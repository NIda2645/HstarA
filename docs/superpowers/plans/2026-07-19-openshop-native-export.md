# OpenShop Native Export and Send Acknowledgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Windows-native local saving for every OpenShop export path and show send success only after the receiving canvas has created and persisted the output node.

**Architecture:** A focused OpenShop export service will own artifact validation, Blob-to-Base64 conversion, recent-folder lookup, and calls to the existing native-save APIs. OpenShop will expose format generators for raster, SVG, PDF, and PSD artifacts, while the host protocol coordinates the new top-bar download command and validates completion acknowledgements from classic and smart canvas adapters.

**Tech Stack:** Vanilla JavaScript, Fabric.js 5.3.1, jsPDF 4.2.1, ag-psd 22.0.2, FastAPI/Pydantic, Vitest/jsdom, Playwright, Python unittest.

---

## File Structure

- Create `integrations/openshop/host/openshop-export-service.js`: format dispatch, artifact validation, Blob/Base64 conversion, native single-save and batch-save clients.
- Create `integrations/openshop/tests/hstar-export-service.test.js`: isolated export-service contract tests.
- Create `tests/test_native_output_save.py`: backend native-save validation, filtering, cancellation, and collision tests.
- Modify `main.py`: accept Base64 batch items, validate all items before opening a folder picker, secure both native-save routes, and select format-specific Save As filters.
- Modify `integrations/openshop/index.html`: generate all six artifact types, route file-menu/settings/batch actions through the export service, and expose a notification-free runtime download method.
- Modify `integrations/openshop/scripts/build-hstar.mjs`: include the new export service in the approved runtime build.
- Modify `integrations/openshop/host/openshop-protocol.js`: add scoped local-download request/result message types.
- Modify `integrations/openshop/host/openshop-host-runtime.js`: execute the editor download command and return success/cancel/error results.
- Modify `static/js/openshop-host.js`: add the top-bar button, pending-request validation, transient notices, and send acknowledgement handling.
- Modify `static/css/openshop-host.css`: style the transient notice without covering toolbar controls or the layer panel.
- Modify `static/js/canvas-openshop.js`: acknowledge classic-canvas import only after `saveCanvas()` resolves.
- Modify `static/js/smart-canvas-openshop.js`: acknowledge smart-canvas import only after `saveCanvas()` resolves.
- Modify `integrations/openshop/tests/hstar-protocol.test.js`: verify both new protocol types.
- Modify `integrations/openshop/tests/hstar-host-runtime.test.js`: verify runtime download result correlation and cancellation/error behavior.
- Modify `integrations/openshop/tests/hstar-openshop-host.test.js`: verify button ordering, disabled state, stale-result rejection, notices, and canvas acknowledgement validation.
- Modify `integrations/openshop/tests/os-unit.test.js`: verify original dimensions, state restoration, menu/settings routing, and batch pre-generation.
- Modify `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`: verify native-save requests and persisted-send acknowledgements in classic and smart canvases.
- Modify `static/index.html`, `static/canvas.html`, `static/smart-canvas.html`, and `static/js/openshop-host.js`: advance one shared cache-busting runtime revision.
- Regenerate `static/openshop/` with `npm run build:hstar`; never hand-edit generated files under that directory.

### Task 1: Harden and Extend Native Save APIs

**Files:**
- Modify: `main.py:2881-2899`
- Modify: `main.py:12601-12825`
- Create: `tests/test_native_output_save.py`

- [ ] **Step 1: Write failing backend tests for Base64 batch items, prevalidation, format filters, cancellation, and local same-origin enforcement**

```python
import base64
import os
import tempfile
import unittest
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import main


def local_request(path):
    return Request({
        "type": "http", "method": "POST", "path": path,
        "scheme": "http", "query_string": b"",
        "server": ("127.0.0.1", 3000), "client": ("127.0.0.1", 51000),
        "headers": [
            (b"host", b"127.0.0.1:3000"),
            (b"origin", b"http://127.0.0.1:3000"),
        ],
    })


class NativeOutputSaveTests(unittest.TestCase):
    def test_batch_decodes_every_item_before_opening_picker(self):
        payload = main.SaveOutputBatchRequest(items=[
            {"name": "design.png", "content_base64": base64.b64encode(b"png").decode("ascii")},
            {"name": "design.pdf", "content_base64": "not-base64"},
        ])
        with patch.object(main, "choose_folder_path") as picker:
            with self.assertRaises(HTTPException) as error:
                main.save_output_batch(payload, local_request("/api/native/save-output-batch"))
        self.assertEqual(error.exception.status_code, 400)
        picker.assert_not_called()

    def test_batch_saves_base64_items_with_collision_numbers(self):
        with tempfile.TemporaryDirectory() as folder:
            open(os.path.join(folder, "design.png"), "wb").write(b"old")
            payload = main.SaveOutputBatchRequest(items=[
                {"name": "design.png", "content_base64": base64.b64encode(b"one").decode("ascii")},
                {"name": "design.png", "content_base64": base64.b64encode(b"two").decode("ascii")},
            ])
            with patch.object(main, "choose_folder_path", return_value=folder), \
                 patch.object(main, "load_software_settings", return_value={}), \
                 patch.object(main, "save_software_settings"):
                result = main.save_output_batch(payload, local_request("/api/native/save-output-batch"))
            self.assertEqual([item["filename"] for item in result["files"]], ["design-2.png", "design-3.png"])
            self.assertEqual(open(os.path.join(folder, "design-2.png"), "rb").read(), b"one")

    def test_single_save_uses_extension_specific_filter_and_silent_cancel(self):
        scripts = []
        completed = type("Completed", (), {"returncode": 0, "stdout": "", "stderr": ""})()
        with patch.object(main.subprocess, "run", side_effect=lambda command, **kwargs: scripts.append(command[4]) or completed):
            result = main.save_output_as(
                main.SaveOutputAsRequest(name="layout.psd", content_base64=base64.b64encode(b"8BPS").decode("ascii")),
                local_request("/api/native/save-output-as"),
            )
        self.assertTrue(result["cancelled"])
        self.assertIn("Photoshop Document (*.psd)|*.psd", scripts[0])

    def test_native_save_rejects_remote_or_cross_origin_requests(self):
        request = local_request("/api/native/save-output-as")
        request.scope["client"] = ("192.168.1.8", 51000)
        with self.assertRaises(HTTPException) as error:
            main.save_output_as(main.SaveOutputAsRequest(), request)
        self.assertEqual(error.exception.status_code, 403)
```

- [ ] **Step 2: Run the backend test and verify the new contract fails**

Run:

```powershell
python -m unittest discover -s tests -p "test_native_output_save.py" -v
```

Expected: failures show that `save_output_batch`/`save_output_as` do not yet accept `Request`, Base64 batch items are filtered out, and the PSD filter is absent.

- [ ] **Step 3: Add shared request validation, format filters, and predecoded batch items**

Add these helpers and use them from both routes:

