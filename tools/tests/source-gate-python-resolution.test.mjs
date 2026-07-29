import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';

const scriptUrl = new URL('../../build/scripts/Test-HstarSource.ps1', import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const source = await readFile(scriptUrl, 'utf8');

const escapedScriptPath = scriptPath.replaceAll("'", "''");
const parseResult = spawnSync('powershell.exe', [
  '-NoProfile',
  '-Command',
  `$tokens = $null; $errors = $null; `
    + `[System.Management.Automation.Language.Parser]::ParseFile('${escapedScriptPath}', [ref]$tokens, [ref]$errors) | Out-Null; `
    + `if ($errors.Count -gt 0) { $errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1 }`,
], {encoding: 'utf8'});
assert.equal(
  parseResult.status,
  0,
  `source gate must be valid PowerShell:\n${parseResult.stderr || parseResult.stdout}`,
);

assert.match(source, /\[string\]\$PythonPath\s*=\s*\$env:HSTAR_TEST_PYTHON/,
  'source gate must accept an explicit test Python');
assert.match(source, /Join-Path \$RepositoryRoot 'python\\python\.exe'/,
  'source gate must have a deterministic repository Python fallback');
assert.match(source, /WindowsApps/i,
  'source gate must reject WindowsApps command aliases');
assert.match(source, /import requests, fastapi, PIL, uvicorn/,
  'source gate must probe runtime dependencies before running the suite');
assert.doesNotMatch(source, /requires a development Python/,
  'source gate must not reject its validated packaged Python fallback');

console.log('source gate Python resolution contract passed');
