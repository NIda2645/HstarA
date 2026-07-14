import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';

const runtimeRoot = 'static/openshop';
const requiredFiles = [
  'index.html',
  'icon.png',
  'LICENSE',
  'host/openshop-protocol.js',
  'host/openshop-project-adapter.js',
  'host/openshop-host-runtime.js',
];

for(const relativePath of requiredFiles){
  assert.ok(
    existsSync(`${runtimeRoot}/${relativePath}`),
    `${runtimeRoot}/${relativePath} should exist`,
  );
}

assert.equal(existsSync(`${runtimeRoot}/node_modules`), false, 'runtime must not contain node_modules');
assert.equal(existsSync(`${runtimeRoot}/.git`), false, 'runtime must not contain nested Git metadata');
assert.equal(existsSync(`${runtimeRoot}/tests`), false, 'runtime must not contain upstream tests');

const index = readFileSync(`${runtimeRoot}/index.html`, 'utf8');
const protocolIndex = index.indexOf('./host/openshop-protocol.js');
const adapterIndex = index.indexOf('./host/openshop-project-adapter.js');
const runtimeIndex = index.indexOf('./host/openshop-host-runtime.js');
const bodyEndIndex = index.lastIndexOf('</body>');

assert.ok(protocolIndex > 0, 'runtime index should load the OpenShop protocol');
assert.ok(adapterIndex > protocolIndex, 'runtime index should load the project adapter after the protocol');
assert.ok(runtimeIndex > adapterIndex, 'runtime index should load the host runtime after the project adapter');
assert.ok(bodyEndIndex > runtimeIndex, 'host scripts should load before the closing body tag');

const license = readFileSync(`${runtimeRoot}/LICENSE`, 'utf8');
assert.match(license, /MIT License/);
assert.match(license, /Copyright \(c\) 2026 Matthew Parker/);

console.log('OpenShop foundation build tests passed');
