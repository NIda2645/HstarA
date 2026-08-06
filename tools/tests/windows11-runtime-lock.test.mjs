import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';

const root = resolve(process.cwd());
const requirementsPath = resolve(root, 'build/runtime-locks/windows11-requirements.txt');
const lockPath = resolve(root, 'build/runtime-locks/windows11-runtime.json');
const lockerPath = resolve(root, 'build/scripts/Lock-HstarRuntime.ps1');

assert.ok(existsSync(requirementsPath), 'Windows 11 direct requirements lock exists');
assert.ok(existsSync(lockPath), 'Windows 11 resolved runtime lock exists');
assert.ok(existsSync(lockerPath), 'Windows 11 runtime locker exists');

const expectedDirect = new Map([
  ['fastapi', '0.139.2'],
  ['uvicorn', '0.51.0'],
  ['requests', '2.34.2'],
  ['pydantic', '2.13.4'],
  ['python-multipart', '0.0.32'],
  ['httpx', '0.28.1'],
  ['pillow', '12.3.0'],
  ['websockets', '16.1.1'],
  ['fonttools', '4.63.0'],
]);

const requirementsSource = readFileSync(requirementsPath, 'utf8');
const requirementLines = requirementsSource
  .split(/\r?\n/)
  .map(line => line.trim())
  .filter(line => line && !line.startsWith('#'));
