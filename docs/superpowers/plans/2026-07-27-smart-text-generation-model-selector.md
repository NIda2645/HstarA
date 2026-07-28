# Smart Text Generation Model Selector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are prohibited by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an isolated, persistent generation-model selector to the smart-canvas “修改文字” panel and execute text replacement with the confirmed settings from every supported image-generation engine.

**Architecture:** Keep the existing smart-canvas generation renderers and provider catalogs authoritative. Render those controls against a temporary settings object inside the text-edit panel, bind their existing `data-*` contracts to a container-scoped draft editor, and persist only the confirmed serializable settings under the source image’s existing text-edit state. The existing `runSmartImageTextGeneration` path remains responsible for references, output nodes, requests, logs, rollback, and persistence.

**Tech Stack:** Browser JavaScript, HTML template strings, CSS, Node.js `node:test`, Hstar smart-canvas runtime and cache-integrity tooling.

**Constraints:** Do not use subagents. Do not touch the installed stable Hstar or port `5000`. Do not commit, merge, or push without explicit user authorization.

---

## File Map

- Modify `static/js/smart-canvas.js`: selector session state, isolated rendering/binding, persistence, summary, validation, and generation handoff.
- Modify `static/css/smart-canvas.css`: two-row footer, nested selector layer, responsive control layout, and theme-compatible states.
- Modify `tools/tests/smart-text-edit-integration.test.mjs`: structural integration and execution-chain regression assertions.
- Create `tools/tests/smart-text-generation-settings.test.mjs`: executable state, cancellation, confirmation, validation, and summary tests for extracted pure helpers.
- Modify `static/smart-canvas.html`: refresh smart-canvas JS/CSS cache revisions after source changes.

### Task 1: Add Failing State And UI Contracts

**Files:**
- Modify: `tools/tests/smart-text-edit-integration.test.mjs`
- Create: `tools/tests/smart-text-generation-settings.test.mjs`

- [ ] **Step 1: Extend the integration test with the required UI and execution contracts**

Add assertions that require:

```js
assert.match(js, /data-smart-text-panel-action="selectGeneration"[\s\S]*选择生图模型/);
assert.match(js, /smart-text-generation-summary[\s\S]*未选择生图模型/);
assert.match(js, /data-smart-text-generation-action="confirm"/);
assert.match(js, /data-smart-text-generation-engine/);
assert.match(js, /generationSettingsConfirmed/);
assert.match(js, /runSmartImageTextGeneration\(state\.nodeId,\s*state\.imageIndex,\s*prompt,\s*'修改文字',\s*runSettings\)/);
assert.match(css, /\.smart-text-generation-layer/);
assert.match(css, /\.smart-text-edit-action-row/);
assert.match(css, /\.smart-text-generation-summary/);
```

- [ ] **Step 2: Create executable pure-helper tests**

Use the existing function extraction pattern from `tools/tests/task-lifecycle-ownership.test.mjs` to load these functions from `static/js/smart-canvas.js`:

```js
[
  'cloneSmartTextGenerationSettings',
  'smartTextGenerationSession',
  'cancelSmartTextGenerationSession',
  'confirmSmartTextGenerationSession',
  'validateSmartTextGenerationSettings',
  'smartTextGenerationSummaryParts'
]
```

Cover these concrete behaviors:

```js
test('prefills a draft without implicitly confirming it', () => {
  const state = { generationSettingsConfirmed: false };
  smartTextGenerationSession(state, {
    engine: 'api', provider_id: 'runninghub', model: 'seedream-v4',
    ratio: 'story', resolution: '4k', quality: 'auto', count: 1
  });
  assert.equal(state.generationSettingsConfirmed, false);
  assert.equal(state.generationSettingsDraft.model, 'seedream-v4');
  assert.equal(state.generationSettings, undefined);
});

test('cancel discards only the draft', () => {
  const confirmed = { engine: 'modelscope', msgenModel: 'zimage', count: 2 };
  const state = {
    generationSettingsConfirmed: true,
    generationSettings: confirmed,
    generationSettingsDraft: { engine: 'api', model: 'other' },
    generationSelectorOpen: true
  };
  cancelSmartTextGenerationSession(state);
  assert.deepEqual(state.generationSettings, confirmed);
  assert.equal(state.generationSettingsDraft, null);
  assert.equal(state.generationSelectorOpen, false);
});

test('confirm clones the draft into durable settings', () => {
  const state = {
    generationSettingsDraft: {
      engine: 'api', apiKind: 'image', provider_id: 'runninghub',
      model: 'seedream-v4', ratio: 'wide', resolution: '2k', quality: 'high', count: 3
    },
    generationSelectorOpen: true
  };
  confirmSmartTextGenerationSession(state);
  assert.equal(state.generationSettingsConfirmed, true);
  assert.notEqual(state.generationSettings, state.generationSettingsDraft);
  assert.equal(state.generationSelectorOpen, false);
});
```

