# OpenShop OCR Geometry and Art Font Local Redraw Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align editable horizontal and vertical OCR text by visible glyph pixels, and replace transparent artistic-glyph generation with an original-image patch plus mask local-redraw workflow.

**Architecture:** A new browser-side OCR layout module measures the untransformed text object's alpha bounds and solves font size, character spacing, and origin offsets without object scaling. Python image helpers prepare a source patch and transparent edit mask, then restore protected source pixels after generation; the backend returns an exact `placementBox`, and OpenShop places the resulting opaque patch at native size.

**Tech Stack:** JavaScript, Fabric.js 5.3, Vitest, Python 3.14, Pillow, FastAPI task orchestration, unittest, Playwright, existing HstarA image-provider routing.

---

### Task 1: Visible-glyph OCR layout module

**Files:**
- Create: `integrations/openshop/host/openshop-ocr-layout.js`
- Create: `integrations/openshop/tests/hstar-ocr-layout.test.js`
- Modify: `integrations/openshop/index.html`

- [ ] **Step 1: Write failing layout tests**

Add tests that inject deterministic alpha-bound measurements and assert horizontal fitting matches target height and width, vertical fitting matches target width and height, rotated origin compensation is finite, and both object scales remain `1`.

```js
const result = layout.fitTextObject(object, geometry, {
  writingMode:'horizontal',
  measure:fakeVisibleBounds,
});
expect(object.scaleX).toBe(1);
expect(object.scaleY).toBe(1);
expect(result.visibleBox.width).toBeCloseTo(geometry.width, 1);
expect(result.visibleBox.height).toBeCloseTo(geometry.height, 1);
```

- [ ] **Step 2: Run the new test and verify RED**

Run: `npm.cmd test -- hstar-ocr-layout.test.js`

Expected: FAIL because `openshop-ocr-layout.js` and `HstarOpenShopOcrLayout` do not exist.

- [ ] **Step 3: Implement the layout module**

Expose `quadGeometry`, `measureVisibleBounds`, and `fitTextObject`. Render `object._render` into a padded offscreen canvas centered on the object, scan alpha pixels, solve cross-axis font size and flow-axis `charSpacing`, then compensate `left/top` through the quad rotation matrix.

```js
root.HstarOpenShopOcrLayout = Object.freeze({
  quadGeometry,
  measureVisibleBounds,
  fitTextObject,
});
```

Clamp font size, character spacing, iteration count, canvas size, and all finite numbers. Set `scaleX` and `scaleY` to `1` on every successful fit.

- [ ] **Step 4: Load the module before text tools and verify GREEN**

Run: `npm.cmd test -- hstar-ocr-layout.test.js`

Expected: all new layout tests pass.

### Task 2: Use visible-glyph fitting when creating OCR layers

**Files:**
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Replace old expectations with failing visible-bound expectations**

Update the horizontal/vertical OCR creation tests to inject `ocrLayout`, expect `fitTextObject` for every block, expect solved `fontSize`/`charSpacing`, and assert `scaleX=1`, `scaleY=1`. Add a source-result scaling case where a `960x540` OCR response maps to a `1920x1080` canvas without position drift.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `npm.cmd test -- hstar-text-tools.test.js hstar-ocr-layout.test.js`

Expected: FAIL because text tools still call `fitTextUniformly`.

- [ ] **Step 3: Integrate the new layout contract**

Require `options.ocrLayout || root.HstarOpenShopOcrLayout`, remove `fitTextUniformly`, and call:

```js
const fit = ocrLayout.fitTextObject(object, geometry, {
  writingMode:visualProfile.writingMode,
  documentRef,
});
```

Persist the solved text properties while retaining the original OCR quad and visual profile for art-font provenance.

- [ ] **Step 4: Run focused tests and verify GREEN**

Run: `npm.cmd test -- hstar-text-tools.test.js hstar-ocr-layout.test.js`

Expected: both files pass.

### Task 3: Source patch and edit-mask image primitives

**Files:**
- Modify: `openshop_image_ops.py`
- Create: `tests/test_openshop_art_font_patch.py`
- Modify: `tools/tests/openshop-ai-image-normalization.test.mjs`

- [ ] **Step 1: Write failing Python tests**

Cover `prepare_art_font_edit` returning an opaque cropped source, transparent-inside/opaque-outside mask, and in-document `placementBox`. Cover `normalize_art_font_patch_output` restoring every protected pixel exactly and returning a PNG whose dimensions equal `placementBox`.

```python
patch, mask, placement = prepare_art_font_edit(source_png, quad)
output, result = normalize_art_font_patch_output(generated_png, patch, mask, placement)
self.assertEqual(result["placementBox"], placement)
self.assertEqual(protected_pixels(output), protected_pixels(patch))
```

- [ ] **Step 2: Run tests and verify RED**

Run: `python -m unittest tests.test_openshop_art_font_patch -v`

Expected: import failure for the new functions.

- [ ] **Step 3: Implement patch preparation and protected compositing**

Create a bounded axis-aligned crop around the normalized quad, rasterize the expanded quad into a PNG mask with alpha `0` in editable pixels and `255` in protected pixels, and return integer source-image placement coordinates. Decode generated output safely, fit it to patch dimensions, and composite generated pixels only where mask alpha is transparent.

