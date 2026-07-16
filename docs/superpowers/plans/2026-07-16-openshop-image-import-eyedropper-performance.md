# OpenShop Image Import, Eyedropper, and Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make local image and GIF imports create independent layers in the current OpenShop document, restore accurate canvas-local eyedropper sampling, and remove avoidable main-thread work from high-resolution editing.

**Architecture:** Two focused browser modules provide device-pixel canvas sampling and coalesced UI scheduling. OpenShop keeps document and layer ownership in its existing core object, while image imports use one transactional layer insertion path, GIF frames bind to their owning layer, and navigator/histogram work shares a revisioned low-resolution analysis preview without mutating the main viewport.

**Tech Stack:** JavaScript IIFE browser modules, Fabric.js 5.3, HTML Canvas 2D, Vitest/jsdom, Playwright Chromium, Node.js build scripts.

---

## File Map

- Create `integrations/openshop/host/openshop-canvas-sampler.js`: convert a Fabric pointer and browser click into a safe device-pixel sample from `lowerCanvasEl`.
- Create `integrations/openshop/host/openshop-update-scheduler.js`: coalesce frame-critical and idle derived UI updates with visibility-aware dirty state.
- Create `integrations/openshop/tests/hstar-canvas-sampler.test.js`: sampler coordinate, Retina, bounds, transparency, and read-failure tests.
- Create `integrations/openshop/tests/hstar-update-scheduler.test.js`: frame/idle coalescing and hidden-panel tests.
- Create `integrations/openshop/tests/hstar-editor-performance.test.js`: OpenShop history, preview cache, tool-state, and high-frequency render-count tests.
- Create `integrations/openshop/tests/hstar-import-eyedropper-performance.e2e.spec.js`: real PNG/GIF import, visible-color sampling, and high-resolution browser checks.
- Modify `integrations/openshop/index.html`: transactional import, layer-owned GIF frames, eyedropper integration, preview cache, scheduling, and hot-path changes.
- Modify `integrations/openshop/locales/zh-CN.js`: new import and eyedropper error messages.
- Modify `integrations/openshop/tests/os-harness.js`: load the sampler and scheduler modules and expose canvas backing-element mocks.
- Modify `integrations/openshop/tests/os-unit.test.js`: core import and GIF ownership regression tests.
- Modify `integrations/openshop/tests/hstar-foundation.e2e.spec.js`: update the native image-import expectation from document replacement to independent-layer insertion and generalize the high-resolution baseline name.
- Modify `integrations/openshop/tests/hstar-offline-runtime.test.js`: require the two new local modules.
- Modify `integrations/openshop/scripts/build-hstar.mjs`: ship the new modules.
- Modify `integrations/openshop/package.json`: add the focused E2E script.
- Regenerate `static/openshop/` only through `npm.cmd --prefix integrations\openshop run build:hstar`.

### Task 1: Add a deterministic canvas-local pixel sampler

**Files:**
- Create: `integrations/openshop/host/openshop-canvas-sampler.js`
- Create: `integrations/openshop/tests/hstar-canvas-sampler.test.js`
- Modify: `integrations/openshop/tests/os-harness.js`

- [ ] **Step 1: Write failing sampler tests**

Create tests for normal CSS pixels, 2x backing pixels, translated/zoomed Fabric pointers, document bounds, transparent pixels, and `getImageData` failures:

