# OpenShop Generative Mention Capsules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make both OpenShop generative tools start in the compact selection-waiting state, expand after a new selection, and support inline blue `@` reference capsules that submit valid reference assets.

**Architecture:** Keep the generative workflow controller in `openshop-generative-tools.js`, but replace its textarea-specific prompt handling with a small structured DOM adapter that serializes contenteditable text and immutable mention tokens into the existing plain-text `prompt` contract. Extend the reference picker records with stable identity fields, reconcile prompt tokens whenever selection references change, and keep API/task persistence unchanged by converting tokens back to mentions before submission.

**Tech Stack:** Vanilla JavaScript, contenteditable/Selection/Range DOM APIs, Vitest + JSDOM, Playwright, OpenShop build script.

---

## File Map

- Modify `integrations/openshop/host/openshop-generative-tools.js`: startup state machine, contenteditable prompt adapter, mention interaction, reference reconciliation, and submission wiring.
- Modify `integrations/openshop/host/openshop-reference-manager.js`: expose stable picker identity and reference metadata already held by the manager.
- Modify `integrations/openshop/host/openshop-generative-tools.css`: contenteditable and blue capsule presentation without changing control layout.
- Modify `integrations/openshop/tests/hstar-generative-tools.test.js`: controller, token editing, synchronization, and request-contract tests.
- Modify `integrations/openshop/tests/hstar-reference-manager.test.js`: picker identity contract.
- Modify `integrations/openshop/tests/hstar-generative-tools.e2e.spec.js`: real compact-to-expanded and token editing browser flows for both tools.
- Modify `integrations/openshop/index.html`: apply the new OpenShop runtime revision to entry assets before building.
- Modify `main.py` and `static/js/openshop-host.js`: keep the host-side OpenShop runtime revision synchronized.
- Verify `tools/tests/static-cache-integrity.test.mjs`: enforce one revision across backend, host, and OpenShop assets.
- Regenerate `static/openshop/host/openshop-generative-tools.js`, `static/openshop/host/openshop-reference-manager.js`, and `static/openshop/host/openshop-generative-tools.css` with the existing build script.

### Task 1: Compact Startup State And Fresh Selection Gate

**Files:**
- Modify: `integrations/openshop/tests/hstar-generative-tools.test.js:247-315`
- Modify: `integrations/openshop/host/openshop-generative-tools.js:829-859`

- [ ] **Step 1: Write the failing startup tests**

Replace the old hidden-on-start expectation with an assertion that each tool clears a pre-existing selection, stays visible in compact form, and waits for a fresh selection:

```js
it.each(['generative-fill', 'local-redraw'])(
  'starts %s compact and expands only after a fresh selection',
  async toolId => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();

    controller.openTool(toolId);

    const bar = document.querySelector('[data-generative-operation-bar]');
    expect(editor.clearSelection).toHaveBeenCalledTimes(1);
    expect(editor.setTool).toHaveBeenCalledWith('marquee-rect');
    expect(controller.getState()).toMatchObject({
      activeTool:toolId,
      status:'selecting',
      collapsed:true,
      selectionActive:false,
      selectionCount:0,
      selectionRegions:[],
    });
    expect(bar.hidden).toBe(false);
    expect(bar.classList.contains('is-collapsed')).toBe(true);

    editor._selectionBounds = {x:30, y:40, w:180, h:120};
    window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
      detail:{
        reason:'marquee',
        hasSelection:true,
        regions:[{x:30, y:40, w:180, h:120}],
        regionCount:1,
        incomingBounds:{x:30, y:40, w:180, h:120},
      },
    }));

    expect(controller.getState()).toMatchObject({
      status:'ready',
      collapsed:false,
      selectionActive:false,
      selectionCount:1,
    });
    expect(bar.hidden).toBe(false);
    expect(bar.classList.contains('is-collapsed')).toBe(false);
    controller.destroy();
  },
);
```

- [ ] **Step 2: Run the focused test and verify failure**

