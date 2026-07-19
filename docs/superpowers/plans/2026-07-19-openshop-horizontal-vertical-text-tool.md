# OpenShop Horizontal and Vertical Text Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Photoshop-style two-item text-tool flyout and real editable horizontal/vertical text modes, including OCR direction, persistence, and export behavior.

**Architecture:** Add a focused writing-mode runtime that owns mode normalization, vertical glyph layout, a serializable Fabric vertical-text class, and its DOM editing surface. Keep OpenShop's existing tool-group, layer, history, font, and text-properties systems, but route them through one `hstarWritingMode` value. OCR reports/infer direction separately from rotation and creates the matching text object.

**Tech Stack:** Vanilla JavaScript, Fabric.js 5.3.1, HTML/CSS, Vitest/jsdom, Playwright Chromium, Python/pytest.

---

## File Map

- Create `integrations/openshop/host/openshop-writing-mode.js`: writing-mode constants, vertical layout, Fabric class registration, object creation/conversion, and vertical editing surface.
- Create `integrations/openshop/host/openshop-writing-mode.css`: vertical editing surface and text-tool flyout row styling.
- Create `integrations/openshop/tests/hstar-writing-mode.test.js`: unit coverage for raw content, layout, conversion, and serialization.
- Modify `integrations/openshop/index.html`: two-option text group, tool state, creation/edit routing, custom serialization field, and runtime loading.
- Modify `integrations/openshop/host/openshop-desktop-input.js`: register horizontal/vertical modes under `T` while retaining the last selected mode for plain `T`.
- Modify `integrations/openshop/host/openshop-text-properties.js`: recognize vertical text and synchronize the selected object's writing mode.
- Modify `integrations/openshop/host/openshop-text-tools.js`: create OCR layers with the normalized writing mode.
- Modify `integrations/openshop/locales/zh-CN.js`: exact Simplified Chinese text-tool labels.
- Modify `openshop_ai.py`: prompt, normalization, and inference for `writingMode` independent of rotation.
- Modify `integrations/openshop/tests/os-harness.js`: load/mock the writing-mode runtime and expose both text tools in the editor fixture.
- Modify `integrations/openshop/tests/os-unit.test.js`: tool menu, creation, layer, selection, history, and serialization behavior.
- Modify `integrations/openshop/tests/hstar-desktop-input.test.js`: `T` shortcut behavior.
- Modify `integrations/openshop/tests/hstar-text-properties.test.js`: selected vertical object synchronization.
- Modify `integrations/openshop/tests/hstar-text-tools.test.js`: OCR direction-to-object mapping.
- Modify `tests/test_openshop_ocr_layout.py`: backend writing-mode normalization and inference.
- Modify `integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js`: real flyout/vertical editing/viewport checks.
- Modify `integrations/openshop/scripts/build-hstar.mjs`: include the new runtime files.
- Build output only: `static/openshop/**` via `npm run build:hstar`.

### Task 1: Vertical Writing Runtime

**Files:**
- Create: `integrations/openshop/host/openshop-writing-mode.js`
- Create: `integrations/openshop/host/openshop-writing-mode.css`
- Create: `integrations/openshop/tests/hstar-writing-mode.test.js`

- [ ] **Step 1: Write failing tests for mode normalization and vertical layout**