```python
NATIVE_EXPORT_FILTERS = {
    ".png": "PNG Image (*.png)|*.png",
    ".jpg": "JPEG Image (*.jpg;*.jpeg)|*.jpg;*.jpeg",
    ".jpeg": "JPEG Image (*.jpg;*.jpeg)|*.jpg;*.jpeg",
    ".webp": "WebP Image (*.webp)|*.webp",
    ".svg": "SVG Image (*.svg)|*.svg",
    ".pdf": "PDF Document (*.pdf)|*.pdf",
    ".psd": "Photoshop Document (*.psd)|*.psd",
}


def require_local_same_origin(request: Request) -> None:
    client_host = str(getattr(getattr(request, "client", None), "host", "") or "").strip()
    if not is_gemini_cli_loopback_hostname(client_host):
        raise HTTPException(status_code=403, detail="Native save is available to local requests only")
    ensure_same_origin_request(request)


def native_export_dialog_filter(suggested_name: str) -> str:
    extension = os.path.splitext(str(suggested_name or ""))[1].lower()
    specific = NATIVE_EXPORT_FILTERS.get(extension)
    return f"{specific}|All Files (*.*)|*.*" if specific else "All Files (*.*)|*.*"


def decode_output_item(item: Dict[str, Any], index: int) -> tuple[bytes, str]:
    requested = str(item.get("name") or "").strip()
    encoded = str(item.get("content_base64") or "").strip()
    url = str(item.get("url") or "").strip()
    if encoded:
        try:
            content = base64.b64decode(encoded, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail=f"Invalid file content encoding at item {index}") from exc
        fallback = requested or f"output-{index}.bin"
    elif url:
        content, _content_type, source_name = media_bytes_from_url(url)
        fallback = source_name or requested or f"output-{index}.png"
    else:
        raise HTTPException(status_code=400, detail=f"Missing file content at item {index}")
    name = sanitize_export_filename(os.path.basename(requested) if requested else fallback, fallback)
    return content, name
```

Change `choose_save_output_path()` to derive and escape the filter beside the existing escaped name/directory values:

```python
    escaped_name = suggested_name.replace("'", "''")
    escaped_dir = initial_dir.replace("'", "''")
    escaped_filter = native_export_dialog_filter(suggested_name).replace("'", "''")
```

Replace the fixed PowerShell filter assignment with:

```powershell
$dialog.Filter = '{escaped_filter}'
```

Change the endpoint signatures and batch preparation to:

```python
@app.post("/api/native/save-output-batch")
def save_output_batch(payload: SaveOutputBatchRequest, request: Request):
    require_local_same_origin(request)
    prepared = [decode_output_item(item, index) for index, item in enumerate(payload.items or [], 1) if isinstance(item, dict)]
    if not prepared:
        raise HTTPException(status_code=400, detail="No files to save")
    folder = choose_folder_path("Select output folder", payload.initial_dir or last_output_download_folder())
    if not folder:
        return {"ok": False, "cancelled": True, "count": 0}
    os.makedirs(folder, exist_ok=True)
    saved, used = [], set()
    for index, (content, name) in enumerate(prepared, 1):
        stem, ext = os.path.splitext(name)
        candidate = f"{stem or 'output'}{ext or '.bin'}"
        suffix = 2
        while candidate.lower() in used or os.path.exists(os.path.join(folder, candidate)):
            candidate = f"{stem or 'output'}-{suffix}{ext or '.bin'}"
            suffix += 1
        used.add(candidate.lower())
        saved_path = save_bytes_to_path(content, os.path.join(folder, candidate))
        saved.append({"path": saved_path, "filename": candidate})
    settings = load_software_settings()
    settings["output_download_folder"] = folder
    save_software_settings(settings)
    return {"ok": True, "cancelled": False, "folder": folder, "count": len(saved), "files": saved}


@app.post("/api/native/save-output-as")
def save_output_as(payload: SaveOutputAsRequest, request: Request):
    require_local_same_origin(request)
    if payload.content_base64:
        try:
            content = base64.b64decode(payload.content_base64, validate=True)
        except Exception as exc:
            raise HTTPException(status_code=400, detail="Invalid file content encoding") from exc
        source_name = payload.name or "download.bin"
    else:
        content, _content_type, source_name = media_bytes_from_url(payload.url)
    suggested_name = sanitize_export_filename(payload.name or source_name, source_name or "output.png")
    target_path, folder = choose_save_output_path(suggested_name, payload.initial_dir)
    if not target_path:
        return {"ok": False, "cancelled": True}
    saved_path = save_bytes_to_path(content, target_path)
    settings = load_software_settings()
    settings["output_download_folder"] = folder or os.path.dirname(saved_path)
    save_software_settings(settings)
    return {
        "ok": True, "cancelled": False, "path": saved_path,
        "folder": os.path.dirname(saved_path), "filename": os.path.basename(saved_path),
    }
```

- [ ] **Step 4: Run backend tests and nearby native picker regression tests**

Run:

```powershell
python -m unittest discover -s tests -p "test_native_output_save.py" -v
python -m unittest discover -s tests -p "test_native_file_picker.py" -v
```

Expected: both suites pass; cancellation returns `cancelled: true`, malformed batch content opens no picker, and same-origin local requests remain accepted.

- [ ] **Step 5: Commit the backend contract**

```powershell
git add -- main.py tests/test_native_output_save.py
git commit -m "feat: accept OpenShop artifacts in native save APIs"
```

### Task 2: Build the Focused Export Service

**Files:**
- Create: `integrations/openshop/host/openshop-export-service.js`
- Create: `integrations/openshop/tests/hstar-export-service.test.js`
- Modify: `integrations/openshop/scripts/build-hstar.mjs`

- [ ] **Step 1: Write failing service tests for raw Base64, folder persistence, cancellation, and all-or-nothing batch generation**

```js
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(resolve(testDir, '..', 'host', 'openshop-export-service.js'), 'utf8');

describe('OpenShop export service', () => {
  beforeEach(() => {
    delete window.HstarOpenShopExportService;
    localStorage.clear();
    window.eval(source);
  });

  it('sends raw Base64 and persists the successful folder', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({folder:'C:/exports'}), {status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ok:true, filename:'design.png', folder:'C:/chosen'}), {status:200}));
    const service = window.HstarOpenShopExportService.create({
      generators:{png:vi.fn(async () => ({blob:new Blob(['png']), filename:'design.png', mimeType:'image/png', format:'png', width:3840, height:2160}))},
      fetchImpl,
      storage:localStorage,
    });
    const result = await service.saveFormat('png');
    const request = JSON.parse(fetchImpl.mock.calls[1][1].body);
    expect(request.content_base64).toBe('cG5n');
    expect(request.content_base64).not.toContain('data:');
    expect(result.filename).toBe('design.png');
    expect(localStorage.getItem('hstar.outputDownloadFolder')).toBe('C:/chosen');
  });

  it('keeps cancellation silent and does not update storage', async () => {
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({folder:''}), {status:200}))
      .mockResolvedValueOnce(new Response(JSON.stringify({ok:false, cancelled:true}), {status:200}));
    const service = window.HstarOpenShopExportService.create({
      generators:{png:async () => ({blob:new Blob(['x']), filename:'x.png', mimeType:'image/png', format:'png', width:1, height:1})},
      fetchImpl, storage:localStorage,
    });
    expect(await service.saveFormat('png')).toMatchObject({cancelled:true});
    expect(localStorage.getItem('hstar.outputDownloadFolder')).toBeNull();
  });

  it('generates every artifact before making one batch request', async () => {
    const png = vi.fn(async () => ({blob:new Blob(['png']), filename:'x.png', mimeType:'image/png', format:'png', width:10, height:10}));
    const pdf = vi.fn(async () => { throw new Error('pdf failed'); });
    const fetchImpl = vi.fn();
    const service = window.HstarOpenShopExportService.create({generators:{png, pdf}, fetchImpl, storage:localStorage});
    await expect(service.saveBatch(['png', 'pdf'])).rejects.toThrow('pdf failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the service test and verify the missing module failure**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-export-service.test.js
```