- [ ] **Step 4: Run image tests and verify GREEN**

Run: `python -m unittest tests.test_openshop_art_font_patch -v`

Run: `node tools/tests/openshop-ai-image-normalization.test.mjs`

Expected: both pass, including legacy image-normalization coverage that remains used by other tools.

### Task 4: Local-redraw prompt and backend task protocol

**Files:**
- Modify: `openshop_ai.py`
- Modify: `main.py`
- Modify: `tests/test_openshop_ocr_layout.py`
- Modify: `tests/test_qzz_art_font_reference.py`
- Modify: `tools/tests/openshop-ai-api.test.mjs`
- Modify: `tools/tests/qzz-image-provider-routing.test.mjs`

- [ ] **Step 1: Write failing prompt and API tests**

Assert the prompt says to replace only the mask region with `currentText`, match the original style and position, preserve outside pixels, and never restore `originalText`. Assert image generation receives references with roles `source` then `mask`, receives the patch dimensions, and returns `placementBox` instead of `contentBox`.

- [ ] **Step 2: Run focused backend tests and verify RED**

Run: `python -m unittest tests.test_openshop_ocr_layout tests.test_qzz_art_font_reference -v`

Run: `node tools/tests/openshop-ai-api.test.mjs`

Expected: failures showing the existing isolated-glyph reference and `contentBox` response.

- [ ] **Step 3: Switch the art-font task to patch editing**

In `run_openshop_ai_task`, call `prepare_art_font_edit`, provide the source patch and mask as image references, request exact patch dimensions at high quality, materialize the model output, then call `normalize_art_font_patch_output`. Store the opaque PNG and return:

```python
result = {
    "assetId": art_asset["assetId"],
    "url": art_asset["url"],
    "name": art_asset["name"],
    "mime": "image/png",
    "width": geometry["width"],
    "height": geometry["height"],
    "placementBox": geometry["placementBox"],
}
```

Do not call `prepare_art_font_reference`, `_art_font_quad_aspect`, or `normalize_art_font_output` for this tool.

- [ ] **Step 4: Run focused backend tests and verify GREEN**

Run the commands from Step 2 plus `node tools/tests/qzz-image-provider-routing.test.mjs`.

Expected: all focused backend and provider-routing tests pass.

### Task 5: Place native-size redraw patches in OpenShop

**Files:**
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`
- Modify: `integrations/openshop/host/openshop-project-adapter.js` only if the existing generic image serialization omits `placementBox` metadata

- [ ] **Step 1: Write failing reconciliation tests**

Change art result fixtures to `placementBox`. Assert the output image is placed at the exact box with `angle=0`, `scaleX=1`, and `scaleY=1`; the editable carrier becomes hidden only after successful insertion; failure restores visibility and removes partial output.

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm.cmd test -- hstar-text-tools.test.js`

Expected: failure because `validatedArtResult` requires `contentBox` and reconciliation rescales the image to the OCR quad.

- [ ] **Step 3: Implement placementBox validation and placement**

Require integer in-document `placementBox`, require PNG dimensions to equal its width and height, create the image with native placement, and store `placementBox` in `hstarAiGeneration` metadata.

```js
image.set({
  left:result.placementBox.x,
  top:result.placementBox.y,
  originX:'left',
  originY:'top',
  angle:0,
  scaleX:1,
  scaleY:1,
});
```

- [ ] **Step 4: Run focused frontend tests and verify GREEN**

Run: `npm.cmd test -- hstar-text-tools.test.js hstar-project-adapter.test.js`

Expected: all focused tests pass.

### Task 6: Build, full regression, live validation, and service refresh

**Files:**
- Modify: `main.py`
- Modify: `integrations/openshop/index.html`
- Modify: `static/canvas.html`
- Modify: `static/index.html`
- Modify: `static/js/openshop-host.js`
- Modify: `static/smart-canvas.html`
- Generated: `static/openshop/**`

- [ ] **Step 1: Run complete automated verification**

Run: `python -m unittest discover -s tests -v`

Run: `npm.cmd test -- --reporter=dot` from `integrations/openshop`.

Run: `node tools/tests/openshop-ai-image-normalization.test.mjs`

Run: `node tools/tests/qzz-image-provider-routing.test.mjs`

Expected: zero failures.

- [ ] **Step 2: Perform one real configured image-model validation**

Use a temporary source fixture outside all canvas/project directories, submit an original-text to edited-text local redraw, verify source+mask routing, inspect the resulting patch, and compare all protected pixels against the source patch. Do not create or delete HstarA canvases.

- [ ] **Step 3: Bump the unified OpenShop runtime revision and build**

Update every OpenShop entry asset to one new revision, then run `npm.cmd run build:hstar` from `integrations/openshop`.

- [ ] **Step 4: Restart only the Python process listening on port 3000**

Preserve `HSTAR_DATA_DIR=E:\Hstar缓存`, start the worktree's `main.py`, and verify the root, host asset, and OpenShop editor return HTTP 200 with the new revision.

- [ ] **Step 5: Re-run smoke tests after build and report evidence**

Run the focused OCR/art tests again after the build. Report test counts, real-provider outcome, runtime revision, service PID, and `http://127.0.0.1:3000/`.
