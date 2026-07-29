import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from 'node:fs';
import {relative, resolve, sep} from 'node:path';

const root = resolve(process.cwd());
const builderPath = resolve(root, 'build/scripts/New-HstarWindows11Stage.ps1');
const sourceGatePath = resolve(root, 'build/scripts/Test-HstarSource.ps1');
const validatorPath = resolve(root, 'build/scripts/Test-HstarWindows11Stage.ps1');
const attributesPath = resolve(root, '.gitattributes');
const stageRoot = resolve(root, 'build/installer/stage/windows11');

for (const [path, label] of [
  [builderPath, 'deterministic Windows 11 stage builder'],
  [sourceGatePath, 'source release gate'],
  [validatorPath, 'Windows 11 stage validator'],
]) {
  assert.ok(existsSync(path), `${label} exists`);
}

const builder = readFileSync(builderPath, 'utf8');
const sourceGate = readFileSync(sourceGatePath, 'utf8');
const validator = readFileSync(validatorPath, 'utf8');
const attributes = readFileSync(attributesPath, 'utf8');

assert.match(attributes, /^integrations\/openshop\/index\.html text eol=lf$/m, 'OpenShop source entry point has deterministic LF bytes');
assert.match(attributes, /^static\/openshop\/index\.html text eol=lf$/m, 'OpenShop runtime mirror entry point has deterministic LF bytes');

assert.match(builder, /\[switch\]\s*\$AllowDirtyForTest/, 'dirty builds require an explicit test-only switch');
assert.match(builder, /git[\s\S]*status[\s\S]*--porcelain/, 'builder checks the Git worktree state');
assert.match(builder, /Test-HstarSource\.ps1/, 'builder runs the complete source gate');
assert.doesNotMatch(builder, /Skip(?:Source|Tests|Build|Validation)/i, 'official builder has no source-gate skip switch');
assert.match(builder, /windows11-runtime\.json/, 'builder consumes the exact runtime lock');
assert.match(builder, /Get-FileHash[\s\S]*SHA256/i, 'builder verifies locked artifact hashes');
assert.match(builder, /runtime-cache[\\/]windows11/i, 'downloaded runtime artifacts stay in the ignored cache');
assert.match(builder, /dotnet[\s\S]*publish[\s\S]*--self-contained[\s\S]*true/i, 'desktop shell is self-contained');
assert.match(builder, /PublishSingleFile=false/i, 'desktop shell keeps complete runtime files');
assert.match(builder, /PublishTrimmed=false/i, 'desktop shell disables trimming for runtime completeness');
assert.match(builder, /python311\._pth/, 'embedded Python path configuration is deterministic');
assert.match(builder, /--no-index[\s\S]*--find-links/i, 'embedded Python dependencies install offline');
assert.match(builder, /core\.quotepath=false[\s\S]*ls-files[\s\S]*-z/i, 'tracked UTF-8 paths use an unambiguous NUL-delimited Git inventory');
assert.match(builder, /StandardOutputEncoding[\s\S]*UTF8/i, 'tracked Git paths are decoded explicitly as UTF-8');
assert.match(builder, /--cached[\s\S]*--others[\s\S]*--exclude-standard/i, 'test stages include non-ignored current source files');
assert.match(builder, /\.Split\(@\(\[char\]0\),\s*\[StringSplitOptions\]::RemoveEmptyEntries\)/i, 'PowerShell 5 uses the char-array Split overload without a trailing empty path');
assert.match(builder, /Where-Object\s*\{\s*\$_\.Extension\s*-in\s*@\('\.pyc',\s*'\.pyo'\)\s*\}/i, 'compiled Python cleanup filters exact extensions');
assert.doesNotMatch(builder, /Get-ChildItem[^\r\n]*-Include[^\r\n]*\*\.pyc/i, 'PowerShell 5 cleanup does not use the unsafe LiteralPath/Include combination');
assert.match(builder, /Get-ChildItem\s+-LiteralPath\s+\$sitePackages\s+-Recurse\s+-Directory[\s\S]*Where-Object\s*\{\s*\$_\.Name\s*-in\s*@\('test',\s*'tests'\)\s*\}/i, 'third-party wheel test directories are removed from the runtime');
assert.match(builder, /Test-HstarWindows11Stage\.ps1/, 'builder validates the completed stage');
assert.match(builder, /sbom\.spdx\.json/, 'builder creates an SPDX inventory');
assert.match(builder, /files\.sha256/, 'builder creates a complete file hash manifest');

