# OpenShop Desktop Layer Selection and Photoshop Shortcuts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add unclipped localized toolbar tooltips, Photoshop-style layer multi-selection and batch operations, and context-aware Photoshop 2023 keyboard shortcuts for OpenShop's existing desktop features.

**Architecture:** A focused `openshop-desktop-input.js` host module owns pure selection calculations, the shortcut registry, key normalization, and the body-level tooltip controller. The existing OpenShop `OS` object remains the owner of editor mutations and adapts those helpers to Fabric, layer panel rendering, history, and the Hstar project bridge. Selection is ephemeral per editor instance and never serialized.

**Tech Stack:** JavaScript, DOM APIs, Fabric.js 5.3.1, Vitest/jsdom, Playwright, existing OpenShop i18n runtime

---

## File Map

- Create `integrations/openshop/host/openshop-desktop-input.js`: shortcut registry, tool cycles, layer selection helpers, editable-target detection, and tooltip controller.
- Create `integrations/openshop/tests/hstar-desktop-input.test.js`: focused unit tests for the new helper module.
- Create `integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js`: browser verification for localized tooltips, multi-layer interaction, batch actions, and Delete context.
- Modify `integrations/openshop/index.html`: desktop input module loading, tooltip styles, layer selection state, batch layer mutations, drag behavior, shortcut dispatch, and accessibility output.
- Modify `integrations/openshop/locales/zh-CN.js`: base tool labels and batch-operation messages required by the new UI.
- Modify `integrations/openshop/tests/os-unit.test.js`: OS integration tests for selection, batch operations, and keyboard routing.
- Modify `integrations/openshop/tests/os-harness.js`: DOM fixtures for tooltip, layer focus, blend, opacity, and keyboard-context tests.
- Modify `integrations/openshop/tests/hstar-project-adapter.test.js`: prove ephemeral layer selection is excluded from project serialization.
- Modify `integrations/openshop/scripts/build-hstar.mjs`: include the new desktop input runtime in the approved static build.
- Modify `integrations/openshop/package.json`: add the focused desktop Playwright command.
- Generate `static/openshop/index.html`, `static/openshop/host/openshop-desktop-input.js`, and `static/openshop/locales/zh-CN.js` through `build:hstar`.

### Task 1: Desktop Input Module and Unclipped Localized Tooltips

**Files:**
- Create: `integrations/openshop/host/openshop-desktop-input.js`
- Create: `integrations/openshop/tests/hstar-desktop-input.test.js`
- Modify: `integrations/openshop/index.html:62-78`
- Modify: `integrations/openshop/index.html:881-969`
- Modify: `integrations/openshop/index.html:1452-1454`
- Modify: `integrations/openshop/index.html:1595-1610`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Modify: `integrations/openshop/scripts/build-hstar.mjs:42-64`

- [ ] **Step 1: Write failing tooltip and registry tests**

Create `hstar-desktop-input.test.js` that loads the browser module into jsdom and specifies the public API:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(testDir, '..', 'host', 'openshop-desktop-input.js');

function loadDesktopInput() {
  delete window.HstarOpenShopDesktopInput;
  new Function(readFileSync(modulePath, 'utf8'))();
  return window.HstarOpenShopDesktopInput;
}

