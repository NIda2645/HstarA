import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

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
assert.doesNotMatch(onlineHtml, /<button[^>]+id="loadMoreTrigger"/);
assert.doesNotMatch(onlineHtml, /\.onclick\s*=\s*\(\)\s*=>\s*loadHistory\(false\)/);
assert.match(onlineHtml, /id="historyLoadSentinel"/);
assert.match(onlineHtml, /id="historyLoadStatus"[^>]+role="status"[^>]+aria-live="polite"/);
assert.match(onlineHtml, /let historyAutoLoadArmed = false, historyAutoObserver = null;/);
assert.match(onlineHtml, /let historyAutoEntrySeen = false, historyAutoInitialPending = false;/);
assert.match(onlineHtml, /let historyAutoTouchStartX = null, historyAutoTouchStartY = null;/);
assert.equal((onlineHtml.match(/new\s+IntersectionObserver\s*\(/g) || []).length, 1);
assert.match(onlineHtml, /rootMargin:\s*'0px 0px 320px 0px'/);
const historyAutoHandlersStart = onlineHtml.indexOf('function handleHistoryAutoIntersections(entries)');
const historyAutoHandlersEnd = onlineHtml.indexOf('function syncHistoryAutoObserver()');
assert.ok(
  historyAutoHandlersStart >= 0 && historyAutoHandlersEnd > historyAutoHandlersStart,
  'online history must expose executable automatic-loading handlers',
);
const historyAutoHandlersSource = onlineHtml.slice(historyAutoHandlersStart, historyAutoHandlersEnd);
assert.match(historyAutoHandlersSource, /for\(const entry of entries\)/);
assert.match(
  historyAutoHandlersSource,
  /async function requestInitialHistoryAutoLoad\(\)\s*{\s*if\(!historyAutoInitialPending\) return;\s*if\(!historyHasMore\)\s*{\s*historyAutoInitialPending = false;\s*return 'exhausted';\s*}\s*if\(isLoading \|\| historyMutationDepth > 0\) return;\s*const outcome = await loadHistory\(false\);\s*if\(\['loaded','queued','exhausted'\]\.includes\(outcome\)\) historyAutoInitialPending = false;\s*return outcome;\s*}/,
);
assert.match(
  historyAutoHandlersSource,
  /function isHistoryAutoIntentBlocked\(event\)[\s\S]*function handleHistoryAutoKeydown\(event\)\s*{\s*if\(isHistoryAutoIntentBlocked\(event\)\) return;[\s\S]*return requestInitialHistoryAutoLoad\(\);/,
);
assert.match(
  historyAutoHandlersSource,
  /event\.defaultPrevented \|\| event\.altKey \|\| event\.ctrlKey \|\| event\.metaKey \|\| event\.shiftKey/,
);
assert.match(
  historyAutoHandlersSource,
  /event\.target\?\.closest\?\.\('input, textarea, select, button, a, \[contenteditable="true"\]'\)/,
);
assert.match(historyAutoHandlersSource, /function handleHistoryAutoPointerIntent\(event\)/);
assert.match(historyAutoHandlersSource, /function handleHistoryAutoTouchStart\(event\)/);
assert.match(historyAutoHandlersSource, /function resetHistoryAutoTouchIntent\(\)/);
const syncHistoryAutoObserverSource = onlineHtml.slice(
  onlineHtml.indexOf('function syncHistoryAutoObserver()'),
  onlineHtml.indexOf('function setupHistoryAutoLoad()'),
);
assert.match(
  syncHistoryAutoObserverSource,
  /const sentinel = document\.getElementById\('historyLoadSentinel'\);\s*if\(historyHasMore\) historyAutoObserver\.observe\(sentinel\);\s*else historyAutoObserver\.unobserve\(sentinel\);/,
);
const setupHistoryAutoLoadSource = onlineHtml.slice(
  onlineHtml.indexOf('function setupHistoryAutoLoad()'),
  onlineHtml.indexOf('window.onload'),
);
assert.match(
  setupHistoryAutoLoadSource,
  /historyAutoObserver = new IntersectionObserver\(handleHistoryAutoIntersections,\s*{rootMargin:'0px 0px 320px 0px', threshold:0}\);[\s\S]*syncHistoryAutoObserver\(\);\s*}/,
  'setup must delegate initial sentinel registration after constructing the observer',
);
assert.doesNotMatch(setupHistoryAutoLoadSource, /historyAutoObserver\.(?:observe|unobserve)\(/);
assert.match(
  setupHistoryAutoLoadSource,
  /window\.addEventListener\('wheel', handleHistoryAutoPointerIntent, {passive:true}\);/,
);
assert.match(
  setupHistoryAutoLoadSource,
  /window\.addEventListener\('touchstart', handleHistoryAutoTouchStart, {passive:true}\);/,
);
assert.match(setupHistoryAutoLoadSource, /window\.addEventListener\('touchmove', handleHistoryAutoPointerIntent, {passive:true}\);/);
assert.match(setupHistoryAutoLoadSource, /window\.addEventListener\('touchend', resetHistoryAutoTouchIntent, {passive:true}\);/);
assert.match(setupHistoryAutoLoadSource, /window\.addEventListener\('touchcancel', resetHistoryAutoTouchIntent, {passive:true}\);/);
assert.match(setupHistoryAutoLoadSource, /window\.addEventListener\('keydown', handleHistoryAutoKeydown\);/);
assert.doesNotMatch(setupHistoryAutoLoadSource, /window\.addEventListener\('keydown', event =>/);
assert.doesNotMatch(setupHistoryAutoLoadSource, /addEventListener\([^\n]+requestInitialHistoryAutoLoad/);

function createHistoryAutoHarness(loadOutcomes=['loaded']){
  return runInNewContext(`(() => {
    let historyAutoLoadArmed = false;
    let historyAutoEntrySeen = false;
    let historyAutoInitialPending = false;
    let historyAutoTouchStartX = null, historyAutoTouchStartY = null;
    let isLoading = false;
    let historyHasMore = true;
    let historyMutationDepth = 0;
    const requests = [];
    const outcomes = ${JSON.stringify(loadOutcomes)};
    async function loadHistory(reset){
      requests.push(reset);
      return outcomes.length ? outcomes.shift() : 'loaded';
    }
    ${historyAutoHandlersSource}
    return {
      handle: entries => handleHistoryAutoIntersections(entries),
      request: () => requestInitialHistoryAutoLoad(),
      keydown: event => handleHistoryAutoKeydown(event),
      pointer: event => handleHistoryAutoPointerIntent(event),
      touchStart: event => handleHistoryAutoTouchStart(event),
      touchEnd: () => resetHistoryAutoTouchIntent(),
      requestCount: () => requests.length,
      lastRequest: () => requests.at(-1),
      isArmed: () => historyAutoLoadArmed,
      isEntrySeen: () => historyAutoEntrySeen,
      isInitialPending: () => historyAutoInitialPending,
      touchStartX: () => historyAutoTouchStartX,
      touchStartY: () => historyAutoTouchStartY,
      setLoading: value => { isLoading = value; },
      setHasMore: value => { historyHasMore = value; },
      setMutationDepth: value => { historyMutationDepth = value; },
    };
  })()`);
}

const shortPageAutoLoad = createHistoryAutoHarness();
shortPageAutoLoad.handle([{isIntersecting:true}]);
assert.equal(shortPageAutoLoad.requestCount(), 0, 'first intersect must preserve the initial 16-item bound');
assert.equal(shortPageAutoLoad.isEntrySeen(), true);
assert.equal(shortPageAutoLoad.isInitialPending(), true);
assert.equal(shortPageAutoLoad.isArmed(), false);
await shortPageAutoLoad.request();
assert.equal(shortPageAutoLoad.requestCount(), 1, 'first scroll intent must load one reachable page');
assert.equal(shortPageAutoLoad.lastRequest(), false);
assert.equal(shortPageAutoLoad.isInitialPending(), false);
await shortPageAutoLoad.request();
shortPageAutoLoad.handle([{isIntersecting:true}, {isIntersecting:true}]);
assert.equal(shortPageAutoLoad.requestCount(), 1, 'continuous intersection and repeated intent must not cascade');
assert.equal(shortPageAutoLoad.isInitialPending(), false, 'continuous intersection must not recreate initial pending');
shortPageAutoLoad.handle([{isIntersecting:false}]);
assert.equal(shortPageAutoLoad.isArmed(), true, 'leaving the observer margin must arm the next page');
shortPageAutoLoad.handle([{isIntersecting:true}]);
assert.equal(shortPageAutoLoad.requestCount(), 2, 'reentry must load exactly one additional page');
assert.equal(shortPageAutoLoad.isArmed(), false, 'reentry must consume the arm');
shortPageAutoLoad.handle([{isIntersecting:true}]);
assert.equal(shortPageAutoLoad.requestCount(), 2, 'repeated intersection after reentry must not cascade');

const batchedAutoLoad = createHistoryAutoHarness();
batchedAutoLoad.handle([
  {isIntersecting:true},
  {isIntersecting:false},
  {isIntersecting:true},
  {isIntersecting:true},
]);
assert.equal(batchedAutoLoad.requestCount(), 1, 'batched observer entries must be processed in order');
assert.equal(batchedAutoLoad.isInitialPending(), false);
assert.equal(batchedAutoLoad.isArmed(), false);

const guardedIntentAutoLoad = createHistoryAutoHarness();
guardedIntentAutoLoad.handle([{isIntersecting:true}]);
guardedIntentAutoLoad.setLoading(true);
await guardedIntentAutoLoad.request();
assert.equal(guardedIntentAutoLoad.requestCount(), 0, 'loading must block initial intent requests');
assert.equal(guardedIntentAutoLoad.isInitialPending(), true);
guardedIntentAutoLoad.setLoading(false);
guardedIntentAutoLoad.setHasMore(false);
assert.equal(await guardedIntentAutoLoad.request(), 'exhausted');
assert.equal(guardedIntentAutoLoad.requestCount(), 0, 'exhausted history must block initial intent requests');
assert.equal(guardedIntentAutoLoad.isInitialPending(), false, 'exhausted history must consume initial pending');

const guardedIntersectionAutoLoad = createHistoryAutoHarness();
guardedIntersectionAutoLoad.handle([{isIntersecting:false}]);
guardedIntersectionAutoLoad.setLoading(true);
guardedIntersectionAutoLoad.handle([{isIntersecting:true}]);
assert.equal(guardedIntersectionAutoLoad.requestCount(), 0, 'loading must block armed intersection requests');
assert.equal(guardedIntersectionAutoLoad.isArmed(), true);
guardedIntersectionAutoLoad.setLoading(false);
guardedIntersectionAutoLoad.setHasMore(false);
guardedIntersectionAutoLoad.handle([{isIntersecting:true}]);
assert.equal(guardedIntersectionAutoLoad.requestCount(), 0, 'exhausted history must block armed intersection requests');
assert.equal(guardedIntersectionAutoLoad.isArmed(), true);

function historyAutoControlTarget(controlSelector){
  return {
    closest: selector => selector.split(', ').includes(controlSelector) ? {controlSelector} : null,
  };
}

const guardedKeydownAutoLoad = createHistoryAutoHarness();
guardedKeydownAutoLoad.handle([{isIntersecting:true}]);
await guardedKeydownAutoLoad.keydown({
  key: ' ',
  code: 'Space',
  target: historyAutoControlTarget('textarea'),
});
assert.equal(guardedKeydownAutoLoad.requestCount(), 0, 'Space in a textarea must not load history');
assert.equal(guardedKeydownAutoLoad.isInitialPending(), true, 'ignored textarea input must preserve pending');
await guardedKeydownAutoLoad.keydown({
  key: 'ArrowDown',
  target: historyAutoControlTarget('select'),
});
assert.equal(guardedKeydownAutoLoad.requestCount(), 0, 'ArrowDown in a select must not load history');
assert.equal(guardedKeydownAutoLoad.isInitialPending(), true);
for(const modifier of ['altKey', 'ctrlKey', 'metaKey', 'shiftKey']){
  const isShiftSpace = modifier === 'shiftKey';
  await guardedKeydownAutoLoad.keydown({
    key: isShiftSpace ? ' ' : 'PageDown',
    code: isShiftSpace ? 'Space' : undefined,
    [modifier]: true,
    target: {closest: () => null},
  });
  assert.equal(guardedKeydownAutoLoad.requestCount(), 0, `${modifier} scroll intent must not load history`);
  assert.equal(guardedKeydownAutoLoad.isInitialPending(), true, `${modifier} must not consume initial pending`);
}
await guardedKeydownAutoLoad.keydown({
  key: 'End',
  defaultPrevented: true,
  target: {closest: () => null},
});
assert.equal(guardedKeydownAutoLoad.requestCount(), 0, 'modified and prevented keys must not load history');
assert.equal(guardedKeydownAutoLoad.isInitialPending(), true);
await guardedKeydownAutoLoad.keydown({
  key: 'PageDown',
  target: {closest: () => null},
});
assert.equal(guardedKeydownAutoLoad.requestCount(), 1, 'document PageDown must load one pending page');
assert.equal(guardedKeydownAutoLoad.isInitialPending(), false);
await guardedKeydownAutoLoad.keydown({
  key: 'PageDown',
  target: {},
});
assert.equal(guardedKeydownAutoLoad.requestCount(), 1, 'repeated document intent must remain one-shot');

const unmodifiedSpaceAutoLoad = createHistoryAutoHarness();
unmodifiedSpaceAutoLoad.handle([{isIntersecting:true}]);
await unmodifiedSpaceAutoLoad.keydown({
  key: ' ',
  code: 'Space',
  target: {closest: () => null},
});
assert.equal(unmodifiedSpaceAutoLoad.requestCount(), 1, 'unmodified Space must load one pending page');
assert.equal(unmodifiedSpaceAutoLoad.isInitialPending(), false);

const retryableInitialAutoLoad = createHistoryAutoHarness(['failed', 'loaded']);
retryableInitialAutoLoad.handle([{isIntersecting:true}]);
assert.equal(await retryableInitialAutoLoad.request(), 'failed');
assert.equal(retryableInitialAutoLoad.requestCount(), 1, 'first failed intent must attempt once');
assert.equal(retryableInitialAutoLoad.isInitialPending(), true, 'failed intent must preserve pending');
assert.equal(await retryableInitialAutoLoad.request(), 'loaded');
assert.equal(retryableInitialAutoLoad.requestCount(), 2, 'second valid intent must retry once');
assert.equal(retryableInitialAutoLoad.isInitialPending(), false, 'successful retry must consume pending');
await retryableInitialAutoLoad.request();
assert.equal(retryableInitialAutoLoad.requestCount(), 2, 'consumed retry must remain one-shot');

const queuedInitialAutoLoad = createHistoryAutoHarness(['queued']);
queuedInitialAutoLoad.handle([{isIntersecting:true}]);
assert.equal(await queuedInitialAutoLoad.request(), 'queued');
assert.equal(queuedInitialAutoLoad.isInitialPending(), false, 'queued retry must consume pending');
await queuedInitialAutoLoad.request();
assert.equal(queuedInitialAutoLoad.requestCount(), 1, 'queued retry must not permit an extra page intent');

const mutationGuardedInitialAutoLoad = createHistoryAutoHarness();
mutationGuardedInitialAutoLoad.handle([{isIntersecting:true}]);
mutationGuardedInitialAutoLoad.setMutationDepth(1);
await mutationGuardedInitialAutoLoad.request();
assert.equal(mutationGuardedInitialAutoLoad.requestCount(), 0, 'active mutations must block initial intent requests');
assert.equal(mutationGuardedInitialAutoLoad.isInitialPending(), true);

const bodyIntentTarget = {closest: () => null};
const wheelAutoLoad = createHistoryAutoHarness();
wheelAutoLoad.handle([{isIntersecting:true}]);
await wheelAutoLoad.pointer({type:'wheel', deltaY:-40, deltaX:0, target:bodyIntentTarget});
await wheelAutoLoad.pointer({type:'wheel', deltaY:20, deltaX:40, target:bodyIntentTarget});
await wheelAutoLoad.pointer({type:'wheel', deltaY:40, deltaX:0, ctrlKey:true, target:bodyIntentTarget});
await wheelAutoLoad.pointer({type:'wheel', deltaY:40, deltaX:0, shiftKey:true, target:bodyIntentTarget});
await wheelAutoLoad.pointer({type:'wheel', deltaY:40, deltaX:0, defaultPrevented:true, target:bodyIntentTarget});
await wheelAutoLoad.pointer({type:'wheel', deltaY:40, deltaX:0, target:historyAutoControlTarget('input')});
assert.equal(wheelAutoLoad.requestCount(), 0, 'upward, horizontal, zoom, modified, prevented, and control wheel events must be ignored');
assert.equal(wheelAutoLoad.isInitialPending(), true);
await wheelAutoLoad.pointer({type:'wheel', deltaY:40, deltaX:5, target:bodyIntentTarget});
assert.equal(wheelAutoLoad.requestCount(), 1, 'downward body wheel must attempt one pending page');
assert.equal(wheelAutoLoad.isInitialPending(), false);

const touchAutoLoad = createHistoryAutoHarness();
touchAutoLoad.handle([{isIntersecting:true}]);
touchAutoLoad.touchStart({touches:[{clientX:100, clientY:100}]});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:120}], target:bodyIntentTarget});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:100}], target:bodyIntentTarget});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:200, clientY:99}], target:bodyIntentTarget});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientY:80}], target:bodyIntentTarget});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:80}], ctrlKey:true, target:bodyIntentTarget});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:80}], shiftKey:true, target:bodyIntentTarget});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:80}], defaultPrevented:true, target:bodyIntentTarget});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:80}], target:historyAutoControlTarget('button')});
assert.equal(
  touchAutoLoad.requestCount(),
  0,
  'downward, non-directional, horizontal, missing-coordinate, modified, prevented, and control touch gestures must be ignored',
);
assert.equal(touchAutoLoad.isInitialPending(), true);
touchAutoLoad.touchEnd();
assert.equal(touchAutoLoad.touchStartX(), null, 'touchend must reset horizontal touch state');
assert.equal(touchAutoLoad.touchStartY(), null, 'touchend must reset touch intent state');
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:80}], target:bodyIntentTarget});
assert.equal(touchAutoLoad.requestCount(), 0, 'touchmove without an active start must be ignored');
touchAutoLoad.touchStart({touches:[{clientX:100, clientY:100}]});
await touchAutoLoad.pointer({type:'touchmove', touches:[{clientX:110, clientY:80}], target:bodyIntentTarget});
assert.equal(touchAutoLoad.requestCount(), 1, 'vertical-dominant upward finger movement must attempt one pending page');
assert.equal(touchAutoLoad.isInitialPending(), false);

