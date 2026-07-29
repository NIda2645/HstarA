import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(new URL('./python-runner.mjs', import.meta.url), 'utf8');

assert.ok(
  source.includes("const localPython = resolve(process.cwd(), 'python', 'python.exe');"),
  'Windows test fallback must resolve the repository Python explicitly',
);
assert.ok(
  source.includes('existsSync(localPython)'),
  'repository Python must be used only when it exists',
);
assert.ok(
  source.indexOf('{ command: localPython') < source.indexOf("{ command: 'python'"),
  'repository Python must be tried before PATH aliases that can invoke WindowsApps',
);

console.log('python runner safety contract passed');