describe('OpenShop desktop input foundation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="toolbar" style="overflow:auto">
        <button class="tool-btn" data-tool="marquee-rect" data-tip="矩形选框工具"></button>
      </div>`;
  });

  it('shows a body-level localized tooltip with the Photoshop shortcut', () => {
    const desktop = loadDesktopInput();
    const button = document.querySelector('.tool-btn');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({left:20, top:80, right:56, bottom:116, width:36, height:36});
    Object.defineProperty(window, 'innerHeight', {value:120, configurable:true});

    const controller = desktop.createToolTooltipController({root:document, delay:250});
    button.dispatchEvent(new PointerEvent('pointerenter', {bubbles:true}));
    vi.advanceTimersByTime(250);

    const tooltip = document.getElementById('tool-tooltip');
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip.textContent).toBe('矩形选框工具（M）');
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(Number.parseFloat(tooltip.style.top)).toBeLessThanOrEqual(112);
    controller.destroy();
  });

  it('defines Photoshop tool cycles from one registry', () => {
    const desktop = loadDesktopInput();
    expect(desktop.toolCycleForKey('b')).toEqual(['brush', 'pencil', 'spray']);
    expect(desktop.toolShortcut('line')).toBe('U');
    expect(desktop.toolShortcut('lasso')).toBe('L');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
cd integrations/openshop
npm.cmd test -- tests/hstar-desktop-input.test.js
```

Expected: FAIL because `host/openshop-desktop-input.js` does not exist.

- [ ] **Step 3: Implement the desktop module foundation**

Create an IIFE that exposes one immutable API. Define Photoshop tool cycles once:

```js
(() => {
  const TOOL_CYCLES = Object.freeze({
    v:['select'],
    m:['marquee-rect','marquee-ellipse'],
    l:['lasso'],
    w:['magic-wand','ai-segment'],
    c:['crop'],
    b:['brush','pencil','spray'],
    j:['healing'],
    s:['clone'],
    e:['eraser'],
    g:['gradient','fill','pattern'],
    o:['dodge','burn','sponge'],
    r:['smudge'],
    p:['pen'],
    t:['text'],
    u:['rect','circle','triangle','line','arrow','polygon','star'],
    i:['eyedropper','measure','note'],
    h:['pan'],
    z:['zoom'],
  });
  const TOOL_SHORTCUT = new Map(
    Object.entries(TOOL_CYCLES).flatMap(([key, tools]) => tools.map(tool => [tool, key.toUpperCase()]))
  );

  function toolCycleForKey(key) {
    return [...(TOOL_CYCLES[String(key || '').toLowerCase()] || [])];
  }
  function toolShortcut(tool) {
    return TOOL_SHORTCUT.get(String(tool || '')) || '';
  }
  function localizedToolTip(button) {
    const label = String(button?.dataset?.tip || '').trim();
    const shortcut = toolShortcut(button?.dataset?.tool);
    return shortcut ? `${label}（${shortcut}）` : label;
  }

  function createToolTooltipController({root=document, delay=250}={}) {
    const tooltip = root.createElement('div');
    tooltip.id = 'tool-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    root.body.appendChild(tooltip);
    let timer = 0;
    let current = null;
    const hide = () => { clearTimeout(timer); current = null; tooltip.classList.remove('visible'); };
    const show = button => {
      current = button;
      clearTimeout(timer);
      timer = setTimeout(() => {
        if (!current?.isConnected) return hide();
        const rect = current.getBoundingClientRect();
        const text = localizedToolTip(current);
        tooltip.textContent = text;
        current.setAttribute('aria-label', text);
        tooltip.style.left = `${rect.right + 10}px`;
        tooltip.style.top = `${Math.max(8, Math.min(window.innerHeight - 8, rect.top + rect.height / 2))}px`;
        tooltip.classList.add('visible');
      }, delay);
    };
    const enter = event => event.target.closest?.('.tool-btn[data-tip]') && show(event.target.closest('.tool-btn[data-tip]'));
    const leave = event => {
      const button = event.target.closest?.('.tool-btn[data-tip]');
      if (button?.contains(event.relatedTarget)) return;
      hide();
    };
    root.addEventListener('pointerover', enter);
    root.addEventListener('focusin', enter);
    root.addEventListener('pointerout', leave);
    root.addEventListener('focusout', hide);
    return {hide, refresh(){ if (current) show(current); }, destroy(){ hide(); tooltip.remove(); }};
  }

  window.HstarOpenShopDesktopInput = Object.freeze({
    toolCycleForKey,
    toolShortcut,
    localizedToolTip,
    createToolTooltipController,
  });
})();
```

Use delegated `pointerover`/`pointerout` handlers so dynamically moved flyout buttons use the same controller. Clamp the tooltip center between `8 + tooltipHeight / 2` and `window.innerHeight - 8 - tooltipHeight / 2` after measuring it.

- [ ] **Step 4: Connect the module and tooltip styles**

Load the helper after i18n and before the inline `OS` script:

```html
<script src="./host/openshop-i18n.js"></script>
<script src="./locales/zh-CN.js"></script>
<script src="./host/openshop-desktop-input.js"></script>
<script>
```

Replace the clipped pseudo-element CSS with:

```css
#tool-tooltip{position:fixed;z-index:22000;pointer-events:none;opacity:0;transform:translateY(-50%) translateX(-4px);padding:6px 10px;border:1px solid var(--border);border-radius:6px;background:var(--bg-depth-3);color:var(--text-primary);box-shadow:0 6px 18px rgba(0,0,0,.38);font-size:11px;line-height:1.2;white-space:nowrap;transition:opacity .12s var(--ease-out),transform .12s var(--ease-out)}
#tool-tooltip.visible{opacity:1;transform:translateY(-50%) translateX(0)}
@media(max-width:700px){#tool-tooltip{display:none}}
```

In `OS.init()`, create `this._toolTooltipController` after i18n translation. In `setLocale()`, refresh translated labels and the open tooltip. Call `hide()` from `setTool()`, `_closeAllFlyouts()`, toolbar `scroll`, and window `resize` so a tooltip never remains detached from its source. Update toolbar `data-tip`/`data-i18n-tip` values to base labels without stale shortcut suffixes. The module appends the registry shortcut.

Add missing base translations such as:

```js
"Move / Select": "移动工具 / 选择",
"Eraser": "橡皮擦工具",
"Text": "文字工具",
"Sticky Note": "便笺工具",
```

Add `host/openshop-desktop-input.js` to `runtimeFiles` in `build-hstar.mjs`.

- [ ] **Step 5: Run focused and localization tests**

Run:

```powershell
npm.cmd test -- tests/hstar-desktop-input.test.js tests/hstar-i18n.test.js
```

Expected: all focused tests PASS with no unhandled errors.

- [ ] **Step 6: Commit the tooltip foundation**

```powershell
git add integrations/openshop/host/openshop-desktop-input.js integrations/openshop/tests/hstar-desktop-input.test.js integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/scripts/build-hstar.mjs
git commit -m "feat: add localized OpenShop tooltips"
```

### Task 2: Photoshop-Style Layer Selection Model

**Files:**
- Modify: `integrations/openshop/host/openshop-desktop-input.js`
- Modify: `integrations/openshop/tests/hstar-desktop-input.test.js`
- Modify: `integrations/openshop/index.html:1480-1500`
- Modify: `integrations/openshop/index.html:2190-2315`
- Modify: `integrations/openshop/index.html:8940-8995`
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/tests/os-harness.js`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js`

- [ ] **Step 1: Write failing pure selection tests**

Specify the controller backed by layer object references:

```js
it('supports plain, Ctrl, Shift, and Ctrl+Shift layer selection', () => {
  const desktop = loadDesktopInput();
  const layers = ['A','B','C','D'].map(name => ({name}));
  let state = desktop.resetLayerSelection(layers, layers[1]);

  state = desktop.selectLayerRange({layers, state, layer:layers[3], ctrl:false, shift:true});
  expect([...state.selected].map(layer => layer.name)).toEqual(['B','C','D']);
  expect(state.primary).toBe(layers[3]);

  state = desktop.selectLayerRange({layers, state, layer:layers[0], ctrl:true, shift:false});
  expect([...state.selected].map(layer => layer.name)).toEqual(['B','C','D','A']);

  state = desktop.selectLayerRange({layers, state, layer:layers[2], ctrl:true, shift:true});
  expect(state.selected.has(layers[2])).toBe(true);
  expect(state.anchor).toBe(layers[1]);
});

it('never leaves a nonempty layer list without a primary selection', () => {
  const desktop = loadDesktopInput();
  const only = {name:'Only'};
  const state = desktop.selectLayerRange({
    layers:[only],
    state:desktop.resetLayerSelection([only], only),
    layer:only,
    ctrl:true,
    shift:false,
  });
  expect([...state.selected]).toEqual([only]);
  expect(state.primary).toBe(only);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run `npm.cmd test -- tests/hstar-desktop-input.test.js`.

Expected: FAIL because `resetLayerSelection` and `selectLayerRange` are undefined.

- [ ] **Step 3: Implement pure layer selection helpers**

Expose:

```js
function resetLayerSelection(layers, preferred) {
  const primary = layers.includes(preferred) ? preferred : layers.at(-1) || null;
  return {selected:new Set(primary ? [primary] : []), primary, anchor:primary};
}

function normalizeLayerSelection(layers, state, preferred) {
  const selected = new Set([...state.selected].filter(layer => layers.includes(layer)));
  let primary = selected.has(state.primary) ? state.primary : null;
  if (!primary && layers.length) {
    primary = layers.includes(preferred) ? preferred : [...selected].at(-1) || layers.at(-1);
    selected.add(primary);
  }
  const anchor = layers.includes(state.anchor) ? state.anchor : primary;
  return {selected, primary, anchor};
}
```

`selectLayerRange()` must implement the approved plain/Ctrl/Shift/Ctrl+Shift semantics, preserve layer-array order in the returned Set, and keep at least one selected layer.

- [ ] **Step 4: Write failing OS integration tests**

Add an `os-unit.test.js` test that renders four layer rows and dispatches click events with modifiers:

```js
it('renders primary and additive layer selections from mouse modifiers', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock();
  quietUiMethods(OS, {keepLayersPanel:true});
  OS.layers = ['A','B','C','D'].map(name => ({name, visible:true, locked:false, opacity:100, blend:'source-over', objects:[]}));
  OS._resetLayerSelection(OS.layers[1]);
  OS.updateLayersPanel();

  OS.selectLayer(3, new MouseEvent('click', {shiftKey:true}));
  expect(OS._selectedLayerIndices()).toEqual([1,2,3]);

  OS.selectLayer(0, new MouseEvent('click', {ctrlKey:true}));
  expect(OS._selectedLayerIndices()).toEqual([0,1,2,3]);
  expect(OS.activeLayerIdx).toBe(0);
  expect(document.querySelectorAll('.layer-item.selected')).toHaveLength(4);
  expect(document.querySelectorAll('.layer-item.primary')).toHaveLength(1);
});
```

Update the harness so `quietUiMethods` can preserve the real `updateLayersPanel` when requested.

```js
export function quietUiMethods(OS, {keepLayersPanel=false} = {}) {
  OS.updateInfoPanel = vi.fn();
  if (!keepLayersPanel) OS.updateLayersPanel = vi.fn();
  OS.updateHistoryPanel = vi.fn();
  OS.updateStatus = vi.fn();
  OS.updateMinimap = vi.fn();
  OS.updateHistogram = vi.fn();
  OS.recordMacroStep = vi.fn();
  OS.drawGrid = vi.fn();
  OS.drawRulers = vi.fn();
  OS._drawPixelGrid = vi.fn();
  OS.cancelCrop = vi.fn();
  OS.toast = vi.fn();
}
```

- [ ] **Step 5: Run OS tests and verify RED**

Run `npm.cmd test -- tests/os-unit.test.js`.

Expected: FAIL because OS does not own multi-layer selection state and row clicks discard modifier data.

- [ ] **Step 6: Integrate selection state into OS**

Add ephemeral fields:

```js
_selectedLayers: new Set(),
_layerSelectionAnchor: null,
_keyboardContext: 'canvas',
```

Add adapters:

```js
_resetLayerSelection(layer = this.layers[this.activeLayerIdx]) { /* use helper and sync activeLayerIdx */ },
_normalizeLayerSelection() { /* remove stale references and sync activeLayerIdx */ },
_selectedLayerIndices() { return this.layers.map((layer, index) => this._selectedLayers.has(layer) ? index : -1).filter(index => index >= 0); },
selectLayer(idx, event = {}) { /* call selectLayerRange, set layer context, discard Fabric active object, render once */ },
```

Update `createNewDocument`, `addLayer`, PSD/project import, `rebuildLayersFromCanvas`, and deletion paths to reset or normalize selection when layer objects change.

Render rows with:

```js
d.className = `layer-item${selected ? ' selected' : ''}${primary ? ' active primary' : ''}`;
d.setAttribute('aria-selected', selected ? 'true' : 'false');
d.addEventListener('click', event => this.selectLayer(i, event));
```

Update CSS so selected rows share the accent background while the primary row has a stronger border. Update the hidden accessibility layer tree to announce `Selected` and `Primary` without changing serialized project data.

- [ ] **Step 7: Prove selection state is not serialized**

Add to `hstar-project-adapter.test.js`:

```js
it('does not serialize ephemeral desktop layer selection state', () => {
  const adapter = window.HstarOpenShopProjectAdapter;
  const editor = createEditor();
  editor._selectedLayers = new Set(editor.layers);
  editor._layerSelectionAnchor = editor.layers[0];
  editor._keyboardContext = 'layers';

  const project = adapter.serializeProject({editor, context, now:() => 2000});
  const serialized = JSON.stringify(project);

  expect(serialized).not.toContain('_selectedLayers');
  expect(serialized).not.toContain('_layerSelectionAnchor');
  expect(serialized).not.toContain('_keyboardContext');
});
```

- [ ] **Step 8: Run selection tests and full units**

Run:

```powershell
npm.cmd test -- tests/hstar-desktop-input.test.js tests/os-unit.test.js tests/hstar-project-adapter.test.js
npm.cmd test
```

Expected: focused tests and the complete Vitest suite PASS.

- [ ] **Step 9: Commit layer selection**

```powershell
git add integrations/openshop/host/openshop-desktop-input.js integrations/openshop/tests/hstar-desktop-input.test.js integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js integrations/openshop/tests/os-harness.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: add OpenShop layer multi-selection"
```

### Task 3: Batch Layer Actions and Ordered Dragging

**Files:**
- Modify: `integrations/openshop/index.html:2190-2260`
- Modify: `integrations/openshop/index.html:2273-2325`
- Modify: `integrations/openshop/index.html:5734-5765`
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/locales/zh-CN.js`

