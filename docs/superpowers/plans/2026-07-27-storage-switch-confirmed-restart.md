# Storage Switch Confirmation and Automatic Restart Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require confirmation before changing Hstar's storage root, leave all storage state untouched on cancellation, and automatically restart both the Windows desktop build and the port-3000 development runtime after confirmation.

**Architecture:** Keep `/api/storage-migrations` as the only storage-root mutation path. Add a settings-page confirmation boundary before that request, reuse the existing WebView2 restart message in packaged builds, and add a loopback-only development restart endpoint that gracefully stops Uvicorn and re-executes the same Python entry point with the newly persisted data root. Browser mode identifies the replacement backend by a new health-instance id before reloading.

**Tech Stack:** Python 3.12, FastAPI, Uvicorn, vanilla JavaScript, HTML `<dialog>`, Node.js contract tests, .NET 8 WPF/WebView2 tests, PowerShell source gate.

---

## File Map

- Modify `static/software-settings.html`: storage confirmation dialog, restart overlay, retry controls, theme-aware styling, and cache version.
- Modify `static/js/storage-settings-panel.js`: active-root state, confirmation lifecycle, direct-switch handoff, browser restart request, replacement-instance polling, and retry behavior.
- Modify `tools/tests/storage-settings-panel.test.mjs`: executable DOM tests for cancellation, confirmation, same-path handling, desktop restart, browser restart, and retries.
- Modify `main.py`: restart request model, health metadata, development restart endpoint, shutdown scheduling, and process re-execution.
- Create `tests/test_development_restart_api.py`: endpoint security, bootstrap matching, idempotence, health metadata, and re-exec command tests.
- Modify `tools/tests/software-settings-integration.test.mjs`: static integration contracts for the confirmation and restart endpoints.
- Modify `static/index.html`: synchronize the software-settings iframe cache key if the repository cache-integrity contract requires it.
- Verify `desktop/Hstar.Desktop/Runtime/WebViewConfiguration.cs` and `desktop/Hstar.Desktop.Tests/WebViewConfigurationTests.cs`: retain the existing packaged restart contract; production edits are only made if a failing regression test proves they are required.

## Task 1: Lock the pre-switch confirmation contract

**Files:**
- Modify: `tools/tests/storage-settings-panel.test.mjs`
- Modify: `tools/tests/software-settings-integration.test.mjs`
- Test: `tools/tests/storage-settings-panel.test.mjs`

- [ ] **Step 1: Extend the fake DOM with dialog behavior**

Add the storage dialog, path label, restart overlay, and retry elements to the test fixture. The fake dialog must model `showModal()`, `close()`, and a cancellable `cancel` event:

```javascript
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
```

- [ ] **Step 2: Write failing cancellation and same-path tests**

Track all fetch calls. After loading `Y`, edit the input to `X` and click save. Assert the dialog opens before any storage mutation request. Click cancel and assert that `storageInput.value` returns to `Y`, no `/api/storage-migrations` request exists, and the page remains usable. Repeat through the dialog `cancel` event. Save `Y` and assert no dialog and no restart:

```javascript
elements.storageInput.value = 'X:/New Root';
await elements.saveBtn.listeners.get('click')();
assert.equal(elements.storageRestartDialog.open, true);
assert.equal(fetchCalls.some(call => call.path === '/api/storage-migrations'), false);

elements.storageRestartCancel.listeners.get('click')();
assert.equal(elements.storageRestartDialog.open, false);
assert.equal(elements.storageInput.value, 'E:/Hstar缓存');
assert.equal(fetchCalls.some(call => call.path === '/api/storage-migrations'), false);
```

- [ ] **Step 3: Write a failing confirmation test**

Confirm `X` and assert the first storage mutation request occurs only after confirmation and occurs exactly once:

```javascript
elements.storageInput.value = 'X:/New Root';
await elements.saveBtn.listeners.get('click')();
await elements.storageRestartConfirm.listeners.get('click')();
const switches = fetchCalls.filter(call => call.path === '/api/storage-migrations');
assert.equal(switches.length, 1);
assert.deepEqual(JSON.parse(switches[0].options.body), {storage_root: 'X:/New Root'});
```

- [ ] **Step 4: Add failing static integration assertions**

Require the storage confirmation dialog and restart overlay in `static/software-settings.html`, and require the controller to compare against a retained active root before calling `startMigration`.

