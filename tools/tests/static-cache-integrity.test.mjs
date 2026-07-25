import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const version = fs.readFileSync('VERSION', 'utf8').trim().split(/\r?\n/)[0];
const backendSource = fs.readFileSync('main.py', 'utf8');
const runtimeRevision = backendSource.match(/OPENSHOP_RUNTIME_REVISION\s*=\s*["']([^"']+)["']/)?.[1];
const entryAssetBlock = backendSource.match(/OPENSHOP_ENTRY_ASSET_URLS\s*=\s*frozenset\(\{([\s\S]*?)\}\)/)?.[1] || '';
const entryAssetUrls = new Set(
  [...entryAssetBlock.matchAll(/["'](\/static\/[^"']+)["']/g)].map(match => match[1]),
);
const htmlFiles = [];

assert.ok(runtimeRevision, 'main.py should define the OpenShop runtime revision');
assert.ok(entryAssetUrls.size > 0, 'main.py should define OpenShop entry assets');

function walk(dir){
  for(const entry of fs.readdirSync(dir, {withFileTypes:true})){
    const full = path.join(dir, entry.name);
    if(entry.isDirectory()){
      if(entry.name === 'vendor' || entry.name === 'node_modules') continue;
      walk(full);
    } else if(entry.name.endsWith('.html')) {
      htmlFiles.push(full);
    }
  }
}

walk(path.join(root, 'static'));

const mismatches = [];
const refPattern = /(?:src|href|data-src)=["'](\/static\/[^"'?]+)\?v=([^"']+)["']/g;

for(const file of htmlFiles){
  const source = fs.readFileSync(file, 'utf8');
  let match;
  while((match = refPattern.exec(source))){
    const refPath = match[1];
    const localPath = path.join(root, refPath.slice(1));
    if(!fs.existsSync(localPath)) continue;
    const expected = entryAssetUrls.has(refPath)
      ? runtimeRevision
      : `${version}.${Math.floor(fs.statSync(localPath).mtimeMs / 1000)}`;
    if(match[2] !== expected){
      mismatches.push(`${path.relative(root, file)} -> ${refPath}: ${match[2]} !== ${expected}`);
    }
  }
}

assert.deepEqual(mismatches, [], 'static HTML cache keys should match the backend versioning contract');

console.log('static cache integrity tests passed');