- [ ] **Step 1: Write failing batch action tests**

Add focused tests using three unlocked layers and one locked background:

```js
it('deletes selected unlocked layers in one history entry and keeps locked layers', () => {
  const OS = loadOpenShop();
  const objects = [{name:'A'}, {name:'B'}, {name:'Locked'}];
  OS.canvas = createCanvasMock(objects);
  quietUiMethods(OS);
  OS.layers = [
    {name:'Background', locked:true, visible:true, opacity:100, blend:'source-over', objects:[objects[2]]},
    {name:'A', locked:false, visible:true, opacity:100, blend:'source-over', objects:[objects[0]]},
    {name:'B', locked:false, visible:true, opacity:100, blend:'source-over', objects:[objects[1]]},
  ];
  OS._selectedLayers = new Set(OS.layers);
  OS.activeLayerIdx = 2;
  OS.saveHistory = vi.fn();

  OS.deleteLayers();

  expect(OS.layers.map(layer => layer.name)).toEqual(['Background']);
  expect(OS.canvas.remove).toHaveBeenCalledWith(objects[0]);
  expect(OS.canvas.remove).toHaveBeenCalledWith(objects[1]);
  expect(OS.canvas.remove).not.toHaveBeenCalledWith(objects[2]);
  expect(OS.saveHistory).toHaveBeenCalledTimes(1);
});

it('applies opacity and blend to every selected layer', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock();
  quietUiMethods(OS);
  OS.layers = ['A','B','C'].map(name => ({name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[]}));
  OS._selectedLayers = new Set([OS.layers[0], OS.layers[2]]);
  OS.setLayerOpacity(42);
  OS.setLayerBlend('multiply');
  expect(OS.layers.map(layer => layer.opacity)).toEqual([42,100,42]);
  expect(OS.layers.map(layer => layer.blend)).toEqual(['multiply','source-over','multiply']);
});
```

