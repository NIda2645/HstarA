import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const classicPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'canvas-openshop.js');
const smartPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'smart-canvas-openshop.js');
const classicCanvasPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'canvas.js');
const smartCanvasPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'smart-canvas.js');

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
        rollbackImageOutput:vi.fn(id => {
          const nodeIndex = nodes.findIndex(node => node.id === id);
          if(nodeIndex >= 0) nodes.splice(nodeIndex, 1);
          for(let index = connections.length - 1; index >= 0; index -= 1){
            if(connections[index].from === id || connections[index].to === id) connections.splice(index, 1);
          }
        }),
        pushUndo:vi.fn(),
        selectOnly:vi.fn(),
        render:vi.fn(),
        scheduleSave:vi.fn(),
        recordAiTaskLog:vi.fn(() => true),
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
      const nodes = [source];
      window.HstarSmartCanvasOpenShopHooks = {
        getCanvasId:() => 'canvas-2',
        getNode:id => nodes.find(node => node.id === id) || null,
        createImageOutput:vi.fn(({requestId}) => {
          const node = {id:'smart-created', openshopRequestId:requestId};
          nodes.push(node);
          return node;
        }),
        rollbackImageOutput:vi.fn(id => {
          const nodeIndex = nodes.findIndex(node => node.id === id);
          if(nodeIndex >= 0) nodes.splice(nodeIndex, 1);
        }),
        pushUndo:vi.fn(),
        selectOnly:vi.fn(),
        render:vi.fn(),
        scheduleSave:vi.fn(),
        recordAiTaskLog:vi.fn(() => true),
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

  it('posts accepted immediately and success only after canvas persistence resolves', async () => {
    const persistence = deferred();
    const postMessage = vi.spyOn(window, 'postMessage').mockImplementation(() => {});
    const adapter = loadVariant(variant, vi.fn(() => persistence.promise));
    const data = outputData(variant, `${variant.name}-success`);

    const importing = adapter.importOutput(data);
    await Promise.resolve();
    expect(postMessage).toHaveBeenCalledTimes(1);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type:'hstar-openshop-output-applied',
      requestId:`${variant.name}-success`,
      context:variant.context,
      status:'accepted',
    });

    persistence.resolve();
    const created = await importing;

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[1]).toEqual([
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

    expect(postMessage).toHaveBeenCalledTimes(2);
    expect(postMessage.mock.calls[0][0]).toMatchObject({
      type:'hstar-openshop-output-applied',
      requestId:`${variant.name}-failure`,
      context:variant.context,
      status:'accepted',
    });
    expect(postMessage.mock.calls[1][0]).toMatchObject({
      type:'hstar-openshop-output-applied',
      requestId:`${variant.name}-failure`,
      context:variant.context,
      status:'error',
      message:'canvas save failed',
    });
    expect(window[variant.hooks].rollbackImageOutput).toHaveBeenCalledTimes(1);
    expect(window[variant.hooks].rollbackImageOutput).toHaveBeenCalledWith(
      variant.name === 'classic' ? 'img-created' : 'smart-created',
    );
    const createdId = variant.name === 'classic' ? 'img-created' : 'smart-created';
    const createdStillExists = variant.name === 'classic'
      ? window[variant.hooks].getNodes().some(node => node.id === createdId)
      : Boolean(window[variant.hooks].getNode(createdId));
    expect(createdStillExists).toBe(false);
  });

  it('forwards one trusted artistic-font terminal log to the canvas hook', () => {
    const adapter = loadVariant(variant, vi.fn());
    const data = {
      type:'hstar-openshop-ai-task-log',
      context:{...variant.context},
      log:{
        taskId:`${variant.name}-art-task`, toolId:'art-font-restore', status:'success',
        modelId:'image-model', prompt:'Edited title', runMs:1200,
        output:{assetId:'b'.repeat(64), url:'/api/openshop/assets/art-result', name:'art.png'},
      },
    };

    expect(adapter.applyAiTaskLog(data)).toBe(true);
    expect(adapter.applyAiTaskLog(data)).toBe(false);
    expect(window[variant.hooks].recordAiTaskLog).toHaveBeenCalledTimes(1);
    expect(window[variant.hooks].recordAiTaskLog).toHaveBeenCalledWith(data.log, expect.objectContaining({
      id:variant.context.nodeId,
      projectId:variant.context.projectId,
    }));
  });

  it('forwards one trusted local-redraw terminal log to the canvas hook', () => {
    const adapter = loadVariant(variant, vi.fn());
    const data = {
      type:'hstar-openshop-ai-task-log',
      context:{...variant.context},
      log:{
        taskId:`${variant.name}-redraw-task`, toolId:'local-redraw', status:'failed',
        modelId:'gpt-image-2', prompt:'Replace the selection', error:'upstream failed', runMs:1200,
      },
    };

    expect(adapter.applyAiTaskLog(data)).toBe(true);
    expect(adapter.applyAiTaskLog(data)).toBe(false);
    expect(window[variant.hooks].recordAiTaskLog).toHaveBeenCalledOnce();
    expect(window[variant.hooks].recordAiTaskLog).toHaveBeenCalledWith(data.log, expect.objectContaining({
      id:variant.context.nodeId,
      projectId:variant.context.projectId,
    }));
  });
});

describe('OpenShop AI canvas log hooks', () => {
  it('persists the actual OpenShop tool id in both canvas implementations', () => {
    const classic = readFileSync(classicCanvasPath, 'utf8');
    const smart = readFileSync(smartCanvasPath, 'utf8');

    for(const source of [classic, smart]) {
      expect(source).toContain('recordAiTaskLog');
      expect(source).toContain("platform:'OpenShop'");
      expect(source).toContain('openshopTaskId');
      expect(source).toContain("tool_id:String(log.toolId");
      expect(source).toContain("const error = ['failed', 'partial'].includes(log.status)");
      expect(source).toContain("status:log.status === 'partial' ? 'partial' : (error ? 'failed' : 'success')");
    }
  });
});