Expected: failure reports that `host/openshop-export-service.js` does not exist.

- [ ] **Step 3: Implement the export service public contract**

Create the module with this API and no direct access to the `OS` global:

```js
(function bootstrapOpenShopExportService(root){
  const SUPPORTED_FORMATS = Object.freeze(['png', 'jpeg', 'webp', 'svg', 'pdf', 'psd']);

  function safeError(value){
    return String(value?.message || value || '导出失败')
      .replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 180) || '导出失败';
  }

  function normalizeArtifact(value, expectedFormat){
    const format = String(value?.format || expectedFormat || '').toLowerCase();
    if(!SUPPORTED_FORMATS.includes(format)) throw new Error(`Unsupported export format: ${format}`);
    if(!(value?.blob instanceof Blob)) throw new Error(`Export ${format} did not produce a Blob`);
    const filename = String(value.filename || `openshop-export.${format === 'jpeg' ? 'jpg' : format}`).trim();
    const width = Math.max(1, Math.round(Number(value.width || 0)));
    const height = Math.max(1, Math.round(Number(value.height || 0)));
    return {...value, format, filename, width, height, mimeType:String(value.mimeType || value.blob.type || 'application/octet-stream')};
  }

  async function blobToBase64(blob){
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for(let index = 0; index < bytes.length; index += chunk){
      binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }
    return root.btoa(binary);
  }

  async function responseJson(response){
    const body = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(typeof body.detail === 'string' ? body.detail : `保存失败 (${response.status})`);
    return body;
  }

  function create({generators, fetchImpl = root.fetch.bind(root), storage = root.localStorage} = {}){
    if(!generators || typeof generators !== 'object') throw new Error('Export generators are required');

    async function initialFolder(){
      try {
        const cached = storage?.getItem?.('hstar.outputDownloadFolder') || '';
        if(cached) return cached;
      } catch(error) {}
      const response = await fetchImpl('/api/output-download-folder');
      const value = await responseJson(response);
      return String(value.folder || '');
    }

    async function createArtifact(format, options = {}){
      const normalized = String(format || '').toLowerCase();
      const generator = generators[normalized];
      if(typeof generator !== 'function') throw new Error(`Unsupported export format: ${normalized}`);
      return normalizeArtifact(await generator(options), normalized);
    }

    async function saveArtifact(artifact){
      const value = normalizeArtifact(artifact, artifact?.format);
      const response = await fetchImpl('/api/native/save-output-as', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({
          name:value.filename,
          initial_dir:await initialFolder(),
          content_base64:await blobToBase64(value.blob),
        }),
      });
      const result = await responseJson(response);
      if(!result.cancelled && result.folder){
        try { storage?.setItem?.('hstar.outputDownloadFolder', result.folder); } catch(error) {}
      }
      return result;
    }

    async function saveFormat(format, options = {}){
      return saveArtifact(await createArtifact(format, options));
    }

    async function saveBatch(formats, optionsByFormat = {}){
      const artifacts = [];
      for(const format of formats) artifacts.push(await createArtifact(format, optionsByFormat[format] || {}));
      const items = [];
      for(const artifact of artifacts){
        items.push({name:artifact.filename, content_base64:await blobToBase64(artifact.blob)});
      }
      const response = await fetchImpl('/api/native/save-output-batch', {
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({items, initial_dir:await initialFolder()}),
      });
      const result = await responseJson(response);
      if(!result.cancelled && result.folder){
        try { storage?.setItem?.('hstar.outputDownloadFolder', result.folder); } catch(error) {}
      }
      return result;
    }

    return Object.freeze({createArtifact, saveArtifact, saveFormat, saveBatch});
  }

  root.HstarOpenShopExportService = Object.freeze({SUPPORTED_FORMATS, create, blobToBase64, normalizeArtifact, safeError});
})(window);
```

Add `host/openshop-export-service.js` to `runtimeFiles` immediately before `host/openshop-host-runtime.js` in `scripts/build-hstar.mjs`.

- [ ] **Step 4: Run the focused service tests**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-export-service.test.js
```

Expected: all service tests pass and failed artifact generation produces no native-save request.

- [ ] **Step 5: Commit the isolated service**

```powershell
git add -- integrations/openshop/host/openshop-export-service.js integrations/openshop/tests/hstar-export-service.test.js integrations/openshop/scripts/build-hstar.mjs
git commit -m "feat: add OpenShop native export service"
```

### Task 3: Route All OpenShop Export Formats Through the Service

**Files:**
- Modify: `integrations/openshop/index.html:1475-1485`
- Modify: `integrations/openshop/index.html:2041-2111`
- Modify: `integrations/openshop/index.html:4902-4961`
- Modify: `integrations/openshop/index.html:7415-7472`
- Modify: `integrations/openshop/tests/os-unit.test.js`

- [ ] **Step 1: Add failing OS tests for dimensions, state restoration, PDF/PSD Blob creation, menu saves, and one-request batch export**

Add tests that mount `OS`, install a canvas mock with a boundary object, and assert:

```js
it('creates an original-size PNG artifact and restores viewport and boundary state', async () => {
  const OS = loadOpenShop();
  const boundary = {name:'__boundary__', opacity:1, fill:'#ffffff', set:vi.fn(function(key, value){ this[key] = value; })};
  OS.canvas = createCanvasMock([boundary]);
  OS.canvasW = 3840; OS.canvasH = 2160;
  OS.canvas.viewportTransform = [0.5, 0, 0, 0.5, 120, 80];
  const before = OS.canvas.viewportTransform.slice();
  const artifact = await OS._createExportArtifact('png');
  expect(artifact).toMatchObject({format:'png', width:3840, height:2160, mimeType:'image/png'});
  expect(OS.canvas.toDataURL).toHaveBeenCalledWith(expect.objectContaining({width:3840, height:2160, multiplier:1}));
  expect(OS.canvas.viewportTransform).toEqual(before);
  expect(boundary.opacity).toBe(1);
});

it('restores editor state when raster encoding throws', async () => {
  const OS = loadOpenShop();
  const boundary = {name:'__boundary__', opacity:1, fill:'#ffffff', set(key, value){ this[key] = value; }};
  OS.canvas = createCanvasMock([boundary]);
  OS.canvas.toDataURL.mockImplementation(() => { throw new Error('encode failed'); });
  OS.canvas.viewportTransform = [2, 0, 0, 2, -10, -20];
  await expect(OS._createExportArtifact('jpeg')).rejects.toThrow('encode failed');
  expect(OS.canvas.viewportTransform).toEqual([2, 0, 0, 2, -10, -20]);
  expect(boundary.fill).toBe('#ffffff');
});