Cover duplicate ordering, visibility/lock propagation, selected merge, and ordered block movement with these tests:

```js
it('duplicates selected empty layers as one ordered block above the highest selection', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock();
  quietUiMethods(OS);
  OS.layers = ['A','B','C'].map(name => ({name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[]}));
  OS._selectedLayers = new Set([OS.layers[0], OS.layers[2]]);
  OS.activeLayerIdx = 2;
  OS.saveHistory = vi.fn();

  OS.duplicateLayer();

  expect(OS.layers.map(layer => layer.name)).toEqual(['A','B','C','A Copy','C Copy']);
  expect(OS._selectedLayerList().map(layer => layer.name)).toEqual(['A Copy','C Copy']);
  expect(OS.saveHistory).toHaveBeenCalledTimes(1);
});

it('propagates clicked visibility and lock state to selected rows', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock();
  quietUiMethods(OS);
  OS.layers = ['A','B','C'].map(name => ({name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[]}));
  OS._selectedLayers = new Set([OS.layers[0], OS.layers[2]]);
  OS.toggleLayerVisibility(0);
  OS.toggleLayerLock(0);
  expect(OS.layers.map(layer => layer.visible)).toEqual([false,true,false]);
  expect(OS.layers.map(layer => layer.locked)).toEqual([true,false,true]);
});

it('moves selected layers as an ordered block and merges selected layers once', () => {
  const OS = loadOpenShop();
  const objects = ['A','B','C','D'].map(name => ({name}));
  OS.canvas = createCanvasMock(objects);
  quietUiMethods(OS);
  OS.layers = objects.map(object => ({name:object.name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[object]}));
  OS._selectedLayers = new Set([OS.layers[1], OS.layers[3]]);
  OS.activeLayerIdx = 3;
  OS.saveHistory = vi.fn();

  OS._moveSelectedLayersToIndex(0);
  expect(OS.layers.map(layer => layer.name)).toEqual(['B','D','A','C']);
  expect(OS.saveHistory).toHaveBeenLastCalledWith('Reorder Layers');

  OS.mergeSelectedOrDown();
  expect(OS.layers.map(layer => layer.name)).toEqual(['B','A','C']);
  expect(OS.layers[0].objects.map(object => object.name)).toEqual(['B','D']);
  expect(OS.saveHistory).toHaveBeenLastCalledWith('Merge Layers');
});

it('leaves selected locked layers in their relative position during block movement', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock();
  quietUiMethods(OS);
  OS.layers = ['A','B','C','D'].map(name => ({name, locked:name === 'B', visible:true, opacity:100, blend:'source-over', objects:[]}));
  OS._selectedLayers = new Set([OS.layers[1], OS.layers[3]]);
  OS.activeLayerIdx = 3;
  OS.saveHistory = vi.fn();
  OS._moveSelectedLayersToIndex(0);
  expect(OS.layers.map(layer => layer.name)).toEqual(['D','A','B','C']);
  expect(OS.toast).toHaveBeenCalledWith('Skipped 1 locked layers', 'info');
});
```

- [ ] **Step 2: Run OS tests and verify RED**

Run `npm.cmd test -- tests/os-unit.test.js`.

Expected: FAIL because the existing methods operate only on `activeLayerIdx`.

