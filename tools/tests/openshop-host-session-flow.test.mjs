import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const protocolPath = 'integrations/openshop/host/openshop-protocol.js';
const hostPath = 'static/js/openshop-host.js';
const cssPath = 'static/css/openshop-host.css';
const protocolSource = fs.readFileSync(protocolPath, 'utf8');
const hostSource = fs.readFileSync(hostPath, 'utf8');
const cssSource = fs.readFileSync(cssPath, 'utf8');

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

let frameSequence = 0;
function createElement(tagName='div', id='') {
  const listeners = new Map();
  const element = {
    tagName:String(tagName).toUpperCase(),
    id,
    dataset:{},
    className:'',
    classList:classList(),
    style:{},
    attributes:{},
    disabled:false,
    hidden:false,
    isConnected:true,
    textContent:'',
    innerHTML:'',
    src:'',
    title:'',
    children:[],
    parentElement:null,
    setAttribute(name, value) { this.attributes[name] = String(value); },
    getAttribute(name) { return this.attributes[name]; },
    appendChild(child) {
      child.parentElement = this;
      child.isConnected = true;
      this.children.push(child);
      return child;
    },
    remove() {
      this.isConnected = false;
      if(this.parentElement){
        const index = this.parentElement.children.indexOf(this);
        if(index >= 0) this.parentElement.children.splice(index, 1);
      }
      this.parentElement = null;
    },
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatch(type, event={}) {
      for(const handler of listeners.get(type) || []) handler({target:this, preventDefault() {}, ...event});
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
  };
  if(element.tagName === 'IFRAME'){
    frameSequence += 1;
    const messages = [];
    element.contentWindow = {
      id:`editor-window-${frameSequence}`,
      closed:false,
      messages,
      postMessage(message, origin) { messages.push({message, origin}); },
    };
  }
  return element;
}

const listeners = new Map();
const fetchCalls = [];
const switchUICalls = [];
const deletedProjects = [];
const attachedVoiceFrames = [];
const deactivatedVoiceFrames = [];
const detachedVoiceFrames = [];
const delayedSourceFetches = new Map();
const delayedProjectSaves = new Map();
const longTimers = new Map();
let longTimerSequence = 0;
const overlay = createElement('section', 'openshop-host');
overlay.setAttribute('aria-hidden', 'true');
const title = createElement('strong', 'openshop-title');
const status = createElement('span', 'openshop-state');
const sourcesButton = createElement('button', 'openshop-sources');
const sourcePanel = createElement('aside', 'openshop-source-panel');
const notice = createElement('div', 'openshop-notice');
const backButton = createElement('button', 'openshop-back');
const saveButton = createElement('button', 'openshop-save');
const sendButton = createElement('button', 'openshop-send');
const canvasFrameA = createElement('iframe', 'frame-canvas-a');
const canvasFrameB = createElement('iframe', 'frame-canvas-b');

const selectorElements = new Map([
  ['[data-openshop-title]', title],
  ['[data-openshop-state]', status],
  ['[data-openshop-sources]', sourcesButton],
  ['[data-openshop-source-panel]', sourcePanel],
  ['[data-openshop-notice]', notice],
  ['[data-openshop-back]', backButton],
  ['[data-openshop-save]', saveButton],
  ['[data-openshop-send]', sendButton],
]);
overlay.querySelector = selector => selectorElements.get(selector) || null;

const elements = new Map([
  [overlay.id, overlay],
  [canvasFrameA.id, canvasFrameA],
  [canvasFrameB.id, canvasFrameB],
]);
const projectRecords = new Map([
  ['project-a', {
    schemaVersion:1, projectId:'project-a',
    owner:{canvasType:'classic', canvasId:'canvas-a', nodeId:'node-a'},
    document:{width:1920, height:1080}, editor:{objects:[]}, layers:[], sourceBindings:[],
    aiTaskRecords:[], assetRefs:[], previewAssetId:'', autosaveVersion:1,
  }],
  ['project-b', {
    schemaVersion:1, projectId:'project-b',
    owner:{canvasType:'smart', canvasId:'canvas-b', nodeId:'node-b'},
    document:{width:1280, height:720}, editor:{objects:[]}, layers:[], sourceBindings:[],
    aiTaskRecords:[], assetRefs:[], previewAssetId:'', autosaveVersion:1,
  }],
]);

function response({ok=true, status=200, json={}, blob=null, text=''}={}) {
  return {
    ok,
    status,
    async json() { return structuredClone(json); },
    async blob() { return blob || new Blob(['image'], {type:'image/png'}); },
    async text() { return text || JSON.stringify(json); },
  };
}

async function fetchFake(url, options={}) {
  const value = String(url);
  const method = String(options.method || 'GET').toUpperCase();
  fetchCalls.push({url:value, method, options});
  if(value.startsWith('/source-')) {
    await delayedSourceFetches.get(value);
    return response({blob:new Blob([value], {type:'image/png'})});
  }
  const projectMatch = value.match(/^\/api\/openshop\/projects\/([^/?]+)(?:[/?]|$)/);
  if(projectMatch){
    const projectId = decodeURIComponent(projectMatch[1]);
    if(value.endsWith('/assets')){
      return response({json:{asset:{
        assetId:`asset-${projectId}-${fetchCalls.length}`,
        url:`/api/openshop/assets/asset-${projectId}-${fetchCalls.length}`,
        name:`${projectId}.png`,
      }}});
    }
    if(method === 'GET'){
      const project = projectRecords.get(projectId);
      return project ? response({json:{project}}) : response({ok:false, status:404, json:{detail:'Not Found'}});
    }
    if(method === 'PUT'){
      const body = JSON.parse(options.body);
      await delayedProjectSaves.get(projectId);
      const saved = {...body.project, autosaveVersion:Number(body.base_version || 0) + 1};
      projectRecords.set(projectId, saved);
      return response({json:{project:saved}});
    }
    if(method === 'DELETE'){
      deletedProjects.push(projectId);
      projectRecords.delete(projectId);
      return response({json:{ok:true}});
    }
  }
  return response({ok:false, status:404, json:{detail:'Not Found'}});
}

const documentRef = {
  body:createElement('body', 'body'),
  readyState:'complete',
  contains(element) { return Boolean(element?.isConnected); },
  createElement(tagName) { return createElement(tagName); },
  addEventListener() {},
  getElementById(id) { return elements.get(id) || null; },
  querySelector(selector) { return selectorElements.get(selector) || null; },
};

const windowRef = {
  location:{origin:'http://127.0.0.1:3000'},
  crypto:{randomUUID:(() => { let id = 0; return () => `host-${++id}`; })()},
  addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  },
  removeEventListener() {},
  lucide:{createIcons() {}},
  HstarVoiceAssistant:{
    attachFrame(frame) { attachedVoiceFrames.push(frame); },
    deactivateFrame(frame, reason) { deactivatedVoiceFrames.push({frame, reason}); },
    detachFrame(frame, reason) { detachedVoiceFrames.push({frame, reason}); },
  },
  switchUI(trigger, pageId) { switchUICalls.push({trigger, pageId}); },
};

