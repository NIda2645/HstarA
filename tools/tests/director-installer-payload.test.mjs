import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = process.cwd();
const directorRoot = path.join(root, 'static', '3d-director');
const indexPath = path.join(directorRoot, 'index.html');

assert.ok(fs.existsSync(indexPath), 'static/3d-director/index.html exists');

const index = fs.readFileSync(indexPath, 'utf8');
const assetRefs = [...index.matchAll(/(?:src|href)=["']([^"']+)["']/g)].map(match => match[1]);
assert.ok(assetRefs.length > 0, 'director build references local assets');

for(const ref of assetRefs){
  assert.ok(!/^https?:\/\//i.test(ref), `director asset is not external: ${ref}`);
  if(ref.startsWith('data:') || ref.startsWith('#')) continue;
  const cleanRef = ref.split('?')[0].split('#')[0];
  const assetPath = path.resolve(directorRoot, cleanRef);
  assert.ok(assetPath.startsWith(directorRoot), `director asset stays inside static/3d-director: ${ref}`);
  assert.ok(fs.existsSync(assetPath), `director asset exists: ${ref}`);
}

assert.ok(fs.existsSync(path.join(directorRoot, 'assets')), 'director assets directory exists');
assert.ok(fs.existsSync(path.join(directorRoot, 'models')), 'director models directory exists');

const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {encoding: 'utf8'});
assert.ok(!staged.split(/\r?\n/).some(line => line.startsWith('build/installer/stage/')), 'installer stage is not staged');

try {
  execFileSync('git', ['check-ignore', '-q', 'build/installer/stage/'], {stdio: 'pipe'});
} catch(error) {
  assert.fail('build/installer/stage/ should be ignored');
}
