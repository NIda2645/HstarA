import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const allowDirs = new Set(['vendor']);
const hits = [];

function walk(dir){
  for(const entry of fs.readdirSync(dir, {withFileTypes:true})){
    if(entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    const rel = path.relative(root, full).replace(/\\/g, '/');
    if(entry.isDirectory()){
      if(rel.startsWith('static/') && allowDirs.has(entry.name)) continue;
      walk(full);
      continue;
    }
    if(!/\.(?:html|js|css)$/.test(entry.name)) continue;
    if(rel === 'static/js/i18n/validate-i18n.js') continue;
    const text = fs.readFileSync(full, 'utf8');
    if(/console\.log\s*\(/.test(text)) hits.push(rel);
  }
}

walk(path.join(root, 'static'));
assert.deepEqual(hits, [], 'static runtime files should not contain leftover console.log debug output');
console.log('static debug output tests passed');