function setTimeoutFake(handler, delay, ...args) {
  if(Number(delay) >= 10_000){
    const id = `long-timer-${++longTimerSequence}`;
    longTimers.set(id, () => handler(...args));
    return id;
  }
  return setTimeout(handler, delay, ...args);
}

function clearTimeoutFake(id) {
  if(longTimers.delete(id)) return;
  clearTimeout(id);
}

function dispatchEditorMessage(frame, data) {
  for(const handler of listeners.get('message') || []){
    handler({origin:windowRef.location.origin, source:frame.contentWindow, data});
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
  structuredClone,
  document:documentRef,
  encodeURIComponent,
  fetch:fetchFake,
  setTimeout:setTimeoutFake,
  clearTimeout:clearTimeoutFake,
  window:windowRef,
};
sandbox.window.document = documentRef;
sandbox.window.fetch = fetchFake;
sandbox.window.setTimeout = setTimeoutFake;
sandbox.window.clearTimeout = clearTimeoutFake;

vm.createContext(sandbox);
vm.runInContext(protocolSource, sandbox, {filename:protocolPath});
vm.runInContext(hostSource, sandbox, {filename:hostPath});

const protocol = sandbox.window.HstarOpenShopProtocol;
const host = sandbox.window.HstarOpenShopHost;
const contextA = {
  canvasType:'classic', canvasId:'canvas-a', nodeId:'node-a', projectId:'project-a',
  projectName:'海报 A', frameId:'frame-canvas-a', documentWidth:1920, documentHeight:1080,
};
const contextB = {
  canvasType:'smart', canvasId:'canvas-b', nodeId:'node-b', projectId:'project-b',
  projectName:'海报 B', frameId:'frame-canvas-b', documentWidth:1280, documentHeight:720,
};
const sourcesA = [{
  edgeId:'edge-a', sourceNodeId:'image-a', assetVersion:'v1', name:'来源 A.png', url:'/source-a.png', sequence:0,
}];

function frameFor(context) {
  const scope = protocol.createProjectScope(context);
  return overlay.children.find(child => child.dataset?.projectScope === scope);
}

function editorMessages(frame) {
  return frame.contentWindow.messages.map(item => item.message);
}

function readyFrame(frame, context, requestId) {
  const open = editorMessages(frame).find(message => message.type === protocol.TYPES.OPEN_SESSION);
  assert.ok(open, 'frame should receive OPEN_SESSION before READY');
  dispatchEditorMessage(frame, protocol.createEnvelope({
    type:protocol.TYPES.READY,
    sessionId:open.sessionId,
    requestId,
    context,
    payload:{ready:true},
  }));
  return open.sessionId;
}

host.openNodeSession(contextA, sourcesA);
const frameA = frameFor(contextA);
assert.ok(frameA, 'project A should create a dedicated iframe');
assert.deepEqual(attachedVoiceFrames, [frameA], 'dynamic editor iframe should register with voice input');
assert.equal(frameA.hidden, true, 'sourced editor should stay hidden until source synchronization finishes');
assert.equal(overlay.classList.contains('is-open'), true);
assert.deepEqual(editorMessages(frameA), [], 'the host must not message an iframe before its first load');
frameA.dispatch('load');
frameA.dispatch('load');
assert.equal(
  editorMessages(frameA).filter(message => message.type === protocol.TYPES.OPEN_SESSION).length,
  2,
  'the real editor load should resend OPEN_SESSION after an initial about:blank load',
);
const sessionA = readyFrame(frameA, contextA, 'ready-a');
await flushAsync();
assert.deepEqual(editorMessages(frameA).map(message => message.type), [
  protocol.TYPES.OPEN_SESSION,
  protocol.TYPES.SESSION_VISIBILITY,
  protocol.TYPES.OPEN_SESSION,
  protocol.TYPES.LOAD_PROJECT,
  protocol.TYPES.SYNC_SOURCES,
]);
dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.PROJECT_CHANGED,
  sessionId:sessionA,
  requestId:'reveal-a',
  context:contextA,
  payload:{project:projectRecords.get('project-a'), reason:'sources-synchronized'},
}));
await flushAsync();
assert.equal(frameA.hidden, false, 'sourced editor should reveal after source synchronization');
assert.equal(editorMessages(frameA).at(-1).type, protocol.TYPES.FIT_WORKSPACE);

