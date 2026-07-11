import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join, relative, resolve } from 'node:path';

const root = resolve(process.cwd());
const textExtensions = new Set(['.py', '.html', '.js', '.css', '.md', '.txt', '.bat', '.command', '.sh', '.json']);
const skippedDirs = new Set(['.git', 'python', 'packages', 'assets', 'output', 'build', 'node_modules']);
const allowedReplacementCharFiles = new Set([join('static', 'js', 'i18n', 'validate-i18n.js')]);
const allowedMojibakeTokenFiles = new Set([join('static', 'js', 'i18n', 'validate-i18n.js')]);
const visibleMojibakePattern = /鎼滅储|銆|脳|鐏|寮€|鏉愯川|璐村浘|绮楃硻|閲嶇疆|澶嶄綅|宸插|鍏抽棴|楂樺害|姘村钩|鑹叉俯|闃村奖|杩斿洖|瀹屾垚|鐐瑰嚮|æ|å|ç|è|ä|ï|ã/;

function walk(dir, files = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const rel = relative(root, path);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      if (!skippedDirs.has(name)) walk(path, files);
      continue;
    }
    if (stat.isFile()) files.push(rel);
  }
  return files;
}

function hasDangerousCharacters(text, rel) {
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (ch === '\uFFFD' && !allowedReplacementCharFiles.has(rel)) return true;
    if (code >= 0xe000 && code <= 0xf8ff) return true;
    if (code < 32 && !['\n', '\r', '\t'].includes(ch)) return true;
  }
  return false;
}

const files = walk(root);
const dangerous = [];
const mojibake = [];
const invalidJson = [];
for (const rel of files) {
  if (!textExtensions.has(extname(rel).toLowerCase())) continue;
  const abs = join(root, rel);
  const text = readFileSync(abs, 'utf8');
  if (hasDangerousCharacters(text, rel)) dangerous.push(rel);
  if (!allowedMojibakeTokenFiles.has(rel) && visibleMojibakePattern.test(text)) mojibake.push(rel);
  if (extname(rel).toLowerCase() === '.json') {
    try { JSON.parse(text.replace(/^\uFEFF/, '')); }
    catch (error) { invalidJson.push(`${rel}: ${error.message}`); }
  }
}

assert.deepEqual(dangerous, [], `dangerous encoding characters found:\n${dangerous.join('\n')}`);
assert.deepEqual(mojibake, [], `visible mojibake tokens found:\n${mojibake.join('\n')}`);
assert.deepEqual(invalidJson, [], `invalid JSON files found:\n${invalidJson.join('\n')}`);

const activeServerLogs = new Set(['hstarA-server.err.log', 'hstarA-server.log']);
const rootLogs = readdirSync(root).filter((name) => name.endsWith('.log') && !activeServerLogs.has(name));
assert.deepEqual(rootLogs, [], `root log files should be cleaned: ${rootLogs.join(', ')}`);

const indexHtml = readFileSync(join(root, 'static', 'index.html'), 'utf8');
const tailwindScriptIndex = indexHtml.indexOf('/static/vendor/js/tailwindcss-cdn.js');
const mutationGuardIndex = indexHtml.indexOf('__hstarSafeMutationObserverObserve');
assert.ok(tailwindScriptIndex > -1, 'studio shell must load the local Tailwind runtime');
assert.ok(
  mutationGuardIndex > -1 && mutationGuardIndex < tailwindScriptIndex,
  'studio shell must install the MutationObserver safety guard before Tailwind runs',
);

if (process.env.HSTAR_HEALTH_URL) {
  const base = process.env.HSTAR_HEALTH_URL.replace(/\/$/, '');
  const [canvases, settings, assets] = await Promise.all([
    fetch(`${base}/api/canvases`).then((res) => res.json()),
    fetch(`${base}/api/software-settings`).then((res) => res.json()),
    fetch(`${base}/api/asset-library`).then((res) => res.json()),
  ]);
  assert.ok(Array.isArray(canvases.canvases), 'canvas API must return a canvas list');
  assert.ok(settings.settings?.active_storage_root, 'software settings API must expose active storage root');
  assert.ok(Array.isArray(assets.library?.libraries), 'asset library API must return libraries');
}

console.log('HstarC health check passed');
