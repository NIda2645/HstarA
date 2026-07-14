import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import vm from 'node:vm';

const integrationRoot = 'integrations/openshop';
const runtimeRoot = 'static/openshop';
const gitAttributes = readFileSync('.gitattributes', 'utf8');
const sourceManifest = JSON.parse(readFileSync(`${integrationRoot}/vendor/runtime-manifest.json`, 'utf8'));
const glossary = JSON.parse(readFileSync(`${integrationRoot}/locales/photoshop-zh-CN-glossary.json`, 'utf8'));

assert.match(
  gitAttributes,
  /^integrations\/openshop\/vendor\/\*\*\s+-text\b/m,
  'source vendor runtime must bypass Git text normalization',
);
assert.match(
  gitAttributes,
  /^static\/openshop\/vendor\/\*\*\s+-text\b/m,
  'built vendor runtime must bypass Git text normalization',
);

function listFiles(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const absolutePath = join(directory, entry.name);
    return entry.isDirectory()
      ? listFiles(root, absolutePath)
      : [relative(root, absolutePath).replaceAll('\\', '/')];
  });
}

const licenseFiles = listFiles(`${integrationRoot}/vendor/licenses`)
  .map((file) => `vendor/licenses/${file}`);
const expectedFiles = [
  'LICENSE',
  'icon.png',
  'index.html',
  'host/openshop-host-runtime.js',
  'host/openshop-i18n.js',
  'host/openshop-project-adapter.js',
  'host/openshop-protocol.js',
  'locales/zh-CN.js',
  'vendor/runtime-manifest.json',
  ...sourceManifest.files.map((file) => file.path),
  ...licenseFiles,
].sort();

assert.ok(existsSync(runtimeRoot), `${runtimeRoot} should exist`);
assert.deepEqual(listFiles(runtimeRoot).sort(), expectedFiles, 'static runtime must contain only approved files');

const builtManifest = JSON.parse(readFileSync(`${runtimeRoot}/vendor/runtime-manifest.json`, 'utf8'));
assert.deepEqual(builtManifest, sourceManifest, 'static runtime manifest must match the audited source manifest');
for (const file of builtManifest.files) {
  const contents = readFileSync(`${runtimeRoot}/${file.path}`);
  const digest = createHash('sha256').update(contents).digest('hex');
  assert.equal(digest, file.sha256, `${file.path} checksum should match the manifest`);
  assert.equal(contents.length, file.bytes, `${file.path} byte count should match the manifest`);
}

const index = readFileSync(`${runtimeRoot}/index.html`, 'utf8');
assert.doesNotMatch(index, /<script[^>]+src=["']https?:\/\//i, 'runtime must not load remote scripts');
assert.doesNotMatch(index, /fonts\.googleapis\.com|fonts\.gstatic\.com/i, 'runtime must not load Google Fonts');
assert.doesNotMatch(index, /\bimport\(\s*["']https?:\/\//i, 'runtime must not import remote modules');

const registrations = new Map();
const context = vm.createContext({
  window: {
    HstarOpenShopI18n: {
      register(locale, messages) {
        registrations.set(locale, { ...messages });
      },
    },
  },
});
vm.runInContext(readFileSync(`${runtimeRoot}/locales/zh-CN.js`, 'utf8'), context);
const dictionary = registrations.get('zh-CN');
assert.ok(dictionary, 'static runtime should register the zh-CN dictionary');
for (const [key, value] of Object.entries(glossary)) {
  assert.equal(dictionary[key], value, `${key} should match the Photoshop glossary`);
}

console.log(`OpenShop localization build tests passed (${expectedFiles.length} approved files)`);
