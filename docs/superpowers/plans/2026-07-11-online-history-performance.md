# Online Image Archive Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bound Online Image archive startup work to 16 cached thumbnails and require explicit user action before loading additional history pages.

**Architecture:** Extend the existing history endpoint with an opt-in paged response while preserving its legacy array response. Reuse HstarA's existing `/api/media-preview` path-validated WebP cache, and refactor the Online Image archive to fetch 16 records at a time, insert each page through a `DocumentFragment`, and load originals only for lightbox/download/reuse actions.

**Tech Stack:** FastAPI, Python standard library, Pillow, vanilla JavaScript, HTML/CSS, Node.js test runner, Playwright/in-app browser verification.

---

## File Map

- Modify `main.py`: add opt-in history pagination without changing existing callers.
- Modify `static/online.html`: explicit page loading, cached preview URLs, asynchronous image decoding, stable off-screen rendering, and batched DOM insertion.
- Create `tools/tests/online-history-performance.test.mjs`: real Python pagination checks plus frontend contract checks.
- Verify `main.py` media-preview path validation rejects traversal and unmanaged local files before any image decode occurs.
- Modify top-level `static/*.html` cache keys only through the existing `sync_static_html_versions()` release mechanism.
- Keep `static/js/history-bulk-manager.js` unchanged unless a failing regression test proves loaded-card management is broken.

### Task 0: Checkpoint The Existing 2026.07.11 Release State

**Files:**
- Modify: `VERSION`
- Modify: `build/installer/Hstar.iss`
- Modify: `static/angle.html`
- Modify: `static/api-settings.html`
- Modify: `static/asset-manager.html`
- Modify: `static/canvas-list.html`
- Modify: `static/canvas.html`
- Modify: `static/comfyui-settings.html`
- Modify: `static/enhance.html`
- Modify: `static/gpt-chat.html`
- Modify: `static/index.html`
- Modify: `static/klein.html`
- Modify: `static/online.html`
- Modify: `static/smart-canvas.html`
- Modify: `static/zimage.html`

- [ ] **Step 1: Verify the existing dirty files are release-only changes**

Run:

```powershell
git diff -- VERSION build/installer/Hstar.iss static/*.html
```

Expected: version `2026.07.8` changes to `2026.07.11`, the installer output filename changes to `Hstar_Setup_2026.07.11`, and static query keys change to `2026.07.11.<mtime>` without feature logic changes.

- [ ] **Step 2: Run the current regression suite**

Run:

```powershell
node --test tools/tests/*.test.mjs
```

Expected: 51 tests pass and 0 fail.

- [ ] **Step 3: Commit the release checkpoint without staging installer output or staging payload**

Run:

```powershell
git add VERSION build/installer/Hstar.iss static/angle.html static/api-settings.html static/asset-manager.html static/canvas-list.html static/canvas.html static/comfyui-settings.html static/enhance.html static/gpt-chat.html static/index.html static/klein.html static/online.html static/smart-canvas.html static/zimage.html
git commit -m "chore: release Hstar 2026.07.11"
```

Expected: release files are committed; `build/installer/stage/` and the generated EXE remain untracked or ignored.

### Task 1: Add Backward-Compatible History Pagination

**Files:**
- Create: `tools/tests/online-history-performance.test.mjs`
- Modify: `main.py:17472`

- [ ] **Step 1: Write a failing real-code pagination test**

Create `tools/tests/online-history-performance.test.mjs` with this initial content:

```js
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const script = String.raw`
import asyncio
import json
import os
import tempfile
import main

records = [
    {"timestamp": 1, "type": "online", "images": ["/output/1.png"]},
    {"timestamp": 4, "type": "online", "images": ["/output/4.png"]},
    {"timestamp": 3, "type": "angle", "images": ["/output/3.png"]},
    {"timestamp": 2, "type": "online", "images": ["/output/2.png"]},
    {"timestamp": 5, "type": "online", "images": []},
]

