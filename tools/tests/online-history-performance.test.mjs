import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const onlineHtml = readFileSync(join(repoRoot, 'static', 'online.html'), 'utf8');
const bulkManagerJs = readFileSync(join(repoRoot, 'static', 'js', 'history-bulk-manager.js'), 'utf8');

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
    print(json.dumps({
        "legacy": legacy,
        "first": first,
        "second": second,
        "clamped": clamped,
        "invalid_legacy": invalid_legacy,
    }))

asyncio.run(run())
`;

try {
  const result = spawnSync(python.command, [...python.args, '-X', 'utf8', '-c', pythonScript, historyFile], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: pythonEnv,
  });

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

  console.log('online history pagination tests passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
