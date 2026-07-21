# OpenShop Font, OCR, and Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make OpenShop use authoritative installed-font styles, create OCR text at stable zero spacing and correct size, localize OCR failures, and persist the latest project before close or refresh.

**Architecture:** The Python font catalog parses installed font files with `fontTools` and exposes normalized family/style records to the existing frontend manager. OCR layout remains a separate pure fitting module with shrink-only sizing. The embedded editor tracks dirty revisions while the host delays close until the latest save acknowledgement, keeping global host errors separate from OCR tool errors.

**Tech Stack:** Python 3.14, fontTools, FastAPI, browser Canvas/Fabric.js, Vitest/JSDOM, Playwright.

---

### Task 1: Authoritative Windows font metadata

**Files:**
- Modify: `requirements.txt`
- Modify: `openshop_fonts.py`
- Modify: `tests/test_openshop_fonts.py`

- [ ] **Step 1: Write failing tests for real style metadata and variable weights**

Add tests that inject file metadata and verify a variable family produces real non-italic weights while a Regular-only family produces one style:

```python
catalog = OpenShopFontCatalog(
    enumerator=lambda: [{"family": "03免 阿里妈妈灵动体VF Thin", "path": "agile.ttf"}],
    metadata_reader=lambda _path: [{
        "groupFamily": "03免 阿里妈妈灵动体VF",
        "family": "03免 阿里妈妈灵动体VF",
        "styleLabel": "Thin",
        "weight": 100,
        "italic": False,
        "variableWeightRange": (100, 900),
    }],
    platform="win32",
)
styles = catalog.get_catalog()["fonts"][0]["styles"]
self.assertEqual([style["weight"] for style in styles], list(range(100, 1000, 100)))
self.assertTrue(all(style["italic"] is False for style in styles))
```

- [ ] **Step 2: Run the focused Python tests and verify failure**

Run: `python -m unittest tests.test_openshop_fonts -v`

Expected: FAIL because `metadata_reader`, file paths, and authoritative style fields are not implemented.

- [ ] **Step 3: Add fontTools and parse installed font files**

Add `fonttools>=4.56,<5` to `requirements.txt`. Extend registry records with `path`, parse TTF/OTF/TTC name, OS/2, post, and fvar tables, and emit normalized records:

```python
def _read_font_file_faces(path):
    fonts = TTCollection(path).fonts if path.casefold().endswith((".ttc", ".otc")) else [TTFont(path, lazy=True)]
    return [_fonttools_face(font, path) for font in fonts]

def _variable_weights(face):
    minimum, maximum = face.get("variableWeightRange") or (face["weight"], face["weight"])
    return [weight for weight in range(100, 1000, 100) if minimum <= weight <= maximum]
```

Authoritative `groupFamily`, `styleLabel`, `weight`, and `italic` bypass name-suffix inference. Failed file reads fall back to the existing GDI/registry face.

- [ ] **Step 4: Run font tests and the live catalog probe**

Run: `python -m unittest tests.test_openshop_fonts -v`

Run: `python -c "from openshop_fonts import OpenShopFontCatalog; import json; c=OpenShopFontCatalog().get_catalog(refresh=True); print(json.dumps([f for f in c['fonts'] if '阿里妈妈灵动体' in f['family']], ensure_ascii=False, indent=2))"`

Expected: tests PASS; `03免 阿里妈妈灵动体VF` is one English family with truthful non-italic styles.

### Task 2: Exact fallback, “字型”, and real font previews

**Files:**
- Modify: `integrations/openshop/host/openshop-font-catalog.js`
- Modify: `integrations/openshop/host/openshop-text-properties.js`
- Modify: `integrations/openshop/host/openshop-text-properties.css`
- Modify: `integrations/openshop/tests/hstar-font-catalog.test.js`
- Modify: `integrations/openshop/tests/hstar-text-properties.test.js`

- [ ] **Step 1: Write failing frontend tests**

Assert the English fallback and preview style:

```javascript
expect(manager.fallbackFamilyFor('Hello')).toBe('03免 阿里妈妈灵动体VF');
expect(panel.textContent).toContain('字型');
expect(panel.textContent).not.toContain('字形');
expect(fontOption.style.fontFamily).toContain('03免 阿里妈妈灵动体VF');
expect(fontOption.style.fontWeight).toBe('100');
expect(fontOption.style.fontStyle).toBe('normal');
```

