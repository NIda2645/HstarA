# OpenShop Dual Font Selectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single OpenShop font selector with a Chinese selector above an English-and-other-languages selector while retaining one shared virtualized font list.

**Architecture:** Keep the font catalog service unchanged because it already emits `section-zh` and `section-en` row boundaries. The text-properties controller will retain the full catalog once, derive the active section rows when a trigger opens, and move one shared listbox beneath the active trigger. Both selectors continue to call the existing `selectFontFamily` and text-style application path.

**Tech Stack:** Vanilla JavaScript, DOM/ARIA listbox controls, CSS grid, Vitest with jsdom, Playwright.

---

### Task 1: Specify dual-selector behavior with failing unit tests

**Files:**
- Modify: `integrations/openshop/tests/hstar-text-properties.test.js`

- [ ] **Step 1: Add a focused dual-selector test**

Add a test after the existing text-tab activation test that starts the controller with `createSectionedCatalogRows()` and asserts two triggers, labels, mutually exclusive options, shared listbox identity, and current-family display:

```js
it('uses separate Chinese and English-or-other font selectors with one shared listbox', async () => {
  const rows = createSectionedCatalogRows();
  const {controller} = createHarness({catalogRows:rows});
  await controller.start();

  const chinese = document.querySelector('[data-text-family="zh"]');
  const other = document.querySelector('[data-text-family="other"]');
  const list = document.querySelector('[data-text-font-list]');

  expect(chinese).not.toBeNull();
  expect(other).not.toBeNull();
  expect(chinese.querySelector('[data-text-family-label]').textContent).toBe('Microsoft YaHei UI');
  expect(other.querySelector('[data-text-family-label]').textContent).toBe('选择字体');

  chinese.click();
  expect(list.closest('label')).toBe(chinese.closest('label'));
  expect(list.querySelector('[data-family="Virtual Font 0000"]')).not.toBeNull();
  expect(list.querySelector('[data-family="Virtual Font 1250"]')).toBeNull();

  other.click();
  expect(list.hidden).toBe(false);
  expect(list.closest('label')).toBe(other.closest('label'));
  expect(list.querySelector('[data-family="Virtual Font 1250"]')).not.toBeNull();
  expect(list.querySelector('[data-family="Virtual Font 0000"]')).toBeNull();
  controller.destroy();
});
```

- [ ] **Step 2: Update sectioned keyboard tests to address the intended trigger**

Use `[data-text-family="zh"]` when assertions target rows before `section-en`, and `[data-text-family="other"]` when assertions target rows after `section-en`. Preserve existing expectations for focus restoration, Escape, selection application, and virtual row bounds.

- [ ] **Step 3: Run the focused unit test and confirm RED**

Run:

```powershell
npx.cmd vitest run tests/hstar-text-properties.test.js -t "separate Chinese and English-or-other"
```

Expected: FAIL because only one unscoped `[data-text-family]` trigger exists.

- [ ] **Step 4: Commit the failing tests**

```powershell
git add integrations/openshop/tests/hstar-text-properties.test.js
git commit -m "test: specify dual OpenShop font selectors"
```

### Task 2: Implement shared listbox section switching

**Files:**
- Modify: `integrations/openshop/host/openshop-text-properties.js`
- Modify: `integrations/openshop/host/openshop-text-properties.css`
- Test: `integrations/openshop/tests/hstar-text-properties.test.js`

- [ ] **Step 1: Store the full row model and derive one section at a time**

Replace the single-trigger state with a full row cache, trigger collection, active section, and active trigger. Add a helper that slices existing catalog rows without another font request:

```js
let allFontRows = [];
let fontRows = [];
let fontTriggers = [];
let activeFontTrigger = null;
let activeFontSection = 'zh';

function fontRowsForSection(rows, section){
  const sectionKey = section === 'zh' ? 'section-zh' : 'section-en';
  const start = rows.findIndex(row => row.kind === 'section' && row.key === sectionKey);
  if(start < 0) return rows.filter(row => row.kind === 'font');
  const end = rows.findIndex((row, index) => index > start && row.kind === 'section');
  return rows.slice(start, end < 0 ? rows.length : end);
}
```

`updateFontRows()` must call `fontManager.catalogRows()` exactly once, store it in `allFontRows`, and refresh `fontRows` from `activeFontSection`.

- [ ] **Step 2: Render two labeled triggers and one listbox**

Replace the current single font label with:

```html
<div class="hstar-font-selectors hstar-text-property-wide" data-text-font-selectors>
  <label>中文字体
    <button type="button" class="hstar-font-select" data-text-family="zh" aria-haspopup="listbox" aria-expanded="false">
      <span data-text-family-label>选择字体</span><span aria-hidden="true">▾</span>
    </button>
  </label>
  <label>英文及其他语言字体
    <button type="button" class="hstar-font-select" data-text-family="other" aria-haspopup="listbox" aria-expanded="false">
      <span data-text-family-label>选择字体</span><span aria-hidden="true">▾</span>
    </button>
  </label>
  <div class="hstar-font-list" data-text-font-list role="listbox" hidden></div>
</div>
```

