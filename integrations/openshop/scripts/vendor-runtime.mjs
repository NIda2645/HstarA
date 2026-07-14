import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fabricSri = 'sLpuECXYCB5TUyTbC06pftm/rgurDambREZmV4eRHwEqJzCQtU6lxI2Ve00z4XW5';

const sources = [
  {
    packageName: 'ag-psd',
    version: '22.0.2',
    license: 'MIT',
    source: 'node_modules/ag-psd/dist/bundle.js',
    target: 'vendor/ag-psd-22.0.2.bundle.js',
  },
  {
    packageName: 'jspdf',
    version: '4.2.1',
    license: 'MIT',
    source: 'node_modules/jspdf/dist/jspdf.umd.min.js',
    target: 'vendor/jspdf-4.2.1.umd.min.js',
  },
  {
    packageName: '@silvia-odwyer/photon',
    version: '0.3.3',
    license: 'Apache-2.0',
    source: 'node_modules/@silvia-odwyer/photon/photon_rs.js',
    target: 'vendor/photon/photon_rs.js',
  },
  {
    packageName: '@silvia-odwyer/photon',
    version: '0.3.3',
    license: 'Apache-2.0',
    source: 'node_modules/@silvia-odwyer/photon/photon_rs_bg.wasm',
    target: 'vendor/photon/photon_rs_bg.wasm',
  },
  {
    packageName: 'gif.js',
    version: '0.2.0',
    license: 'MIT',
    source: 'node_modules/gif.js/dist/gif.js',
    target: 'vendor/gif/gif.js',
  },
  {
    packageName: 'gif.js',
    version: '0.2.0',
    license: 'MIT',
    source: 'node_modules/gif.js/dist/gif.worker.js',
    target: 'vendor/gif/gif.worker.js',
  },
  {
    packageName: '@huggingface/transformers',
    version: '4.0.0',
    license: 'Apache-2.0',
    source: 'node_modules/@huggingface/transformers/dist/transformers.web.min.js',
    target: 'vendor/transformers/transformers.web.min.js',
  },
  {
    packageName: 'onnxruntime-web',
    version: '1.25.0-dev.20260327-722743c0e2',
    license: 'MIT',
    source: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs',
    target: 'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
  },
  {
    packageName: 'onnxruntime-web',
    version: '1.25.0-dev.20260327-722743c0e2',
    license: 'MIT',
    source: 'node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.wasm',
    target: 'vendor/transformers/ort-wasm-simd-threaded.jsep.wasm',
  },
];

const licenseSources = [
  ['node_modules/ag-psd/LICENSE', 'vendor/licenses/ag-psd-22.0.2-LICENSE'],
  ['node_modules/jspdf/LICENSE', 'vendor/licenses/jspdf-4.2.1-LICENSE'],
  ['node_modules/@silvia-odwyer/photon/LICENSE.md', 'vendor/licenses/photon-0.3.3-LICENSE'],
  ['node_modules/gif.js/README.md', 'vendor/licenses/gif.js-0.2.0-LICENSE'],
  ['node_modules/@huggingface/transformers/LICENSE', 'vendor/licenses/transformers-4.0.0-LICENSE'],
];

function pathInsideRoot(relativePath, label) {
  if (!relativePath || isAbsolute(relativePath)) {
    throw new Error(`${label} must be a relative path: ${relativePath}`);
  }
  const absolutePath = resolve(packageRoot, relativePath);
  const relativePathFromRoot = relative(packageRoot, absolutePath);
  if (relativePathFromRoot === '..' || relativePathFromRoot.startsWith(`..${sep}`)) {
    throw new Error(`${label} escapes the OpenShop directory: ${relativePath}`);
  }
  return absolutePath;
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(pathInsideRoot(relativePath, 'JSON source'), 'utf8'));
}

function verifyPackageVersion(packageName, version) {
  const packageJson = readJson(`node_modules/${packageName}/package.json`);
  if (packageJson.name !== packageName || packageJson.version !== version) {
    throw new Error(
      `Expected ${packageName}@${version}, found ${packageJson.name}@${packageJson.version}`,
    );
  }
}

