# OpenShop Text And Color Interactions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace font search with a read-only scrolling dropdown, make `NumpadEnter` confirm text editing, and add Photoshop-style `Alt+Delete`/`Ctrl+Delete` pixel fills.

**Architecture:** Keep font UI behavior in `openshop-text-properties.js`, keyboard normalization in `openshop-desktop-input.js`, and editor mutations in the OpenShop core. Add a small pure pixel-fill helper so color parsing and image-data mutation are independently testable while the core supplies Fabric transforms and selection predicates.

**Tech Stack:** Browser JavaScript, Fabric.js 5.3.1, Vitest/jsdom, Playwright, HstarA static build script.

---

### Task 1: Read-only font dropdown

**Files:**
- Modify: `integrations/openshop/host/openshop-text-properties.js`
- Modify: `integrations/openshop/host/openshop-text-properties.css`
- Test: `integrations/openshop/tests/hstar-text-properties.test.js`
- Test: `integrations/openshop/tests/hstar-text-properties.e2e.spec.js`

- [ ] **Step 1: Write failing unit tests**

Add a font manager fixture with more than 80 families and assert:

```js
const trigger = document.querySelector('[data-text-family]');
expect(trigger.tagName).toBe('BUTTON');
expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
trigger.click();
expect(document.querySelectorAll('[data-text-font-list] [data-family]')).toHaveLength(96);
expect(document.querySelector('[data-family="Microsoft YaHei UI"]').getAttribute('aria-selected')).toBe('true');
document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
expect(document.querySelector('[data-text-font-list]').hidden).toBe(true);
```

Also dispatch `Escape`, select a different option, and assert the selected family is applied once.

- [ ] **Step 2: Run the focused unit test and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-text-properties.test.js
```

Expected: FAIL because `[data-text-family]` is still a text input and the list is capped at 80 searchable items.

- [ ] **Step 3: Implement the read-only trigger and list behavior**

Replace the input markup with:

```html
<button type="button" class="hstar-font-select" data-text-family
  aria-haspopup="listbox" aria-expanded="false">
  <span data-text-family-label></span><span aria-hidden="true">▾</span>
</button>
<div class="hstar-font-list" data-text-font-list role="listbox" hidden></div>
```

Add `syncFamilyControl(value)`, `closeFontList()`, `renderFontList()`, and `toggleFontList()` helpers. Render `fontManager.searchFonts('')` without slicing, mark the active item with `aria-selected="true"`, call `scrollIntoView({block:'nearest'})` after opening, toggle on trigger click, close on external `mousedown` and `Escape`, and apply/close on option click. Remove the `focus`, `input`, and `Enter` search handlers.

- [ ] **Step 4: Update styles**

Style `.hstar-font-select` as a two-column button with a stable 25px height, ellipsis on the family label, and the same focus treatment as other controls. Keep `.hstar-font-list` bounded by `max-height:190px; overflow:auto` so wheel and touchpad scrolling work without resizing the panel.

- [ ] **Step 5: Update E2E interaction and verify GREEN**

Replace `familyInput.fill(...)` with trigger click, assert list scrolling (`scrollHeight > clientHeight`), select the target option, click outside to verify closure, and retain the existing desktop/mobile viewport assertions.

Run the focused unit test and E2E against the isolated service. Expected: all cases pass.

- [ ] **Step 6: Commit**

```powershell
git add integrations/openshop/host/openshop-text-properties.js integrations/openshop/host/openshop-text-properties.css integrations/openshop/tests/hstar-text-properties.test.js integrations/openshop/tests/hstar-text-properties.e2e.spec.js
git commit -m "feat: add OpenShop font dropdown"
```

### Task 2: Numeric keypad text confirmation

**Files:**
- Modify: `integrations/openshop/host/openshop-desktop-input.js`
- Modify: `integrations/openshop/index.html`
- Test: `integrations/openshop/tests/hstar-desktop-input.test.js`
- Test: `integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js`

- [ ] **Step 1: Write failing shortcut tests**

Add assertions for a dedicated editing resolver:

```js
expect(desktop.resolveEditingShortcut(
  new KeyboardEvent('keydown', {key:'Enter', code:'NumpadEnter'}),
  {isEditing:true},
)).toEqual({command:'commit-text-editing'});
expect(desktop.resolveEditingShortcut(
  new KeyboardEvent('keydown', {key:'Enter', code:'Enter'}),
  {isEditing:true},
)).toBeNull();
```

Verify non-editing objects and input/select targets do not resolve.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-desktop-input.test.js
```

Expected: FAIL because `resolveEditingShortcut` does not exist.

- [ ] **Step 3: Implement editing shortcut resolution**

Export:

```js
function resolveEditingShortcut(event, activeObject){
  if(event?.type !== 'keydown' || !activeObject?.isEditing) return null;
  return event.code === 'NumpadEnter' ? {command:'commit-text-editing'} : null;
}
```

In `_initKeyboardShortcuts()`, resolve this command before the general editable-target guard. Map it to `_commitTextEditing()`, which calls `exitEditing()`, requests a render, saves exactly one `Edit Text` history entry, and keeps the text object selected. Ordinary `Enter` continues to Fabric unchanged.

- [ ] **Step 4: Add E2E coverage and verify GREEN**

Create/edit an `IText`, press `NumpadEnter`, assert `isEditing === false`, active object identity is preserved, and history increases by one. Re-enter editing, press ordinary `Enter`, and assert a newline is inserted while editing remains active.

