# Smart Text Generation Selector Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are prohibited by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the smart-canvas “选择生图模型” layer scale together with the canvas and present its generation settings as evenly spaced single-column rows, with separate size and `1K / 2K / 4K` resolution controls.

**Architecture:** Keep the selector mounted in the canvas world so it follows its source node and inherits the same `viewport.scale` as image cards. Clamp against its unmodified world-space footprint without applying inverse scaling. Continue using the existing provider/model/ratio/quality/count renderers and draft state; only the smart-text selector replaces the combined size picker with existing ratio rendering plus a selector-specific resolution renderer, then decorates the generated controls as labeled full-width rows.

**Tech Stack:** Browser JavaScript, CSS, HTML cache revisions, Node.js `node:test`, Hstar smart-canvas source gate.

**Constraints:** Work only in `E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing`. Do not use subagents. Do not touch stable Hstar or port `5000`. Do not trigger paid image generation. Do not commit, merge, push, clean, or revert unrelated changes.

---

## File Map

- Modify `static/js/smart-canvas.js`: canvas-world positioning, selector-only resolution capability helpers, split size/resolution rendering, field labels, validation, and return icon.
- Modify `static/css/smart-canvas.css`: single-column controls, typography, spacing, popover bounds, and fixed footer behavior.
- Modify `tools/tests/smart-text-edit-integration.test.mjs`: source-level layout, positioning, markup, and cache contracts.
- Modify `tools/tests/smart-text-generation-settings.test.mjs`: executable resolution capability and normalization tests.
- Modify `static/smart-canvas.html`: refresh only the smart-canvas CSS and JavaScript cache revisions.

### Task 1: Add Failing Layout And Resolution Contracts

**Files:**
- Modify: `tools/tests/smart-text-edit-integration.test.mjs`
- Modify: `tools/tests/smart-text-generation-settings.test.mjs`

- [ ] **Step 1: Add source-level positioning and layout assertions**

Keep `SMART_TEXT_EDIT_PANEL_WIDTH` and `SMART_TEXT_EDIT_PANEL_HEIGHT` as canvas-world units. Append assertions that reject inverse scaling and cover selector height, the return icon, separate controls, and single-column styling:

```js
assert.match(js, /const SMART_TEXT_GENERATION_PANEL_HEIGHT = 500;/,
  'generation selector should reserve enough canvas-world height for six single-column rows');
assert.doesNotMatch(js, /const uiScale = 1 \/ scale;|scale\(\$\{uiScale\}\)/,
  'text edit and generation panels should not counter-scale against canvas zoom');
assert.match(js, /const worldWidth = width;[\s\S]*const worldHeight = height;/,
  'panel clamping should use the same canvas-world footprint that scales with the node');
assert.match(js, /panel\.style\.transform = '';/,
  'panel should inherit the canvas world transform');
assert.match(js, /data-smart-text-panel-action="cancelGeneration"[\s\S]*data-lucide="arrow-left"/,
  'the nested selector should expose a return affordance instead of a second close icon');
assert.match(js, /function renderSmartTextResolutionControl\(prefix=''\)/,
  'smart text generation should render resolution separately from size');
assert.match(js, /renderRatioControl\(prefix, includeSource\)[\s\S]*renderSmartTextResolutionControl\(prefix\)/,
  'the smart text selector should replace the combined size picker with separate controls');
assert.match(css, /\.smart-text-generation-fields \{[^}]*flex-direction:column;[^}]*gap:9px;/,
  'generation settings should form an evenly spaced vertical list');
assert.match(css, /\.smart-text-generation-fields \.smart-pill \{[^}]*width:100%;[^}]*height:38px;[^}]*border-radius:8px;/,
  'every generation setting row should share one full-width button box');
assert.match(css, /content:attr\(data-smart-text-field-label\)/,
  'each full-width row should expose a left-aligned field label');
```

- [ ] **Step 2: Extend the pure-helper extraction list**

Add these functions to `names` in `tools/tests/smart-text-generation-settings.test.mjs`:

```js
'smartTextResolutionOptions',
'normalizeSmartTextResolution',
```

