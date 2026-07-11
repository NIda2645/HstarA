# 3D Director Desk Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate `storyai-3d-director-desk` into HstarA as a same-origin built-in "3D Director Desk" page, plus ordinary and smart canvas Director nodes that can exchange panorama inputs and capture outputs.

**Architecture:** Vendor the upstream React/Three.js project under `integrations/storyai-3d-director-desk/`, build it into `static/3d-director/`, and host it through HstarA's existing FastAPI static service. HstarA owns a shell host controller plus classic/smart canvas adapters; the Director app communicates only through a versioned same-origin `postMessage` protocol.

**Tech Stack:** FastAPI static hosting, HstarA static HTML/JavaScript canvas files, React 18, Vite 6, TypeScript, Three.js/R3F/Drei, Zustand, Node test scripts.

---

## File Structure

- Create `integrations/storyai-3d-director-desk/`: vendored upstream source pinned to commit `8c8bd36`.
- Modify `integrations/storyai-3d-director-desk/package.json`: remove direct Darwin Rollup dependency and add build/test helpers if needed.
- Modify `integrations/storyai-3d-director-desk/package-lock.json`: regenerate on Windows after dependency cleanup.
- Modify `integrations/storyai-3d-director-desk/vite.config.ts`: set `base: "./"` and build output to `../../static/3d-director`.
- Create `integrations/storyai-3d-director-desk/src/editor/io/hostProtocol.ts`: protocol constants, envelope types, validation helpers.
- Create `integrations/storyai-3d-director-desk/src/editor/io/hostRuntime.ts`: Director-side host runtime, session handling, pause/resume, capture sending.
- Modify `integrations/storyai-3d-director-desk/src/editor/io/hostBridge.ts`: use the new runtime without breaking existing upstream message names.
- Modify `integrations/storyai-3d-director-desk/src/App.tsx`, `src/editor/canvas/DirectorCanvas.tsx`, and relevant panel files: apply scoped session, panorama import, capture return, and render lifecycle.
- Create upstream tests beside the new host runtime files.
- Create `static/js/director-protocol.js`: browser-safe protocol constants and validation shared by Hstar shell and canvas adapters.
- Create `static/js/director-host.js`: iframe host, page activation, context routing, target picker, image persistence through `/api/ai/upload-base64`, and import acknowledgement.
- Create `static/js/canvas-director.js`: classic canvas Director adapter.
- Create `static/js/smart-canvas-director.js`: smart canvas Director adapter.
- Create `static/css/director-host.css`: shell iframe and target picker styles.
- Create `static/css/director-canvas.css`: shared Director node styles for canvas cards.
- Modify `static/index.html`: add sidebar entry below infinite canvas, Director page iframe, scripts/styles, and page routing.
- Modify `static/canvas.html` and `static/smart-canvas.html`: load Director adapter CSS/JS after existing canvas scripts.
- Modify `static/js/canvas.js`: register classic Director node type, ports, rendering hook, menu entry, connection rules, save integration, and import helpers.
- Modify `static/js/smart-canvas.js`: register smart Director node type, menu entry, connection rules, save integration, and import helpers.
- Modify `static/js/i18n/common.js` and canvas i18n files only for user-facing labels required by the new feature.
- Create `tools/tests/director-protocol.test.mjs`, `tools/tests/director-shell-integration.test.mjs`, `tools/tests/director-classic-adapter.test.mjs`, `tools/tests/director-smart-adapter.test.mjs`, and `tools/tests/director-installer-payload.test.mjs`.
- Avoid staging `build/installer/stage/`, `python/Lib/`, and `python/Scripts/`; these are local runtime outputs.

## Task 1: Baseline and Tooling

**Files:**
- Modify: `.gitignore`
- Create/Modify: `integrations/storyai-3d-director-desk/`
- Test: command-level baseline verification

- [ ] **Step 1: Verify git state and ignored runtime outputs**

Run:

```powershell
git status --short
git check-ignore -q build/installer/stage/; $LASTEXITCODE
git check-ignore -q python/Lib/; $LASTEXITCODE
git check-ignore -q python/Scripts/; $LASTEXITCODE
```

Expected: `build/installer/stage/` is ignored or intentionally left untracked and never staged. If `python/Lib/` or `python/Scripts/` are unignored, add these exact ignore rules:

```gitignore
python/Lib/
python/Scripts/
python/pyvenv.cfg
```

- [ ] **Step 2: Copy upstream source into HstarA**

Run:

