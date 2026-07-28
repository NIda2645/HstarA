# OpenShop Layer Snapping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add always-on geometry snapping that restores full-size layers to the document and local-redraw layers to their frozen selection position without locking movement or changing image data.

**Architecture:** Add a browser-safe pure geometry module that resolves per-axis snap candidates by priority. The OpenShop core adapts Fabric object geometry into that module, while the generative integration persists selection-anchor metadata and the project adapter round-trips it.

**Tech Stack:** JavaScript, Fabric.js 5.3.1, Vitest/jsdom, Playwright, existing OpenShop build script

---

## File Map

- Create `integrations/openshop/host/openshop-snap-engine.js`: pure rectangle and movement snap calculations with no Fabric or DOM dependency.
- Create `integrations/openshop/tests/openshop-snap-engine.test.js`: unit coverage for geometry priority, tolerance, grid fallback, and drag release.
- Modify `integrations/openshop/index.html`: load the engine and route `object:moving` through an OpenShop-to-engine adapter.
- Modify `integrations/openshop/tests/os-unit.test.js`: verify Fabric movement integration and old-project metadata fallback.
- Modify `integrations/openshop/host/openshop-generative-tools.js`: attach a frozen local-selection anchor to newly generated image objects.
- Modify `integrations/openshop/tests/hstar-generative-tools.test.js`: verify generated anchor metadata and initial placement.
- Modify `integrations/openshop/host/openshop-project-adapter.js`: include `hstarSnapAnchor` in serialized Fabric object properties.
- Modify `integrations/openshop/tests/hstar-project-adapter.test.js`: verify anchor metadata survives save and restore.
- Modify `integrations/openshop/scripts/build-hstar.mjs`: include the new engine in the approved runtime tree.
- Modify `integrations/openshop/tests/hstar-generative-tools.e2e.spec.js`: exercise snapping in a real Fabric canvas.
- Build generated counterparts under `static/openshop/`.

### Task 1: Pure Geometry Snap Engine

**Files:**
- Create: `integrations/openshop/host/openshop-snap-engine.js`
- Create: `integrations/openshop/tests/openshop-snap-engine.test.js`

- [ ] **Step 1: Write failing engine tests**

Cover exact document overlap, local-selection anchors, edge/center alignment, grid fallback, and movement beyond tolerance:

```js
it('prioritizes a frozen local selection over document and grid targets', () => {
  const result = engine.resolveMovement({
    position:{left:12, top:8},
    objectRect:{left:12, top:8, width:800, height:600},
    documentRect:{left:0, top:0, width:800, height:600},
    localAnchorRect:{left:112, top:88, width:240, height:160},
    localTargetRect:{left:100, top:80, width:240, height:160},
    tolerance:15,
    grid:{enabled:true, size:20},
  });
  expect(result).toMatchObject({left:0, top:0, sourceX:'local-selection', sourceY:'local-selection'});
});

it('does not retain a snap after the proposed position leaves tolerance', () => {
  const result = engine.resolveMovement({
    position:{left:18, top:0},
    objectRect:{left:18, top:0, width:800, height:600},
    documentRect:{left:0, top:0, width:800, height:600},
    tolerance:10,
    grid:{enabled:false, size:20},
  });
  expect(result.left).toBe(18);
  expect(result.sourceX).toBe('none');
});
```

- [ ] **Step 2: Run the focused test and verify failure**

Run: `npm test -- tests/openshop-snap-engine.test.js`

Expected: FAIL because `host/openshop-snap-engine.js` does not exist or `HstarOpenShopSnapEngine` is undefined.

- [ ] **Step 3: Implement candidate resolution**

Expose one immutable browser global and keep all calculations pure:

```js
(function bootstrapOpenShopSnapEngine(root){
  const finite = (value, fallback=0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
  const point = value => ({left:finite(value?.left), top:finite(value?.top)});
  const rect = value => {
    const normalized = {
      left:finite(value?.left), top:finite(value?.top),
      width:finite(value?.width), height:finite(value?.height),
    };
    return normalized.width > 0 && normalized.height > 0 ? normalized : null;
  };
  const axisPoints = (value, axis) => axis === 'x'
    ? [value.left, value.left + value.width / 2, value.left + value.width]
    : [value.top, value.top + value.height / 2, value.top + value.height];
  const addMatching = (list, currentValue, targetValue, axis, tolerance, priority, source) => {
    if (!currentValue || !targetValue) return;
    axisPoints(currentValue, axis).forEach((current, index) => {
      const delta = axisPoints(targetValue, axis)[index] - current;
      if (Math.abs(delta) <= tolerance) list.push({delta, priority, source});
    });
  };
  const choose = candidates => candidates.sort((left, right) => (
    left.priority - right.priority || Math.abs(left.delta) - Math.abs(right.delta)
  ))[0] || null;
  const gridActive = grid => Boolean(grid?.enabled) && finite(grid?.size) > 0;
  const gridValue = (value, grid) => gridActive(grid)
    ? Math.round(value / finite(grid.size)) * finite(grid.size)
    : value;

  function resolveMovement(input={}) {
    const position = point(input.position);
    const objectRect = rect(input.objectRect);
    const documentRect = rect(input.documentRect);
    const localAnchorRect = rect(input.localAnchorRect);
    const localTargetRect = rect(input.localTargetRect);
    const tolerance = Math.max(0, finite(input.tolerance));
    const xCandidates = [];
    const yCandidates = [];

    addMatching(xCandidates, localAnchorRect, localTargetRect, 'x', tolerance, 0, 'local-selection');
    addMatching(yCandidates, localAnchorRect, localTargetRect, 'y', tolerance, 0, 'local-selection');
    if (objectRect && documentRect
      && Math.abs(objectRect.width - documentRect.width) <= tolerance
      && Math.abs(objectRect.height - documentRect.height) <= tolerance) {
      xCandidates.push({delta:documentRect.left - objectRect.left, priority:1, source:'document-overlap'});
      yCandidates.push({delta:documentRect.top - objectRect.top, priority:1, source:'document-overlap'});
    }
    addMatching(xCandidates, objectRect, documentRect, 'x', tolerance, 2, 'document-geometry');
    addMatching(yCandidates, objectRect, documentRect, 'y', tolerance, 2, 'document-geometry');

    const x = choose(xCandidates);
    const y = choose(yCandidates);
    return {
      left:x ? position.left + x.delta : gridValue(position.left, input.grid),
      top:y ? position.top + y.delta : gridValue(position.top, input.grid),
      sourceX:x?.source || (gridActive(input.grid) ? 'grid' : 'none'),
      sourceY:y?.source || (gridActive(input.grid) ? 'grid' : 'none'),
    };
  }
  root.HstarOpenShopSnapEngine = Object.freeze({resolveMovement});
})(window);
```

Candidate ordering must be priority first, then smallest absolute delta. X and Y are selected independently. Grid rounding runs only on axes with no geometry candidate.

- [ ] **Step 4: Run the focused test and verify pass**

Run: `npm test -- tests/openshop-snap-engine.test.js`

Expected: all snap-engine tests PASS.

- [ ] **Step 5: Commit the pure engine**

```bash
git add integrations/openshop/host/openshop-snap-engine.js integrations/openshop/tests/openshop-snap-engine.test.js
git commit -m "feat: add OpenShop geometry snap engine"
```

### Task 2: Fabric Movement Integration

**Files:**
- Modify: `integrations/openshop/index.html:1596`
- Modify: `integrations/openshop/index.html:8912`
- Modify: `integrations/openshop/tests/os-unit.test.js`

- [ ] **Step 1: Write failing OpenShop integration tests**

Load the snap engine in the test harness, create a movable object with a deterministic `getBoundingRect()`, and assert `_applyObjectSnapping()` restores full-document alignment at both 100% and 21% zoom. Add a second assertion that an 11-screen-pixel displacement does not snap when `snapTolerance` is 10.

```js
const object = {
  left:24, top:-14, width:3840, height:2160, scaleX:1, scaleY:1,
  getBoundingRect:() => ({left:object.left, top:object.top, width:3840, height:2160}),
  set(values){ Object.assign(this, values); },
  setCoords:vi.fn(),
};
OS.canvasW = 3840;
OS.canvasH = 2160;
OS.canvas.viewportTransform = [0.21, 0, 0, 0.21, 0, 0];
OS._prefs.snapTolerance = 6;
OS._applyObjectSnapping(object);
expect(object).toMatchObject({left:0, top:0});
```