- [ ] **Step 5: Run the focused tests and verify RED**

Run:

```powershell
node tools/tests/storage-settings-panel.test.mjs
node tools/tests/software-settings-integration.test.mjs
```

Expected: FAIL because the storage confirmation and restart elements do not exist and save still starts the switch immediately.

## Task 2: Implement the confirmation UI without touching storage on cancel

**Files:**
- Modify: `static/software-settings.html`
- Modify: `static/js/storage-settings-panel.js`
- Test: `tools/tests/storage-settings-panel.test.mjs`

- [ ] **Step 1: Add the theme-aware storage dialog and restart overlay**

Add a dedicated dialog rather than sharing mutable voice-dialog state:

```html
<dialog id="storageRestartDialog" class="settings-confirm-dialog">
  <form class="settings-confirm-panel" method="dialog">
    <h2>确认重启 Hstar</h2>
    <p>确认后将切换储存位置并自动重启 Hstar。原储存位置中的数据不会被迁移、删除或修改。</p>
    <div class="settings-confirm-fact">
      <span>新的储存位置</span>
      <span id="storageRestartTarget">-</span>
    </div>
    <div class="settings-confirm-toolbar">
      <button id="storageRestartCancel" type="button">取消</button>
      <button id="storageRestartConfirm" class="primary" type="button">确认并重启</button>
    </div>
  </form>
</dialog>
<div id="storageRestartOverlay" class="storage-restart-overlay" hidden>
  <div role="status" aria-live="assertive">
    <strong>正在重新启动 Hstar</strong>
    <span id="storageRestartMessage">正在等待新的 Hstar 服务...</span>
    <div class="settings-confirm-toolbar">
      <button id="storageRestartDetect" type="button" hidden>重新检测</button>
      <button id="storageRestartRetry" type="button" hidden>重试重启</button>
    </div>
  </div>
</div>
```

Use `var(--card)`, `var(--text)`, `var(--muted)`, `var(--line)`, and `var(--strong)` for both themes. Keep dialog radius at `8px` and make `[hidden]` remove the overlay from layout.

- [ ] **Step 2: Retain and compare the active root**

Add controller state and path comparison that handles slash direction, trailing separators, and Windows case differences without resolving or probing the candidate directory:

```javascript
let activeStorageRoot = '';
let pendingStorageRoot = '';

function comparablePath(value) {
  return String(value || '')
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\//g, '\\')
    .toLocaleLowerCase('en-US');
}
```

`loadSettings()` stores `activeStorageRoot`. No client-side operation may call the folder endpoint or storage switch merely to compare paths.

- [ ] **Step 3: Add confirmation and cancellation functions**

```javascript
function requestStorageRestartConfirmation(storageRoot) {
  const candidate = String(storageRoot || '').trim();
  if (!candidate) {
    setStatus('请输入储存文件夹路径。', 'err');
    return false;
  }
  if (comparablePath(candidate) === comparablePath(activeStorageRoot)) {
    elements.storageInput.value = activeStorageRoot;
    setStatus('当前已使用该储存位置。', 'ok');
    return false;
  }
  pendingStorageRoot = candidate;
  elements.storageRestartTarget.textContent = candidate;
  elements.storageRestartDialog.showModal();
  return true;
}

function cancelStorageRestartConfirmation() {
  pendingStorageRoot = '';
  elements.storageInput.value = activeStorageRoot;
  elements.storageRestartDialog.close();
  setStatus('已取消更改储存位置。');
}

async function confirmStorageRestart() {
  const target = pendingStorageRoot;
  if (!target) return null;
  pendingStorageRoot = '';
  elements.storageRestartDialog.close();
  return startMigration(target);
}
```

Bind save to `requestStorageRestartConfirmation`, both cancel paths to `cancelStorageRestartConfirmation`, and confirm to `confirmStorageRestart`. Prevent duplicate confirmation while busy or while a task is active.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run:

```powershell
node tools/tests/storage-settings-panel.test.mjs
node tools/tests/software-settings-integration.test.mjs
```

Expected: both scripts print their success messages and exit `0`.

## Task 3: Lock the development restart backend contract

**Files:**
- Create: `tests/test_development_restart_api.py`
- Modify: `tests/test_storage_migration_api.py`
- Test: `tests/test_development_restart_api.py`

- [ ] **Step 1: Write failing health and endpoint tests**

