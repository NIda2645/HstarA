import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const protocolPath = resolve(testDir, '..', 'host', 'openshop-protocol.js');
const hostPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'openshop-host.js');
const shellPath = resolve(testDir, '..', '..', '..', 'static', 'index.html');
const hostCssPath = resolve(testDir, '..', '..', '..', 'static', 'css', 'openshop-host.css');

async function mountHost() {
  delete window.HstarOpenShopHost;
  delete window.HstarOpenShopProtocol;
  document.body.innerHTML = '<main class="stage"><iframe id="frame-canvas" class="active"></iframe><iframe id="frame-settings"></iframe></main>';
  globalThis.MutationObserver = class UnsupportedMutationObserver {
    observe() {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.");
    }
    disconnect() {}
  };
  window.switchUI = (_trigger, id) => {
    document.querySelectorAll('iframe').forEach(frame => frame.classList.remove('active'));
    document.getElementById(`frame-${id}`)?.classList.add('active');
  };
  window.lucide = {createIcons:vi.fn()};
  await import(`${pathToFileURL(protocolPath).href}?test=${Date.now()}-${Math.random()}`);
  window.eval(readFileSync(hostPath, 'utf8'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return window.HstarOpenShopHost;
}

async function flushMutations() {
  await Promise.resolve();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {promise, resolve:resolvePromise, reject:rejectPromise};
}

function dispatchEditorReady(host, frame) {
  const activeSession = host.getState().activeSession;
  const ready = window.HstarOpenShopProtocol.createEnvelope({
    type:window.HstarOpenShopProtocol.TYPES.READY,
    sessionId:activeSession.sessionId,
    requestId:'ready-clone',
    context:activeSession.context,
  });
  const event = new Event('message');
  Object.defineProperties(event, {
    origin:{value:window.location.origin},
    source:{value:frame.contentWindow},
    data:{value:ready},
  });
  window.dispatchEvent(event);
}

function dispatchProjectChanged(host, frame, requestId, reason = 'sources-synchronized') {
  const activeSession = host.getState().activeSession;
  const changed = window.HstarOpenShopProtocol.createEnvelope({
    type:window.HstarOpenShopProtocol.TYPES.PROJECT_CHANGED,
    sessionId:activeSession.sessionId,
    requestId,
    context:activeSession.context,
    payload:{reason, project:{
      projectId:activeSession.context.projectId,
      owner:{
        canvasType:activeSession.context.canvasType,
        canvasId:activeSession.context.canvasId,
        nodeId:activeSession.context.nodeId,
      },
      aiTaskRecords:[], sourceBindings:[],
    }},
  });
  const event = new Event('message');
  Object.defineProperties(event, {
    origin:{value:window.location.origin},
    source:{value:frame.contentWindow},
    data:{value:changed},
  });
  window.dispatchEvent(event);
}

function dispatchEditorEnvelope(host, frame, type, requestId, payload = {}) {
  const activeSession = host.getState().activeSession;
  const event = new MessageEvent('message', {
    origin:window.location.origin,
    source:frame.contentWindow,
    data:window.HstarOpenShopProtocol.createEnvelope({
      type,
      requestId,
      payload,
      sessionId:activeSession.sessionId,
      context:activeSession.context,
    }),
  });
  window.dispatchEvent(event);
}

function dispatchCanvasMessage(data, frame = document.getElementById('frame-canvas')) {
  window.dispatchEvent(new MessageEvent('message', {
    data,
    origin:window.location.origin,
    source:frame.contentWindow,
  }));
}

describe('Hstar OpenShop host page visibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('keeps a live OpenShop session visually hidden outside the canvas page', async () => {
    const style = document.createElement('style');
    style.textContent = readFileSync(hostCssPath, 'utf8');
    document.head.appendChild(style);
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-hidden', nodeId:'node-hidden',
      projectId:'project-hidden', frameId:'frame-canvas', projectName:'Hidden session',
    });

    const overlay = document.getElementById('openshop-host');
    expect(getComputedStyle(overlay).display).toBe('grid');
    window.switchUI(null, 'api-settings');

    expect(overlay.hidden).toBe(true);
    expect(overlay.classList.contains('is-open')).toBe(true);
    expect(getComputedStyle(overlay).display).toBe('none');
  });

  it('uses one current runtime revision for the host script and editor iframe', async () => {
    const hostSource = readFileSync(hostPath, 'utf8');
    const shellSource = readFileSync(shellPath, 'utf8');
    const revision = hostSource.match(/OPENSHOP_RUNTIME_REVISION\s*=\s*'([^']+)'/)?.[1];
    expect(revision).toMatch(/^\d{4}\.\d{2}\.\d{2}\.[0-9.]+$/);
    expect(shellSource).toContain(`/static/js/openshop-host.js?v=${revision}`);

    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
      projectName:'Layered text', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
    });

    expect(document.querySelector('iframe.openshop-session-frame').getAttribute('src'))
      .toBe(`/static/openshop/index.html?v=${revision}`);
  });

  it('hides the editor without interrupting its session or background-task iframe', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic',
      canvasId:'canvas-1',
      nodeId:'node-1',
      projectId:'project-1',
      projectName:'图文分层',
      frameId:'frame-canvas',
      documentWidth:1920,
      documentHeight:1080,
    });

    const overlay = document.getElementById('openshop-host');
    const editorFrame = overlay.querySelector('iframe.openshop-session-frame');
    const editorWindow = editorFrame.contentWindow;
    const sessionBefore = host.getState().activeSession;
    expect(overlay.classList.contains('is-open')).toBe(true);
    expect(overlay.hidden).toBe(false);

    window.switchUI(null, 'settings');
    await flushMutations();

    expect(overlay.hidden).toBe(true);
    expect(overlay.classList.contains('is-open')).toBe(true);
    expect(host.getState().activeSession).toEqual(sessionBefore);
    expect(host.getState().sessionCount).toBe(1);
    expect(editorFrame.isConnected).toBe(true);
    expect(editorFrame.contentWindow).toBe(editorWindow);
    expect(overlay.querySelector('iframe.openshop-session-frame')).toBe(editorFrame);

    window.switchUI(null, 'canvas');
    await flushMutations();

    expect(overlay.hidden).toBe(false);
    expect(overlay.classList.contains('is-open')).toBe(true);
    expect(host.getState().activeSession).toEqual(sessionBefore);
    expect(editorFrame.isConnected).toBe(true);
    expect(editorFrame.contentWindow).toBe(editorWindow);
    expect(overlay.querySelector('iframe.openshop-session-frame')).toBe(editorFrame);
  });

  it('does not reopen an editor that the user explicitly closed', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
      projectName:'图文分层', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
    });
    const overlay = document.getElementById('openshop-host');
    host.close();

    window.switchUI(null, 'settings');
    await flushMutations();
    window.switchUI(null, 'canvas');
    await flushMutations();

    expect(overlay.classList.contains('is-open')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  });

  it('notifies the live editor to pause polling when the overlay is hidden', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
      projectName:'Layered text', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
    });
    const frame = document.querySelector('iframe.openshop-session-frame');
    frame.dispatchEvent(new Event('load'));
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');

    host.close();

    expect(postMessage.mock.calls.some(([message]) => (
      message.type === window.HstarOpenShopProtocol.TYPES.SESSION_VISIBILITY
      && message.payload?.visible === false
    ))).toBe(true);
  });

  it('hides OpenShop immediately and leaves persistence to autosave', async () => {
    const project = {
      projectId:'project-close-save',
      owner:{canvasType:'classic', canvasId:'canvas-close-save', nodeId:'node-close-save'},
      document:{width:1920, height:1080},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve({
      ok:true, status:200, json:vi.fn().mockResolvedValue({project}),
    })));
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-close-save', nodeId:'node-close-save',
      projectId:'project-close-save', frameId:'frame-canvas',
    });
    const overlay = document.getElementById('openshop-host');
    const frame = document.querySelector('iframe.openshop-session-frame');
    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');

    host.close();

    expect(overlay.hidden).toBe(true);
    expect(postMessage.mock.calls.some(([message]) => (
      message.type === window.HstarOpenShopProtocol.TYPES.REQUEST_SAVE
    ))).toBe(false);
    expect(frame.isConnected).toBe(true);
  });

  it('resumes the existing same-node editor after an explicit hide', async () => {
    const host = await mountHost();
    const context = {
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
      projectName:'Layered text', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
    };
    const sources = [{
      edgeId:'edge-1', sourceNodeId:'source-1', assetId:'a'.repeat(64),
      assetVersion:'source-v1', name:'source.png', url:'/api/openshop/assets/source', sequence:0,
    }];
    host.openNodeSession(context, sources);
    const frame = document.querySelector('iframe.openshop-session-frame');
    frame.dispatchEvent(new Event('load'));
    const editorWindow = frame.contentWindow;
    const sessionBefore = host.getState().activeSession;
    const postMessage = vi.spyOn(editorWindow, 'postMessage');
    dispatchProjectChanged(host, frame, 'project-ready');
    await flushMutations();
    expect(frame.hidden).toBe(false);
    expect(postMessage.mock.calls.some(([message]) => (
      message.type === window.HstarOpenShopProtocol.TYPES.SESSION_VISIBILITY
      && message.payload?.visible === true
    ))).toBe(true);

    postMessage.mockClear();
    host.close();
    expect(postMessage.mock.calls.some(([message]) => (
      message.type === window.HstarOpenShopProtocol.TYPES.SESSION_VISIBILITY
      && message.payload?.visible === false
    ))).toBe(true);

    postMessage.mockClear();
    host.openNodeSession(context, sources);

    expect(host.getState().activeSession).toEqual(sessionBefore);
    expect(document.querySelector('iframe.openshop-session-frame')).toBe(frame);
    expect(frame.contentWindow).toBe(editorWindow);
    expect(postMessage.mock.calls.some(([message]) => (
      message.type === window.HstarOpenShopProtocol.TYPES.SESSION_VISIBILITY
      && message.payload?.visible === true
    ))).toBe(true);
    expect(postMessage.mock.calls.some(([message]) => (
      message.type === window.HstarOpenShopProtocol.TYPES.CLOSE
    ))).toBe(false);

    postMessage.mockClear();
    host.openNodeSession(context, sources);
    expect(postMessage.mock.calls.some(([message]) => (
      message.type === window.HstarOpenShopProtocol.TYPES.SESSION_VISIBILITY
      && message.payload?.visible === true
    ))).toBe(true);
    expect(document.querySelectorAll('iframe.openshop-session-frame')).toHaveLength(1);
  });

  it('counts queued artistic-font records as active background work', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
      projectName:'Layered text', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
    });
    const session = host.getState().activeSession;
    const frame = document.querySelector('iframe.openshop-session-frame');
    const envelope = window.HstarOpenShopProtocol.createEnvelope({
      type:window.HstarOpenShopProtocol.TYPES.PROJECT_CHANGED,
      sessionId:session.sessionId,
      requestId:'project-art-running',
      context:session.context,
      payload:{project:{
        projectId:'project-1', owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1'},
        aiTaskRecords:[{
          taskId:'task-art-1', toolId:'art-font-restore', kind:'single',
          status:'queued', reconcileState:'pending',
        }],
      }},
    });
    const event = new Event('message');
    Object.defineProperties(event, {
      origin:{value:window.location.origin}, source:{value:frame.contentWindow}, data:{value:envelope},
    });

    window.dispatchEvent(event);
    await flushMutations();

    expect(host.getState().sessions[0].activeTaskCount).toBe(1);
  });

  it('publishes one canvas log when an artistic-font task is applied', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-art-log', nodeId:'node-art-log', projectId:'project-art-log',
      projectName:'Layered text', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
    });
    const session = host.getState().activeSession;
    const editorFrame = document.querySelector('iframe.openshop-session-frame');
    const canvasFrame = document.getElementById('frame-canvas');
    const postMessage = vi.spyOn(canvasFrame.contentWindow, 'postMessage');
    const project = {
      projectId:'project-art-log',
      owner:{canvasType:'classic', canvasId:'canvas-art-log', nodeId:'node-art-log'},
      sourceBindings:[],
      aiTaskRecords:[{
        taskId:'task-art-applied', toolId:'art-font-restore', status:'succeeded',
        reconcileState:'applied', apiConfigId:'image-provider', modelId:'image-model',
        outputAssetId:'a'.repeat(64), generatedLayerId:'art-layer-1',
        createdAt:1000, completedAt:2100, appliedAt:2500,
        snapshot:{textLayerId:'text-layer-1', currentText:'Edited artistic title'},
        result:{
          assetId:'a'.repeat(64), url:'/api/openshop/assets/art-output', name:'art-output.png',
          mime:'image/png', width:640, height:180, contentBox:{x:0, y:0, width:640, height:180},
        },
      }],
    };
    const envelope = window.HstarOpenShopProtocol.createEnvelope({
      type:window.HstarOpenShopProtocol.TYPES.PROJECT_CHANGED,
      sessionId:session.sessionId,
      requestId:'project-art-applied',
      context:session.context,
      payload:{reason:'art-font-applied', project},
    });
    const event = new Event('message');
    Object.defineProperties(event, {
      origin:{value:window.location.origin}, source:{value:editorFrame.contentWindow}, data:{value:envelope},
    });

    window.dispatchEvent(event);
    window.dispatchEvent(event);
    await flushMutations();

    const messages = postMessage.mock.calls.map(([message]) => message)
      .filter(message => message.type === 'hstar-openshop-ai-task-log');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      context:{canvasType:'classic', canvasId:'canvas-art-log', nodeId:'node-art-log', projectId:'project-art-log'},
      log:{
        taskId:'task-art-applied', toolId:'art-font-restore', status:'success',
        apiConfigId:'image-provider', modelId:'image-model', prompt:'Edited artistic title',
        output:{assetId:'a'.repeat(64), url:'/api/openshop/assets/art-output', width:640, height:180},
        generatedLayerId:'art-layer-1', textLayerId:'text-layer-1', runMs:1500,
      },
    });
  });

  it('publishes a failed local-redraw log with the child error', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-redraw-log', nodeId:'node-redraw-log', projectId:'project-redraw-log',
      projectName:'Layered redraw', frameId:'frame-canvas', documentWidth:2448, documentHeight:3264,
    });
    const session = host.getState().activeSession;
    const editorFrame = document.querySelector('iframe.openshop-session-frame');
    const canvasFrame = document.getElementById('frame-canvas');
    const postMessage = vi.spyOn(canvasFrame.contentWindow, 'postMessage');
    const project = {
      projectId:'project-redraw-log',
      owner:{canvasType:'classic', canvasId:'canvas-redraw-log', nodeId:'node-redraw-log'},
      sourceBindings:[],
      aiTaskRecords:[{
        taskId:'task-redraw-failed', kind:'parent', toolId:'local-redraw', status:'failed',
        apiConfigId:'image-provider', modelId:'gpt-image-2', targetCount:1,
        completedCount:0, failedCount:1, createdAt:1000, completedAt:2500, error:'',
        snapshot:{prompt:'将选区变为一个锤子', references:[]},
        children:[{childTaskId:'child-redraw', status:'failed', error:'crop ratio mismatch'}],
      }],
    };
    const envelope = window.HstarOpenShopProtocol.createEnvelope({
      type:window.HstarOpenShopProtocol.TYPES.PROJECT_CHANGED,
      sessionId:session.sessionId,
      requestId:'project-redraw-failed',
      context:session.context,
      payload:{reason:'ai-generation', project},
    });
    const event = new Event('message');
    Object.defineProperties(event, {
      origin:{value:window.location.origin}, source:{value:editorFrame.contentWindow}, data:{value:envelope},
    });

    window.dispatchEvent(event);
    window.dispatchEvent(event);
    await flushMutations();

    const messages = postMessage.mock.calls.map(([message]) => message)
      .filter(message => message.type === 'hstar-openshop-ai-task-log');
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      log:{
        taskId:'task-redraw-failed', toolId:'local-redraw', status:'failed',
        modelId:'gpt-image-2', prompt:'将选区变为一个锤子', error:'crop ratio mismatch', runMs:1500,
      },
    });
  });
});

