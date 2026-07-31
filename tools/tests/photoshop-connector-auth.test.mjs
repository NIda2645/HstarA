import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const net = await readFile(
  new URL('../photoshop-asset-connector/js/net.js', import.meta.url),
  'utf8',
);

assert.doesNotMatch(
  net,
  /X-Hstar-Integration/i,
  'the Photoshop plugin remains independent of packaged-shell authentication',
);
assert.match(
  net,
  /fetch\(`\$\{httpBase\(\)\}\$\{path\}`,\s*\{\s*cache:\s*'no-store'\s*\}\)/,
  'Photoshop GET requests keep their existing request shape',
);
assert.match(
  net,
  /fetch\(absUrl\(url\)\)/,
  'Photoshop byte downloads keep their existing request shape',
);

console.log('Photoshop connector source-boundary contract tests passed');
