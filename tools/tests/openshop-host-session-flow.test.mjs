import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const protocolPath = 'integrations/openshop/host/openshop-protocol.js';
const hostPath = 'static/js/openshop-host.js';
assert.ok(fs.existsSync(hostPath), `${hostPath} should exist`);

const protocolSource = fs.readFileSync(protocolPath, 'utf8');
const hostSource = fs.readFileSync(hostPath, 'utf8');
const shellSource = fs.readFileSync('static/index.html', 'utf8');
assert.match(shellSource, /\/static\/css\/openshop-host\.css/);
const shellProtocolIndex = shellSource.indexOf('/static/openshop/host/openshop-protocol.js');
const shellHostIndex = shellSource.indexOf('/static/js/openshop-host.js');
assert.ok(shellProtocolIndex > 0, 'Studio Shell should load the OpenShop protocol');
assert.ok(shellHostIndex > shellProtocolIndex, 'Studio Shell should load the OpenShop host after its protocol');

function classList() {
  const values = new Set();
  return {
    add(...names) { names.forEach(name => values.add(name)); },
    remove(...names) { names.forEach(name => values.delete(name)); },
    toggle(name, force) {
      if(force === true || (force === undefined && !values.has(name))) values.add(name);
      else values.delete(name);
      return values.has(name);
    },
    contains(name) { return values.has(name); },
  };
}