with tempfile.TemporaryDirectory() as temp_dir:
    history_path = os.path.join(temp_dir, "history.json")
    with open(history_path, "w", encoding="utf-8") as handle:
        json.dump(records, handle)
    old_history_file = main.HISTORY_FILE
    main.HISTORY_FILE = history_path
    try:
        legacy = asyncio.run(main.get_history_api(type="online"))
        first = asyncio.run(main.get_history_api(type="online", paged=True, offset=0, limit=2))
        second = asyncio.run(main.get_history_api(type="online", paged=True, offset=2, limit=2))
        clamped = asyncio.run(main.get_history_api(type="online", paged=True, offset=-9, limit=999))
    finally:
        main.HISTORY_FILE = old_history_file

print(json.dumps({"legacy": legacy, "first": first, "second": second, "clamped": clamped}))
`;

const raw = execFileSync('py', ['-3', '-X', 'utf8', '-c', script], { encoding: 'utf8' });
const result = JSON.parse(raw.trim().split(/\r?\n/).at(-1));

assert.deepEqual(result.legacy.map(item => item.timestamp), [4, 2, 1]);
assert.deepEqual(result.first.items.map(item => item.timestamp), [4, 2]);
assert.equal(result.first.total, 3);
assert.equal(result.first.offset, 0);
assert.equal(result.first.next_offset, 2);
assert.equal(result.first.has_more, true);
assert.deepEqual(result.second.items.map(item => item.timestamp), [1]);
assert.equal(result.second.next_offset, null);
assert.equal(result.second.has_more, false);
assert.equal(result.clamped.offset, 0);
assert.equal(result.clamped.items.length, 3);

console.log('online history backend pagination tests passed');
```

