import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';
import vm from 'node:vm';

const root = resolve(process.cwd());
const panelPath = resolve(root, 'static/js/storage-settings-panel.js');
assert.ok(existsSync(panelPath), 'storage migration controller must exist');

const panel = readFileSync(panelPath, 'utf8');
const html = readFileSync(resolve(root, 'static/software-settings.html'), 'utf8');

assert.match(html, /id="storageProgressWrap"[^>]*hidden/, 'storage card must include a hidden progress region');
assert.match(html, /id="storageProgress"/, 'storage card must include a progress element');
assert.match(html, /id="storageCancelBtn"/, 'storage card must include a cancel command');
assert.match(html, /src="\/static\/js\/storage-settings-panel\.js\?v=[0-9.]+"/, 'storage controller must be versioned');
assert.doesNotMatch(html, /fetch\('\/api\/software-settings\/storage'/, 'page must not call the retired blocking endpoint');

assert.match(panel, /POLL_INTERVAL_MS\s*=\s*500/, 'migration status must poll every 500 ms');
assert.match(panel, /fetch\('\/api\/storage-migrations'/, 'controller must create background migration tasks');
assert.match(panel, /`\/api\/storage-migrations\/\$\{[^}]+\}`/, 'controller must poll and cancel the task endpoint');
assert.match(panel, /method:\s*'DELETE'/, 'cancel must use the idempotent delete endpoint');
assert.match(panel, /copied_bytes/, 'controller must render copied byte progress');
assert.match(panel, /total_bytes/, 'controller must support determinate progress');
assert.match(panel, /removeAttribute\('value'\)/, 'unknown totals must remain indeterminate');
assert.match(panel, /type:\s*'hstar-restart-with-data-root'/, 'completed migration must request a controlled shell restart');
assert.match(panel, /迁移完成，请重新启动 Hstar 以使用新位置。/, 'browser-only mode must present the manual restart result');
assert.doesNotMatch(panel, /location\.reload/, 'controller must not reload into the old backend process');

function fakeElement() {
  return {
    hidden: false,
    textContent: '',
    className: '',
    value: '',
    disabled: false,
    attributes: new Map(),
    listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

const ids = [
  'currentPath', 'storageInput', 'status', 'saveBtn', 'browseBtn',
  'storageProgressWrap', 'storageProgress', 'storageProgressStage',
  'storageProgressBytes', 'storageCancelBtn',
];
const elements = Object.fromEntries(ids.map(id => [id, fakeElement()]));
const shellMessages = [];
const window = {
  document: {getElementById: id => elements[id] || null},
  fetch: async path => {
    assert.equal(path, '/api/software-settings');
    return {
      ok: true,
      json: async () => ({settings: {active_storage_root: 'E:/Hstar缓存'}}),
    };
  },
  chrome: {webview: {postMessage: message => shellMessages.push(message)}},
  setTimeout,
  clearTimeout,
};
window.window = window;
window.parent = window;
vm.runInNewContext(panel, {window, console, setTimeout, clearTimeout});
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));

assert.equal(elements.currentPath.textContent, 'E:/Hstar缓存');
window.HstarStorageSettingsPanel.renderTask({
  id: 'copy-1',
  status: 'copying',
  copied_bytes: 25,
  total_bytes: 100,
  current_path: 'projects/canvas.json',
});
assert.equal(elements.storageProgress.value, 25);
assert.equal(elements.saveBtn.disabled, true);
assert.match(elements.storageProgressStage.textContent, /projects\/canvas\.json/);

await window.HstarStorageSettingsPanel.handoffCompletedMigration({
  id: 'complete-1',
  status: 'completed',
  target: 'D:/Hstar Data',
});
assert.equal(shellMessages.length, 1);
assert.equal(shellMessages[0].type, 'hstar-restart-with-data-root');
assert.equal(shellMessages[0].dataRoot, 'D:/Hstar Data');

delete window.chrome;
await window.HstarStorageSettingsPanel.handoffCompletedMigration({
  id: 'complete-2',
  status: 'completed',
  target: 'F:/Portable/Hstar',
});
assert.equal(elements.status.textContent, '迁移完成，请重新启动 Hstar 以使用新位置。');

console.log('storage settings panel checks passed');