host.close();
assert.equal(overlay.classList.contains('is-open'), false, 'close should only hide the full-screen host');
assert.equal(frameA.isConnected, true, 'hidden project iframe should remain mounted');
assert.equal(frameA.contentWindow.closed, false);
assert.equal(editorMessages(frameA).some(message => message.type === protocol.TYPES.REQUEST_SAVE), false);
assert.equal(editorMessages(frameA).some(message => message.type === protocol.TYPES.CLOSE), false);
assert.deepEqual(
  deactivatedVoiceFrames.at(-1),
  {frame:frameA, reason:'openshop-hidden'},
  'hiding OpenShop must clear and stop any voice target inside its iframe',
);

host.openNodeSession(contextB, []);
const frameB = frameFor(contextB);
assert.ok(frameB, 'project B should create a second iframe');
assert.notEqual(frameA, frameB);
assert.equal(frameA.hidden, true);
assert.deepEqual(
  deactivatedVoiceFrames.at(-1),
  {frame:frameA, reason:'openshop-session-switch'},
  'switching OpenShop projects must stop voice input in the hidden iframe',
);
assert.equal(frameB.hidden, true, 'empty editor should stay hidden until its project is restored');
frameB.dispatch('load');
const sessionB = readyFrame(frameB, contextB, 'ready-b');
await flushAsync();
dispatchEditorMessage(frameB, protocol.createEnvelope({
  type:protocol.TYPES.PROJECT_CHANGED,
  sessionId:sessionB,
  requestId:'reveal-b',
  context:contextB,
  payload:{project:projectRecords.get('project-b'), reason:'project-loaded'},
}));
await flushAsync();
assert.equal(frameB.hidden, false, 'empty editor should reveal after project restoration');
assert.equal(editorMessages(frameB).at(-1).type, protocol.TYPES.FIT_WORKSPACE);

