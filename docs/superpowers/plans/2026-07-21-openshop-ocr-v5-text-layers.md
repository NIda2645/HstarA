# OpenShop OCR v5 Text Layers Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace OpenShop OCR v4's overlapping geometry corrections with a Schema v5 pipeline that creates editable, non-distorted text layers at the recognized visible bounds using script-specific free-commercial font pools and real local font faces.

**Architecture:** The backend emits one normalized quad per text line plus Unicode style runs and never performs glyph-pixel refinement. The client matches every run to an installed local face, renders the final styled Fabric object offscreen, solves font size on the cross axis and spacing on the flow axis, then places the measured visible bounds at the OCR quad. Paragraph lines merge only when one Fabric text object can reproduce every line position; otherwise they remain independent layers.

**Tech Stack:** Python 3.14, FastAPI, Pillow, JavaScript, Fabric.js, Vitest, jsdom, Playwright.

---

## File Structure

- Modify `openshop_ai.py`: define the v5 prompt, normalize Unicode style runs, and emit Schema v5.
- Modify `main.py`: stop invoking OCR glyph-pixel refinement and publish a new runtime revision.
- Modify `openshop_image_ops.py`: remove OCR-only glyph refinement helpers while preserving art-font image processing.
- Modify `tests/test_openshop_ocr_layout.py`: replace v4 glyph tests with v5 prompt, run, and schema tests.
- Modify `integrations/openshop/host/openshop-font-catalog.js`: match one OCR run at a time and support separate Chinese and English fallback families.
- Modify `integrations/openshop/tests/hstar-font-catalog.test.js`: verify pool isolation, fallback families, and nearest real face selection.
- Rewrite `integrations/openshop/host/openshop-ocr-layout.js`: expose one line/paragraph visible-bound solver without metric or punctuation branches.
- Rewrite `integrations/openshop/tests/hstar-ocr-layout.test.js`: verify horizontal, vertical, rotated, punctuation, and paragraph fitting.
- Modify `integrations/openshop/host/openshop-text-tools.js`: validate v5 results, reconcile edited run ranges, create mixed-style objects, group paragraphs, and reject v4 applies.
- Modify `integrations/openshop/tests/hstar-text-tools.test.js`: cover v5 application, mixed runs, paragraph grouping, repeated apply, v4 rejection, and atomic failure.
- Modify `integrations/openshop/tests/hstar-foundation.e2e.spec.js`: verify rendered OCR bounds and real face properties in a running editor.
- Regenerate `static/openshop/**`, `static/js/**`, and versioned HTML through `integrations/openshop/scripts/build-hstar.mjs` rather than manual edits.

### Task 1: Replace The Backend OCR Contract With Schema v5

**Files:**
- Modify: `tests/test_openshop_ocr_layout.py`
- Modify: `openshop_ai.py`
- Modify: `main.py`
- Modify: `openshop_image_ops.py`

- [ ] **Step 1: Replace v4 prompt tests with a failing v5 contract test**

```python
def test_requests_one_quad_and_unicode_style_runs_without_v4_geometry(self):
    prompt = build_ocr_prompt(1085, 1449)
    self.assertIn("one visible text line", prompt)
    self.assertIn("runs", prompt)
    self.assertIn("Unicode code-point indexes", prompt)
    self.assertNotIn("fontMetricQuad", prompt)
    self.assertNotIn("glyphQuads", prompt)
    self.assertNotIn("Punctuation entries are optional", prompt)
```

- [ ] **Step 2: Add failing normalization tests for complete run coverage and independent block styles**

```python
def test_emits_schema_version_5_with_validated_runs(self):
    block = self.block(
        text="Open夏日",
        runs=[
            {"start": 0, "end": 4, "script": "en", "familyCandidates": ["Poster"], "size": 48, "weight": 300},
            {"start": 4, "end": 6, "script": "zh-hans", "familyCandidates": ["普惠体"], "size": 52, "weight": 700},
        ],
    )
    result = self.normalize(block)
    self.assertEqual(result["schemaVersion"], 5)
    self.assertEqual(result["blocks"][0]["runs"][1]["weight"], 700)

def test_rejects_overlapping_or_incomplete_unicode_runs(self):
    result = self.normalize_many([self.block(text="ABC", runs=[{"start": 0, "end": 2, "script": "en"}])])
    self.assertEqual(result["blocks"], [])
    self.assertEqual(result["warnings"][0]["code"], "invalid_runs")
```