Run from `integrations/openshop`:

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js -t "starts .* compact"
```

Expected: FAIL because `openTool()` currently reuses the old selection, does not call `clearSelection()`, and leaves `collapsed` false.

- [ ] **Step 3: Implement the fresh-selection startup transition**

Update `openTool()` so old geometry is cleared before the tool becomes active, the compact bar remains visible, and drawing itself still uses the existing pointerdown auto-hide behavior:

```js
function openTool(toolId){
  if(!TOOLS.has(toolId)) throw new Error('OpenShop 生成式功能不存在');
  if(state.activeTool === toolId){
    close();
    return getState();
  }
  if(typeof editor.clearSelection === 'function' && selectionAvailable()) editor.clearSelection();
  state.activeTool = toolId;
  state.error = '';
  state.expanded = false;
  state.collapsed = true;
  state.autoHidden = false;
  state.selectionActive = false;
  state.selectionCount = 0;
  state.selectionRegions = [];
  state.status = 'selecting';
  const current = clean(editor.state?.tool);
  if(SELECTION_TOOLS.has(current)) state.lastSelectionTool = current;
  const nextTool = SELECTION_TOOLS.has(state.lastSelectionTool) ? state.lastSelectionTool : 'marquee-rect';
  editor.setTool(nextTool);
  render();
  void Promise.all([
    referenceManager.syncSelectionRegions?.([]),
    referenceManager.setPrimaryMode?.(state.referenceMode),
  ]).then(() => {
    if(!state.destroyed && state.activeTool === toolId) render();
  }).catch(error => {
    if(!state.destroyed && state.activeTool === toolId) handlePrimaryReferenceError(error);
  });
  return getState();
}
```

- [ ] **Step 4: Run the startup and existing panel-state tests**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js -t "compact|selection is being drawn|zoom"
```

Expected: PASS. Update superseded assertions that expected the bar to be hidden immediately after activation; keep the assertion that canvas pointerdown hides it while drawing.

- [ ] **Step 5: Commit the state-machine change**

```powershell
git add integrations/openshop/host/openshop-generative-tools.js integrations/openshop/tests/hstar-generative-tools.test.js
git commit -m "fix: start OpenShop generative tools compact"
```

### Task 2: Stable Reference Picker Identity

**Files:**
- Modify: `integrations/openshop/tests/hstar-reference-manager.test.js:125-145`
- Modify: `integrations/openshop/host/openshop-reference-manager.js:575-585`

- [ ] **Step 1: Write the failing picker-contract test**

```js
it('exposes stable identity and mention metadata to prompt tokens', async () => {
  const {manager} = createHarness();
  manager.restore([{
    assetId:'a'.repeat(64),
    alias:'参考图1',
    mention:'@参考图1',
    sourceType:'library',
    order:0,
    width:1024,
    height:768,
  }]);

  expect(manager.itemsForMentionPicker('参考图')).toEqual([
    expect.objectContaining({
      assetId:'a'.repeat(64),
      referenceKey:'a'.repeat(64),
      alias:'参考图1',
      mention:'@参考图1',
      sourceType:'library',
    }),
  ]);
});
```

- [ ] **Step 2: Run the focused reference-manager test**

```powershell
npm run test:unit -- tests/hstar-reference-manager.test.js -t "stable identity"
```

Expected: FAIL because picker records currently omit `assetId` and `referenceKey`.

- [ ] **Step 3: Extend `itemsForMentionPicker()` without changing persistence**

```js
function itemsForMentionPicker(query=''){
  const needle = clean(query).toLowerCase();
  return allRecords()
    .filter(item => !needle || item.alias.toLowerCase().includes(needle))
    .map(item => ({
      assetId:item.assetId,
      referenceKey:item.assetId || item.thumbnailUrl || `${item.sourceType}:${item.alias}`,
      mention:`@${item.alias}`,
      alias:item.alias,
      sourceType:item.sourceType,
      selectionRegionIndex:item.selectionRegionIndex,
      thumbnailUrl:item.thumbnailUrl || item.dataUrl,
    }));
}
```

- [ ] **Step 4: Run the full reference-manager suite**