Destructure both helpers from `context.helpers`.

Add this deterministic dependency to the test VM context so `normalizeSmartTextResolution` can use the same interface as production:

```js
defaultSmartApiResolution() {
  return '1k';
},
```

- [ ] **Step 3: Add executable resolution capability tests**

Add tests covering generic models, fixed-resolution model names, and stale draft normalization:

```js
test('resolution choices always expose 1K 2K and 4K', () => {
  assert.deepEqual(plain(smartTextResolutionOptions({ model: 'seedream-v5-pro' })), [
    { value: '1k', disabled: false },
    { value: '2k', disabled: false },
    { value: '4k', disabled: false },
  ]);
});

test('model names with an explicit resolution disable unsupported choices', () => {
  assert.deepEqual(plain(smartTextResolutionOptions({ model: 'gpt-image2-4k' })), [
    { value: '1k', disabled: true },
    { value: '2k', disabled: true },
    { value: '4k', disabled: false },
  ]);
});

test('resolution normalization replaces a stale unsupported draft value', () => {
  const draft = { model: 'gpt-image2-2k', resolution: '4k' };
  assert.equal(normalizeSmartTextResolution(draft), '2k');
  assert.equal(draft.resolution, '2k');
});

test('ModelScope custom models use the prefixed resolution field', () => {
  const draft = { msgenModel: 'custom', msCustomModel: 'poster-model-4k', msResolution: '1k' };
  assert.equal(normalizeSmartTextResolution(draft, 'ms'), '4k');
  assert.equal(draft.msResolution, '4k');
});
```

- [ ] **Step 4: Run the focused tests and verify RED**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs
```

Expected: FAIL because selector-specific height, inherited canvas scaling, single-column CSS, return icon, and resolution helpers do not exist yet.

### Task 2: Split Size And Resolution Without Duplicating Provider Logic

**Files:**
- Modify: `static/js/smart-canvas.js`
- Test: `tools/tests/smart-text-generation-settings.test.mjs`

- [ ] **Step 1: Add pure resolution capability helpers next to the smart-text generation state helpers**

Add these functions before `validateSmartTextGenerationSettings`:

```js
function smartTextResolutionOptions(source, prefix=''){
    const draft = source || {};
    const model = prefix === 'ms'
        ? (draft.msgenModel === 'custom' ? draft.msCustomModel : draft.msgenModel)
        : draft.model;
    const fixed = String(model || '').trim().toLowerCase().match(/(?:^|[-_])(1k|2k|4k)$/)?.[1] || '';
    return ['1k','2k','4k'].map(value => ({
        value,
        disabled:Boolean(fixed) && value !== fixed
    }));
}