```js
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));

describe('OpenShop canvas sampler', () => {
  beforeEach(() => {
    delete window.HstarOpenShopCanvasSampler;
    new Function(readFileSync(resolve(testDir, '..', 'host', 'openshop-canvas-sampler.js'), 'utf8'))();
  });

  it('samples the composited backing pixel at Retina scale', () => {
    const getImageData = vi.fn(() => ({data:new Uint8ClampedArray([17, 34, 51, 128])}));
    const lowerCanvasEl = {
      width:1600,
      height:1200,
      getBoundingClientRect:() => ({left:100, top:50, width:800, height:600}),
      getContext:() => ({getImageData}),
    };
    const result = window.HstarOpenShopCanvasSampler.sample({
      canvas:{lowerCanvasEl},
      event:{clientX:300, clientY:200},
      documentPoint:{x:240, y:180},
      documentWidth:800,
      documentHeight:600,
    });

    expect(getImageData).toHaveBeenCalledWith(400, 300, 1, 1);
    expect(result).toEqual({red:17, green:34, blue:51, alpha:128, hex:'#112233'});
  });

  it('rejects document-outside clicks without touching the backing context', () => {
    const getContext = vi.fn();
    expect(() => window.HstarOpenShopCanvasSampler.sample({
      canvas:{lowerCanvasEl:{getContext}},
      event:{clientX:10, clientY:10},
      documentPoint:{x:-1, y:20},
      documentWidth:800,
      documentHeight:600,
    })).toThrowError('Color sample is outside the document');
    expect(getContext).not.toHaveBeenCalled();
  });

  it('returns transparent RGB values and normalizes read failures', () => {
    const canvas = {
      lowerCanvasEl:{
        width:100,
        height:100,
        getBoundingClientRect:() => ({left:0, top:0, width:100, height:100}),
        getContext:() => ({getImageData:() => { throw new DOMException('tainted'); }}),
      },
    };
    expect(() => window.HstarOpenShopCanvasSampler.sample({
      canvas,
      event:{clientX:1, clientY:1},
      documentPoint:{x:1, y:1},
      documentWidth:100,
      documentHeight:100,
    })).toThrowError('Canvas color could not be sampled');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-canvas-sampler.test.js
```

Expected: FAIL because `openshop-canvas-sampler.js` does not exist.

- [ ] **Step 3: Implement the sampler module**

Create an IIFE that exposes one immutable API and never calls `window.EyeDropper`:

```js
(function initOpenShopCanvasSampler(root) {
  'use strict';

  function finite(value, label) {
    const number = Number(value);
    if (!Number.isFinite(number)) throw new Error(`${label} is invalid`);
    return number;
  }

  function sample({canvas, event, documentPoint, documentWidth, documentHeight}) {
    const pointX = finite(documentPoint?.x, 'Document X');
    const pointY = finite(documentPoint?.y, 'Document Y');
    const width = finite(documentWidth, 'Document width');
    const height = finite(documentHeight, 'Document height');
    if (pointX < 0 || pointY < 0 || pointX >= width || pointY >= height) {
      throw new Error('Color sample is outside the document');
    }

    const element = canvas?.lowerCanvasEl;
    const rect = element?.getBoundingClientRect?.();
    if (!element || !rect || rect.width <= 0 || rect.height <= 0) {
      throw new Error('Canvas color could not be sampled');
    }
    const x = Math.floor((finite(event?.clientX, 'Client X') - rect.left) * element.width / rect.width);
    const y = Math.floor((finite(event?.clientY, 'Client Y') - rect.top) * element.height / rect.height);
    if (x < 0 || y < 0 || x >= element.width || y >= element.height) {
      throw new Error('Color sample is outside the canvas');
    }
    try {
      const [red, green, blue, alpha] = element.getContext('2d', {willReadFrequently:true})
        .getImageData(x, y, 1, 1).data;
      const hex = `#${[red, green, blue].map(value => value.toString(16).padStart(2, '0')).join('')}`;
      return {red, green, blue, alpha, hex};
    } catch (_) {
      throw new Error('Canvas color could not be sampled');
    }
  }

  root.HstarOpenShopCanvasSampler = Object.freeze({sample});
})(window);
```

- [ ] **Step 4: Load the module in the unit harness and verify GREEN**

Extend `loadOpenShop()` to evaluate the sampler before evaluating the OS object. Run the focused test again and expect all cases to pass.

- [ ] **Step 5: Commit the sampler**

```powershell
git add integrations/openshop/host/openshop-canvas-sampler.js integrations/openshop/tests/hstar-canvas-sampler.test.js integrations/openshop/tests/os-harness.js
git commit -m "feat: add OpenShop canvas color sampler"
```

### Task 2: Import local images and GIFs as independent current-document layers

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/tests/hstar-foundation.e2e.spec.js`