function createElement(id = '') {
  const listeners = new Map();
  return {
    id,
    dataset: {},
    classList: classList(),
    style: {},
    attributes: {},
    disabled: false,
    textContent: '',
    innerHTML: '',
    src: '',
    children: [],
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatch(type, event = {}) {
      for(const handler of listeners.get(type) || []) handler({target:this, preventDefault() {}, ...event});
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
}

const listeners = new Map();
const editorMessages = [];
const canvasMessages = [];
const fetchCalls = [];
const switchUICalls = [];
let uploadedSourceCount = 0;

const editorWindow = {
  postMessage(message, origin) {
    editorMessages.push({message, origin});
  },
};
const canvasWindow = {
  postMessage(message, origin) {
    canvasMessages.push({message, origin});
  },
};

const overlay = createElement('openshop-host');
overlay.setAttribute('aria-hidden', 'true');
const frame = createElement('frame-openshop');
frame.dataset.src = '/static/openshop/index.html';
frame.contentWindow = editorWindow;
const canvasFrame = createElement('frame-canvas');
canvasFrame.contentWindow = canvasWindow;
const title = createElement('openshop-title');
const status = createElement('openshop-state');
const sourcesButton = createElement('openshop-sources');
const sourcePanel = createElement('openshop-source-panel');
const backButton = createElement('openshop-back');
const saveButton = createElement('openshop-save');
const sendButton = createElement('openshop-send');

const selectorElements = new Map([
  ['[data-openshop-title]', title],
  ['[data-openshop-state]', status],
  ['[data-openshop-sources]', sourcesButton],
  ['[data-openshop-source-panel]', sourcePanel],
  ['[data-openshop-back]', backButton],
  ['[data-openshop-save]', saveButton],
  ['[data-openshop-send]', sendButton],
]);
overlay.querySelector = selector => selectorElements.get(selector) || null;

const elements = new Map([
  [overlay.id, overlay],
  [frame.id, frame],
  [canvasFrame.id, canvasFrame],
]);

const project = {
  schemaVersion: 1,
  projectId: 'project-1',
  owner: {canvasType:'classic', canvasId:'canvas-1', nodeId:'layered-1'},
  document: {width:1920, height:1080},
  editor: {objects:[]},
  layers: [],
  sourceBindings: [],
  assetRefs: [],
  previewAssetId: '',
  autosaveVersion: 1,
};

function response({ok = true, status = 200, json = {}, blob = null, text = ''} = {}) {
  return {
    ok,
    status,
    async json() { return json; },
    async blob() { return blob || new Blob(['image'], {type:'image/png'}); },
    async text() { return text || JSON.stringify(json); },
  };
}

async function fetchFake(url, options = {}) {
  const method = String(options.method || 'GET').toUpperCase();
  fetchCalls.push({url:String(url), method, options});
  if(String(url).startsWith('/source-')) {
    return response({blob:new Blob([String(url)], {type:'image/png'})});
  }
  if(method === 'GET' && String(url).startsWith('/api/openshop/projects/project-1?')) {
    return response({json:{project}});
  }
  if(method === 'POST' && String(url) === '/api/openshop/projects/project-1/assets') {
    uploadedSourceCount += 1;
    const assetId = `asset-source-${uploadedSourceCount}`;
    return response({json:{asset:{assetId, url:`/api/openshop/assets/${assetId}`, name:`source-${uploadedSourceCount}.png`}}});
  }
  if(method === 'PUT' && String(url) === '/api/openshop/projects/project-1') {
    const body = JSON.parse(options.body);
    return response({json:{project:{...body.project, autosaveVersion:2, previewAssetId:'asset-preview'}}});
  }
  return response({ok:false, status:404, json:{detail:'Not Found'}});
}

const documentRef = {
  body: createElement('body'),
  readyState: 'complete',
  contains(element) { return elements.has(element?.id); },
  createElement,
  addEventListener() {},
  getElementById(id) { return elements.get(id) || null; },
  querySelector(selector) {
    if(selectorElements.has(selector)) return selectorElements.get(selector);
    return null;
  },
};

const windowRef = {
  location: {origin:'http://127.0.0.1:3000'},
  crypto: {randomUUID: (() => { let id = 0; return () => `host-${++id}`; })()},
  addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  },
  removeEventListener() {},
  lucide: {createIcons() {}},
  switchUI(trigger, pageId) { switchUICalls.push({trigger, pageId}); },
};

function dispatchEditorMessage(data) {
  for(const handler of listeners.get('message') || []) {
    handler({origin:windowRef.location.origin, source:editorWindow, data});
  }
}

async function flushAsync() {
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
}

const sandbox = {
  Blob,
  FormData,
  URL,
  URLSearchParams,
  console,
  document: documentRef,
  encodeURIComponent,
  fetch: fetchFake,
  setTimeout,
  clearTimeout,
  window: windowRef,
};
sandbox.window.document = documentRef;
sandbox.window.fetch = fetchFake;
sandbox.window.setTimeout = setTimeout;
sandbox.window.clearTimeout = clearTimeout;

vm.createContext(sandbox);
vm.runInContext(protocolSource, sandbox, {filename:protocolPath});
vm.runInContext(hostSource, sandbox, {filename:hostPath});

const protocol = sandbox.window.HstarOpenShopProtocol;
const host = sandbox.window.HstarOpenShopHost;
assert.equal(typeof host?.openNodeSession, 'function');

const sources = [
  {edgeId:'edge-1', sourceNodeId:'image-1', assetVersion:'v1', name:'第一张.png', url:'/source-1.png', sequence:0},
  {edgeId:'edge-2', sourceNodeId:'image-2', assetVersion:'v1', name:'第二张.png', url:'/source-2.png', sequence:1},
];
host.openNodeSession({
  canvasType:'classic', canvasId:'canvas-1', nodeId:'layered-1',
  projectId:'project-1', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
}, sources);

assert.equal(overlay.classList.contains('is-open'), true);
assert.equal(overlay.getAttribute('aria-hidden'), 'false');
assert.match(frame.src, /\/static\/openshop\/index\.html/);
frame.dispatch('load');
assert.deepEqual(editorMessages.map(item => item.message.type), [protocol.TYPES.OPEN_SESSION]);
const sessionId = editorMessages[0].message.sessionId;

dispatchEditorMessage(protocol.createEnvelope({
  type:protocol.TYPES.READY,
  sessionId,
  requestId:'editor-ready-1',
  context:{canvasType:'classic', canvasId:'canvas-1', nodeId:'layered-1', projectId:'project-1'},
  payload:{ready:true},
}));
await flushAsync();

assert.deepEqual(editorMessages.map(item => item.message.type), [
  protocol.TYPES.OPEN_SESSION,
  protocol.TYPES.LOAD_PROJECT,
  protocol.TYPES.SYNC_SOURCES,
]);
assert.equal(uploadedSourceCount, 2);
assert.deepEqual(
  Array.from(editorMessages[2].message.payload.sources, source => source.sequence),
  [0, 1],
);

const saveProject = {
  ...project,
  previewAssetId:'asset-preview',
  autosaveVersion:1,
  layers:[{layerId:'layer-1', name:'图层 1'}],
  sourceBindings:[{
    layerId:'layer-1', edgeId:'edge-1', sourceNodeId:'image-1',
    assetId:'asset-source-1', assetVersion:'v1', sequence:0, state:'bound',
  }],
};
dispatchEditorMessage(protocol.createEnvelope({
  type:protocol.TYPES.SAVE_PROJECT,
  sessionId,
  requestId:'save-1',
  context:{...project.owner, projectId:'project-1'},
  payload:{reason:'manual', closeAfter:false, project:saveProject},
}));
await flushAsync();

const putCall = fetchCalls.find(call => call.method === 'PUT');
assert.ok(putCall, 'SAVE_PROJECT should persist through the project API');
assert.equal(JSON.parse(putCall.options.body).base_version, 1);
assert.equal(editorMessages.at(-1).message.type, protocol.TYPES.SAVE_CONFIRMED);
const metaMessage = canvasMessages.find(item => item.message.type === 'hstar-openshop-node-meta');
assert.ok(metaMessage, 'save confirmation should update only the originating canvas iframe');
assert.equal(metaMessage.message.context.nodeId, 'layered-1');
assert.equal(metaMessage.message.meta.layerCount, 1);

dispatchEditorMessage(protocol.createEnvelope({
  type:protocol.TYPES.SEND_TO_CANVAS,
  sessionId,
  requestId:'send-1',
  context:{...project.owner, projectId:'project-1'},
  payload:{
    assetId:'asset-output',
    url:'/api/openshop/assets/asset-output',
    name:'图文分层输出.png',
    width:1920,
    height:1080,
  },
}));
await flushAsync();

const outputMessage = canvasMessages.find(item => item.message.type === 'hstar-openshop-output');
assert.ok(outputMessage, 'composited output should return to the originating canvas iframe');
assert.equal(outputMessage.message.output.assetId, 'asset-output');
assert.equal(outputMessage.message.output.url, '/api/openshop/assets/asset-output');
assert.doesNotMatch(JSON.stringify(outputMessage.message), /data:image\/|blob:/);

dispatchEditorMessage(protocol.createEnvelope({
  type:protocol.TYPES.OPEN_API_SETTINGS,
  sessionId,
  requestId:'open-api-settings-1',
  context:{...project.owner, projectId:'project-1'},
  payload:{},
}));
await flushAsync();

assert.equal(overlay.classList.contains('is-open'), false, 'API settings command should close the full-screen editor overlay');
assert.equal(switchUICalls.length, 1, 'API settings command should route through the Studio shell');
assert.equal(switchUICalls[0].pageId, 'api-settings');

assert.match(hostSource, /mode:\s*['"]replace['"]/);
assert.match(hostSource, /mode:\s*['"]add['"]/);
assert.match(hostSource, /mode:\s*['"]ignore['"]/);
assert.match(hostSource, /Protocol\.TYPES\.OPEN_API_SETTINGS/);
assert.match(hostSource, /Object\.freeze\(\{[\s\S]*openNodeSession[\s\S]*requestSave[\s\S]*requestSendToCanvas[\s\S]*refreshSources[\s\S]*close[\s\S]*getState/);

console.log('OpenShop full-screen host session flow tests passed');