```js
expect(runtime.normalizeWritingMode('vertical')).toBe('vertical');
expect(runtime.normalizeWritingMode('unknown')).toBe('horizontal');
expect(runtime.layoutVerticalText('甲乙\nAB')).toMatchObject({
  columns:[['甲', '乙'], ['A', 'B']],
  writingMode:'vertical',
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `npm test -- --run tests/hstar-writing-mode.test.js`

Expected: FAIL because `openshop-writing-mode.js` does not exist.

- [ ] **Step 3: Add the minimal public runtime**

Expose one stable API:

```js
window.HstarOpenShopWritingMode = {
  HORIZONTAL:'horizontal',
  VERTICAL:'vertical',
  normalizeWritingMode,
  layoutVerticalText,
  registerFabricClass,
  createTextObject,
  convertTextObject,
  writingModeFor,
  destroy,
};
```

`layoutVerticalText` keeps raw text unchanged, splits only explicit line breaks
into columns, and returns glyph coordinates from top to bottom with columns ordered
right to left. Do not rotate the entire text object and do not insert synthetic
line breaks into stored content.

- [ ] **Step 4: Add failing Fabric object tests**

```js
const object = runtime.createTextObject(fabric, '甲乙', {
  hstarWritingMode:'vertical', fontSize:40, fontFamily:'Microsoft YaHei',
});
expect(object.text).toBe('甲乙');
expect(object.hstarWritingMode).toBe('vertical');
expect(object.toObject(['hstarWritingMode'])).toMatchObject({
  text:'甲乙', hstarWritingMode:'vertical', type:'hstar-vertical-text',
});
```

- [ ] **Step 5: Implement the serializable vertical Fabric class and editor**

Register `fabric.HstarVerticalText` once. The class stores raw `text`, measures
glyph advances, draws each glyph independently, exposes Fabric bounds/controls,
and serializes as `hstar-vertical-text`. `fromObject` reconstructs the class.
`enterEditing()` opens one positioned `<textarea>` using `writing-mode:vertical-rl`;
input updates raw text and layout in real time, and exit restores canvas focus.

- [ ] **Step 6: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/hstar-writing-mode.test.js`

Expected: PASS with raw content, layout, conversion, and round-trip tests green.

- [ ] **Step 7: Commit**

```bash
git add integrations/openshop/host/openshop-writing-mode.js integrations/openshop/host/openshop-writing-mode.css integrations/openshop/tests/hstar-writing-mode.test.js
git commit -m "feat(openshop): add vertical writing runtime"
```

### Task 2: Two-Item Text Tool Group

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Modify: `integrations/openshop/host/openshop-desktop-input.js`
- Modify: `integrations/openshop/tests/os-harness.js`
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/tests/hstar-desktop-input.test.js`

- [ ] **Step 1: Write failing DOM and shortcut tests**

```js
expect([...document.querySelectorAll('[data-group="text"] .tool-flyout [data-tool]')]
  .map(button => button.dataset.tool)).toEqual(['text-horizontal', 'text-vertical']);
expect(document.querySelector('[data-group="text"] .tool-flyout').textContent)
  .not.toContain('蒙版');
expect(desktop.toolCycleForKey('t')).toEqual(['text-horizontal', 'text-vertical']);
```

Also assert outside `mousedown` closes the menu, selected row is active, the face
copies the selected orientation icon/label, and plain `T` keeps the current text
orientation while `Shift+T` cycles.

Assert the artistic-font layer action remains Simplified Chinese in every state:
`艺术字体处理`, `没有原图参考`, and `艺术字体处理中`.

- [ ] **Step 2: Run the focused tests and verify RED**

Run: `npm test -- --run tests/os-unit.test.js tests/hstar-desktop-input.test.js`

Expected: FAIL because only the standalone `text` tool exists.

- [ ] **Step 3: Replace the text button with a two-row tool group**

Use `data-group="text"`, a horizontal face button, and exactly two flyout buttons:

```html
<button class="tool-btn text-tool-row" data-tool="text-horizontal"
  data-tip="Horizontal Type Tool" data-i18n-tip="Horizontal Type Tool">
  <span class="text-tool-icon" aria-hidden="true">T</span>
  <span class="text-tool-label">横排文字工具</span>
  <span class="text-tool-shortcut" aria-hidden="true">T</span>
</button>
<button class="tool-btn text-tool-row" data-tool="text-vertical"
  data-tip="Vertical Type Tool" data-i18n-tip="Vertical Type Tool">
  <span class="text-tool-icon text-tool-icon-vertical" aria-hidden="true">T</span>
  <span class="text-tool-label">直排文字工具</span>
  <span class="text-tool-shortcut" aria-hidden="true">T</span>
