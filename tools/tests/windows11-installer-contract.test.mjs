import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const installerPath = resolve(root, 'build/installer/Hstar.Windows11.iss');
const classicInstallerPath = resolve(root, 'build/installer/Hstar.iss');
const builderPath = resolve(root, 'build/scripts/New-HstarWindows11Installer.ps1');
const chineseLanguagePath = resolve(root, 'build/installer/languages/ChineseSimplified.isl');
const desktopProjectPath = resolve(root, 'desktop/Hstar.Desktop/Hstar.Desktop.csproj');
const brandIconPath = resolve(root, 'desktop/Hstar.Desktop/Branding/Hstar.ico');
const brandIconSourcePath = resolve(root, 'desktop/Hstar.Desktop/Branding/Hstar.svg');

assert.ok(existsSync(installerPath), 'independent Windows 11 installer definition exists');
assert.ok(existsSync(builderPath), 'Windows 11 installer builder exists');
assert.ok(existsSync(chineseLanguagePath), 'Simplified Chinese installer messages are a pinned build input');
assert.ok(existsSync(brandIconPath), 'the Windows brand icon exists');
assert.ok(existsSync(brandIconSourcePath), 'the editable Windows brand icon source exists');

const installer = readFileSync(installerPath, 'utf8');
const classicInstaller = readFileSync(classicInstallerPath, 'utf8');
const builder = readFileSync(builderPath, 'utf8');
const desktopProject = readFileSync(desktopProjectPath, 'utf8');
const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');

assert.match(installer, /#define\s+MyEdition\s+"Windows11"/i);
assert.match(installer, /#define\s+SourceRoot\s+"stage\\windows11"/i);
assert.match(installer, /#ifndef\s+MyAppVersion[\s\S]*#error/i, 'version must come from the build command');
assert.match(installer, /^AppId=\{\{7D2E8423-5B6B-48EC-A986-5E8B57EE3A11\}$/mi);
assert.match(installer, /^DefaultDirName=\{localappdata\}\\Programs\\Hstar$/mi);
assert.match(installer, /^DisableDirPage=no$/mi, 'interactive installs always show the destination directory page');
assert.match(installer, /^PrivilegesRequired=lowest$/mi);
assert.match(installer, /^ArchitecturesAllowed=x64compatible$/mi);
assert.match(installer, /^ArchitecturesInstallIn64BitMode=x64compatible$/mi);
assert.match(installer, /^MinVersion=10\.0\.22000$/mi);
assert.match(installer, /^OutputDir=\.\.\\release\\windows11$/mi);
assert.match(installer, /^OutputBaseFilename=Hstar_Windows11_Setup_\{#MyAppVersion\}$/mi);
assert.match(installer, /^SetupIconFile=\.\.\\\.\.\\desktop\\Hstar\.Desktop\\Branding\\Hstar\.ico$/mi);
assert.match(installer, /^Compression=lzma2\/max$/mi, 'installer prioritizes dependable build behavior over extreme compression');
assert.match(installer, /^AppMutex=\{#MyAppMutex\}$/mi, 'installer binds only the Windows 11 mutex');
assert.match(installer, /^CloseApplications=no$/mi, 'installer does not terminate unrelated processes');
assert.match(desktopProject, /<ApplicationIcon>Branding\\Hstar\.ico<\/ApplicationIcon>/i);
assert.match(installer, /MessagesFile:\s*"languages\\ChineseSimplified\.isl"/i);
assert.doesNotMatch(installer, /compiler:Languages\\ChineseSimplified\.isl/i);

const filesSection = installer.match(/\[Files\]([\s\S]*?)(?=\r?\n\[|$)/i)?.[1] ?? '';
const fileSources = [...filesSection.matchAll(/^Source:/gmi)];
assert.equal(fileSources.length, 1, 'installer copies one closed payload root');
assert.match(filesSection, /Source:\s*"\{#SourceRoot\}\\\*";\s*DestDir:\s*"\{app\}"/i);
assert.doesNotMatch(filesSection, /(?:\.\.[\\/]|node_modules|Fun-ASR-Nano|safetensors|\.hstar-voice)/i);

assert.match(installer, /Name:\s*"desktopicon";[^\r\n]*Flags:\s*checkedonce/i);
assert.match(installer, /Name:\s*"updateapiconfig";[^\r\n]*Flags:\s*unchecked/i);
assert.match(installer, /Name:\s*"updateapiconfig";[^\r\n]*覆盖更新内置 API 配置/i);
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

const icon = readFileSync(brandIconPath);
assert.equal(icon.readUInt16LE(0), 0, 'ICO reserved field is zero');
assert.equal(icon.readUInt16LE(2), 1, 'brand asset is a Windows ICO');
const iconSizes = new Set();
const iconCount = icon.readUInt16LE(4);
for (let index = 0; index < iconCount; index += 1) {
  const width = icon[6 + (index * 16)] || 256;
  const height = icon[7 + (index * 16)] || 256;
  if (width === height) iconSizes.add(width);
}
for (const size of [16, 32, 48, 256]) {
  assert.ok(iconSizes.has(size), `brand ICO contains a ${size}x${size} layer`);
}

assert.match(classicInstaller, /^\[Setup\]/mi, 'classic installer remains independently buildable');
assert.match(classicInstaller, /^AppId=\{\{B41E0B38-7D96-49FD-95BC-781C568F9E18\}$/mi);
assert.doesNotMatch(
  classicInstaller,
  /7D2E8423-5B6B-48EC-A986-5E8B57EE3A11/i,
  'classic and Windows 11 installers use independent product identities',
);
assert.doesNotMatch(
  classicInstaller,
  /Hstar_Windows11_Setup_/i,
  'classic installer cannot overwrite the Windows 11 release name',
);

assert.match(builder, /Test-HstarWindows11Stage\.ps1/);
assert.match(builder, /ISCC\.exe/i);
assert.match(builder, /Hstar\.Windows11\.iss/i);
assert.match(builder, /Get-FileHash[\s\S]*SHA256/i);
assert.match(builder, /release-manifest\.json/i);
assert.match(builder, /\[string\]\$OutputDirectory/i, 'builder accepts the requested final output folder');
assert.match(builder, /Copy-Item[\s\S]*\$finalInstallerPath/i, 'builder copies the verified installer to the requested folder');
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
