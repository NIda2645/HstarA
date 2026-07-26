import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const scriptPath = resolve(root, 'tools/validate-windows11-upgrade.ps1');

assert.ok(existsSync(scriptPath), 'Windows 11 upgrade validator exists');
const script = readFileSync(scriptPath, 'utf8');

assert.match(script, /BaseInstaller[\s\S]*UpgradeInstaller[\s\S]*InstallRoot/i);
assert.match(
  script,
  /hstar-win11-install-test/i,
  'upgrade validation is restricted to the dedicated temporary install root',
);
assert.match(script, /\/TASKS=/i, 'installer tasks are explicitly controlled');
assert.doesNotMatch(
  script,
  /\/TASKS=[^\r\n]*updateapiconfig/i,
  'the Inno API task must not resolve the real user AppData during isolated validation',
);
assert.match(script, /api-providers\.user\.json/i);
assert.match(script, /credentials\.dpapi/i);
assert.match(script, /update-api-config[\s\S]*--data-root/i);
assert.match(script, /stale[\s\S]*app[\s\S]*runtime/i, 'obsolete payload cleanup is verified');
assert.match(script, /function\s+Write-Utf8NoBom[\s\S]*UTF8Encoding/i);
assert.match(
  script,
  /Write-Utf8NoBom\s+-Path\s+\$output\s+-Content\s+\(\(\$report\s+\|\s+ConvertTo-Json/i,
  'the result report is UTF-8 JSON',
);
assert.doesNotMatch(script, /E:\\Hstar缓存|Fun-ASR-Nano|model\.pt/i);

console.log('Windows 11 upgrade validation contract passed');
