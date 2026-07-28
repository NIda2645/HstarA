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
assert.match(html, /id="storageRestartDialog"/, 'storage settings must confirm before changing the active root');
assert.match(html, /id="storageRestartTarget"/, 'storage restart confirmation must show the selected target');
assert.match(html, /id="storageRestartCancel"/, 'storage restart confirmation must expose cancellation');
assert.match(html, /id="storageRestartConfirm"/, 'storage restart confirmation must expose explicit confirmation');
assert.match(html, /id="storageRestartOverlay"[^>]*hidden/, 'automatic restart must have a hidden blocking overlay');
assert.match(html, /id="storageRestartMessage"/, 'restart overlay must expose live status');
assert.match(html, /id="storageRestartRetry"[^>]*hidden/, 'restart overlay must expose a hidden retry command');
assert.match(html, /id="storageRestartDetect"[^>]*hidden/, 'restart overlay must expose a hidden detection command');
assert.match(html, /aria-label="存储位置应用状态"/, 'storage progress must describe direct application rather than migration');
assert.match(html, /id="storageCancelBtn"[^>]*>取消应用<\/button>/, 'storage cancellation must use switch wording');
assert.doesNotMatch(html, /数据迁移进度/, 'storage card must not describe direct switching as data migration');
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
assert.match(panel, /'\/api\/runtime\/restart'/, 'browser development mode must request a controlled runtime restart');
assert.match(panel, /instance_id/, 'browser restart must distinguish the replacement backend instance');
assert.match(panel, /location\.reload/, 'browser mode must reload only after the replacement backend is verified');
assert.match(panel, /requestStorageRestartConfirmation/, 'save must enter a confirmation boundary before switching storage');

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
    focus() {},
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
  };
}

function fakeDialog() {
  const element = fakeElement();
  element.open = false;
  element.showModal = () => { element.open = true; };
  element.close = () => { element.open = false; };
  return element;
}

