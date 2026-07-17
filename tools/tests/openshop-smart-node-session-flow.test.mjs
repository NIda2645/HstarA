import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const adapterPath = 'static/js/smart-canvas-openshop.js';
assert.ok(fs.existsSync(adapterPath), `${adapterPath} should exist`);

const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const canvasSource = fs.readFileSync('static/js/smart-canvas.js', 'utf8');
const htmlSource = fs.readFileSync('static/smart-canvas.html', 'utf8');
const cssSource = fs.readFileSync('static/css/smart-canvas.css', 'utf8');
const i18nSource = fs.readFileSync('static/js/i18n/smart-canvas.js', 'utf8');

const listeners = new Map();
const openedSessions = [];
const disposedProjects = [];
const createdOutputs = [];
let renderCount = 0;
let saveCount = 0;
let undoCount = 0;
let scheduleCount = 0;
let uidCount = 0;
let canvasId = 'smart-canvas-source';
const selected = new Set();

const imageOne = {
  id:'smart-image-1',
  type:'smart-image',
  images:[{url:'/smart-one.png', name:'智能一.png', kind:'image', assetVersion:'v1'}],
};
const imageTwo = {
  id:'smart-image-2',
  type:'smart-image',
  images:[{url:'/smart-two.png', name:'智能二.png', kind:'image', assetVersion:'v2'}],
};
const prompt = {id:'smart-prompt-1', type:'smart-prompt', text:'not an image'};
let projectNode = null;
const nodes = [imageOne, imageTwo, prompt];
const connections = [];

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
    uidCount += 1;
    return `${prefix}_${uidCount}`;
  },
  getCanvasId: () => canvasId,
  getNode: id => nodes.find(node => node.id === id) || null,
  getConnections: () => connections,
  inputImagesForNode(node) {
    return connections
      .filter(connection => connection.to === node.id && (connection.kind || 'flow') === 'input')
      .flatMap(connection => {
        const source = nodes.find(candidate => candidate.id === connection.from);
        return (source?.images || []).map((image, imageIndex) => ({
          ...image,
          nodeId:source.id,
          sourceNodeId:source.id,
          imageIndex,
        }));
      });
  },
  displayMediaUrl: url => `/display${url}`,
  createImageOutput({sourceNode, output, requestId}) {
    const node = {
      id:`smart-output-${createdOutputs.length + 1}`,
      type:'smart-image',
      images:[{url:output.url, name:output.name, kind:'image', openshopAssetId:output.assetId}],
      sourceType:'openshop-layered',
      openshopSourceNodeId:sourceNode.id,
      openshopRequestId:requestId,
    };
    nodes.push(node);
    connections.push({from:sourceNode.id, to:node.id, kind:'flow'});
    createdOutputs.push(node);
    return node;
  },
  pushUndo() { undoCount += 1; },
  selectOnly(id) { selected.clear(); selected.add(id); },
  render() { renderCount += 1; },
  scheduleSave() { scheduleCount += 1; },
  async saveCanvas() { saveCount += 1; },
  t: key => key,
  toast() {},
};

const parentRef = {HstarOpenShopHost:host};
const windowRef = {
  location:{origin:'http://127.0.0.1:3000'},
  frameElement:{id:'frame-smart-canvas'},
  parent:parentRef,
  crypto:{randomUUID:(() => { let id = 100; return () => `smart-project-${++id}`; })()},
  HstarSmartCanvasOpenShopHooks:hooks,
  addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  },
};

const sandbox = {
  console,
  Date,
  document:{createElement:() => ({className:'', innerHTML:'', querySelector:() => null})},
  window:windowRef,
};
vm.createContext(sandbox);
vm.runInContext(adapterSource, sandbox, {filename:adapterPath});

const adapter = sandbox.window.HstarSmartOpenShopAdapter;
assert.ok(adapter, 'smart OpenShop adapter should be exported');
projectNode = adapter.createNode({x:210, y:260});
nodes.push(projectNode);
assert.equal(projectNode.type, 'openshop-layered');
assert.match(projectNode.projectId, /^osp_/);
assert.equal(projectNode.saveState, 'new');
assert.equal(projectNode.aiStatus, '');
assert.equal(projectNode.aiTargetCount, 0);
assert.equal(projectNode.cloneSourceCanvasType, '');
assert.equal(projectNode.cloneSourceCanvasId, '');
assert.equal(projectNode.cloneSourceNodeId, '');
assert.equal(projectNode.x, 210);
assert.equal(projectNode.y, 260);