function copyRequiredFile(sourcePath, targetPath) {
  const source = pathInsideRoot(sourcePath, 'Vendor source');
  const target = pathInsideRoot(targetPath, 'Vendor target');
  if (!targetPath.replaceAll('\\', '/').startsWith('vendor/')) {
    throw new Error(`Vendor target must stay under vendor/: ${targetPath}`);
  }
  if (!existsSync(source) || !statSync(source).isFile()) {
    throw new Error(`Missing vendor source: ${sourcePath}`);
  }
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
  return target;
}

function sha256(filePath) {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex');
}

function listFiles(directoryPath) {
  const entries = readdirSync(directoryPath, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const child = resolve(directoryPath, entry.name);
    return entry.isDirectory() ? listFiles(child) : [child];
  });
}

const packageVersions = new Map(sources.map((source) => [source.packageName, source.version]));
for (const [packageName, version] of packageVersions) {
  verifyPackageVersion(packageName, version);
}

const fabricPath = pathInsideRoot('vendor/fabric-5.3.1.min.js', 'Fabric runtime');
if (!existsSync(fabricPath)) {
  throw new Error('Missing separately verified Fabric.js runtime');
}
const actualFabricSri = createHash('sha384').update(readFileSync(fabricPath)).digest('base64');
if (actualFabricSri !== fabricSri) {
  throw new Error(`Fabric.js SHA-384 mismatch: ${actualFabricSri}`);
}

const fabricLicensePath = pathInsideRoot(
  'vendor/licenses/fabric-5.3.1-LICENSE',
  'Fabric license',
);
if (!existsSync(fabricLicensePath)) {
  throw new Error('Missing Fabric.js license');
}
const onnxRuntimeLicensePath = pathInsideRoot(
  'vendor/licenses/onnxruntime-web-1.25.0-dev.20260327-722743c0e2-LICENSE',
  'ONNX Runtime license',
);
if (!existsSync(onnxRuntimeLicensePath)) {
  throw new Error('Missing ONNX Runtime Web license');
}

const manifestFiles = [
  {
    package: 'fabric',
    version: '5.3.1',
    license: 'MIT',
    source: 'https://cdnjs.cloudflare.com/ajax/libs/fabric.js/5.3.1/fabric.min.js',
    path: 'vendor/fabric-5.3.1.min.js',
    sha256: sha256(fabricPath),
    bytes: statSync(fabricPath).size,
  },
];

for (const source of sources) {
  const target = copyRequiredFile(source.source, source.target);
  manifestFiles.push({
    package: source.packageName,
    version: source.version,
    license: source.license,
    source: source.source,
    path: source.target.replaceAll('\\', '/'),
    sha256: sha256(target),
    bytes: statSync(target).size,
  });
}

for (const [source, target] of licenseSources) {
  copyRequiredFile(source, target);
}

const manifestPath = pathInsideRoot('vendor/runtime-manifest.json', 'Runtime manifest');
const manifest = {
  schemaVersion: 1,
  files: manifestFiles.sort((left, right) => left.path.localeCompare(right.path, 'en')),
};
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

const expectedFiles = new Set([
  'vendor/fabric-5.3.1.min.js',
  'vendor/runtime-manifest.json',
  'vendor/licenses/fabric-5.3.1-LICENSE',
  'vendor/licenses/onnxruntime-web-1.25.0-dev.20260327-722743c0e2-LICENSE',
  ...sources.map((source) => source.target.replaceAll('\\', '/')),
  ...licenseSources.map(([, target]) => target.replaceAll('\\', '/')),
]);
const vendorRoot = pathInsideRoot('vendor', 'Vendor directory');
const unexpectedFiles = listFiles(vendorRoot)
  .map((filePath) => relative(packageRoot, filePath).split(sep).join('/'))
  .filter((filePath) => !expectedFiles.has(filePath));
if (unexpectedFiles.length > 0) {
  throw new Error(`Unexpected files in vendor directory: ${unexpectedFiles.join(', ')}`);
}

console.log(`Vendored ${manifest.files.length} audited OpenShop runtime files.`);