const changedA = {
  ...projectRecords.get('project-a'),
  layers:[{layerId:'source-layer', name:'来源图层'}],
  aiTaskRecords:[{
    taskId:'parent-a', kind:'parent', status:'partial', targetCount:4,
    completedCount:3, failedCount:1,
  }],
};
dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.PROJECT_CHANGED,
  sessionId:sessionA,
  requestId:'changed-a',
  context:contextA,
  payload:{project:changedA, reason:'ai-generation'},
}));
dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.SAVE_PROJECT,
  sessionId:sessionA,
  requestId:'save-a',
  context:contextA,
  payload:{project:changedA, reason:'ai-generation', closeAfter:false},
}));
await flushAsync();

const metaA = canvasFrameA.contentWindow.messages
  .map(item => item.message)
  .filter(message => message.type === 'hstar-openshop-node-meta')
  .at(-1);
assert.ok(metaA, 'hidden project should still update its originating canvas');
assert.equal(metaA.context.canvasType, 'classic');
assert.equal(metaA.context.canvasId, 'canvas-a');
assert.equal(metaA.context.nodeId, 'node-a');
assert.equal(metaA.context.projectId, 'project-a');
assert.equal(metaA.meta.aiStatus, 'partial');
assert.equal(metaA.meta.aiTargetCount, 4);
assert.equal(metaA.meta.aiCompletedCount, 3);
assert.equal(metaA.meta.aiFailedCount, 1);

host.openNodeSession(contextA, sourcesA);
assert.equal(frameFor(contextA), frameA, 'reopening a project should reuse its iframe');
assert.equal(frameA.hidden, false);
assert.equal(frameB.hidden, true);
assert.equal(editorMessages(frameA).filter(message => message.type === protocol.TYPES.OPEN_SESSION).length, 2);

let releaseSlowSource;
delayedSourceFetches.set('/source-race-slow.png', new Promise(resolve => { releaseSlowSource = resolve; }));
const syncCountBeforeRace = editorMessages(frameA)
  .filter(message => message.type === protocol.TYPES.SYNC_SOURCES).length;