- [ ] **Step 2: Run the new test and verify RED**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
```

Expected: FAIL because `get_history_api` does not accept `paged`, `offset`, or `limit`.

- [ ] **Step 3: Implement minimal opt-in pagination**

Replace the existing history route with a helper plus compatible route:

```python
def read_history_records(history_type: str = None):
    if not os.path.exists(HISTORY_FILE):
        return []
    try:
        with open(HISTORY_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
        if history_type:
            data = [item for item in data if item.get("type", "zimage") == history_type]
        data = [item for item in data if item.get("images") and len(item["images"]) > 0]
        data.sort(
            key=lambda item: float(item.get("timestamp", 0))
            if isinstance(item.get("timestamp", 0), (int, float)) else 0,
            reverse=True,
        )
        return data
    except Exception as exc:
        print(f"读取历史文件失败: {exc}")
        return []


@app.get("/api/history")
async def get_history_api(
    type: str = None,
    paged: bool = False,
    offset: int = 0,
    limit: int = 24,
):
    data = read_history_records(type)
    if not paged:
        return data
    safe_offset = max(0, int(offset or 0))
    safe_limit = max(1, min(50, int(limit or 24)))
    items = data[safe_offset:safe_offset + safe_limit]
    next_offset = safe_offset + len(items)
    has_more = next_offset < len(data)
    return {
        "items": items,
        "total": len(data),
        "offset": safe_offset,
        "next_offset": next_offset if has_more else None,
        "has_more": has_more,
    }
```

- [ ] **Step 4: Run pagination and existing API tests**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
node --test tools/tests/api-settings-protocol-override.test.mjs tools/tests/image-marker-api-route.test.mjs
```

Expected: pagination test passes; selected API regression tests pass.

- [ ] **Step 5: Commit backend pagination**

Run:

```powershell
git add main.py tools/tests/online-history-performance.test.mjs
git commit -m "perf: paginate online image history"
```

### Task 2: Bound Frontend Loading And Remove Automatic Cascades

**Files:**
- Modify: `tools/tests/online-history-performance.test.mjs`
- Modify: `static/online.html:268`
- Modify: `static/online.html:653`
- Modify: `static/online.html:740`

- [ ] **Step 1: Add failing frontend contract assertions**

Append to `tools/tests/online-history-performance.test.mjs`:

```js
import fs from 'node:fs';

const online = fs.readFileSync('static/online.html', 'utf8');
assert.match(online, /const PAGE_SIZE = 16;/);
assert.match(online, /\/api\/history\?type=online&paged=1&offset=\$\{historyOffset\}&limit=\$\{PAGE_SIZE\}/);
assert.match(online, /historyOffset = page\.next_offset/);
assert.match(online, /historyHasMore = Boolean\(page\.has_more\)/);
assert.doesNotMatch(online, /new IntersectionObserver\(/);
assert.match(online, /loadMoreTrigger['"]\)\.onclick = \(\) => loadHistory\(false\)/);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
```

Expected: backend assertions pass, frontend assertions fail on `PAGE_SIZE = 24`, the unpaged request, and `IntersectionObserver`.

- [ ] **Step 3: Replace archive state and loading logic**

Use bounded state:

```js
let currentResult = null, currentLightboxData = null, isLoading = false;
let historyOffset = 0, historyHasMore = true;
const PAGE_SIZE = 16;
```

Replace `loadHistory` with:

```js
async function loadHistory(reset=false){
    if(isLoading || (!reset && !historyHasMore)) return;
    isLoading = true;
    const loader = document.getElementById('loadMoreTrigger');
    loader.classList.remove('hidden');
    loader.setAttribute('aria-disabled', 'true');
    loader.innerText = tr('online.loadingArchives');
    if(reset){
        historyOffset = 0;
        historyHasMore = true;
        document.getElementById('masonry').innerHTML = '';
    }
    try {
        const page = await fetch(`/api/history?type=online&paged=1&offset=${historyOffset}&limit=${PAGE_SIZE}`).then(async response => {
            if(!response.ok) throw new Error(`HTTP ${response.status}`);
            return response.json();
        });
        renderHistoryBatch(Array.isArray(page.items) ? page.items : []);
        historyOffset = page.next_offset;
        historyHasMore = Boolean(page.has_more);
        loader.classList.toggle('hidden', !historyHasMore);
        loader.innerText = tr('online.loadMore');
    } catch(error) {
        loader.classList.remove('hidden');
        loader.innerText = tr('online.loadMore');
        console.error('Failed to load online archive:', error);
    } finally {
        loader.removeAttribute('aria-disabled');
        isLoading = false;
    }
}
```

Replace startup observation with explicit loading:

```js
window.onload = async () => {
    applyLanguage();
    setRatio('square');
    setResolution('1k');
    await initModels();
    await loadHistory(true);
    window.HistoryBulkManager?.attach({masonry:'#masonry'});
    document.getElementById('loadMoreTrigger').onclick = () => loadHistory(false);
};
```

- [ ] **Step 4: Run the frontend contract test**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
```

Expected: backend and explicit-pagination assertions pass.

- [ ] **Step 5: Commit bounded frontend paging**

Run:

```powershell
git add static/online.html tools/tests/online-history-performance.test.mjs
git commit -m "perf: bound online archive page loading"
```

### Task 3: Render Cached Thumbnails In One DOM Batch

**Files:**
- Modify: `tools/tests/online-history-performance.test.mjs`
- Modify: `static/online.html:58`
- Modify: `static/online.html:639`
- Verify existing: `main.py:6296-6410`

- [ ] **Step 1: Add failing thumbnail and rendering assertions**

Append:

```js
const py = fs.readFileSync('main.py', 'utf8');
assert.match(online, /function historyPreviewUrl\(url\)/);
assert.match(online, /\/api\/media-preview\?url=\$\{encodeURIComponent\(url\)\}&w=480/);
assert.match(online, /loading="lazy" decoding="async" fetchpriority="low"/);
assert.match(online, /const fragment = document\.createDocumentFragment\(\)/);
assert.match(online, /masonry\.appendChild\(fragment\)/);
assert.doesNotMatch(online, /next\.forEach\(item => renderImageCard\(item\)\)/);
assert.doesNotMatch(online, /function renderImageCard[\s\S]*?lucide\.createIcons\(\);\s*\}/);
assert.match(online, /content-visibility:\s*auto/);
assert.match(online, /contain-intrinsic-size:\s*320px 320px/);
assert.match(online, /img\.src = originalUrl/);
assert.match(py, /def remove_media_preview_cache\(path: str, widths=\(480,\)\):/);
assert.match(py, /remove_media_preview_cache\(file_path, widths=\(480,\)\)/);
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
```

Expected: fails because cards still use original URLs, insert individually, and call `lucide.createIcons()` per card.

- [ ] **Step 3: Add a real cached-preview characterization test**

Append a second Python probe to the test file:

```js
const previewScript = String.raw`
import asyncio
import json
import os
import tempfile
from fastapi import HTTPException
from PIL import Image
import main

with tempfile.TemporaryDirectory() as root:
    output_dir = os.path.join(root, "output")
    cache_dir = os.path.join(root, "cache")
    os.makedirs(output_dir)
    source_path = os.path.join(output_dir, "large.png")
    Image.new("RGB", (1200, 800), (20, 40, 60)).save(source_path)
    old_output_dir = main.OUTPUT_DIR
    old_preview_dir = main.MEDIA_PREVIEW_DIR
    main.OUTPUT_DIR = output_dir
    main.MEDIA_PREVIEW_DIR = cache_dir
    try:
        first = asyncio.run(main.media_preview("/output/large.png", 480))
        second = asyncio.run(main.media_preview("/output/large.png", 480))
        with Image.open(first.path) as preview:
            size = list(preview.size)
        try:
            asyncio.run(main.media_preview("/output/../outside.png", 480))
            traversal_status = 200
        except HTTPException as exc:
            traversal_status = exc.status_code
    finally:
        main.OUTPUT_DIR = old_output_dir
        main.MEDIA_PREVIEW_DIR = old_preview_dir

print(json.dumps({
    "same_path": first.path == second.path,
    "size": size,
    "traversal_status": traversal_status,
}))
`;