Use `httpx.ASGITransport` with loopback and remote clients. Patch `main.EDITION`, `main.BOOTSTRAP`, `main.STORAGE_ROOT`, `main.ACTIVE_UVICORN_SERVER`, and restart state per test. Require:

```python
async def test_health_identifies_runtime_and_active_storage(self):
    response = await self.local.get('/api/health')
    self.assertEqual(response.status_code, 200)
    self.assertEqual(response.json()['instance_id'], main.CLIENT_ID)
    self.assertEqual(response.json()['active_storage_root'], str(self.source))

async def test_loopback_development_restart_requires_persisted_target(self):
    self.bootstrap.save(BootstrapConfig(1, 'development', str(self.target)))
    response = await self.local.post(
        '/api/runtime/restart',
        json={'expected_storage_root': str(self.target)},
    )
    self.assertEqual(response.status_code, 202)
    self.assertTrue(response.json()['scheduled'])
    self.assertTrue(self.server.should_exit)
```

Also assert `403` for non-development and non-loopback requests, `409` when expected target differs from bootstrap, `503` when no active Uvicorn server exists, and idempotent success for a repeated request targeting the same directory.

- [ ] **Step 2: Write a failing re-exec command test**

Patch `os.execv` and assert the function sets exact environment values before re-execution:

```python
with patch.object(main.os, 'execv') as execv:
    main.DEVELOPMENT_RESTART_TARGET = self.target.resolve()
    main.exec_development_restart_if_scheduled()

self.assertEqual(os.environ['HSTAR_DATA_DIR'], str(self.target.resolve()))
execv.assert_called_once_with(
    sys.executable,
    [sys.executable, '-B', '-X', 'utf8', str(Path(main.__file__).resolve())],
)
```

Preserve and restore environment variables in teardown so tests cannot leak runtime state.

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
.\python\python.exe -m unittest tests.test_development_restart_api
```

Expected: FAIL because `/api/runtime/restart`, health instance metadata, and re-exec logic do not exist.

## Task 4: Implement the loopback-only development restart

**Files:**
- Modify: `main.py`
- Test: `tests/test_development_restart_api.py`

- [ ] **Step 1: Add restart state and request model**

Near the Uvicorn server state add:

```python
ACTIVE_UVICORN_SERVER = None
DEVELOPMENT_RESTART_TARGET: Optional[Path] = None
DEVELOPMENT_RESTART_LOCK = Lock()
```

Add:

```python
class RuntimeRestartRequest(BaseModel):
    expected_storage_root: str = Field(min_length=1, max_length=1024)
```

- [ ] **Step 2: Extend health metadata**

Return only non-secret process identity and path state:

```python
return {
    'ok': True,
    'edition': EDITION,
    'version': current_app_version(),
    'instance_id': CLIENT_ID,
    'active_storage_root': STORAGE_ROOT,
}
```

- [ ] **Step 3: Add the restart endpoint**

Implement validation before changing any restart state:

```python
@app.post('/api/runtime/restart', status_code=202)
async def restart_development_runtime(payload: RuntimeRestartRequest, request: Request):
    if EDITION != 'development' or not is_loopback_request(request):
        raise HTTPException(status_code=403, detail='当前环境不允许自动重启 Hstar')
    target = Path(payload.expected_storage_root).expanduser().resolve()
    validate_storage_root_location(str(target))
    persisted = BOOTSTRAP.require().resolved_data_root()
    if os.path.normcase(str(target)) != os.path.normcase(str(persisted)):
        raise HTTPException(status_code=409, detail='重启目录与已确认的储存位置不一致')
    server = ACTIVE_UVICORN_SERVER
    if server is None:
        raise HTTPException(status_code=503, detail='Hstar 服务尚未进入可重启状态')
    global DEVELOPMENT_RESTART_TARGET
    with DEVELOPMENT_RESTART_LOCK:
        if DEVELOPMENT_RESTART_TARGET not in (None, target):
            raise HTTPException(status_code=409, detail='已有其他储存位置正在等待重启')
        DEVELOPMENT_RESTART_TARGET = target
    asyncio.get_running_loop().call_soon(setattr, server, 'should_exit', True)
    return {'ok': True, 'scheduled': True, 'instance_id': CLIENT_ID}
