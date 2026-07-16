# OpenShop Text Properties and Local Fonts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Photoshop-style OpenShop text properties panel that edits whole text objects, selected character ranges, and caret input styles while automatically exposing locally installed Windows fonts.

**Architecture:** A Python-only font catalog module enumerates Windows font faces and exposes a path-free `/api/openshop/fonts` response. The existing browser font catalog becomes an asynchronous source of normalized family/style records, while a new focused text-properties controller owns the right-side panel, Fabric selection scope, top-bar synchronization, history, and project dirty events.

**Tech Stack:** Python 3.10 standard library and FastAPI, JavaScript ES modules/IIFE browser modules, Fabric.js 5.3, Vitest/jsdom, Playwright Chromium.

---

### Task 1: Add the Windows system font catalog and API

**Files:**
- Create: `openshop_fonts.py`
- Create: `tests/test_openshop_fonts.py`
- Modify: `main.py`

- [ ] **Step 1: Write failing font normalization and cache tests**

Create `tests/test_openshop_fonts.py` with `unittest` cases that inject deterministic font faces:

```python
import unittest

from openshop_fonts import OpenShopFontCatalog


class OpenShopFontCatalogTests(unittest.TestCase):
    def test_groups_styles_and_filters_vertical_aliases(self):
        calls = []

        def enumerate_faces():
            calls.append(True)
            return [
                {"family": "Arial", "weight": 400, "italic": False},
                {"family": "Arial", "weight": 700, "italic": False},
                {"family": "Arial", "weight": 700, "italic": True},
                {"family": "Arial", "weight": 700, "italic": True},
                {"family": "@SimSun", "weight": 400, "italic": False},
            ]

        catalog = OpenShopFontCatalog(enumerator=enumerate_faces, platform="win32")
        result = catalog.get_catalog()

        self.assertEqual(result["platform"], "windows")
        self.assertFalse(result["cached"])
        self.assertEqual([item["family"] for item in result["fonts"]], ["Arial"])
        self.assertEqual(
            [(item["weight"], item["italic"], item["label"])
             for item in result["fonts"][0]["styles"]],
            [(400, False, "Regular"), (700, False, "Bold"), (700, True, "Bold Italic")],
        )
        self.assertEqual(len(calls), 1)

        cached = catalog.get_catalog()
        self.assertTrue(cached["cached"])
        self.assertEqual(len(calls), 1)

        catalog.get_catalog(refresh=True)
        self.assertEqual(len(calls), 2)

    def test_response_never_exposes_font_paths(self):
        catalog = OpenShopFontCatalog(
            enumerator=lambda: [{"family":"Test Font", "weight":400, "italic":False}],
            platform="win32",
        )
        serialized = str(catalog.get_catalog()).lower()
        self.assertNotIn(".ttf", serialized)
        self.assertNotIn("path", serialized)

    def test_uses_common_fallbacks_off_windows(self):
        catalog = OpenShopFontCatalog(enumerator=lambda: [], platform="linux")
        families = [item["family"] for item in catalog.get_catalog()["fonts"]]
        self.assertIn("Microsoft YaHei UI", families)
        self.assertIn("Arial", families)


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the focused backend test and verify RED**

Run:

```powershell
E:\Claude专业组\HstarA\python\python.exe -m unittest discover -s tests -p test_openshop_fonts.py -v
```

Expected: FAIL because `openshop_fonts.py` does not exist.

- [ ] **Step 3: Implement the catalog with an injectable enumerator**

Create `openshop_fonts.py` with these responsibilities:

```python
import copy
import ctypes
import sys
from ctypes import wintypes
from threading import Lock

COMMON_FONTS = (
    "Microsoft YaHei UI", "Microsoft YaHei", "SimSun", "SimHei",
    "KaiTi", "FangSong", "Arial", "Georgia", "Verdana",
    "Times New Roman", "Courier New", "Consolas", "Impact",
)


def _style_label(weight, italic):
    base = "Thin" if weight <= 150 else "Light" if weight <= 350 else \
        "Regular" if weight <= 550 else "Semibold" if weight <= 650 else \
        "Bold" if weight <= 800 else "Black"
    return f"{base} Italic" if italic else base


