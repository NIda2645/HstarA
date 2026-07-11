import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const onlineHtml = readFileSync(join(repoRoot, 'static', 'online.html'), 'utf8');
const bulkManagerJs = readFileSync(join(repoRoot, 'static', 'js', 'history-bulk-manager.js'), 'utf8');
const mainPy = readFileSync(join(repoRoot, 'main.py'), 'utf8');

assert.match(onlineHtml, /const PAGE_SIZE = 16;/);
assert.ok(
  onlineHtml.includes('`/api/history?type=online&paged=1&offset=${historyOffset}&limit=${PAGE_SIZE}`'),
  'online history must request one bounded backend page',
);
assert.match(onlineHtml, /historyOffset = page\.next_offset \?\? \(page\.offset \+ items\.length\);/);
assert.match(onlineHtml, /historyHasMore = Boolean\(page\.has_more\)/);
assert.doesNotMatch(onlineHtml, /new\s+IntersectionObserver\s*\(/);
assert.match(
  onlineHtml,
  /document\.getElementById\('loadMoreTrigger'\)\.onclick = \(\) => loadHistory\(false\)/,
);
assert.doesNotMatch(onlineHtml, /new\s+MutationObserver\s*\(/);
assert.doesNotMatch(onlineHtml, /historyResetPending|invalidateHistory/);
assert.match(onlineHtml, /let historyRevision = 0, historyMutationDepth = 0, queuedHistoryLoad = null;/);
assert.match(
  onlineHtml,
  /function beginHistoryMutation\(\)\s*{\s*historyRevision \+= 1;\s*historyMutationDepth \+= 1;\s*}/,
);
assert.match(
  onlineHtml,
  /function queueHistoryLoad\(reset\)\s*{\s*if\(queuedHistoryLoad === null \|\| reset\) queuedHistoryLoad = reset;\s*}/,
);
assert.match(
  onlineHtml,
  /function runQueuedHistoryLoad\(\)\s*{\s*if\(historyMutationDepth > 0 \|\| isLoading \|\| queuedHistoryLoad === null\) return;\s*const reset = queuedHistoryLoad;\s*queuedHistoryLoad = null;\s*loadHistory\(reset\);\s*}/,
);
assert.match(
  onlineHtml,
  /function finishHistoryMutation\(offsetDelta=0\)\s*{\s*historyOffset = Math\.max\(0, historyOffset \+ offsetDelta\);\s*historyMutationDepth = Math\.max\(0, historyMutationDepth - 1\);\s*if\(historyMutationDepth === 0\) runQueuedHistoryLoad\(\);\s*}/,
);
assert.match(
  onlineHtml,
  /if\(historyMutationDepth > 0\)\s*{\s*queueHistoryLoad\(reset\);\s*return;\s*}/,
  'history GETs must queue while mutations are in flight',
);
assert.match(onlineHtml, /const requestRevision = historyRevision;/);
assert.ok(
  onlineHtml.indexOf('const requestRevision = historyRevision;')
    < onlineHtml.indexOf('const response = await fetch(`/api/history?type=online'),
  'history requests must capture the mutation revision before fetching',
);
const staleResponseGuard = 'if(requestRevision !== historyRevision){';
assert.match(
  onlineHtml,
  /if\(requestRevision !== historyRevision\)\s*{\s*queueHistoryLoad\(reset\);\s*return;\s*}/,
  'stale history responses must queue the same request mode',
);
assert.ok(
  onlineHtml.indexOf(staleResponseGuard) < onlineHtml.indexOf('renderHistoryBatch(items);'),
  'stale history responses must be rejected before rendering',
);
assert.match(
  onlineHtml,
  /finally\s*{\s*if\(requestRevision !== historyRevision\) queueHistoryLoad\(reset\);[\s\S]*isLoading = false;\s*runQueuedHistoryLoad\(\);/,
);

const generationSource = onlineHtml.slice(
  onlineHtml.indexOf('async function submitImage()'),
  onlineHtml.indexOf('function renderImageCard'),
);
assert.ok(
  generationSource.indexOf('beginHistoryMutation();') < generationSource.indexOf("fetch('/api/online-image'"),
  'generation must begin its mutation before POSTing',
);
assert.match(generationSource, /let historyDelta = 0;[\s\S]*renderImageCard\(result, true\);\s*historyDelta = 1;/);
assert.match(generationSource, /finally\s*{\s*finishHistoryMutation\(historyDelta\);/);
assert.doesNotMatch(generationSource, /loadHistory\(true\)|masonry[^\n]*innerHTML/);

const singleDeleteSource = onlineHtml.slice(
  onlineHtml.indexOf('async function deleteHistoryItem'),
  onlineHtml.indexOf('window.onload'),
);
assert.ok(
  singleDeleteSource.indexOf('beginHistoryMutation();') < singleDeleteSource.indexOf("fetch('/api/history/delete'"),
  'single deletion must begin its mutation before POSTing',
);
assert.match(
  singleDeleteSource,
  /let historyDelta = 0;[\s\S]*if\(card\)\s*{\s*card\.remove\(\);\s*historyDelta = -1;\s*}/,
);
assert.match(singleDeleteSource, /finally\s*{\s*finishHistoryMutation\(historyDelta\);\s*}/);
assert.doesNotMatch(singleDeleteSource, /loadHistory\(true\)|masonry[^\n]*innerHTML/);

const bulkStartEvent = "masonry.dispatchEvent(new CustomEvent('history-bulk-delete-start'));";
const bulkRequests = 'const results = await Promise.allSettled';
const bulkUiDecision = 'if(selectedCards().length === 0 && cards().length === 0){ exit(); }';
const bulkFinishEvent = "masonry.dispatchEvent(new CustomEvent('history-bulk-delete-finish', {detail:{successCount}}));";
assert.ok(bulkManagerJs.indexOf(bulkStartEvent) < bulkManagerJs.indexOf(bulkRequests));
assert.ok(bulkManagerJs.indexOf(bulkFinishEvent) > bulkManagerJs.indexOf(bulkUiDecision));
assert.match(bulkManagerJs, /let successCount = 0;\s*masonry\.dispatchEvent\(new CustomEvent\('history-bulk-delete-start'\)\);\s*try\s*{/);
assert.match(
  bulkManagerJs,
  /successCount = results\.filter\(result => result\.status === 'fulfilled'\)\.length;/,
);
assert.match(
  bulkManagerJs,
  /finally\s*{\s*masonry\.dispatchEvent\(new CustomEvent\('history-bulk-delete-finish', {detail:{successCount}}\)\);\s*}/,
);
assert.doesNotMatch(bulkManagerJs, /history-bulk-delete-success/);
assert.match(
  onlineHtml,
  /masonry\.addEventListener\('history-bulk-delete-start', beginHistoryMutation\);/,
);
assert.match(
  onlineHtml,
  /masonry\.addEventListener\('history-bulk-delete-finish', event =>\s*{\s*const successCount = Number\(event\.detail\?\.successCount\) \|\| 0;\s*finishHistoryMutation\(-successCount\);\s*}\);/,
);
const bulkListenerSource = onlineHtml.slice(
  onlineHtml.indexOf("masonry.addEventListener('history-bulk-delete-start'"),
  onlineHtml.indexOf("window.HistoryBulkManager?.attach({masonry:'#masonry'})"),
);
assert.doesNotMatch(bulkListenerSource, /loadHistory\(true\)|innerHTML/);
assert.match(onlineHtml, /<button\s+type="button"\s+id="loadMoreTrigger"/);
assert.doesNotMatch(onlineHtml, /<div\s+id="loadMoreTrigger"/);
assert.match(
  onlineHtml,
  /<button[^>]+id="loadMoreTrigger"[^>]+class="[^"]*\bw-full\b[^"]*\bfocus-visible:ring-2\b[^"]*"/,
);
assert.match(onlineHtml, /loader\.disabled = true;/);
assert.match(onlineHtml, /finally\s*{[^}]*loader\.disabled = false;/s);

const pythonEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};

const bundledCandidates = process.platform === 'win32'
  ? [join(repoRoot, 'python', 'python.exe')]
  : [join(repoRoot, 'python', 'bin', 'python3'), join(repoRoot, 'python', 'bin', 'python')];
const fallbackCandidates = process.platform === 'win32'
  ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
  : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
const pythonCandidates = [
  ...bundledCandidates.filter(existsSync).map((command) => ({ command, args: [] })),
  ...fallbackCandidates,
];

const python = pythonCandidates.find(({ command, args }) => {
  const probe = spawnSync(
    command,
    [...args, '-X', 'utf8', '-c', 'import fastapi, httpx, PIL, pydantic, requests'],
    { cwd: repoRoot, encoding: 'utf8', env: pythonEnv },
  );
  return !probe.error && probe.status === 0;
});

assert.ok(python, 'No usable Python interpreter could import the application dependencies');

const tempDir = mkdtempSync(join(tmpdir(), 'hstar-online-history-'));
const historyFile = join(tempDir, 'history.json');
const previewOutputDir = join(tempDir, 'output');
const previewCacheDir = join(tempDir, 'preview-cache');

const records = [
  { timestamp: 1, type: 'online', images: ['/output/1.png'] },
  { timestamp: 4, type: 'online', images: ['/output/4.png'] },
  { timestamp: 3, type: 'angle', images: ['/output/3.png'] },
  { timestamp: 2, type: 'online', images: ['/output/2.png'] },
  { timestamp: 5, type: 'online', images: [] },
];

writeFileSync(historyFile, JSON.stringify(records), 'utf8');

const pythonScript = String.raw`
import asyncio
import json
import os
import sys

from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, os.getcwd())
import main

main.HISTORY_FILE = sys.argv[1]

async def run():
    legacy = await main.get_history_api(type="online")
    first = await main.get_history_api(type="online", paged=True, offset=0, limit=2)
    second = await main.get_history_api(type="online", paged=True, offset=2, limit=2)
    clamped = await main.get_history_api(type="online", paged=True, offset=-9, limit=999)
    with open(main.HISTORY_FILE, "w", encoding="utf-8") as file:
        json.dump({"unexpected": "shape"}, file)
    invalid_legacy = await main.get_history_api(type="online")

    original_output_dir = main.OUTPUT_DIR
    original_preview_dir = main.MEDIA_PREVIEW_DIR
    preview = {}
    try:
        main.OUTPUT_DIR = sys.argv[2]
        main.MEDIA_PREVIEW_DIR = sys.argv[3]
        os.makedirs(main.OUTPUT_DIR, exist_ok=True)
        os.makedirs(main.MEDIA_PREVIEW_DIR, exist_ok=True)
        Image.new("RGB", (1200, 800), (24, 96, 160)).save(os.path.join(main.OUTPUT_DIR, "large.png"))
        Image.new("RGB", (8, 8), (160, 24, 96)).save(os.path.join(os.path.dirname(main.OUTPUT_DIR), "outside.png"))

        first_preview = await main.media_preview("/output/large.png", 480)
        second_preview = await main.media_preview("/output/large.png", 480)
        with Image.open(first_preview.path) as preview_image:
            preview_size = preview_image.size

        traversal_status = None
        try:
            await main.media_preview("/output/../outside.png", 480)
        except HTTPException as exc:
            traversal_status = exc.status_code

        preview = {
            "first_path": os.path.abspath(first_preview.path),
            "second_path": os.path.abspath(second_preview.path),
            "size": preview_size,
            "traversal_status": traversal_status,
        }
    finally:
        main.OUTPUT_DIR = original_output_dir
        main.MEDIA_PREVIEW_DIR = original_preview_dir

    print(json.dumps({
        "legacy": legacy,
        "first": first,
        "second": second,
        "clamped": clamped,
        "invalid_legacy": invalid_legacy,
        "preview": preview,
    }))

asyncio.run(run())
`;

try {
  const result = spawnSync(
    python.command,
    [...python.args, '-X', 'utf8', '-c', pythonScript, historyFile, previewOutputDir, previewCacheDir],
    {
    cwd: repoRoot,
    encoding: 'utf8',
    env: pythonEnv,
    },
  );

  assert.ok(!result.error, `Failed to launch Python interpreter: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));

  assert.deepEqual(output.legacy.map((item) => item.timestamp), [4, 2, 1]);
  assert.ok(Array.isArray(output.legacy), 'legacy mode must return a plain array');

  assert.deepEqual(output.first.items.map((item) => item.timestamp), [4, 2]);
  assert.deepEqual(
    {
      total: output.first.total,
      offset: output.first.offset,
      next_offset: output.first.next_offset,
      has_more: output.first.has_more,
    },
    { total: 3, offset: 0, next_offset: 2, has_more: true },
  );

  assert.deepEqual(output.second.items.map((item) => item.timestamp), [1]);
  assert.deepEqual(
    {
      total: output.second.total,
      offset: output.second.offset,
      next_offset: output.second.next_offset,
      has_more: output.second.has_more,
    },
    { total: 3, offset: 2, next_offset: null, has_more: false },
  );

  assert.deepEqual(output.clamped.items.map((item) => item.timestamp), [4, 2, 1]);
  assert.deepEqual(
    {
      total: output.clamped.total,
      offset: output.clamped.offset,
      next_offset: output.clamped.next_offset,
      has_more: output.clamped.has_more,
    },
    { total: 3, offset: 0, next_offset: null, has_more: false },
  );
  assert.deepEqual(output.invalid_legacy, [], 'legacy read failures must still return an empty array');

  assert.equal(output.preview.first_path, output.preview.second_path, 'preview requests must reuse one cached file');
  assert.ok(Math.max(...output.preview.size) <= 480, 'preview dimensions must be bounded to 480px');
  assert.equal(output.preview.traversal_status, 404, 'preview traversal must be rejected');

  console.log('online history pagination and media preview characterization passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

assert.match(
  onlineHtml,
  /function historyPreviewUrl\(url\)\s*{\s*return `\/api\/media-preview\?url=\$\{encodeURIComponent\(url\)\}&w=480`;\s*}/,
);
assert.match(
  onlineHtml,
  /\.masonry-item\s*{[^}]*content-visibility:auto;[^}]*contain-intrinsic-size:320px 320px;/,
);

const createCardSource = onlineHtml.slice(
  onlineHtml.indexOf('function createImageCard'),
  onlineHtml.indexOf('function beginHistoryMutation'),
);
assert.match(createCardSource, /const originalUrl = data\.images\[0\];/);
assert.match(
  createCardSource,
  /<img src="\$\{escapeHtml\(historyPreviewUrl\(originalUrl\)\)\}"[^>]*loading="lazy"[^>]*decoding="async"[^>]*fetchpriority="low"/,
);
assert.match(createCardSource, /img\.onerror\s*=\s*\(\)\s*=>\s*{[\s\S]*img\.src = originalUrl;/);
assert.doesNotMatch(createCardSource, /lucide\.createIcons\(\)/);
assert.doesNotMatch(onlineHtml, /\b(?:next|items)\.forEach\(item => renderImageCard\(item\)\)/);
assert.match(
  createCardSource,
  /function renderHistoryBatch\(items\)\s*{\s*const masonry = document\.getElementById\('masonry'\);\s*const fragment = document\.createDocumentFragment\(\);[\s\S]*masonry\.appendChild\(fragment\);\s*}/,
);

assert.match(mainPy, /def remove_media_preview_cache\(path: str, widths=\(480,\)\):/);
const deleteHistorySource = mainPy.slice(
  mainPy.indexOf('async def delete_history'),
  mainPy.indexOf('# --- ModelScope', mainPy.indexOf('async def delete_history')),
);
assert.match(
  deleteHistorySource,
  /remove_media_preview_cache\(file_path, widths=\(480,\)\)[\s\S]*os\.remove\(file_path\)/,
);