const cancelledTouchAutoLoad = createHistoryAutoHarness();
cancelledTouchAutoLoad.handle([{isIntersecting:true}]);
cancelledTouchAutoLoad.touchStart({touches:[{clientX:100, clientY:100}]});
cancelledTouchAutoLoad.touchEnd();
assert.equal(cancelledTouchAutoLoad.touchStartX(), null);
assert.equal(cancelledTouchAutoLoad.touchStartY(), null);
await cancelledTouchAutoLoad.pointer({type:'touchmove', touches:[{clientX:100, clientY:80}], target:bodyIntentTarget});
assert.equal(cancelledTouchAutoLoad.requestCount(), 0, 'touchcancel reset must prevent stale directional intent');
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
const loadHistorySource = onlineHtml.slice(
  onlineHtml.indexOf('async function loadHistory(reset=false)'),
  onlineHtml.indexOf('let lightboxPreview = null'),
);
assert.match(
  loadHistorySource,
  /if\(historyMutationDepth > 0\)\s*{\s*queueHistoryLoad\(reset\);\s*return 'queued';\s*}/,
  'history GETs must queue while mutations are in flight',
);
assert.match(loadHistorySource, /if\(isLoading\) return 'busy';/);
assert.match(loadHistorySource, /if\(!reset && !historyHasMore\) return 'exhausted';/);
assert.match(loadHistorySource, /let outcome = 'failed';/);
assert.match(loadHistorySource, /outcome = 'loaded';/);
assert.match(loadHistorySource, /return outcome;\s*}/);
assert.match(loadHistorySource, /const requestRevision = historyRevision;/);
assert.ok(
  onlineHtml.indexOf('const requestRevision = historyRevision;')
    < onlineHtml.indexOf('const response = await fetch(`/api/history?type=online'),
  'history requests must capture the mutation revision before fetching',
);
const staleResponseGuard = 'if(requestRevision !== historyRevision){';
assert.match(
  loadHistorySource,
  /if\(requestRevision !== historyRevision\)\s*{\s*queueHistoryLoad\(reset\);\s*outcome = 'queued';\s*}\s*else\s*{/,
  'stale history responses must queue the same request mode',
);
assert.ok(
  onlineHtml.indexOf(staleResponseGuard) < onlineHtml.indexOf('renderHistoryBatch(items);'),
  'stale history responses must be rejected before rendering',
);
assert.match(
  loadHistorySource,
  /finally\s*{\s*if\(requestRevision !== historyRevision\)\s*{\s*queueHistoryLoad\(reset\);\s*outcome = 'queued';\s*}[\s\S]*isLoading = false;\s*runQueuedHistoryLoad\(\);/,
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
import threading
import time

from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, os.getcwd())
import main

test_history_file = sys.argv[1]

async def run():
    original_history_file = main.HISTORY_FILE
    original_output_dir = main.OUTPUT_DIR
    original_preview_dir = main.MEDIA_PREVIEW_DIR
    original_remove_preview_cache = main.remove_media_preview_cache
    try:
        main.HISTORY_FILE = test_history_file
        main.OUTPUT_DIR = sys.argv[2]
        main.MEDIA_PREVIEW_DIR = sys.argv[3]

        legacy = await main.get_history_api(type="online")
        first = await main.get_history_api(type="online", paged=True, offset=0, limit=2)
        second = await main.get_history_api(type="online", paged=True, offset=2, limit=2)
        clamped = await main.get_history_api(type="online", paged=True, offset=-9, limit=999)
        with open(main.HISTORY_FILE, "w", encoding="utf-8") as file:
            json.dump({"unexpected": "shape"}, file)
        invalid_legacy = await main.get_history_api(type="online")

        concurrent_records = [
            {"timestamp": 1, "type": "online", "images": ["/output/1.png"]},
            {"timestamp": 4, "type": "online", "images": ["/output/4.png"]},
            {"timestamp": 3, "type": "angle", "images": ["/output/3.png"]},
            {"timestamp": 2, "type": "online", "images": ["/output/2.png"]},
            {"timestamp": 5, "type": "online", "images": []},
        ]
        partial_written = threading.Event()
        reader_started = threading.Event()
        writer_errors = []

        def rewrite_history():
            try:
                with main.HISTORY_LOCK:
                    with open(main.HISTORY_FILE, "w", encoding="utf-8") as file:
                        file.write('[{"timestamp":')
                        file.flush()
                        partial_written.set()
                        if not reader_started.wait(timeout=5):
                            raise AssertionError("history reader did not start")
                        time.sleep(0.05)
                        file.seek(0)
                        file.truncate()
                        json.dump(concurrent_records, file)
                        file.flush()
            except BaseException as exc:
                writer_errors.append(repr(exc))
                partial_written.set()

        writer = threading.Thread(target=rewrite_history, daemon=True)
        writer.start()
        if not partial_written.wait(timeout=5):
            raise AssertionError("history writer did not expose partial content")
        reader_started.set()
        concurrent_page = await main.get_history_api(type="online", paged=True, offset=0, limit=2)
        writer.join(timeout=5)
        if writer.is_alive():
            raise AssertionError("history writer did not finish")
        if writer_errors:
            raise AssertionError(writer_errors[0])

        os.makedirs(main.OUTPUT_DIR, exist_ok=True)
        os.makedirs(main.MEDIA_PREVIEW_DIR, exist_ok=True)
        source_path = os.path.join(main.OUTPUT_DIR, "large.png")
        Image.new("RGB", (1200, 800), (24, 96, 160)).save(source_path)
        Image.new("RGB", (8, 8), (160, 24, 96)).save(os.path.join(os.path.dirname(main.OUTPUT_DIR), "outside.png"))

        first_preview = await main.media_preview("/output/large.png", 480)
        second_preview = await main.media_preview("/output/large.png", 480)
        with Image.open(first_preview.path) as preview_image:
            preview_size = preview_image.size
        preview_cache_paths = main.media_preview_cache_paths(source_path, 480)
        cache_exists_before_cleanup = [os.path.exists(path) for path in preview_cache_paths]
        main.remove_media_preview_cache(source_path, widths=(480,))
        cache_exists_after_cleanup = [os.path.exists(path) for path in preview_cache_paths]

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
            "cache_paths": preview_cache_paths,
            "cache_exists_before_cleanup": cache_exists_before_cleanup,
            "cache_exists_after_cleanup": cache_exists_after_cleanup,
        }

        delete_timestamp = 1234.5
        delete_source_path = os.path.join(main.OUTPUT_DIR, "delete-me.png")
        Image.new("RGB", (32, 32), (32, 160, 96)).save(delete_source_path)
        with open(main.HISTORY_FILE, "w", encoding="utf-8") as file:
            json.dump([{
                "timestamp": delete_timestamp,
                "type": "online",
                "images": ["/output/delete-me.png"],
            }], file)

        def failing_preview_cleanup(path, widths=(480,)):
            raise RuntimeError("simulated preview cleanup failure")

        main.remove_media_preview_cache = failing_preview_cleanup
        delete_result = await main.delete_history(main.DeleteHistoryRequest(timestamp=delete_timestamp))
        with open(main.HISTORY_FILE, "r", encoding="utf-8") as file:
            remaining_history = json.load(file)
        delete_isolation = {
            "result": delete_result,
            "source_exists": os.path.exists(delete_source_path),
            "remaining_history": remaining_history,
        }
    finally:
        main.HISTORY_FILE = original_history_file
        main.OUTPUT_DIR = original_output_dir
        main.MEDIA_PREVIEW_DIR = original_preview_dir
        main.remove_media_preview_cache = original_remove_preview_cache

    print(json.dumps({
        "legacy": legacy,
        "first": first,
        "second": second,
        "clamped": clamped,
        "invalid_legacy": invalid_legacy,
        "concurrent_page": concurrent_page,
        "preview": preview,
        "delete_isolation": delete_isolation,
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
  assert.deepEqual(
    {
      timestamps: output.concurrent_page.items.map((item) => item.timestamp),
      total: output.concurrent_page.total,
      offset: output.concurrent_page.offset,
      next_offset: output.concurrent_page.next_offset,
      has_more: output.concurrent_page.has_more,
    },
    { timestamps: [4, 2], total: 3, offset: 0, next_offset: 2, has_more: true },
    'history reads must wait for locked writers and parse their completed snapshot',
  );

  assert.equal(output.preview.first_path, output.preview.second_path, 'preview requests must reuse one cached file');
  assert.ok(Math.max(...output.preview.size) <= 480, 'preview dimensions must be bounded to 480px');
  assert.equal(output.preview.traversal_status, 404, 'preview traversal must be rejected');
  assert.deepEqual(
    output.preview.cache_paths.map((path) => path.slice(path.lastIndexOf('.'))).sort(),
    ['.png', '.webp'],
  );
  assert.ok(output.preview.cache_exists_before_cleanup.some(Boolean), 'a generated 480px cache file must exist');
  assert.deepEqual(output.preview.cache_exists_after_cleanup, [false, false]);

  assert.equal(output.delete_isolation.result.success, true, 'cleanup failure must not fail history deletion');
  assert.equal(output.delete_isolation.source_exists, false, 'cleanup failure must not retain the source image');
  assert.deepEqual(output.delete_isolation.remaining_history, [], 'authoritative history deletion must still persist');

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
const reservationHelperStart = onlineHtml.indexOf('function reserveHistoryCardId');
const createCardStart = onlineHtml.indexOf('function createImageCard');
assert.ok(reservationHelperStart >= 0, 'online archive must define reserveHistoryCardId');
assert.ok(reservationHelperStart < createCardStart, 'reservation helper must be defined before createImageCard');
const liveIds = new Set(['history-99']);
const reservationHelperSource = onlineHtml.slice(reservationHelperStart, createCardStart);
const reserveHistoryCardId = runInNewContext(
  `(() => { ${reservationHelperSource}; return reserveHistoryCardId; })()`,
  { document: { getElementById: (id) => (liveIds.has(id) ? { id } : null) } },
);
const reservedIds = new Set();
assert.equal(reserveHistoryCardId({ timestamp: 42, images: ['/output/first.png'] }, reservedIds), 'history-42');
assert.equal(reserveHistoryCardId({ timestamp: 42, images: ['/output/second.png'] }, reservedIds), null);
assert.equal(reserveHistoryCardId({ timestamp: 99, images: ['/output/live.png'] }, reservedIds), null);
assert.equal(reserveHistoryCardId({ timestamp: 7, images: [] }, reservedIds), null);

assert.match(
  createCardSource,
  /function createImageCard\(data, reservedIds\)\s*{\s*const cardId = reserveHistoryCardId\(data, reservedIds\);\s*if\(!cardId\) return null;/,
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
  /function renderHistoryBatch\(items\)\s*{\s*const masonry = document\.getElementById\('masonry'\);\s*const fragment = document\.createDocumentFragment\(\);\s*const reservedIds = new Set\(\);[\s\S]*createImageCard\(item, reservedIds\)[\s\S]*masonry\.appendChild\(fragment\);\s*}/,
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
