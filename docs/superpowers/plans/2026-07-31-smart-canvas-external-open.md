# Smart Canvas External Open Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a canvas-scaled `外部打开` dropdown to Smart Canvas image nodes that opens the active image in Photoshop, Illustrator, or a user-selected executable through Hstar's existing native APIs.

**Architecture:** Keep the Classic Canvas and backend untouched. Add a Smart Canvas-owned dropdown controller that captures the active node image URL, uses the existing external-open, executable-picker, and settings endpoints, and performs one explicit retry only after an executable is selected and saved.

**Tech Stack:** Vanilla browser JavaScript, CSS, FastAPI's existing routes, Node.js source-contract tests, PowerShell Hstar source gate.

---

## File Structure

- Create `tools/tests/smart-external-open.test.mjs`: toolbar order, menu content, API contract, lifecycle, and cache-revision assertions.
- Modify `static/js/smart-canvas.js`: toolbar action, dropdown state/controller, native API workflow, and lifecycle hooks.
- Modify `static/css/smart-canvas.css`: external menu minimum width while inheriting all existing text-menu presentation.
- Modify `static/smart-canvas.html`: advance Smart Canvas JS/CSS revisions so WebView2 and browsers load the implementation.

### Task 1: Add the failing Smart Canvas contract

**Files:**
- Create: `tools/tests/smart-external-open.test.mjs`

- [ ] **Step 1: Write the source contract**

Create a test that reads `smart-canvas.js`, `smart-canvas.css`, and `smart-canvas.html`, then asserts this behavior:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/smart-canvas.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../static/smart-canvas.html', import.meta.url), 'utf8');

const gridIndex = js.indexOf("{key:'grid'");
const externalIndex = js.indexOf("{key:'externalOpen'");
const downloadIndex = js.indexOf("{key:'download'");