```powershell
npm run test:unit -- tests/hstar-reference-manager.test.js
```

Expected: PASS.

- [ ] **Step 5: Update the generative test harness identity records**

Give each mocked reference the same identity contract returned by the real manager:

```js
const references = [{
  assetId:PRIMARY_ASSET_ID,
  referenceKey:PRIMARY_ASSET_ID,
  alias:'参考图1',
  mention:'@参考图1',
  sourceType:'primary',
  order:0,
  thumbnailUrl:'/api/openshop/assets/primary',
}];
```

- [ ] **Step 6: Commit the picker contract**

```powershell
git add integrations/openshop/host/openshop-reference-manager.js integrations/openshop/tests/hstar-reference-manager.test.js integrations/openshop/tests/hstar-generative-tools.test.js
git commit -m "feat: expose OpenShop prompt reference identity"
```

### Task 3: Structured Contenteditable Prompt Adapter

**Files:**
- Modify: `integrations/openshop/tests/hstar-generative-tools.test.js:430-485`
- Modify: `integrations/openshop/host/openshop-generative-tools.js:78-113,652-679,760-769,1029-1056`

- [ ] **Step 1: Add failing tests for both tools and serialization**

```js
it.each(['generative-fill', 'local-redraw'])(
  'renders a shared contenteditable mention editor for %s',
  async toolId => {
    const {controller, editor} = createHarness();
    await controller.start();
    controller.openTool(toolId);
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    window.dispatchEvent(new CustomEvent('openshop:selection-changed'));

    const prompt = document.querySelector('[data-generative-prompt]');
    expect(prompt.tagName).toBe('DIV');
    expect(prompt.contentEditable).toBe('true');
    expect(prompt.getAttribute('role')).toBe('textbox');
    prompt.textContent = '保留主体\n增强光线';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));
    expect(controller.getState().prompt).toBe('保留主体\n增强光线');
    controller.destroy();
  },
);
```

- [ ] **Step 2: Run the shared-editor test and verify failure**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js -t "shared contenteditable"
```

Expected: FAIL because the prompt is still a textarea and input handling reads `.value`.

- [ ] **Step 3: Add structured prompt state and safe DOM conversion helpers**

Add `promptParts` and `promptRange` to controller state, then add these helpers near `syncPromptFromDom()`:

```js
function promptReferenceItems(){
  return referenceManager.itemsForMentionPicker?.('') || [];
}

function promptPartsFromText(value, references=promptReferenceItems()){
  const text = String(value || '');
  const candidates = references
    .filter(item => clean(item.mention))
    .sort((left, right) => right.mention.length - left.mention.length);
  const parts = [];
  let index = 0;
  while(index < text.length){
    const hit = candidates.find(item => text.startsWith(item.mention, index));
    if(hit){
      parts.push({type:'mention', referenceKey:hit.referenceKey, mention:hit.mention});
      index += hit.mention.length;
      continue;
    }
    const next = candidates.reduce((found, item) => {
      const position = text.indexOf(item.mention, index + 1);
      return position >= 0 && (found < 0 || position < found) ? position : found;
    }, -1);
    const end = next < 0 ? text.length : next;
    parts.push({type:'text', text:text.slice(index, end)});
    index = end;
  }
  return parts.length ? parts : [{type:'text', text:''}];
}

function promptTextFromParts(parts){
  return (Array.isArray(parts) ? parts : [])
    .map(part => part.type === 'mention' ? clean(part.mention) : String(part.text || ''))
    .join('')
    .slice(0, 8000);
}

function promptPartsHtml(parts){
  return (Array.isArray(parts) ? parts : []).map(part => {
    if(part.type !== 'mention') return escapeHtml(part.text);
    return `<span class="hstar-generative-mention-token" contenteditable="false" data-generative-mention-token="true" data-reference-key="${escapeHtml(part.referenceKey)}" data-mention="${escapeHtml(part.mention)}">${escapeHtml(part.mention)}</span>`;
  }).join('');
}