- [ ] **Step 1: Write failing ordinary-image import tests**

Add a unit test that starts with a 3840x2160 document, a protected base layer, an existing content layer, a document name, and two history states. Call `_addDecodedImageToCanvas()` with a 9000x4000 image and assert:

```js
expect(OS.createNewDocument).not.toHaveBeenCalled();
expect(OS.canvasW).toBe(3840);
expect(OS.canvasH).toBe(2160);
expect(OS._docName).toBe('existing-project');
expect(OS.layers.slice(0, 2)).toEqual(originalLayers);
expect(OS.layers.at(-1)).toMatchObject({
  name:'reference-wide.png', visible:true, locked:false, opacity:100, blend:'source-over',
});
expect(OS.layers.at(-1).objects).toEqual([image]);
expect(image.set).toHaveBeenCalledWith(expect.objectContaining({left:0, top:0, name:'reference-wide.png'}));
expect(image.scaleToWidth).not.toHaveBeenCalled();
expect(OS.canvas.setActiveObject).toHaveBeenCalledWith(image);
expect(OS.saveHistory).toHaveBeenCalledTimes(1);
```

Add a second test proving `_handleFileLoad()` does not change `_docName` before asynchronous decoding succeeds.

- [ ] **Step 2: Write failing GIF ownership tests**

Inject an `ImageDecoder` with three frame canvases and stub the Fabric image callback. Assert that import:

- does not call `createNewDocument()`;
- creates one layer with `animationFrames.length === 3`;
- keeps all previous layers and history;
- assigns the first frame image to the new layer at `(0, 0)`;
- points `_animFrames` at the selected layer's `animationFrames`;
- does not clear the canvas when `selectFrame(1)` runs.

Also test that multi-frame decode failure calls the static image path and still inserts a new layer without document replacement.

- [ ] **Step 3: Run the focused tests and verify RED**

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/os-unit.test.js
```

Expected: the new tests fail because open mode still calls `createNewDocument()`, changes `_docName`, and frame selection clears the document.

- [ ] **Step 4: Add one transactional image-layer insertion path**

Implement these core methods in `OS`:

```js
_createImportedImageLayer(img, {name, animationFrames = []}) {
  this._validateDecodedImage(img);
  const safeName = this._safeText(name, 120);
  img.set({left:0, top:0, scaleX:1, scaleY:1, selectable:true, name:safeName});
  const layer = {
    name:safeName,
    visible:true,
    locked:false,
    opacity:100,
    blend:'source-over',
    objects:[img],
    animationFrames:[...animationFrames],
  };
  this.layers.push(layer);
  this.canvas.add(img);
  this.activeLayerIdx = this.layers.length - 1;
  this._resetLayerSelection(layer);
  this.canvas.setActiveObject(img);
  if (layer.animationFrames.length) this._activateAnimationLayer(layer);
  this.canvas.requestRenderAll();
  this.updateLayersPanel();
  this.saveHistory(layer.animationFrames.length ? 'Import GIF' : 'Import Image');
  return layer;
},
```

Change `_addDecodedImageToCanvas()` so `mode === 'open'` calls this method, never scales, never calls `zoomFit()`, and never recreates the document. Keep paste/drop behavior unchanged. Remove the `_docName` assignment from `_handleFileLoad()`.

- [ ] **Step 5: Bind animation frames to their layer**

Implement `_activateAnimationLayer(layer)` so `_animFrames` references `layer.animationFrames`, `_animIdx` resets safely, and the timeline becomes visible. Decode all GIF frames into a local array first; only after all frames and the first Fabric image decode successfully call `_createImportedImageLayer()`. This preserves transactional behavior.

Change `selectFrame(idx)` to update only the active animation layer's image element:

```js
selectFrame(idx) {
  const layer = this._activeAnimationLayer;
  const target = layer?.objects?.find(object => object.type === 'image');
  const source = layer?.animationFrames?.[idx];
  if (!target || !source) return;
  fabric.Image.fromURL(source, frameImage => {
    if (!frameImage || layer !== this._activeAnimationLayer) return;
    target.setElement(frameImage.getElement());
    target.set({width:frameImage.width, height:frameImage.height});
    target.setCoords();
    this._animIdx = idx;
    this._renderFrames();
    this.canvas.requestRenderAll();
  });
},
```

Update `selectLayer()` to activate that layer's frame collection when `animationFrames.length > 0`. `addFrame`, `dupFrame`, `removeFrame`, navigation, play, and export continue using `_animFrames`, which now aliases the owning layer collection.

- [ ] **Step 6: Update the native-import E2E expectation and verify GREEN**

Before `OS.openFile()`, create an 800x600 document with one existing marker object. After importing the real 150x150 PNG, assert `canvasW === 800`, `canvasH === 600`, the existing marker remains, and one new 150x150 image layer exists. Keep the PSD expectation unchanged: opening PSD still produces its own 1024x512 document.

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/os-unit.test.js
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'; npm.cmd --prefix integrations\openshop run test:hstar:e2e -- --grep "imports local image"
```

