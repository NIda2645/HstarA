import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const scriptPath = resolve(root, 'tools/validate-windows11-package.ps1');
const specPath = resolve(root, 'integrations/openshop/tests/hstar-windows11-package.e2e.spec.js');
const ignorePath = resolve(root, '.gitignore');

assert.ok(existsSync(scriptPath), 'packaged feature validator exists');
assert.ok(existsSync(specPath), 'packaged Playwright smoke exists');
const script = readFileSync(scriptPath, 'utf8');
const spec = readFileSync(specPath, 'utf8');
const ignore = readFileSync(ignorePath, 'utf8');

assert.match(
  ignore,
  /^build\/generated\/$/m,
  'isolated package reports and test credentials stay untracked',
);

assert.match(script, /windows11-package-smoke/i, 'all generated data stays in the dedicated root');
assert.match(script, /Port\s+-eq\s+5000/i, 'stable port 5000 is explicitly rejected');
assert.match(script, /runtime\\python\\pythonw\.exe/i, 'the installed embedded Python runtime is used');
assert.match(script, /HSTAR_PROGRAM_DIR[\s\S]*HSTAR_DATA_DIR[\s\S]*HSTAR_EDITION/i);
assert.match(script, /APPDATA\s*=\s*\$appDataRoot/i, 'AppData is isolated');
assert.match(script, /PYTHONDONTWRITEBYTECODE\s*=\s*'1'/i, 'program bytecode caches are disabled');
assert.match(script, /test:hstar:canvas-integration/i, 'classic, smart, and OpenShop dataflow tests run');
assert.match(script, /hstar-windows11-package\.e2e\.spec\.js/i);
assert.match(script, /Start-PackagedBackend[\s\S]*\$migrationTarget/i, 'migrated storage is restarted');
assert.match(
  script,
  /function\s+Invoke-Utf8JsonGet[\s\S]*UTF8\.GetString[\s\S]*ConvertFrom-Json/i,
  'Windows PowerShell 5 JSON reads must decode response bytes explicitly as UTF-8',
);
assert.match(
  script,
  /\$settings\s*=\s*Invoke-Utf8JsonGet[\s\S]*\$providers\s*=\s*Invoke-Utf8JsonGet/i,
  'migrated settings and provider verification use the UTF-8 JSON reader',
);
assert.doesNotMatch(script, /E:\\Hstar缓存|Fun-ASR-Nano|model\.pt/i, 'package smoke never reads stable or model data');

assert.match(spec, /software-settings/);
assert.match(spec, /api-settings/);
assert.match(spec, /director-desk/);
assert.match(spec, /voice-assistant\/status/);
assert.match(spec, /storage-migrations/);
assert.match(spec, /api\/providers/);

const parseResult = spawnSync(
  'powershell.exe',
  [
    '-NoProfile',
    '-Command',
    '$tokens=$null; $errors=$null; ' +
      '[System.Management.Automation.Language.Parser]::ParseFile(' +
      '$env:HSTAR_PACKAGE_VALIDATOR,[ref]$tokens,[ref]$errors) | Out-Null; ' +
      'if ($errors.Count -gt 0) { $errors | ForEach-Object { ' +
      '[Console]::Error.WriteLine($_.Message) }; exit 1 }',
  ],
  {
    encoding: 'utf8',
    env: {...process.env, HSTAR_PACKAGE_VALIDATOR: scriptPath},
  },
);
assert.equal(
  parseResult.status,
  0,
  `Windows PowerShell 5 must parse the package validator:\n${parseResult.stderr}${parseResult.stdout}`,
);

console.log('Windows 11 package smoke contract passed');