```powershell
robocopy 'E:\Claude专业组\_tmp_storyai_3d_director_ref' 'E:\Claude专业组\HstarA\integrations\storyai-3d-director-desk' /E /XD .git node_modules dist /XF tsconfig.tsbuildinfo tsconfig.node.tsbuildinfo
if ($LASTEXITCODE -le 7) { exit 0 } else { exit $LASTEXITCODE }
```

Expected: upstream files appear under `integrations/storyai-3d-director-desk/`, with no `node_modules`, no `.git`, and no generated `dist`.

- [ ] **Step 3: Remove direct Darwin Rollup dependency**

Edit `integrations/storyai-3d-director-desk/package.json` so `dependencies` or `devDependencies` do not contain:

```json
"@rollup/rollup-darwin-arm64": "..."
```

- [ ] **Step 4: Install clean dependencies**

Run:

```powershell
npm install
```

from `integrations/storyai-3d-director-desk/`.

Expected: `package-lock.json` is regenerated and `npm` exits `0`.

- [ ] **Step 5: Commit tooling baseline**

Run:

```powershell
git add .gitignore integrations/storyai-3d-director-desk/package.json integrations/storyai-3d-director-desk/package-lock.json integrations/storyai-3d-director-desk/LICENSE integrations/storyai-3d-director-desk/README.md integrations/storyai-3d-director-desk/index.html integrations/storyai-3d-director-desk/public integrations/storyai-3d-director-desk/src integrations/storyai-3d-director-desk/tsconfig.json integrations/storyai-3d-director-desk/tsconfig.node.json integrations/storyai-3d-director-desk/vite.config.ts
git commit -m "chore: vendor 3d director desk source"
```

## Task 2: Director Protocol Tests

**Files:**
- Create: `static/js/director-protocol.js`
- Create: `tools/tests/director-protocol.test.mjs`
- Create: `integrations/storyai-3d-director-desk/src/editor/io/hostProtocol.ts`
- Create: `integrations/storyai-3d-director-desk/src/editor/io/hostProtocol.test.ts`

- [ ] **Step 1: Write failing Hstar protocol test**

Create `tools/tests/director-protocol.test.mjs` with assertions that:

```js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync('static/js/director-protocol.js', 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox);

const protocol = sandbox.window.HstarDirectorProtocol;
assert.equal(protocol.PROTOCOL_VERSION, 1);
assert.equal(protocol.SCENE_PREFIX, 'director:');
assert.equal(protocol.createSceneKey('classic', 'canvas-1', 'node-1'), 'director:classic:canvas-1:node-1');
assert.equal(protocol.createStandaloneSceneKey(), 'director:standalone');

const envelope = protocol.createEnvelope({
  type: 'storyai:director-desk-session',
  sessionId: 's1',
  requestId: 'r1',
  context: { mode: 'node', canvasType: 'classic', canvasId: 'c1', nodeId: 'n1', instanceId: 'i1' },
  payload: { ok: true },
});

assert.equal(protocol.validateEnvelope(envelope).ok, true);
assert.equal(protocol.validateEnvelope({ ...envelope, protocolVersion: 999 }).ok, false);
assert.equal(protocol.validateEnvelope({ ...envelope, requestId: '' }).ok, false);
```

Run:

```powershell
node tools/tests/director-protocol.test.mjs
```

Expected: FAIL because `static/js/director-protocol.js` does not exist.

- [ ] **Step 2: Implement minimal Hstar protocol module**

Create `static/js/director-protocol.js` exposing `window.HstarDirectorProtocol` with:

```js
(function(){
  const PROTOCOL_VERSION = 1;
  const SCENE_PREFIX = 'director:';
  const TYPES = Object.freeze({
    READY: 'storyai:director-desk-ready',
    CLOSE: 'storyai:director-desk-close',
    SESSION: 'storyai:director-desk-session',
    PANORAMA: 'storyai:director-desk-panorama',
    PANORAMA_REMOVED: 'storyai:director-desk-panorama-removed',
    CAPTURES_SENT: 'storyai:director-desk-captures-sent',
    PICK_TARGET: 'storyai:director-desk-pick-target',
    IMPORT_RESULT: 'storyai:director-desk-import-result',
    ERROR: 'storyai:director-desk-error',
    RENDER_STATE: 'storyai:director-desk-render-state',
  });
  function createSceneKey(canvasType, canvasId, nodeId){
    return `${SCENE_PREFIX}${canvasType}:${canvasId}:${nodeId}`;
  }
  function createStandaloneSceneKey(){
    return `${SCENE_PREFIX}standalone`;
  }
  function createEnvelope({ type, sessionId, requestId, context, payload }){
    return { type, protocolVersion: PROTOCOL_VERSION, sessionId, requestId, context, payload: payload || {} };
  }
  function validateEnvelope(value){
    if(!value || typeof value !== 'object') return { ok:false, reason:'not-object' };
    if(value.protocolVersion !== PROTOCOL_VERSION) return { ok:false, reason:'version' };
    if(typeof value.type !== 'string' || !value.type.startsWith('storyai:director-desk-')) return { ok:false, reason:'type' };
    if(typeof value.sessionId !== 'string' || !value.sessionId) return { ok:false, reason:'session' };
    if(typeof value.requestId !== 'string' || !value.requestId) return { ok:false, reason:'request' };
    if(!value.context || typeof value.context !== 'object') return { ok:false, reason:'context' };
    return { ok:true };
  }
  window.HstarDirectorProtocol = Object.freeze({ PROTOCOL_VERSION, SCENE_PREFIX, TYPES, createSceneKey, createStandaloneSceneKey, createEnvelope, validateEnvelope });
})();
```

- [ ] **Step 3: Run Hstar protocol test**

Run:

```powershell
node tools/tests/director-protocol.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Mirror protocol in TypeScript**

Create `hostProtocol.ts` with matching constants, `DirectorContext`, `DirectorEnvelope`, `createEnvelope`, `validateEnvelope`, `createSceneKey`, and `createStandaloneSceneKey`.

- [ ] **Step 5: Add upstream protocol test**

Create `hostProtocol.test.ts` using Vitest to assert the same behavior as the Hstar Node test.

- [ ] **Step 6: Run upstream targeted test**

Run:

```powershell
npm test -- src/editor/io/hostProtocol.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit protocol**

Run:

```powershell
git add static/js/director-protocol.js tools/tests/director-protocol.test.mjs integrations/storyai-3d-director-desk/src/editor/io/hostProtocol.ts integrations/storyai-3d-director-desk/src/editor/io/hostProtocol.test.ts
git commit -m "feat: add 3d director host protocol"
```

## Task 3: Upstream Host Runtime and Build

**Files:**
- Create: `integrations/storyai-3d-director-desk/src/editor/io/hostRuntime.ts`
- Create: `integrations/storyai-3d-director-desk/src/editor/io/hostRuntime.test.ts`
- Modify: `integrations/storyai-3d-director-desk/src/editor/io/hostBridge.ts`
- Modify: `integrations/storyai-3d-director-desk/src/App.tsx`
- Modify: `integrations/storyai-3d-director-desk/src/editor/canvas/DirectorCanvas.tsx`
- Modify: `integrations/storyai-3d-director-desk/vite.config.ts`

- [ ] **Step 1: Write failing host runtime tests**

Tests must verify:

```ts
it('accepts only same-origin session messages for the active session', () => {});
it('deduplicates capture request ids until the session changes', () => {});
it('emits render-state pause and resume notifications', () => {});
it('imports, replaces, and clears panorama without resetting scene content', () => {});
```

Run:

```powershell
npm test -- src/editor/io/hostRuntime.test.ts
```

Expected: FAIL because runtime does not exist.

- [ ] **Step 2: Implement host runtime**

Implement a small runtime that:

- reads session envelopes from `window.message`;
- validates origin against `window.location.origin`;
- stores active `sessionId`, `sceneKey`, and `context`;
- exposes `postReady`, `postCapturesSent`, `postPanoramaRemoved`, and `postError`;
- exposes `pauseRendering` and `resumeRendering`;
- drops duplicate `requestId` values.

- [ ] **Step 3: Wire runtime into upstream app**

Update `App.tsx`, `hostBridge.ts`, and `DirectorCanvas.tsx` so the Director app:

- announces ready;
- accepts a scoped session;
- stores and reloads by `sceneKey`;
- applies panorama payloads as background;
- sends capture batches through the runtime;
- pauses rendering when the shell marks the iframe inactive.

- [ ] **Step 4: Update Vite config**

Set:

```ts
base: './',
build: {
  outDir: '../../static/3d-director',
  emptyOutDir: true,
}
```

- [ ] **Step 5: Run upstream tests and build**

Run:

```powershell
npm test
npm run build
```

Expected: tests and build exit `0`; `static/3d-director/index.html` exists and uses relative asset URLs.