- [ ] **Step 3: Run the focused Python tests and verify RED**

Run:

```powershell
py -3.14 -m unittest -v tests.test_openshop_ocr_layout.OpenShopOcrPromptTests tests.test_openshop_ocr_layout.OpenShopOcrWritingModeTests
```

Expected: FAIL because the prompt still requests `fontMetricQuad/glyphQuads` and normalization emits Schema v4 without runs.

- [ ] **Step 4: Implement bounded run normalization in `openshop_ai.py`**

Add a dedicated normalizer with this interface:

```python
def _normalize_ocr_runs(value: Any, text: str) -> list[dict[str, Any]]:
    codepoints = list(text)
    runs = value if isinstance(value, list) else []
    normalized = [_normalize_ocr_run(run, len(codepoints)) for run in runs]
    normalized.sort(key=lambda run: (run["start"], run["end"]))
    cursor = 0
    for run in normalized:
        if run["start"] != cursor or run["end"] <= run["start"]:
            raise OpenShopAiValidationError("OCR runs must completely cover text")
        cursor = run["end"]
    if cursor != len(codepoints):
        raise OpenShopAiValidationError("OCR runs must completely cover text")
    return normalized
```

Normalize each run's `script`, `familyCandidates`, `size`, `weight`, `style`, `artistic`, `styleDescription`, `color`, `letterSpacing`, `lineHeight`, `strokeColor`, `strokeWidth`, and `shadow` independently. Do not copy style values from adjacent runs.

- [ ] **Step 5: Rewrite `build_ocr_prompt()` and `_normalize_block()` for Schema v5**

The prompt must request exactly one tight visible quad per line and full run coverage. `_normalize_block()` must assign `runs` and must not preserve `fontMetricQuad` or `glyphQuads`. `normalize_ocr_layout()` must emit `schemaVersion: 5`.

- [ ] **Step 6: Remove OCR pixel-refinement invocation and helpers**

Remove the `refine_ocr_glyph_quads` import and call from `main.py`. Remove `_ocr_color`, `_ocr_quad_bounds`, `_normalized_axis_quad`, `_refine_ocr_glyph_bounds`, and `refine_ocr_glyph_quads` from `openshop_image_ops.py`; do not change art-font crop, mask, or normalization functions.

- [ ] **Step 7: Run focused and full Python tests**

Run:

```powershell
py -3.14 -m unittest -v tests.test_openshop_ocr_layout
py -3.14 -m unittest discover -s tests -p 'test_*.py' -v
```

Expected: all tests pass and no test imports `refine_ocr_glyph_quads`.

- [ ] **Step 8: Commit the backend contract**

```powershell
git add openshop_ai.py openshop_image_ops.py main.py tests/test_openshop_ocr_layout.py
git commit -m "refactor: replace OpenShop OCR geometry with schema v5"
```

### Task 2: Add Script-Specific Run Font Matching And Dual Fallbacks

**Files:**
- Modify: `integrations/openshop/tests/hstar-font-catalog.test.js`
- Modify: `integrations/openshop/host/openshop-font-catalog.js`

- [ ] **Step 1: Add failing tests for run pools and fallback families**

```javascript
it('matches OCR runs by script and uses distinct Chinese and English fallbacks', async () => {
  const manager = await loadedManager([
    font('阿里巴巴普惠体 3.0', '', [style('普惠 Light', 300), style('普惠 Bold', 700)]),
    font('阿里妈妈灵动体', '', [style('灵动 Regular', 400), style('灵动 Bold', 700)]),
    font('01免海报体', '01', [style('01免海报体 Bold', 700)]),
    font('03免Poster', '03', [style('03免Poster Light', 300)]),
  ]);
  expect(manager.matchOcrRun({script:'zh-hans', familyCandidates:['海报体'], weight:680}).faceFamily).toBe('01免海报体 Bold');
  expect(manager.matchOcrRun({script:'zh-hans', familyCandidates:['Missing'], weight:260}).family).toBe('阿里巴巴普惠体 3.0');
  expect(manager.matchOcrRun({script:'en', familyCandidates:['Missing'], weight:680}).family).toBe('阿里妈妈灵动体');
});
```

- [ ] **Step 2: Add a failing nearest-face tie test**

Verify that target weight `600` chooses `500` instead of `700` when distances are equal, and that matching italic wins before weight distance.