</button>
```

Give flyout rows visible Simplified Chinese labels and a trailing `T` shortcut.
Extend `flyoutSelect()` to update the selected row's active state and copy only
the icon into the compact face, rather than copying the entire text row.
Keep the artistic-font layer action's tooltip and running/missing-reference state
labels in Simplified Chinese; do not replace them with English text.

- [ ] **Step 4: Add canonical state and aliases**

Add `state.textWritingMode:'horizontal'`. Normalize legacy `setTool('text')` to
`text-horizontal`, and treat both new IDs as the text interaction profile and
`opt-text` tools. `T` resolves to the last selected text mode; `Shift+T` cycles.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run: `npm test -- --run tests/os-unit.test.js tests/hstar-desktop-input.test.js`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/host/openshop-desktop-input.js integrations/openshop/tests/os-harness.js integrations/openshop/tests/os-unit.test.js integrations/openshop/tests/hstar-desktop-input.test.js
git commit -m "feat(openshop): add horizontal and vertical text tools"
```

### Task 3: Creation, Editing, Properties, and History

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/host/openshop-text-properties.js`
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/tests/hstar-text-properties.test.js`

- [ ] **Step 1: Write failing creation and synchronization tests**

Prove horizontal mode creates `fabric.IText`, vertical mode creates
`fabric.HstarVerticalText`, each object gets its own layer, clicking an existing
text object enters editing instead of creating another layer, and selecting a
vertical object changes `state.textWritingMode` plus the active text-tool face.

- [ ] **Step 2: Run tests and verify RED**

Run: `npm test -- --run tests/os-unit.test.js tests/hstar-text-properties.test.js`

Expected: FAIL because pointer creation always constructs `fabric.IText`.

- [ ] **Step 3: Route all text creation through the writing-mode runtime**

```js
const text = window.HstarOpenShopWritingMode.createTextObject(fabric, 'Type here', {
  ...textStyle,
  hstarWritingMode:this.state.textWritingMode,
});
```

Keep `_createObjectLayer(text, text.text)`, active-object selection, editing entry,
history, and layer-panel updates unchanged. Extend `_isEditableTextObject` and the
properties controller's text-type predicate to include `hstar-vertical-text`.

- [ ] **Step 4: Persist and convert the writing mode**

Add `hstarWritingMode` to `_fabricCustomProperties`. Add one controller setter that
converts a selected text object with `convertTextObject`, preserves all style and
OCR metadata, replaces it in the same layer and canvas stack position, and records
one history entry.

```js
setTextWritingMode(mode, {convertSelection = true, recordHistory = true} = {})
```

- [ ] **Step 5: Run tests and verify GREEN**

Run: `npm test -- --run tests/os-unit.test.js tests/hstar-text-properties.test.js`

Expected: PASS, including undo/redo round-trip assertions.

- [ ] **Step 6: Commit**

```bash
git add integrations/openshop/index.html integrations/openshop/host/openshop-text-properties.js integrations/openshop/tests/os-unit.test.js integrations/openshop/tests/hstar-text-properties.test.js
git commit -m "feat(openshop): integrate vertical text editing"
```

### Task 4: OCR Writing Direction

**Files:**
- Modify: `openshop_ai.py`
- Modify: `tests/test_openshop_ocr_layout.py`
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Write failing backend normalization tests**

```python
assert vertical_block["writingMode"] == "vertical"
assert rotated_horizontal["writingMode"] == "horizontal"
assert inferred_tall_block["writingMode"] == "vertical"
```

Cover explicit `horizontal`/`vertical`, invalid fallback, geometry inference, and
the requirement that `rotation:90` does not itself force vertical writing.

- [ ] **Step 2: Run pytest and verify RED**

Run: `pytest -q tests/test_openshop_ocr_layout.py`

Expected: FAIL because OCR schema version 2 has no `writingMode`.