function promptPartsFromDom(editorNode){
  const parts = [];
  const blockTags = new Set(['DIV', 'P', 'LI', 'SECTION', 'ARTICLE', 'BLOCKQUOTE']);
  const walk = node => {
    if(node.nodeType === 3){
      if(node.textContent) parts.push({type:'text', text:node.textContent});
      return;
    }
    if(node.nodeType !== 1) return;
    if(node.matches?.('[data-generative-mention-token]')){
      parts.push({
        type:'mention',
        referenceKey:clean(node.dataset.referenceKey),
        mention:clean(node.dataset.mention || node.textContent),
      });
      return;
    }
    if(node.tagName === 'BR'){
      parts.push({type:'text', text:'\n'});
      return;
    }
    const isBlock = node !== editorNode && blockTags.has(node.tagName);
    if(isBlock && parts.length && !promptTextFromParts(parts).endsWith('\n')){
      parts.push({type:'text', text:'\n'});
    }
    node.childNodes.forEach(walk);
    if(isBlock && !promptTextFromParts(parts).endsWith('\n')){
      parts.push({type:'text', text:'\n'});
    }
  };
  editorNode.childNodes.forEach(walk);
  return parts.length ? parts : [{type:'text', text:''}];
}

function syncPromptFromDom(){
  const editorNode = documentRef.querySelector('[data-generative-operation-bar] [data-generative-prompt]');
  if(!editorNode) return;
  state.promptParts = promptPartsFromDom(editorNode);
  state.prompt = promptTextFromParts(state.promptParts);
}
```

- [ ] **Step 4: Render the contenteditable while preserving the existing layout hook**

Initialize `state.promptParts` as `[{type:'text', text:''}]`. Replace the textarea with:

```js
<div class="hstar-generative-prompt-editor" data-generative-prompt contenteditable="true" role="textbox" aria-multiline="true" data-placeholder="${state.activeTool === 'local-redraw' ? '请输入修改要求，输入 @ 可引用参考图…' : '请输入提示词，输入 @ 可引用参考图，也可以留空直接运行…'}">${promptPartsHtml(state.promptParts)}</div>
```

Update `handleBarInput()` to call `syncPromptFromDom()` before refreshing picker and validation state. Remove textarea-only `mentionRange()` and `.value` access.

- [ ] **Step 5: Migrate existing unit-test prompt writes**

Add this helper in the test file and replace direct `.value =` assignments:

```js
function setPrompt(prompt, value){
  prompt.textContent = value;
  prompt.dispatchEvent(new Event('input', {bubbles:true}));
}
```

- [ ] **Step 6: Run all generative unit tests**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js
```

Expected: PASS for text input and existing validation; mention insertion tests may still fail until Task 4.

- [ ] **Step 7: Commit the prompt adapter**

```powershell
git add integrations/openshop/host/openshop-generative-tools.js integrations/openshop/tests/hstar-generative-tools.test.js
git commit -m "refactor: add OpenShop structured prompt editor"
```

### Task 4: Mention Insertion, Capsule Deletion, Paste, And Reference Reconciliation

**Files:**
- Modify: `integrations/openshop/tests/hstar-generative-tools.test.js:440-690`
- Modify: `integrations/openshop/host/openshop-generative-tools.js:455-467,652-674,1029-1056,1179-1184,1243-1254,1267-1292`

- [ ] **Step 1: Add failing mention interaction tests**