- [ ] **Step 3: Run the focused Vitest file and verify RED**

Run from `integrations/openshop`:

```powershell
npm.cmd test -- tests/hstar-font-catalog.test.js
```

Expected: FAIL because `matchOcrRun` and the English fallback do not exist.

- [ ] **Step 4: Implement `matchOcrRun()` and fallback indexing**

Replace the single fallback record with:

```javascript
const FALLBACK_FAMILIES = Object.freeze({
  'zh-hans':'阿里巴巴普惠体 3.0',
  'zh-hant':'阿里巴巴普惠体 3.0',
  en:'阿里妈妈灵动体',
});
```

`buildSystemFontMatchIndex()` must populate `fallbackFonts` by exact canonical family. `matchOcrRun(run)` selects pool `01`, `02`, or `03`, preserves existing reliable-name threshold behavior, and then calls `nearestStyle()` with the run's numeric weight and italic state. Keep `matchOcrFont(block)` as a compatibility adapter for non-v5 callers until Task 4 removes its OCR apply usage.

- [ ] **Step 5: Run focused and complete font catalog tests**

```powershell
npm.cmd test -- tests/hstar-font-catalog.test.js
```

Expected: all font catalog tests pass.

- [ ] **Step 6: Commit font matching**

```powershell
git add integrations/openshop/host/openshop-font-catalog.js integrations/openshop/tests/hstar-font-catalog.test.js
git commit -m "feat: match OCR style runs to local font faces"
```

### Task 3: Rewrite The OCR Visible-Bounds Layout Solver

**Files:**
- Modify: `integrations/openshop/tests/hstar-ocr-layout.test.js`
- Modify: `integrations/openshop/host/openshop-ocr-layout.js`

- [ ] **Step 1: Replace metric/punctuation tests with failing single-quad tests**

Add deterministic measurement tests for these contracts:

```javascript
const result = runtime.fitLineObject(object, target, {
  writingMode:'vertical',
  measure:measureVisibleBounds,
});
expect(result.visibleBox.width).toBeCloseTo(target.width, 3);
expect(result.left).toBeCloseTo(target.left - result.localVisibleOffset.x, 3);
expect(object.scaleX).toBe(1);
expect(object.scaleY).toBe(1);
```

Cover horizontal, vertical, `angle: 17`, a line ending in punctuation, a single glyph, and a measurement failure. Assert that no option named `metricGeometry`, `metricText`, `glyphGeometries`, or `hstarVerticalTrailingPunctuationOffset` is read.

- [ ] **Step 2: Add failing paragraph representability tests**

```javascript
expect(runtime.paragraphPlan([lineA, lineB])).toMatchObject({merge:true});
expect(runtime.paragraphPlan([lineA, irregularLine])).toMatchObject({merge:false, reason:'irregular-line-spacing'});
```

- [ ] **Step 3: Run the OCR layout tests and verify RED**

```powershell
npm.cmd test -- tests/hstar-ocr-layout.test.js
```

Expected: FAIL because the runtime still exposes v4 metric fitting and punctuation compensation.

- [ ] **Step 4: Implement `fitLineObject()` with one geometry source**

Keep `quadGeometry()` and `measureVisibleBounds()`. Replace `glyphMetricGeometry()` and the v4 `fitTextObject()` branches with:

```javascript
function fitLineObject(object, geometry, options = {}) {
  const target = normalizedGeometry(geometry);
  const writingMode = normalizeWritingMode(options.writingMode);
  setValues(object, {scaleX:1, scaleY:1});
  solveCrossAxisFontSize(object, target, writingMode, options.measure);
  solveFlowAxisSpacing(object, target, writingMode, options.measure);
  return placeVisibleBounds(object, target, options.measure);
}
```

The solver may change only `fontSize`, `charSpacing`, `lineHeight`, `left`, `top`, and `angle`. It must reject non-finite measurements and never set object scale.

- [ ] **Step 5: Implement `paragraphPlan()`**

Group only lines sharing `paragraphId`, writing mode, approximately equal rotation, compatible cross-axis size, and a uniform line/column interval within one pixel. Return separate one-line plans when any invariant fails.

- [ ] **Step 6: Run focused layout tests**

```powershell
npm.cmd test -- tests/hstar-ocr-layout.test.js
```

Expected: all layout tests pass.

- [ ] **Step 7: Commit the layout runtime**

