import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const integrationRoot = resolve(scriptDir, '..');
const projectRoot = resolve(integrationRoot, '..', '..');
const staticRoot = resolve(projectRoot, 'static');
const destination = resolve(staticRoot, 'openshop');

if(dirname(destination) !== staticRoot){
  throw new Error(`Unsafe OpenShop build destination: ${destination}`);
}

const manifest = JSON.parse(await readFile(resolve(integrationRoot, 'vendor/runtime-manifest.json'), 'utf8'));
if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.files) || manifest.files.length === 0) {
  throw new Error('Invalid OpenShop runtime manifest');
}
for (const file of manifest.files) {
  const manifestPath = String(file?.path || '').replaceAll('\\', '/');
  if (
    isAbsolute(manifestPath)
    || !manifestPath.startsWith('vendor/')
    || manifestPath.split('/').includes('..')
    || !/^[a-f0-9]{64}$/.test(String(file?.sha256 || ''))
  ) {
    throw new Error(`Unsafe OpenShop manifest entry: ${manifestPath}`);
  }
}

const licenseFiles = [
  'vendor/licenses/ag-psd-22.0.2-LICENSE',
  'vendor/licenses/fabric-5.3.1-LICENSE',
  'vendor/licenses/gif.js-0.2.0-LICENSE',
  'vendor/licenses/jspdf-4.2.1-LICENSE',
  'vendor/licenses/onnxruntime-web-1.25.0-dev.20260327-722743c0e2-LICENSE',
  'vendor/licenses/photon-0.3.3-LICENSE',
  'vendor/licenses/transformers-4.0.0-LICENSE',
];

const runtimeFiles = [...new Set([
  'index.html',
  'icon.png',
  'LICENSE',
  'host/openshop-protocol.js',
  'host/openshop-desktop-input.js',
  'host/openshop-pixel-fill.js',
  'host/openshop-project-adapter.js',
  'host/openshop-snap-engine.js',
  'host/openshop-host-runtime.js',
  'host/openshop-ai-client.js',
  'host/openshop-font-catalog.js',
  'host/openshop-text-properties.js',
  'host/openshop-text-properties.css',
  'host/openshop-text-tools.js',
  'host/openshop-reference-manager.js',
  'host/openshop-generative-client.js',
  'host/openshop-generative-tools.js',
  'host/openshop-generative-tools.css',
  'host/openshop-i18n.js',
  'locales/zh-CN.js',
  'vendor/runtime-manifest.json',
  ...manifest.files.map((file) => file.path.replaceAll('\\', '/')),
  ...licenseFiles,
])].sort();

for(const file of runtimeFiles){
  if(/(^|\/)(?:tests?|node_modules|__pycache__|\.cache|projects?|runtime-data)(?:\/|$)/i.test(file)
    || /\.(?:tmp|log|pyc)$/i.test(file)){
    throw new Error(`Forbidden OpenShop runtime entry: ${file}`);
  }
}

await rm(destination, {recursive:true, force:true});

for(const file of runtimeFiles){
  const source = resolve(integrationRoot, file);
  const target = resolve(destination, file);
  const sourceRelative = relative(integrationRoot, source);
  const targetRelative = relative(destination, target);
  if(sourceRelative === '..' || sourceRelative.startsWith(`..${sep}`) || isAbsolute(sourceRelative)){
    throw new Error(`Unsafe OpenShop build source: ${source}`);
  }
  if(targetRelative === '..' || targetRelative.startsWith(`..${sep}`) || isAbsolute(targetRelative)){
    throw new Error(`Unsafe OpenShop build target: ${target}`);
  }
  await mkdir(dirname(target), {recursive:true});
  await copyFile(source, target);
  console.log(relative(projectRoot, target).replaceAll('\\', '/'));
}

async function listFiles(root, directory = root){
  const entries = await readdir(directory, {withFileTypes:true});
  const files = [];
  for(const entry of entries){
    const absolute = resolve(directory, entry.name);
    if(entry.isDirectory()) files.push(...await listFiles(root, absolute));
    else files.push(relative(root, absolute).replaceAll('\\', '/'));
  }
  return files.sort();
}

const builtFiles = await listFiles(destination);
if(JSON.stringify(builtFiles) !== JSON.stringify(runtimeFiles)){
  throw new Error(`OpenShop build tree differs from the approved manifest: ${JSON.stringify(builtFiles)}`);
}

const treeHash = createHash('sha256');
for(const file of builtFiles){
  treeHash.update(file, 'utf8');
  treeHash.update('\0');
  treeHash.update(await readFile(resolve(destination, file)));
  treeHash.update('\0');
}
console.log(`OPENSHOP_BUILD_SHA256=${treeHash.digest('hex')}`);
