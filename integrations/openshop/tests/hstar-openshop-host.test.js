import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const protocolPath = resolve(testDir, '..', 'host', 'openshop-protocol.js');
const hostPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'openshop-host.js');

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

describe('Hstar OpenShop host page visibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
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
});
