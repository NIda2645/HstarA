# OpenShop Default Font Fallback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:executing-plans` to implement this plan task-by-task in the current task. Do not dispatch subagents unless the user explicitly grants permission.

**Goal:** Make new horizontal, vertical, and OCR-created OpenShop text prefer the approved Chinese and Latin fonts, while remaining fully usable when those fonts are not installed and preserving explicit user font choices.

**Architecture:** Keep installed-font knowledge and script-aware fallback resolution in `openshop-font-catalog.js`. Mark only newly created manual text with a serialized automatic-font policy; let the text-properties controller apply per-character Fabric font styles as text changes and permanently disable that policy when a user selects a font. OCR keeps reliable matched faces and delegates only missing-face fallback to the same resolver.

**Tech Stack:** Vanilla JavaScript, Fabric.js 5.3.1, Vitest/jsdom, existing OpenShop source-to-static build, Node test runner.

---

## File Structure

- Modify `integrations/openshop/host/openshop-font-catalog.js`: classify CJK/Latin/neutral text runs; resolve preferred, installed suitable, and generic faces; reuse resolution for OCR fallback.
- Modify `integrations/openshop/host/openshop-text-properties.js`: apply automatic run styles to marked text and disable the policy on explicit font selection.
- Modify `integrations/openshop/index.html`: mark new manual text, track whether the creation font is automatic, and serialize the marker.
- Modify `integrations/openshop/tests/hstar-font-catalog.test.js`: cover preferred, installed-system, generic, mixed-run, and OCR fallback behavior.
- Modify `integrations/openshop/tests/hstar-text-properties.test.js`: cover automatic styles and explicit user override.
- Modify `integrations/openshop/tests/os-unit.test.js`: cover horizontal/vertical creation and marker serialization.
- Modify `integrations/openshop/tests/hstar-host-runtime.test.js`: lock the custom-property persistence contract.
- Regenerate `static/openshop/**` with the existing build script, then synchronize static cache versions through the existing application helper.

### Task 1: Script-Aware Font Resolution

**Files:**
- Modify: `integrations/openshop/tests/hstar-font-catalog.test.js`
- Modify: `integrations/openshop/host/openshop-font-catalog.js`

- [ ] **Step 1: Write failing preferred and fallback tests**

Add tests that require the manager API below:

```js
expect(manager.resolveDefaultFace('zh-hans')).toMatchObject({
  family:'阿里巴巴普惠体 3.0',
  faceFamily:'阿里巴巴普惠体 3.0',
});
expect(manager.resolveDefaultFace('en')).toMatchObject({
  family:'03免 阿里妈妈灵动体VF',
  faceFamily:'03免 阿里妈妈灵动体VF',
});
expect(manager.defaultTextRuns('夏日 Open 2026！').map(run => run.script))
  .toEqual(['zh-hans', 'en', 'zh-hans']);
```

