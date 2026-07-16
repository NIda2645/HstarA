# OpenShop Crash-Safe Local File Import Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Route OpenShop image and PSD file selection through an out-of-process Windows dialog so a native picker failure cannot terminate Codex, while retaining existing OpenShop decode and validation behavior.

**Architecture:** A focused standard-library Python module owns PowerShell dialog construction and selected-file validation. FastAPI exposes a loopback, same-origin binary streaming endpoint; OpenShop reconstructs a `File` from that response and passes it to the existing image or PSD importer, with browser input fallback only when the backend explicitly reports an unsupported platform.

**Tech Stack:** Python 3.10 standard library, FastAPI/Starlette `FileResponse`, JavaScript, Fabric.js, Vitest/jsdom, Playwright

---

## File Map

- Create `native_file_picker.py`: dialog filters, PowerShell subprocess isolation, lock, timeout, path and size validation.
- Create `tests/test_native_file_picker.py`: standard-library unit tests for success, cancel, invalid files, failure, and timeout.
- Modify `main.py`: request model, local/same-origin endpoint, binary response headers.
- Modify `integrations/openshop/index.html`: native file request client and safe `openFile()` / `openPSD()` routing.
- Modify `integrations/openshop/tests/os-unit.test.js`: front-end response, cancel, error, and cross-platform fallback coverage.
- Modify `integrations/openshop/tests/hstar-foundation.e2e.spec.js`: real PNG/PSD fixture import without opening a system dialog.
- Build changed OpenShop runtime files under `static/openshop/`.

### Task 1: Isolated Native Picker Module

**Files:**
- Create: `native_file_picker.py`
- Create: `tests/test_native_file_picker.py`

- [ ] **Step 1: Write failing standard-library tests**

Test a fake PowerShell runner against a real temporary image file:

```python
class NativeFilePickerTests(unittest.TestCase):
    def test_selects_and_validates_an_image_without_exposing_a_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            selected = os.path.join(folder, "sample.png")
            with open(selected, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")

            def runner(command, **kwargs):
                self.assertEqual(command[:4], ["powershell", "-NoProfile", "-STA", "-Command"])
                self.assertIn("*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp", command[4])
                return SimpleNamespace(returncode=0, stdout=f"{selected}\n", stderr="")

            result = choose_open_file_path("image", runner=runner, platform="nt")
            metadata = selected_file_metadata(result, "image")
            self.assertEqual(metadata["name"], "sample.png")
            self.assertNotIn(folder, metadata["name"])

    def test_returns_empty_string_when_the_dialog_is_cancelled(self):
        runner = lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout="", stderr="")
        self.assertEqual(choose_open_file_path("psd", runner=runner, platform="nt"), "")
```

Also test unsupported platform (`501`), invalid kind (`400`), disallowed extension (`400`), image over 100 MiB (`413`), PSD over 256 MiB (`413`), nonzero helper exit (`500`), and `subprocess.TimeoutExpired` (`504`).

- [ ] **Step 2: Run the test and verify RED**

Run from the worktree root:

```powershell
$repoRoot = (Resolve-Path (Join-Path (git rev-parse --git-common-dir) '..')).Path
& "$repoRoot\python\python.exe" -m unittest discover -s tests -p 'test_native_file_picker.py' -v
```

Expected: FAIL because `native_file_picker` does not exist.

- [ ] **Step 3: Implement the focused module**

Define immutable file rules and one typed error:

```python
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"}
PSD_EXTENSIONS = {".psd"}
MAX_BYTES = {"image": 100 * 1024 * 1024, "psd": 256 * 1024 * 1024}
PICKER_LOCK = Lock()

class NativeFilePickerError(Exception):
    def __init__(self, status_code: int, detail: str):
        super().__init__(detail)
        self.status_code = status_code
        self.detail = detail
```

`choose_open_file_path(kind, runner=subprocess.run, platform=os.name)` must:

1. Normalize `kind` to `image` or `psd`.
2. Reject non-Windows with status `501`.
3. Construct the fixed filter and title without browser-provided path input.
4. Hold `PICKER_LOCK` only while `runner()` executes.
5. Call `powershell -NoProfile -STA -Command <script>` with UTF-8 capture and 300-second timeout.
6. Return `""` on cancel, otherwise return `validate_selected_file(last_stdout_line, kind)`.

`selected_file_metadata(path, kind)` must return only `path`, base `name`, `size`, and MIME. PSD MIME is `image/vnd.adobe.photoshop`; images use `mimetypes.guess_type()` with `application/octet-stream` fallback.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the same unittest command.

Expected: all native picker tests PASS.

- [ ] **Step 5: Commit the isolated module**

