import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const installerPath = resolve(root, 'build/installer/Hstar.Windows11.iss');
const retiredInstallerPath = resolve(root, 'build/installer/Hstar.iss');
const builderPath = resolve(root, 'build/scripts/New-HstarWindows11Installer.ps1');
const chineseLanguagePath = resolve(root, 'build/installer/languages/ChineseSimplified.isl');

assert.ok(existsSync(installerPath), 'independent Windows 11 installer definition exists');
assert.ok(existsSync(builderPath), 'Windows 11 installer builder exists');
assert.ok(existsSync(chineseLanguagePath), 'Simplified Chinese installer messages are a pinned build input');

const installer = readFileSync(installerPath, 'utf8');
const retiredInstaller = readFileSync(retiredInstallerPath, 'utf8');
const builder = readFileSync(builderPath, 'utf8');
const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');

assert.match(installer, /#define\s+MyEdition\s+"Windows11"/i);
assert.match(installer, /#define\s+SourceRoot\s+"stage\\windows11"/i);
assert.match(installer, /#ifndef\s+MyAppVersion[\s\S]*#error/i, 'version must come from the build command');
assert.match(installer, /^AppId=\{\{7D2E8423-5B6B-48EC-A986-5E8B57EE3A11\}$/mi);
assert.match(installer, /^DefaultDirName=\{localappdata\}\\Programs\\Hstar$/mi);
assert.match(installer, /^PrivilegesRequired=lowest$/mi);
assert.match(installer, /^ArchitecturesAllowed=x64compatible$/mi);
assert.match(installer, /^ArchitecturesInstallIn64BitMode=x64compatible$/mi);
assert.match(installer, /^MinVersion=10\.0\.22000$/mi);
assert.match(installer, /^OutputDir=\.\.\\release\\windows11$/mi);
assert.match(installer, /^OutputBaseFilename=Hstar_Windows11_Setup_\{#MyAppVersion\}$/mi);
assert.match(installer, /^AppMutex=\{#MyAppMutex\}$/mi, 'installer binds only the Windows 11 mutex');
assert.match(installer, /^CloseApplications=no$/mi, 'installer does not terminate unrelated processes');
assert.match(installer, /MessagesFile:\s*"languages\\ChineseSimplified\.isl"/i);
assert.doesNotMatch(installer, /compiler:Languages\\ChineseSimplified\.isl/i);

const filesSection = installer.match(/\[Files\]([\s\S]*?)(?=\r?\n\[|$)/i)?.[1] ?? '';
const fileSources = [...filesSection.matchAll(/^Source:/gmi)];
assert.equal(fileSources.length, 1, 'installer copies one closed payload root');
assert.match(filesSection, /Source:\s*"\{#SourceRoot\}\\\*";\s*DestDir:\s*"\{app\}"/i);
assert.doesNotMatch(filesSection, /(?:\.\.[\\/]|node_modules|Fun-ASR-Nano|safetensors|\.hstar-voice)/i);

assert.match(installer, /Name:\s*"desktopicon";[^\r\n]*Flags:\s*checkedonce/i);
assert.match(installer, /Name:\s*"updateapiconfig";[^\r\n]*Flags:\s*unchecked/i);
assert.match(installer, /Name:\s*"\{group\}\\\{#MyAppName\}";\s*Filename:\s*"\{app\}\\\{#MyAppExeName\}"/i);
assert.match(installer, /Name:\s*"\{autodesktop\}\\\{#MyAppName\}";[^\r\n]*Tasks:\s*desktopicon/i);

assert.match(installer, /Filename:\s*"\{app\}\\\{#MyAppExeName\}";\s*Parameters:\s*"--maintenance=update-api-config";[^\r\n]*Flags:\s*runhidden\s+waituntilterminated;[^\r\n]*Tasks:\s*updateapiconfig/i);
assert.match(installer, /Filename:\s*"\{app\}\\\{#MyAppExeName\}";\s*Description:[^\r\n]*Flags:\s*nowait\s+postinstall/i);
assert.match(installer, /CheckForMutexes\(MyAppMutex\)[\s\S]*--maintenance=shutdown/i, 'upgrade shutdown uses the edition maintenance contract');

assert.doesNotMatch(installer, /(?:powershell(?:\.exe)?|\{cmd\}|cmd\.exe|taskkill|run\.bat)/i);
const installDeleteSection = installer.match(/\[InstallDelete\]([\s\S]*?)(?=\r?\n\[|$)/i)?.[1] ?? '';
const installDeleteEntries = [...installDeleteSection.matchAll(/^Type:\s*filesandordirs;\s*Name:\s*"([^"]+)"\s*$/gmi)]
    .map((match) => match[1]);
assert.deepEqual(
    installDeleteEntries,
    ['{app}\\app', '{app}\\runtime'],
    'upgrade cleanup is limited to the two program-owned payload roots that the stage fully replaces',
);
assert.doesNotMatch(
    installDeleteSection,
    /(?:appdata|localappdata|userappdata|commonappdata|dataRoot|Hstar缓存|\{code:|\{reg:)/i,
    'upgrade cleanup cannot resolve to AppData, the selected data root, or another dynamic location',
);
assert.doesNotMatch(installer, /\[UninstallDelete\]/i, 'uninstall never declares destructive cleanup');
assert.doesNotMatch(installer, /(?:Fun-ASR-Nano|safetensors|model\.pt|voice-assistant-data)/i);
assert.match(retiredInstaller, /retired/i, 'legacy combined installer is explicitly retired');
assert.doesNotMatch(retiredInstaller, /^\[Setup\]/mi, 'retired installer cannot produce a package');

assert.match(builder, /Test-HstarWindows11Stage\.ps1/);
assert.match(builder, /ISCC\.exe/i);
assert.match(builder, /Hstar\.Windows11\.iss/i);
assert.match(builder, /Get-FileHash[\s\S]*SHA256/i);
assert.match(builder, /release-manifest\.json/i);
assert.match(builder, /Compiler engine version:\\s\*Inno Setup/i, 'manifest version comes from compiler output');
assert.doesNotMatch(builder, /VersionInfo\.ProductVersion/i, 'ISCC PE version fields are always 0.0.0.0');
assert.doesNotMatch(builder, /Skip(?:Stage|Validation)/i);
assert.match(ignore, /^build\/release\/$/mi, 'compiled installers and release manifests remain untracked');

const parseResult = spawnSync(
    'powershell.exe',
    [
        '-NoProfile',
        '-Command',
        '$tokens=$null; $errors=$null; ' +
            '[System.Management.Automation.Language.Parser]::ParseFile(' +
            '$env:HSTAR_INSTALLER_BUILDER,[ref]$tokens,[ref]$errors) | Out-Null; ' +
            'if ($errors.Count -gt 0) { $errors | ForEach-Object { ' +
            '[Console]::Error.WriteLine($_.Message) }; exit 1 }',
    ],
    {
        encoding: 'utf8',
        env: {...process.env, HSTAR_INSTALLER_BUILDER: builderPath},
    },
);
assert.equal(
    parseResult.status,
    0,
    `Windows PowerShell 5 must parse the installer builder:\n${parseResult.stderr}${parseResult.stdout}`,
);

console.log('Windows 11 installer contract passed');