- [ ] **Step 6: Commit upstream runtime**

Run:

```powershell
git add integrations/storyai-3d-director-desk static/3d-director
git commit -m "feat: build 3d director desk static app"
```

## Task 4: Hstar Shell Host

**Files:**
- Create: `static/js/director-host.js`
- Create: `static/css/director-host.css`
- Modify: `static/index.html`
- Create: `tools/tests/director-shell-integration.test.mjs`

- [ ] **Step 1: Write failing shell integration test**

Create a Node source-scan test that asserts:

- `static/index.html` contains a nav entry for `director-desk` immediately after `canvas`;
- `PAGE_IDS` includes `director-desk`;
- an iframe with id `frame-director-desk` points to `/static/3d-director/index.html`;
- `director-host.css`, `director-protocol.js`, and `director-host.js` are loaded.

Run:

```powershell
node tools/tests/director-shell-integration.test.mjs
```

Expected: FAIL before shell changes.

- [ ] **Step 2: Add shell nav and page**

In `static/index.html`, add the sidebar item directly below the infinite canvas item:

```html
<div class="nav-item" onclick="switchUI(this, 'director-desk')">
  <div class="nav-icon"><i data-lucide="box"></i></div>
  <span class="nav-text" data-i18n="nav.directorDesk">3D导演台</span>
</div>
```

Add page iframe:

```html
<iframe id="frame-director-desk" data-src="/static/3d-director/index.html" scrolling="no"></iframe>
```

Add `director-desk` to `PAGE_IDS`.

- [ ] **Step 3: Implement shell host controller**

`static/js/director-host.js` must:

- lazily load and reuse `frame-director-desk`;
- create standalone session context `director:standalone`;
- dispatch render pause/resume when switching pages;
- validate `postMessage` origin and source;
- open a target picker for standalone capture sends;
- call existing `/api/projects`, `/api/canvases`, `POST /api/canvases`, `GET /api/canvases/{id}`, and `PUT /api/canvases/{id}`;
- persist capture data URLs through `/api/ai/upload-base64` before storing canvas JSON;
- reject duplicate `requestId` values.

- [ ] **Step 4: Style iframe and picker**

`director-host.css` must keep the Director page full-screen inside HstarA, with a compact same-style target picker overlay and no nested decorative cards.

- [ ] **Step 5: Run shell test**

Run:

```powershell
node tools/tests/director-shell-integration.test.mjs
```

Expected: PASS.

- [ ] **Step 6: Commit shell host**

Run:

```powershell
git add static/index.html static/js/director-host.js static/css/director-host.css tools/tests/director-shell-integration.test.mjs
git commit -m "feat: add 3d director shell host"
```

## Task 5: Classic Canvas Adapter

**Files:**
- Create: `static/js/canvas-director.js`
- Create: `static/css/director-canvas.css`
- Modify: `static/canvas.html`
- Modify: `static/js/canvas.js`
- Create: `tools/tests/director-classic-adapter.test.mjs`

- [ ] **Step 1: Write failing classic adapter test**

Test source requirements:

- `canvas.html` loads `director-canvas.css`, `director-protocol.js`, and `canvas-director.js`;
- `canvas.js` recognizes node type `director-3d`;
- `canConnect()` allows exactly one image source into a Director node;
- render output contains an open action and panorama status;
- an adapter function creates one grouped output node from 1, 4, or 12 captures.

Run:

```powershell
node tools/tests/director-classic-adapter.test.mjs
```

Expected: FAIL before adapter changes.

- [ ] **Step 2: Implement classic adapter module**

Expose `window.HstarClassicDirectorAdapter` with:

- `createDirectorNode(point)`;
- `renderDirectorNode(node)`;
- `openDirectorNode(nodeId)`;
- `resolveDirectorPanorama(node)`;
- `importDirectorCaptures({ originNodeId, captures, requestId })`;
- `removeDirectorPanorama({ nodeId, edgeId })`.

- [ ] **Step 3: Wire adapter into classic canvas**

Update `canvas.js` so:

- create menu includes "3D导演台";
- `createNodeByType('director-3d')` creates a lightweight node;
- `renderNode()` delegates Director node body to the adapter;
- `canConnect()` permits image-to-Director and Director-to-output, with one active image input;
- save and delete flows do not resurrect deleted Director output nodes;
- returned captures call existing `addOutputNode()` path and save through `saveCanvas()`.

