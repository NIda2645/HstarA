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
  const permanentlyDeletedOpenShopNodeIds = new Set(['openshop-deleted']);
  ${filterSource}
  ${mergeSource}
  output = mergeClassicCanvasConflictState({
    nodes:[
      {id:'shared-node', type:'prompt', text:'local edit'},
      {id:'local-new', type:'image'},
    ],
    connections:[{id:'local-link', from:'local-new', to:'shared-node'}],
    selectedIds:['local-new'],
  }, {
    nodes:[
      {id:'shared-node', type:'prompt', text:'remote old'},
      {id:'remote-new', type:'image'},
      {id:'openshop-deleted', type:'openshop-layered'},
    ],
    connections:[
      {id:'remote-link', from:'remote-new', to:'shared-node'},
      {id:'deleted-link', from:'openshop-deleted', to:'remote-new'},
    ],
    selectedIds:[],
  });
`, sandbox);
const merged = JSON.parse(JSON.stringify(sandbox.output));
assert.deepEqual(merged.nodes, [
  {id:'shared-node', type:'prompt', text:'local edit'},
  {id:'remote-new', type:'image'},
  {id:'local-new', type:'image'},
]);
assert.deepEqual(merged.connections, [
  {id:'remote-link', from:'remote-new', to:'shared-node'},
  {id:'local-link', from:'local-new', to:'shared-node'},
]);
assert.deepEqual(merged.selectedIds, ['local-new']);
assert.match(extractFunction(js, 'saveCanvas'), /mergeClassicCanvasConflictState\(/, 'ordinary canvas 409 handling should merge remote additions before retrying local changes');

console.log('ordinary canvas dirty remote sync tests passed');
