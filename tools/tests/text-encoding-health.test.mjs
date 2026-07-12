import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../..', import.meta.url));
const result = spawnSync(process.execPath, ['tools/audit-text-encoding.mjs'], {
  cwd: root,
  encoding: 'utf8',
});

assert.equal(
  result.status,
  0,
  [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'),
);
assert.match(result.stdout, /^User-facing text encoding passed: \d+\r?\n$/);
console.log('Text encoding health tests passed');