Also assert validation errors for missing API model, incomplete custom size, missing ComfyUI workflow, and missing RunningHub selection.

- [ ] **Step 3: Run the tests and verify the expected failures**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs
```

Expected: FAIL because the selector functions, markup, styles, and override handoff do not exist.

### Task 2: Implement Isolated Generation Session State

**Files:**
- Modify: `static/js/smart-canvas.js`
- Test: `tools/tests/smart-text-generation-settings.test.mjs`

- [ ] **Step 1: Add serializable clone, session, validation, and summary helpers near the smart-text state helpers**

Implement these interfaces:

```js
function cloneSmartTextGenerationSettings(source){
    const clean = settingsForStorage(cloneSmartSettings(source || {}));
    clean.apiKind = 'image';
    delete clean.videoTempShLinks;
    return clean;
}

function smartTextGenerationSession(state, fallbackSettings){
    if(!state) return null;
    const source = state.generationSettingsConfirmed && state.generationSettings
        ? state.generationSettings
        : fallbackSettings;
    state.generationSettingsDraft = cloneSmartTextGenerationSettings(source);
    state.generationSettingsDraft.apiKind = 'image';
    state.generationSelectorOpen = true;
    state.generationSettingsError = '';
    return state.generationSettingsDraft;
}

function cancelSmartTextGenerationSession(state){
    if(!state) return;
    state.generationSettingsDraft = null;
    state.generationSelectorOpen = false;
    state.generationSettingsError = '';
}

function confirmSmartTextGenerationSession(state){
    if(!state?.generationSettingsDraft) return null;
    state.generationSettings = cloneSmartTextGenerationSettings(state.generationSettingsDraft);
    state.generationSettingsConfirmed = true;
    state.generationSettingsDraft = null;
    state.generationSelectorOpen = false;
    state.generationSettingsError = '';
    return state.generationSettings;
}
```

`validateSmartTextGenerationSettings(draft)` must return an empty string for valid settings and a Chinese actionable error for these invalid states:

- `api` or `volcengine`: no provider/model;
- `api` or `modelscope`: custom resolution without positive width and height;
- `modelscope`: custom model mode without `msCustomModel`;
- `comfy`: custom mode without `comfyWorkflow`;
- `runninghub`: no resolvable `rhConfigKey`.

`smartTextGenerationSummaryParts(source)` must return an array of non-empty labels based on normalized settings. It must use existing provider, model, ratio, resolution, RunningHub, ModelScope, and ComfyUI labels instead of hard-coded provider lists.

- [ ] **Step 2: Persist only confirmed settings in the existing per-image node state**

Extend `hydrateSmartTextPanelState` and `saveSmartTextPanelStateToNode` with:

```js
generationSettingsConfirmed: saved.generationSettingsConfirmed === true,
generationSettings: saved.generationSettingsConfirmed === true
    ? cloneSmartTextGenerationSettings(saved.generationSettings)
    : null
```

and persist:

```js
generationSettingsConfirmed: state.generationSettingsConfirmed === true,
generationSettings: state.generationSettingsConfirmed
    ? cloneSmartTextGenerationSettings(state.generationSettings)
    : null
