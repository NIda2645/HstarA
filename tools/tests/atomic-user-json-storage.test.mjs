import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync('main.py', 'utf8');

assert.doesNotMatch(
  source,
  /json\.dump\s*\(/,
  'user JSON records must use atomic replacement instead of writing directly to live files',
);
assert.match(
  source,
  /from hstar_runtime\.atomic import [^\n]*atomic_create_json[^\n]*atomic_write_json/,
  'canvas creation and user JSON updates must use shared atomic helpers',
);

console.log('atomic user JSON storage tests passed');