- [ ] **Step 2: Run the focused integration test and verify failure**

Run: `npm test -- tests/os-unit.test.js`

Expected: FAIL because `_applyObjectSnapping` is undefined.

- [ ] **Step 3: Add the OpenShop-to-engine adapter**

Replace the old grid-only listener with:

```js
this.canvas.on('object:moving', opt => this._applyObjectSnapping(opt.target));
```

Add focused helpers on `OS`:

```js
_applyObjectSnapping(object) {
  if (!object || object.name === '__boundary__' || object.selectable === false) return;
  const layer = this.layers.find(item => item.objects?.includes(object));
  if (layer?.locked) return;
  const zoom = Math.max(0.0001, Math.abs(Number(this.canvas?.viewportTransform?.[0] || this.zoom || 1)));
  const objectRect = this._objectSnapRect(object);
  const local = this._localSelectionSnapGeometry(object, layer, objectRect);
  const result = window.HstarOpenShopSnapEngine?.resolveMovement({
    position:{left:Number(object.left) || 0, top:Number(object.top) || 0},
    objectRect,
    documentRect:{left:0, top:0, width:this.canvasW, height:this.canvasH},
    localAnchorRect:local?.anchorRect,
    localTargetRect:local?.targetRect,
    tolerance:Math.max(1, Number(this._prefs.snapTolerance) || 5) / zoom,
    grid:{enabled:this.snapEnabled, size:this.gridSize},
  });
  if (!result) return;
  object.set({left:result.left, top:result.top});
  object.setCoords?.();
}
```

`_objectSnapRect` must prefer `getBoundingRect(true, true)` and validate finite positive dimensions. `_localSelectionSnapGeometry` must ignore rotated/skewed objects and derive old-project selection data from `layer.hstarAiGeneration.selection` when object metadata is absent.

Load `./host/openshop-snap-engine.js` before the other host modules.

- [ ] **Step 4: Run engine and OpenShop unit tests**

Run: `npm test -- tests/openshop-snap-engine.test.js tests/os-unit.test.js`

Expected: both files PASS; existing grid behavior remains covered through the engine fallback.

- [ ] **Step 5: Commit Fabric integration**

```bash
git add integrations/openshop/index.html integrations/openshop/tests/os-unit.test.js
git commit -m "feat: snap OpenShop layers to document geometry"
```

### Task 3: Persist Local-Redraw Selection Anchors