- [ ] **Step 3: Extend prompt and normalization**

Require `writingMode` in the OCR prompt, normalize aliases to `horizontal` or
`vertical`, infer from block geometry only when missing, and return schema version
3. Keep rotation independently normalized.

```python
def _normalize_writing_mode(value: Any, quad: list[dict[str, float]]) -> str:
    normalized = str(value or "").strip().lower().replace("_", "-")
    if normalized in {"horizontal", "horizontal-tb"}:
        return "horizontal"
    if normalized in {"vertical", "vertical-rl", "vertical-lr"}:
        return "vertical"
    xs = [point["x"] for point in quad]
    ys = [point["y"] for point in quad]
    return "vertical" if (max(ys) - min(ys)) > (max(xs) - min(xs)) * 1.5 else "horizontal"
```

- [ ] **Step 4: Write failing client conversion tests**

Add horizontal and vertical OCR blocks and assert resulting objects keep the raw
text, correct `hstarWritingMode`, source quad, scale, angle, font face/weight,
color, tracking, line height, stroke, and shadow metadata.

- [ ] **Step 5: Implement mode-aware OCR creation**

Include `writingMode` in `ocrVisualProfile()` and call the writing-mode runtime
instead of directly constructing `fabric.IText`. Use vertical natural bounds when
fitting to the OCR quad; never derive mode from `angle` on the client.

- [ ] **Step 6: Run backend and client tests and verify GREEN**

Run: `pytest -q tests/test_openshop_ocr_layout.py`

Run: `npm test -- --run tests/hstar-text-tools.test.js`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add openshop_ai.py tests/test_openshop_ocr_layout.py integrations/openshop/host/openshop-text-tools.js integrations/openshop/tests/hstar-text-tools.test.js
git commit -m "feat(openshop): preserve OCR writing direction"
```

### Task 5: Build and Browser Verification

**Files:**
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js`
- Generated: `static/openshop/**`

- [ ] **Step 1: Write failing Chromium tests**

At desktop and compact editor viewports assert the flyout is visible and inside
the viewport, has exactly two Simplified Chinese rows, contains no mask row, and
closes on outside click. Create `甲乙`, verify two top-to-bottom glyphs in vertical
mode, edit it without creating a second layer, press Enter for a new right-to-left
column, switch to horizontal, and verify each new object owns one layer.

- [ ] **Step 2: Run Playwright and verify RED**

Run: `npm run test:hstar:desktop -- --grep "horizontal and vertical text"`

Expected: FAIL against the current built static resources.

- [ ] **Step 3: Add runtime files to the build manifest and build**

Add `host/openshop-writing-mode.js` and `host/openshop-writing-mode.css` to
`runtimeFiles`, load them before the editor core, bump the unified static revision,
then run `npm run build:hstar`.

- [ ] **Step 4: Run focused and full verification**

Run: `npm test -- --run tests/hstar-writing-mode.test.js tests/os-unit.test.js tests/hstar-desktop-input.test.js tests/hstar-text-properties.test.js tests/hstar-text-tools.test.js`

Run: `pytest -q tests/test_openshop_ocr_layout.py`

Run: `npm run test:hstar:desktop -- --grep "horizontal and vertical text"`

Run: `npm test`

Expected: all pass with no console errors.

- [ ] **Step 5: Restart the engineering service and inspect both viewports**

Restart only the engineering instance serving `http://127.0.0.1:3000/`. Use
Playwright screenshots and bounding-box assertions at `1440x1000` and `1024x720`.
Do not create or modify stable-installation canvases.

- [ ] **Step 6: Delete isolated test data**

Delete only test-owned canvas/project/node records and temporary screenshots
created by this plan. Verify no test-owned record remains in `E:\Hstar缓存`.

- [ ] **Step 7: Commit**

```bash
git add integrations/openshop/scripts/build-hstar.mjs integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js static/openshop
git commit -m "test(openshop): verify horizontal and vertical text tools"
```