```bash
git add native_file_picker.py tests/test_native_file_picker.py
git commit -m "feat: add isolated native file picker"
```

### Task 2: Local Binary File Endpoint

**Files:**
- Modify: `main.py:44`
- Modify: `main.py:2856`
- Modify: `main.py:12525`
- Modify: `tests/test_native_file_picker.py`

- [ ] **Step 1: Write failing endpoint tests**

Import `main` after the focused module tests, construct a Starlette `Request` with loopback client, local host and matching origin, and patch the picker functions:

```python
def request_for(client="127.0.0.1", origin="http://127.0.0.1:3000"):
    return Request({
        "type":"http", "method":"POST", "path":"/api/native/open-local-file",
        "scheme":"http", "query_string":b"", "server":("127.0.0.1", 3000),
        "client":(client, 50000),
        "headers":[
            (b"host", b"127.0.0.1:3000"),
            (b"origin", origin.encode("ascii")),
        ],
    })

with patch.object(main, "choose_open_file_path", return_value=selected):
    response = main.open_native_local_file(
        main.NativeOpenFileRequest(kind="image"), request_for()
    )
self.assertEqual(response.status_code, 200)
self.assertEqual(response.headers["x-hstar-filename"], "sample.png")
self.assertEqual(response.headers["cache-control"], "no-store")
self.assertNotIn(folder, str(response.headers))
```

Add cancellation (`204`), remote client (`403`), and mismatched origin (`403`) cases.

- [ ] **Step 2: Run the endpoint tests and verify RED**

Run the same unittest command.

Expected: FAIL because `NativeOpenFileRequest` and `open_native_local_file` do not exist.

- [ ] **Step 3: Add request model and endpoint**

Import the picker API in `main.py` and add:

```python
class NativeOpenFileRequest(BaseModel):
    kind: str = "image"

@app.post("/api/native/open-local-file")
def open_native_local_file(payload: NativeOpenFileRequest, request: Request):
    client_host = str(getattr(getattr(request, "client", None), "host", "") or "")
    if not is_gemini_cli_loopback_hostname(client_host):
        raise HTTPException(status_code=403, detail="仅允许本机打开本地文件。")
    ensure_same_origin_request(request)
    try:
        selected = choose_open_file_path(payload.kind)
        if not selected:
            return Response(status_code=204, headers={"Cache-Control":"no-store"})
        metadata = selected_file_metadata(selected, payload.kind)
    except NativeFilePickerError as error:
        raise HTTPException(status_code=error.status_code, detail=error.detail) from error
    headers = {
        "X-Hstar-Filename": urllib.parse.quote(metadata["name"], safe=""),
        "X-Hstar-File-Size": str(metadata["size"]),
        "Cache-Control":"no-store",
    }
    return FileResponse(metadata["path"], media_type=metadata["mime"], headers=headers)
```

- [ ] **Step 4: Run Python tests and compile check**

Run the unittest command, then:

```powershell
$repoRoot = (Resolve-Path (Join-Path (git rev-parse --git-common-dir) '..')).Path
& "$repoRoot\python\python.exe" -m py_compile main.py native_file_picker.py
```

Expected: tests PASS and compile exits `0`.

- [ ] **Step 5: Commit endpoint support**

```bash
git add main.py tests/test_native_file_picker.py
git commit -m "feat: stream native file selections to OpenShop"
```

### Task 3: OpenShop Safe Import Client

**Files:**
- Modify: `integrations/openshop/index.html:1753`
- Modify: `integrations/openshop/index.html:1980`
- Modify: `integrations/openshop/tests/os-unit.test.js`

- [ ] **Step 1: Write failing front-end tests**

Mock `window.fetch`, `_handleFileLoad`, `_loadPSDFile`, and hidden input clicks. Verify successful image and PSD responses never click browser inputs:

```js
window.fetch = vi.fn().mockResolvedValue(new Response(
  new Blob(['file-bytes'], {type:'image/png'}),
  {status:200, headers:{
    'Content-Type':'image/png',
    'X-Hstar-Filename':encodeURIComponent('测试图片.png'),
  }},
));
OS._handleFileLoad = vi.fn();
const click = vi.spyOn(document.getElementById('file-input'), 'click');

await OS.openFile();

expect(window.fetch).toHaveBeenCalledWith('/api/native/open-local-file', expect.objectContaining({
  method:'POST', body:JSON.stringify({kind:'image'}),
}));
expect(OS._handleFileLoad).toHaveBeenCalledWith(expect.objectContaining({name:'测试图片.png'}));
expect(click).not.toHaveBeenCalled();
```

Add tests for PSD routing, `204` cancel, `500` error without fallback, and `501` fallback that clicks only the appropriate hidden input.