- [ ] **Step 4: Run classic adapter test**

Run:

```powershell
node tools/tests/director-classic-adapter.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit classic adapter**

Run:

```powershell
git add static/canvas.html static/js/canvas.js static/js/canvas-director.js static/css/director-canvas.css tools/tests/director-classic-adapter.test.mjs
git commit -m "feat: add classic canvas 3d director node"
```

## Task 6: Smart Canvas Adapter

**Files:**
- Create: `static/js/smart-canvas-director.js`
- Modify: `static/smart-canvas.html`
- Modify: `static/js/smart-canvas.js`
- Create: `tools/tests/director-smart-adapter.test.mjs`

- [ ] **Step 1: Write failing smart adapter test**

Test source requirements:

- `smart-canvas.html` loads `director-canvas.css`, `director-protocol.js`, and `smart-canvas-director.js`;
- `smart-canvas.js` recognizes `director-3d`;
- smart create menu contains "3D导演台";
- `addConnection()`/`connectInputNode()` can connect image input to Director and Director to grouped output;
- imported captures use the existing grouped image structure and save the canvas.

Run:

```powershell
node tools/tests/director-smart-adapter.test.mjs
```

Expected: FAIL before adapter changes.

- [ ] **Step 2: Implement smart adapter module**

Expose `window.HstarSmartDirectorAdapter` with the same public operations as the classic adapter, but using smart canvas node/group structures.

- [ ] **Step 3: Wire adapter into smart canvas**

Update `smart-canvas.js` so:

- menu creation includes the Director node;
- renderer displays a lightweight Director card;
- connection logic accepts one image input and Director output;
- capture import creates one grouped image output to the right and connects it to the Director node;
- delete and remote-sync code track deleted Director-created nodes so they do not reappear.

- [ ] **Step 4: Run smart adapter test**

Run:

```powershell
node tools/tests/director-smart-adapter.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit smart adapter**

Run:

```powershell
git add static/smart-canvas.html static/js/smart-canvas.js static/js/smart-canvas-director.js tools/tests/director-smart-adapter.test.mjs
git commit -m "feat: add smart canvas 3d director node"
```

## Task 7: End-to-End Verification and Packaging Guard

**Files:**
- Create: `tools/tests/director-installer-payload.test.mjs`
- Modify only files needed to fix failures found by verification.

- [ ] **Step 1: Write installer/static payload test**

Assert:

- `static/3d-director/index.html` exists;
- every local JS/CSS asset referenced by it exists;
- no asset URL starts with `http://` or `https://`;
- expected model/static resources used by the upstream build are present;
- `build/installer/stage/` is not staged by git.

Run:

```powershell
node tools/tests/director-installer-payload.test.mjs
```

Expected: PASS after the build task.

- [ ] **Step 2: Run all Hstar Node tests**

Run:

```powershell
Get-ChildItem tools/tests/*.test.mjs | ForEach-Object { node $_.FullName }
node tools/tests/hstarc-health-check.mjs
```

Expected: every test exits `0`.

- [ ] **Step 3: Run upstream clean checks**

Run from `integrations/storyai-3d-director-desk/`:

```powershell
npm test
npm run build
```

Expected: both exit `0`.

- [ ] **Step 4: Browser smoke check**

With HstarA running at `http://127.0.0.1:3000/`, verify:

- sidebar entry opens Director page;
- WebGL canvas is nonblank by canvas-pixel sampling;
- switching away pauses render and switching back resumes;
- standalone send target picker lists "New Canvas" and existing canvases;
- classic canvas can create/open Director node;
- smart canvas can create/open Director node.

- [ ] **Step 5: Final git status and commit**

Run:

```powershell
git status --short
```

Expected: only intentional source changes remain. Do not stage `build/installer/stage/`, `python/Lib/`, or `python/Scripts/`.

Commit verification fixes:

```powershell
git add static integrations tools docs .gitignore
git commit -m "test: verify 3d director integration"
```

## Self-Review

- Spec coverage: The plan covers vendoring, same-origin static hosting, shell entry, iframe host, classic/smart nodes, panorama input, capture output, standalone send target picker, session validation, render pause/resume, static payload, browser checks, and installer guard.
- Placeholder scan: No unfinished-work placeholder terms or undefined future work placeholders are used.
- Type consistency: Protocol names use `storyai:director-desk-*`, scene keys use `director:<canvasType>:<canvasId>:<nodeId>` and `director:standalone`, and Hstar node type is consistently `director-3d`.