const previewRaw = execFileSync('py', ['-3', '-X', 'utf8', '-c', previewScript], { encoding: 'utf8' });
const preview = JSON.parse(previewRaw.trim().split(/\r?\n/).at(-1));
assert.equal(preview.same_path, true);
assert.ok(Math.max(...preview.size) <= 480);
assert.equal(preview.traversal_status, 404);
```

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
```

Expected: the existing `/api/media-preview` characterization assertions pass, while the new frontend and cache-cleanup assertions remain RED.

- [ ] **Step 4: Add stable off-screen rendering CSS**

Extend `.masonry-item`:

```css
.masonry-item {
    aspect-ratio:1/1;
    border-radius:24px;
    overflow:hidden;
    background:#fff;
    border:1px solid #f1f5f9;
    transition:all .5s var(--easing);
    content-visibility:auto;
    contain-intrinsic-size:320px 320px;
}
```

- [ ] **Step 5: Separate card creation from insertion and use previews**

Implement:

```js
function historyPreviewUrl(url){
    return `/api/media-preview?url=${encodeURIComponent(url)}&w=480`;
}

function createImageCard(data){
    if(!data.images?.[0] || document.getElementById(`history-${data.timestamp}`)) return null;
    const originalUrl = data.images[0];
    const card = document.createElement('div');
    card.id = `history-${data.timestamp}`;
    card.dataset.historyTs = data.timestamp;
    card.className = 'masonry-item group relative cursor-zoom-in';
    card.onclick = () => {
        if(document.body.classList.contains('history-bulk-selecting')) return;
        openLightbox(data);
    };
    const multi = Array.isArray(data.images) && data.images.length > 1
        ? `<div class="absolute top-3 right-3 bg-black/60 text-white text-[10px] font-black px-2 py-0.5 rounded-full pointer-events-none">x${data.images.length}</div>`
        : '';
    card.innerHTML = `<img src="${escapeHtml(historyPreviewUrl(originalUrl))}" class="w-full h-full object-cover block group-hover:scale-105 transition-transform duration-1000" loading="lazy" decoding="async" fetchpriority="low">${multi}
        <div class="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 p-6 flex flex-col justify-end"><p class="text-white text-[10px] font-medium line-clamp-2 uppercase tracking-wider">${escapeHtml(data.prompt || tr('online.onlineImageFallback'))}</p></div>`;
    const img = card.querySelector('img');
    img.addEventListener('error', () => {
        if(img.src !== originalUrl) img.src = originalUrl;
    }, {once:true});
    return card;
}

function renderImageCard(data, isNew=false){
    const card = createImageCard(data);
    if(!card) return;
    const masonry = document.getElementById('masonry');
    isNew ? masonry.prepend(card) : masonry.appendChild(card);
}

function renderHistoryBatch(items){
    const masonry = document.getElementById('masonry');
    const fragment = document.createDocumentFragment();
    items.forEach(item => {
        const card = createImageCard(item);
        if(card) fragment.appendChild(card);
    });
    masonry.appendChild(fragment);
}
```