it('routes every public export and one batch through the native service', async () => {
  const OS = loadOpenShop();
  OS._exportService = {
    saveFormat:vi.fn(async (_format) => ({ok:true, filename:'saved.file'})),
    saveBatch:vi.fn(async () => ({ok:true, count:6})),
  };
  OS.toast = vi.fn();
  for(const format of ['png','jpeg','webp','svg','pdf','psd']) await OS.saveFile(format);
  expect(OS._exportService.saveFormat.mock.calls.map(([format]) => format)).toEqual(['png','jpeg','webp','svg','pdf','psd']);
  await OS._saveBatchFormats(['png','jpeg','webp','svg','pdf','psd']);
  expect(OS._exportService.saveBatch).toHaveBeenCalledTimes(1);
});
```

Add this concrete artifact test for the non-raster formats:

```js
it('returns SVG, PDF, and PSD Blobs without triggering browser downloads', async () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock([]);
  OS.canvasW = 640; OS.canvasH = 480;
  OS.canvas.toSVG = vi.fn(() => '<svg width="640" height="480"></svg>');
  OS.layers = [];
  OS._downloadBlob = vi.fn();
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const pdf = {addImage:vi.fn(), output:vi.fn(() => new Blob(['pdf'], {type:'application/pdf'})), save:vi.fn()};
  window.jspdf = {jsPDF:vi.fn(() => pdf)};
  window.agPsd = {writePsd:vi.fn(() => new Uint8Array([56, 66, 80, 83]))};

  const artifacts = await Promise.all(['svg','pdf','psd'].map(format => OS._createExportArtifact(format)));

  expect(artifacts.map(item => item.format)).toEqual(['svg','pdf','psd']);
  expect(artifacts.every(item => item.blob instanceof Blob)).toBe(true);
  expect(OS._downloadBlob).not.toHaveBeenCalled();
  expect(click).not.toHaveBeenCalled();
  expect(pdf.save).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run the focused OS tests and verify the old browser-download behavior fails**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/os-unit.test.js --testNamePattern "export|Export"
```

Expected: failures report missing `_createExportArtifact`/`_saveBatchFormats` and direct download calls.

- [ ] **Step 3: Add artifact generators with one state-restoration boundary**

Load `./host/openshop-export-service.js` before `openshop-host-runtime.js`. Add these OS methods and move the existing PDF/PSD encoding bodies into their corresponding artifact functions:

```js
    _exportService: null,
    _documentExportName(format) {
        const extension = format === 'jpeg' ? 'jpg' : format;
        const base = String(this._docName || 'openshop-export').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'openshop-export';
        return `${base}.${extension}`;
    },
    async _withExportCanvas({opaque = false} = {}, render) {
        const canvas = this.canvas;
        const viewport = canvas.viewportTransform.slice();
        const boundary = canvas.getObjects().find(object => object.name === '__boundary__');
        const boundaryState = boundary ? {opacity:boundary.opacity, fill:boundary.fill, visible:boundary.visible} : null;
        try {
            canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
            if(boundary){
                boundary.set('visible', true);
                boundary.set('opacity', opaque ? 1 : 0);
                if(opaque) boundary.set('fill', '#ffffff');
            }
            canvas.renderAll();
            return await render();
        } finally {
            if(boundary && boundaryState){
                boundary.set('opacity', boundaryState.opacity);
                boundary.set('fill', boundaryState.fill);
                boundary.set('visible', boundaryState.visible);
            }
            canvas.viewportTransform = viewport;
            canvas.renderAll();
        }
    },
    _dataUrlBlob(dataUrl) {
        const [header, encoded] = String(dataUrl).split(',', 2);
        const mimeType = header.match(/^data:([^;]+)/)?.[1] || 'application/octet-stream';
        const binary = atob(encoded || '');
        const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
        return new Blob([bytes], {type:mimeType});
    },
    async _createRasterArtifact(format, options = {}) {
        const scale = Math.max(0.01, Number(options.scale || 1));
        const quality = Math.min(1, Math.max(0.01, Number(options.quality ?? (format === 'jpeg' ? 0.92 : 1))));
        const dataUrl = await this._withExportCanvas({opaque:format === 'jpeg' && options.transparent !== true}, () => (
            this.canvas.toDataURL({format, quality, left:0, top:0, width:this.canvasW, height:this.canvasH, multiplier:scale})
        ));
        return {
            blob:this._dataUrlBlob(dataUrl), filename:this._documentExportName(format),
            mimeType:format === 'jpeg' ? 'image/jpeg' : `image/${format}`,
            format, width:Math.round(this.canvasW * scale), height:Math.round(this.canvasH * scale),
        };
    },
    async _createSvgArtifact() {
        const svg = await this._withExportCanvas({}, () => this._sanitizeSVG(this.canvas.toSVG({
            viewBox:{x:0,y:0,width:this.canvasW,height:this.canvasH}, width:this.canvasW, height:this.canvasH,
        })));
        return {blob:new Blob([svg], {type:'image/svg+xml'}), filename:this._documentExportName('svg'), mimeType:'image/svg+xml', format:'svg', width:this.canvasW, height:this.canvasH};
    },
    async _createPdfArtifact() {
        const jsPDF = window.jspdf?.jsPDF;
        if(!jsPDF) throw new Error(this._t('jsPDF not loaded'));
        const png = await this._createRasterArtifact('png');
        const pdf = new jsPDF({orientation:this.canvasW > this.canvasH ? 'landscape' : 'portrait', unit:'px', format:[this.canvasW, this.canvasH]});
        pdf.addImage(await this._blobDataUrl(png.blob), 'PNG', 0, 0, this.canvasW, this.canvasH);
        return {blob:pdf.output('blob'), filename:this._documentExportName('pdf'), mimeType:'application/pdf', format:'pdf', width:this.canvasW, height:this.canvasH};
    },
    _blobDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error || new Error('Blob read failed'));
            reader.readAsDataURL(blob);
        });
    },
```

Implement `_createPsdArtifact()` as a pure artifact generator:

```js
    async _createPsdArtifact() {
        const lib = window.agPsd;
        if(!lib?.writePsd) throw new Error(this._t('PSD library not loaded or does not support writing'));
        return this._withExportCanvas({}, () => {
            const psd = {width:this.canvasW, height:this.canvasH, children:[]};
            for(let index = 0; index < this.layers.length; index += 1){
                const layer = this.layers[index];
                const objects = layer.objects.filter(object => object.name !== '__boundary__');
                if(!objects.length) continue;
                const layerCanvas = document.createElement('canvas');
                layerCanvas.width = this.canvasW;
                layerCanvas.height = this.canvasH;
                const layerContext = layerCanvas.getContext('2d');
                for(const object of objects){
                    if(!object.visible) continue;
                    const objectCanvas = object.toCanvasElement?.();
                    if(!objectCanvas) continue;
                    layerContext.globalAlpha = Number.isFinite(Number(object.opacity)) ? Number(object.opacity) : 1;
                    layerContext.drawImage(objectCanvas, Number(object.left || 0), Number(object.top || 0));
                    layerContext.globalAlpha = 1;
                }
                psd.children.push({
                    name:layer.name || `Layer ${index + 1}`, canvas:layerCanvas, left:0, top:0,
                    opacity:Math.round(Math.min(100, Math.max(0, Number(layer.opacity ?? 100))) * 2.55),
                    hidden:layer.visible === false,
                });
            }
            const buffer = lib.writePsd(psd);
            return {
                blob:new Blob([buffer], {type:'image/vnd.adobe.photoshop'}),
                filename:this._documentExportName('psd'), mimeType:'image/vnd.adobe.photoshop',
                format:'psd', width:this.canvasW, height:this.canvasH,
            };
        });
    },
