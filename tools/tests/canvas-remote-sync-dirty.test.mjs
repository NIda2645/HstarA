import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const js = readFileSync('static/js/canvas.js', 'utf8');
const start = js.indexOf('function handleCanvasUpdatedMessage');
const end = js.indexOf('async function returnToCanvasManager', start);
assert.ok(start >= 0 && end > start, 'ordinary canvas remote update handler should be present');

const handler = js.slice(start, end);
const guardIndex = handler.search(/localCanvasDirty\s*\|\|\s*saveTimer\s*\|\|\s*savingCanvasNow\s*\|\|\s*saveCanvasAgain/);
const clearDirtyIndex = handler.indexOf('localCanvasDirty = false');

assert.ok(guardIndex >= 0, 'ordinary canvas should defer remote sync while local node edits are pending');
assert.ok(clearDirtyIndex < 0 || guardIndex < clearDirtyIndex, 'ordinary canvas should check local dirty state before clearing it for remote sync');
const openCanvasSource = js.slice(js.indexOf('async function openCanvas('), js.indexOf('function applyRemoteCanvasData(', js.indexOf('async function openCanvas(')));
assert.match(openCanvasSource, /if\(touched\?\.nodes\) canvas = touched;/, 'ordinary canvas open should adopt the full latest canvas returned by touch');
assert.match(openCanvasSource, /lastSyncedCanvasState\s*=\s*captureClassicCanvasSyncState/, 'ordinary canvas open should capture its fetched merge baseline');

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

const filterSource = extractFunction(js, 'filterPermanentlyDeletedOpenShopHistoryState');
const mergeSource = extractFunction(js, 'mergeClassicCanvasConflictState');
const sandbox = {output:null};
vm.createContext(sandbox);
vm.runInContext(`
  const permanentlyDeletedOpenShopNodeIds = new Set();
  ${filterSource}
  ${mergeSource}
  const merged = mergeClassicCanvasConflictState({
    nodes:[
      {id:'shared-node', type:'output', x:100, images:[]},
      {id:'openshop-remote-deleted', type:'openshop-layered'},
      {id:'local-new', type:'image'},
    ],
    connections:[
      {id:'openshop-link', from:'openshop-remote-deleted', to:'shared-node'},
      {id:'local-link', from:'local-new', to:'shared-node'},
    ],
    selectedIds:['openshop-remote-deleted', 'local-new'],
    logs:[
      {id:'base-log', value:'base'},
      {id:'local-log', value:'local'},
    ],
  }, {
    nodes:[
      {id:'shared-node', type:'output', x:0, images:[
        {url:'/output/base-result.png'},
        {url:'/output/remote-result.png'},
      ]},
      {id:'ordinary-local-deleted', type:'image'},
      {id:'remote-new', type:'image'},
    ],
    connections:[
      {id:'ordinary-link', from:'ordinary-local-deleted', to:'shared-node'},
      {id:'remote-link', from:'remote-new', to:'shared-node'},
    ],
    selectedIds:[],
    logs:[
      {id:'base-log', value:'base'},
      {id:'remote-log', value:'remote'},
    ],
  }, {
    nodes:[
      {id:'shared-node', type:'output', x:0, images:[{url:'/output/base-result.png'}]},
      {id:'openshop-remote-deleted', type:'openshop-layered'},
      {id:'ordinary-local-deleted', type:'image'},
    ],
    connections:[
      {id:'openshop-link', from:'openshop-remote-deleted', to:'shared-node'},
      {id:'ordinary-link', from:'ordinary-local-deleted', to:'shared-node'},
    ],
    selectedIds:[],
    logs:[{id:'base-log', value:'base'}],
  });
  output = {merged, tombstones:[...permanentlyDeletedOpenShopNodeIds]};
`, sandbox);
const {merged, tombstones} = JSON.parse(JSON.stringify(sandbox.output));
assert.deepEqual(merged.nodes, [
  {id:'shared-node', type:'output', x:100, images:[{url:'/output/remote-result.png'}]},
  {id:'remote-new', type:'image'},
  {id:'local-new', type:'image'},
]);
assert.deepEqual(merged.connections, [
  {id:'remote-link', from:'remote-new', to:'shared-node'},
  {id:'local-link', from:'local-new', to:'shared-node'},
]);
assert.deepEqual(merged.selectedIds, ['local-new']);
assert.deepEqual(merged.logs, [
  {id:'base-log', value:'base'},
  {id:'remote-log', value:'remote'},
  {id:'local-log', value:'local'},
]);
assert.deepEqual(tombstones, ['openshop-remote-deleted']);
const saveCanvasSource = extractFunction(js, 'saveCanvas');
assert.match(saveCanvasSource, /mergeClassicCanvasConflictState\(/, 'ordinary canvas 409 handling should merge remote additions before retrying local changes');
assert.match(saveCanvasSource, /const\s+currentLogs\s*=\s*canvas\.logs\s*\|\|\s*\[\]/, 'ordinary canvas save should capture logs added while a request is in flight');
assert.match(saveCanvasSource, /canvas\s*=\s*\{[\s\S]*logs:currentLogs/, 'ordinary canvas save response should preserve in-flight logs for the queued retry');

console.log('ordinary canvas dirty remote sync tests passed');