function normalizeSmartTextResolution(source, prefix=''){
    if(!source || typeof source !== 'object') return '1k';
    const key = prefix ? `${prefix}Resolution` : 'resolution';
    const allowed = smartTextResolutionOptions(source, prefix)
        .filter(option => !option.disabled)
        .map(option => option.value);
    const fallback = allowed.includes(prefix ? '1k' : defaultSmartApiResolution(source.model))
        ? (prefix ? '1k' : defaultSmartApiResolution(source.model))
        : (allowed[0] || '1k');
    if(!allowed.includes(source[key])) source[key] = fallback;
    return source[key];
}
```

The suffix rule is intentionally conservative: only a model identifier explicitly ending in `-1k`, `-2k`, `-4k`, `_1k`, `_2k`, or `_4k` locks the resolution. Models without explicit capability information keep all three choices enabled.

- [ ] **Step 2: Run pure-helper tests and verify GREEN for the new helpers**

Run:

```powershell
node --test tools/tests/smart-text-generation-settings.test.mjs
```

Expected: all helper tests PASS.

- [ ] **Step 3: Add a selector-specific resolution control**

Add the renderer near `renderSmartTextGenerationFields` so the normal image-node control remains unchanged:

```js
function renderSmartTextResolutionControl(prefix=''){
    const draft = settings || {};
    const key = prefix ? `${prefix}Resolution` : 'resolution';
    const current = normalizeSmartTextResolution(draft, prefix);
    const options = smartTextResolutionOptions(draft, prefix);
    return `<div class="smart-control resolution-control smart-text-resolution-control">
        <button class="smart-pill" type="button"><i data-lucide="monitor"></i><span>${escapeHtml(String(current).toUpperCase())}</span></button>
        <div class="smart-popover compact-popover">
            <div class="smart-popover-title">分辨率</div>
            <div class="seg-row">
                ${options.map(option => `<button type="button" class="${option.value === current ? 'active' : ''}" data-smart-param="${key}" data-smart-value="${option.value}" ${option.disabled ? 'disabled title="该模型不支持"' : ''}>${option.value.toUpperCase()}</button>`).join('')}
            </div>
        </div>
    </div>`;
}
```

- [ ] **Step 4: Replace only the selector's combined size picker**

Add a DOM adapter that reuses the existing ratio renderer and keeps global `renderApiParams`, `renderVolcengineParams`, `renderMsParams`, and `renderRunningHubParams` authoritative:

```js
function splitSmartTextGenerationSizeControl(state, container, prefix='', includeSource=false){
    const combined = container?.querySelector('.size-picker-control');
    const draft = state?.generationSettingsDraft;
    if(!combined || !draft) return;
    const holder = document.createElement('div');
    holder.innerHTML = withSmartSettingsRenderContext(draft, () =>
        `${renderRatioControl(prefix, includeSource)}${renderSmartTextResolutionControl(prefix)}`
    );
    combined.replaceWith(...holder.children);
}
```

In `renderSmartTextGenerationFields`, call the adapter after the existing engine renderer and before event binding:

```js
const prefix = draft.engine === 'modelscope' ? 'ms' : '';
if(container.querySelector('.size-picker-control')){
    splitSmartTextGenerationSizeControl(state, container, prefix, draft.engine !== 'modelscope');
}
decorateSmartTextGenerationFields(container);
bindSmartTextGenerationFields(state, container);
```

- [ ] **Step 5: Add field labels without rewriting existing renderer markup**

Add a focused decorator:

```js
function smartTextGenerationFieldLabel(control){
    if(control.classList.contains('provider-control')){
        return control.querySelector('[data-smart-param="msgenModel"]') ? '生图模型' : 'API 平台';
    }
    if(control.classList.contains('model-control')) return '生图模型';
    if(control.classList.contains('rh-config-control')) return '模型 / 应用 / 工作流';
    if(control.classList.contains('ratio-control')) return '尺寸';
    if(control.classList.contains('smart-text-resolution-control')) return '分辨率';
    if(control.classList.contains('quality-control')) return '质量';
    if(control.classList.contains('count-control')) return '生图数量';
    if(control.classList.contains('rh-payment-control')) return '支付方式';
    if(control.classList.contains('rh-machine-control')) return '运行规格';
    if(control.classList.contains('workflow-control')) return '工作流';
    if(control.classList.contains('comfy-mode-control')) return '生成模式';
    return '';
}

function decorateSmartTextGenerationFields(container){
    container?.querySelectorAll('.smart-control').forEach(control => {
        const pill = control.querySelector(':scope > .smart-pill');
        const label = smartTextGenerationFieldLabel(control);
        if(pill && label) pill.dataset.smartTextFieldLabel = label;
    });
}
```

Dynamic ComfyUI and RunningHub fields retain their existing input renderers; only controls with a known semantic role receive the two-sided labeled-row treatment.

- [ ] **Step 6: Normalize model changes and reject impossible confirmation**

After provider/model changes have been applied in `setSmartTextGenerationDraftSetting`, rely on the next render to call `normalizeSmartTextResolution`. Extend `validateSmartTextGenerationSettings` before its final return:

```js
const prefix = engine === 'modelscope' ? 'ms' : '';
const resolutionKey = prefix ? 'msResolution' : 'resolution';
if(source[resolutionKey] && ['api','volcengine','modelscope'].includes(engine)){
    const selected = smartTextResolutionOptions(source, prefix)
        .find(option => option.value === source[resolutionKey]);
    if(!selected || selected.disabled) return '当前模型不支持所选分辨率，请重新选择';
}
```

- [ ] **Step 7: Run focused behavior tests**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs
```