```

Use the repository's existing localized error style when implementing. Do not call `/api/storage-migrations` from this endpoint.

- [ ] **Step 4: Re-execute after graceful Uvicorn shutdown**

```python
def exec_development_restart_if_scheduled() -> bool:
    target = DEVELOPMENT_RESTART_TARGET
    if target is None:
        return False
    os.environ['HSTAR_DATA_DIR'] = str(target)
    os.environ['HSTAR_PROGRAM_DIR'] = str(PROGRAM_ROOT)
    os.environ['HSTAR_EDITION'] = 'development'
    os.environ['HSTAR_HOST'] = resolve_server_host()
    os.environ['HSTAR_PORT'] = str(resolve_server_port())
    argv = [sys.executable, '-B', '-X', 'utf8', str(Path(__file__).resolve())]
    os.execv(sys.executable, argv)
    return True

if __name__ == '__main__':
    run_server()
    exec_development_restart_if_scheduled()
```

This preserves the current hidden process context and does not launch a shell or touch port `5000`.

- [ ] **Step 5: Run backend tests and verify GREEN**

Run:

```powershell
.\python\python.exe -m unittest tests.test_development_restart_api tests.test_storage_migration_api
```

Expected: all tests pass with no environment leakage.

## Task 5: Lock browser restart and recovery behavior

**Files:**
- Modify: `tools/tests/storage-settings-panel.test.mjs`
- Test: `tools/tests/storage-settings-panel.test.mjs`

- [ ] **Step 1: Write the failing successful-restart test**

Run without `chrome.webview`. Make fetch return old health metadata, accept `/api/runtime/restart`, fail health while the server is down, then return a new instance with target `X`. Assert reload occurs exactly once and storage switching occurs exactly once:

```javascript
healthQueue.push(
  {instance_id: 'old', active_storage_root: 'Y:/Current'},
  new TypeError('connection refused'),
  {instance_id: 'new', active_storage_root: 'X:/New Root'},
);
await window.HstarStorageSettingsPanel.restartBrowserRuntime('X:/New Root');
assert.equal(reloadCount, 1);
assert.equal(restartRequests.length, 1);
assert.equal(storageSwitchRequests.length, 1);
```

- [ ] **Step 2: Write failing timeout and retry tests**

Inject a short polling limit. Assert timeout reveals both recovery buttons. Clicking “重新检测” polls without another restart request. Clicking “重试重启” posts only `/api/runtime/restart` and never posts another `/api/storage-migrations`.

- [ ] **Step 3: Run the test and verify RED**

Run:

```powershell
node tools/tests/storage-settings-panel.test.mjs
```

Expected: FAIL because browser restart coordination does not exist.

## Task 6: Implement browser replacement-instance detection

**Files:**
- Modify: `static/js/storage-settings-panel.js`
- Test: `tools/tests/storage-settings-panel.test.mjs`

- [ ] **Step 1: Add restart state and health reads**

Track only the already switched target; never route retry through `startMigration`:

```javascript
let restartTarget = '';
let restartInstanceId = '';

async function readRuntimeHealth() {
  return request('/api/health');
}
```

- [ ] **Step 2: Add replacement polling**

```javascript
async function waitForReplacementRuntime(target, previousInstanceId, attempts = 160) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    await delay(500);
    try {
      const health = await readRuntimeHealth();
      if (health.instance_id !== previousInstanceId
          && comparablePath(health.active_storage_root) === comparablePath(target)) {
        global.location.reload();
        return true;
      }
    } catch (_) {
      // The old process is expected to be unavailable during restart.
    }
  }
  showRestartRecovery('Hstar 重启等待超时，请重新检测或重试重启。');
  return false;
}
```

Use the existing injectable `setTimeout` path in tests rather than a busy loop.

- [ ] **Step 3: Add browser restart and retry commands**

Read current health first, show the overlay, then post the expected target:

```javascript
async function restartBrowserRuntime(target) {
  restartTarget = target;
  const health = await readRuntimeHealth();
  restartInstanceId = String(health.instance_id || '');
  await request('/api/runtime/restart', {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({expected_storage_root: target}),
  });
  return waitForReplacementRuntime(target, restartInstanceId);
}
```

“重新检测” calls only `waitForReplacementRuntime`; “重试重启” calls only `restartBrowserRuntime(restartTarget)`.

- [ ] **Step 4: Route completed switches by host environment**

Keep the existing desktop message path. When `chrome.webview.postMessage` is absent, replace the manual-restart status with `restartBrowserRuntime(dataRoot)`. Update `activeStorageRoot` only after the replacement process is confirmed.

- [ ] **Step 5: Run the focused tests and verify GREEN**

Run:

```powershell
node tools/tests/storage-settings-panel.test.mjs
node tools/tests/software-settings-integration.test.mjs
```

Expected: both pass; retries never create a second storage switch.

## Task 7: Preserve the packaged desktop restart contract

**Files:**
- Verify: `desktop/Hstar.Desktop/Runtime/WebViewConfiguration.cs`
- Modify only if RED: `desktop/Hstar.Desktop.Tests/WebViewConfigurationTests.cs`
- Test: `desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj`

- [ ] **Step 1: Run the focused desktop tests**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter "FullyQualifiedName~WebViewConfigurationTests"
```