- [ ] **Step 2: Run the unit test and verify RED**

Run: `npm.cmd test -- tests/os-unit.test.js`

Expected: FAIL because `openFile()` still invokes browser picker/input and `openPSD()` is synchronous.

- [ ] **Step 3: Implement `_requestNativeLocalFile(kind)`**

```js
async _requestNativeLocalFile(kind) {
    const response = await fetch('/api/native/open-local-file', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({kind}),
    });
    if (response.status === 204) return {file:null, fallback:false};
    if (response.status === 501) return {file:null, fallback:true};
    if (!response.ok) {
        const value = await response.json().catch(() => ({}));
        throw new Error(value.detail || `Native file picker failed (${response.status})`);
    }
    const blob = await response.blob();
    const encodedName = response.headers.get('X-Hstar-Filename') || '';
    const name = decodeURIComponent(encodedName) || (kind === 'psd' ? 'document.psd' : 'image.png');
    return {file:new File([blob], name, {type:blob.type || response.headers.get('Content-Type') || ''}), fallback:false};
},
```

`openFile()` and `openPSD()` await this method. On success call the existing importer; on `fallback:true` click the relevant hidden input; on any other error show a toast and do not invoke a browser picker. Remove the `showOpenFilePicker()` branch.

- [ ] **Step 4: Run focused OpenShop tests**

Run: `npm.cmd test -- tests/os-unit.test.js`

Expected: all OS unit tests PASS.

- [ ] **Step 5: Commit front-end routing**

```bash
git add integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js
git commit -m "fix: isolate OpenShop local file dialogs"
```

### Task 4: Real PNG and PSD Browser Integration

**Files:**
- Modify: `integrations/openshop/tests/hstar-foundation.e2e.spec.js`
- Generate: `static/openshop/index.html`

- [ ] **Step 1: Write a failing browser integration test**

Read `static/images/logo.png` and `tests/golden/openshop-text-layer-probe.psd`. Intercept `**/api/native/open-local-file`, choose fixture by request body, and return the binary content plus headers. Install counters on both hidden file inputs and a throwing `showOpenFilePicker` sentinel.

Call `OS.openFile()` and assert 150×150 with one image object. Then call `OS.openPSD()` and assert 1024×512, two editable document layers, no error toast, zero browser input clicks, and zero `showOpenFilePicker` calls.

- [ ] **Step 2: Run the new E2E test against the stale build and verify RED**

Run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm.cmd run test:hstar:e2e -- --grep "imports local image and PSD"
```

Expected: FAIL because the static build still uses browser file dialogs.

- [ ] **Step 3: Build static OpenShop**

Run: `npm.cmd run build:hstar`

Expected: `static/openshop/index.html` updates and build ends with a 64-character `OPENSHOP_BUILD_SHA256`.

- [ ] **Step 4: Restart the engineering server and run full relevant E2E**

Restart `main.py` from the worktree, verify `GET /` returns `200`, then run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm.cmd run test:hstar:e2e
npm.cmd run test:hstar:canvas-integration
```

Expected: foundation and canvas integration suites PASS, including the new import test.

- [ ] **Step 5: Commit E2E and build output**

```bash
git add integrations/openshop/tests/hstar-foundation.e2e.spec.js static/openshop/index.html
git commit -m "test: verify crash-safe OpenShop file import"
```

### Task 5: Full Verification and Native Dialog Smoke Test

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run all Python and OpenShop unit tests**

Run Python unittest and compile commands from Tasks 1 and 2.

Run: `npm.cmd test`

Expected: all Python and Vitest tests PASS.

- [ ] **Step 2: Run generative E2E regression**

Run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm.cmd run test:hstar:generative
```

Expected: all generative tests PASS.

- [ ] **Step 3: Perform a real native picker smoke test**

In HstarA's OpenShop editor, click “打开图像”. Confirm the visible dialog belongs to the independent PowerShell helper, select the repository `static/images/logo.png`, and verify the document becomes 150×150 without Codex or HstarA exiting. Repeat “打开 PSD” with `integrations/openshop/tests/golden/openshop-text-layer-probe.psd` and verify a 1024×512 document opens.

- [ ] **Step 4: Inspect repository scope**

Run: `git status --short`

Expected: only the user's pre-existing `data/asset_library.json`, `assets/`, and unrelated `static/*.html` changes remain. No picker process, test output, local path, temporary file, or crash artifact is staged.

- [ ] **Step 5: Preserve the feature branch**

Keep `codex/openshop-inline-generative-editing` and its worktree unchanged for user acceptance testing. Do not merge `main` until the user explicitly requests it.