def _normalize_faces(faces):
    grouped = {}
    for face in faces:
        family = str(face.get("family") or "").strip()
        if not family or family.startswith("@"):
            continue
        weight = max(100, min(900, int(face.get("weight") or 400)))
        italic = bool(face.get("italic"))
        grouped.setdefault(family.casefold(), {"family":family, "styles":{}})
        grouped[family.casefold()]["styles"][(weight, italic)] = {
            "id": f"{family.casefold()}-{weight}-{'italic' if italic else 'normal'}",
            "label": _style_label(weight, italic),
            "weight": weight,
            "italic": italic,
            "localNames": [family],
        }
    return [
        {
            "family": value["family"],
            "label": value["family"],
            "styles": [value["styles"][key] for key in sorted(value["styles"])],
        }
        for _, value in sorted(grouped.items(), key=lambda item: item[1]["family"].casefold())
    ]


class OpenShopFontCatalog:
    def __init__(self, enumerator=None, platform=None):
        self._platform = platform or sys.platform
        self._enumerator = enumerator or _enumerate_windows_faces
        self._lock = Lock()
        self._fonts = None

    def get_catalog(self, refresh=False):
        with self._lock:
            cached = self._fonts is not None and not refresh
            if not cached:
                faces = self._enumerator() if self._platform == "win32" else [
                    {"family": family, "weight": 400, "italic": False}
                    for family in COMMON_FONTS
                ]
                self._fonts = _normalize_faces(faces)
            return {
                "platform": "windows" if self._platform == "win32" else self._platform,
                "cached": cached,
                "fonts": copy.deepcopy(self._fonts),
            }
```

Implement `_enumerate_windows_faces()` with `EnumFontFamiliesExW`, a `LOGFONTW` structure, `DEFAULT_CHARSET`, and a callback that returns only `family`, `weight`, and `italic`. Always release the screen device context in `finally`. Return `COMMON_FONTS` faces if Win32 enumeration raises.

- [ ] **Step 4: Add and test the FastAPI endpoint**

Extend `tests/test_openshop_fonts.py` with:

```python
class OpenShopFontEndpointTests(unittest.TestCase):
    def test_endpoint_forwards_refresh_without_exposing_paths(self):
        import main
        from unittest.mock import patch

        payload = {"platform":"windows", "cached":False, "fonts":[]}
        with patch.object(main.OPENSHOP_FONTS, "get_catalog", return_value=payload) as getter:
            self.assertEqual(main.get_openshop_fonts(refresh=True), payload)
        getter.assert_called_once_with(refresh=True)
```

In `main.py` import `OpenShopFontCatalog`, create one process-level `OPENSHOP_FONTS`, and add:

```python
@app.get("/api/openshop/fonts")
def get_openshop_fonts(refresh: bool = False):
    return OPENSHOP_FONTS.get_catalog(refresh=refresh)
```

Run the focused test and expect all backend tests to pass.

- [ ] **Step 5: Commit the backend font catalog**

```powershell
git add openshop_fonts.py main.py tests/test_openshop_fonts.py
git commit -m "feat: expose installed fonts to OpenShop"
```

### Task 2: Make the browser font catalog asynchronous and searchable

**Files:**
- Modify: `integrations/openshop/host/openshop-font-catalog.js`
- Modify: `integrations/openshop/tests/hstar-font-catalog.test.js`

- [ ] **Step 1: Write failing load, search, refresh, and fallback tests**

Add tests using an injected `fetchImpl`:

```js
it('loads, searches and refreshes installed font families', async () => {
  const fetchImpl = vi.fn(async url => ({
    ok:true,
    json:async () => ({
      platform:'windows', cached:!String(url).includes('refresh=1'),
      fonts:[
        {family:'Microsoft YaHei UI', label:'微软雅黑 UI', styles:[
          {id:'yahei-400-normal', label:'Regular', weight:400, italic:false, localNames:['Microsoft YaHei UI']},
          {id:'yahei-700-normal', label:'Bold', weight:700, italic:false, localNames:['Microsoft YaHei UI']},
        ]},
        {family:'Century Gothic', label:'Century Gothic', styles:[
          {id:'century-400-normal', label:'Regular', weight:400, italic:false, localNames:['Century Gothic']},
        ]},
      ],
    }),
  }));
  const manager = window.HstarOpenShopFontCatalog.createManager({fetchImpl, fontProbe:() => true});

  await manager.loadSystemFonts();
  expect(manager.searchFonts('century').map(item => item.family)).toEqual(['Century Gothic']);
  expect(manager.stylesFor('Microsoft YaHei UI')).toHaveLength(2);

  await manager.refreshSystemFonts();
  expect(fetchImpl).toHaveBeenLastCalledWith('/api/openshop/fonts?refresh=1', {cache:'no-store'});
});