connections.push(
  {id:'smart-edge-first', from:imageOne.id, to:projectNode.id, kind:'input'},
  {id:'smart-edge-second', from:imageTwo.id, to:projectNode.id, kind:'input'},
);
projectNode.inputNodeIds = [imageOne.id, imageTwo.id];

assert.equal(adapter.canConnect(imageOne, projectNode), true);
assert.equal(adapter.canConnect(prompt, projectNode), false);
assert.equal(adapter.canConnect(projectNode, imageOne), true);
const sources = adapter.sourcesForNode(projectNode);
assert.deepEqual(Array.from(sources, source => source.edgeId), ['smart-edge-first:0', 'smart-edge-second:0']);
assert.deepEqual(Array.from(sources, source => source.sequence), [0, 1]);
assert.deepEqual(Array.from(sources, source => source.url), ['/display/smart-one.png', '/display/smart-two.png']);

assert.equal(adapter.openNode(projectNode.id), true);
assert.equal(openedSessions.length, 1);
assert.deepEqual({...openedSessions[0].context}, {
  canvasType:'smart',
  canvasId:'smart-canvas-source',
  nodeId:projectNode.id,
  projectId:projectNode.projectId,
  projectName:'图文分层项目',
  frameId:'frame-smart-canvas',
  cloneSourceProjectId:'',
  cloneSourceCanvasType:'',
  cloneSourceCanvasId:'',
  cloneSourceNodeId:'',
  documentWidth:1920,
  documentHeight:1080,
});

function dispatchMessage(data, source = parentRef) {
  for(const handler of listeners.get('message') || []) {
    handler({origin:windowRef.location.origin, source, data});
  }
}

dispatchMessage({
  type:'hstar-openshop-node-meta',
  requestId:'smart-meta-1',
  context:{canvasType:'smart', canvasId:'smart-canvas-source', nodeId:projectNode.id, projectId:projectNode.projectId},
  meta:{
    previewUrl:'/api/openshop/assets/smart-preview', layerCount:7, sourceUpdateCount:2,
    autosaveVersion:5, saveState:'saving', aiStatus:'running',
    aiTargetCount:5, aiCompletedCount:2, aiFailedCount:0,
  },
});
assert.equal(projectNode.previewUrl, '/api/openshop/assets/smart-preview');
assert.equal(projectNode.layerCount, 7);
assert.equal(projectNode.sourceUpdateCount, 2);
assert.equal(projectNode.autosaveVersion, 5);
assert.equal(projectNode.aiStatus, 'running');
assert.equal(projectNode.aiTargetCount, 5);
assert.equal(projectNode.aiCompletedCount, 2);
assert.equal(projectNode.aiFailedCount, 0);
assert.match(adapter.renderNode(projectNode), /生成中\s*2\s*\/\s*5/);

dispatchMessage({
  type:'hstar-openshop-node-meta',
  context:{canvasType:'smart', canvasId:'smart-canvas-source', nodeId:projectNode.id, projectId:projectNode.projectId},
  meta:{layerCount:7, saveState:'saved', aiStatus:'partial', aiTargetCount:5, aiCompletedCount:3, aiFailedCount:2},
});
assert.match(adapter.renderNode(projectNode), /已完成\s*3\s*\/\s*5/);

dispatchMessage({
  type:'hstar-openshop-node-meta',
  context:{canvasType:'classic', canvasId:'smart-canvas-source', nodeId:projectNode.id, projectId:projectNode.projectId},
  meta:{layerCount:99},
});
assert.equal(projectNode.layerCount, 7, 'classic canvas messages must not update smart nodes');

const outputMessage = {
  type:'hstar-openshop-output',
  requestId:'smart-output-1',
  context:{canvasType:'smart', canvasId:'smart-canvas-source', nodeId:projectNode.id, projectId:projectNode.projectId},
  output:{assetId:'smart-asset-output', url:'/api/openshop/assets/smart-asset-output', name:'智能图文分层输出.png'},
};
dispatchMessage(outputMessage);
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.equal(createdOutputs.length, 1);
assert.equal(createdOutputs[0].type, 'smart-image');
assert.equal(createdOutputs[0].images[0].openshopAssetId, 'smart-asset-output');
assert.equal(connections.some(connection => connection.from === projectNode.id && connection.to === createdOutputs[0].id && connection.kind === 'flow'), true);
assert.equal(selected.has(createdOutputs[0].id), true);
assert.equal(undoCount, 1);
assert.ok(renderCount > 0);
assert.equal(saveCount, 1);