Expected: focused unit and E2E tests pass.

- [ ] **Step 7: Commit image and GIF import behavior**

```powershell
git add integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js integrations/openshop/tests/hstar-foundation.e2e.spec.js
git commit -m "fix: import OpenShop images as independent layers"
```

### Task 3: Connect the eyedropper to the composited OpenShop canvas

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Modify: `integrations/openshop/tests/os-unit.test.js`

- [ ] **Step 1: Write failing OS integration tests**

Set `OS.state.tool = 'eyedropper'`, stub `HstarOpenShopCanvasSampler.sample()` to return `#336699`, and call `onMouseDown()` with a Fabric pointer plus client coordinates. Assert `setFgColor('#336699')` and the localized picked toast. Add failure tests asserting the existing foreground color remains unchanged and a localized error toast is shown.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm.cmd --prefix integrations\openshop test -- tests/os-unit.test.js
```

Expected: FAIL because OS still invokes `window.EyeDropper` or the invalid Fabric `getContext()` fallback.

- [ ] **Step 3: Replace both eyedropper branches**

Use the sampler synchronously in `onMouseDown()`:

```js
if (tool === 'eyedropper') {
  try {
    const sample = window.HstarOpenShopCanvasSampler.sample({
      canvas:this.canvas,
      event:opt.e,
      documentPoint:ptr,
      documentWidth:this.canvasW,
      documentHeight:this.canvasH,
    });
    this.setFgColor(sample.hex);
    this.toast(this._t('Picked: {hex}', {hex:sample.hex}), 'info');
  } catch (error) {
    this.toast(this._t(error?.message || 'Canvas color could not be sampled'), 'error');
  }
  return;
}
```

Add Chinese translations for `Color sample is outside the document`, `Color sample is outside the canvas`, and `Canvas color could not be sampled`. Do not add a system-screen sampling fallback.

- [ ] **Step 4: Verify focused tests and commit**

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-canvas-sampler.test.js tests/os-unit.test.js
npm.cmd --prefix integrations\openshop run audit:i18n
git add integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/tests/os-unit.test.js
git commit -m "fix: sample visible colors with OpenShop eyedropper"
```

### Task 4: Add visibility-aware coalesced UI scheduling

**Files:**
- Create: `integrations/openshop/host/openshop-update-scheduler.js`
- Create: `integrations/openshop/tests/hstar-update-scheduler.test.js`
- Modify: `integrations/openshop/tests/os-harness.js`
- Modify: `integrations/openshop/index.html`

