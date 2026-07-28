import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';

const integrationRoot = 'integrations/openshop';
const runtimeRoot = 'static/openshop';
const allowDirtyMirrorForTest = process.env.HSTAR_ALLOW_DIRTY_MIRROR_FOR_TEST === '1';
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
  'host/openshop-ai-client.js',
  'host/openshop-font-catalog.js',
  'host/openshop-i18n.js',
  'host/openshop-project-adapter.js',
  'host/openshop-protocol.js',
  'host/openshop-text-tools.js',
  'locales/zh-CN.js',
  'vendor/runtime-manifest.json',
  ...sourceManifest.files.map((file) => file.path),
  ...licenseFiles,
].sort();

assert.ok(existsSync(runtimeRoot), `${runtimeRoot} should exist`);
const runtimeFiles = listFiles(runtimeRoot).sort();
if(allowDirtyMirrorForTest){
  for(const file of expectedFiles){
    assert.ok(runtimeFiles.includes(file), `dirty test runtime should retain approved file ${file}`);
  }
  assert.equal(
    runtimeFiles.some(file => /(^|\/)(?:tests?|node_modules|__pycache__|\.cache|projects?|runtime-data)(?:\/|$)/i.test(file)
      || /\.(?:tmp|log|pyc)$/i.test(file)),
    false,
    'dirty test runtime must still exclude tests, caches, runtime data, and temporary files',
  );
}
else{
  assert.deepEqual(runtimeFiles, expectedFiles, 'static runtime must contain only approved files');
}

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

function runBuild(output){
  const result = spawnSync(process.execPath, ['scripts/build-hstar.mjs', '--output', output], {
    cwd:integrationRoot,
    encoding:'utf8',
    shell:false,
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const match = String(result.stdout || '').match(/OPENSHOP_BUILD_SHA256=([a-f0-9]{64})/);
  assert.ok(match, 'build should report a deterministic OpenShop tree fingerprint');
  return match[1];
}

const buildRoot = mkdtempSync(join(tmpdir(), 'hstar-openshop-build-'));
try{
  assert.equal(
    runBuild(join(buildRoot, 'first')),
    runBuild(join(buildRoot, 'second')),
    'repeated OpenShop builds should have identical tree fingerprints',
  );
}
finally{
  rmSync(buildRoot, {recursive:true, force:true});
}

console.log(`OpenShop localization build tests passed (${expectedFiles.length} approved files)`);