- [ ] **Step 3: Synchronize values without duplicating the selected family**

Determine the selected family's section from its row position in `allFontRows`. Set the matching trigger label to the grouped family, set the other label to `选择字体`, and preserve the existing mixed-value label on both controls:

```js
function sectionForFamily(family){
  const target = clean(family).toLowerCase();
  let section = 'other';
  for(const row of allFontRows){
    if(row.kind === 'section') section = row.key === 'section-zh' ? 'zh' : 'other';
    if(row.kind === 'font' && clean(row.family).toLowerCase() === target) return section;
  }
  return section;
}
```

- [ ] **Step 4: Reuse one popup for both triggers**

Bind the same mousedown, click, and keyboard handlers to each trigger. When opening, set `activeFontSection`, derive `fontRows`, move the existing listbox into `trigger.closest('label')`, reset only the active trigger's `aria-expanded`, and render the selected row. When switching triggers while open, keep the listbox open and swap its row model immediately.

- [ ] **Step 5: Update close, outside-click, refresh, and destroy paths**

`closeFontList()` must collapse every trigger and restore focus to `activeFontTrigger`. Outside-click detection must accept either trigger. Font refresh and subscription updates must continue to close the list, cancel pending animation frames, fetch catalog rows once, and synchronize both labels. Destroy must clear `allFontRows`, `fontRows`, `fontTriggers`, and active trigger state.

- [ ] **Step 6: Style the vertical selector stack**

Add focused CSS without changing the existing panel visual language:

```css
.hstar-font-selectors{position:relative;display:grid;gap:7px;min-width:0}
.hstar-font-selectors>label{position:relative;display:flex;flex-direction:column;gap:3px;min-width:0}
.hstar-font-select [data-text-family-label]{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
```

The existing `.hstar-font-list{top:46px}` rule remains valid because the shared listbox is moved into the active label before display.

- [ ] **Step 7: Run the unit suite and confirm GREEN**

Run:

```powershell
npx.cmd vitest run tests/hstar-text-properties.test.js tests/hstar-font-catalog.test.js
```

Expected: 2 files pass, including all virtual-list and font-application tests.

- [ ] **Step 8: Commit the implementation**

```powershell
git add integrations/openshop/host/openshop-text-properties.js integrations/openshop/host/openshop-text-properties.css integrations/openshop/tests/hstar-text-properties.test.js
git commit -m "feat: split OpenShop font selectors by language"
```

### Task 3: Verify the real editor layout and interaction

**Files:**
- Modify: `integrations/openshop/tests/hstar-text-properties.e2e.spec.js`

- [ ] **Step 1: Extend the editor interaction test**

In the existing text-properties editor test, assert both selectors are visible, open each one, and confirm category isolation using real font rows:

```js
const chineseTrigger = frame.locator('[data-text-family="zh"]');
const otherTrigger = frame.locator('[data-text-family="other"]');
await expect(chineseTrigger).toBeVisible();
await expect(otherTrigger).toBeVisible();
await chineseTrigger.click();
await expect(frame.locator('[data-text-font-list] [data-family="Microsoft YaHei UI"]')).toBeVisible();
await expect(frame.locator('[data-text-font-list] [data-family="Century Gothic"]')).toHaveCount(0);
await otherTrigger.click();
await expect(frame.locator('[data-text-font-list] [data-family="Century Gothic"]')).toBeVisible();
await expect(frame.locator('[data-text-font-list] [data-family="Microsoft YaHei UI"]')).toHaveCount(0);
```

- [ ] **Step 2: Restart the engineering service**

Stop only the Python process listening on port `3000`, then start `main.py` from `E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing`. Confirm `http://127.0.0.1:3000/` returns HTTP 200.

- [ ] **Step 3: Run the focused Playwright test**

Run:

```powershell
npx.cmd playwright test tests/hstar-text-properties.e2e.spec.js
```

Expected: all text-properties scenarios pass.

- [ ] **Step 4: Capture desktop and narrow screenshots**

Use Playwright at `1440x900` and `768x900` with the text tab active. Verify both selectors fit the right panel, the listbox opens below the active trigger, no control overlaps “字形/字号”, and panel scrolling remains available.

- [ ] **Step 5: Run final verification**

Run:

```powershell
npx.cmd vitest run tests/hstar-text-properties.test.js tests/hstar-font-catalog.test.js
git diff --check
```

Expected: all tests pass and `git diff --check` reports no errors.

- [ ] **Step 6: Commit the end-to-end coverage**

```powershell
git add integrations/openshop/tests/hstar-text-properties.e2e.spec.js
git commit -m "test: cover dual font selector workflow"
```
