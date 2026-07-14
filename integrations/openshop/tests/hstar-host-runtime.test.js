import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const protocolPath = resolve(testDir, '..', 'host', 'openshop-protocol.js');
const runtimePath = resolve(testDir, '..', 'host', 'openshop-host-runtime.js');

const context = {
  canvasType: 'classic',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  projectId: 'project-1'
};

function flushMessages() {
  return new Promise(resolvePromise => setTimeout(resolvePromise, 0));
}

describe('Hstar OpenShop editor host runtime', () => {
  let protocol;
  let runtime;
  let parentWindow;
  let editor;
  let projectAdapter;

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
    editor = { canvasW: 1920, canvasH: 1080 };
    projectAdapter = {
      restoreProject: vi.fn(async () => ({ project: { schemaVersion: 1 } })),
      queueSourceImageLayer: vi.fn(async () => ({ name: '来源图片' })),
      serializeProject: vi.fn(() => ({
        schemaVersion: 1,
        projectId: context.projectId,
        owner: {
          canvasType: context.canvasType,
          canvasId: context.canvasId,
          nodeId: context.nodeId
        }
      }))
    };
    runtime.start({
      editor,
      protocol,
      projectAdapter,
      parentWindow,
      origin: 'https://hstar.test',
      assetResolver: async assetId => `/static/assets/${assetId}.png`,
      imageLoader: async source => ({ source })
    });
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

  it('loads only the active project and resets request ids for a new session', async () => {
    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-1'));
    dispatch(envelope(protocol.TYPES.LOAD_PROJECT, 'load-1', {
      project: { schemaVersion: 1, projectId: 'project-1' }
    }));
    await flushMessages();

    expect(projectAdapter.restoreProject).toHaveBeenCalledTimes(1);

    dispatch(envelope(protocol.TYPES.OPEN_SESSION, 'open-2', {}, {
      sessionId: 'session-2'
    }));
    dispatch(envelope(protocol.TYPES.LOAD_PROJECT, 'load-1', {
      project: { schemaVersion: 1, projectId: 'project-1' }
    }, {
      sessionId: 'session-2'
    }));
    await flushMessages();

    expect(projectAdapter.restoreProject).toHaveBeenCalledTimes(2);
    expect(runtime.getState().activeSession.sessionId).toBe('session-2');
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
});