```powershell
git add integrations/openshop/host/openshop-ocr-layout.js integrations/openshop/tests/hstar-ocr-layout.test.js
git commit -m "refactor: use one OCR visible-bound layout solver"
```

### Task 4: Create V5 Text Layers With Unicode Style Runs

**Files:**
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`
- Modify: `integrations/openshop/host/openshop-text-tools.js`

- [ ] **Step 1: Add failing tests for v5 validation and v4 rejection**

```javascript
await controller.runTextExtraction();
await expect(controller.applyTextExtraction()).rejects.toThrow('旧版识别结果');
expect(editor.canvas.add).not.toHaveBeenCalled();
```

Use a separate result with `schemaVersion:5` to verify creation proceeds only when result dimensions equal the captured canvas dimensions.

- [ ] **Step 2: Add failing mixed-run and nearest-face tests**

Create one `Open夏日` block with English and Chinese runs. Assert `matchOcrRun()` is called twice and the resulting one Fabric text object has English styles on code points `0..3` and Chinese styles on `4..5`, including the selected face family, weight, italic, fill, stroke, and shadow.

- [ ] **Step 3: Add failing edited-text run reconciliation tests**

Verify a single run expands to the full edited text. For multi-run text, verify unchanged code points retain styles and inserted Chinese/English characters inherit the adjacent run with matching script.

- [ ] **Step 4: Add failing paragraph and atomicity tests**

Verify two representable lines create one object containing a newline. Verify irregular lines create two layers. Make the second line's layout throw and assert no canvas object, layer, or history entry is created.

- [ ] **Step 5: Run the text tool tests and verify RED**

```powershell
npm.cmd test -- tests/hstar-text-tools.test.js
```

Expected: FAIL because application still matches one font per block and consumes v4 metric geometry.

- [ ] **Step 6: Implement v5 guards and run reconciliation**

Add pure helpers with explicit interfaces:

```javascript
function assertOcrV5Result(record, canvasWidth, canvasHeight) {}
function reconcileOcrRuns(originalText, editedText, runs) {}
function fabricStylesForRuns(text, resolvedRuns) {}
```

`assertOcrV5Result` rejects non-v5 results and dimension mismatches before font loading or canvas mutation. `reconcileOcrRuns` uses code-point arrays rather than UTF-16 offsets.

- [ ] **Step 7: Preflight all run fonts and build paragraph plans**

Call `fontManager.loadSystemFonts()` once, resolve every run through `matchOcrRun()`, wait for `document.fonts.load()` for every selected face, and compute every line/paragraph object off-canvas. Do not call `editor.canvas.add()` until every object has fitted successfully.

- [ ] **Step 8: Apply Fabric character styles and single-quad fitting**

Set base object properties from the first run and apply run differences through Fabric's per-line/per-character `styles`. Call `ocrLayout.fitLineObject()` for one-line plans. For a merged paragraph, derive `lineHeight` from `paragraphPlan()` and verify all rendered line boxes before accepting the merge; otherwise use one object per line.

Persist only v5 provenance:

```javascript
{
  hstarOcrSchemaVersion:5,
  hstarOcrQuad:block.quad,
  hstarOcrRuns:block.runs,
  hstarOcrOriginalText:originalBlock.text,
  hstarOcrVisualProfile:visualProfile,
}
```

Do not persist new `hstarOcrFontMetricQuad` or `hstarOcrGlyphQuads` values.

- [ ] **Step 9: Preserve repeatable apply and review persistence**

Do not set a one-shot applied flag that disables creation. Keep `reviewBlocks` in the project task record after apply and clear it only when the user starts a new extraction.

- [ ] **Step 10: Run focused text tool tests**

```powershell
npm.cmd test -- tests/hstar-text-tools.test.js tests/hstar-ocr-layout.test.js tests/hstar-font-catalog.test.js
```

Expected: all focused tests pass.

- [ ] **Step 11: Commit text-layer creation**

```powershell
git add integrations/openshop/host/openshop-text-tools.js integrations/openshop/tests/hstar-text-tools.test.js
git commit -m "feat: create editable OCR v5 text layers"
```

### Task 5: Publish Assets And Verify The Complete Workflow

**Files:**
- Modify: `integrations/openshop/tests/hstar-foundation.e2e.spec.js`
- Modify through build: `integrations/openshop/index.html`
- Modify through build: `static/openshop/**`
- Modify through build: `static/js/**`
- Modify: `main.py`

- [ ] **Step 1: Add an E2E fixture for exact visible-bound placement**

Add a deterministic v5 OCR response with horizontal, vertical, rotated, punctuation, mixed-run, and multi-line blocks. In Playwright, create layers, render the canvas, scan each text object's visible pixels, and assert top-left and cross-axis error are at most one canvas pixel. Assert `scaleX/scaleY` are exactly `1` and non-Regular fixtures use non-Regular real faces.

- [ ] **Step 2: Run the E2E test against an isolated server and verify RED**

Start `main.py` with `HSTAR_PORT=3010` and an isolated `HSTAR_DATA_DIR` under `tmp/`, then run:

```powershell
$testData = Join-Path (Get-Location) 'tmp\hstar-e2e-ocr-v5'
New-Item -ItemType Directory -Path $testData -Force | Out-Null
$env:HSTAR_PORT = '3010'
$env:HSTAR_DATA_DIR = $testData
$testServer = Start-Process `
  -FilePath 'C:\Users\he927\AppData\Local\Programs\Python\Python314\python.exe' `
  -ArgumentList 'main.py' `
  -WorkingDirectory (Get-Location) `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $testData 'server.stdout.log') `
  -RedirectStandardError (Join-Path $testData 'server.stderr.log') `
  -PassThru
Set-Location integrations\openshop
npm.cmd run test:hstar:e2e
Set-Location ..\..
```

Expected: the new v5 fixture fails before static assets are rebuilt.

- [ ] **Step 3: Build OpenShop static assets and bump the runtime revision**

Run from `integrations/openshop`:

```powershell
npm.cmd run build:hstar
```

Update `OPENSHOP_RUNTIME_REVISION` once and ensure the build applies the same revision to the host, editor scripts, and HTML entry points.

- [ ] **Step 4: Run all automated verification**

```powershell
npm.cmd test
py -3.14 -m unittest discover -s tests -p 'test_*.py' -v
node --test tools/tests/openshop-ai-api.test.mjs tools/tests/openshop-ai-image-normalization.test.mjs tools/tests/openshop-localization-build.test.mjs tools/tests/qzz-image-provider-routing.test.mjs
npm.cmd run test:hstar:e2e
git diff --check
```

Expected: zero failures; Vitest, Python, Node, and Playwright report all tests passed.

- [ ] **Step 5: Perform one authorized real-API OCR run**

Use the existing saved API configuration, never hardcode credentials. Run OCR against the user's reference image, verify the returned result is Schema v5, create text layers in an isolated OpenShop project, and record for each block:

```json
{
  "targetQuad": {},
  "visibleBounds": {},
  "topLeftErrorPx": 0,
  "crossAxisErrorPx": 0,
  "family": "",
  "faceFamily": "",
  "weight": 0,
  "fontSize": 0,
  "charSpacing": 0,
  "lineHeight": 0
}
```

Delete only the isolated test project and temporary server directory after recording results. Do not delete or modify existing user canvases.

```powershell
Stop-Process -Id $testServer.Id
if ([System.IO.Directory]::Exists($testData)) {
  [System.IO.Directory]::Delete($testData, $true)
}
```

- [ ] **Step 6: Restart the real HstarA server**

Stop only the process listening on port `3000`, restart the current worktree's Python 3.14 `main.py` with a hidden window, and verify `http://127.0.0.1:3000/` returns HTTP 200 with the new runtime revision.

- [ ] **Step 7: Commit the published implementation**

```powershell
git add main.py integrations/openshop/index.html integrations/openshop/tests/hstar-foundation.e2e.spec.js static
git commit -m "build: publish OpenShop OCR v5 text layers"
```

## Completion Checklist

- [ ] Schema v5 is the only contract accepted for new OCR text-layer creation.
- [ ] OCR v4 geometry fields and pixel refinement are absent from the new path.
- [ ] `01免 / 02免 / 03免` pools and both required fallback families are enforced.
- [ ] Mixed text uses one layer with Unicode character styles.
- [ ] Horizontal, vertical, rotated, punctuation, and paragraph layouts use one quad per line.
- [ ] Every created text object has `scaleX=1` and `scaleY=1`.
- [ ] Old OCR results remain viewable but cannot create new layers.
- [ ] V5 results remain persisted and reusable.
- [ ] No partial layers are created on font or layout failure.
- [ ] Real API and deterministic pixel-bound verification are recorded.
- [ ] Port `3000` serves the rebuilt runtime.