Add catalogs without the preferred families and assert that Chinese selects an installed Chinese common face, English selects an installed Latin common face, and an empty/failed catalog returns a non-throwing `system-ui` face. Replace the two old assertions that expected `未安装必需的回退字体` with generic fallback assertions.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
Set-Location integrations/openshop
npm test -- --run tests/hstar-font-catalog.test.js
```

Expected: FAIL because `resolveDefaultFace()` and `defaultTextRuns()` do not exist and missing preferred fonts still throw.

- [ ] **Step 3: Implement the minimal central resolver**

Add these public contracts to the font manager:

```js
resolveDefaultFace(script, {weight = 400, italic = false} = {})
defaultTextRuns(text, {weight = 400, italic = false} = {})
```

`resolveDefaultFace` must use this order:

```text
exact preferred family -> installed common family for the script
-> installed catalog family for the script -> system-ui
```

Every returned face must contain `family`, `faceFamily`, `styleId`, `weight`, `italic`, and `fallback`. `defaultTextRuns` must classify CJK as `zh-hans`, Latin letters/numbers as `en`, and assign neutral punctuation/whitespace to the nearest meaningful script, using Chinese when no meaningful character exists. Adjacent equal-script faces are merged into `{start, end, script, ...face}` runs measured in Unicode code points.

Refactor `matchOcrProfile`, `matchOcrRun`, and `matchOcrFont` so a reliable category match remains unchanged, while an absent requested/preferred face returns `resolveDefaultFace(...)` instead of throwing.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run the Task 1 command again.

Expected: all font-catalog tests pass, including empty-catalog and failed-load generic fallback.

- [ ] **Step 5: Commit the resolver**

```powershell
git add integrations/openshop/host/openshop-font-catalog.js integrations/openshop/tests/hstar-font-catalog.test.js
git commit -m "feat: add resilient OpenShop default font resolver"
```

### Task 2: Automatic Manual Text Styling and User Override

**Files:**
- Modify: `integrations/openshop/tests/hstar-text-properties.test.js`
- Modify: `integrations/openshop/host/openshop-text-properties.js`

- [ ] **Step 1: Write failing controller tests**

Extend the harness font manager with `defaultTextRuns`. Add tests for a marked horizontal object and a marked vertical object:

```js
textObject.hstarAutomaticFontPolicy = 'script-default';
textObject.text = '中文 Open';
canvas.fire('text:changed', {target:textObject});
expect(textObject.styles[0][0].fontFamily).toBe('阿里巴巴普惠体 3.0');
expect(textObject.styles[0][3].fontFamily).toBe('03免 阿里妈妈灵动体VF');
```

Assert that existing `fill`, `fontSize`, and other non-font character styles survive. Then call `controller.applyProperty('fontFamily', 'Century Gothic')` and assert:

```js
expect(textObject.hstarAutomaticFontPolicy).toBeUndefined();
```

After another `text:changed`, the manually selected family must remain unchanged.

- [ ] **Step 2: Run the controller test and verify RED**

Run:

```powershell
Set-Location integrations/openshop
npm test -- --run tests/hstar-text-properties.test.js
```

Expected: FAIL because marked objects are not styled and explicit font selection does not clear the policy.

- [ ] **Step 3: Implement automatic styling**

Add controller-private helpers equivalent to:

```js
function applyAutomaticFontPolicy(target) {
  if(target?.hstarAutomaticFontPolicy !== 'script-default') return false;
  const runs = fontManager.defaultTextRuns(String(target.text || ''), {
    weight:target.fontWeight,
    italic:target.fontStyle === 'italic',
  });
  // Merge only fontFamily/fontWeight/fontStyle into each Fabric character style.
  // Horizontal lines and vertical columns both use outer-index/inner-index maps.
}

function disableAutomaticFontPolicy(target) {
  if(target?.hstarAutomaticFontPolicy !== 'script-default') return false;
  delete target.hstarAutomaticFontPolicy;
  return true;
}
```

Apply the policy on controller startup after font loading, on editing entry, and after caret styles in `text:changed`. Disable it before any explicit `fontFamily` application or font-style selection. When a font is selected with no active object, set `editor.state.textFontAutomatic = false` so future text uses the chosen creation font.

- [ ] **Step 4: Run the controller test and verify GREEN**

Run the Task 2 command again.

Expected: all text-properties tests pass; mixed styles update without erasing color/size styles; manual choices persist.

- [ ] **Step 5: Commit the controller behavior**

```powershell
git add integrations/openshop/host/openshop-text-properties.js integrations/openshop/tests/hstar-text-properties.test.js
git commit -m "feat: apply automatic script fonts to OpenShop text"
```

### Task 3: New Text Marking and Persistence

**Files:**
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/tests/hstar-host-runtime.test.js`
- Modify: `integrations/openshop/index.html`

- [ ] **Step 1: Write failing creation and serialization tests**

Extend the existing horizontal/vertical creation test to expect both new objects to have:

```js
{hstarAutomaticFontPolicy:'script-default'}
```

Assert `_fabricCustomProperties` contains `hstarAutomaticFontPolicy`, and that setting `OS.state.textFontAutomatic = false` before creation omits the marker and keeps `OS.state.textFont`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run:

```powershell
Set-Location integrations/openshop
npm test -- --run tests/os-unit.test.js tests/hstar-host-runtime.test.js
```

Expected: FAIL because new objects have no marker and the marker is absent from serialization.

- [ ] **Step 3: Mark only automatic new text**