Expected: PASS, proving the existing message validates source, absolute path, program-root exclusion, bootstrap agreement, and invokes one controlled restart.

- [ ] **Step 2: Add a regression test only if the new frontend message exposes a contract gap**

If the focused test fails because the frontend payload differs, keep the message contract exactly:

```json
{
  "type": "hstar-restart-with-data-root",
  "dataRoot": "X:\\SelectedRoot"
}
```

Do not weaken WebView origin or bootstrap validation.

## Task 8: Synchronize static cache keys and run focused verification

**Files:**
- Modify: `static/software-settings.html`
- Modify if required: `static/index.html`
- Test: `tools/tests/static-cache-integrity.test.mjs`

- [ ] **Step 1: Update the storage controller cache version**

Change the `storage-settings-panel.js` query version and synchronize any matching version recorded by the parent page.

- [ ] **Step 2: Run focused verification**

Run:

```powershell
node tools/tests/storage-settings-panel.test.mjs
node tools/tests/software-settings-integration.test.mjs
node tools/tests/static-cache-integrity.test.mjs
.\python\python.exe -m unittest tests.test_development_restart_api tests.test_storage_migration_api
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter "FullyQualifiedName~WebViewConfigurationTests"
git diff --check
```

Expected: every command exits `0`.

## Task 9: Execute a real isolated restart smoke test

**Files:**
- No source edits unless the smoke test reveals a defect.

- [ ] **Step 1: Start an isolated development server**

Use temporary `Y`, target `X`, and a free loopback port other than `3000` and `5000`. Launch with the bundled Python and explicit development environment.

- [ ] **Step 2: Record both directory trees**

Create an ordinary file in `Y` and another in `X`, recording bytes, size, and `LastWriteTimeUtc.Ticks` before the switch.

- [ ] **Step 3: Switch and restart through real HTTP**

POST `/api/storage-migrations`, wait for `switch_storage` completion, read the old `/api/health` instance id, POST `/api/runtime/restart`, then poll until a different instance id reports `active_storage_root == X`.

- [ ] **Step 4: Verify zero data mutation**

Assert the ordinary files in `Y` and `X` retain the same bytes, size, and timestamps, no source canvas was copied, and the bootstrap target equals `X`.

- [ ] **Step 5: Stop only the isolated process**

Terminate the process owning the temporary test port. Do not inspect, stop, or alter port `5000`.

## Task 10: Run the complete HstarA source gate

**Files:**
- No source edits unless verification reveals a scoped defect.

- [ ] **Step 1: Run the complete gate**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File build/scripts/Test-HstarSource.ps1
```

Expected: Python, Node, OpenShop, desktop, build, encoding, secret, static cache, isolated smoke, compile, and `git diff --check` checks all pass.

- [ ] **Step 2: Verify the live HstarA process**

Restart only HstarA on port `3000`, then verify:

```powershell
curl.exe -s -o NUL -w "%{http_code}" http://127.0.0.1:3000/
.\python\python.exe -X utf8 -c "import json,urllib.request; print(json.load(urllib.request.urlopen('http://127.0.0.1:3000/api/health')))"
```

Expected: HTTP `200`, a nonempty `instance_id`, and exact `active_storage_root` `E:\Hstar缓存` unless the user has explicitly selected another root during testing.

- [ ] **Step 3: Review the final diff**

Confirm only the planned files changed for this feature, no unrelated dirty-worktree changes were reverted, no generated caches remain, and no commit, merge, push, or cleanup is performed without explicit user instruction.
