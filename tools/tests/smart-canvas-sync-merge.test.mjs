import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const js = readFileSync('static/js/smart-canvas.js', 'utf8');
const start = js.indexOf('function mergeSmartImageLists');
const end = js.indexOf('function mergeSmartConnections', start);
assert.ok(start >= 0 && end > start, 'smart canvas merge helpers should be present');

const snippet = js.slice(start, end);
const context = {
  smartPendingTasks: () => [],
  nowMs: () => 1000,
  smartNodeRunTokens: { delete() {} },
};
vm.createContext(context);
vm.runInContext(`${snippet}\nglobalThis.mergeSmartNodeLists = mergeSmartNodeLists;\nglobalThis.smartRemoteDeletedOpenShopNodeIds = smartRemoteDeletedOpenShopNodeIds;`, context);

const localNodes = [
  { id: 'gen-1', type: 'smart-image', x: 260, y: 140, images: [{ url: '/assets/new-local.png' }] },
];
const remoteNodes = [
  { id: 'gen-1', type: 'smart-image', x: 40, y: 25, images: [{ url: '/assets/remote-old.png' }] },
  { id: 'out-deleted', type: 'smart-image', x: 640, y: 25, images: [{ url: '/assets/deleted-output.png' }] },
];

const merged = context.mergeSmartNodeLists(localNodes, remoteNodes, {
  preferLocal: true,
  deletedNodeIds: new Set(['out-deleted']),
});

const moved = merged.find(node => node.id === 'gen-1');
assert.equal(moved.x, 260, 'dirty smart canvas merge should keep the local moved x position');
assert.equal(moved.y, 140, 'dirty smart canvas merge should keep the local moved y position');
assert.equal(
  JSON.stringify(moved.images.map(item => item.url)),
  JSON.stringify(['/assets/new-local.png', '/assets/remote-old.png']),
  'dirty smart canvas merge should still keep remote generated images'
);
assert.equal(
  merged.some(node => node.id === 'out-deleted'),
  false,
  'dirty smart canvas merge should not resurrect locally deleted generated nodes from an old remote snapshot'
);

const localOnlyNodes = [
  {id:'openshop-remote-deleted', type:'openshop-layered', projectId:'project-deleted'},
  {id:'ordinary-local-result', type:'smart-image', images:[{url:'/assets/local-result.png'}]},
];
const authoritativeMerge = context.mergeSmartNodeLists(localOnlyNodes, [], {
  preferLocal:false,
  deletedNodeIds:new Set(['openshop-remote-deleted']),
});
assert.equal(
  authoritativeMerge.some(node => node.id === 'openshop-remote-deleted'),
  false,
  'authoritative remote deletion should remove a clean local OpenShop node',
);
assert.equal(
  authoritativeMerge.some(node => node.id === 'ordinary-local-result'),
  true,
  'authoritative remote merge should preserve ordinary local-only results',
);

const dirtyMerge = context.mergeSmartNodeLists(localOnlyNodes, [], {
  preferLocal:true,
  deletedNodeIds:new Set(),
});
assert.equal(
  dirtyMerge.some(node => node.id === 'openshop-remote-deleted'),
  true,
  'dirty local merge should preserve a not-yet-saved OpenShop node',
);

assert.deepEqual(
  Array.from(context.smartRemoteDeletedOpenShopNodeIds(
    localOnlyNodes,
    [],
    new Set(['openshop-remote-deleted']),
  )),
  ['openshop-remote-deleted'],
  'dirty conflict should recognize a remotely deleted OpenShop node from the last synced baseline',
);
assert.deepEqual(
  Array.from(context.smartRemoteDeletedOpenShopNodeIds(
    localOnlyNodes,
    [],
    new Set(),
  )),
  [],
  'dirty conflict should not classify a new unsaved OpenShop node as remotely deleted',
);

assert.match(js, /async function\s+loadCanvas\([\s\S]*rememberSyncedSmartOpenShopNodes\(/, 'smart canvas load should capture the synced OpenShop baseline');
assert.match(js, /async function\s+saveCanvas\([\s\S]*rememberSyncedSmartOpenShopNodes\(/, 'smart canvas successful save should refresh the synced OpenShop baseline');
assert.match(js, /function\s+applyMergedServerCanvas\([\s\S]*smartRemoteDeletedOpenShopNodeIds\(/, 'smart conflict merge should consult the synced OpenShop baseline');

console.log('smart canvas sync merge tests passed');
