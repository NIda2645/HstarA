import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const directorRoot = path.join(root, 'static', '3d-director');
const windows11StageRoot = path.join(root, 'build', 'installer', 'stage', 'windows11');
const indexPath = path.join(directorRoot, 'index.html');
const attributesPath = path.join(root, '.gitattributes');
const approvedSharedAssets = new Map([
  ['/static/js/voice-input-adapter.js', path.join(root, 'static', 'js', 'voice-input-adapter.js')],
]);

assert.ok(fs.existsSync(indexPath), 'static/3d-director/index.html exists');

const attributes = fs.readFileSync(attributesPath, 'utf8');
assert.match(
  attributes,
  /^integrations\/storyai-3d-director-desk\/index\.html\s+text\s+eol=lf\b/m,
  'director source template uses deterministic LF line endings',
);
assert.match(
  attributes,
  /^integrations\/storyai-3d-director-desk\/public\/\*\*\/\*\.txt\s+text\s+eol=lf\b/m,
  'director public text assets use deterministic LF line endings',
);
for(const extension of ['html', 'js', 'css', 'txt']){
  assert.match(
    attributes,
    new RegExp(`^static/3d-director/\\*\\*/\\*\\.${extension}\\s+text\\s+eol=lf\\b`, 'm'),
    `director built ${extension} assets use deterministic LF line endings`,
  );
}

const index = fs.readFileSync(indexPath, 'utf8');
const assetRefs = [...index.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]);
assert.ok(assetRefs.length > 0, 'director build references local assets');

for(const ref of assetRefs){
  assert.ok(!/^https?:\/\//i.test(ref), `director asset is not external: ${ref}`);
  if(ref.startsWith('data:') || ref.startsWith('#')) continue;
  const cleanRef = ref.split('?')[0].split('#')[0];
  if(cleanRef.startsWith('/')){
    assert.ok(approvedSharedAssets.has(cleanRef), `director absolute asset is approved: ${ref}`);
    assert.ok(fs.existsSync(approvedSharedAssets.get(cleanRef)), `director shared asset exists: ${ref}`);
    continue;
  }
  const assetPath = path.resolve(directorRoot, cleanRef);
  assert.ok(assetPath.startsWith(directorRoot), `director asset stays inside static/3d-director: ${ref}`);
  assert.ok(fs.existsSync(assetPath), `director asset exists: ${ref}`);
}

assert.ok(fs.existsSync(path.join(directorRoot, 'assets')), 'director assets directory exists');
assert.ok(fs.existsSync(path.join(directorRoot, 'models')), 'director models directory exists');
if(fs.existsSync(windows11StageRoot)){
  assert.ok(fs.existsSync(path.join(windows11StageRoot, 'static', '3d-director', 'index.html')), 'Windows 11 stage contains the director entry point');
  assert.ok(fs.existsSync(path.join(windows11StageRoot, 'static', '3d-director', 'models', 'ue-mannequin-retopology.glb')), 'Windows 11 stage contains the director model payload');
}

const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {encoding: 'utf8'});
assert.ok(!staged.split(/\r?\n/).some(line => line.startsWith('build/installer/stage/')), 'installer stage is not staged');

try {
  execFileSync('git', ['check-ignore', '-q', 'build/installer/stage/windows11/'], {stdio: 'pipe'});
} catch(error) {
  assert.fail('build/installer/stage/windows11/ should be ignored');
}