```js
it.each(['generative-fill', 'local-redraw'])(
  'inserts and serializes a blue mention token for %s',
  async toolId => {
    const {controller, editor} = createHarness();
    await controller.start();
    controller.openTool(toolId);
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.focus();
    prompt.textContent = '替换为 @';
    const range = document.createRange();
    range.selectNodeContents(prompt);
    range.collapse(false);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    prompt.dispatchEvent(new Event('input', {bubbles:true}));

    expect(document.querySelector('[data-reference-mention-picker]').hidden).toBe(false);
    document.querySelector('[data-reference-mention="@参考图1"]').click();

    const token = prompt.querySelector('[data-generative-mention-token]');
    expect(token.textContent).toBe('@参考图1');
    expect(token.contentEditable).toBe('false');
    expect(controller.getState().prompt).toBe('替换为 @参考图1 ');
    controller.destroy();
  },
);

it('deletes capsules atomically, pastes plain text, and drops removed references', async () => {
  const {controller, editor, referenceManager} = createHarness();
  await controller.start();
  controller.openTool('local-redraw');
  editor._selectionBounds = {x:10, y:20, w:300, h:200};
  window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
  const prompt = document.querySelector('[data-generative-prompt]');
  prompt.innerHTML = '材质 <span class="hstar-generative-mention-token" contenteditable="false" data-generative-mention-token="true" data-reference-key="primary-key" data-mention="@参考图1">@参考图1</span> ';
  prompt.dispatchEvent(new Event('input', {bubbles:true}));

  const token = prompt.querySelector('[data-generative-mention-token]');
  const range = document.createRange();
  range.setStartAfter(token);
  range.collapse(true);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
  prompt.dispatchEvent(new KeyboardEvent('keydown', {key:'Backspace', bubbles:true}));
  expect(prompt.querySelector('[data-generative-mention-token]')).toBeNull();

  const paste = new Event('paste', {bubbles:true, cancelable:true});
  Object.defineProperty(paste, 'clipboardData', {
    value:{getData:type => type === 'text/plain' ? '<b>纯文本</b>' : ''},
  });
  prompt.dispatchEvent(paste);
  expect(prompt.querySelector('b')).toBeNull();
  expect(prompt.textContent).toContain('<b>纯文本</b>');

  referenceManager.itemsForMentionPicker.mockReturnValue([]);
  window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
  expect(controller.getState().prompt).not.toContain('@参考图1');
  controller.destroy();
});
```

- [ ] **Step 2: Run the mention tests and verify failure**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js -t "mention token|capsules atomically"
```

Expected: FAIL because generative fill has no picker, no token is inserted, and keydown/paste/reconciliation are not implemented.

- [ ] **Step 3: Make the picker available to both tools and preserve the caret range**

Remove the local-redraw guard from `mentionPickerHtml()`. Add delegated listeners in `ensureBar()`:

```js
bar.addEventListener('keydown', handlePromptKeyDown);
bar.addEventListener('paste', handlePromptPaste);
bar.addEventListener('pointerdown', event => {
  if(event.target.closest?.('[data-reference-mention]')) event.preventDefault();
});
```

Implement `rememberPromptRange()` by cloning the current collapsed Selection range only when it belongs to `[data-generative-prompt]`. Open the picker when text before the caret matches `/(^|\s)@[^\s@]*$/` for either active tool.

- [ ] **Step 4: Insert an immutable mention token at the saved Range**

```js
function insertMentionToken(editorNode, item){
  const selection = root.getSelection?.();
  const range = state.promptRange?.cloneRange?.() || documentRef.createRange();
  if(!state.promptRange){
    range.selectNodeContents(editorNode);
    range.collapse(false);
  }
  if(range.startContainer?.nodeType === 3 && range.startOffset > 0){
    const value = range.startContainer.textContent || '';
    if(value[range.startOffset - 1] === '@'){
      range.setStart(range.startContainer, range.startOffset - 1);
      range.deleteContents();
    }
  }
  const token = documentRef.createElement('span');
  token.className = 'hstar-generative-mention-token';
  token.contentEditable = 'false';
  token.dataset.generativeMentionToken = 'true';
  token.dataset.referenceKey = item.referenceKey;
  token.dataset.mention = item.mention;
  token.textContent = item.mention;
  range.insertNode(token);
  const spacer = documentRef.createTextNode(' ');
  token.after(spacer);
  range.setStartAfter(spacer);
  range.collapse(true);
  selection?.removeAllRanges();
  selection?.addRange(range);
  state.promptRange = range.cloneRange();
  state.mentionOpen = false;
  syncPromptFromDom();
  renderMentionPicker();
  editorNode.focus();
}
```

Resolve the clicked item from `promptReferenceItems()` by `mention` and call this function instead of `referenceManager.insertMention()`.

- [ ] **Step 5: Add atomic deletion and plain-text paste**

For collapsed Backspace/Delete, find the immediately adjacent `[data-generative-mention-token]`, remove the whole node, prevent the default, and call `syncPromptFromDom()`. For paste, prevent the default, delete the selected Range contents, insert one text node from `event.clipboardData.getData('text/plain').slice(0, 8000)`, restore the caret after it, and call `syncPromptFromDom()`.

- [ ] **Step 6: Reconcile tokens when references are removed or renumbered**

Add a stable reconciliation helper:

```js
function reconcilePromptReferences(items=promptReferenceItems()){
  const references = new Map(items.map(item => [item.referenceKey, item]));
  state.promptParts = (state.promptParts || []).flatMap(part => {
    if(part.type !== 'mention') return [part];
    const current = references.get(part.referenceKey);
    return current ? [{...part, mention:current.mention}] : [];
  });
  state.prompt = promptTextFromParts(state.promptParts);
}
```

Call it after `removeReference()` and after `syncSelectionRegions()` resolves, before `render()`. This removes deleted tokens and updates display mentions when surviving selection aliases are renumbered.

- [ ] **Step 7: Run all generative unit tests**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js
```