- [ ] **Step 1: Write failing scheduler tests**

Use injected frame and idle queues. Verify that three requests for the same key run once, hidden idle handlers remain dirty, revealing a key flushes it once, and a throwing handler does not prevent other handlers:

```js
const scheduler = window.HstarOpenShopUpdateScheduler.create({
  frameRequest:callback => { frameQueue.push(callback); return frameQueue.length; },
  idleRequest:callback => { idleQueue.push(callback); return idleQueue.length; },
  handlers:{layers, status, minimap, histogram},
  idleKeys:['minimap', 'histogram'],
  isVisible:key => visibility[key] !== false,
});

scheduler.request('layers', 'layers', 'status');
expect(frameQueue).toHaveLength(1);
frameQueue.shift()();
expect(layers).toHaveBeenCalledOnce();
expect(status).toHaveBeenCalledOnce();

visibility.minimap = false;
scheduler.request('minimap');
idleQueue.shift()({timeRemaining:() => 10});
expect(minimap).not.toHaveBeenCalled();
visibility.minimap = true;
scheduler.flushVisible('minimap');
expect(minimap).toHaveBeenCalledOnce();
```

- [ ] **Step 2: Run the scheduler test and verify RED**

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-update-scheduler.test.js
```

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 3: Implement the scheduler**

Expose `create({handlers, idleKeys, isVisible, frameRequest, idleRequest, onError})`. Maintain separate frame and idle dirty sets, one scheduled callback per queue, and these methods:

```js
return Object.freeze({
  request(...keys) { keys.flat().forEach(markDirty); schedule(); },
  flushVisible(...keys) { runKeys(keys.flat()); schedule(); },
  isDirty(key) { return frameDirty.has(key) || idleDirty.has(key); },
  dispose() { disposed = true; frameDirty.clear(); idleDirty.clear(); },
});
```

Use `requestIdleCallback(callback, {timeout:250})` when available and `setTimeout(() => callback({timeRemaining:() => 0}), 32)` as fallback. Hidden idle keys remain dirty instead of being discarded.

- [ ] **Step 4: Integrate the scheduler before document creation**

During `OS.init()`, after creating Fabric Canvas and before `createNewDocument()`, create `_updateScheduler` with handlers for `layers`, `history`, `status`, `minimap`, `histogram`, and `viewportUi`. Add `_scheduleUi(...keys)` as the only wrapper.

Change `saveHistory()` to keep snapshot creation and history insertion synchronous, then call:

```js
this._analysisRevision = (this._analysisRevision || 0) + 1;
this._analysisPreviewCache = null;
this._scheduleUi('history', 'status', 'minimap', 'histogram');
```

Remove direct `updateHistoryPanel()`, `updateStatus()`, `updateMinimap()`, and `updateHistogram()` calls from `saveHistory()`. Keep macro recording and `openshop:project-dirty` dispatch synchronous.

Update `switchTab()` so opening `ptg3-nav` calls `flushVisible('minimap', 'histogram')`. Visibility checks use `#ptg3-nav.classList.contains('active')`, not `offsetParent`, so tests and browser behavior agree.

- [ ] **Step 5: Verify scheduler and history behavior**

Add an OS test proving `saveHistory()` immediately increments history but does not synchronously execute minimap or histogram handlers. Flush the injected idle queue and assert each runs once.

Run:

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-update-scheduler.test.js tests/os-unit.test.js
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit the scheduler integration**

```powershell
git add integrations/openshop/host/openshop-update-scheduler.js integrations/openshop/tests/hstar-update-scheduler.test.js integrations/openshop/tests/os-harness.js integrations/openshop/index.html
git commit -m "perf: coalesce OpenShop derived UI updates"
```

### Task 5: Share a revisioned analysis preview between navigator and histogram

**Files:**
- Modify: `integrations/openshop/index.html`
- Create: `integrations/openshop/tests/hstar-editor-performance.test.js`

- [ ] **Step 1: Write failing preview-cache tests**