it('keeps common fonts usable when the system endpoint fails', async () => {
  const manager = window.HstarOpenShopFontCatalog.createManager({
    fetchImpl:async () => { throw new Error('offline'); },
    fontProbe:() => true,
  });
  await expect(manager.loadSystemFonts()).resolves.toEqual([]);
  expect(manager.searchFonts('Arial')[0].family).toBe('Arial');
  expect(manager.getState().error).toContain('offline');
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-font-catalog.test.js
```

Expected: FAIL because the async catalog methods do not exist.

- [ ] **Step 3: Implement the minimal async catalog**

Keep existing `scanEditor`, `replaceFont`, and `listCommonFonts`. Add manager state and these public methods:

```js
const state = {fonts:[], loaded:false, loading:false, error:'', platform:'', listeners:new Set()};

async function loadSystemFonts({refresh=false} = {}) {
  if(state.loading) return state.fonts;
  state.loading = true;
  state.error = '';
  try {
    const url = `/api/openshop/fonts${refresh ? '?refresh=1' : ''}`;
    const response = await fetchImpl(url, {cache:'no-store'});
    if(!response.ok) throw new Error(`字体目录加载失败 (${response.status})`);
    const payload = await response.json();
    state.platform = String(payload.platform || '');
    state.fonts = normalizeCatalog(payload.fonts, COMMON_FONTS);
    state.loaded = true;
  } catch(error) {
    state.error = error instanceof Error ? error.message : String(error);
    state.fonts = normalizeCatalog([], COMMON_FONTS);
  } finally {
    state.loading = false;
    state.listeners.forEach(listener => listener(getState()));
  }
  return state.fonts.map(cloneFont);
}
```

Expose `loadSystemFonts`, `refreshSystemFonts`, `searchFonts`, `stylesFor`, `subscribe`, and `getState`. Deduplicate case-insensitively and never discard project-missing font refs.

- [ ] **Step 4: Verify focused and existing text-tool tests**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-font-catalog.test.js tests/hstar-text-tools.test.js
```

Expected: all tests pass.

- [ ] **Step 5: Commit the browser catalog**

```powershell
git add integrations/openshop/host/openshop-font-catalog.js integrations/openshop/tests/hstar-font-catalog.test.js
git commit -m "feat: load local fonts in OpenShop"
```

### Task 3: Build the Photoshop-style text properties controller

**Files:**
- Create: `integrations/openshop/host/openshop-text-properties.js`
- Create: `integrations/openshop/host/openshop-text-properties.css`
- Create: `integrations/openshop/tests/hstar-text-properties.test.js`
- Modify: `integrations/openshop/host/openshop-project-adapter.js`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js`

- [ ] **Step 1: Write failing panel and auto-switch tests**

Create a jsdom harness with a fake evented Fabric canvas and `IText` object. Test that `start()` injects a `文字` tab and that `selection:created` or `text:editing:entered` activates it:

```js
it('opens the text tab when a text object is selected or edited', async () => {
  const {controller, canvas, textObject} = createHarness();
  await controller.start();

  canvas.activeObject = textObject;
  canvas.fire('selection:created', {selected:[textObject]});

  expect(document.querySelector('[data-hstar-text-properties-tab]').classList).toContain('active');
  expect(document.getElementById('hstar-text-properties-panel').classList).toContain('active');
  expect(document.querySelector('[data-text-family]').value).toBe('Microsoft YaHei UI');
});
```

- [ ] **Step 2: Write failing object, range, and caret scope tests**

Cover the three approved Photoshop scopes:

```js
it('applies styles to the whole object outside editing', () => {
  const {controller, textObject} = createHarness();
  controller.applyProperty('fontFamily', 'Century Gothic');
  expect(textObject.set).toHaveBeenCalledWith({fontFamily:'Century Gothic'});
});

it('applies supported character styles only to the selected range', () => {
  const {controller, textObject} = createHarness({editing:true, selectionStart:1, selectionEnd:4});
  controller.applyProperty('fontWeight', 700);
  expect(textObject.setSelectionStyles).toHaveBeenCalledWith({fontWeight:700}, 1, 4);
});

it('stores a caret style and applies it only to newly typed characters', () => {
  const {controller, textObject, canvas} = createHarness({editing:true, selectionStart:3, selectionEnd:3});
  controller.applyProperty('fill', '#ef4444');
  textObject.text = 'abcX';
  textObject.selectionStart = textObject.selectionEnd = 4;
  canvas.fire('text:changed', {target:textObject});
  expect(textObject.setSelectionStyles).toHaveBeenCalledWith({fill:'#ef4444'}, 3, 4);
});
```

Also test mixed values, object-level `textAlign/lineHeight/charSpacing`, point-to-pixel conversion, top-bar synchronization, one history entry per committed control, `fontRefs`, and `openshop:project-dirty`. Add a kerning test that verifies `auto` and `metrics` preserve zero manual tracking while `numeric` stores the entered `charSpacing`; persist the selected mode as `hstarKerningMode` without pretending Fabric has character-level kerning controls.

- [ ] **Step 3: Run the focused test and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-text-properties.test.js
```

Expected: FAIL because the controller module does not exist.

- [ ] **Step 4: Implement the controller state and scope engine**

Create `openshop-text-properties.js` as an IIFE exposing `window.HstarOpenShopTextProperties.createController`. Use these core helpers:

```js
const CHARACTER_PROPERTIES = new Set([
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'underline', 'linethrough',
]);
const OBJECT_PROPERTIES = new Set(['textAlign', 'lineHeight', 'charSpacing']);
const pointsToPixels = value => Number(value) * 96 / 72;
const pixelsToPoints = value => Number(value) * 72 / 96;

function applyProperty(property, value, {commit=true} = {}) {
  const target = activeTextObject();
  if(!target) return false;
  if(CHARACTER_PROPERTIES.has(property) && target.isEditing) {
    const start = Number(target.selectionStart || 0);
    const end = Number(target.selectionEnd || 0);
    if(start < end) target.setSelectionStyles({[property]:value}, start, end);
    else state.caretStyles[property] = value;
  } else {
    target.set({[property]:value});
  }
  editor.canvas.renderAll();
  syncControls();
  if(commit) commitChange(`修改文字${property}`);
  return true;
}

function onTextChanged(event) {
  const target = event?.target;
  if(target !== state.target || !target?.isEditing) return;
  const current = Number(target.selectionStart || 0);
  const inserted = Math.max(0, String(target.text || '').length - state.previousTextLength);
  if(inserted > 0 && Object.keys(state.caretStyles).length) {
    target.setSelectionStyles(state.caretStyles, Math.max(0, current - inserted), current);
  }
  state.previousTextLength = String(target.text || '').length;
}
```

Paragraph/object properties always call `target.set`. Implement `applyKerning(mode, value)` so `auto` and `metrics` set `{hstarKerningMode:mode, charSpacing:0}` and `numeric` sets `{hstarKerningMode:'numeric', charSpacing:value}`. Add `hstarKerningMode` to the project adapter's Fabric serialization allowlist and verify it survives serialize/restore. Bind `selection:created`, `selection:updated`, `selection:cleared`, `text:editing:entered`, `text:selection:changed`, `text:changed`, and `text:editing:exited`. Keep the text tab open after selection clears.

- [ ] **Step 5: Implement the compact right-panel UI and searchable font picker**

Inject one tab button into the existing `ptg1` tab row and one `panel-tab-content` with:

```html
<div class="hstar-text-property-grid">
  <button type="button" class="hstar-font-combobox" data-text-family aria-haspopup="listbox"></button>
  <select data-text-style></select>
  <label>字号 <input type="number" data-text-size min="1" max="1296"></label>
  <label>行距 <input type="number" data-text-line-height min="0.1" max="10" step="0.05"></label>
  <label>字距 <input type="number" data-text-tracking min="-1000" max="1000"></label>
  <label>字偶距 <select data-text-kerning-mode><option value="auto">自动</option><option value="metrics">度量</option><option value="numeric">数值</option></select></label>
  <input type="number" data-text-kerning min="-1000" max="1000" disabled>
  <input type="color" data-text-color>
  <div role="group" data-text-align></div>
  <div role="group" data-text-decoration></div>
  <button type="button" data-font-refresh title="刷新本机字体"></button>
</div>
```

The font combobox opens a bounded searchable list, supports keyboard up/down/enter/escape, shows `缺失字体` status, and uses `style="font-family:'<family>'"` only for preview text. Use existing button and panel tokens, 4px controls, no nested cards, and stable responsive dimensions.

- [ ] **Step 6: Verify controller tests and commit**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-text-properties.test.js tests/hstar-font-catalog.test.js tests/hstar-project-adapter.test.js
```

Expected: all tests pass.

Commit:

```powershell
git add integrations/openshop/host/openshop-text-properties.js integrations/openshop/host/openshop-text-properties.css integrations/openshop/host/openshop-project-adapter.js integrations/openshop/tests/hstar-text-properties.test.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: add OpenShop text properties panel"
```

### Task 4: Integrate the controller into OpenShop and the Hstar build

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `integrations/openshop/tests/hstar-offline-runtime.test.js`
- Generated by approved build: `static/openshop/index.html`
- Generated by approved build: `static/openshop/host/openshop-font-catalog.js`
- Generated by approved build: `static/openshop/host/openshop-text-properties.js`
- Generated by approved build: `static/openshop/host/openshop-text-properties.css`

- [ ] **Step 1: Write failing runtime-manifest assertions**

Extend `hstar-offline-runtime.test.js` to require the new local JS/CSS files in source HTML and the build allowlist, and reject external font URLs.

- [ ] **Step 2: Run the runtime test and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-offline-runtime.test.js
```

Expected: FAIL because the new controller is not loaded or copied.

- [ ] **Step 3: Load and start the controller**

In `index.html` add the stylesheet and script next to the existing OpenShop host modules. During the iframe `DOMContentLoaded` setup:

```js
window.HstarOpenShopTextPropertiesController?.destroy?.();
const fontManager = window.HstarOpenShopFontCatalog.createManager();
window.HstarOpenShopTextPropertiesController = window.HstarOpenShopTextProperties.createController({
  editor:OS,
  fontManager,
  documentRef:document,
});
await window.HstarOpenShopTextPropertiesController.start();
```

Reuse the same `fontManager` instance for `HstarOpenShopTextTools`. Replace the current fire-and-forget text-tools startup with an async startup block that reports errors through the existing toast without blocking the editor. Add `hstarKerningMode` to every editor history/temporary Fabric `toJSON` property list so undo, redo, and document cloning preserve it.

- [ ] **Step 4: Add runtime files to the build allowlist and build**

Add:

```js
'host/openshop-text-properties.js',
'host/openshop-text-properties.css',
```

to `runtimeFiles`, then run:

```powershell
npm.cmd --prefix integrations\openshop run build:hstar
```

Expected: build exits 0, lists both new static files, and prints `OPENSHOP_BUILD_SHA256=...`.

- [ ] **Step 5: Run unit and localization audits**

Run:

```powershell
npm.cmd --prefix integrations\openshop test
npm.cmd --prefix integrations\openshop run audit:i18n
```

Expected: all tests and all Chinese localization audit cases pass.

- [ ] **Step 6: Commit integration and generated runtime**

```powershell
git add integrations/openshop/index.html integrations/openshop/scripts/build-hstar.mjs integrations/openshop/tests/hstar-offline-runtime.test.js static/openshop
git commit -m "feat: integrate OpenShop local text editing"
```

### Task 5: Add real browser and installed-font E2E coverage

**Files:**
- Create: `integrations/openshop/tests/hstar-text-properties.e2e.spec.js`
- Modify: `integrations/openshop/package.json`

- [ ] **Step 1: Write the E2E workflow**

The E2E test must:

1. Request `/api/openshop/fonts` and assert at least one installed family, with no `path`, `.ttf`, or `.otf` in the payload.
2. Open `static/openshop/index.html`, dismiss the welcome screen, and create an 800x600 document.
3. Select the text tool, create `中文 English`, and verify the right-side `文字` tab activates.
4. Search for `Microsoft YaHei UI` when available, otherwise use the first returned family.
5. Apply family, bold style, 48 pt size, red color, center alignment, underline, line height, tracking, and each kerning mode.
6. Select a substring and apply a second family/style only to that range.
7. Place the caret, change color, type one character, and verify only the inserted character receives that color.
8. Serialize and reload through `HstarOpenShopProjectAdapter`, then verify text, styles, `fontRefs`, and nonblank rendering survive.
9. Capture screenshots at 1440x1000, 1920x1080, 430x932, and 4096x2160; assert the panel stays within the viewport and does not overlap the status bar.

- [ ] **Step 2: Add the package script**

```json
"test:hstar:text-properties": "playwright test tests/hstar-text-properties.e2e.spec.js"
```

- [ ] **Step 3: Run against an isolated engineering service**

Start a free-port HstarA process with `HSTAR_DATA_DIR` pointing to a temporary worktree profile and verify `/api/software-settings` reports a worktree-local storage root. Then run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:<isolated-port>'; npm.cmd --prefix integrations\openshop run test:hstar:text-properties
```

Expected: all E2E cases pass with no page errors, no text clipping, and nonblank canvas pixels.

- [ ] **Step 4: Run existing desktop and text suites**

Run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:<isolated-port>'; npm.cmd --prefix integrations\openshop run test:hstar:desktop
$env:HSTAR_BASE_URL='http://127.0.0.1:<isolated-port>'; npm.cmd --prefix integrations\openshop run test:hstar:text-tools
$env:HSTAR_BASE_URL='http://127.0.0.1:<isolated-port>'; npm.cmd --prefix integrations\openshop run test:hstar:canvas-integration
```

Expected: all existing suites pass, and test canvas/project/resource counts return to zero.

- [ ] **Step 5: Commit E2E coverage**

```powershell
git add integrations/openshop/tests/hstar-text-properties.e2e.spec.js integrations/openshop/package.json
git commit -m "test: cover OpenShop text properties"
```

### Task 6: Final verification and engineering restart

**Files:**
- Review only the files listed above.

- [ ] **Step 1: Run fresh backend and frontend verification**

```powershell
E:\Claude专业组\HstarA\python\python.exe -m unittest discover -s tests -v
cd integrations\openshop
npm.cmd test
npm.cmd run audit:i18n
```

- [ ] **Step 2: Inspect scoped changes**

```powershell
git diff --check
git status --short
git log -8 --oneline
```

Expected: no whitespace errors; existing user changes in `data/asset_library.json`, unrelated `static/*.html`, and `assets/` remain untouched and unstaged.

- [ ] **Step 3: Stop and remove only isolated E2E runtime data**

Verify the test service PID and every resolved temporary target are inside the current worktree, stop that PID, then remove only the temporary profile, runtime, and logs. Confirm its port is no longer listening.

- [ ] **Step 4: Restart the HstarA engineering service**

Restart only the existing engineering process serving `http://127.0.0.1:3000/` from this worktree. Preserve its configured storage root and verify:

```text
GET http://127.0.0.1:3000/api/openshop/fonts
GET http://127.0.0.1:3000/static/openshop/host/openshop-text-properties.js
```

Both must return 200. Leave `codex/openshop-inline-generative-editing` unmerged for the user's manual test.