describe('Hstar OpenShop host project disposal', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('releases only the exact local session without deleting the remote project', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ok:true, status:200});
    vi.stubGlobal('fetch', fetchMock);
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-other', projectId:'project-other',
      projectName:'Other project', frameId:'frame-canvas',
    });
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-target', projectId:'project-target',
      projectName:'Target project', frameId:'frame-canvas',
    });
    const overlay = document.getElementById('openshop-host');
    const targetFrame = overlay.querySelector('[data-project-id="project-target"]');
    const otherFrame = overlay.querySelector('[data-project-id="project-other"]');

    const disposed = await host.disposeProject(' project-target ', {
      canvasType:' classic ', canvasId:' canvas-1 ', nodeId:' node-target ',
      projectId:' ignored-project-id ',
    });

    expect(disposed).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(targetFrame.isConnected).toBe(false);
    expect(otherFrame.isConnected).toBe(true);
    expect(host.getState().sessionCount).toBe(1);
    expect(host.getState().sessions).toEqual([
      expect.objectContaining({projectId:'project-other'}),
    ]);
    expect(host.getState().activeSession).toBeNull();
    expect(overlay.classList.contains('is-open')).toBe(false);
  });

  it('returns false without a remote mutation when no exact session exists', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const host = await mountHost();

    const disposed = await host.disposeProject('project-missing', {
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-missing',
    });

    expect(disposed).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.getState().sessionCount).toBe(0);
  });
});