Mock `canvas.toCanvasElement()` and `canvas.renderAll()`. Assert navigator and histogram reuse one preview for the same revision, use a scale calculated from current document dimensions, never mutate `viewportTransform`, and never call `renderAll()`:

```js
const first = OS._getAnalysisPreview({maxWidth:320, maxHeight:180});
const second = OS._getAnalysisPreview({maxWidth:320, maxHeight:180});
expect(second).toBe(first);
expect(OS.canvas.toCanvasElement).toHaveBeenCalledOnce();
expect(OS.canvas.renderAll).not.toHaveBeenCalled();
expect(OS.canvas.viewportTransform).toEqual(originalViewport);

OS._analysisRevision += 1;
OS._getAnalysisPreview({maxWidth:320, maxHeight:180});
expect(OS.canvas.toCanvasElement).toHaveBeenCalledTimes(2);
```

Test 800x600, 3840x2160, 7680x4320, and an 80-million-pixel-compatible custom size to prove there is no 4K-only branch.

- [ ] **Step 2: Run the focused performance test and verify RED**

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-editor-performance.test.js
```

Expected: FAIL because no analysis preview cache exists and current helpers mutate the viewport and render twice.

- [ ] **Step 3: Implement the preview cache**

Add:

```js
_getAnalysisPreview({maxWidth = 320, maxHeight = 320} = {}) {
  const scale = Math.min(maxWidth / this.canvasW, maxHeight / this.canvasH, 1);
  const width = Math.max(1, Math.round(this.canvasW * scale));
  const height = Math.max(1, Math.round(this.canvasH * scale));
  const key = `${this._analysisRevision || 0}:${width}x${height}`;
  if (this._analysisPreviewCache?.key === key) return this._analysisPreviewCache.canvas;
  const preview = this.canvas.toCanvasElement(scale, {
    left:0,
    top:0,
    width:this.canvasW,
    height:this.canvasH,
  });
  this._analysisPreviewCache = {key, canvas:preview};
  return preview;
},
```

If Fabric returns dimensions that differ by one rounding pixel, draw the result once into an exact `width x height` offscreen canvas before caching it.

- [ ] **Step 4: Rewrite navigator and histogram consumers**

`_renderMinimap()` draws the cached preview directly into `#minimap-canvas`, then calls `_updateMinimapViewport()` for the viewport rectangle. `_renderHistogram()` reads the preview's reduced pixel data and computes bins. Neither method changes the main viewport or calls main-canvas `renderAll()`.

Public `updateMinimap()` and `updateHistogram()` become scheduler requests. Histogram channel buttons still set `_histChannel`, invalidate only the histogram presentation, and request one visible refresh. Zoom and pan call `_updateMinimapViewport()` without regenerating the image preview.

- [ ] **Step 5: Verify no main-canvas disturbance and commit**

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-editor-performance.test.js tests/os-unit.test.js
git add integrations/openshop/index.html integrations/openshop/tests/hstar-editor-performance.test.js
git commit -m "perf: cache OpenShop analysis previews"
```

### Task 6: Optimize tool switching and high-frequency interaction paths

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/hstar-editor-performance.test.js`

- [ ] **Step 1: Write failing tool hot-path tests**

Create 5000 lightweight canvas objects and count calls while switching among tools. Assert:

- tool buttons and option groups are queried once during cache initialization, not on every switch;
- a tool switch performs at most one object traversal;
- switching between tools with the same interaction profile does not traverse unchanged objects again;
- locked objects remain nonselectable and nonevented;
- repeated temporary-shape mouse moves use `requestRenderAll()` and never direct `renderAll()`;
- ten wheel/touch viewport events schedule one `viewportUi` frame and one idle minimap update.

