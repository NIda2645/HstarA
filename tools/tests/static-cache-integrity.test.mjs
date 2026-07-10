import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const version = fs.readFileSync('VERSION', 'utf8').trim().split(/\r?\n/)[0];
const htmlFiles = [];

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
    const expected = `${version}.${Math.floor(fs.statSync(localPath).mtimeMs / 1000)}`;
    if(match[2] !== expected){
      mismatches.push(`${path.relative(root, file)} -> ${refPath}: ${match[2]} !== ${expected}`);
    }
  }
}

assert.deepEqual(mismatches, [], 'static HTML cache keys should match VERSION plus referenced file mtime');

console.log('static cache integrity tests passed');