- [ ] **Step 5: Commit**

```powershell
git add integrations/openshop/host/openshop-desktop-input.js integrations/openshop/index.html integrations/openshop/tests/hstar-desktop-input.test.js integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js
git commit -m "feat: confirm OpenShop text with numpad enter"
```

### Task 3: Foreground and background pixel fill shortcuts

**Files:**
- Create: `integrations/openshop/host/openshop-pixel-fill.js`
- Modify: `integrations/openshop/host/openshop-desktop-input.js`
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Create: `integrations/openshop/tests/hstar-pixel-fill.test.js`
- Test: `integrations/openshop/tests/hstar-desktop-input.test.js`
- Test: `integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js`

- [ ] **Step 1: Write failing pure pixel tests**

Define the desired API:

```js
const imageData = new ImageData(3, 2);
const count = window.HstarOpenShopPixelFill.fillImageData(
  imageData,
  '#12ab34',
  (x, y) => x === 1 && y === 0,
);
expect(count).toBe(1);
expect([...imageData.data.slice(4, 8)]).toEqual([0x12, 0xab, 0x34, 255]);
```

Cover full-image fill, predicate-limited fill, invalid color rejection, and alpha becoming 255.

- [ ] **Step 2: Write failing shortcut tests**

Assert `Alt+Delete` resolves to `fill-foreground`, `Ctrl+Delete` resolves to `fill-background`, plain `Delete` remains `delete-context`, and neither color command resolves from editable form/text contexts.

- [ ] **Step 3: Run focused tests and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-pixel-fill.test.js tests/hstar-desktop-input.test.js
```

Expected: FAIL because the helper and commands do not exist.

- [ ] **Step 4: Implement the pure helper**

Create a browser module exposing:

```js
function fillImageData(imageData, color, includesPixel = () => true){
  const rgba = parseHexColor(color);
  let count = 0;
  for(let y = 0; y < imageData.height; y++) for(let x = 0; x < imageData.width; x++){
    if(!includesPixel(x, y)) continue;
    const offset = (y * imageData.width + x) * 4;
    imageData.data.set(rgba, offset);
    count += 1;
  }
  return count;
}
```

Support only validated `#RRGGBB` input and expose an immutable `HstarOpenShopPixelFill` API.

- [ ] **Step 5: Implement editor pixel targeting**

Load the helper before the OpenShop core. Add `fill-foreground` and `fill-background` command descriptors and handlers. Implement `_fillActiveImage(color, historyName)` to:

1. Resolve only an image in `layers[activeLayerIdx]`, preferring the active image and otherwise the topmost image in that same layer.
2. Draw the intrinsic image into an offscreen canvas.
3. Build an `includesPixel(x, y)` predicate by transforming each image pixel center through `target.calcTransformMatrix()` and the Fabric viewport.
4. For `_selectionMask`, sample the screen-space mask; for `_selectionBounds`, test transformed canvas coordinates against `_selToCanvasCoords()`; with no selection, include every pixel.
5. Call `fillImageData`, write the pixels back, and use `_replaceActiveImage()` with `Fill Foreground` or `Fill Background` so exactly one history/project-dirty event is produced.
6. Leave all other layers unchanged and show the existing “请选择图像” message when the active layer has no image.

- [ ] **Step 6: Add E2E pixel assertions and verify GREEN**

Use a deterministic 4x4 image and assert exact RGBA output for:

- full active image foreground fill;
- rectangular-selection background fill;
- sparse pixel-mask foreground fill;
- unchanged non-active image layer;
- no fill while a text object or form control is editing;
- ordinary `Delete` still deletes by context.

Run focused unit and desktop E2E suites. Expected: all cases pass.

- [ ] **Step 7: Commit**

```powershell
git add integrations/openshop/host/openshop-pixel-fill.js integrations/openshop/host/openshop-desktop-input.js integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/tests/hstar-pixel-fill.test.js integrations/openshop/tests/hstar-desktop-input.test.js integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js
git commit -m "feat: add OpenShop color fill shortcuts"
```

### Task 4: Static build, regression, and engineering restart

**Files:**
- Regenerate: `static/openshop/**`

- [ ] **Step 1: Build the Hstar static runtime**

```powershell
npm.cmd --prefix integrations\openshop run build:hstar
```

Verify source and built host files have matching SHA-256 hashes.

- [ ] **Step 2: Run fresh verification**

```powershell
npm.cmd --prefix integrations\openshop test
npm.cmd --prefix integrations\openshop run audit:i18n
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'
npm.cmd --prefix integrations\openshop run test:hstar:text-properties
npm.cmd --prefix integrations\openshop run test:hstar:desktop
```

Expected: all unit, i18n, font dropdown, text confirmation, and pixel-fill checks pass.

- [ ] **Step 3: Inspect and commit generated files**

Stage only changed `static/openshop` files, run `git diff --cached --check`, and commit:

```powershell
git commit -m "build: refresh OpenShop text interactions"
```

- [ ] **Step 4: Clean isolated test data and restart engineering service**

Stop only the isolated test process, delete only its worktree-local temporary root, and restart port `3000` from the current worktree. Verify `/api/software-settings` still reports `E:\Hstar缓存`, `/static/openshop/index.html` returns 200, and the font dropdown plus keyboard shortcuts work in the running engineering build.
