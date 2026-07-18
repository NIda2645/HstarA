import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const canvasJs = readFileSync('static/js/canvas.js', 'utf8');
const smartJs = readFileSync('static/js/smart-canvas.js', 'utf8');

assert.match(canvasJs, /const\s+(?:CANVAS_)?UNDO_MAX\s*=\s*10|const\s+UNDO_LIMIT\s*=\s*10/, 'ordinary canvas should limit undo history to 10 entries');
assert.match(canvasJs, /redoStack/, 'ordinary canvas should keep a redo stack');
assert.match(canvasJs, /canvasId\s*:\s*(?:canvas\?\.id|canvasId)/, 'ordinary canvas snapshots should carry the current canvas id');
assert.match(canvasJs, /state\.canvasId\s*!==\s*(?:canvas\?\.id|canvasId)|snap\.canvasId\s*!==\s*(?:canvas\?\.id|canvasId)/, 'ordinary canvas restore should reject snapshots from another canvas');
assert.match(canvasJs, /function\s+resetCanvasHistory\(/, 'ordinary canvas should reset undo and redo stacks when a canvas is opened or loaded');
assert.match(canvasJs, /function\s+performRedo\(/, 'ordinary canvas should implement redo');
assert.match(canvasJs, /matchShortcutEvent\(e,\s*'undo'\)/, 'ordinary canvas should route configured undo shortcut through the keydown handler');
assert.match(canvasJs, /matchShortcutEvent\(e,\s*'redo'\)/, 'ordinary canvas should route configured redo shortcut through the keydown handler');
assert.match(canvasJs, /if\(e\.repeat\) return;/, 'ordinary canvas should ignore repeated keydown events for undo or redo');
assert.match(canvasJs, /pushUndo\(\)[\s\S]*redoStack\s*=\s*\[\]/, 'ordinary canvas should clear redo when a new undo snapshot is pushed');

assert.match(smartJs, /const\s+UNDO_LIMIT\s*=\s*40/, 'pure smart canvas should keep its original undo history depth');
assert.match(smartJs, /function\s+snapshotForUndo\(/, 'pure smart canvas should snapshot state for undo');
assert.match(smartJs, /function\s+pushUndo\(\)[\s\S]*if\(undoStack\.length > UNDO_LIMIT\) undoStack\.shift\(\)/, 'pure smart canvas should cap undo history');
assert.match(smartJs, /function\s+performUndo\(/, 'pure smart canvas should implement undo');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for(let index = bodyStart; index < source.length; index += 1) {
    if(source[index] === '{') depth += 1;
    else if(source[index] === '}') {
      depth -= 1;
      if(depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${name} has no closing brace`);
}

function executeHistoryFilter(source, deletedIds, state) {
  const functionSource = extractFunction(source, 'filterPermanentlyDeletedOpenShopHistoryState');
  const sandbox = {input:state, output:null};
  vm.createContext(sandbox);
  vm.runInContext(`
    const permanentlyDeletedOpenShopNodeIds = new Set(${JSON.stringify(deletedIds)});
    ${functionSource}
    output = filterPermanentlyDeletedOpenShopHistoryState(input);
  `, sandbox);
  return JSON.parse(JSON.stringify(sandbox.output));
}

const classicFiltered = executeHistoryFilter(canvasJs, ['openshop-deleted'], {
  canvasId:'classic-canvas',
  nodes:[
    {id:'openshop-deleted', type:'openshop-layered'},
    {id:'image-survivor', type:'image'},
    {id:'group-survivor', type:'group', items:['openshop-deleted', 'image-survivor']},
  ],
  connections:[
    {id:'from-deleted', from:'openshop-deleted', to:'image-survivor'},
    {id:'to-deleted', from:'image-survivor', to:'openshop-deleted'},
  ],
  selectedIds:['openshop-deleted', 'image-survivor'],
});
assert.deepEqual(classicFiltered.nodes, [
  {id:'image-survivor', type:'image'},
  {id:'group-survivor', type:'group', items:['image-survivor']},
]);
assert.deepEqual(classicFiltered.connections, []);
assert.deepEqual(classicFiltered.selectedIds, ['image-survivor']);

const smartFiltered = executeHistoryFilter(smartJs, ['smart-openshop-deleted'], {
  nodes:[
    {id:'smart-openshop-deleted', type:'openshop-layered'},
    {id:'smart-survivor', type:'smart-image', inputNodeIds:['smart-openshop-deleted']},
    {id:'smart-group-survivor', type:'smart-group', items:['smart-openshop-deleted', 'smart-survivor']},
  ],
  connections:[
    {from:'smart-openshop-deleted', to:'smart-survivor', kind:'flow'},
  ],
  selectedId:'smart-openshop-deleted',
  selectedIds:['smart-openshop-deleted', 'smart-survivor'],
  selectedImage:{nodeId:'smart-openshop-deleted', index:0},
});
assert.deepEqual(smartFiltered.nodes, [
  {id:'smart-survivor', type:'smart-image', inputNodeIds:[]},
  {id:'smart-group-survivor', type:'smart-group', items:['smart-survivor']},
]);
assert.deepEqual(smartFiltered.connections, []);
assert.equal(smartFiltered.selectedId, '');
assert.deepEqual(smartFiltered.selectedIds, ['smart-survivor']);
assert.deepEqual(smartFiltered.selectedImage, {nodeId:'', index:-1});

assert.match(canvasJs, /function\s+resetCanvasHistory\(\)[\s\S]*permanentlyDeletedOpenShopNodeIds\.clear\(\)/, 'classic canvas load reset should clear permanent OpenShop tombstones');
assert.match(canvasJs, /function\s+deleteNode\([\s\S]*trackPermanentlyDeletedOpenShopNodes\(\[node\]\)/, 'classic single delete should tombstone the OpenShop node');
assert.match(canvasJs, /function\s+deleteSelectedNodes\([\s\S]*trackPermanentlyDeletedOpenShopNodes\(/, 'classic bulk delete should tombstone selected OpenShop nodes');
assert.match(canvasJs, /deleteSelectedNodes\([\s\S]*HstarClassicOpenShopAdapter\?\.disposeNode\?\.\(node\)/, 'classic bulk delete should permanently dispose each OpenShop project');
assert.match(canvasJs, /function\s+applyCanvasHistoryState\([\s\S]*filterPermanentlyDeletedOpenShopHistoryState\(/, 'classic undo and redo restoration should filter tombstoned OpenShop nodes');
assert.match(canvasJs, /function\s+applyRemoteCanvasData\([\s\S]*filterPermanentlyDeletedOpenShopHistoryState\(/, 'classic remote synchronization should filter permanently deleted OpenShop nodes');
assert.match(canvasJs, /function\s+applyRemoteCanvasData\([\s\S]*blockedPermanentlyDeletedOpenShopNode[\s\S]*scheduleSave\(\)/, 'classic remote resurrection attempts should schedule a corrective save');

assert.match(smartJs, /function\s+deleteNode\([\s\S]*trackPermanentlyDeletedOpenShopNodes\(\[node\]\)/, 'smart delete should tombstone the OpenShop node');
assert.match(smartJs, /function\s+performUndo\([\s\S]*filterPermanentlyDeletedOpenShopHistoryState\(/, 'smart undo restoration should filter tombstoned OpenShop nodes');
assert.match(smartJs, /async function\s+loadCanvas\([\s\S]*permanentlyDeletedOpenShopNodeIds\.clear\(\)/, 'smart canvas load should clear permanent OpenShop tombstones');
assert.match(smartJs, /function\s+applyMergedServerCanvas\([\s\S]*permanentlyDeletedOpenShopNodeIds[\s\S]*deletedNodeIds/, 'smart remote synchronization should always include permanent OpenShop tombstones');
assert.match(smartJs, /function\s+applyMergedServerCanvas\([\s\S]*blockedPermanentlyDeletedOpenShopNode[\s\S]*scheduleSave\(\)/, 'smart remote resurrection attempts should schedule a corrective save');

console.log('canvas undo/redo history tests passed');