- [ ] **Step 2: Run the focused test and verify RED**

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-editor-performance.test.js
```

Expected: FAIL because `setTool()` performs repeated global queries and object traversals, shape moves call `renderAll()`, and viewport events invoke navigator work repeatedly.

- [ ] **Step 3: Cache stable tool DOM and interaction profiles**

Add `_initToolRuntimeCache()` during init:

```js
this._toolRuntime = {
  buttons:[...document.querySelectorAll('.tool-btn')],
  optionGroups:[...document.querySelectorAll('#tool-options .opt-group')],
  optionById:new Map([...document.querySelectorAll('#tool-options .opt-group')].map(node => [node.id, node])),
  activeOption:null,
  interactionProfile:'',
  objectRevision:0,
  appliedObjectRevision:-1,
  brushes:new Map(),
};
```

Listen for Fabric `object:added` and `object:removed` to increment `objectRevision`; increment it when layer lock state changes or history restoration replaces objects.

Map tools to `select`, `target`, or `none` profiles. Apply object interaction state in one traversal only when the profile or object revision changes. Always force boundary and locked-layer objects to `selectable=false` and `evented=false`.

- [ ] **Step 4: Reuse brush instances and update only changed UI**

Use a brush cache key for `pencil`, `spray`, and preset type. Reconfigure color, width, density, line cap, and shadow on activation. Remove `active` only from previously active buttons and add it only to buttons matching the selected tool. Hide only the previously active option group and show the new group.

Flyout face changes must update the cached button object in place; no cache rebuild is needed because the DOM node is unchanged.

- [ ] **Step 5: Coalesce high-frequency viewport and shape feedback**

Replace direct `renderAll()` during temporary shape movement and touch movement with `requestRenderAll()`. Add one `viewportUi` scheduler handler that runs `drawGrid()`, `drawRulers()`, `_drawPixelGrid()`, and `_updateMinimapViewport()` once per animation frame. Mouse wheel, pan, and touch handlers schedule this key instead of calling each helper synchronously.

Do not delay the actual Fabric viewport transform or pointer feedback; only derived overlays are coalesced.

- [ ] **Step 6: Verify performance tests and existing desktop behavior**

```powershell
npm.cmd --prefix integrations\openshop test -- tests/hstar-editor-performance.test.js tests/os-unit.test.js tests/hstar-desktop-input.test.js
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'; npm.cmd --prefix integrations\openshop run test:hstar:desktop
```

Expected: call-count tests and desktop interaction E2E pass.

- [ ] **Step 7: Commit hot-path optimization**

```powershell
git add integrations/openshop/index.html integrations/openshop/tests/hstar-editor-performance.test.js
git commit -m "perf: reduce OpenShop tool interaction work"
```

### Task 7: Ship runtime modules and add real browser coverage

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `integrations/openshop/tests/hstar-offline-runtime.test.js`
- Create: `integrations/openshop/tests/hstar-import-eyedropper-performance.e2e.spec.js`
- Modify: `integrations/openshop/package.json`
- Generated: `static/openshop/`

- [ ] **Step 1: Write failing offline runtime assertions**

Require these source tags and build entries:

```js
expect(html).toContain('<script src="./host/openshop-canvas-sampler.js"></script>');
expect(html).toContain('<script src="./host/openshop-update-scheduler.js"></script>');
expect(buildScript).toContain("'host/openshop-canvas-sampler.js'");
expect(buildScript).toContain("'host/openshop-update-scheduler.js'");
```

Run the test and verify RED.

- [ ] **Step 2: Load and ship the modules**

Add both script tags before host runtime startup at the bottom of `index.html`. Add both files to `runtimeFiles` in `build-hstar.mjs`.

- [ ] **Step 3: Write the browser workflow**

The E2E test must:

1. Start with an existing 1920x1080 two-layer document and record its dimensions, layer identities, document name, viewport, history entries, and history length.
2. Intercept `/api/native/open-local-file` with a real 320x180 PNG; call `OS.openFile()` and assert one new original-size layer at `(0, 0)`, one new history entry, and unchanged dimensions, prior layers, document name, viewport, and prior history entries.
3. Repeat with a two-frame GIF fixture and assert another independent layer with two frames; selecting its second frame must not remove any other canvas object.
4. Draw overlapping red and 50%-opaque blue rectangles, set zoom and translation, click the eyedropper at a known composite pixel, and compare the resulting foreground color with `lowerCanvasEl.getImageData()` at that screen point.
5. Click outside document bounds and assert the foreground color remains unchanged.
6. Exercise 800x600, 3840x2160, 7680x4320, and a custom high-pixel document; record tool switch, wheel burst, history commit, navigator, and histogram timings plus call counts.
7. Assert high-resolution cases use the same scheduler and preview methods, main viewport remains unchanged after analysis, navigator/histogram calls are coalesced, canvas pixels are nonblank, and there are no page errors.

The test reports timing evidence to the console but gates on correctness and call-count reductions rather than environment-sensitive absolute milliseconds.

- [ ] **Step 4: Add the E2E script and run isolated tests**

Add:

```json
"test:hstar:import-eyedropper-performance": "playwright test tests/hstar-import-eyedropper-performance.e2e.spec.js"
```

Run only against the `3010` isolated engineering service:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'; npm.cmd --prefix integrations\openshop run test:hstar:import-eyedropper-performance
```

