import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const runtimeRoot = 'static/openshop';
const requiredFiles = [
  'index.html',
  'icon.png',
  'LICENSE',
  'host/openshop-protocol.js',
  'host/openshop-project-adapter.js',
  'host/openshop-host-runtime.js',
  'host/openshop-i18n.js',
  'locales/zh-CN.js',
  'vendor/runtime-manifest.json',
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

function listFiles(root, directory = root){
  return readdirSync(directory, {withFileTypes:true}).flatMap(entry => {
    const absolute = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(root, absolute)
      : [relative(root, absolute).replaceAll('\\', '/')];
  });
}

function digest(path){
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

for(const relativePath of [
  'index.html',
  'host/openshop-protocol.js',
  'host/openshop-project-adapter.js',
  'host/openshop-host-runtime.js',
]){
  assert.equal(
    digest(`${runtimeRoot}/${relativePath}`),
    digest(`integrations/openshop/${relativePath}`),
    `${relativePath} should exactly match the integration source`,
  );
}

const runtimeFiles = listFiles(runtimeRoot);
assert.equal(
  runtimeFiles.some(path => /(^|\/)(?:tests?|node_modules|__pycache__|\.cache|projects?|runtime-data)(?:\/|$)/i.test(path)),
  false,
  'runtime must not ship tests, caches, project manifests, or runtime data directories',
);
assert.equal(runtimeFiles.some(path => /\.(?:tmp|log|pyc)$/i.test(path)), false, 'runtime must not ship temporary data');

const index = readFileSync(`${runtimeRoot}/index.html`, 'utf8');
const protocolIndex = index.indexOf('./host/openshop-protocol.js');
const adapterIndex = index.indexOf('./host/openshop-project-adapter.js');
const runtimeIndex = index.indexOf('./host/openshop-host-runtime.js');
const bodyEndIndex = index.lastIndexOf('</body>');

assert.ok(protocolIndex > 0, 'runtime index should load the OpenShop protocol');
assert.ok(adapterIndex > protocolIndex, 'runtime index should load the project adapter after the protocol');
assert.ok(runtimeIndex > adapterIndex, 'runtime index should load the host runtime after the project adapter');
assert.ok(bodyEndIndex > runtimeIndex, 'host scripts should load before the closing body tag');
assert.match(index, /HstarOpenShopAssetApi\.upload/, 'runtime should expose same-origin asset persistence');
assert.match(index, /previewWriter:/, 'runtime should configure preview persistence');
assert.match(index, /outputWriter:/, 'runtime should configure output persistence');

const shell = readFileSync('static/index.html', 'utf8');
const classic = readFileSync('static/canvas.html', 'utf8');
const smart = readFileSync('static/smart-canvas.html', 'utf8');
assert.match(shell, /\/static\/css\/openshop-host\.css(?:\?[^"']*)?/);
assert.match(shell, /\/static\/js\/openshop-host\.js(?:\?[^"']*)?/);
assert.match(classic, /\/static\/js\/canvas-openshop\.js(?:\?[^"']*)?/);
assert.match(smart, /\/static\/js\/smart-canvas-openshop\.js(?:\?[^"']*)?/);

const license = readFileSync(`${runtimeRoot}/LICENSE`, 'utf8');
assert.match(license, /MIT License/);
assert.match(license, /Copyright \(c\) 2026 Matthew Parker/);

console.log('OpenShop foundation build tests passed');
