import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const clientPath = resolve(testDir, '..', 'host', 'openshop-generative-client.js');

const context = {
  canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
};

const requestSnapshot = {
  toolId:'local-redraw',
  sourceAssetId:'a'.repeat(64),
  maskAssetId:'b'.repeat(64),
  primaryReferenceAssetId:'c'.repeat(64),
  references:[{
    assetId:'c'.repeat(64), alias:'参考图1', mention:'@参考图1', sourceType:'primary', order:0,
  }],
  apiConfigId:'image-api',
  modelId:'image-model',
  prompt:'重绘 @参考图1',
  size:'2048x2048',
  quality:'high',
  targetCount:3,
  referenceMode:'full',
  sourceLayerId:'source-layer',
  sourceLayerIndex:2,
  document:{width:1920, height:1080, layerVersion:17, visibleCompositeVersion:23},
  selection:{x:10, y:20, width:300, height:200, feather:0},
  seed:42,
};

function jsonResponse(value, status=200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers:{'Content-Type':'application/json'},
  }));
}

describe('Hstar OpenShop generative task client', () => {
  beforeEach(async () => {
    expect(existsSync(clientPath), `${clientPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopGenerativeClient;
    await import(`${pathToFileURL(clientPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('creates, continuously polls and retries a partially successful parent task', async () => {
    const statuses = ['running', 'partial'];
    const fetchImpl = vi.fn((url, options={}) => {
      if(url === '/api/openshop/projects/project-1/ai-tasks' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        expect(body).toEqual({
          owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1'},
          tool_id:'local-redraw',
          source_asset_id:'a'.repeat(64),
          mask_asset_id:'b'.repeat(64),
          primary_reference_asset_id:'c'.repeat(64),
          reference_assets:requestSnapshot.references,
          provider_id:'image-api',
          model_id:'image-model',
          prompt:'重绘 @参考图1',
          size:'2048x2048',
          quality:'high',
          target_count:3,
          reference_mode:'full',
          source_layer_id:'source-layer',
          source_layer_index:2,
          document:requestSnapshot.document,
          selection:requestSnapshot.selection,
          options:{},
        });
        return jsonResponse({
          task_id:'parent-1', status:'queued',
          task:{taskId:'parent-1', status:'queued', targetCount:3},
        });
      }
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/parent-1?')) {
        const status = statuses.shift() || 'partial';
        return jsonResponse({task:{
          taskId:'parent-1', status, targetCount:3,
          completedCount:status === 'partial' ? 2 : 0,
          failedCount:status === 'partial' ? 1 : 0,
        }});
      }
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/parent-1/retry-missing?')) {
        expect(options.method).toBe('POST');
        expect(JSON.parse(options.body)).toEqual({
          owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1'},
        });
        return jsonResponse({
          task_id:'parent-2', status:'queued',
          task:{taskId:'parent-2', status:'queued', retryOfTaskId:'parent-1'},
        });
      }
      return jsonResponse({detail:'unexpected request'}, 404);
    });
    const client = window.HstarOpenShopGenerativeClient.createClient({fetchImpl, pollIntervalMs:1});
    client.startSession(context);

    const created = await client.createTask(context, requestSnapshot);
    const updates = [];
    const task = await client.pollTask(context, created.task_id, {
      onUpdate:value => updates.push(value.status),
    });
    document.dispatchEvent(new Event('visibilitychange'));
    const retry = await client.retryMissing(context, task.taskId);

    expect(task).toMatchObject({status:'partial', completedCount:2, failedCount:1});
    expect(updates).toEqual(['running', 'partial']);
    expect(retry.task.retryOfTaskId).toBe(task.taskId);
    expect(client.getState().activePolls).toBe(0);
    client.destroy();
  });

  it('keeps a cancelled task cancelled when a late success response arrives', async () => {
    let resolvePoll;
    const delayedPoll = new Promise(resolve => { resolvePoll = resolve; });
    const onResult = vi.fn();
    const fetchImpl = vi.fn((url, options={}) => {
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/parent-late?') && options.method === 'GET') {
        return delayedPoll;
      }
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/parent-late?') && options.method === 'DELETE') {
        return jsonResponse({task:{taskId:'parent-late', status:'cancelled'}});
      }
      return jsonResponse({detail:'unexpected request'}, 404);
    });
    const client = window.HstarOpenShopGenerativeClient.createClient({fetchImpl, pollIntervalMs:1});
    client.startSession(context);

    const polling = client.pollTask(context, 'parent-late', {onResult});
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    const cancelled = await client.cancelTask(context, 'parent-late');
    resolvePoll(await jsonResponse({task:{
      taskId:'parent-late', status:'succeeded', completedCount:1, failedCount:0,
    }}));
    const terminal = await polling;

    expect(cancelled.status).toBe('cancelled');
    expect(terminal.status).toBe('cancelled');
    expect(onResult).not.toHaveBeenCalled();
    expect(client.getState().activePolls).toBe(0);
    client.destroy();
  });

  it('restores unfinished tasks and preserves frozen snapshots when the service lost a task', async () => {
    const records = [{
      taskId:'lost-task', kind:'parent', status:'running', toolId:'local-redraw',
      snapshot:{...requestSnapshot, seed:undefined},
    }];
    const onUpdate = vi.fn();
    const fetchImpl = vi.fn(() => jsonResponse({detail:'OpenShop AI task not found'}, 404));
    const client = window.HstarOpenShopGenerativeClient.createClient({fetchImpl, pollIntervalMs:1});
    client.startSession(context);

    const restored = await client.restoreTasks(records, {onUpdate});

    expect(restored).toEqual([expect.objectContaining({
      taskId:'lost-task', status:'failed', snapshot:records[0].snapshot,
      error:'后台服务已重启，任务状态不可恢复',
    })]);
    expect(onUpdate).toHaveBeenCalledWith(restored[0]);
    client.destroy();
  });
});