**Files:**
- Modify: `integrations/openshop/host/openshop-generative-tools.js:198`
- Modify: `integrations/openshop/host/openshop-project-adapter.js:763`
- Modify: `integrations/openshop/index.html:1926,3866,4601`
- Modify: `integrations/openshop/tests/hstar-generative-tools.test.js:324`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js:476`

- [ ] **Step 1: Write failing metadata and round-trip tests**

Assert every local-redraw result receives this serializable object property:

```js
expect(generated[0].objects[0].hstarSnapAnchor).toEqual({
  type:'selection', x:10, y:20, width:300, height:200,
  documentWidth:1920, documentHeight:1080,
});
```

Extend the project-adapter round-trip fixture to place `hstarSnapAnchor` on the image, assert it exists in `project.editor.objects[0]`, restore the project, and assert the restored object retains the exact value.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `npm test -- tests/hstar-generative-tools.test.js tests/hstar-project-adapter.test.js`

Expected: FAIL because generated objects and serialized objects do not contain `hstarSnapAnchor`.

- [ ] **Step 3: Attach and serialize selection anchors**

When `task.toolId === 'local-redraw'`, normalize the frozen snapshot values and assign:

```js
image.hstarSnapAnchor = {
  type:'selection',
  x:Number(selection.x),
  y:Number(selection.y),
  width:Number(selection.width),
  height:Number(selection.height),
  documentWidth:Number(snapshot.document?.width || editor.canvasW),
  documentHeight:Number(snapshot.document?.height || editor.canvasH),
};
```

Add `'hstarSnapAnchor'` to the project-adapter Fabric property list and all OpenShop history/project `toJSON` property lists. Do not crop or rescale the generated full-document transparent PNG.

- [ ] **Step 4: Run focused metadata and snapping tests**

Run: `npm test -- tests/hstar-generative-tools.test.js tests/hstar-project-adapter.test.js tests/openshop-snap-engine.test.js tests/os-unit.test.js`

Expected: all focused tests PASS, including old-project fallback from layer metadata.

- [ ] **Step 5: Commit metadata persistence**

```bash
git add integrations/openshop/host/openshop-generative-tools.js integrations/openshop/host/openshop-project-adapter.js integrations/openshop/index.html integrations/openshop/tests/hstar-generative-tools.test.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: preserve OpenShop selection snap anchors"
```

### Task 4: Runtime Build and Browser Verification

**Files:**
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `integrations/openshop/tests/hstar-generative-tools.e2e.spec.js`
- Generate: `static/openshop/index.html`
- Generate: `static/openshop/host/openshop-snap-engine.js`
- Generate: changed host files under `static/openshop/host/`

- [ ] **Step 1: Add a failing real-Fabric E2E assertion**

After generated layers are inserted, move one result near but not exactly at its origin, fire Fabric's movement event, and assert the full-document object returns to `(0, 0)`. Then move it beyond the screen-space tolerance and assert it remains displaced.

```js
const snapResult = await page.evaluate(() => {
  const layer = OS.layers.find(item => item.hstarAiGeneration);
  const object = layer.objects[0];
  object.set({
    left:3,
    top:2,
    scaleX:OS.canvasW / object.width,
    scaleY:OS.canvasH / object.height,
  });
  object.setCoords();
  OS.canvas.fire('object:moving', {target:object});
  const snapped = {left:object.left, top:object.top};
  object.set({left:80, top:0});
  object.setCoords();
  OS.canvas.fire('object:moving', {target:object});
  return {snapped, released:{left:object.left, top:object.top}};
});
expect(snapResult.snapped).toEqual({left:0, top:0});
expect(snapResult.released.left).toBe(80);
```

Also assert `hstarSnapAnchor` contains the original selection coordinates.

- [ ] **Step 2: Add the engine to the approved build tree**

Insert `'host/openshop-snap-engine.js'` into `runtimeFiles` in `scripts/build-hstar.mjs`.

- [ ] **Step 3: Build the static OpenShop runtime**

Run: `npm run build:hstar`

Expected: command prints `static/openshop/host/openshop-snap-engine.js` and ends with `OPENSHOP_BUILD_SHA256=<64 hex characters>`.

- [ ] **Step 4: Run the real browser test against HstarA**

Run: `$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm run test:hstar:generative`

Expected: all generative Playwright tests PASS, including full-size snap, local anchor metadata, release beyond tolerance, background generation, and viewport framing.

- [ ] **Step 5: Commit the runtime build and E2E coverage**

```bash
git add integrations/openshop/scripts/build-hstar.mjs integrations/openshop/tests/hstar-generative-tools.e2e.spec.js static/openshop
git commit -m "test: verify OpenShop layer snapping in browser"
```

### Task 5: Regression Verification

**Files:**
- Verify only; no planned source edits.

- [ ] **Step 1: Run the complete OpenShop unit suite**

Run: `npm test`

Expected: all Vitest tests PASS.

- [ ] **Step 2: Run foundation and canvas integration E2E suites**

Run: `$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm run test:hstar:e2e`

Expected: all foundation E2E tests PASS.

Run: `$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm run test:hstar:canvas-integration`

Expected: all canvas integration E2E tests PASS.

- [ ] **Step 3: Inspect repository scope**

Run: `git status --short`

Expected: only the user's pre-existing `data/asset_library.json`, `assets/`, and unrelated `static/*.html` changes remain. No test artifact, cache, trace, screenshot, or temporary file is staged.

- [ ] **Step 4: Perform final browser geometry check**

Open `http://127.0.0.1:3000/static/openshop/index.html`, create a 3840×2160 document, and verify with browser evaluation that a same-size layer snaps to exact `(0,0)` at fit-to-window zoom and can be dragged beyond tolerance. Confirm the canvas is nonblank and no controls overlap.

- [ ] **Step 5: Record verification evidence**

Capture the exact Vitest and Playwright pass counts plus the final commit list in the completion response. Do not claim completion if any required suite failed or remained running.