assert.ok(gridIndex >= 0, 'smart image toolbar should keep the grid action');
assert.ok(externalIndex > gridIndex, 'external open should follow the grid action');
assert.ok(downloadIndex > externalIndex, 'download should follow external open');
assert.match(js, /key:'externalOpen'[\s\S]{0,140}dropdown:true/, 'external open should render a dropdown caret');
assert.match(js, /data-smart-external-app="photoshop"[\s\S]*用 Photoshop 打开/, 'menu should include Photoshop');
assert.match(js, /data-smart-external-app="illustrator"[\s\S]*用 Illustrator 打开/, 'menu should include Illustrator');
assert.match(js, /data-smart-external-app="custom"[\s\S]*用自定义软件打开/, 'menu should include custom software');
assert.match(js, /fetch\('\/api\/open-external-image'/, 'smart canvas should use the established external-open route');
assert.match(js, /fetch\('\/api\/native\/choose-executable'/, 'smart canvas should use the native executable picker');
assert.match(js, /fetch\('\/api\/software-settings\/external-app'/, 'smart canvas should persist executable bindings');
assert.match(js, /body:JSON\.stringify\(\{url, app\}\)/, 'external-open payload should preserve the active image URL and app');
assert.match(js, /body:JSON\.stringify\(\{app, path\}\)/, 'binding payload should preserve app and executable path');
assert.match(js, /function positionSmartExternalOpenMenu\(\)/, 'menu should have world-space positioning');
assert.match(js, /positionSmartExternalOpenMenu\(\);[\s\S]*positionSmartTextEditPanel\(\);/, 'viewport changes should reposition the menu');
assert.match(js, /closeSmartTextEditMenu\(\);[\s\S]{0,180}smartExternalOpenMenuState/, 'opening external menu should close text edit');
assert.match(js, /function openSmartTextEditMenu\([\s\S]{0,260}closeSmartExternalOpenMenu\(\);/, 'opening text edit should close external menu');
assert.match(js, /event\.key === 'Escape'[\s\S]{0,260}closeSmartExternalOpenMenu\(\)/, 'Escape should close the menu');
assert.match(css, /\.smart-external-open-menu\s*\{[^}]*min-width:158px;/, 'menu should fit all labels without wrapping');
assert.match(html, /smart-canvas\.css\?v=2026\.07\.31\.1/, 'page should request the revised stylesheet');
assert.match(html, /smart-canvas\.js\?v=2026\.07\.31\.1/, 'page should request the revised script');

console.log('smart external open tests passed');
```

- [ ] **Step 2: Run the contract and confirm RED**

Run: `node tools/tests/smart-external-open.test.mjs`

Expected: FAIL because the `externalOpen` toolbar action does not exist.

### Task 2: Implement the toolbar menu and native workflow

**Files:**
- Modify: `static/js/smart-canvas.js`
- Modify: `static/css/smart-canvas.css`
- Modify: `static/smart-canvas.html`
- Test: `tools/tests/smart-external-open.test.mjs`

- [ ] **Step 1: Add state and the ordered toolbar action**

Add `let smartExternalOpenMenuState = null;` beside `smartTextEditMenuState`. Insert this action directly after `grid`:

```js
{key:'externalOpen', icon:'external-link', label:'外部打开', enabled:canEditImage, dropdown:true},
```

Handle it before opening the image editor:

```js
if(action === 'externalOpen'){
    openSmartExternalOpenMenu(nodeId, index);
    return;
}
```

- [ ] **Step 2: Add the menu controller**

Mount `#smartExternalOpenMenu` under `world` with classes `smart-text-edit-menu smart-external-open-menu`. Store `{nodeId, imageIndex, url}` and render the three ordered commands using `data-smart-external-app`. Position the menu from the `externalOpen` toolbar button using the same screen-to-world conversion as `positionSmartTextEditMenu()`.

The click handler must capture state, close the menu, then call:

```js
openSmartImageInExternalApp(state.url, button.dataset.smartExternalApp);
```

- [ ] **Step 3: Add the existing API workflow**

Implement these focused helpers:

```js
async function requestSmartExternalImageOpen(url, app){
    const response = await fetch('/api/open-external-image', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({url, app})
    });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(data.detail || '启动外部程序失败');
    return data;
}

async function chooseSmartExternalExecutable(app){
    const response = await fetch('/api/native/choose-executable', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({app, force:true})
    });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(data.detail || '无法打开程序选择器');
    return String(data.path || '').trim();
}

async function saveSmartExternalExecutable(app, path){
    const response = await fetch('/api/software-settings/external-app', {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        body:JSON.stringify({app, path})
    });
    const data = await response.json().catch(() => ({}));
    if(!response.ok) throw new Error(data.detail || '保存软件位置失败');
}
```

`openSmartImageInExternalApp(url, app)` first calls the open route. On failure it opens the picker once; cancellation stops cleanly, while a selected path is saved and followed by exactly one retry. Final success or error uses `toast()`.

- [ ] **Step 4: Wire lifecycle and mutual exclusion**

Call `positionSmartExternalOpenMenu()` beside existing text-panel positioning on viewport transforms, node drag/resize, and window resize. Close it on render, outside mousedown, and Escape. `openSmartExternalOpenMenu()` closes the text menu; `openSmartTextEditMenu()` closes the external menu.

- [ ] **Step 5: Reuse the established menu design and revise caches**

Add only this CSS override:

```css
.smart-external-open-menu { min-width:158px; }
```

Change both Smart Canvas asset query strings in `static/smart-canvas.html` to `2026.07.31.1`.

- [ ] **Step 6: Run focused tests and confirm GREEN**

Run:

```powershell
node tools/tests/smart-external-open.test.mjs
node tools/tests/smart-text-edit-integration.test.mjs
node tools/tests/static-cache-integrity.test.mjs
```

Expected: all three commands exit `0`.

### Task 3: Verify the browser workflow and source health

**Files:**
- Verify: `static/js/smart-canvas.js`
- Verify: `static/css/smart-canvas.css`
- Verify: `static/smart-canvas.html`
- Verify: `tools/tests/smart-external-open.test.mjs`

- [ ] **Step 1: Run syntax, encoding, and diff checks**

Run:

```powershell
node --check static/js/smart-canvas.js
node tools/tests/text-encoding-health.test.mjs
git diff --check -- static/js/smart-canvas.js static/css/smart-canvas.css static/smart-canvas.html tools/tests/smart-external-open.test.mjs
```

Expected: every command exits `0` with no encoding or whitespace errors.

- [ ] **Step 2: Verify the engineering service**

Confirm `http://127.0.0.1:3000/static/smart-canvas.html` serves `2026.07.31.1`. In the browser, select a Smart Canvas image node and verify the toolbar order, dropdown alignment, three menu commands, outside click, Escape, and zoom positioning.

- [ ] **Step 3: Run the complete source gate**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/Test-HstarSource.ps1`

Expected: exit `0` with all Python, Node, desktop contract, encoding, and repository checks passing.

- [ ] **Step 4: Review the final diff**

Run: `git diff -- static/js/smart-canvas.js static/css/smart-canvas.css static/smart-canvas.html tools/tests/smart-external-open.test.mjs`

Confirm no backend, plugin, Classic Canvas, packaging, or unrelated files changed for this feature.
