# Online History Automatic Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the manual Online Image archive load-more button with bounded scroll-triggered loading while retaining 16-record pages and all existing performance protections.

**Architecture:** A non-interactive sentinel is observed by one armed `IntersectionObserver`. Each leave-and-reenter cycle can request one page through the existing `loadHistory` state machine; status text is separate from the sentinel and is visible only while a request is active.

**Tech Stack:** Static HTML/JavaScript, FastAPI history endpoint (unchanged), Node.js contract tests, in-app browser verification.

---

### Task 1: Add Bounded Automatic Archive Loading

**Files:**
- Modify: `tools/tests/online-history-performance.test.mjs`
- Modify: `static/online.html:207-211`
- Modify: `static/online.html:268-272`
- Modify: `static/online.html:715-753`
- Modify: `static/online.html:844-866`

- [ ] **Step 1: Replace the manual-loading assertions with failing automatic-loading assertions**

Replace the existing assertions that ban `IntersectionObserver` and require a click handler with:

```js
assert.doesNotMatch(onlineHtml, /<button[^>]+id="loadMoreTrigger"/);
assert.doesNotMatch(onlineHtml, /\.onclick\s*=\s*\(\)\s*=>\s*loadHistory\(false\)/);
assert.match(onlineHtml, /id="historyLoadSentinel"/);
assert.match(onlineHtml, /id="historyLoadStatus"[^>]+role="status"[^>]+aria-live="polite"/);
assert.match(onlineHtml, /let historyAutoLoadArmed = false, historyAutoObserver = null;/);
assert.equal((onlineHtml.match(/new\s+IntersectionObserver\s*\(/g) || []).length, 1);
assert.match(onlineHtml, /if\(!entry\.isIntersecting\)\s*{\s*historyAutoLoadArmed = true;\s*return;\s*}/);
assert.match(onlineHtml, /if\(!historyAutoLoadArmed \|\| isLoading \|\| !historyHasMore\) return;/);
assert.match(onlineHtml, /historyAutoLoadArmed = false;\s*loadHistory\(false\);/);
assert.match(onlineHtml, /rootMargin:\s*'0px 0px 320px 0px'/);
assert.match(onlineHtml, /historyAutoObserver\.observe\(document\.getElementById\('historyLoadSentinel'\)\)/);
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
```

Expected: FAIL because the page still contains the manual button and explicitly has no `IntersectionObserver`.

- [ ] **Step 3: Replace the button with a sentinel and transient status**

Replace the manual button with:

```html
<div id="historyLoadSentinel" class="h-px w-full" aria-hidden="true"></div>
<div id="historyLoadStatus" class="hidden py-8 text-center text-gray-400 text-[10px] font-bold uppercase tracking-widest" role="status" aria-live="polite"></div>
```

This removes all click and keyboard interaction while preserving an accessible loading announcement.

- [ ] **Step 4: Add observer state and setup helpers**

Add beside the existing history state:

```js
let historyAutoLoadArmed = false, historyAutoObserver = null;
```

Add before `window.onload`:

```js
function syncHistoryAutoObserver(){
    if(!historyAutoObserver) return;
    const sentinel = document.getElementById('historyLoadSentinel');
    if(historyHasMore) historyAutoObserver.observe(sentinel);
    else historyAutoObserver.unobserve(sentinel);
}
function setupHistoryAutoLoad(){
    historyAutoObserver = new IntersectionObserver(entries => {
        const entry = entries[0];
        if(!entry.isIntersecting){
            historyAutoLoadArmed = true;
            return;
        }
        if(!historyAutoLoadArmed || isLoading || !historyHasMore) return;
        historyAutoLoadArmed = false;
        loadHistory(false);
    }, {rootMargin:'0px 0px 320px 0px', threshold:0});
    historyAutoObserver.observe(document.getElementById('historyLoadSentinel'));
}
```

The initial armed value is false, so observing a sentinel already visible after first render cannot immediately cascade a second page.

- [ ] **Step 5: Convert loadHistory UI state from button state to status state**

Use the separate status element:

```js
const status = document.getElementById('historyLoadStatus');
status.classList.remove('hidden');
status.textContent = tr('online.loadingArchives');
```

Remove all `disabled`, `aria-disabled`, load-more label, and click-control operations. After applying a successful page, call:

```js
historyHasMore = Boolean(page.has_more);
syncHistoryAutoObserver();
```

In both error and `finally` paths, do not automatically retry. In `finally` hide the transient status:

```js
status.classList.add('hidden');
status.textContent = '';
isLoading = false;
runQueuedHistoryLoad();
```

- [ ] **Step 6: Initialize the observer after the first page**

Keep the initial `await loadHistory(true)`, then call:

```js
setupHistoryAutoLoad();
```

Remove the old `loadMoreTrigger.onclick` assignment. Keep bulk-delete listeners and manager attachment unchanged.

- [ ] **Step 7: Run focused and regression tests**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
node --test tools/tests/static-debug-output.test.mjs tools/tests/output-node-actions.test.mjs
```

Expected: automatic-loading contract passes and both selected regressions pass. Static cache integrity is verified after cache-key synchronization in Task 2.

- [ ] **Step 8: Commit the behavior change**

```powershell
git add static/online.html tools/tests/online-history-performance.test.mjs
git commit -m "feat: restore automatic online archive loading"
```

### Task 2: Refresh Cache Keys And Verify Runtime Behavior

**Files:**
- Modify through helper: `static/index.html`
- Modify through helper: static HTML references to `online.html` and its changed dependencies
- Test: `tools/tests/*.test.mjs`

- [ ] **Step 1: Synchronize static cache keys twice**

Run:

```powershell
py -3 -X utf8 -c "import sys; sys.path.insert(0, r'E:\Claude专业组\HstarA'); import main; main.sync_static_html_versions(); main.sync_static_html_versions()"
```

Expected: references to changed `online.html` converge after the second pass.

- [ ] **Step 2: Run the complete root test suite**

```powershell
node --test tools/tests/*.test.mjs
```

Expected: 52 tests pass, 0 fail.

- [ ] **Step 3: Restart only the engineering server**

Find the listener on port 3000, stop that process only, and start `E:\Claude专业组\HstarA\python\python.exe main.py` hidden from the HstarA working directory. Do not access or modify the stable software data/cache or any port-5000 process.

- [ ] **Step 4: Verify automatic loading in the in-app browser**

Open `http://127.0.0.1:3000/static/online.html`, reload, and verify:

```js
({
  cards: document.querySelectorAll('#masonry [data-history-ts]').length,
  hasManualButton: Boolean(document.querySelector('button#loadMoreTrigger')),
  statusHidden: document.getElementById('historyLoadStatus').classList.contains('hidden'),
  previewSources: [...document.querySelectorAll('#masonry img')].every(img =>
    (img.getAttribute('src') || '').startsWith('/api/media-preview?')
  ),
})
```

Expected initially: at most 16 cards, no manual button, idle status hidden, and all archive cards use previews.

Scroll the sentinel into the 320px prefetch margin. Expected: card count increases by at most 16. Wait while remaining at the bottom; expected: no additional cascade. Scroll away until the sentinel exits, then return; expected: one further page may load.

- [ ] **Step 5: Check source hygiene and commit cache-key changes**

```powershell
git diff --check
git add static/*.html
git commit -m "chore: refresh online archive auto-load cache key"
```

Expected: only synchronized cache-key references are staged, the worktree is clean after commit, and the engineering server remains available on port 3000.