for (const requiredCommand of [
  /audit-text-encoding\.mjs/,
  /audit-secrets\.mjs/,
  /unittest[\s\S]*discover/,
  /tools[\\/]tests[\s\S]*\.test\.mjs/,
  /\$openShopRoot\s*=\s*Join-Path[^\r\n]+integrations[\\/]openshop/,
  /Invoke-Native\s+-Command\s+'npm\.cmd'\s+-Arguments\s+@\('test',\s*'--prefix',\s*\$openShopRoot\)/,
  /build-hstar\.mjs/,
  /\$directorRoot\s*=\s*Join-Path[^\r\n]+storyai-3d-director-desk/,
  /Invoke-Native\s+-Command\s+'npm\.cmd'\s+-Arguments\s+@\('test',\s*'--prefix',\s*\$directorRoot\)/,
  /Invoke-Native\s+-Command\s+'npm\.cmd'\s+-Arguments\s+@\([\s\S]*'run',[\s\S]*'build',[\s\S]*'--prefix',[\s\S]*\$directorRoot,[\s\S]*'--outDir',[\s\S]*\$directorBuildRoot/,
  /\$desktopTests\s*=\s*Join-Path[^\r\n]+Hstar\.Desktop\.Tests/,
  /Invoke-Native\s+-Command\s+'dotnet'\s+-Arguments\s+@\('test',\s*\$desktopTests/,
  /test:hstar:canvas-integration/,
]) {
  assert.match(sourceGate, requiredCommand, `source gate includes ${requiredCommand}`);
}
assert.doesNotMatch(sourceGate, /param\s*\([\s\S]*Skip/i, 'source gate cannot skip release checks');
assert.match(sourceGate, /HSTAR_DATA_DIR/, 'browser smoke uses an isolated data root');
assert.match(sourceGate, /HSTAR_PORT/, 'browser smoke uses an isolated non-production port');
assert.match(sourceGate, /'-B'[\s\S]*unittest[\s\S]*discover/, 'source unit tests cannot create repository bytecode');
assert.match(sourceGate, /pycache_prefix=/, 'compileall writes bytecode beneath an isolated cache root');
assert.match(sourceGate, /Get-TreeDigest/, 'source gate fingerprints generated runtime mirrors');
assert.match(sourceGate, /build-hstar\.mjs'[\s\S]*'--output'[\s\S]*\$openShopBuildRoot/, 'OpenShop verification builds into an isolated directory');
assert.match(sourceGate, /PYTHONDONTWRITEBYTECODE/, 'all source-gate Python paths disable repository bytecode');
assert.match(sourceGate, /Get-Command\s+['"]python\.exe['"]/i, 'source gate uses development Python instead of the isolated packaged runtime');
assert.match(sourceGate, /ArgumentList\s+@\('-B',\s*'-X',\s*'utf8',\s*'main\.py'\)/, 'browser smoke server cannot write repository bytecode');
assert.match(sourceGate, /OpenShop build output drifted/, 'source gate rejects a stale OpenShop mirror');
assert.match(sourceGate, /3D Director build output drifted/, 'source gate rejects a stale 3D Director mirror');

assert.match(validator, /files\.sha256/, 'stage validator verifies the file manifest');
assert.match(validator, /sbom\.spdx\.json/, 'stage validator verifies the SPDX document');
assert.match(validator, /\$python\s*=\s*Join-Path[^\r\n]+runtime[\\/]python[\\/]python\.exe/i, 'stage validator binds packaged Python');
assert.match(builder, /Invoke-Native\s+-Command\s+\$embeddedPython\s+-Arguments\s+@\(\s*'-I',\s*'-B'/i, 'builder runtime import cannot create bytecode');
assert.equal([...validator.matchAll(/Invoke-Native\s+-Command\s+\$python\s+-Arguments\s+@\(\s*'-I',\s*'-B'/gi)].length, 2, 'both validator Python checks are bytecode-free');
assert.match(validator, /Invoke-Native\s+-Command\s+\$python[\s\S]*'-I'[\s\S]*'-B'[\s\S]*import fastapi,uvicorn,PIL,httpx,websockets,fontTools/i, 'stage validator imports packaged Python modules');
assert.match(validator, /\.hstar-voice|Fun-ASR-Nano|safetensors/i, 'stage validator rejects optional voice payloads');
assert.match(validator, /assets\/\(\?:input\|library\|output\|uploads\)/i, 'stage validator rejects only user-data asset directories');
assert.doesNotMatch(validator, /['"]\^assets\/['"]/i, 'stage validator does not reject every program asset directory');
assert.match(validator, /\^assets\/startup\/\(\?:index/i, 'stage validator rejects only external startup web assets');
assert.doesNotMatch(validator, /\^assets\/startup\(\//i, 'stage validator permits native startup media');
assert.match(validator, /Assets\\startup\\startup-lightfall\.mp4/i, 'stage validator requires native startup video');
assert.match(validator, /Assets\\startup\\startup-lightfall-poster\.jpg/i, 'stage validator requires native startup poster');
assert.doesNotMatch(validator, /'Assets\\startup\\(?:index\.html|startup\.css|startup\.js|ogl\.mjs)'/i, 'stage validator does not require external startup web assets');

if (!existsSync(stageRoot)) {
  console.log('Windows 11 stage scripts contract passed; no generated stage is present');
  process.exit(0);
}

const requiredStageEntries = [
  'Hstar.exe',
  'VERSION',
  'LICENSE',
  'app/main.py',
  'app/hstar_runtime/__init__.py',
  'app/voice_assistant/__init__.py',
  'API/defaults/api-providers.json',
  'workflows/Z-Image.json',
  'static/index.html',
  'static/js/desktop-shell-bridge.js',
  'static/openshop/index.html',
  'static/openshop/LICENSE',
  'static/3d-director/index.html',
  'static/3d-director/models/ue-mannequin-retopology.glb',
  'Assets/startup/startup-lightfall.mp4',
  'Assets/startup/startup-lightfall-poster.jpg',
  'runtime/python/python.exe',
  'runtime/python/pythonw.exe',
  'runtime/python/python311._pth',
  'runtime/python/Lib/site-packages/fastapi/__init__.py',
  'runtime/browser/WebView2/msedgewebview2.exe',
  'manifests/windows11-runtime.json',
  'manifests/files.sha256',
  'manifests/release.json',
  'manifests/sbom.spdx.json',
];
for (const entry of requiredStageEntries) {
  assert.ok(existsSync(resolve(stageRoot, entry)), `stage contains ${entry}`);
}

const forbiddenPatterns = [
  /(^|\/)\.git(\/|$)/i,
  /(^|\/)node_modules(\/|$)/i,
  /(^|\/)tests?(\/|$)/i,
  /(^|\/)tools\/tests(\/|$)/i,
  /^build\//i,
  /(^|\/)output(\/|$)/i,
  /(^|\/)assets\/(?:input|library|output|uploads)(\/|$)/i,
  /(^|\/)assets\/startup\/(?:index\.html|startup\.css|startup\.js|ogl\.mjs|ogl\.LICENSE\.txt)$/i,
  /(^|\/)projects?(\/|$)/i,
  /(^|\/)cache(\/|$)/i,
  /(^|\/)logs?(\/|$)/i,
  /(^|\/)\.hstar-voice(\/|$)/i,
  /FunAudioLLM\/Fun-ASR-Nano-2512/i,
  /(^|\/)voice-assistant-data(\/|$)/i,
  /(^|\/)\.cache\/modelscope(\/|$)/i,
  /(^|\/)API\/\.env$/i,
  /(^|\/)config\/api-providers\.json$/i,
  /(?:^|\/)real-smoke-.*\.json$/i,
  /\.(?:pt|safetensors|wav|pcm|raw|webm|ogg|m4a)$/i,
  /(?:^|\/)unins\d*\.(?:exe|dat)$/i,
];

function walk(directory, files = []) {
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) walk(absolute, files);
    else files.push(absolute);
  }
  return files;
}

const stagedFiles = walk(stageRoot);
const stagedRelative = stagedFiles.map(file => relative(stageRoot, file).split(sep).join('/'));
for (const entry of stagedRelative) {
  for (const pattern of forbiddenPatterns) {
    assert.doesNotMatch(entry, pattern, `stage excludes ${entry}`);
  }
}

const hashManifestPath = resolve(stageRoot, 'manifests/files.sha256');
const manifestEntries = new Map();
for (const line of readFileSync(hashManifestPath, 'utf8').split(/\r?\n/).filter(Boolean)) {
  const match = line.match(/^([a-f0-9]{64})  (.+)$/);
  assert.ok(match, `valid SHA-256 manifest line: ${line}`);
  assert.ok(!manifestEntries.has(match[2]), `hash manifest path occurs once: ${match[2]}`);
  manifestEntries.set(match[2], match[1]);
}

const expectedHashedFiles = stagedRelative
  .filter(path => path !== 'manifests/files.sha256')
  .sort();
assert.deepEqual([...manifestEntries.keys()].sort(), expectedHashedFiles, 'hash manifest covers every staged file exactly once');
for (const [path, expected] of manifestEntries) {
  const actual = createHash('sha256').update(readFileSync(resolve(stageRoot, path))).digest('hex');
  assert.equal(actual, expected, `stage file hash matches: ${path}`);
}

const runtimeLock = JSON.parse(readFileSync(resolve(root, 'build/runtime-locks/windows11-runtime.json'), 'utf8'));
const stagedRuntimeLock = JSON.parse(readFileSync(resolve(stageRoot, 'manifests/windows11-runtime.json'), 'utf8'));
assert.deepEqual(stagedRuntimeLock, runtimeLock, 'stage carries the exact dependency lock');

const release = JSON.parse(readFileSync(resolve(stageRoot, 'manifests/release.json'), 'utf8'));
assert.equal(release.edition, 'windows11');
assert.equal(release.architecture, 'x64');
assert.match(release.sourceCommit, /^[a-f0-9]{40}$/);
assert.match(release.runtimeLockSha256, /^[a-f0-9]{64}$/);
assert.equal(release.fileCount, manifestEntries.size);
assert.ok(Number.isSafeInteger(release.stageBytes) && release.stageBytes > 0);

const sbom = JSON.parse(readFileSync(resolve(stageRoot, 'manifests/sbom.spdx.json'), 'utf8'));
assert.equal(sbom.spdxVersion, 'SPDX-2.3');
assert.equal(sbom.dataLicense, 'CC0-1.0');
assert.ok(Array.isArray(sbom.packages) && sbom.packages.length > runtimeLock.packages.length);
const packageNames = new Set(sbom.packages.map(pkg => pkg.name));
for (const name of ['Hstar', 'Hstar.Desktop', 'Python', 'Microsoft Edge WebView2', 'OpenShop', 'StoryAI 3D Director']) {
  assert.ok(packageNames.has(name), `SBOM identifies ${name}`);
}
for (const dependency of runtimeLock.packages) {
  const pkg = sbom.packages.find(item => item.name.toLowerCase() === dependency.name.toLowerCase());
  assert.ok(pkg, `SBOM identifies Python package ${dependency.name}`);
  assert.equal(pkg.versionInfo, dependency.version);
  assert.ok(pkg.checksums?.some(item => item.algorithm === 'SHA256' && item.checksumValue === dependency.sha256));
}
assert.doesNotMatch(JSON.stringify(sbom), /Fun-ASR-Nano|safetensors|model\.pt/i, 'SBOM contains no optional model weight');

for (const path of stagedFiles) {
  assert.ok(statSync(path).size >= 0, `stage file is readable: ${path}`);
}

console.log(`Windows 11 stage contract passed: ${stagedFiles.length} files`);
