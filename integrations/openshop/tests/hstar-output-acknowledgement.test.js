import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const classicPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'canvas-openshop.js');
const smartPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'smart-canvas-openshop.js');

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {promise, resolve:resolvePromise, reject:rejectPromise};
}

const variants = [
  {
    name:'classic',
    path:classicPath,
    adapter:'HstarClassicOpenShopAdapter',
    hooks:'HstarClassicOpenShopHooks',
    context:{canvasType:'classic', canvasId:'canvas-1', nodeId:'layered-1', projectId:'project-1'},
    install(saveCanvas) {
      const nodes = [{
        id:'layered-1', type:'openshop-layered', projectId:'project-1',
        x:100, y:100, w:340,
      }];
      const connections = [];
      window.HstarClassicOpenShopHooks = {
        getCanvasId:() => 'canvas-1',
        getNodes:() => nodes,
        getConnections:() => connections,
        uid:prefix => `${prefix}-created`,
        addNode:node => { nodes.push(node); return node; },
        addConnection:connection => { connections.push(connection); return connection; },
        pushUndo:vi.fn(),
        selectOnly:vi.fn(),
        render:vi.fn(),
        scheduleSave:vi.fn(),
        saveCanvas,
      };
    },
  },
  {
    name:'smart',
    path:smartPath,
    adapter:'HstarSmartOpenShopAdapter',
    hooks:'HstarSmartCanvasOpenShopHooks',
    context:{canvasType:'smart', canvasId:'canvas-2', nodeId:'layered-2', projectId:'project-2'},
    install(saveCanvas) {
      const source = {
        id:'layered-2', type:'openshop-layered', projectId:'project-2',
        x:100, y:100, w:340,
      };
      window.HstarSmartCanvasOpenShopHooks = {
        getCanvasId:() => 'canvas-2',
        getNode:id => id === source.id ? source : null,
        createImageOutput:vi.fn(({requestId}) => ({id:'smart-created', openshopRequestId:requestId})),
        pushUndo:vi.fn(),
        selectOnly:vi.fn(),
        render:vi.fn(),
        scheduleSave:vi.fn(),
        saveCanvas,
      };
    },
  },
];

function outputData(variant, requestId) {
  return {
    requestId,
    context:{...variant.context},
    output:{
      assetId:'a'.repeat(64),
      url:'/api/openshop/assets/output',
      name:'output.png',
      width:640,
      height:480,
    },
  };
}

function loadVariant(variant, saveCanvas) {
  delete window[variant.adapter];
  variant.install(saveCanvas);
  window.eval(readFileSync(variant.path, 'utf8'));
  return window[variant.adapter];
}

describe.each(variants)('$name OpenShop output acknowledgement', variant => {
  afterEach(() => {
    delete window[variant.adapter];
    delete window[variant.hooks];
    vi.restoreAllMocks();
  });

  it('posts success only after canvas persistence resolves', async () => {
    const persistence = deferred();
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    const adapter = loadVariant(variant, vi.fn(() => persistence.promise));
    const data = outputData(variant, `${variant.name}-success`);

    const importing = adapter.importOutput(data);
    await Promise.resolve();
    expect(postMessage).not.toHaveBeenCalled();

    persistence.resolve();
    const created = await importing;

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0]).toEqual([
      {
        type:'hstar-openshop-output-applied',
        requestId:`${variant.name}-success`,
        context:variant.context,
        status:'success',
        nodeId:created.id,
      },
      window.location.origin,
    ]);
  });

  it('posts an error acknowledgement when persistence rejects', async () => {
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    const adapter = loadVariant(variant, vi.fn(async () => { throw new Error('canvas save failed'); }));
    const data = outputData(variant, `${variant.name}-failure`);

    await expect(adapter.importOutput(data)).rejects.toThrow('canvas save failed');

    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type:'hstar-openshop-output-applied',
      requestId:`${variant.name}-failure`,
      context:variant.context,
      status:'error',
      message:'canvas save failed',
    });
  });
});