Add `textFontAutomatic:true` to the default editor state. Create new text with `system-ui` as the safe initial base only while automatic mode is active, include `hstarAutomaticFontPolicy:'script-default'`, and call the text-properties controller's automatic-policy method after adding the object. If `textFontAutomatic` is false, keep the user-selected `textFont` and omit the marker. Add `hstarAutomaticFontPolicy` exactly once to `_fabricCustomProperties`.

- [ ] **Step 4: Run the focused tests and verify GREEN**

Run the Task 3 command again.

Expected: horizontal and vertical text share the marker contract; explicit creation fonts are preserved; custom-property tests pass.

- [ ] **Step 5: Commit creation and persistence**

```powershell
git add integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js integrations/openshop/tests/hstar-host-runtime.test.js
git commit -m "feat: persist OpenShop automatic font policy"
```

### Task 4: OCR Regression Coverage

**Files:**
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Add missing-preferred-font OCR coverage**

Use a real font manager loaded with an empty catalog, or a manager stub returning the generic resolver shape, and confirm OCR creates an editable layer whose `fontFamily` and per-character style are `system-ui`. Keep assertions for position, angle, size, writing mode, fill, stroke, shadow, and source metadata unchanged. Also assert a reliable installed OCR match remains its matched face and does not gain `hstarAutomaticFontPolicy`.

- [ ] **Step 2: Run OCR and layout tests**

Run:

```powershell
Set-Location integrations/openshop
npm test -- --run tests/hstar-text-tools.test.js tests/hstar-ocr-layout.test.js tests/hstar-writing-mode.test.js
```

Expected: PASS; font absence no longer prevents OCR conversion and geometry/writing-mode behavior is unchanged.

- [ ] **Step 3: Commit OCR regression coverage**

```powershell
git add integrations/openshop/tests/hstar-text-tools.test.js
git commit -m "test: cover OpenShop OCR generic font fallback"
```

### Task 5: Publish Runtime and Verify

**Files:**
- Modify: generated `static/openshop/index.html`
- Modify: generated `static/openshop/host/openshop-font-catalog.js`
- Modify: generated `static/openshop/host/openshop-text-properties.js`
- Modify: cache-version references generated by the existing static version synchronizer

- [ ] **Step 1: Run all OpenShop unit tests**

```powershell
Set-Location integrations/openshop
npm test
```

Expected: all Vitest suites pass.

- [ ] **Step 2: Build the approved OpenShop static runtime**

```powershell
Set-Location integrations/openshop
npm run build:hstar
```

Expected: the command lists approved runtime files and prints `OPENSHOP_BUILD_SHA256=...`; static copies match integration sources.

- [ ] **Step 3: Synchronize cache versions using the repository helper**

Run the same `sync_static_html_versions()` path used by HstarA startup, then run it a second time.

Expected: the second run produces no additional cache-key changes.

- [ ] **Step 4: Run root integration and cache checks**

```powershell
node --test tools/tests/openshop-foundation-build.test.mjs tools/tests/openshop-localization-build.test.mjs tools/tests/static-cache-integrity.test.mjs tools/tests/text-encoding-health.test.mjs
```

Expected: all selected root tests pass and source/runtime UTF-8 text remains valid.

- [ ] **Step 5: Verify in the browser on port 3000**

In an OpenShop node, create horizontal and vertical text containing `中文 Open 2026`, confirm per-script fonts and punctuation inheritance, then choose another font and type more text to prove the explicit choice persists. Exercise OCR conversion with installed preferred fonts unavailable or simulated unavailable; confirm the layer remains editable and aligned.

Expected: no global error banner, no missing-font crash, correct mixed-script faces, and unchanged OCR geometry.

- [ ] **Step 6: Inspect and commit only related publication changes**

```powershell
git diff --check
git status --short
git add static/openshop integrations/openshop static/index.html static/canvas.html static/smart-canvas.html main.py
git diff --cached --name-only
git commit -m "feat: publish OpenShop default font fallback"
```

Expected: the staged set contains only OpenShop source/tests/runtime and cache-version references changed by synchronization. Do not stage or alter existing canvas-list, GPT chat, API settings, or software settings work.