```

Never persist `generationSettingsDraft`, `generationSelectorOpen`, or `generationSettingsError`.

- [ ] **Step 3: Run the pure-helper tests**

Run:

```powershell
node --test tools/tests/smart-text-generation-settings.test.mjs
```

Expected: PASS.

### Task 3: Render And Bind Every Image Generation Engine In The Secondary Layer

**Files:**
- Modify: `static/js/smart-canvas.js`
- Modify: `static/css/smart-canvas.css`
- Test: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] **Step 1: Add a synchronous settings-context adapter for existing renderers**

Add:

```js
function withSmartSettingsRenderContext(draft, container, callback){
    const previousSettings = settings;
    const previousDynamicParams = dynamicParams;
    settings = draft;
    dynamicParams = container;
    try { return callback(); }
    finally {
        settings = previousSettings;
        dynamicParams = previousDynamicParams;
    }
}
```

Add `renderSmartTextGenerationFields(state, container)`, which selects the existing image renderer by `draft.engine`:

```js
withSmartSettingsRenderContext(draft, container, () => {
    if(draft.engine === 'api') renderApiParams();
    else if(draft.engine === 'volcengine') renderVolcengineParams();
    else if(draft.engine === 'modelscope') renderMsParams();
    else if(draft.engine === 'comfy') renderComfyParams(renderSmartTextModifyPanel);
    else if(draft.engine === 'runninghub') renderRunningHubParams();
});
```

Change `renderComfyParams` to accept an optional `onWorkflowReady=renderDynamicParams` callback and use that callback after `ensureComfyWorkflow` resolves. Existing callers keep unchanged behavior.

- [ ] **Step 2: Add a draft-only container binder**

Implement `bindSmartTextGenerationFields(state, container)`. It must support the existing control contracts inside `container` only:

- `.smart-control > .smart-pill` and scoped popover close;
- `[data-smart-param]`, `[data-size-scope]`, and `[data-param]`;
- `[data-toggle-param]`;
- `[data-comfy-bool]`, `[data-comfy-param]`, `[data-comfy-pick]`, `[data-comfy-random]`;
- `[data-rh-bool]`, `[data-rh-param]`, `[data-rh-pick]`, `[data-rh-random]`.

Each handler mutates `state.generationSettingsDraft`, then calls `renderSmartTextModifyPanel()` when a layout-affecting field changes. It must not call `persistActiveSmartSettings`, `rememberRecentSmartSettings`, or `scheduleSave` before confirmation.

For `comfyWorkflow`, clear `comfyParams`, load the workflow through `ensureComfyWorkflow`, then rerender the secondary layer. For `rhConfigKey`, clear `rhParams` and `rhRandomActive` before rerendering.

- [ ] **Step 3: Add secondary-layer markup and actions**

Add these panel actions in `ensureSmartTextEditPanel`:

```js
if(action === 'selectGeneration') openSmartTextGenerationSelector();
if(action === 'cancelGeneration') cancelSmartTextGenerationSelector();
if(action === 'confirmGeneration') confirmSmartTextGenerationSelector();
```

Add a `change` handler for `[data-smart-text-generation-engine]` that sets one of:

```js
['api', 'volcengine', 'modelscope', 'comfy', 'runninghub']
```

and forces `apiKind = 'image'` before rerendering.

Render the secondary layer only in modify mode:

```html
<div class="smart-text-generation-layer open">
  <div class="smart-text-generation-head">
    <strong>选择生图模型</strong>
    <button data-smart-text-panel-action="cancelGeneration" title="返回">...</button>
  </div>
  <label class="smart-text-generation-engine-field">
    <span>生成引擎</span>
    <select data-smart-text-generation-engine>...</select>
  </label>
  <div class="smart-text-generation-fields"></div>
  <div class="smart-text-generation-error"></div>
  <div class="smart-text-generation-actions">
    <button data-smart-text-panel-action="cancelGeneration">取消</button>
    <button data-smart-text-panel-action="confirmGeneration">确认</button>
  </div>
</div>
```

After assigning `panel.innerHTML`, call `renderSmartTextGenerationFields` and `bindSmartTextGenerationFields` for `.smart-text-generation-fields`.

- [ ] **Step 4: Add compact, theme-compatible CSS**

Add rules that:

- make `.smart-text-edit-actions` a column with a first-row action bar and second-row summary;
- align `.smart-text-generation-trigger` to the same 10px panel inset as `.smart-text-edit-tabs`;
- keep cancel/apply grouped on the right;
- position `.smart-text-generation-layer` absolutely inside the panel below the header and above the footer;
- use `var(--panel)`, `var(--card)`, `var(--line)`, `var(--text)`, `var(--muted)`, and `var(--strong)` for both themes;
- constrain engine fields and popovers to the panel width with internal scrolling;
- prevent text overflow through `min-width:0`, wrapping, and ellipsis only for non-critical secondary labels.

- [ ] **Step 5: Run the integration test**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs
```

Expected: PASS.

### Task 4: Wire Confirmation To Image Generation

**Files:**
- Modify: `static/js/smart-canvas.js`
- Test: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] **Step 1: Render the two-row footer and selection summary**

In modify mode render:

```html
<div class="smart-text-edit-actions">
  <div class="smart-text-edit-action-row">
    <button class="smart-text-generation-trigger" data-smart-text-panel-action="selectGeneration">选择生图模型</button>
    <div class="smart-text-edit-action-right">
      <button class="secondary" data-smart-text-panel-action="cancel">取消</button>
      <button class="primary" data-smart-text-panel-action="apply" disabled>应用修改</button>
    </div>
  </div>
  <div class="smart-text-generation-summary">未选择生图模型</div>
</div>
```

Enable “应用修改” only when text rows exist, OCR is not loading, and `generationSettingsConfirmed === true`.

For a confirmed state, render summary parts from `smartTextGenerationSummaryParts` with escaped text and a recognizable platform/model/workflow label.

- [ ] **Step 2: Confirm settings without changing global/node generation settings**

`openSmartTextGenerationSelector` initializes the draft from:

```js
state.generationSettingsConfirmed && state.generationSettings
    ? state.generationSettings
    : smartTextImageRunSettings(subject.node)
```

`confirmSmartTextGenerationSelector` validates, then calls `confirmSmartTextGenerationSession`, saves the smart-text state to the node, and rerenders. `cancelSmartTextGenerationSelector` calls the cancel helper and rerenders without saving a draft.

- [ ] **Step 3: Pass the confirmed configuration to the existing run path**

Change `applySmartTextModification` to:

```js
const state = smartTextEditPanelState;
if(!state || !(state.texts || []).length || !state.generationSettingsConfirmed) return;
const prompt = smartTextModificationPrompt(state.texts);
const runSettings = cloneSmartTextGenerationSettings(state.generationSettings);
closeSmartTextModifyPanel();
try {
    await runSmartImageTextGeneration(state.nodeId, state.imageIndex, prompt, '修改文字', runSettings);
} catch(err){
    toast((err?.message || '修改文字失败').slice(0, 160));
}
```

- [ ] **Step 4: Run smart-text and task-lifecycle tests**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs tools/tests/task-lifecycle-ownership.test.mjs
```

Expected: PASS with no duplicate request or ownership regressions.

### Task 5: Refresh Runtime Assets And Verify End To End

**Files:**
- Modify: `static/smart-canvas.html`
- Test: `tools/tests/static-cache-integrity.test.mjs`

- [ ] **Step 1: Update cache revisions**

Compute each required cache key with the same version-plus-mtime contract used by `tools/tests/static-cache-integrity.test.mjs`:

```powershell
node -e "const fs=require('fs');const v=fs.readFileSync('VERSION','utf8').trim().split(/\r?\n/)[0];for(const f of ['static/css/smart-canvas.css','static/js/smart-canvas.js'])console.log(f+'='+v+'.'+Math.floor(fs.statSync(f).mtimeMs/1000))"
```

Update only the matching query strings in `static/smart-canvas.html` for:

- `/static/css/smart-canvas.css`;
- `/static/js/smart-canvas.js`.

Do not alter unrelated asset revisions.

- [ ] **Step 2: Run focused source gates**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs tools/tests/static-cache-integrity.test.mjs
node tools/audit-text-encoding.mjs
git diff --check
```

Expected: all commands exit `0`.

- [ ] **Step 3: Reload port 3000 and verify the real UI without paid generation**

Verify in the existing HstarA engineering service:

1. Open an image’s “修改文字” window.
2. Confirm the new button aligns with the top modify tab.
3. Confirm the default summary reads “未选择生图模型” and apply is disabled.
4. Open the secondary layer and verify the current node settings are prefilled.
5. Switch through API, ModelScope, ComfyUI, and RunningHub to confirm engine-specific controls render.
6. Cancel and confirm the previous summary remains unchanged.
7. Reopen, confirm a configuration, and verify summary, close/reopen persistence, light theme, dark theme, zoom, and node movement.
8. Inspect browser console errors.

Do not click “应用修改” against a paid provider without explicit authorization.

- [ ] **Step 4: Run the complete source gate**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File build/scripts/Test-HstarSource.ps1
```

Expected: exit `0`; record the exact Python, Node, OpenShop, desktop, build, encoding, secret, cache, and diff-check counts emitted by the gate.

- [ ] **Step 5: Preserve the branch and worktree**

Do not commit, merge, push, delete, or clean unrelated worktree changes. Report the changed files, exact verification results, remaining paid-generation test gap, and the live `http://127.0.0.1:3000/` URL.