Expected: PASS, including insertion, deletion, paste, and selection synchronization.

- [ ] **Step 8: Commit mention interactions**

```powershell
git add integrations/openshop/host/openshop-generative-tools.js integrations/openshop/tests/hstar-generative-tools.test.js
git commit -m "feat: add OpenShop inline mention capsules"
```

### Task 5: Submit Generative-Fill References Through The Existing API Contract

**Files:**
- Modify: `integrations/openshop/tests/hstar-generative-tools.test.js:550-690`
- Modify: `integrations/openshop/host/openshop-generative-tools.js:969-989`

- [ ] **Step 1: Write the failing generative-fill request test**

```js
it('submits generative-fill mention references through snapshotForTask', async () => {
  const {controller, editor, referenceManager, generativeClient} = createHarness();
  editor._selectionBounds = {x:10, y:20, w:300, h:200};
  referenceManager.snapshotForTask.mockResolvedValue({
    primaryReferenceAssetId:'b'.repeat(64),
    references:[{
      assetId:'c'.repeat(64),
      alias:'参考图2',
      mention:'@参考图2',
      sourceType:'library',
      order:1,
    }],
  });
  await controller.start();
  controller.openTool('generative-fill');
  editor._selectionBounds = {x:10, y:20, w:300, h:200};
  window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
  setPrompt(document.querySelector('[data-generative-prompt]'), '使用 @参考图2 的材质');

  await controller.submit();

  expect(referenceManager.snapshotForTask).toHaveBeenCalledWith(expect.objectContaining({
    mode:'full',
    maxReferences:expect.any(Number),
    fullCompositeAsset:expect.any(Object),
  }));
  expect(generativeClient.createTask).toHaveBeenCalledWith(
    expect.any(Object),
    expect.objectContaining({
      prompt:'使用 @参考图2 的材质',
      primaryReferenceAssetId:'b'.repeat(64),
      references:[expect.objectContaining({mention:'@参考图2'})],
    }),
  );
});
```

- [ ] **Step 2: Run the focused submission test**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js -t "submits generative-fill mention"
```

Expected: FAIL because generative fill currently hard-codes `references:[]`.

- [ ] **Step 3: Use `snapshotForTask()` for both tools**

```js
const referenceSnapshot = await referenceManager.snapshotForTask({
  mode:state.activeTool === 'local-redraw' ? state.referenceMode : 'full',
  maxReferences:limits.maxReferences,
  fullCompositeAsset:sourceAsset,
});
```

Keep `referenceMode:'full'` in the generative-fill request so the existing server contract receives the same source mode while now receiving selected mention references.

- [ ] **Step 4: Run submission and full generative unit tests**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js
```

Expected: PASS with no regression in local-redraw request payloads.

- [ ] **Step 5: Commit API wiring**