- [ ] **Step 2: Run focused Vitest and verify failure**

Run: `npx vitest run integrations/openshop/tests/hstar-font-catalog.test.js integrations/openshop/tests/hstar-text-properties.test.js`

Expected: FAIL on the old fallback, “字形”, or missing preview weight/style.

- [ ] **Step 3: Implement exact fallback and preview face selection**

Set both the English fallback and first alias to `03免 阿里妈妈灵动体VF`. Render each family label using its nearest-to-Regular available style:

```javascript
const previewStyle = [...(font.styles || [])].sort((a, b) =>
  Math.abs(Number(a.weight) - 400) - Math.abs(Number(b.weight) - 400)
)[0];
option.style.fontFamily = clean(previewStyle?.family) || family;
option.style.fontWeight = String(Number(previewStyle?.weight) || 400);
option.style.fontStyle = previewStyle?.italic ? 'italic' : 'normal';
```

Change the property label from `字形` to `字型`. Keep section headings in the UI font.

- [ ] **Step 4: Run focused frontend tests**

Run: `npx vitest run integrations/openshop/tests/hstar-font-catalog.test.js integrations/openshop/tests/hstar-text-properties.test.js`

Expected: PASS.

### Task 3: OCR zero spacing and shrink-only size fitting

**Files:**
- Modify: `integrations/openshop/host/openshop-ocr-layout.js`
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `integrations/openshop/tests/hstar-ocr-layout.test.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Replace expansion expectations with failing zero-spacing tests**

Add assertions for object and character styles:

```javascript
runtime.fitLineObject(object, target, {writingMode:'horizontal', measure});
expect(object.charSpacing).toBe(0);
expect(object.styles[0][0].charSpacing).toBe(0);
expect(object.fontSize).toBeLessThanOrEqual(sourceFontSize);
expect(object.scaleX).toBe(1);
expect(object.scaleY).toBe(1);
```

- [ ] **Step 2: Run focused OCR tests and verify failure**

Run: `npx vitest run integrations/openshop/tests/hstar-ocr-layout.test.js integrations/openshop/tests/hstar-text-tools.test.js`

Expected: FAIL because positive OCR spacing and 20% font enlargement remain possible.

- [ ] **Step 3: Implement zero spacing and shrink-only fitting**

Remove flow-axis spacing fitting, initialize every OCR object and per-character style to zero spacing, and cap fitting at the recognized size:

```javascript
const maximumFontSize = anchorFontSize;
setValues(object, {fontSize:anchorFontSize, charSpacing:0, scaleX:1, scaleY:1, angle:target.angle});
updateStyledNumber(object, 'charSpacing', () => 0);
```

Use cross-axis fitting only when it shrinks. Then, if the measured flow length still exceeds the OCR target, shrink font size by `targetFlow / visibleFlow`; never stretch the object or add spacing.

- [ ] **Step 4: Run focused OCR tests**

Run: `npx vitest run integrations/openshop/tests/hstar-ocr-layout.test.js integrations/openshop/tests/hstar-text-tools.test.js`

Expected: PASS for horizontal and vertical OCR blocks with `charSpacing === 0`.

### Task 4: Localize OCR position failures and isolate tool errors

**Files:**
- Modify: `openshop_ai.py`
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `tests/test_openshop_ocr_layout.py`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Write failing localization and status-scope tests**

```python
with self.assertRaisesRegex(OpenShopAiValidationError, "OCR 模型没有返回可靠的文字位置"):
    normalize_ocr_result(payload)