- [ ] **Step 3: Implement batch selection accessors and delete**

Create one normalized accessor:

```js
_selectedLayerList() {
  this._normalizeLayerSelection();
  return this.layers.filter(layer => this._selectedLayers.has(layer));
},
```

Implement `deleteLayers()` so it filters locked/boundary layers, removes eligible objects, removes eligible layer references, selects the nearest surviving layer, and calls render/panel/history once. Keep `deleteLayer()` as a compatibility wrapper calling `deleteLayers()`.

Add translations:

```js
"Skipped {count} locked layers": "已跳过 {count} 个锁定图层",
"No selected layers can be deleted": "所选图层均无法删除",
```

- [ ] **Step 4: Implement duplicate and property batching**

Update `duplicateLayer`, `toggleLayerVisibility`, `toggleLayerLock`, `setLayerOpacity`, and `setLayerBlend` to operate on the selected set according to the spec. Duplicate clones asynchronously but commits one render/history action after all selected object clones resolve. New copies form one contiguous block above the highest selected layer and become the only selected layers.

`setLayerOpacity` remains a live preview during the range input's `input` events. Add `commitLayerOpacity()` to write one `Layer Opacity` history entry from the range input's `change` event. Blend, visibility, and lock changes each write one history entry after the complete selected set has been updated.

- [ ] **Step 5: Implement selected merge and ordered block dragging**

Add:

```js
mergeSelectedOrDown() {
  const selected = this._selectedLayerList();
  if (selected.length < 2) return this.mergeDown();
  // Merge selected layer objects into the lowest selected layer in current z-order.
}
```

Refactor `initLayerDrag` so drag start resets selection only when the dragged row is not selected. On drop:

1. Normalize selected references.
2. Split selected layers into movable and locked.
3. Remove movable layers from the array.
4. Calculate the destination against the reduced array.
5. Insert movable layers as one block while preserving original order.
6. Keep them selected and record one `Reorder Layers` history entry.

- [ ] **Step 6: Run batch tests and full units**

Run:

```powershell
npm.cmd test -- tests/os-unit.test.js
npm.cmd test
```

Expected: all batch tests and the complete Vitest suite PASS.

- [ ] **Step 7: Commit batch operations**

```powershell
git add integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js integrations/openshop/locales/zh-CN.js
git commit -m "feat: add OpenShop batch layer actions"
```

### Task 4: Context-Aware Photoshop Shortcut Dispatcher