```powershell
git add integrations/openshop/host/openshop-generative-tools.js integrations/openshop/tests/hstar-generative-tools.test.js
git commit -m "fix: submit OpenShop fill references"
```

### Task 6: Blue Capsule Styling Without Layout Changes

**Files:**
- Modify: `integrations/openshop/host/openshop-generative-tools.css:597-661,1247-1275,1812-1826`
- Modify: `integrations/openshop/tests/hstar-generative-tools.test.js:750-770`

- [ ] **Step 1: Add the failing stylesheet contract test**

```js
it('styles the prompt editor and inline mention capsules', () => {
  const styles = readFileSync(new URL('../host/openshop-generative-tools.css', import.meta.url), 'utf8');
  expect(styles).toContain('.hstar-generative-prompt-editor');
  expect(styles).toContain('.hstar-generative-mention-token');
  expect(styles).toMatch(/\.hstar-generative-mention-token\s*\{[^}]*background:\s*#2563eb/s);
  expect(styles).toMatch(/\.hstar-generative-prompt-editor\[data-placeholder\]:empty::before/);
});
```

- [ ] **Step 2: Run the stylesheet test and verify failure**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js -t "inline mention capsules"
```

Expected: FAIL because the CSS only targets `textarea`.

- [ ] **Step 3: Replace textarea selectors and add the compact blue token**

```css
.hstar-generative-prompt-editor {
  width: 100%;
  height: 100%;
  min-height: 0;
  max-height: none;
  overflow-y: auto;
  padding: 14px 16px 34px;
  color: #f2f2f3;
  border: 0;
  outline: 0;
  background: transparent;
  font-size: 12px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}

.hstar-generative-prompt-editor[data-placeholder]:empty::before {
  color: #9e9ea3;
  content: attr(data-placeholder);
  pointer-events: none;
}