```

Finish dispatch and lazy service creation:

```js
    _createExportArtifact(format, options = {}) {
        if(['png','jpeg','webp'].includes(format)) return this._createRasterArtifact(format, options);
        if(format === 'svg') return this._createSvgArtifact(options);
        if(format === 'pdf') return this._createPdfArtifact(options);
        if(format === 'psd') return this._createPsdArtifact(options);
        return Promise.reject(new Error(`Unsupported export format: ${format}`));
    },
    _getExportService() {
        if(this._exportService) return this._exportService;
        const formats = ['png','jpeg','webp','svg','pdf','psd'];
        const generators = Object.fromEntries(formats.map(format => [format, options => this._createExportArtifact(format, options)]));
        this._exportService = window.HstarOpenShopExportService.create({generators});
        return this._exportService;
    },
```

- [ ] **Step 4: Replace direct-download commands with asynchronous native saves**

Use one wrapper for top runtime and all editor commands:

```js
    async downloadToLocal({format='png', options={}} = {}) {
        return this._getExportService().saveFormat(format, options);
    },
    async saveFile(format, options = {}) {
        try {
            const result = await this.downloadToLocal({format, options});
            if(result?.cancelled) return result;
            this.toast(`已保存：${result?.filename || this._documentExportName(format)}`, 'success');
            return result;
        } catch(error) {
            this.toast(window.HstarOpenShopExportService.safeError(error), 'error');
            throw error;
        }
    },
    _exportSVG() { return this.saveFile('svg'); },
    exportPDF() { return this.saveFile('pdf'); },
    exportPSD() { return this.saveFile('psd'); },
    async _saveBatchFormats(formats) {
        const result = await this._getExportService().saveBatch(formats);
        if(!result?.cancelled) this.toast(`已保存 ${result.count || formats.length} 个文件`, 'success');
        return result;
    },
```

Replace the batch/settings completion functions with:

```js
    batchExport() {
        const formats = ['png','jpeg','webp','svg','pdf','psd'];
        const overlay = document.createElement('div');
        overlay.className = 'modal-overlay';
        overlay.innerHTML = `<div class="modal"><h3 data-i18n="Batch Export">Batch Export</h3>
            <p style="font-size:12px;color:var(--text-secondary);margin-bottom:12px" data-i18n="Export canvas to multiple formats at once.">Export canvas to multiple formats at once.</p>
            ${formats.map(format => `<div class="modal-row"><label style="width:60px">${format.toUpperCase()}</label><label><input type="checkbox" id="batch-${format}" checked> <span data-i18n="Export">Export</span></label></div>`).join('')}
            <div class="modal-btns"><button class="btn" data-modal-close data-i18n="Cancel">Cancel</button>
            <button class="btn btn-primary" data-modal-action data-i18n="Export All">Export All</button></div></div>`;
        overlay.querySelector('[data-modal-action]').addEventListener('click', () => { void this.doBatchExport(overlay); });
        document.body.appendChild(overlay);
        requestAnimationFrame(() => overlay.classList.add('show'));
    },
    async doBatchExport(overlay) {
        const formats = ['png','jpeg','webp','svg','pdf','psd']
            .filter(format => overlay.querySelector(`#batch-${format}`)?.checked);
        const action = overlay.querySelector('[data-modal-action]');
        if(!formats.length) return;
        if(action) action.disabled = true;
        try {
            await this._saveBatchFormats(formats);
            overlay.remove();
        } catch(error) {
            this.toast(window.HstarOpenShopExportService.safeError(error), 'error');
            if(action?.isConnected) action.disabled = false;
        }
    },
    async _doExportSettings(overlay) {
        const fmt = overlay.querySelector('.export-format-row .btn.active')?.dataset?.fmt || 'png';
        const quality = (+overlay.querySelector('#es-quality').value || 92) / 100;
        const scale = +overlay.querySelector('#es-scale').value || 1;
        const transparent = overlay.querySelector('#es-transparent').checked;
        const action = overlay.querySelector('[data-modal-action]');
        if(action) action.disabled = true;
        try {
            const result = await this.saveFile(fmt, {quality, scale, transparent});
            if(!result?.cancelled) overlay.remove();
        } finally {
            if(action?.isConnected) action.disabled = false;
        }
    },
```

A user-selected settings scale is an explicit override; the top-bar and File-menu paths always use scale `1`.

- [ ] **Step 5: Run OS and export-service tests**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-export-service.test.js tests/os-unit.test.js
```

Expected: all tests pass; no tested File-menu path clicks an anchor or invokes `pdf.save()`.

- [ ] **Step 6: Commit editor export integration**

```powershell
git add -- integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js
git commit -m "feat: route OpenShop exports through native save"
```

### Task 4: Add the Top-Bar Download Protocol and Notice

**Files:**
- Modify: `integrations/openshop/host/openshop-protocol.js:4-22`
- Modify: `integrations/openshop/host/openshop-host-runtime.js:381-450`
- Modify: `static/js/openshop-host.js:35-56`
- Modify: `static/js/openshop-host.js:160-202`
- Modify: `static/js/openshop-host.js:670-732`
- Modify: `static/css/openshop-host.css`
- Modify: `integrations/openshop/tests/hstar-protocol.test.js`
- Modify: `integrations/openshop/tests/hstar-host-runtime.test.js`
- Modify: `integrations/openshop/tests/hstar-openshop-host.test.js`

- [ ] **Step 1: Write failing protocol/runtime tests for correlated success, cancellation, and error results**

Extend the protocol assertion with:

```js
expect(protocol.TYPES).toMatchObject({
  REQUEST_DOWNLOAD_LOCAL:'hstar:openshop:request-download-local',
  DOWNLOAD_LOCAL_RESULT:'hstar:openshop:download-local-result',
});
```

In the runtime fixture, set `editor.downloadToLocal = vi.fn()`, then add:

```js
it('returns one scoped result for a native download request', async () => {
  editor.downloadToLocal.mockResolvedValue({ok:true, filename:'design.png'});
  dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
  await flushMessages();
  parentWindow.postMessage.mockClear();
  dispatch(envelope(protocol.TYPES.REQUEST_DOWNLOAD_LOCAL, 'download-1', {format:'png'}));
  await flushMessages();
  expect(editor.downloadToLocal).toHaveBeenCalledWith({format:'png', options:{}});
  expect(posted(protocol.TYPES.DOWNLOAD_LOCAL_RESULT)[0]).toMatchObject({
    requestId:'download-1', payload:{status:'success', filename:'design.png'},
  });
});

it.each([
  [{cancelled:true}, {status:'cancelled'}],
  [new Error('disk failed'), {status:'error', message:'disk failed'}],
])('reports cancellation and failure without a false success', async (outcome, expected) => {
  if(outcome instanceof Error) editor.downloadToLocal.mockRejectedValue(outcome);
  else editor.downloadToLocal.mockResolvedValue(outcome);
  dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
  await flushMessages();
  dispatch(envelope(protocol.TYPES.REQUEST_DOWNLOAD_LOCAL, 'download-result', {format:'png'}));
  await flushMessages();
  expect(posted(protocol.TYPES.DOWNLOAD_LOCAL_RESULT).at(-1).payload).toMatchObject(expected);
});
```

- [ ] **Step 2: Write failing host UI tests for ordering, disabled state, stale results, and transient notice**