dispatchMessage(outputMessage);
await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
assert.equal(createdOutputs.length, 1, 'duplicate requestId must not create another output');

const clone = {...projectNode, id:'smart-openshop-copy'};
adapter.prepareClone(projectNode, clone);
assert.notEqual(clone.projectId, projectNode.projectId);
assert.equal(clone.cloneSourceProjectId, projectNode.projectId);
assert.equal(clone.cloneSourceCanvasType, 'smart');
assert.equal(clone.cloneSourceCanvasId, 'smart-canvas-source');
assert.equal(clone.cloneSourceNodeId, projectNode.id);
assert.equal(clone.saveState, 'new');
assert.equal(clone.autosaveVersion, 0);
assert.equal(clone.aiStatus, '');
assert.equal(clone.aiTargetCount, 0);
nodes.push(clone);
canvasId = 'smart-canvas-target';
assert.equal(adapter.openNode(clone.id), true);
assert.equal(openedSessions.length, 2);
assert.equal(openedSessions[1].context.canvasId, 'smart-canvas-target');
assert.equal(openedSessions[1].context.cloneSourceProjectId, projectNode.projectId);
assert.equal(openedSessions[1].context.cloneSourceCanvasType, 'smart');
assert.equal(openedSessions[1].context.cloneSourceCanvasId, 'smart-canvas-source');
assert.equal(openedSessions[1].context.cloneSourceNodeId, projectNode.id);

dispatchMessage({
  type:'hstar-openshop-node-meta',
  requestId:'smart-clone-meta-1',
  context:{canvasType:'smart', canvasId:'smart-canvas-target', nodeId:clone.id, projectId:clone.projectId},
  meta:{autosaveVersion:1, saveState:'saved'},
});
assert.equal(clone.cloneSourceProjectId, '');
assert.equal(clone.cloneSourceCanvasType, '');
assert.equal(clone.cloneSourceCanvasId, '');
assert.equal(clone.cloneSourceNodeId, '');

canvasId = 'smart-canvas-source';
assert.equal(disposedProjects.length, 0, 'opening and metadata updates must not dispose projects');
assert.equal(adapter.disposeNode(projectNode), true);
assert.equal(disposedProjects.length, 1);
assert.equal(disposedProjects[0].projectId, projectNode.projectId);
assert.deepEqual({...disposedProjects[0].context}, {
  canvasType:'smart', canvasId:'smart-canvas-source', nodeId:projectNode.id, projectId:projectNode.projectId,
});

assert.match(htmlSource, /src=["']\/static\/js\/smart-canvas-openshop\.js(?:\?[^"']*)?["']/);
assert.match(htmlSource, /data-create-type=["']openshop-layered["']/);
assert.match(canvasSource, /function\s+createOpenShopLayeredNode\s*\(/);
assert.match(canvasSource, /HstarSmartOpenShopAdapter\??\.renderNode/);
assert.match(canvasSource, /HstarSmartOpenShopAdapter\??\.canConnect/);
assert.ok((canvasSource.match(/HstarSmartOpenShopAdapter\??\.prepareClone/g) || []).length >= 2, 'both cloneSmartNode definitions should isolate OpenShop projects');
assert.match(canvasSource, /type\s*===\s*['"]openshop-layered['"]/);
assert.match(canvasSource, /HstarSmartOpenShopAdapter\??\.disposeNode\??\.\(node\)/);
assert.match(cssSource, /\.openshop-layered-node/);
assert.match(cssSource, /aspect-ratio:\s*16\s*\/\s*9/);
assert.match(i18nSource, /smart\.openshopLayered/);
assert.match(i18nSource, /smart\.openshopOpen/);
assert.match(i18nSource, /smart\.openshopSourceUpdates/);
assert.ok(scheduleCount > 0, 'node metadata updates should schedule canvas persistence');

console.log('OpenShop smart canvas node session flow tests passed');