.hstar-generative-mention-token {
  display: inline-flex;
  max-width: 100%;
  min-height: 20px;
  align-items: center;
  margin: 0 2px;
  padding: 1px 7px;
  overflow: hidden;
  color: #eff6ff;
  border: 1px solid #60a5fa;
  border-radius: 999px;
  background: #2563eb;
  box-shadow: inset 0 1px rgba(255, 255, 255, .16);
  font-size: 11px;
  line-height: 16px;
  text-overflow: ellipsis;
  vertical-align: text-bottom;
  white-space: nowrap;
}
```

Update every responsive `textarea` selector to `.hstar-generative-prompt-editor`; do not alter the generative controls, reference row, bottom toolbar, or compact-panel dimensions.

- [ ] **Step 4: Run the stylesheet and full generative unit tests**

```powershell
npm run test:unit -- tests/hstar-generative-tools.test.js
```

Expected: PASS.

- [ ] **Step 5: Commit visual styling**

```powershell
git add integrations/openshop/host/openshop-generative-tools.css integrations/openshop/tests/hstar-generative-tools.test.js
git commit -m "style: render OpenShop mentions as blue capsules"
```

### Task 7: Browser Regression Coverage For Both Tools

**Files:**
- Modify: `integrations/openshop/tests/hstar-generative-tools.e2e.spec.js:342-399,483-550,698-708`

- [ ] **Step 1: Update the browser flow to assert compact startup and full expansion**

For each tool, clear any prior selection, click the tool, and assert the compact state before drawing:

```js
for(const toolName of ['生成式填充', '局部重绘']){
  await page.evaluate(() => OS.clearSelection());
  await page.getByRole('button', {name:toolName}).click();
  const bar = page.locator('[data-generative-operation-bar]');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/is-collapsed/);
  await expect(bar.getByText('等待选区')).toBeVisible();
  await dragSelection(page);
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/is-collapsed/);
  await page.getByRole('button', {name:toolName}).click();
}
```

- [ ] **Step 2: Add an inline-token browser assertion for each tool**

```js
await page.getByRole('button', {name:toolName}).click();
await dragSelection(page);
const prompt = page.locator('[data-generative-prompt]');
await prompt.fill('把这里改成 @');
await page.locator('[data-reference-mention="@选区1"]').click();
const token = prompt.locator('[data-generative-mention-token]');
await expect(token).toHaveText('@选区1');
await expect(token).toHaveCSS('background-color', 'rgb(37, 99, 235)');
await expect.poll(() => page.evaluate(() => (
  window.__generativeE2E.controller.getState().prompt
))).toContain('@选区1');
```

Replace `toHaveValue()` with `toHaveText()` or controller-state assertions. Playwright `fill()` supports contenteditable elements. Replace browser-evaluated `.value =` assignments with `.textContent =` plus an `input` event.

- [ ] **Step 3: Run the focused browser suite and verify expected failures before the final build**

```powershell
npm run test:hstar:generative -- --grep "compact startup|inline token|runs selection"
```

Expected before source-to-static build: FAIL because the served static bundle does not contain the integration changes.

- [ ] **Step 4: Build integration sources into the served static tree**

Generate one new revision with `Get-Date -Format 'yyyy.MM.dd.HHmmssfffffff'`, then use `apply_patch` to replace `2026.07.24.2211000000000` with that exact value in:

- `main.py` at `OPENSHOP_RUNTIME_REVISION`.
- `static/js/openshop-host.js` at `OPENSHOP_RUNTIME_REVISION`.
- Every OpenShop entry asset query in `integrations/openshop/index.html`.

Run the build after the three source revisions match:

```powershell
npm run build:hstar
```

Expected: the build reports synchronized Hstar OpenShop assets and an `OPENSHOP_BUILD_SHA256` value. The copied `static/openshop/index.html` contains the same new runtime revision.

- [ ] **Step 5: Run cache integrity, unit, and browser suites**

```powershell
node ../../tools/tests/static-cache-integrity.test.mjs
npm run test:unit -- tests/hstar-reference-manager.test.js tests/hstar-generative-tools.test.js
npm run test:hstar:generative
```

Expected: all tests PASS at desktop, mobile, and 4K viewports.

- [ ] **Step 6: Commit tests and generated assets**

```powershell
git add integrations/openshop/tests/hstar-generative-tools.e2e.spec.js integrations/openshop/index.html main.py static/js/openshop-host.js static/openshop/host/openshop-generative-tools.js static/openshop/host/openshop-reference-manager.js static/openshop/host/openshop-generative-tools.css static/openshop/index.html
git commit -m "test: cover OpenShop generative mention workflow"
```

### Task 8: Formal Port 3000 Verification

**Files:**
- Verify: `http://127.0.0.1:3000/`
- Verify: `http://127.0.0.1:3000/static/openshop/index.html`

- [ ] **Step 1: Restart the formal HstarA service on port 3000**

Stop only the process currently listening on port 3000, then launch the repository's existing `run.bat` in a hidden window. Confirm no test server remains on port 3010.

- [ ] **Step 2: Verify health and runtime revision**

```powershell
Invoke-WebRequest http://127.0.0.1:3000/ -UseBasicParsing
Invoke-WebRequest http://127.0.0.1:3000/static/openshop/host/openshop-generative-tools.js -UseBasicParsing
```

Expected: both return HTTP 200 and the served controller contains `hstar-generative-mention-token`.

- [ ] **Step 3: Perform a real browser smoke test**

Using Playwright against port 3000:

1. Open an OpenShop project.
2. Activate `生成式填充`; verify compact visible state.
3. Draw a fresh selection; verify full panel opens.
4. Insert `@选区1`; verify the blue capsule is inside the editor.
5. Repeat the same sequence for `局部重绘`.
6. Remove a selection thumbnail; verify its capsule disappears and no red error banner appears.

- [ ] **Step 4: Inspect browser console and network failures**

Expected: no uncaught exceptions, no failed local asset requests, and no invalid reference-order or missing-reference API errors.

- [ ] **Step 5: Record final verification status**

Run:

```powershell
git status --short
git log -8 --oneline
```

Expected: only pre-existing unrelated workspace changes remain unstaged; all implementation commits are visible in the recent history.