Add this helper to dispatch a protocol envelope from the active editor frame:

```js
function dispatchEditorEnvelope(host, frame, type, requestId, payload={}) {
  const active = host.getState().activeSession;
  const event = new MessageEvent('message', {
    origin:window.location.origin,
    source:frame.contentWindow,
    data:window.HstarOpenShopProtocol.createEnvelope({
      type, requestId, payload,
      sessionId:active.sessionId,
      context:active.context,
    }),
  });
  window.dispatchEvent(event);
}
```

Assert:

```js
const commands = [...document.querySelectorAll('.openshop-host-command')].map(button => button.textContent.trim());
expect(commands.slice(-3)).toEqual(['保存', '下载到本地', '发送到画布']);
const frame = document.querySelector('iframe.openshop-session-frame');
const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');
document.querySelector('[data-openshop-download]').click();
expect(document.querySelector('[data-openshop-download]').disabled).toBe(true);
const request = postMessage.mock.calls.map(([message]) => message).find(message => message.type === window.HstarOpenShopProtocol.TYPES.REQUEST_DOWNLOAD_LOCAL);
dispatchEditorEnvelope(host, frame, window.HstarOpenShopProtocol.TYPES.DOWNLOAD_LOCAL_RESULT, 'wrong-request', {status:'success', filename:'wrong.png'});
expect(document.querySelector('[data-openshop-notice]').textContent).not.toContain('wrong.png');
dispatchEditorEnvelope(host, frame, window.HstarOpenShopProtocol.TYPES.DOWNLOAD_LOCAL_RESULT, request.requestId, {status:'success', filename:'design.png'});
expect(document.querySelector('[data-openshop-download]').disabled).toBe(false);
expect(document.querySelector('[data-openshop-notice]').textContent).toBe('已保存：design.png');
```

- [ ] **Step 3: Run protocol, runtime, and host tests to verify failure**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-protocol.test.js tests/hstar-host-runtime.test.js tests/hstar-openshop-host.test.js
```

Expected: failures report unknown protocol types and missing download button/result handling.

- [ ] **Step 4: Add protocol types and runtime result reporting**

Add both constants to `TYPES`. In the runtime add:

```js
  async function requestDownloadLocal(envelope){
    const session = captureSession();
    try {
      const result = await state.editor.downloadToLocal({format:'png', options:{}});
      assertActiveSession(session);
      post(state.protocol.TYPES.DOWNLOAD_LOCAL_RESULT, {
        requestId:envelope.requestId, sessionId:session.sessionId, context:session.context,
        payload:result?.cancelled
          ? {status:'cancelled'}
          : {status:'success', filename:String(result?.filename || 'openshop-export.png')},
      });
    } catch(error) {
      assertActiveSession(session);
      post(state.protocol.TYPES.DOWNLOAD_LOCAL_RESULT, {
        requestId:envelope.requestId, sessionId:session.sessionId, context:session.context,
        payload:{status:'error', message:safeErrorMessage(error)},
      });
    }
  }
```

Handle `REQUEST_DOWNLOAD_LOCAL` in `applyRequest()` before generic errors. Preserve the incoming `requestId` in every result.

- [ ] **Step 5: Add the host button, pending request state, and notice renderer**

Insert the button immediately before send and add the notice after the header:

```html
<button class="openshop-host-command" data-openshop-download type="button">
  <i data-lucide="download"></i><span>下载到本地</span>
</button>
<div class="openshop-host-notice" data-openshop-notice role="status" aria-live="polite" hidden></div>
```

Initialize every session with `downloadRequestId:''` and add:

```js
    let noticeTimer = 0;
    function showNotice(message, kind='success'){
        const notice = ui('[data-openshop-notice]');
        if(!notice) return;
        window.clearTimeout(noticeTimer);
        notice.textContent = clean(message);
        notice.dataset.kind = kind;
        notice.hidden = !notice.textContent;
        noticeTimer = window.setTimeout(() => { notice.hidden = true; notice.textContent = ''; }, 2200);
    }
    function syncDownloadButton(session=activeSession()){
        const button = ui('[data-openshop-download]');
        if(button) button.disabled = !session?.editorReady || Boolean(session.downloadRequestId);
    }
    function requestDownloadLocal(){
        const session = activeSession();
        if(!session?.editorReady || session.downloadRequestId) return null;
        const requestId = uuid('openshop-download');
        session.downloadRequestId = requestId;
        syncDownloadButton(session);
        return postToEditor(session, Protocol.TYPES.REQUEST_DOWNLOAD_LOCAL, {format:'png'}, requestId);
    }
    function applyDownloadResult(session, envelope){
        if(session.downloadRequestId !== envelope.requestId) return false;
        session.downloadRequestId = '';
        if(session.scope === state.activeScope){
            syncDownloadButton(session);
            const status = clean(envelope.payload?.status);
            if(status === 'success') showNotice(`已保存：${clean(envelope.payload?.filename) || 'openshop-export.png'}`);
            if(status === 'error') showNotice(safeError(envelope.payload?.message), 'error');
        }
        return true;
    }
```

Call `applyDownloadResult()` from the validated editor-message branch, call `syncDownloadButton()` after READY and session switches, and bind the new button to `requestDownloadLocal()`.

Style the notice as an absolute, pointer-events-none element below the 48px host bar, centered with `max-width:min(520px, calc(100% - 32px))`, `z-index:4`, and an error color variant. It must not alter grid dimensions.

- [ ] **Step 6: Run focused tests and commit the protocol/UI path**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-protocol.test.js tests/hstar-host-runtime.test.js tests/hstar-openshop-host.test.js
```

Expected: all tests pass, cancellation produces no notice, and a stale request cannot re-enable the current button.

Commit:

```powershell
git add -- integrations/openshop/host/openshop-protocol.js integrations/openshop/host/openshop-host-runtime.js static/js/openshop-host.js static/css/openshop-host.css integrations/openshop/tests/hstar-protocol.test.js integrations/openshop/tests/hstar-host-runtime.test.js integrations/openshop/tests/hstar-openshop-host.test.js
git commit -m "feat: add OpenShop native download command"
```

### Task 5: Acknowledge Send Only After Canvas Persistence

**Files:**
- Modify: `static/js/openshop-host.js:588-715`
- Modify: `static/js/canvas-openshop.js:294-344`
- Modify: `static/js/smart-canvas-openshop.js:275-303`
- Modify: `integrations/openshop/tests/hstar-openshop-host.test.js`

- [ ] **Step 1: Write failing host tests for trusted success, failure, duplicate, and wrong-canvas acknowledgements**

Add a canvas-message helper:

```js
function dispatchCanvasMessage(data, frame=document.getElementById('frame-canvas')) {
  window.dispatchEvent(new MessageEvent('message', {
    data, origin:window.location.origin, source:frame.contentWindow,
  }));
}
```

After dispatching a valid editor `SEND_TO_CANVAS` envelope, dispatch messages from `#frame-canvas.contentWindow`:

