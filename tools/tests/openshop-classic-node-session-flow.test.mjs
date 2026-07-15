import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const adapterPath = 'static/js/canvas-openshop.js';
assert.ok(fs.existsSync(adapterPath), `${adapterPath} should exist`);

const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const canvasSource = fs.readFileSync('static/js/canvas.js', 'utf8');
const htmlSource = fs.readFileSync('static/canvas.html', 'utf8');
const cssSource = fs.readFileSync('static/css/canvas.css', 'utf8');
const i18nSource = fs.readFileSync('static/js/i18n/canvas.js', 'utf8');

const listeners = new Map();
const openedSessions = [];
const disposedProjects = [];
let renderCount = 0;
let saveCount = 0;
let undoCount = 0;
const uidCounts = {};
let nodes = [];
let connections = [];
const selected = new Set();

const host = {
  openNodeSession(context, sources) {
    openedSessions.push({context, sources});
  },
  disposeProject(projectId, context) {
    disposedProjects.push({projectId, context});
    return Promise.resolve(true);
  },
};

const hooks = {
  uid(prefix = 'id') {
    uidCounts[prefix] = (uidCounts[prefix] || 0) + 1;
    return `${prefix}_${uidCounts[prefix]}`;
  },
  getCanvasId: () => 'canvas-1',
  getNodes: () => nodes,
  getConnections: () => connections,
  mediaRefsFromNode(node) {
    if(node.type === 'group') return (node.items || []).map(id => nodes.find(item => item.id === id)).filter(Boolean);
    if(node.type === 'output') return node.images || [];
    return node.url ? [{url:node.url, name:node.name, kind:node.mediaKind || 'image'}] : [];
  },
  mediaKindForRef: ref => ref.kind || 'image',
  displayMediaUrl: url => `/display${url}`,
  addNode(node) { nodes.push(node); return node; },
  addConnection(connection) { connections.push(connection); return connection; },
  pushUndo() { undoCount += 1; },
  render() { renderCount += 1; },
  scheduleSave() {},
  async saveCanvas() { saveCount += 1; },
  selectOnly(id) { selected.clear(); selected.add(id); },
};

const windowRef = {
  location: {origin:'http://127.0.0.1:3000', search:'?id=canvas-1'},
  frameElement: {id:'frame-canvas'},
  parent: {HstarOpenShopHost:host},
  crypto: {randomUUID: (() => { let id = 0; return () => `project-${++id}`; })()},
  HstarClassicOpenShopHooks: hooks,
  addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  },
};

const sandbox = {
  console,
  Date,
  document: {createElement: () => ({className:'', innerHTML:'', querySelector:() => null, appendChild(){}})},
  escapeHtml: value => String(value),
  escapeAttr: value => String(value),
  tr: key => key,
  window: windowRef,
};
vm.createContext(sandbox);
vm.runInContext(adapterSource, sandbox, {filename:adapterPath});

const adapter = sandbox.window.HstarClassicOpenShopAdapter;
assert.ok(adapter, 'classic OpenShop adapter should be exported');
const node = adapter.createNode({x:100, y:120});
assert.equal(node.type, 'openshop-layered');
assert.match(node.projectId, /^osp_/);
assert.equal(node.saveState, 'new');
assert.equal(node.aiStatus, '');
assert.equal(node.aiTargetCount, 0);
assert.equal(node.x, 100);
assert.equal(node.y, 120);

const imageOne = {id:'image-1', type:'image', url:'/image-one.png', name:'第一张.png', mediaKind:'image', updated_at:11};
const imageTwo = {id:'image-2', type:'image', url:'/image-two.png', name:'第二张.png', mediaKind:'image', updated_at:22};
const prompt = {id:'prompt-1', type:'prompt', text:'not an image'};
nodes = [imageOne, imageTwo, prompt, node];
connections = [
  {id:'edge-first', from:'image-1', to:node.id},
  {id:'edge-second', from:'image-2', to:node.id},
];

assert.equal(adapter.canConnect(imageOne, node), true);
assert.equal(adapter.canConnect(prompt, node), false);
assert.equal(adapter.canConnect(node, imageOne), true);
const sources = adapter.sourcesForNode(node);
assert.deepEqual(Array.from(sources, item => item.sequence), [0, 1]);
assert.deepEqual(Array.from(sources, item => item.edgeId), ['edge-first', 'edge-second']);
assert.deepEqual(Array.from(sources, item => item.url), ['/display/image-one.png', '/display/image-two.png']);

assert.equal(adapter.openNode(node.id), true);
assert.equal(openedSessions.length, 1);
assert.deepEqual({...openedSessions[0].context}, {
  canvasType:'classic',
  canvasId:'canvas-1',
  nodeId:node.id,
  projectId:node.projectId,
  projectName:'图文分层项目',
  frameId:'frame-canvas',
  cloneSourceProjectId:'',
  documentWidth:1920,
  documentHeight:1080,
});
assert.deepEqual(Array.from(openedSessions[0].sources, source => source.edgeId), ['edge-first', 'edge-second']);