const ids = [
  'currentPath', 'storageInput', 'status', 'saveBtn', 'browseBtn',
  'storageProgressWrap', 'storageProgress', 'storageProgressStage',
  'storageProgressBytes', 'storageCancelBtn', 'storageRestartDialog',
  'storageRestartTarget', 'storageRestartCancel', 'storageRestartConfirm',
  'storageRestartOverlay', 'storageRestartMessage', 'storageRestartRetry',
  'storageRestartDetect',
];
function createPanelElements() {
  const result = Object.fromEntries(ids.map(id => [id, fakeElement()]));
  result.storageRestartDialog = fakeDialog();
  return result;
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

const elements = createPanelElements();
const shellMessages = [];
const fetchCalls = [];
const window = {
  document: {getElementById: id => elements[id] || null},
  fetch: async (path, options = {}) => {
    fetchCalls.push({path, options});
    if (path === '/api/software-settings') {
      return jsonResponse({settings: {active_storage_root: 'E:/Hstar缓存'}});
    }
    if (path === '/api/storage-migrations') {
      return jsonResponse({
        ok: true,
        task: {id: 'switch-request', operation: 'switch_storage', status: 'failed'},
      });
    }
    assert.fail(`unexpected fetch: ${path}`);
    return {
      ok: false,
      json: async () => ({}),
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
fetchCalls.length = 0;

elements.storageInput.value = 'X:/New Root';
elements.saveBtn.listeners.get('click')();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.equal(elements.storageRestartDialog.open, true, 'save must open confirmation first');
assert.equal(elements.storageRestartTarget.textContent, 'X:/New Root');
assert.equal(fetchCalls.some(call => call.path === '/api/storage-migrations'), false, 'confirmation must precede storage mutation');

elements.storageRestartCancel.listeners.get('click')();
assert.equal(elements.storageRestartDialog.open, false);
assert.equal(elements.storageInput.value, 'E:/Hstar缓存', 'cancel must restore the active root');
assert.equal(fetchCalls.some(call => call.path === '/api/storage-migrations'), false, 'cancel must remain a zero-request operation');

elements.storageInput.value = 'X:/New Root';
elements.saveBtn.listeners.get('click')();
await elements.storageRestartConfirm.listeners.get('click')();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
const confirmedSwitches = fetchCalls.filter(call => call.path === '/api/storage-migrations');
assert.equal(confirmedSwitches.length, 1, 'confirmation must submit exactly one storage switch');
assert.deepEqual(JSON.parse(confirmedSwitches[0].options.body), {storage_root: 'X:/New Root'});

elements.storageInput.value = 'E:/Hstar缓存/';
elements.saveBtn.listeners.get('click')();
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.equal(elements.storageRestartDialog.open, false, 'equivalent active path must not open confirmation');
assert.equal(fetchCalls.filter(call => call.path === '/api/storage-migrations').length, 1, 'equivalent active path must not switch storage');

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

window.HstarStorageSettingsPanel.renderTask({
  id: 'switch-1',
  operation: 'switch_storage',
  status: 'preflight',
  copied_bytes: 0,
  total_bytes: 0,
});
assert.equal(elements.storageProgressStage.textContent, '正在应用存储位置');
assert.equal(elements.status.textContent, '正在应用存储位置');
assert.equal(elements.storageProgress.hidden, true);
assert.equal(elements.storageProgressBytes.hidden, true);
assert.equal(elements.storageCancelBtn.hidden, true);

window.HstarStorageSettingsPanel.renderTask({
  id: 'cancel-1',
  status: 'cancelling',
  copied_bytes: 25,
  total_bytes: 100,
});
assert.equal(elements.storageProgressStage.textContent, '正在取消迁移');
assert.equal(elements.status.textContent, '正在取消迁移');
assert.equal(elements.saveBtn.disabled, true);
assert.equal(elements.browseBtn.disabled, true);
assert.equal(elements.storageCancelBtn.disabled, true);
assert.equal(elements.storageCancelBtn.hidden, false);

await window.HstarStorageSettingsPanel.handoffCompletedMigration({
  id: 'switch-complete-1',
  status: 'completed',
  operation: 'switch_storage',
  target: 'X:/Direct Storage',
});
assert.equal(elements.status.textContent, '存储位置已切换，正在重新启动 Hstar。');
assert.equal(shellMessages.length, 1);
assert.equal(shellMessages[0].type, 'hstar-restart-with-data-root');
assert.equal(shellMessages[0].dataRoot, 'X:/Direct Storage');

await window.HstarStorageSettingsPanel.handoffCompletedMigration({
  id: 'complete-1',
  status: 'completed',
  target: 'D:/Hstar Data',
});
assert.equal(shellMessages.length, 2);
assert.equal(shellMessages[1].type, 'hstar-restart-with-data-root');
assert.equal(shellMessages[1].dataRoot, 'D:/Hstar Data');

await window.HstarStorageSettingsPanel.handoffCompletedMigration({
  id: 'activate-1',
  status: 'completed',
  operation: 'activate_existing',
  target: 'E:/Hstar缓存',
});
assert.equal(elements.status.textContent, '存储位置已切换，正在重新启动 Hstar。');
assert.equal(shellMessages.length, 3);
assert.equal(shellMessages[2].dataRoot, 'E:/Hstar缓存');

const browserElements = createPanelElements();
const browserFetchCalls = [];
const browserHealth = [
  {instance_id: 'browser-old', active_storage_root: 'Y:/Current'},
  new TypeError('connection refused'),
  {instance_id: 'browser-new', active_storage_root: 'X:/Browser Storage'},
];
let browserReloads = 0;
const browserWindow = {
  document: {getElementById: id => browserElements[id] || null},
  fetch: async (path, options = {}) => {
    browserFetchCalls.push({path, options});
    if (path === '/api/software-settings') {
      return jsonResponse({settings: {active_storage_root: 'Y:/Current'}});
    }
    if (path === '/api/health') {
      const next = browserHealth.shift();
      if (next instanceof Error) throw next;
      return jsonResponse(next);
    }
    if (path === '/api/runtime/restart') {
      return jsonResponse({ok: true, scheduled: true, instance_id: 'browser-old'}, 202);
    }
    assert.fail(`unexpected browser fetch: ${path}`);
  },
  location: {reload: () => { browserReloads += 1; }},
  setTimeout: callback => { Promise.resolve().then(callback); return 1; },
  clearTimeout() {},
};
browserWindow.window = browserWindow;
browserWindow.parent = browserWindow;
vm.runInNewContext(panel, {window: browserWindow, console, setTimeout, clearTimeout});
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));

await browserWindow.HstarStorageSettingsPanel.handoffCompletedMigration({
  id: 'browser-switch-complete',
  status: 'completed',
  operation: 'switch_storage',
  target: 'X:/Browser Storage',
});
assert.equal(browserFetchCalls.filter(call => call.path === '/api/runtime/restart').length, 1);
assert.equal(browserFetchCalls.filter(call => call.path === '/api/storage-migrations').length, 0);
assert.equal(browserReloads, 1, 'verified replacement runtime must reload once');

const timeoutElements = createPanelElements();
const timeoutFetchCalls = [];
let timeoutReloads = 0;
let timeoutHealthMode = 'old';
const timeoutWindow = {
  HSTAR_STORAGE_RESTART_POLL_ATTEMPTS: 2,
  HSTAR_STORAGE_RESTART_POLL_INTERVAL_MS: 0,
  document: {getElementById: id => timeoutElements[id] || null},
  fetch: async (path, options = {}) => {
    timeoutFetchCalls.push({path, options});
    if (path === '/api/software-settings') {
      return jsonResponse({settings: {active_storage_root: 'Y:/Current'}});
    }
    if (path === '/api/health') {
      return jsonResponse(timeoutHealthMode === 'old'
        ? {instance_id: 'timeout-old', active_storage_root: 'Y:/Current'}
        : {instance_id: 'timeout-new', active_storage_root: 'X:/Timeout Target'});
    }
    if (path === '/api/runtime/restart') {
      return jsonResponse({ok: true, scheduled: true, instance_id: 'timeout-old'}, 202);
    }
    assert.fail(`unexpected timeout fetch: ${path}`);
  },
  location: {reload: () => { timeoutReloads += 1; }},
  setTimeout: callback => { Promise.resolve().then(callback); return 1; },
  clearTimeout() {},
};
timeoutWindow.window = timeoutWindow;
timeoutWindow.parent = timeoutWindow;
vm.runInNewContext(panel, {window: timeoutWindow, console, setTimeout, clearTimeout});
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));

await timeoutWindow.HstarStorageSettingsPanel.handoffCompletedMigration({
  id: 'timeout-switch-complete',
  status: 'completed',
  operation: 'switch_storage',
  target: 'X:/Timeout Target',
});
assert.equal(timeoutReloads, 0);
assert.equal(timeoutElements.storageRestartRetry.hidden, false);
assert.equal(timeoutElements.storageRestartDetect.hidden, false);
assert.equal(timeoutFetchCalls.filter(call => call.path === '/api/runtime/restart').length, 1);

timeoutHealthMode = 'new';
await timeoutElements.storageRestartDetect.listeners.get('click')();
assert.equal(timeoutReloads, 1, 'manual detection must accept the verified replacement runtime');
assert.equal(timeoutFetchCalls.filter(call => call.path === '/api/runtime/restart').length, 1, 'detection must not request another restart');
assert.equal(timeoutFetchCalls.filter(call => call.path === '/api/storage-migrations').length, 0, 'recovery must never repeat storage switching');

console.log('storage settings panel checks passed');
