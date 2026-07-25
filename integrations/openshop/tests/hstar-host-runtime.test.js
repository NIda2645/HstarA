import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const protocolPath = resolve(testDir, '..', 'host', 'openshop-protocol.js');
const runtimePath = resolve(testDir, '..', 'host', 'openshop-host-runtime.js');
const indexPath = resolve(testDir, '..', 'index.html');

const context = {
  canvasType: 'classic',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  projectId: 'project-1'
};

function flushMessages() {
  return new Promise(resolvePromise => setTimeout(resolvePromise, 0));
}

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {promise, resolve: resolvePromise, reject: rejectPromise};
}

describe('Hstar OpenShop editor host runtime', () => {
  let protocol;
  let runtime;
  let parentWindow;
  let editor;
  let projectAdapter;
  let assetWriter;
  let previewWriter;
  let outputWriter;

  beforeEach(async () => {
    expect(existsSync(runtimePath), `${runtimePath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopProtocol;
    delete window.HstarOpenShopRuntime;
    await import(`${pathToFileURL(protocolPath).href}?runtime-protocol=${Date.now()}-${Math.random()}`);
    await import(`${pathToFileURL(runtimePath).href}?runtime=${Date.now()}-${Math.random()}`);
    protocol = window.HstarOpenShopProtocol;
    runtime = window.HstarOpenShopRuntime;
    parentWindow = { postMessage: vi.fn() };
    editor = {
      canvasW: 1920,
      canvasH: 1080,
      history: [{action: 'old'}],
      historyIdx: 0,
      createNewDocument: vi.fn(function createNewDocument(width, height) {
        this.canvasW = width;
        this.canvasH = height;
      }),
      resizeCanvas: vi.fn(),
      zoomFit: vi.fn(),
      dismissWelcome: vi.fn(),
      _setPersistenceMode: vi.fn(),
      downloadToLocal: vi.fn(),
      canvas: {
        toDataURL: vi.fn(() => 'data:image/png;base64,COMPOSITE_BYTES'),
        discardActiveObject: vi.fn(),
        renderAll: vi.fn(),
      },
    };
    projectAdapter = {
      restoreProject: vi.fn(async () => ({ project: { schemaVersion: 1 } })),
      queueSourceImageLayer: vi.fn(async () => ({ name: '来源图片' })),
      reconcileSources: vi.fn(async () => ({added: [], pendingUpdates: [], detached: []})),
      resolveSourceUpdate: vi.fn(async () => ({layerId: 'layer-1'})),
      persistEditorAssets: vi.fn(async () => []),
      recordExport: vi.fn(({editor:targetEditor, output}) => {
        targetEditor.__hstarExportRecords = [{
          assetId: output.assetId,
          name: output.name,
          width: targetEditor.canvasW,
          height: targetEditor.canvasH,
          createdAt: 2000,
        }];
        return targetEditor.__hstarExportRecords[0];
      }),
      serializeProject: vi.fn(() => ({
        schemaVersion: 1,
        projectId: context.projectId,
        owner: {
          canvasType: context.canvasType,
          canvasId: context.canvasId,
          nodeId: context.nodeId
        },
        autosaveVersion: Number(editor.__hstarAutosaveVersion || 0),
      }))
    };
    assetWriter = vi.fn(async ({role}) => ({assetId: `asset-${role}`, url: `/api/assets/${role}`, role}));
    previewWriter = vi.fn(async () => ({assetId: 'asset-preview', url: '/api/assets/preview', role: 'preview'}));
    outputWriter = vi.fn(async () => ({assetId: 'asset-output', url: '/api/assets/output', name: '图文分层输出.png'}));
    runtime.start({
      editor,
      protocol,
      projectAdapter,
      parentWindow,
      origin: 'https://hstar.test',
      assetResolver: async assetId => `/static/assets/${assetId}.png`,
      imageLoader: async source => ({ source }),
      assetWriter,
      previewWriter,
      outputWriter,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    runtime?.stop?.();
  });

  it('wires editor dirty events and same-origin asset APIs in the OpenShop page', () => {
    const html = readFileSync(indexPath, 'utf8');
    const customPropertySource = html.match(/_fabricCustomProperties:\s*Object\.freeze\(\[([\s\S]*?)\]\)/)?.[1] || '';
    const customProperties = [...customPropertySource.matchAll(/'([^']+)'/g)].map(match => match[1]);
    expect(html).toContain("new CustomEvent('openshop:project-dirty'");
    expect(customProperties).toEqual(expect.arrayContaining([
      'name', 'excludeFromExport', 'globalCompositeOperation',
      'hstarAssetId', 'hstarAssetRole', 'hstarEdgeId', 'hstarSourceNodeId', 'hstarLayerId',
      'hstarSnapAnchor', 'hstarAiGeneration', 'hstarKerningMode',
      'hstarOcrSourceAssetId', 'hstarOcrSourceLayerId', 'hstarOcrBlockId', 'hstarOcrQuad',
      'hstarOcrVisualProfile', 'hstarOcrOriginalText', 'hstarArtFontRequestGeneration',
      'hstarOcrConfidence', 'hstarOcrLanguage', 'hstarOcrFontCandidates',
    ]));
    expect(customProperties.filter(property => property === 'hstarAiGeneration')).toHaveLength(1);
    expect(html).toContain('window.HstarOpenShopAssetApi');
    expect(html).toMatch(/\/api\/openshop\/projects\/.*\/assets/);
    expect(html).toContain("assetResolver: assetId => `/api/openshop/assets/${encodeURIComponent(assetId)}`");
    expect(html).toContain('assetWriter: payload => window.HstarOpenShopAssetApi.upload(payload)');
    expect(html).toContain("previewWriter: payload => window.HstarOpenShopAssetApi.upload({...payload, role:'preview'})");
    expect(html).toContain("outputWriter: payload => window.HstarOpenShopAssetApi.upload({...payload, role:'output'})");
  });

  function envelope(type, requestId, payload = {}, overrides = {}) {
    return protocol.createEnvelope({
      type,
      sessionId: overrides.sessionId || 'session-1',
      requestId,
      context: overrides.context || context,
      payload
    });
  }

  function dispatch(data, { origin = 'https://hstar.test', source = parentWindow } = {}) {
    window.dispatchEvent(new MessageEvent('message', { data, origin, source }));
  }

  function posted(type) {
    return parentWindow.postMessage.mock.calls
      .map(call => call[0])
      .filter(message => message.type === type);
  }

  it('returns one scoped result for a native download request', async () => {
    editor.downloadToLocal.mockResolvedValue({ok:true, filename:'design.png'});
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-download'));
    await flushMessages();
    parentWindow.postMessage.mockClear();

    dispatch(envelope(protocol.TYPES.REQUEST_DOWNLOAD_LOCAL, 'download-1', {format:'png'}));
    await flushMessages();

    expect(editor.downloadToLocal).toHaveBeenCalledWith({format:'png', options:{}});
    expect(posted(protocol.TYPES.DOWNLOAD_LOCAL_RESULT)).toHaveLength(1);
    expect(posted(protocol.TYPES.DOWNLOAD_LOCAL_RESULT)[0]).toMatchObject({
      requestId:'download-1',
      sessionId:'session-1',
      context,
      payload:{status:'success', filename:'design.png'},
    });
  });

  it('reports native download cancellation without false success', async () => {
    editor.downloadToLocal.mockResolvedValue({cancelled:true});
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-download-cancel'));
    await flushMessages();

    dispatch(envelope(protocol.TYPES.REQUEST_DOWNLOAD_LOCAL, 'download-cancel', {format:'png'}));
    await flushMessages();

    expect(posted(protocol.TYPES.DOWNLOAD_LOCAL_RESULT).at(-1)).toMatchObject({
      requestId:'download-cancel',
      payload:{status:'cancelled'},
    });
  });

  it('reports bounded native download errors with the same request id', async () => {
    editor.downloadToLocal.mockRejectedValue(new Error('disk failed\nwith details'));
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-download-error'));
    await flushMessages();

    dispatch(envelope(protocol.TYPES.REQUEST_DOWNLOAD_LOCAL, 'download-error', {format:'png'}));
    await flushMessages();

    expect(posted(protocol.TYPES.DOWNLOAD_LOCAL_RESULT).at(-1)).toMatchObject({
      requestId:'download-error',
      payload:{status:'error', message:'disk failed with details'},
    });
  });

  it('dispatches scoped hidden and visible events from session visibility envelopes', async () => {
    const hidden = vi.fn();
    const visible = vi.fn();
    window.addEventListener('openshop:session-hidden', hidden);
    window.addEventListener('openshop:session-visible', visible);
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-visibility'));
    await flushMessages();

    dispatch(envelope(protocol.TYPES.SESSION_VISIBILITY, 'visibility-hidden', {visible:false}));
    await flushMessages();
    dispatch(envelope(protocol.TYPES.SESSION_VISIBILITY, 'visibility-visible', {visible:true}));
    await flushMessages();

    expect(hidden).toHaveBeenCalledOnce();
    expect(hidden.mock.calls[0][0].detail.context).toEqual(context);
    expect(visible).toHaveBeenCalledOnce();
    expect(visible.mock.calls[0][0].detail.context).toEqual(context);
    window.removeEventListener('openshop:session-hidden', hidden);
    window.removeEventListener('openshop:session-visible', visible);
  });

  async function flushAsync() {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }

  it('accepts a session only from the configured origin and parent window', async () => {
    const open = envelope(protocol.TYPES.OPEN_SESSION, 'open-1');

    dispatch(open, { origin: 'https://foreign.test' });
    dispatch(open, { source: { postMessage: vi.fn() } });
    await flushMessages();

    expect(runtime.getState().activeSession).toBeNull();
    expect(parentWindow.postMessage).not.toHaveBeenCalled();

    dispatch(open);
    await flushMessages();

    expect(runtime.getState().activeSession).toEqual({
      sessionId: 'session-1',
      context
    });
    expect(parentWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(parentWindow.postMessage.mock.calls[0][0].type).toBe(protocol.TYPES.READY);
    expect(parentWindow.postMessage.mock.calls[0][1]).toBe('https://hstar.test');
  });

  it('sets embedded persistence only after a validated session opens', async () => {
    const open = envelope(protocol.TYPES.OPEN_SESSION, 'open-persistence');

    dispatch(open, {origin:'https://foreign.test'});
    dispatch(open, {source:{postMessage:vi.fn()}});
    await flushMessages();

    expect(editor._setPersistenceMode).not.toHaveBeenCalled();

    dispatch(open);
    await flushMessages();

    expect(editor._setPersistenceMode).toHaveBeenCalledTimes(1);
    expect(editor._setPersistenceMode).toHaveBeenCalledWith('embedded-hstara');
    expect(editor.createNewDocument.mock.invocationCallOrder[0])
      .toBeLessThan(editor._setPersistenceMode.mock.invocationCallOrder[0]);
  });

  it('deduplicates image requests and rejects another project context', async () => {
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    await flushMessages();
    parentWindow.postMessage.mockClear();

    const add = envelope(protocol.TYPES.ADD_IMAGE_LAYER, 'add-1', {
      source: {
        assetId: 'asset-1',
        edgeId: 'edge-1',
        sourceNodeId: 'image-node-1',
        name: '第一张.png',
        url: '/static/assets/asset-1.png',
        sequence: 0
      }
    });
    dispatch(add);
    dispatch(add);
    dispatch(envelope(protocol.TYPES.ADD_IMAGE_LAYER, 'add-2', add.payload, {
      context: { ...context, projectId: 'project-2' }
    }));
    await flushMessages();

    expect(projectAdapter.queueSourceImageLayer).toHaveBeenCalledTimes(1);
    expect(projectAdapter.serializeProject).toHaveBeenCalledTimes(1);
    expect(parentWindow.postMessage).toHaveBeenCalledTimes(1);
    expect(parentWindow.postMessage.mock.calls[0][0].type).toBe(protocol.TYPES.PROJECT_CHANGED);
  });

  it('keeps the welcome page for empty sessions and reveals sourced sessions after synchronization', async () => {
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1', {entryMode:'welcome'}));
    dispatch(envelope(protocol.TYPES.LOAD_PROJECT, 'load-1', {
      project: { schemaVersion: 1, projectId: 'project-1' }
    }));
    dispatch(envelope(protocol.TYPES.SYNC_SOURCES, 'sync-empty', {sources:[]}));
    await flushMessages();

    expect(projectAdapter.restoreProject).toHaveBeenCalledTimes(1);
    expect(editor.dismissWelcome).not.toHaveBeenCalled();

    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-2', {entryMode:'workspace'}, {
      sessionId: 'session-2'
    }));
    dispatch(envelope(protocol.TYPES.LOAD_PROJECT, 'load-1', {
      project: { schemaVersion: 1, projectId: 'project-1' }
    }, {
      sessionId: 'session-2'
    }));
    await flushMessages();

    expect(projectAdapter.restoreProject).toHaveBeenCalledTimes(2);
    expect(editor.dismissWelcome).not.toHaveBeenCalled();

    dispatch(envelope(protocol.TYPES.SYNC_SOURCES, 'sync-sourced', {sources:[{
      assetId:'asset-1', edgeId:'edge-1', sourceNodeId:'image-node-1',
      name:'source.png', url:'/static/assets/source.png', sequence:0,
    }]}, {
      sessionId:'session-2',
    }));
    await flushMessages();

    expect(editor.dismissWelcome).toHaveBeenCalledTimes(1);
    expect(runtime.getState().activeSession.sessionId).toBe('session-2');
  });

  it('emits session and project lifecycle events for project-scoped tools', async () => {
    const opened = vi.fn();
    const loaded = vi.fn();
    const stopped = vi.fn();
    window.addEventListener('openshop:session-opened', opened);
    window.addEventListener('openshop:project-loaded', loaded);
    window.addEventListener('openshop:session-stopped', stopped);
    try {
      dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-events'));
      dispatch(envelope(protocol.TYPES.LOAD_PROJECT, 'load-events', {
        project:{schemaVersion:1, projectId:'project-1'},
      }));
      await flushMessages();

      expect(opened).toHaveBeenCalledTimes(1);
      expect(opened.mock.calls[0][0].detail.session.context).toEqual(context);
      expect(loaded).toHaveBeenCalledTimes(1);
      expect(loaded.mock.calls[0][0].detail.project.projectId).toBe('project-1');

      runtime.stop();
      expect(stopped).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('openshop:session-opened', opened);
      window.removeEventListener('openshop:project-loaded', loaded);
      window.removeEventListener('openshop:session-stopped', stopped);
    }
  });

  it('refits the workspace after the parent reveals the editor frame', async () => {
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-fit'));
    await flushMessages();

    dispatch(envelope(protocol.TYPES.FIT_WORKSPACE, 'fit-visible'));
    await flushMessages();

    expect(editor.resizeCanvas).toHaveBeenCalledTimes(1);
    expect(editor.zoomFit).toHaveBeenCalledTimes(1);
  });

  it('waits for project restoration before reconciling the source snapshot', async () => {
    const restoration = deferred();
    const callOrder = [];
    projectAdapter.restoreProject.mockImplementationOnce(async () => {
      callOrder.push('restore-start');
      await restoration.promise;
      callOrder.push('restore-end');
    });
    projectAdapter.reconcileSources.mockImplementationOnce(async () => {
      callOrder.push('reconcile');
      return {added: [], pendingUpdates: [], detached: []};
    });

    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    dispatch(envelope(protocol.TYPES.LOAD_PROJECT, 'load-ordered', {
      project: {schemaVersion: 1, projectId: 'project-1'},
    }));
    dispatch(envelope(protocol.TYPES.SYNC_SOURCES, 'sync-ordered', {
      sources: [{
        assetId: 'asset-v1', assetVersion: 'v1', edgeId: 'edge-1',
        sourceNodeId: 'image-node-1', name: 'source.png',
        url: '/static/assets/asset-v1.png', sequence: 0,
      }],
    }));
    await flushAsync();

    expect(callOrder).toEqual(['restore-start']);
    expect(projectAdapter.reconcileSources).not.toHaveBeenCalled();

    restoration.resolve();
    await flushMessages();
    await flushMessages();

    expect(callOrder).toEqual(['restore-start', 'restore-end', 'reconcile']);
  });

  it('reports a terminal error when an active request fails', async () => {
    projectAdapter.queueSourceImageLayer.mockRejectedValueOnce(new Error('decode failed'));
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    await flushMessages();
    parentWindow.postMessage.mockClear();

    dispatch(envelope(protocol.TYPES.ADD_IMAGE_LAYER, 'add-failed', {
      source: {
        assetId: 'asset-1',
        edgeId: 'edge-1',
        sourceNodeId: 'image-node-1',
        name: '损坏图片.png',
        url: '/static/assets/asset-1.png',
        sequence: 0
      }
    }));
    await flushMessages();

    expect(parentWindow.postMessage).toHaveBeenCalledTimes(1);
    const error = parentWindow.postMessage.mock.calls[0][0];
    expect(error.type).toBe(protocol.TYPES.ERROR);
    expect(error.payload).toMatchObject({
      code: 'OPENSHOP_REQUEST_FAILED',
      requestId: 'add-failed',
      message: 'decode failed'
    });
  });

  it('leaves image loading to the project adapter when no loader is injected', async () => {
    runtime.stop();
    runtime.start({
      editor,
      protocol,
      projectAdapter,
      parentWindow,
      origin: 'https://hstar.test'
    });
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    await flushMessages();

    dispatch(envelope(protocol.TYPES.ADD_IMAGE_LAYER, 'add-default-loader', {
      source: {
        assetId: 'asset-1',
        edgeId: 'edge-1',
        sourceNodeId: 'image-node-1',
        name: '默认加载.png',
        url: '/static/assets/asset-1.png',
        sequence: 0
      }
    }));
    await flushMessages();

    expect(projectAdapter.queueSourceImageLayer).toHaveBeenCalledWith(expect.objectContaining({
      imageLoader: undefined
    }));
  });

  it('debounces repeated dirty events into one autosave request', async () => {
    vi.useFakeTimers();
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    parentWindow.postMessage.mockClear();

    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'Move'}}));
    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'Move'}}));
    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'Move'}}));
    await vi.advanceTimersByTimeAsync(1199);
    expect(posted(protocol.TYPES.SAVE_PROJECT)).toHaveLength(0);

    await vi.advanceTimersByTimeAsync(1);
    await flushAsync();
    const saves = posted(protocol.TYPES.SAVE_PROJECT);
    expect(saves).toHaveLength(1);
    expect(projectAdapter.persistEditorAssets).toHaveBeenCalledTimes(1);
    expect(previewWriter).toHaveBeenCalledTimes(1);
    expect(saves[0].payload).toMatchObject({reason: 'autosave', closeAfter: false});

    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, saves[0].requestId, {
      project: {...saves[0].payload.project, autosaveVersion: 2},
    }));
    await flushAsync();
    expect(runtime.getState()).toMatchObject({saving: false, dirty: false});
  });

  it('saves again immediately when the project changes during an active save', async () => {
    vi.useFakeTimers();
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    parentWindow.postMessage.mockClear();
    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'First'}}));
    await vi.advanceTimersByTimeAsync(1200);
    await flushAsync();
    const firstSave = posted(protocol.TYPES.SAVE_PROJECT)[0];
    expect(firstSave).toBeTruthy();

    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'Second'}}));
    expect(runtime.getState()).toMatchObject({saving: true, saveAgain: true, dirty: true});
    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, firstSave.requestId, {
      project: {...firstSave.payload.project, autosaveVersion: 2},
    }));
    await flushAsync();

    const saves = posted(protocol.TYPES.SAVE_PROJECT);
    expect(saves).toHaveLength(2);
    expect(saves[1].payload.reason).toBe('autosave');
    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, saves[1].requestId, {
      project: {...saves[1].payload.project, autosaveVersion: 3},
    }));
    await flushAsync();
    expect(runtime.getState()).toMatchObject({dirtyRevision:2, savedRevision:2, dirty:false});
  });

  it('flushes the latest dirty revision immediately on pagehide', async () => {
    vi.useFakeTimers();
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    parentWindow.postMessage.mockClear();
    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'Last edit'}}));

    window.dispatchEvent(new Event('pagehide'));
    await flushAsync();

    const saves = posted(protocol.TYPES.SAVE_PROJECT);
    expect(saves).toHaveLength(1);
    expect(saves[0].payload).toMatchObject({reason:'pagehide', closeAfter:false});
    expect(runtime.getState()).toMatchObject({dirtyRevision:1, savedRevision:0, saving:true});
    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, saves[0].requestId, {
      project:{...saves[0].payload.project, autosaveVersion:2},
    }));
    await flushAsync();
    expect(runtime.getState()).toMatchObject({dirtyRevision:1, savedRevision:1, dirty:false});
  });

  it('ignores save confirmations from an obsolete session', async () => {
    vi.useFakeTimers();
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    parentWindow.postMessage.mockClear();
    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'Session one'}}));
    await vi.advanceTimersByTimeAsync(1200);
    await flushAsync();
    const oldSave = posted(protocol.TYPES.SAVE_PROJECT)[0];

    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-2', {document:{width:800, height:600}}, {
      sessionId: 'session-2',
    }));
    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, oldSave.requestId, {
      project: {...oldSave.payload.project, autosaveVersion: 99},
    }));
    await flushAsync();

    expect(runtime.getState().activeSession.sessionId).toBe('session-2');
    expect(runtime.getState().autosaveVersion).toBe(0);
    expect(editor.createNewDocument).toHaveBeenLastCalledWith(800, 600);
    expect(editor.history).toEqual([]);
  });

  it('saves before sending a composited image to the canvas', async () => {
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    await flushMessages();
    parentWindow.postMessage.mockClear();

    dispatch(envelope(protocol.TYPES.REQUEST_SEND_TO_CANVAS, 'send-1'));
    await flushMessages();
    const save = posted(protocol.TYPES.SAVE_PROJECT)[0];
    expect(save).toBeTruthy();
    expect(outputWriter).not.toHaveBeenCalled();

    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, save.requestId, {
      project: {...save.payload.project, autosaveVersion: 2},
    }));
    await flushMessages();
    await flushMessages();

    expect(outputWriter).toHaveBeenCalledWith(expect.objectContaining({
      dataUrl: 'data:image/png;base64,COMPOSITE_BYTES',
      role: 'output',
    }));
    expect(projectAdapter.recordExport).toHaveBeenCalledWith(expect.objectContaining({
      editor,
      output: expect.objectContaining({assetId: 'asset-output'}),
    }));
    const exportSave = posted(protocol.TYPES.SAVE_PROJECT)[1];
    expect(exportSave).toBeTruthy();
    expect(posted(protocol.TYPES.SEND_TO_CANVAS)).toHaveLength(0);

    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, exportSave.requestId, {
      project: {...exportSave.payload.project, autosaveVersion: 3},
    }));
    await flushMessages();

    const sent = posted(protocol.TYPES.SEND_TO_CANVAS);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload).toEqual({
      assetId: 'asset-output',
      url: '/api/assets/output',
      name: '图文分层输出.png',
      width: 1920,
      height: 1080,
    });
    expect(JSON.stringify(sent[0])).not.toContain('data:image/png;base64');
  });

  it('waits for a save that is still externalizing assets before sending output', async () => {
    const persistence = deferred();
    projectAdapter.persistEditorAssets.mockImplementationOnce(() => persistence.promise);
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    await flushMessages();
    parentWindow.postMessage.mockClear();

    const activeSave = runtime.requestSave({reason:'autosave'});
    await flushAsync();
    const send = runtime.requestSendToCanvas({requestId:'send-during-prepare'});
    await flushAsync();
    expect(outputWriter).not.toHaveBeenCalled();

    persistence.resolve([]);
    await flushAsync();
    const save = posted(protocol.TYPES.SAVE_PROJECT)[0];
    expect(save).toBeTruthy();
    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, save.requestId, {
      project: {...save.payload.project, autosaveVersion: 2},
    }));
    await activeSave;
    await flushAsync();
    const exportSave = posted(protocol.TYPES.SAVE_PROJECT)[1];
    expect(exportSave).toBeTruthy();
    dispatch(envelope(protocol.TYPES.SAVE_CONFIRMED, exportSave.requestId, {
      project: {...exportSave.payload.project, autosaveVersion: 3},
    }));
    await send;

    expect(outputWriter).toHaveBeenCalledTimes(1);
    expect(posted(protocol.TYPES.SEND_TO_CANVAS)).toHaveLength(1);
  });

  it('does not continue an old send request after switching node sessions', async () => {
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    await flushMessages();
    parentWindow.postMessage.mockClear();
    dispatch(envelope(protocol.TYPES.REQUEST_SEND_TO_CANVAS, 'send-old-session'));
    await flushMessages();
    expect(posted(protocol.TYPES.SAVE_PROJECT)).toHaveLength(1);

    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-2', {}, {sessionId:'session-2'}));
    await flushMessages();
    await flushMessages();

    expect(runtime.getState().activeSession.sessionId).toBe('session-2');
    expect(outputWriter).not.toHaveBeenCalled();
    expect(posted(protocol.TYPES.SEND_TO_CANVAS)).toHaveLength(0);
  });

  it('unlocks the save queue when the host rejects the active save', async () => {
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    await flushMessages();
    parentWindow.postMessage.mockClear();
    const savePromise = runtime.requestSave({reason:'manual'});
    await flushMessages();
    const save = posted(protocol.TYPES.SAVE_PROJECT)[0];
    expect(runtime.getState().saving).toBe(true);

    dispatch(envelope(protocol.TYPES.ERROR, save.requestId, {
      code:'SAVE_CONFLICT',
      requestId:save.requestId,
      message:'项目版本冲突',
    }));
    await expect(savePromise).rejects.toThrow('项目版本冲突');

    expect(runtime.getState()).toMatchObject({saving:false, dirty:true});
  });
});
