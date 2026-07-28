import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../static/canvas-list.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../static/js/canvas-list.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/canvas-list.css', import.meta.url), 'utf8');

const purgeAllIndex = html.indexOf('id="trashPurgeAll"');
const closeIndex = html.indexOf('id="trashClose"');

assert.ok(purgeAllIndex >= 0, 'trash header should expose a purge-all button');
assert.ok(closeIndex > purgeAllIndex, 'purge-all button should be immediately before the close action');
assert.match(html, /id="trashPurgeAllDialog"[^>]*role="dialog"[^>]*aria-modal="true"/,
  'trash purge-all should use an accessible in-app confirmation dialog');
assert.match(html, /id="trashPurgeAllConfirm"/, 'confirmation dialog should expose a destructive confirm action');
assert.match(html, /id="trashPurgeAllCancel"/, 'confirmation dialog should expose a cancel action');
assert.match(html, /是否确认删除回收站内全部可回收画布？/, 'dialog should clearly describe the batch deletion');
assert.match(html, /删除后无法恢复。/, 'dialog should warn that deletion cannot be undone');

assert.match(js, /trashPurgeAllBtn\.disabled\s*=\s*trashPurgeAllBusy\s*\|\|\s*deletedCanvases\.length\s*===\s*0/,
  'purge-all should be disabled while busy or when trash is empty');
assert.match(js, /fetch\('\/api\/canvases\/trash\/purge-all',\s*\{\s*method:\s*'DELETE'\s*\}\)/,
  'confirmation should call the dedicated batch purge API');
assert.match(js, /async function purgeAllCanvases\(\)[\s\S]*await loadAll\(\);[\s\S]*await loadTrash\(\);/,
  'successful batch deletion should reload active and trashed canvas state');
assert.match(js, /trashPurgeAllBtn\.addEventListener\('click',\s*openTrashPurgeAllDialog\)/,
  'purge-all button should open the confirmation dialog');
assert.match(js, /trashPurgeAllConfirmBtn\.addEventListener\('click',\s*purgeAllCanvases\)/,
  'confirm action should execute batch deletion');

assert.match(css, /\.ws-trash-head-actions\s*\{/,
  'trash header should group the purge-all and close controls');
assert.match(css, /\.ws-trash-bulk-dialog\s*\{/,
  'trash confirmation dialog should have dedicated visual styling');

console.log('canvas trash purge-all UI tests passed');