```js
const editorFrame = document.querySelector('iframe.openshop-session-frame');
dispatchEditorEnvelope(
  host,
  editorFrame,
  window.HstarOpenShopProtocol.TYPES.SEND_TO_CANVAS,
  'send-1',
  {assetId:'a'.repeat(64), url:'/api/openshop/assets/output-1', name:'output.png', width:640, height:480},
);
const acknowledgement = {
  type:'hstar-openshop-output-applied', requestId:'send-1',
  context:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1'},
  status:'success', nodeId:'image-1',
};
dispatchCanvasMessage(acknowledgement);
expect(document.querySelector('[data-openshop-notice]').textContent).toBe('已发送到画布');

const notice = document.querySelector('[data-openshop-notice]');
notice.hidden = true;
notice.textContent = '';
dispatchCanvasMessage(acknowledgement);
expect(notice.hidden).toBe(true);
dispatchCanvasMessage({...acknowledgement, requestId:'unknown'});
dispatchCanvasMessage({...acknowledgement, context:{...acknowledgement.context, canvasId:'other'}});
expect(notice.hidden).toBe(true);

dispatchEditorEnvelope(
  host,
  editorFrame,
  window.HstarOpenShopProtocol.TYPES.SEND_TO_CANVAS,
  'send-2',
  {assetId:'b'.repeat(64), url:'/api/openshop/assets/output-2', name:'output-2.png', width:640, height:480},
);
dispatchCanvasMessage({...acknowledgement, requestId:'send-2', status:'error', message:'画布保存失败'});
expect(document.querySelector('[data-openshop-notice]').textContent).toBe('画布保存失败');
expect(document.querySelector('[data-openshop-notice]').dataset.kind).toBe('error');
```

Also dispatch the same success twice and assert only the first consumes a pending request.

- [ ] **Step 2: Run the host test and verify no acknowledgement path exists**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-openshop-host.test.js --testNamePattern "acknowledg|发送到画布"
```

Expected: failure because the host does not track pending sends or accept canvas messages.

- [ ] **Step 3: Track pending output requests and validate canvas-origin acknowledgements**

Initialize each host session with `pendingCanvasOutputs:new Map()`. When handling a validated editor `SEND_TO_CANVAS`, record the request before forwarding:

```js
session.pendingCanvasOutputs.set(envelope.requestId, {createdAt:Date.now()});
postToOrigin(session, {
  type:'hstar-openshop-output', requestId:envelope.requestId,
  context:{...session.context}, output,
});
```

Add strict origin-frame validation before `validEditorEvent()`:

```js
    function validCanvasAcknowledgement(event){
        if(event.origin !== window.location.origin) return null;
        const data = event.data || {};
        if(data.type !== 'hstar-openshop-output-applied') return null;
        const session = [...state.sessions.values()].find(item => event.source === originFrame(item)?.contentWindow);
        if(!session || !sameContext(data.context, session.context)) return null;
        const requestId = clean(data.requestId);
        if(!requestId || !session.pendingCanvasOutputs.has(requestId)) return null;
        return {session, data, requestId};
    }
    function applyCanvasAcknowledgement(valid){
        const {session, data, requestId} = valid;
        session.pendingCanvasOutputs.delete(requestId);
        if(session.scope !== state.activeScope) return;
        if(data.status === 'success') showNotice('已发送到画布');
        else showNotice(safeError(data.message || '发送到画布失败'), 'error');
    }
```

Run this branch before editor-envelope validation. Deleting the request before rendering the notice makes duplicate acknowledgements inert.

- [ ] **Step 4: Post success/failure from both adapters after persistence**

Add this scoped helper to the classic adapter:

```js
    function acknowledgeOutput(data, status, details={}){
        const source = nodeList().find(candidate => candidate.id === data?.context?.nodeId && candidate.type === 'openshop-layered');
        if(!clean(data?.requestId) || !source || !matchingContext(data?.context, source)) return false;
        root.parent?.postMessage?.({
            type:'hstar-openshop-output-applied',
            requestId:clean(data.requestId), context:{...data.context}, status,
            ...(details.nodeId ? {nodeId:clean(details.nodeId)} : {}),
            ...(details.message ? {message:clean(details.message).slice(0, 180)} : {}),
        }, root.location.origin);
        return true;
    }
```

Add the smart equivalent:

```js
    function acknowledgeOutput(data, status, details={}){
        const source = nodeFor(data?.context?.nodeId);
        if(!clean(data?.requestId) || source?.type !== 'openshop-layered' || !matchingContext(data?.context, source)) return false;
        root.parent?.postMessage?.({
            type:'hstar-openshop-output-applied',
            requestId:clean(data.requestId), context:{...data.context}, status,
            ...(details.nodeId ? {nodeId:clean(details.nodeId)} : {}),
            ...(details.message ? {message:clean(details.message).slice(0, 180)} : {}),
        }, root.location.origin);
        return true;
    }
```

In each `importOutput()`:

```js
await hooks().saveCanvas?.();
acknowledgeOutput(data, 'success', {nodeId:created.id});
return created;
```

In `handleMessage()` catch:

```js
acknowledgeOutput(data, 'error', {message:error?.message || '图文分层输出导入失败'});
```

Do not acknowledge invalid origins, mismatched contexts, duplicate request IDs, or payloads rejected before node creation.

- [ ] **Step 5: Run host tests and commit acknowledgement behavior**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/hstar-openshop-host.test.js
```

Expected: trusted success appears once, failure never shows success, and wrong source/context/request messages are ignored.

Commit:

```powershell
git add -- static/js/openshop-host.js static/js/canvas-openshop.js static/js/smart-canvas-openshop.js integrations/openshop/tests/hstar-openshop-host.test.js
git commit -m "feat: confirm persisted OpenShop canvas outputs"
```

### Task 6: Synchronize Runtime Assets and Cache Revisions

**Files:**
- Modify: `integrations/openshop/index.html:10190-10205`
- Modify: `static/index.html:54`
- Modify: `static/index.html:1367-1368`
- Modify: `static/canvas.html:377`
- Modify: `static/smart-canvas.html:475`
- Modify: `static/js/openshop-host.js:8`
- Regenerate: `static/openshop/`

- [ ] **Step 1: Set one shared runtime revision in every entry point**

Use the concrete revision `2026.07.19.1784476800000` for:

```text
/static/css/openshop-host.css?v=2026.07.19.1784476800000
/static/openshop/host/openshop-protocol.js?v=2026.07.19.1784476800000
/static/js/openshop-host.js?v=2026.07.19.1784476800000
/static/js/canvas-openshop.js?v=2026.07.19.1784476800000
/static/js/smart-canvas-openshop.js?v=2026.07.19.1784476800000
```

Set `OPENSHOP_RUNTIME_REVISION` to the same value. In `integrations/openshop/index.html`, load the new service and use the same revision for protocol/runtime scripts:

```html
<script src="./host/openshop-export-service.js?v=2026.07.19.1784476800000"></script>
```

- [ ] **Step 2: Build the approved OpenShop runtime tree**

Run:

```powershell
Set-Location integrations/openshop
npm run build:hstar
```

Expected: the command lists `static/openshop/host/openshop-export-service.js`, prints `OPENSHOP_BUILD_SHA256=...`, and exits successfully.

- [ ] **Step 3: Verify source/runtime identity and stale revision absence**

Run:

```powershell
git diff --no-index -- integrations/openshop/index.html static/openshop/index.html
git diff --no-index -- integrations/openshop/host/openshop-export-service.js static/openshop/host/openshop-export-service.js
rg -n "1784465907|1784291311|1784103381" static/index.html static/canvas.html static/smart-canvas.html static/js/openshop-host.js
```