**Files:**
- Modify: `integrations/openshop/host/openshop-desktop-input.js`
- Modify: `integrations/openshop/tests/hstar-desktop-input.test.js`
- Modify: `integrations/openshop/index.html:6470-6610`
- Modify: `integrations/openshop/index.html:7065-7270`
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/locales/zh-CN.js`

- [ ] **Step 1: Write failing shortcut registry tests**

Specify registry lookup and editable-target exclusion:

```js
it('resolves Photoshop commands and ignores editable targets', () => {
  const desktop = loadDesktopInput();
  expect(desktop.resolveShortcut(new KeyboardEvent('keydown', {key:'j', ctrlKey:true}), {context:'layers'})).toEqual({command:'duplicate-context'});
  expect(desktop.resolveShortcut(new KeyboardEvent('keydown', {key:'Delete'}), {context:'layers'})).toEqual({command:'delete-context'});
  expect(desktop.resolveShortcut(new KeyboardEvent('keydown', {key:'u', shiftKey:true}), {context:'canvas', currentTool:'rect'})).toEqual({command:'cycle-tool', tool:'circle'});

  const input = document.createElement('input');
  expect(desktop.isEditableShortcutTarget(input, null)).toBe(true);
  expect(desktop.isEditableShortcutTarget(document.body, {isEditing:true})).toBe(true);
  expect(desktop.commandShortcut('duplicate-context')).toBe('Ctrl+J');
  expect(desktop.shortcutRows()).toContainEqual(expect.objectContaining({id:'duplicate-context', keys:['Ctrl+J']}));
});
```

- [ ] **Step 2: Run the helper tests and verify RED**

Run `npm.cmd test -- tests/hstar-desktop-input.test.js`.

Expected: FAIL because registry command resolution is not implemented.

- [ ] **Step 3: Implement command registry and key normalization**

Define the complete command descriptor list. `keys` accepts aliases that invoke the same command:

```js
const COMMAND_SHORTCUTS = Object.freeze([
  {id:'command-palette', keys:['Ctrl+Alt+K']},
  {id:'preferences', keys:['Ctrl+K']},
  {id:'new-document', keys:['Ctrl+N']},
  {id:'open-image', keys:['Ctrl+O']},
  {id:'save-project', keys:['Ctrl+S']},
  {id:'export-settings', keys:['Ctrl+Alt+Shift+W']},
  {id:'undo', keys:['Ctrl+Z']},
  {id:'redo', keys:['Ctrl+Shift+Z']},
  {id:'cut', keys:['Ctrl+X']},
  {id:'copy', keys:['Ctrl+C']},
  {id:'paste', keys:['Ctrl+V']},
  {id:'duplicate-context', keys:['Ctrl+J']},
  {id:'free-transform', keys:['Ctrl+T']},
  {id:'select-all', keys:['Ctrl+A']},
  {id:'deselect', keys:['Ctrl+D']},
  {id:'reselect', keys:['Ctrl+Shift+D']},
  {id:'invert-selection', keys:['Ctrl+Shift+I']},
  {id:'invert-image', keys:['Ctrl+I']},
  {id:'resize-canvas', keys:['Ctrl+Alt+C']},
  {id:'levels', keys:['Ctrl+L']},
  {id:'curves', keys:['Ctrl+M']},
  {id:'color-balance', keys:['Ctrl+B']},
  {id:'new-layer', keys:['Ctrl+Shift+N']},
  {id:'merge-context', keys:['Ctrl+E']},
  {id:'merge-visible', keys:['Ctrl+Shift+E']},
  {id:'select-layer-below', keys:['Alt+[']},
  {id:'select-layer-above', keys:['Alt+]']},
  {id:'move-layers-down', keys:['Ctrl+[']},
  {id:'move-layers-up', keys:['Ctrl+]']},
  {id:'move-layers-bottom', keys:['Ctrl+Shift+[']},
  {id:'move-layers-top', keys:['Ctrl+Shift+]']},
  {id:'toggle-rulers', keys:['Ctrl+R']},
  {id:'toggle-grid', keys:["Ctrl+'"]},
  {id:'zoom-fit', keys:['Ctrl+0']},
  {id:'zoom-100', keys:['Ctrl+1']},
  {id:'zoom-in', keys:['Ctrl++','Ctrl+=']},
  {id:'zoom-out', keys:['Ctrl+-']},
  {id:'toggle-panels', keys:['Tab']},
  {id:'cycle-screen-mode', keys:['F']},
  {id:'delete-context', keys:['Delete','Backspace']},
  {id:'commit-operation', keys:['Enter']},
  {id:'cancel-operation', keys:['Escape']},
  {id:'temporary-pan', keys:['Space'], releaseCommand:'temporary-pan-release'},
  {id:'brush-size-down', keys:['[']},
  {id:'brush-size-up', keys:[']']},
  {id:'default-colors', keys:['D']},
  {id:'swap-colors', keys:['X']},
]);
```

`resolveShortcut` returns null when no command matches. `shortcutRows()` returns display rows directly from these descriptors. Tool commands are resolved from the full `TOOL_CYCLES` map created in Task 1; Shift cycles to the next entry while an unmodified tool key selects the first entry or retains the current member.

- [ ] **Step 4: Write failing OS routing tests**

Specify context-aware delete and duplicate routing:

```js
it('routes Delete to layers or canvas according to the last editing context', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock([{name:'Canvas Object'}]);
  quietUiMethods(OS);
  OS.deleteLayers = vi.fn();
  OS._deleteSelected = vi.fn();
  OS._initKeyboardShortcuts();

  OS._keyboardContext = 'layers';
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));
  expect(OS.deleteLayers).toHaveBeenCalledOnce();

  OS._keyboardContext = 'canvas';
  OS.canvas.setActiveObject(OS.canvas.getObjects()[0]);
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));
  expect(OS._deleteSelected).toHaveBeenCalledOnce();
});
```

Specify input, contenteditable, and Fabric text-editing suppression:

```js
it('does not run editor shortcuts while an editable target or Fabric text is active', () => {
  const OS = loadOpenShop();
  OS.canvas = createCanvasMock();
  quietUiMethods(OS);
  OS.deleteLayers = vi.fn();
  OS.setTool = vi.fn();
  OS._initKeyboardShortcuts();

  const input = document.createElement('input');
  document.body.appendChild(input);
  input.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));

  const editable = document.createElement('div');
  editable.contentEditable = 'true';
  document.body.appendChild(editable);
  editable.dispatchEvent(new KeyboardEvent('keydown', {key:'b', bubbles:true}));

  OS.canvas.setActiveObject({type:'i-text', isEditing:true});
  document.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));

  expect(OS.deleteLayers).not.toHaveBeenCalled();
  expect(OS.setTool).not.toHaveBeenCalled();
});
```

- [ ] **Step 5: Run OS tests and verify RED**

Run `npm.cmd test -- tests/os-unit.test.js`.

Expected: FAIL because current Delete has no layer context and tool keys use conflicting legacy mappings.

- [ ] **Step 6: Replace the global shortcut switch with registry dispatch**

Map command IDs to OS methods in one object:

```js
_shortcutCommands() {
  return {
    'command-palette':()=>this.toggleCmdPalette(),
    'preferences':()=>this.showPreferences(),
    'new-document':()=>this.newImage(),
    'open-image':()=>this.openFile(),
    'save-project':()=>this.saveProject(),
    'export-settings':()=>this.showExportSettings(),
    'undo':()=>this.undo(),
    'redo':()=>this.redo(),
    'cut':()=>this._cutSelection(),
    'copy':()=>this._copySelection(),
    'paste':()=>this._pasteSelection(),
    'duplicate-context':()=>this._keyboardContext === 'layers' ? this.duplicateLayer() : this._duplicateSelection(),
    'free-transform':()=>this.freeTransform(),
    'select-all':()=>this.selectAll(),
    'deselect':()=>this.deselectAll(),
    'reselect':()=>this.reselectSelection(),
    'invert-selection':()=>this.invertSelection(),
    'invert-image':()=>this.applyFilterDirect('Invert'),
    'resize-canvas':()=>this.showResize(),
    'levels':()=>this.showLevelsDialog(),
    'curves':()=>this.showCurvesDialog(),
    'color-balance':()=>this.showColorBalanceDialog(),
    'delete-context':()=>this._deleteByContext(),
    'new-layer':()=>this.addLayer(),
    'merge-context':()=>this.mergeSelectedOrDown(),
    'merge-visible':()=>this.mergeVisibleLayers(),
    'select-layer-below':()=>this._selectAdjacentLayer(-1),
    'select-layer-above':()=>this._selectAdjacentLayer(1),
    'move-layers-down':()=>this._moveSelectedLayersBy(-1),
    'move-layers-up':()=>this._moveSelectedLayersBy(1),
    'move-layers-bottom':()=>this._moveSelectedLayersToBoundary('bottom'),
    'move-layers-top':()=>this._moveSelectedLayersToBoundary('top'),
    'toggle-rulers':()=>this.toggleRulers(),
    'toggle-grid':()=>this.toggleGrid(),
    'zoom-fit':()=>this.zoomFit(),
    'zoom-100':()=>this.setZoom(1),
    'zoom-in':()=>this.zoomIn(),
    'zoom-out':()=>this.zoomOut(),
    'toggle-panels':()=>this._toggleUIPanels(),
    'cycle-screen-mode':()=>this.toggleFullscreen(),
    'commit-operation':()=>this._commitActiveOperation(),
    'cancel-operation':()=>this._cancelActiveOperation(),
    'temporary-pan':()=>this._setTemporaryPan(true),
    'temporary-pan-release':()=>this._setTemporaryPan(false),
    'brush-size-down':()=>this.setBrushSize(Math.max(1, this.state.brushSize - 2)),
    'brush-size-up':()=>this.setBrushSize(Math.min(200, this.state.brushSize + 2)),
    'default-colors':()=>{ this.setFgColor('#000000'); this.setBgColor('#ffffff'); },
    'swap-colors':()=>this.swapColors(),
  };
},
```

Implement `_deleteByContext()` in the approved order. Add `_selectAdjacentLayer(delta)`, `_moveSelectedLayersBy(delta)`, and `_moveSelectedLayersToBoundary(edge)` as adapters over the selection state and `_moveSelectedLayersToIndex()`. Extract the current Enter, Escape, temporary Space-pan, and Tab-panel logic into `_commitActiveOperation()`, `_cancelActiveOperation()`, `_setTemporaryPan(active)`, and `_toggleUIPanels()` without changing their existing behavior.

Set keyboard context through `pointerdown`/`focusin` listeners on the layer panel and canvas area. The keydown dispatcher executes registry commands; keyup executes `releaseCommand` for Space. Do not prevent the event unless the resolver returns and executes a command.

Use registry tool cycles for single keys and Shift+key cycling. Update the current group face and localized tooltip after cycling.

- [ ] **Step 7: Generate shortcut dialog and command labels from the registry**

Replace the hard-coded `showShortcuts()` array with `HstarOpenShopDesktopInput.shortcutRows()`. Replace duplicate command-palette key labels with `commandShortcut(commandId)` wherever the command has a registry ID. Remove conflicting legacy keys such as `L` for Line, `R` for Rectangle, `O` for Ellipse, and `A` for Arrow.

- [ ] **Step 8: Run focused and complete unit tests**

Run:

```powershell
npm.cmd test -- tests/hstar-desktop-input.test.js tests/os-unit.test.js
npm.cmd test
```

Expected: the complete unit suite PASS with no duplicate shortcut listeners or unhandled errors.

- [ ] **Step 9: Commit Photoshop shortcut routing**

```powershell
git add integrations/openshop/host/openshop-desktop-input.js integrations/openshop/tests/hstar-desktop-input.test.js integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js integrations/openshop/locales/zh-CN.js
git commit -m "feat: align OpenShop desktop shortcuts"
```

### Task 5: Browser Interaction Coverage and Static Runtime Build

**Files:**
- Create: `integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js`
- Modify: `integrations/openshop/package.json`
- Generate: `static/openshop/index.html`
- Generate: `static/openshop/host/openshop-desktop-input.js`
- Generate: `static/openshop/locales/zh-CN.js`

- [ ] **Step 1: Write failing desktop browser tests**

Create a focused Playwright suite that opens `static/openshop/index.html`, dismisses welcome/recovery UI without deleting recovery data, creates four deterministic layers, and verifies:

```js
import { expect, test } from '@playwright/test';

const hstarBaseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3000';
const openshopUrl = `${hstarBaseUrl}/static/openshop/index.html`;

async function openPreparedEditor(page) {
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(typeof OS !== 'undefined' && OS.canvas && window.HstarOpenShopDesktopInput));
  await page.evaluate(() => {
    OS.dismissWelcome();
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
    OS.createNewDocument(800, 600);
    OS.canvas.clear();
    const background = OS._createCheckerBoundary(800, 600);
    OS.canvas.add(background);
    OS.layers = [
      {name:'Background', visible:true, locked:true, opacity:100, blend:'source-over', objects:[background]},
      ...['A','B','C'].map(name => ({name, visible:true, locked:false, opacity:100, blend:'source-over', objects:[]})),
    ];
    OS.activeLayerIdx = 1;
    OS._resetLayerSelection(OS.layers[1]);
    OS.updateLayersPanel();
  });
}

test('shows unclipped Chinese tooltips and edits multiple layers with desktop controls', async ({page}) => {
  await openPreparedEditor(page);

  const marquee = page.locator('#toolbar > .tool-group[data-group="selection"] > .tool-btn');
  await marquee.hover();
  const tooltip = page.locator('#tool-tooltip');
  await expect(tooltip).toHaveText('矩形选框工具（M）');
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  expect(box.x).toBeGreaterThan(46);

  await marquee.click();
  const lasso = page.locator('#flyout-host .tool-btn[data-tool="lasso"]');
  await lasso.hover();
  await expect(tooltip).toHaveText('套索工具（L）');

  const rows = page.locator('#layers-list .layer-item');
  await rows.filter({hasText:'A'}).click();
  await rows.filter({hasText:'C'}).click({modifiers:['Shift']});
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => OS.layers.map(layer => layer.name))).toEqual(['Background']);
});
```

Add explicit interaction tests:

```js
test('supports additive selection and batch layer properties', async ({page}) => {
  await openPreparedEditor(page);
  const rows = page.locator('#layers-list .layer-item');
  await rows.filter({hasText:'A'}).click();
  await rows.filter({hasText:'C'}).click({modifiers:['Control']});
  await page.locator('#layer-opacity').evaluate(input => {
    input.value = '42';
    input.dispatchEvent(new Event('input', {bubbles:true}));
  });
  await page.locator('#layer-blend').selectOption('multiply');
  expect(await page.evaluate(() => OS.layers.map(layer => ({name:layer.name, opacity:layer.opacity, blend:layer.blend})))).toEqual([
    {name:'Background', opacity:100, blend:'source-over'},
    {name:'A', opacity:42, blend:'multiply'},
    {name:'B', opacity:100, blend:'source-over'},
    {name:'C', opacity:42, blend:'multiply'},
  ]);

  await rows.filter({hasText:'A'}).locator('.layer-vis').click();
  await rows.filter({hasText:'A'}).locator('.layer-lock').click();
  expect(await page.evaluate(() => OS.layers.filter(layer => ['A','C'].includes(layer.name)).map(layer => ({visible:layer.visible, locked:layer.locked})))).toEqual([
    {visible:false, locked:true},
    {visible:false, locked:true},
  ]);
});

