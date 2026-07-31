import assert from 'node:assert/strict';
import {readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const directorRoot = path.join(root, 'static', '3d-director');
const html = await readFile(path.join(directorRoot, 'index.html'), 'utf8');
const entryMatch = html.match(/<script[^>]+type="module"[^>]+src="([^"]+\.js)"/i);

assert.ok(entryMatch, 'Director build exposes a module entry script');
const entryPath = path.resolve(directorRoot, entryMatch[1]);
const entry = await stat(entryPath);

assert.ok(
  entry.size <= 600 * 1024,
  `Director application entry must stay at or below 600 KiB; received ${entry.size} bytes`,
);

const viteConfig = await readFile(
  path.join(root, 'integrations', 'storyai-3d-director-desk', 'vite.config.ts'),
  'utf8',
);
assert.match(viteConfig, /manualChunks/, 'Director build keeps vendor code outside the application entry');

const gitignore = await readFile(path.join(root, '.gitignore'), 'utf8');
assert.match(
  gitignore,
  /!static\/3d-director\/assets\/\*\*/,
  'generated Director chunks remain visible to Git and release builds',
);

console.log(`Director application entry size contract passed: ${entry.size} bytes`);
