import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const scriptPath = resolve(root, 'tools/measure-windows11-startup.ps1');
const appPath = resolve(root, 'desktop/Hstar.Desktop/App.xaml.cs');
const mainWindowPath = resolve(root, 'desktop/Hstar.Desktop/MainWindow.xaml.cs');
const environmentFactoryPath = resolve(root, 'desktop/Hstar.Desktop/Runtime/WebViewEnvironmentFactory.cs');

assert.ok(existsSync(scriptPath), 'Windows 11 startup measurement script exists');
assert.ok(existsSync(appPath), 'Windows 11 shell application source exists');
assert.ok(existsSync(mainWindowPath), 'Windows 11 shell window source exists');
assert.ok(existsSync(environmentFactoryPath), 'shared WebView environment factory exists');
const script = readFileSync(scriptPath, 'utf8');
const app = readFileSync(appPath, 'utf8');
const mainWindow = readFileSync(mainWindowPath, 'utf8');
const environmentFactory = readFileSync(environmentFactoryPath, 'utf8');

for (const parameter of [
  'InstallRoot',
  'DataRoot',
  'AppDataRoot',
  'ApprovedTempRoot',
  'ColdRuns',
  'WarmRuns',
  'PortStart',
  'OutputPath',
]) {
  assert.match(script, new RegExp(`\\$${parameter}\\b`), `script accepts ${parameter}`);
}

assert.match(script, /ColdRuns\s*=\s*5/i);
assert.match(script, /WarmRuns\s*=\s*5/i);
assert.match(script, /--validation-appdata-root=/i);
assert.match(script, /--validation-port=/i);
assert.match(script, /--validation-ready-file=/i);
assert.match(script, /MainWindowHandle/i, 'shell window readiness is measured');
assert.match(script, /backendHealthyUtc/i, 'authorized backend health readiness is measured');
assert.match(script, /readyUtc/i, 'interactive WebView readiness uses the shell marker');
assert.match(script, /--maintenance=shutdown/i, 'each run uses graceful edition shutdown');
assert.match(script, /pythonw/i, 'backend cleanup is verified');
assert.match(script, /cmd|powershell|python|conhost/i, 'visible console process checks are present');
assert.match(script, /Median/i, 'cold and warm medians are reported');
assert.match(script, /5000/, 'the production port is explicitly rejected');
assert.match(script, /IsSameOrDescendant/i, 'all writable roots are containment-checked');
assert.doesNotMatch(script, /taskkill|Stop-Process\s+-Name/i);
assert.match(
  app,
  /browserPreparation\s*=\s*window\.PrepareBrowserAsync[\s\S]*?_startupCoordinator\.StartAsync[\s\S]*?await\s+browserPreparation[\s\S]*?window\.AttachBackendSessionAsync/i,
  'fixed WebView initialization overlaps backend startup and finishes before navigation',
);
assert.match(
  mainWindow,
  /PrepareBrowserAsync[\s\S]*?_environmentFactory[\s\S]*?StartupWebView\.EnsureCoreWebView2Async\(environment\)[\s\S]*?MainWebView\.EnsureCoreWebView2Async\(environment\)/i,
  'browser preparation prioritizes the startup animation while sharing one fixed-runtime environment across both WebViews',
);
assert.equal(
  [...environmentFactory.matchAll(/CoreWebView2Environment\.CreateAsync/g)].length,
  1,
  'shared environment factory has one creation site',
);
assert.match(
  mainWindow,
  /AttachBackendSessionAsync[\s\S]*?WebViewConfiguration\.Create[\s\S]*?NavigateAsync[\s\S]*?_interactiveCompletion\.Task\.WaitAsync/i,
  'session attachment remains covered until the interactive handshake',
);

const parseResult = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    '$tokens=$null; $errors=$null; ' +
      '[System.Management.Automation.Language.Parser]::ParseFile(' +
      '$env:HSTAR_STARTUP_MEASUREMENT,[ref]$tokens,[ref]$errors) | Out-Null; ' +
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { ' +
      '[Console]::Error.WriteLine("{0}:{1} {2}", $_.Extent.StartLineNumber, ' +
      '$_.Extent.StartColumnNumber, $_.Message) }; exit 1 }',
  ],
  {
    encoding: 'utf8',
    env: {...process.env, HSTAR_STARTUP_MEASUREMENT: scriptPath},
  },
);
assert.equal(
  parseResult.status,
  0,
  `Windows PowerShell 5 must parse the startup measurement script:\n${parseResult.stderr}${parseResult.stdout}`,
);

console.log('Windows 11 startup measurement contract passed');