test('drags selected rows as one ordered block', async ({page}) => {
  await openPreparedEditor(page);
  const rows = page.locator('#layers-list .layer-item');
  await rows.filter({hasText:'A'}).click();
  await rows.filter({hasText:'C'}).click({modifiers:['Control']});
  await rows.filter({hasText:'C'}).dragTo(rows.filter({hasText:'Background'}));
  expect(await page.evaluate(() => OS.layers.map(layer => layer.name))).toEqual(['A','C','Background','B']);
});

test('keeps Delete context separate and suppresses shortcuts while editing', async ({page}) => {
  await openPreparedEditor(page);
  await page.locator('#layers-list .layer-item').filter({hasText:'B'}).click();
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => OS.layers.some(layer => layer.name === 'B'))).toBe(false);

  await page.locator('#canvas-area').click({position:{x:100,y:100}});
  await page.evaluate(() => {
    const object = new fabric.Rect({left:10, top:10, width:40, height:40});
    OS.canvas.add(object);
    OS.layers[OS.activeLayerIdx].objects.push(object);
    OS.canvas.setActiveObject(object);
  });
  const beforeCanvasDelete = await page.evaluate(() => OS.layers.length);
  const beforeObjectDelete = await page.evaluate(() => OS.canvas.getObjects().length);
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => OS.layers.length)).toBe(beforeCanvasDelete);
  expect(await page.evaluate(() => OS.canvas.getObjects().length)).toBe(beforeObjectDelete - 1);

  await page.locator('#layers-list .layer-name').filter({hasText:'A'}).dblclick();
  const rename = page.locator('.layer-name-input');
  await rename.fill('A Delete U');
  await rename.press('Backspace');
  expect(await rename.inputValue()).toBe('A Delete ');
  expect(await page.evaluate(() => OS.layers.length)).toBe(beforeCanvasDelete);
});

for (const viewport of [{width:1440,height:1000},{width:3840,height:2160}]) {
  test(`frames tooltips at ${viewport.width}`, async ({page}) => {
    await page.setViewportSize(viewport);
    await openPreparedEditor(page);
    const tool = page.locator('#toolbar > .tool-btn[data-tool="note"]');
    await tool.hover();
    const box = await page.locator('#tool-tooltip').boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(46);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });
}
```

- [ ] **Step 2: Add the Playwright command**

Add:

```json
"test:hstar:desktop": "playwright test tests/hstar-desktop-interactions.e2e.spec.js"
```

- [ ] **Step 3: Run against the stale static build and verify RED**

Run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm.cmd run test:hstar:desktop
```

Expected: FAIL because the current static runtime clips tooltips and lacks layer multi-selection.

- [ ] **Step 4: Build the static runtime**

Run `npm.cmd run build:hstar`.

Expected: the output lists `static/openshop/host/openshop-desktop-input.js` and ends with a 64-character `OPENSHOP_BUILD_SHA256`.

- [ ] **Step 5: Restart HstarA engineering server**

Stop only the Python process listening on port 3000 after verifying its command line contains this worktree's `main.py`. Restart it with the repository Python runtime and the current worktree on `sys.path`. Verify:

```powershell
(Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:3000/static/openshop/index.html').StatusCode
```

Expected: `200`.

- [ ] **Step 6: Run desktop, foundation, and canvas E2E**

Run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm.cmd run test:hstar:desktop
npm.cmd run test:hstar:e2e
npm.cmd run test:hstar:canvas-integration
```

Expected: every suite PASS; desktop screenshots show no clipping or overlap.

- [ ] **Step 7: Commit browser coverage and build output**

```powershell
git add integrations/openshop/tests/hstar-desktop-interactions.e2e.spec.js integrations/openshop/package.json static/openshop/index.html static/openshop/host/openshop-desktop-input.js static/openshop/locales/zh-CN.js
git commit -m "test: verify OpenShop desktop layer controls"
```

### Task 6: Full Regression and Branch Preservation

**Files:**
- Verify only; no planned source changes.

- [ ] **Step 1: Run all unit and localization checks**

Run:

```powershell
cd integrations/openshop
npm.cmd test
npm.cmd run audit:i18n
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm.cmd run test:hstar:localization
```

Expected: all Vitest tests, i18n audit, and localization E2E PASS without mojibake findings.

- [ ] **Step 2: Run editing regressions**

Run:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm.cmd run test:hstar:text-tools
npm.cmd run test:hstar:generative
```

Expected: all text and generative tests PASS, including background task persistence.

- [ ] **Step 3: Inspect repository scope**

Run:

```powershell
git status --short
git diff --cached --name-only
```

Expected: no staged files. Only the user's existing `data/asset_library.json`, `assets/`, and unrelated `static/*.html` changes remain outside committed feature files.

- [ ] **Step 4: Confirm the running engineering build**

Verify the port 3000 listener belongs to the worktree Python process and `GET /` returns `200`. Leave `http://127.0.0.1:3000/` running for user acceptance.

- [ ] **Step 5: Preserve the feature branch**

Keep `codex/openshop-inline-generative-editing` and its worktree unchanged. Do not merge `main`, push, or remove the worktree until the user explicitly requests integration after hands-on testing.