Expected: both `git diff --no-index` commands produce no differences and `rg` produces no matches in the listed entry points.

- [ ] **Step 4: Commit generated runtime and revisions**

```powershell
git add -- integrations/openshop/index.html integrations/openshop/host/openshop-export-service.js integrations/openshop/host/openshop-protocol.js integrations/openshop/host/openshop-host-runtime.js integrations/openshop/scripts/build-hstar.mjs static/openshop static/index.html static/canvas.html static/smart-canvas.html static/js/openshop-host.js static/css/openshop-host.css static/js/canvas-openshop.js static/js/smart-canvas-openshop.js
git commit -m "build: publish OpenShop native export runtime"
```

Before committing, inspect `git diff --cached --name-status`; it must contain only files named in this task and earlier task commits must not be restaged.

### Task 7: End-to-End and Real Native Save Verification

**Files:**
- Modify: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`

- [ ] **Step 1: Add an E2E test that intercepts native saves and verifies original PNG dimensions**

Create a prefixed classic test canvas so existing `afterEach` cleanup removes it. Intercept both native endpoints before opening the node:

```js
const nativeRequests = [];
await page.route('**/api/native/save-output-as', async route => {
  nativeRequests.push(route.request().postDataJSON());
  await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify({ok:true, cancelled:false, filename:'native-export.png', folder:'C:/test-output'})});
});
await page.route('**/api/native/save-output-batch', async route => {
  nativeRequests.push(route.request().postDataJSON());
  await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify({ok:true, cancelled:false, count:6, folder:'C:/test-output'})});
});

await page.locator('[data-openshop-download]').click();
await expect(page.locator('[data-openshop-notice]')).toHaveText('已保存：native-export.png');
const pngRequest = nativeRequests.find(item => item.name?.endsWith('.png') && item.content_base64);
const png = Buffer.from(pngRequest.content_base64, 'base64');
expect(png.toString('ascii', 1, 4)).toBe('PNG');
expect(png.readUInt32BE(16)).toBe(1600);
expect(png.readUInt32BE(20)).toBe(900);
```

Verify the host controls remain non-overlapping in a narrow viewport:

```js
await page.setViewportSize({width:720, height:700});
const downloadBox = await page.locator('[data-openshop-download]').boundingBox();
const sendBox = await page.locator('[data-openshop-send]').boundingBox();
expect(downloadBox.x + downloadBox.width).toBeLessThanOrEqual(sendBox.x);
expect(sendBox.x + sendBox.width).toBeLessThanOrEqual(720);
```

Within the editor frame, click the actual File-menu items, then invoke batch export:

```js
const menuCommands = [
  "OS.saveFile('png')", "OS.saveFile('jpeg')", "OS.saveFile('webp')",
  "OS.saveFile('svg')", 'OS.exportPDF()', 'OS.exportPSD()',
];
for(let index = 0; index < menuCommands.length; index += 1){
  await editor.locator(`[onclick="${menuCommands[index]}"]`).evaluate(element => element.click());
  await expect.poll(() => nativeRequests.filter(item => item.name).length).toBe(index + 2);
}
await editor.evaluate(() => OS._saveBatchFormats(['png','jpeg','webp','svg','pdf','psd']));
const singleNames = nativeRequests.filter(item => item.name).map(item => item.name);
expect(singleNames.some(name => name.endsWith('.png'))).toBe(true);
expect(singleNames.some(name => name.endsWith('.jpg'))).toBe(true);
expect(singleNames.some(name => name.endsWith('.webp'))).toBe(true);
expect(singleNames.some(name => name.endsWith('.svg'))).toBe(true);
expect(singleNames.some(name => name.endsWith('.pdf'))).toBe(true);
expect(singleNames.some(name => name.endsWith('.psd'))).toBe(true);
const batch = nativeRequests.find(item => Array.isArray(item.items));
expect(batch.items).toHaveLength(6);
```

- [ ] **Step 2: Extend the existing classic/smart output test with persistence acknowledgements**

After each `requestSendToCanvas()` call, assert the host notice only after the canvas record contains the new node:

```js
await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas({requestId:'classic-send-ack'}));
await expect.poll(() => frame.evaluate(() => window.HstarClassicOpenShopHooks.getNodes().some(node => node.openshopRequestId === 'classic-send-ack'))).toBe(true);
await expect(page.locator('[data-openshop-notice]')).toHaveText('已发送到画布');
```

Repeat with the smart adapter. For failure, install this route immediately before the send request:

```js
let failNextCanvasSave = true;
await page.route(`**/api/canvases/${smart.id}`, async route => {
  if(failNextCanvasSave && route.request().method() === 'PUT'){
    failNextCanvasSave = false;
    await route.fulfill({status:500, contentType:'application/json', body:JSON.stringify({detail:'画布保存失败'})});
    return;
  }
  await route.continue();
});
await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas({requestId:'smart-save-failure'}));
await expect(page.locator('[data-openshop-notice][data-kind="error"]')).toContainText('画布保存失败');
await expect(page.locator('[data-openshop-notice]')).not.toHaveText('已发送到画布');
await page.unroute(`**/api/canvases/${smart.id}`);
```

- [ ] **Step 3: Run focused E2E tests against the engineering service**

Run:

```powershell
Set-Location integrations/openshop
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npx playwright test tests/hstar-canvas-integration.e2e.spec.js --grep "native export|receive every OpenShop output"
```

Expected: tests pass and `hstar-test-canvas-cleanup.js` purges every `codex-e2e-openshop-` canvas and its OpenShop project data after each test.

- [ ] **Step 4: Run complete unit and regression suites**

Run:

```powershell
Set-Location integrations/openshop
npm test
npx playwright test tests/hstar-canvas-integration.e2e.spec.js
Set-Location ../..
python -m unittest discover -s tests -p "test_native_*.py" -v
node tools/tests/output-node-actions.test.mjs
git diff --check
```

Expected: all Vitest suites pass, the full canvas integration suite passes, native Python tests pass, migration checks pass, and `git diff --check` is silent.

- [ ] **Step 5: Perform one actual Windows Save As smoke test and delete its output**

In `http://127.0.0.1:3000/`, open an engineering-test OpenShop node with a 1600x900 document, click `下载到本地`, save as:

```text
C:\Users\he927\AppData\Local\Temp\hstar-openshop-native-export-smoke.png
```

Verify with PowerShell:

```powershell
Add-Type -AssemblyName System.Drawing
$path = 'C:\Users\he927\AppData\Local\Temp\hstar-openshop-native-export-smoke.png'
$image = [System.Drawing.Image]::FromFile($path)
try { "{0}x{1}" -f $image.Width,$image.Height } finally { $image.Dispose() }
Remove-Item -LiteralPath $path
```

Expected: output is `1600x900`; the file is removed afterward. Delete the prefixed engineering-test canvas through the existing cleanup helper or UI, and verify no stable-installation canvas ID is touched.

- [ ] **Step 6: Commit E2E coverage**

```powershell
git add -- integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js
git commit -m "test: cover OpenShop native export and send acknowledgements"
```

- [ ] **Step 7: Inspect final branch scope**

Run:

```powershell
git status --short
git log --oneline --decorate -8
git diff HEAD~7..HEAD --stat
```

Expected: task commits are present; unrelated pre-existing worktree changes remain uncommitted and unchanged; no merge or push to `main` has occurred.