function dispatchMessage(data) {
  for(const handler of listeners.get('message') || []) {
    handler({origin:windowRef.location.origin, source:windowRef.parent, data});
  }
}

dispatchMessage({
  type:'hstar-openshop-node-meta',
  requestId:'meta-1',
  context:{canvasType:'classic', canvasId:'canvas-1', nodeId:node.id, projectId:node.projectId},
  meta:{
    previewUrl:'/api/openshop/assets/preview', layerCount:7, sourceUpdateCount:1,
    autosaveVersion:4, saveState:'saving', aiStatus:'running',
    aiTargetCount:5, aiCompletedCount:2, aiFailedCount:0,
  },
});
assert.equal(node.previewUrl, '/api/openshop/assets/preview');
assert.equal(node.layerCount, 7);
assert.equal(node.sourceUpdateCount, 1);
assert.equal(node.autosaveVersion, 4);
assert.equal(node.saveState, 'saving');
assert.equal(node.aiStatus, 'running');
assert.equal(node.aiTargetCount, 5);
assert.equal(node.aiCompletedCount, 2);
assert.equal(node.aiFailedCount, 0);
assert.match(adapter.renderNode(node).innerHTML, /生成中\s*2\s*\/\s*5/);

dispatchMessage({
  type:'hstar-openshop-node-meta',
  requestId:'meta-partial',
  context:{canvasType:'classic', canvasId:'canvas-1', nodeId:node.id, projectId:node.projectId},
  meta:{layerCount:7, saveState:'saved', aiStatus:'partial', aiTargetCount:5, aiCompletedCount:3, aiFailedCount:2},
});
assert.match(adapter.renderNode(node).innerHTML, /已完成\s*3\s*\/\s*5/);

dispatchMessage({
  type:'hstar-openshop-output',
  requestId:'output-1',
  context:{canvasType:'classic', canvasId:'canvas-1', nodeId:node.id, projectId:node.projectId},
  output:{assetId:'asset-output', url:'/api/openshop/assets/asset-output', name:'图文分层输出.png', width:1920, height:1080},
});
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
const output = nodes.find(item => item.openshopAssetId === 'asset-output');
assert.ok(output, 'OpenShop output should create an image node');
assert.equal(output.type, 'image');
assert.equal(output.sourceType, 'openshop-layered');
assert.ok(connections.some(connection => connection.from === node.id && connection.to === output.id));
assert.equal(selected.has(output.id), true);
assert.equal(undoCount, 1);
assert.ok(renderCount > 0);
assert.equal(saveCount, 1);

const clone = {...node, id:'openshop-copy'};
adapter.prepareClone(node, clone);
assert.notEqual(clone.projectId, node.projectId);
assert.equal(clone.cloneSourceProjectId, node.projectId);
assert.equal(clone.saveState, 'new');
assert.equal(clone.autosaveVersion, 0);
assert.equal(clone.aiStatus, '');
assert.equal(clone.aiTargetCount, 0);

assert.equal(disposedProjects.length, 0, 'opening and metadata updates must not dispose projects');
assert.equal(adapter.disposeNode(node), true);
assert.equal(disposedProjects.length, 1);
assert.equal(disposedProjects[0].projectId, node.projectId);
assert.deepEqual({...disposedProjects[0].context}, {
  canvasType:'classic', canvasId:'canvas-1', nodeId:node.id, projectId:node.projectId,
});

assert.match(htmlSource, /src=["']\/static\/js\/canvas-openshop\.js(?:\?[^"']*)?["']/);
assert.match(htmlSource, /addOpenShopLayeredNode\(\)/);
assert.match(htmlSource, /menuAdd\(['"]openshop-layered['"]\)/);
assert.match(canvasSource, /function\s+addOpenShopLayeredNode\s*\(/);
assert.match(canvasSource, /HstarClassicOpenShopAdapter\??\.renderNode/);
assert.match(canvasSource, /HstarClassicOpenShopAdapter\??\.canConnect/);
assert.match(canvasSource, /HstarClassicOpenShopAdapter\??\.prepareClone/);
assert.match(canvasSource, /type\s*===\s*['"]openshop-layered['"]/);
assert.match(canvasSource, /HstarClassicOpenShopAdapter\??\.disposeNode\??\.\(node\)/);
assert.match(cssSource, /\.openshop-layered-node/);
assert.match(cssSource, /aspect-ratio:\s*16\s*\/\s*9/);
assert.match(i18nSource, /canvas\.openshopLayered/);
assert.match(i18nSource, /canvas\.openshopOpen/);
assert.match(i18nSource, /canvas\.openshopSourceUpdates/);

console.log('OpenShop classic canvas node session flow tests passed');