Expected: resolution helper tests PASS; layout assertions remain RED until Task 3.

### Task 3: Stabilize Screen Size And Apply The Single-Column Visual System

**Files:**
- Modify: `static/js/smart-canvas.js`
- Modify: `static/css/smart-canvas.css`
- Test: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] **Step 1: Add selector-specific height and canvas-synchronous positioning**

Add the selector height beside the existing constants:

```js
const SMART_TEXT_EDIT_PANEL_WIDTH = 280;
const SMART_TEXT_EDIT_PANEL_HEIGHT = 420;
const SMART_TEXT_GENERATION_PANEL_HEIGHT = 500;
```

Replace the geometry inside `positionSmartTextEditPanel` with canvas-world dimensions and world-footprint clamping:

```js
const scale = Math.max(0.001, Number(viewport.scale) || 1);
const width = SMART_TEXT_EDIT_PANEL_WIDTH;
const targetHeight = state.generationSelectorOpen
    ? SMART_TEXT_GENERATION_PANEL_HEIGHT
    : SMART_TEXT_EDIT_PANEL_HEIGHT;
const height = Math.min(targetHeight, Math.max(320, shell.clientHeight - 24));
const worldWidth = width;
const worldHeight = height;
const node = nodes.find(n => n.id === state.nodeId);
const bounds = node ? nodeRect(node) : null;
const viewLeft = -viewport.x / scale;
const viewTop = -viewport.y / scale;
const viewWidth = shell.clientWidth / scale;
const viewHeight = shell.clientHeight / scale;
const viewRight = viewLeft + viewWidth;
const viewBottom = viewTop + viewHeight;
const gap = 14;
const inset = 12 / scale;
let left = bounds
    ? bounds.x + bounds.width + gap
    : viewLeft + Math.max(inset, (viewWidth - worldWidth) / 2);
if(left + worldWidth > viewRight - inset){
    left = (bounds ? bounds.x : viewRight) - worldWidth - gap;
}
left = Math.max(viewLeft + inset, Math.min(left, viewRight - worldWidth - inset));
const rawTop = bounds ? bounds.y : viewTop + (92 / scale);
const top = Math.max(viewTop + inset, Math.min(rawTop, viewBottom - worldHeight - inset));
panel.style.width = `${width}px`;
panel.style.height = `${height}px`;
panel.style.left = `${left}px`;
panel.style.top = `${top}px`;
panel.style.transform = '';
```

Do not round `left` and `top`: fractional world coordinates prevent visible jitter while zooming.

- [ ] **Step 2: Replace the nested close icon with a return icon**

Change the secondary header button to:

```html
<button type="button" data-smart-text-panel-action="cancelGeneration" title="返回" aria-label="返回修改文字">
    <i data-lucide="arrow-left"></i>
</button>
```

- [ ] **Step 3: Add stable transform origin and full-width row CSS**

Update the selector-specific rules in `static/css/smart-canvas.css`:

```css
.smart-text-edit-panel { transform-origin:top left; }
.smart-text-generation-content { gap:10px; }
.smart-text-generation-fields {
  --ctrl-height:38px;
  min-width:0;
  display:flex;
  flex-direction:column;
  align-items:stretch;
  gap:9px;
}
.smart-text-generation-fields > * { width:100%; min-width:0; max-width:100%; box-sizing:border-box; }
.smart-text-generation-fields .smart-control { width:100%; max-width:100%; }
.smart-text-generation-fields .smart-pill {
  width:100%;
  max-width:none;
  height:38px;
  padding:0 11px;
  border:1px solid var(--line);
  border-radius:8px;
  justify-content:flex-start;
  background:var(--card);
  font-size:11px !important;
}
.smart-text-generation-fields .smart-pill::before {
  content:attr(data-smart-text-field-label);
  flex:0 0 auto;
  color:var(--faint);
  font-size:10px;
  font-weight:800;
}
.smart-text-generation-fields .smart-pill > span {
  min-width:0;
  margin-left:auto;
  overflow:hidden;
  text-overflow:ellipsis;
  white-space:nowrap;
  color:var(--text);
  font-weight:750;
}
.smart-text-generation-fields .smart-pill > i:first-child,
.smart-text-generation-fields .smart-pill > svg:first-child { display:none; }
.smart-text-generation-fields .smart-popover {
  left:0;
  right:auto;
  top:calc(100% + 6px);
  width:100%;
  min-width:0;
  max-width:100%;
  box-sizing:border-box;
  transform:translateY(-4px);
}
```