describe('Hstar OpenShop host clone ownership', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('posts the exact source and target owners while keeping source ownership out of envelopes', async () => {
    const project = {
      projectId:'project-copy',
      owner:{canvasType:'classic', canvasId:'canvas-target', nodeId:'node-copy'},
      document:{width:1920, height:1080},
      layers:[],
      sourceBindings:[],
      aiTaskRecords:[],
      autosaveVersion:1,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok:true,
      status:200,
      json:vi.fn().mockResolvedValue({project}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = await mountHost();

    host.openNodeSession({
      canvasType:'classic',
      canvasId:'canvas-target',
      nodeId:'node-copy',
      projectId:'project-copy',
      cloneSourceProjectId:'project-source',
      cloneSourceCanvasType:'classic',
      cloneSourceCanvasId:'canvas-source',
      cloneSourceNodeId:'node-source',
      frameId:'frame-canvas',
      documentWidth:1920,
      documentHeight:1080,
    });

    expect(host.getState().activeSession.context.cloneSourceNodeId).toBe('node-source');
    expect(host.getState().activeSession.context.cloneSourceCanvasId).toBe('canvas-source');
    const frame = document.querySelector('iframe.openshop-session-frame');
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');
    dispatchEditorReady(host, frame);

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/openshop/projects/project-copy/clone');
    expect(options.method).toBe('POST');
    expect(JSON.parse(options.body)).toEqual({
      source_project_id:'project-source',
      source_owner:{canvasType:'classic', canvasId:'canvas-source', nodeId:'node-source'},
      owner:{canvasType:'classic', canvasId:'canvas-target', nodeId:'node-copy'},
    });

    await vi.waitFor(() => {
      const loadProject = postMessage.mock.calls
        .map(([message]) => message)
        .find(message => message.type === window.HstarOpenShopProtocol.TYPES.LOAD_PROJECT);
      expect(loadProject.context).toEqual({
        canvasType:'classic', canvasId:'canvas-target', nodeId:'node-copy', projectId:'project-copy',
      });
    });
  });

  it('rejects any incomplete clone source owner before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const host = await mountHost();
    const cloneSource = {
      cloneSourceProjectId:'project-source',
      cloneSourceCanvasType:'classic',
      cloneSourceCanvasId:'canvas-source',
      cloneSourceNodeId:'node-source',
    };

    for(const missingField of Object.keys(cloneSource)) {
      const incompleteSource = {...cloneSource};
      delete incompleteSource[missingField];
      expect(() => host.openNodeSession({
        canvasType:'classic',
        canvasId:'canvas-target',
        nodeId:'node-copy',
        projectId:'project-copy',
        ...incompleteSource,
        frameId:'frame-canvas',
      }), missingField).toThrow('OpenShop clone source context is incomplete');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(host.getState().sessionCount).toBe(0);
  });

  it('consumes successful clone intent before a later bootstrap', async () => {
    const project = {
      projectId:'project-copy',
      owner:{canvasType:'classic', canvasId:'canvas-target', nodeId:'node-copy'},
      document:{width:1920, height:1080},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    const fetchMock = vi.fn().mockResolvedValue({
      ok:true,
      status:200,
      json:vi.fn().mockResolvedValue({project}),
    });
    vi.stubGlobal('fetch', fetchMock);
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-target', nodeId:'node-copy', projectId:'project-copy',
      cloneSourceProjectId:'project-source', cloneSourceCanvasType:'classic',
      cloneSourceCanvasId:'canvas-source', cloneSourceNodeId:'node-source', frameId:'frame-canvas',
    });
    const frame = document.querySelector('iframe.openshop-session-frame');

    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(host.getState().activeSession.context).toMatchObject({
      cloneSourceProjectId:'', cloneSourceCanvasType:'', cloneSourceCanvasId:'', cloneSourceNodeId:'',
    });

    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(fetchMock.mock.calls[0][0]).toBe('/api/openshop/projects/project-copy/clone');
    expect(fetchMock.mock.calls[1][0]).toBe(
      '/api/openshop/projects/project-copy?canvas_type=classic&canvas_id=canvas-target&node_id=node-copy',
    );
    expect(fetchMock.mock.calls[1][1]).toBeUndefined();
  });

  it('retains failed clone intent so a later bootstrap can retry', async () => {
    const project = {
      projectId:'project-copy',
      owner:{canvasType:'classic', canvasId:'canvas-target', nodeId:'node-copy'},
      document:{width:1920, height:1080},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok:false,
        status:503,
        json:vi.fn().mockResolvedValue({detail:'clone unavailable'}),
      })
      .mockResolvedValueOnce({
        ok:true,
        status:200,
        json:vi.fn().mockResolvedValue({project}),
      });
    vi.stubGlobal('fetch', fetchMock);
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-target', nodeId:'node-copy', projectId:'project-copy',
      cloneSourceProjectId:'project-source', cloneSourceCanvasType:'classic',
      cloneSourceCanvasId:'canvas-source', cloneSourceNodeId:'node-source', frameId:'frame-canvas',
    });
    const frame = document.querySelector('iframe.openshop-session-frame');

    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(host.getState().status).toBe('error'));
    expect(host.getState().activeSession.context).toMatchObject({
      cloneSourceProjectId:'project-source', cloneSourceCanvasType:'classic',
      cloneSourceCanvasId:'canvas-source', cloneSourceNodeId:'node-source',
    });

    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url, options]) => [url, options.method])).toEqual([
      ['/api/openshop/projects/project-copy/clone', 'POST'],
      ['/api/openshop/projects/project-copy/clone', 'POST'],
    ]);
  });

  it('orders the download command before send and correlates its success result', async () => {
    const project = {
      projectId:'project-download',
      owner:{canvasType:'classic', canvasId:'canvas-download', nodeId:'node-download'},
      document:{width:1920, height:1080},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:true,
      status:200,
      json:vi.fn().mockResolvedValue({project}),
    }));
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-download', nodeId:'node-download',
      projectId:'project-download', frameId:'frame-canvas', projectName:'下载测试',
    });
    const commands = [...document.querySelectorAll('.openshop-host-command')]
      .map(button => button.textContent.trim());
    expect(commands.slice(-3)).toEqual(['保存', '下载到本地', '发送到画布']);

    const frame = document.querySelector('iframe.openshop-session-frame');
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');
    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));
    postMessage.mockClear();

    const download = document.querySelector('[data-openshop-download]');
    download.click();
    expect(download.disabled).toBe(true);
    const request = postMessage.mock.calls
      .map(([message]) => message)
      .find(message => message.type === window.HstarOpenShopProtocol.TYPES.REQUEST_DOWNLOAD_LOCAL);
    expect(request).toMatchObject({payload:{format:'png'}});

    dispatchEditorEnvelope(
      host, frame, window.HstarOpenShopProtocol.TYPES.DOWNLOAD_LOCAL_RESULT,
      'wrong-request', {status:'success', filename:'wrong.png'},
    );
    expect(download.disabled).toBe(true);
    expect(document.querySelector('[data-openshop-notice]').textContent).not.toContain('wrong.png');

    dispatchEditorEnvelope(
      host, frame, window.HstarOpenShopProtocol.TYPES.DOWNLOAD_LOCAL_RESULT,
      request.requestId, {status:'success', filename:'design.png'},
    );
    expect(download.disabled).toBe(false);
    expect(document.querySelector('[data-openshop-notice]').textContent).toBe('已保存：design.png');
  });

  it('keeps cancellation silent and shows a bounded native download error', async () => {
    const project = {
      projectId:'project-download-result',
      owner:{canvasType:'classic', canvasId:'canvas-result', nodeId:'node-result'},
      document:{width:800, height:600},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:true,
      status:200,
      json:vi.fn().mockResolvedValue({project}),
    }));
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-result', nodeId:'node-result',
      projectId:'project-download-result', frameId:'frame-canvas',
    });
    const frame = document.querySelector('iframe.openshop-session-frame');
    const postMessage = vi.spyOn(frame.contentWindow, 'postMessage');
    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));
    postMessage.mockClear();

    const button = document.querySelector('[data-openshop-download]');
    button.click();
    let request = postMessage.mock.calls.map(([message]) => message)
      .find(message => message.type === window.HstarOpenShopProtocol.TYPES.REQUEST_DOWNLOAD_LOCAL);
    dispatchEditorEnvelope(
      host, frame, window.HstarOpenShopProtocol.TYPES.DOWNLOAD_LOCAL_RESULT,
      request.requestId, {status:'cancelled'},
    );
    expect(button.disabled).toBe(false);
    expect(document.querySelector('[data-openshop-notice]').hidden).toBe(true);

    postMessage.mockClear();
    button.click();
    request = postMessage.mock.calls.map(([message]) => message)
      .find(message => message.type === window.HstarOpenShopProtocol.TYPES.REQUEST_DOWNLOAD_LOCAL);
    dispatchEditorEnvelope(
      host, frame, window.HstarOpenShopProtocol.TYPES.DOWNLOAD_LOCAL_RESULT,
      request.requestId, {status:'error', message:'disk\nfailed'},
    );
    const notice = document.querySelector('[data-openshop-notice]');
    expect(notice.textContent).toBe('disk failed');
    expect(notice.dataset.kind).toBe('error');
  });

  it('shows send success only for a trusted pending canvas acknowledgement', async () => {
    const project = {
      projectId:'project-send-ack',
      owner:{canvasType:'classic', canvasId:'canvas-ack', nodeId:'node-ack'},
      document:{width:640, height:480},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:true,
      status:200,
      json:vi.fn().mockResolvedValue({project}),
    }));
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-ack', nodeId:'node-ack',
      projectId:'project-send-ack', frameId:'frame-canvas',
    });
    const editorFrame = document.querySelector('iframe.openshop-session-frame');
    dispatchEditorReady(host, editorFrame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));

    dispatchEditorEnvelope(
      host, editorFrame, window.HstarOpenShopProtocol.TYPES.SEND_TO_CANVAS,
      'send-ack-1',
      {assetId:'a'.repeat(64), url:'/api/openshop/assets/output-1', name:'output.png', width:640, height:480},
    );
    const acknowledgement = {
      type:'hstar-openshop-output-applied',
      requestId:'send-ack-1',
      context:{canvasType:'classic', canvasId:'canvas-ack', nodeId:'node-ack', projectId:'project-send-ack'},
      status:'success',
      nodeId:'image-1',
    };

    dispatchCanvasMessage({...acknowledgement, requestId:'unknown'});
    dispatchCanvasMessage({...acknowledgement, context:{...acknowledgement.context, canvasId:'other'}});
    expect(document.querySelector('[data-openshop-notice]').hidden).toBe(true);

    dispatchCanvasMessage(acknowledgement);
    const notice = document.querySelector('[data-openshop-notice]');
    expect(notice.textContent).toBe('已发送到画布');
    expect(notice.dataset.kind).toBe('success');

    notice.hidden = true;
    notice.textContent = '';
    dispatchCanvasMessage(acknowledgement);
    expect(notice.hidden).toBe(true);
  });

  it('shows send failure without a false success notice', async () => {
    const project = {
      projectId:'project-send-error',
      owner:{canvasType:'classic', canvasId:'canvas-error', nodeId:'node-error'},
      document:{width:640, height:480},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:true,
      status:200,
      json:vi.fn().mockResolvedValue({project}),
    }));
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-error', nodeId:'node-error',
      projectId:'project-send-error', frameId:'frame-canvas',
    });
    const editorFrame = document.querySelector('iframe.openshop-session-frame');
    dispatchEditorReady(host, editorFrame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));
    dispatchEditorEnvelope(
      host, editorFrame, window.HstarOpenShopProtocol.TYPES.SEND_TO_CANVAS,
      'send-ack-error',
      {assetId:'b'.repeat(64), url:'/api/openshop/assets/output-2', name:'output-2.png', width:640, height:480},
    );

    dispatchCanvasMessage({
      type:'hstar-openshop-output-applied',
      requestId:'send-ack-error',
      context:{canvasType:'classic', canvasId:'canvas-error', nodeId:'node-error', projectId:'project-send-error'},
      status:'error',
      message:'画布\n保存失败',
    });

    const notice = document.querySelector('[data-openshop-notice]');
    expect(notice.textContent).toBe('画布 保存失败');
    expect(notice.textContent).not.toBe('已发送到画布');
    expect(notice.dataset.kind).toBe('error');
  });

  it('does not promote an OCR tool failure into the global project status', async () => {
    const project = {
      projectId:'project-ocr-error',
      owner:{canvasType:'classic', canvasId:'canvas-ocr-error', nodeId:'node-ocr-error'},
      document:{width:1920, height:1080},
      layers:[], sourceBindings:[], aiTaskRecords:[], autosaveVersion:1,
    };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok:true, status:200, json:vi.fn().mockResolvedValue({project}),
    }));
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-ocr-error', nodeId:'node-ocr-error',
      projectId:'project-ocr-error', frameId:'frame-canvas',
    });
    const frame = document.querySelector('iframe.openshop-session-frame');
    dispatchEditorReady(host, frame);
    await vi.waitFor(() => expect(host.getState().status).toBe('saved'));

    dispatchEditorEnvelope(
      host,
      frame,
      window.HstarOpenShopProtocol.TYPES.ERROR,
      'ocr-tool-error',
      {code:'OPENSHOP_REQUEST_FAILED', message:'OCR model did not return reliable text positions'},
    );
    await flushMutations();

    expect(host.getState().status).toBe('saved');
    expect(document.querySelector('[data-openshop-state]').textContent).toBe('已保存');
    expect(document.getElementById('openshop-host').textContent)
      .not.toContain('OCR model did not return reliable text positions');
  });
});