```

```javascript
await controller.runTextExtraction();
expect(panel.textContent).toContain('OCR 模型没有返回可靠的文字位置');
expect(window.parent.postMessage).not.toHaveBeenCalledWith(
  expect.objectContaining({type:protocol.TYPES.ERROR}), expect.anything()
);
```

- [ ] **Step 2: Run focused tests and verify failure**

Run: `python -m unittest tests.test_openshop_ocr_layout -v`

Run: `npx vitest run integrations/openshop/tests/hstar-text-tools.test.js`

Expected: FAIL on the English backend error and/or global error leakage.

- [ ] **Step 3: Add a single OCR error translator**

Use Chinese validation messages in `openshop_ai.py`. In the text tool, normalize known upstream messages before `setStatus('failed', ...)`:

```javascript
function localizedOcrError(error){
  const message = clean(error?.message || error);
  if(/reliable text positions|reliable position/i.test(message)) {
    return 'OCR 模型没有返回可靠的文字位置，请重新执行文字提取';
  }
  return message || '文字提取失败，请重试';
}
```

Tool failures stay in `.hstar-text-status`; only project load/save/host communication may set the host header to `error`. Clear the stale host error after a successful project change/save.

- [ ] **Step 4: Run focused localization tests**

Run: `python -m unittest tests.test_openshop_ocr_layout -v`

Run: `npx vitest run integrations/openshop/tests/hstar-text-tools.test.js integrations/openshop/tests/hstar-openshop-host.test.js`

Expected: PASS with no English OCR position warning in the global header.

### Task 5: Save barrier for close and refresh

**Files:**
- Modify: `integrations/openshop/host/openshop-host-runtime.js`
- Modify: `static/js/openshop-host.js`
- Modify: `integrations/openshop/tests/hstar-host-runtime.test.js`
- Modify: `integrations/openshop/tests/hstar-openshop-host.test.js`

- [ ] **Step 1: Write failing close/save revision tests**

```javascript
window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'Edit'}}));
const closing = host.close();
expect(overlay.hidden).toBe(false);
expect(posted(protocol.TYPES.REQUEST_SAVE)).toHaveLength(1);
dispatchEditorSaveProject();
await acknowledgeProjectPut();
await closing;
expect(overlay.hidden).toBe(true);
```

Add a runtime test where a second dirty revision arrives during close; the close promise resolves only after the second revision is confirmed.

- [ ] **Step 2: Run host/runtime tests and verify failure**

Run: `npx vitest run integrations/openshop/tests/hstar-host-runtime.test.js integrations/openshop/tests/hstar-openshop-host.test.js`

Expected: FAIL because `close()` currently hides immediately and returns `null`.

- [ ] **Step 3: Track revisions and await close saves**

Increment `dirtyRevision` in `markDirty`, capture `savingRevision` in each save, and only clear dirty state when confirmation covers the latest revision:

```javascript
state.dirtyRevision += 1;
const revision = state.dirtyRevision;
state.pendingSave = {...pending, revision};
if(pending.revision >= state.dirtyRevision) state.dirty = false;
else queueSave({reason:'autosave'});
```

Change host close to request a close save and hide only after save confirmation:

```javascript
async function close(){
  const session = activeSession();
  if(!session?.editorReady) return hideOverlay();
  setStatus(session, 'saving');
  await requestSave({reason:'close', closeAfter:true});
}
```

Make `requestSave` return a promise tied to request ID confirmation. Register `pagehide` and `beforeunload` handlers that start the same latest-revision save path without deleting the session or project binding.

- [ ] **Step 4: Run persistence tests**

Run: `npx vitest run integrations/openshop/tests/hstar-host-runtime.test.js integrations/openshop/tests/hstar-openshop-host.test.js`

Expected: PASS; close waits for the newest revision and save failure leaves OpenShop visible.

### Task 6: Build, full regression, and live verification

**Files:**
- Generated: `static/openshop/**`
- Modify: `VERSION`
- Modify: runtime revision references generated by the existing build script

- [ ] **Step 1: Install the approved dependency**

Run: `python -m pip install "fonttools>=4.56,<5"`

Expected: fontTools installs into the Python 3.14 runtime used by HstarA.

- [ ] **Step 2: Build embedded OpenShop assets**

Run: `node integrations/openshop/scripts/build-hstar.mjs`

Expected: source host files are copied to `static/openshop`, and the runtime revision is refreshed.

- [ ] **Step 3: Run complete automated suites**

Run: `npx vitest run`

Run: `python -m unittest discover -s tests -p "test_*.py"`

Run: `node tools/tests/openshop-localization-build.test.mjs`

Expected: all existing and new tests PASS.

- [ ] **Step 4: Preserve data, restart HstarA, and perform browser checks**

Record the canvas count before restart, stop only the current HstarA PID, launch `python main.py` from this worktree, and confirm `http://127.0.0.1:3000/` responds. Verify:

1. The font panel says “字型”, `03免 阿里妈妈灵动体VF` is the English fallback, and family rows show real previews.
2. OCR-created text has zero spacing and does not exceed the recognized source size.
3. OCR position failures appear in Chinese inside the extraction panel, not as a red English header.
4. Edit a project, close OpenShop, refresh HstarA, reopen the same node, and confirm the edit remains.
5. Canvas count and existing project files are unchanged.