const slowRefresh = host.refreshSources([{
  edgeId:'edge-race', sourceNodeId:'image-race', assetVersion:'slow-v1',
  name:'慢来源.png', url:'/source-race-slow.png', sequence:0,
}], contextA);
await flushAsync();
const sourceUploadsBeforeFast = fetchCalls.filter(call => call.method === 'POST' && call.url.endsWith('/assets')).length;
const fastRefresh = host.refreshSources([{
  edgeId:'edge-race', sourceNodeId:'image-race', assetVersion:'fast-v2',
  name:'新来源.png', url:'/source-race-fast.png', sequence:0,
}], contextA);
await fastRefresh;
const sourceUploadsAfterFast = fetchCalls.filter(call => call.method === 'POST' && call.url.endsWith('/assets')).length;
assert.equal(sourceUploadsAfterFast, sourceUploadsBeforeFast + 1);
releaseSlowSource();
await slowRefresh;
assert.equal(
  fetchCalls.filter(call => call.method === 'POST' && call.url.endsWith('/assets')).length,
  sourceUploadsAfterFast,
  'superseded source synchronization must stop before uploading a stale asset',
);
const raceSyncMessages = editorMessages(frameA)
  .filter(message => message.type === protocol.TYPES.SYNC_SOURCES)
  .slice(syncCountBeforeRace);
assert.equal(raceSyncMessages.length, 1, 'a stale same-session refresh must not overwrite a newer source set');
assert.equal(raceSyncMessages[0].payload.sources[0].assetVersion, 'fast-v2');

let releaseDelayedSave;
delayedProjectSaves.set('project-a', new Promise(resolve => { releaseDelayedSave = resolve; }));
const delayedSaveProject = {
  ...projectRecords.get('project-a'),
  editor:{objects:[{id:'saved-older-edit'}]},
};
dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.SAVE_PROJECT,
  sessionId:sessionA,
  requestId:'save-delayed-a',
  context:contextA,
  payload:{project:delayedSaveProject, reason:'autosave', closeAfter:false},
}));
await flushAsync();
const newerProject = {
  ...delayedSaveProject,
  editor:{objects:[{id:'newer-unsaved-edit'}]},
};
dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.PROJECT_CHANGED,
  sessionId:sessionA,
  requestId:'changed-after-save-a',
  context:contextA,
  payload:{project:newerProject, reason:'user-edit'},
}));
releaseDelayedSave();
await flushAsync();
delayedProjectSaves.delete('project-a');
assert.equal(host.getState().status, 'dirty', 'an older save response must not mark newer edits as saved');
assert.deepEqual(
  host.getState().sessions.find(item => item.projectId === 'project-a')?.status,
  'dirty',
);

dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.SEND_TO_CANVAS,
  sessionId:sessionA,
  requestId:'send-a',
  context:contextA,
  payload:{assetId:'asset-output', url:'/api/openshop/assets/asset-output', name:'输出.png', width:1920, height:1080},
}));
await flushAsync();
assert.ok(canvasFrameA.contentWindow.messages.some(item => item.message.type === 'hstar-openshop-output'));
assert.equal(longTimers.size, 1, 'canvas output should wait for one bounded acknowledgement');
const initialOutputTimer = [...longTimers.keys()][0];
for(const handler of listeners.get('message') || []){
  handler({
    origin:windowRef.location.origin,
    source:canvasFrameA.contentWindow,
    data:{
      type:'hstar-openshop-output-applied', requestId:'send-a', context:contextA, status:'accepted',
    },
  });
}
assert.equal(longTimers.size, 1, 'accepted output should keep waiting for the final persistence result');
assert.notEqual(
  [...longTimers.keys()][0],
  initialOutputTimer,
  'accepted output should receive a fresh final-persistence deadline',
);
for(const handler of listeners.get('message') || []){
  handler({
    origin:windowRef.location.origin,
    source:canvasFrameA.contentWindow,
    data:{
      type:'hstar-openshop-output-applied', requestId:'send-a', context:contextA, status:'success',
    },
  });
}
assert.equal(longTimers.size, 0, 'a canvas acknowledgement should cancel its timeout');

dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.SEND_TO_CANVAS,
  sessionId:sessionA,
  requestId:'send-timeout-a',
  context:contextA,
  payload:{assetId:'asset-timeout', url:'/api/openshop/assets/asset-timeout', name:'超时.png', width:1, height:1},
}));
await flushAsync();
assert.equal(longTimers.size, 1);
longTimers.values().next().value();
longTimers.clear();
assert.match(notice.textContent, /超时/, 'missing canvas acknowledgement should produce a visible failure');

dispatchEditorMessage(frameA, protocol.createEnvelope({
  type:protocol.TYPES.OPEN_API_SETTINGS,
  sessionId:sessionA,
  requestId:'api-a',
  context:contextA,
  payload:{},
}));
await flushAsync();
assert.equal(overlay.classList.contains('is-open'), false);
assert.equal(switchUICalls.at(-1).pageId, 'api-settings');
assert.equal(frameA.isConnected, true, 'opening API settings must not dispose the project');

const disposed = await host.disposeProject('project-a', contextA);
assert.equal(disposed, true);
assert.equal(frameA.isConnected, false);
assert.equal(deletedProjects.includes('project-a'), false);
assert.equal(projectRecords.has('project-a'), true);
assert.equal(fetchCalls.some(call => (
  call.method === 'DELETE' && call.url.includes('/projects/project-a')
)), false);
assert.equal(editorMessages(frameA).at(-1).type, protocol.TYPES.CLOSE);
assert.equal(host.getState().sessionCount, 1);
assert.deepEqual(
  detachedVoiceFrames.at(-1),
  {frame:frameA, reason:'project-deleted'},
  'disposing an OpenShop session must detach its iframe from voice coordination',
);

async function openReadyEmptySession(projectId, index) {
  const context = {
    canvasType:'smart', canvasId:`canvas-${projectId}`, nodeId:`node-${projectId}`, projectId,
    projectName:`项目 ${index}`, frameId:`frame-${projectId}`, documentWidth:640, documentHeight:480,
  };
  projectRecords.set(projectId, {
    schemaVersion:1, projectId,
    owner:{canvasType:context.canvasType, canvasId:context.canvasId, nodeId:context.nodeId},
    document:{width:640, height:480}, editor:{objects:[]}, layers:[], sourceBindings:[],
    aiTaskRecords:[], assetRefs:[], previewAssetId:'', autosaveVersion:1,
  });
  elements.set(context.frameId, createElement('iframe', context.frameId));
  host.openNodeSession(context, []);
  const frame = frameFor(context);
  frame.dispatch('load');
  readyFrame(frame, context, `ready-${projectId}`);
  await flushAsync();
  return {context, frame};
}

const idleSessionC = await openReadyEmptySession('project-c', 3);
await openReadyEmptySession('project-d', 4);
await openReadyEmptySession('project-e', 5);
await openReadyEmptySession('project-f', 6);
await openReadyEmptySession('project-g', 7);
assert.equal(idleSessionC.frame.isConnected, false, 'the oldest safe idle session should be reclaimed above the cap');
assert.equal(frameB.isConnected, true, 'an unsaved hidden session must never be reclaimed to satisfy the cap');
assert.equal(host.getState().sessionCount, 5, 'the active session, three safe idle sessions, and one dirty session should remain');

assert.match(cssSource, /\.openshop-session-frame\[hidden\]\s*\{\s*display:\s*none;/);
assert.doesNotMatch(hostSource, /about:blank/);
assert.match(hostSource, /HIDDEN_SESSION_IDLE_MS\s*=\s*15\s*\*\s*60\s*\*\s*1000/);
assert.match(hostSource, /MAX_IDLE_SESSIONS\s*=\s*3/);
assert.match(hostSource, /Object\.freeze\(\{[\s\S]*openNodeSession[\s\S]*disposeProject[\s\S]*requestSave[\s\S]*requestSendToCanvas[\s\S]*refreshSources[\s\S]*close[\s\S]*getState/);

console.log('OpenShop full-screen host session flow tests passed');