Expected: all browser workflows pass and leave no project or asset data behind.

- [ ] **Step 5: Build and run complete OpenShop verification**

```powershell
npm.cmd --prefix integrations\openshop run build:hstar
npm.cmd --prefix integrations\openshop test
npm.cmd --prefix integrations\openshop run audit:i18n
```

Expected: build exits 0 with `OPENSHOP_BUILD_SHA256=...`; all unit tests and localization audit cases pass.

- [ ] **Step 6: Commit integration and generated runtime**

```powershell
git add integrations/openshop/index.html integrations/openshop/scripts/build-hstar.mjs integrations/openshop/tests/hstar-offline-runtime.test.js integrations/openshop/tests/hstar-import-eyedropper-performance.e2e.spec.js integrations/openshop/package.json static/openshop
git commit -m "test: cover OpenShop imports eyedropper and performance"
```

### Task 8: Final regression, isolated cleanup, and engineering restart

**Files:**
- Review only files listed in this plan.

- [ ] **Step 1: Run fresh unit, audit, and related E2E suites**

```powershell
npm.cmd --prefix integrations\openshop test
npm.cmd --prefix integrations\openshop run audit:i18n
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'; npm.cmd --prefix integrations\openshop run test:hstar:import-eyedropper-performance
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'; npm.cmd --prefix integrations\openshop run test:hstar:e2e
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'; npm.cmd --prefix integrations\openshop run test:hstar:desktop
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'; npm.cmd --prefix integrations\openshop run test:hstar:canvas-integration
```

Expected: all commands pass with no page errors, blank canvases, image scaling, document replacement, or test-data leaks.

- [ ] **Step 2: Inspect the exact branch scope**

```powershell
git diff --check
git status --short
git log -12 --oneline
```

Expected: no whitespace errors. Existing user changes in `data/asset_library.json`, unrelated `static/*.html`, and `assets/` remain untouched and unstaged.

- [ ] **Step 3: Clean only isolated engineering test data**

Verify the isolated service PID, port, and resolved storage root. Stop only the `3010` process, delete only its worktree-local temporary canvas/project/assets/log data, and confirm port `3010` is no longer listening. Never delete or modify `E:\Hstar缓存`, the `3000` data root, or stable Hstar storage.

- [ ] **Step 4: Restart only the HstarA engineering service**

Restart the existing engineering process for this worktree at `http://127.0.0.1:3000/` with its current configured storage root. Verify:

```text
GET /static/openshop/index.html -> 200
GET /static/openshop/host/openshop-canvas-sampler.js -> 200
GET /static/openshop/host/openshop-update-scheduler.js -> 200
```

Leave branch `codex/openshop-inline-generative-editing` unmerged for user testing.