assert.equal(requirementLines.length, expectedDirect.size, 'direct requirements contain no extras');
for (const line of requirementLines) {
  assert.match(line, /^[A-Za-z0-9_.-]+==[^<>=!~\s]+$/, `direct requirement is exactly pinned: ${line}`);
  const [name, version] = line.split('==');
  assert.equal(expectedDirect.get(name.toLowerCase()), version, `approved direct pin is unchanged: ${name}`);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
assert.equal(lock.schemaVersion, 1);
assert.equal(lock.edition, 'windows11');
assert.equal(lock.architecture, 'x64');
assert.equal(lock.pythonAbi, 'cp311');
assert.equal(lock.requirementsFile, 'build/runtime-locks/windows11-requirements.txt');
assert.equal(
  lock.requirementsSha256,
  createHash('sha256').update(requirementsSource).digest('hex'),
  'requirements hash binds the resolved lock to its direct inputs',
);

function assertArtifact(artifact, label) {
  assert.equal(typeof artifact, 'object', `${label} metadata exists`);
  assert.match(artifact.name, /^[^/\\]+$/, `${label} filename is flat`);
  assert.match(artifact.url, /^https:\/\//, `${label} URL is HTTPS`);
  assert.doesNotMatch(artifact.url, /(?:latest|[<>~*])/i, `${label} URL is immutable`);
  assert.match(artifact.sha256, /^[a-f0-9]{64}$/, `${label} has lowercase SHA-256`);
  assert.ok(Number.isSafeInteger(artifact.size) && artifact.size > 0, `${label} records byte size`);
}

assert.equal(lock.python.version, '3.11.9');
assert.equal(lock.python.architecture, 'x64');
assert.equal(lock.python.abi, 'cp311');
assert.equal(lock.python.artifact.name, 'python-3.11.9-embed-amd64.zip');
assert.equal(
  lock.python.artifact.url,
  'https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip',
);
assertArtifact(lock.python.artifact, 'embedded Python');

assert.equal(lock.voicePython.version, '3.10.11');
assert.equal(lock.voicePython.architecture, 'x64');
assert.equal(lock.voicePython.abi, 'cp310');
assert.equal(lock.voicePython.artifact.name, 'python-3.10.11-embed-amd64.zip');
assert.equal(
  lock.voicePython.artifact.url,
  'https://www.python.org/ftp/python/3.10.11/python-3.10.11-embed-amd64.zip',
);
assertArtifact(lock.voicePython.artifact, 'voice Python');

assert.equal(lock.webView2.version, '150.0.4078.99');
assert.equal(lock.webView2.distribution, 'fixed');
assert.equal(lock.webView2.architecture, 'x64');
assert.equal(
  lock.webView2.artifact.url,
  'https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/1c394b0d-2689-4d8b-af57-2f2018abccf6/Microsoft.WebView2.FixedVersionRuntime.150.0.4078.99.x64.cab',
);
assertArtifact(lock.webView2.artifact, 'fixed WebView2');

assert.ok(Array.isArray(lock.packages) && lock.packages.length >= expectedDirect.size, 'resolved wheel list is complete');
const packageNames = new Set();
let expectedTotal = lock.python.artifact.size + lock.voicePython.artifact.size + lock.webView2.artifact.size;
for (const entry of lock.packages) {
  assert.match(entry.name, /^[A-Za-z0-9_.-]+$/, 'package name is normalized text');
  assert.match(entry.version, /^[^<>=!~*\s]+$/, `${entry.name} has an exact version`);
  assert.equal(entry.kind, 'python-wheel', `${entry.name} is distributed as a wheel`);
  assert.match(entry.filename, /\.whl$/i, `${entry.name} filename is a wheel`);
  assert.ok(
    /-(?:py2\.py3|py3)-none-any\.whl$/i.test(entry.filename)
      || /-(?:cp311|cp3\d|abi3)-[^-]*-win_amd64\.whl$/i.test(entry.filename),
    `${entry.name} wheel supports CPython 3.11 x64 or is platform-independent: ${entry.filename}`,
  );
  assertArtifact({name: entry.filename, url: entry.url, sha256: entry.sha256, size: entry.size}, `${entry.name} wheel`);
  const normalized = entry.name.toLowerCase().replaceAll('_', '-');
  assert.ok(!packageNames.has(normalized), `package occurs once: ${entry.name}`);
  packageNames.add(normalized);
  expectedTotal += entry.size;
}

for (const [name, version] of expectedDirect) {
  const normalized = name.replaceAll('_', '-');
  const entry = lock.packages.find(item => item.name.toLowerCase().replaceAll('_', '-') === normalized);
  assert.ok(entry, `direct dependency is present in resolved wheels: ${name}`);
  assert.equal(entry.version, version, `direct dependency version remains pinned: ${name}`);
}
const pipBootstrap = lock.packages.find(item => item.name.toLowerCase() === 'pip');
assert.ok(pipBootstrap, 'embedded Python includes a locked pip bootstrap wheel for optional voice runtime installation');
assert.equal(pipBootstrap.version, '26.1.2', 'pip bootstrap version is exact');
const setuptoolsBootstrap = lock.packages.find(item => item.name.toLowerCase() === 'setuptools');
assert.ok(setuptoolsBootstrap, 'embedded Python includes setuptools for pure-source optional dependencies');
assert.equal(setuptoolsBootstrap.version, '83.0.0', 'setuptools bootstrap version is exact');
const wheelBootstrap = lock.packages.find(item => item.name.toLowerCase() === 'wheel');
assert.ok(wheelBootstrap, 'embedded Python includes wheel build support for optional dependencies');
assert.equal(wheelBootstrap.version, '0.47.0', 'wheel bootstrap version is exact');
assert.equal(lock.totalDownloadBytes, expectedTotal, 'total download size matches every locked artifact');

const serialized = JSON.stringify(lock);
assert.doesNotMatch(serialized, /(?:Fun-ASR-Nano|model\.pt|\.safetensors|site-packages)/i, 'lock excludes voice models and installed runtime trees');
assert.doesNotMatch(serialized, /https:\/\/[^"']+\.(?:png|jpe?g|gif|webp|svg)(?:[?"'])/i, 'lock excludes external image assets');

const locker = readFileSync(lockerPath, 'utf8');
assert.match(locker, /\[switch\]\s*\$Refresh/, 'locker requires an explicit refresh switch to replace a lock');
assert.match(locker, /Test-Path[^\r\n]+windows11-runtime\.json|Test-Path[^\r\n]+\$lockPath/i, 'locker protects an existing lock');
assert.match(locker, /--dry-run/, 'wheel resolution never installs packages');
assert.match(locker, /--only-binary/, 'wheel resolution rejects source distributions');
assert.doesNotMatch(locker, /pip\s+install(?![^\r\n]*--dry-run)/i, 'locker never installs downloaded Python code');

console.log('Windows 11 runtime lock contract passed');