Keep `.smart-text-generation-actions` outside the scrolling `.smart-text-generation-content`; its existing flex sizing and border make the footer remain visible.

- [ ] **Step 4: Keep engine control sizing unchanged and make disabled resolution options explicit**

Do not change `.smart-text-generation-engine-field select` height or padding. Add:

```css
.smart-text-generation-fields .seg-row button:disabled {
  opacity:.38;
  cursor:not-allowed;
  text-decoration:line-through;
}
```

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs tools/tests/task-lifecycle-ownership.test.mjs
```

Expected: all tests PASS with no generation lifecycle regression.

### Task 4: Refresh Assets And Verify The Real Canvas

**Files:**
- Modify: `static/smart-canvas.html`
- Test: `tools/tests/static-cache-integrity.test.mjs`

- [ ] **Step 1: Refresh only smart-canvas CSS and JavaScript cache revisions**

Run:

```powershell
node -e "const fs=require('fs');const v=fs.readFileSync('VERSION','utf8').trim().split(/\r?\n/)[0];for(const f of ['static/css/smart-canvas.css','static/js/smart-canvas.js'])console.log(f+'='+v+'.'+Math.floor(fs.statSync(f).mtimeMs/1000))"
```

Update only the matching `/static/css/smart-canvas.css?v=...` and `/static/js/smart-canvas.js?v=...` query strings in `static/smart-canvas.html`.

- [ ] **Step 2: Run focused source gates**

Run:

```powershell
node --test tools/tests/smart-text-edit-integration.test.mjs tools/tests/smart-text-generation-settings.test.mjs tools/tests/static-cache-integrity.test.mjs
node tools/audit-text-encoding.mjs
git diff --check
```

Expected: every command exits `0` and the encoding audit reports no new mojibake.

- [ ] **Step 3: Verify real UI behavior at multiple zoom levels without generating an image**

Use the existing HstarA service at `http://127.0.0.1:3000/`:

1. Open a smart-canvas image’s “修改文字” window, then open “选择生图模型”.
2. Confirm “生成引擎” keeps its current size.
3. Confirm API platform, model, size, resolution, quality, and quantity appear as six full-width, evenly spaced rows.
4. Open “尺寸” and verify it changes only the ratio.
5. Open “分辨率” and verify it shows exactly `1K / 2K / 4K`.
6. Select a generic model and verify all three resolution choices are enabled.
7. Select an explicitly fixed model such as a configured `*-4k` model and verify `1K / 2K` are disabled with the “该模型不支持” title.
8. Zoom the canvas to approximately `0.45`, `1.0`, and `2.2`; verify panel pixels, typography, and spacing remain stable while the panel follows the source node.
9. Move and resize the source node; verify the panel repositions and remains inside the visible canvas.
10. Scroll long content; verify “取消 / 确认” stays visible.
11. Check light and dark themes and inspect the browser console for errors.

Do not click “应用修改” against a paid provider.

- [ ] **Step 4: Run the complete source gate**

Run:

```powershell
powershell -ExecutionPolicy Bypass -File build/scripts/Test-HstarSource.ps1
```

Expected: exit `0`; record the exact Python, Node, OpenShop, desktop, build, encoding, secret, cache, and diff-check counts emitted by the gate.

- [ ] **Step 5: Preserve the working branch**

Do not commit, merge, push, clean, or revert unrelated worktree changes. Report modified files, exact verification results, the browser checks performed, the remaining paid-generation test gap, and the live `http://127.0.0.1:3000/` URL.