Keep `openLightbox`, `downloadLightboxImage`, `applySameStyle`, and generation request data pointed at `data.images[0]`, never the preview URL.

- [ ] **Step 6: Add best-effort preview cleanup to history deletion**

Add after `media_preview_cache_paths`:

```python
def remove_media_preview_cache(path: str, widths=(480,)):
    for width in widths:
        try:
            cache_paths = media_preview_cache_paths(path, int(width))
        except OSError:
            continue
        for cache_path in cache_paths:
            try:
                os.remove(cache_path)
            except FileNotFoundError:
                pass
            except OSError:
                pass
```

Before deleting each history image source in `delete_history`, call:

```python
remove_media_preview_cache(file_path, widths=(480,))
os.remove(file_path)
```

Thumbnail cleanup remains best-effort: failure cannot prevent the authoritative history record and original image deletion.

- [ ] **Step 7: Run thumbnail/frontend tests**

Run:

```powershell
node tools/tests/online-history-performance.test.mjs
node --test tools/tests/static-debug-output.test.mjs tools/tests/output-node-actions.test.mjs
```

Expected: all selected tests pass.

- [ ] **Step 8: Commit thumbnail rendering and cleanup**

Run:

```powershell
git add main.py static/online.html tools/tests/online-history-performance.test.mjs
git commit -m "perf: render cached online archive thumbnails"
```

### Task 4: Refresh Cache Keys And Run Full Verification

**Files:**
- Modify through existing helper: `static/index.html`
- Test: `tools/tests/online-history-performance.test.mjs`
- Test: all `tools/tests/*.test.mjs`
- Test: all `integrations/storyai-3d-director-desk/src/**/*.test.*`

- [ ] **Step 1: Synchronize static cache keys twice**

Run:

```powershell
.\python\python.exe -c "import sys; sys.path.insert(0, r'E:\Claude专业组\HstarA'); import main; main.sync_static_html_versions(); main.sync_static_html_versions()"
```

Expected: `static/index.html` updates the `online.html` mtime key and the second pass converges HTML-to-HTML references.

- [ ] **Step 2: Run the complete root suite**

Run:

```powershell
node --test tools/tests/*.test.mjs
```

Expected: 52 tests pass after adding the new test file, 0 fail.

- [ ] **Step 3: Run the complete 3D director suite**

Run:

```powershell
cd integrations/storyai-3d-director-desk
npm.cmd test -- --reporter=dot
```

Expected: 36 test files and 322 tests pass.

- [ ] **Step 4: Verify runtime behavior in the in-app browser**

Open `http://127.0.0.1:3000/static/online.html`, reload, and verify through browser evaluation/network inspection:

```js
({
  cards: document.querySelectorAll('#masonry [data-history-ts]').length,
  hasLoadMore: !document.getElementById('loadMoreTrigger').classList.contains('hidden'),
  sources: [...document.querySelectorAll('#masonry img')].map(img => img.getAttribute('src')),
})
```

Expected after initial load:

- `cards` is at most 16.
- Every successful card source begins with `/api/media-preview?`.
- Clicking Load More adds at most 16 cards.
- Scrolling without clicking does not add cards.
- Opening a card loads its original `/output/` or `/assets/` URL in the lightbox.
- Management mode, selection, deletion, and exit remain usable.

- [ ] **Step 5: Measure the optimized history response**

Run:

```powershell
$response = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/history?type=online&paged=1&offset=0&limit=16'
$page = $response.Content | ConvertFrom-Json
[pscustomobject]@{
    Records = @($page.items).Count
    Bytes = [Text.Encoding]::UTF8.GetByteCount($response.Content)
    HasMore = $page.has_more
}
```

Expected: 16 records, response size substantially below the prior 2,814,173-byte baseline, and `HasMore=True` for the current 457-record archive.

- [ ] **Step 6: Check source hygiene and commit cache-key updates**

Run:

```powershell
git diff --check
git status -sb
git add static/index.html
git commit -m "chore: refresh online archive cache key"
```

Expected: no source whitespace errors outside generated bundles; only intentional commits remain.
