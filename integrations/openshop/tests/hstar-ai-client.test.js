import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const clientPath = resolve(testDir, '..', 'host', 'openshop-ai-client.js');

const context = {
  canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
};

function catalog({extractModel='gemini-3.1-pro-high', removeModel='gemini-3-pro-image'} = {}) {
  return {
    schemaVersion:1,
    primaryProviderId:'vision',
    tools:{
      'text-extract':{
        id:'text-extract', label:'文字提取', capability:'structured-ocr-layout',
        providers:[{
          id:'vision', name:'Vision API', protocol:'openai', available:true,
          models:extractModel ? [{id:extractModel, name:extractModel, available:true}] : [],
        }],
      },
      'text-remove':{
        id:'text-remove', label:'去除文字', capability:'image-edit',
        providers:[{
          id:'vision', name:'Vision API', protocol:'openai', available:true,
          models:removeModel ? [{id:removeModel, name:removeModel, available:true}] : [],
        }],
      },
      'art-font-restore':{
        id:'art-font-restore', label:'艺术字体处理', capability:'reference-image-generation-transparent',
        providers:[{
          id:'vision', name:'Vision API', protocol:'openai', available:true,
          models:removeModel ? [{id:removeModel, name:removeModel, available:true, imageInput:true}] : [],
        }],
      },
    },
  };
}

class FakeBroadcastChannel {
  static instances = [];

  constructor(name) {
    this.name = name;
    this.onmessage = null;
    FakeBroadcastChannel.instances.push(this);
  }

  emit(data) {
    this.onmessage?.({data});
  }

  close() {}
}

function jsonResponse(value, status=200) {
  return Promise.resolve(new Response(JSON.stringify(value), {
    status,
    headers:{'Content-Type':'application/json'},
  }));
}

describe('Hstar OpenShop global API client', () => {
  beforeEach(async () => {
    expect(existsSync(clientPath), `${clientPath} should exist`).toBe(true);
    vi.resetModules();
    FakeBroadcastChannel.instances = [];
    delete window.HstarOpenShopAiClient;
    await import(`${pathToFileURL(clientPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('resolves global and project preferences without silently replacing stale models', async () => {
    const fetchImpl = vi.fn(() => jsonResponse(catalog()));
    const client = window.HstarOpenShopAiClient.createClient({fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel});
    await client.loadCatalog();

    expect(client.resolvePreference('text-extract', {mode:'global'})).toMatchObject({
      available:true,
      mode:'global',
      apiConfigId:'vision',
      modelId:'gemini-3.1-pro-high',
    });
    expect(client.resolvePreference('text-remove', {
      mode:'project', apiConfigId:'vision', modelId:'gemini-3-pro-image',
    })).toMatchObject({available:true, mode:'project'});
    expect(client.resolvePreference('text-extract', {
      mode:'project', apiConfigId:'vision', modelId:'deleted-model',
    })).toEqual({
      available:false,
      mode:'project',
      apiConfigId:'vision',
      modelId:'deleted-model',
      providerName:'Vision API',
      modelName:'deleted-model',
      reason:'配置不可用',
    });

    client.destroy();
  });

  it('refreshes the catalog after a studio-api provider broadcast', async () => {
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => jsonResponse(catalog()))
      .mockImplementationOnce(() => jsonResponse(catalog({extractModel:'gemini-3.2-pro'})));
    const client = window.HstarOpenShopAiClient.createClient({fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel});
    const updates = [];
    client.subscribe(value => updates.push(value));
    await client.loadCatalog();

    FakeBroadcastChannel.instances[0].emit({type:'providers-changed'});
    await vi.waitFor(() => {
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(client.resolvePreference('text-extract', {mode:'global'}).modelId).toBe('gemini-3.2-pro');
    });

    expect(client.resolvePreference('text-extract', {mode:'global'}).modelId).toBe('gemini-3.2-pro');
    expect(updates.at(-1).tools['text-extract'].providers[0].models[0].id).toBe('gemini-3.2-pro');
    client.destroy();
  });

  it('uses the real provider discovery endpoint without changing the saved catalog', async () => {
    const fetchImpl = vi.fn((url) => {
      if(url === '/api/openshop/ai/catalog') return jsonResponse(catalog());
      if(url === '/api/providers/vision/fetch-models') {
        return jsonResponse({
          total:3,
          all:['gemini-3.1-pro-high', 'gemini-3.2-pro', 'gemini-3-pro-image'],
          chat_models:['gemini-3.1-pro-high', 'gemini-3.2-pro'],
          image_models:['gemini-3-pro-image'],
        });
      }
      return jsonResponse({detail:'unexpected'}, 404);
    });
    const client = window.HstarOpenShopAiClient.createClient({fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel});
    await client.loadCatalog();
    const discovered = await client.discoverModels('vision');

    expect(discovered.total).toBe(3);
    expect(fetchImpl).toHaveBeenCalledWith('/api/providers/vision/fetch-models', expect.objectContaining({cache:'no-store'}));
    expect(client.resolvePreference('text-extract', {mode:'global'}).modelId).toBe('gemini-3.1-pro-high');
    client.destroy();
  });

  it('creates, polls and cancels tasks inside the active project scope', async () => {
    const statuses = ['running', 'succeeded'];
    const fetchImpl = vi.fn((url, options={}) => {
      if(url === '/api/openshop/ai/catalog') return jsonResponse(catalog());
      if(url === '/api/openshop/projects/project-1/ai-tasks' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        expect(body).toMatchObject({
          tool_id:'text-extract', provider_id:'vision', model_id:'gemini-3.1-pro-high',
          source_asset_id:'a'.repeat(64), owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1'},
        });
        return jsonResponse({task_id:'task-1', status:'queued'});
      }
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/task-1?') && (!options.method || options.method === 'GET')) {
        const status = statuses.shift() || 'succeeded';
        return jsonResponse({task:{taskId:'task-1', status, result:status === 'succeeded' ? {blocks:[]} : null}});
      }
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/task-1?') && options.method === 'DELETE') {
        return jsonResponse({ok:true, task:{taskId:'task-1', status:'cancelled'}});
      }
      return jsonResponse({detail:'unexpected'}, 404);
    });
    const client = window.HstarOpenShopAiClient.createClient({fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel, pollIntervalMs:1});
    client.startSession(context);
    const created = await client.createTask(context, {
      toolId:'text-extract', sourceAssetId:'a'.repeat(64), apiConfigId:'vision', modelId:'gemini-3.1-pro-high', mode:'layer',
    });
    const completed = await client.pollTask(context, created.task_id);
    const cancelled = await client.cancelTask(context, created.task_id);

    expect(completed.status).toBe('succeeded');
    expect(cancelled.status).toBe('cancelled');
    client.destroy();
  });

  it('forwards the artistic-font source layer and snapshot without rewriting them', async () => {
    const clientRequestId = 'art-font-request.project-1.node-1.text-layer-1.3';
    const artFont = {
      textLayerId:'text-layer-1', ocrBlockId:'ocr-title', originalText:'Original', currentText:'Edited',
      requestGeneration:3, document:{width:1920, height:1080},
      quad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
      visualProfile:{script:'en', fill:'#112233', weight:700},
    };
    const fetchImpl = vi.fn((_url, options={}) => {
      const body = JSON.parse(options.body);
      expect(body.source_layer_id).toBe('source-layer-1');
      expect(body.client_request_id).toBe(clientRequestId);
      expect(body.options.artFont).toEqual(artFont);
      return jsonResponse({task_id:'task-art-1', status:'queued'});
    });
    const client = window.HstarOpenShopAiClient.createClient({fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel});
    client.startSession(context);

    await client.createTask(context, {
      toolId:'art-font-restore', sourceLayerId:'source-layer-1', sourceAssetId:'a'.repeat(64),
      clientRequestId, apiConfigId:'vision', modelId:'gemini-3-pro-image', mode:'layer', options:{artFont},
    });

    client.destroy();
  });

  it('polls independent artistic-font tasks concurrently', async () => {
    const calls = new Map();
    const fetchImpl = vi.fn((url) => {
      const taskId = url.includes('task-art-a') ? 'task-art-a' : 'task-art-b';
      const count = (calls.get(taskId) || 0) + 1;
      calls.set(taskId, count);
      return jsonResponse({task:{taskId, status:count === 1 ? 'running' : 'succeeded'}});
    });
    const client = window.HstarOpenShopAiClient.createClient({
      fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel, pollIntervalMs:1,
    });
    client.startSession(context);

    const results = await Promise.all([
      client.pollTask(context, 'task-art-a'),
      client.pollTask(context, 'task-art-b'),
    ]);

    expect(results.map(task => task.taskId).sort()).toEqual(['task-art-a', 'task-art-b']);
    expect(calls).toEqual(new Map([['task-art-a', 2], ['task-art-b', 2]]));
    client.destroy();
  });

  it('aborts local polling on session stop without deleting the server task', async () => {
    const fetchImpl = vi.fn((_url, options={}) => jsonResponse({
      task:{taskId:'task-art-running', status:'running'},
    }));
    const client = window.HstarOpenShopAiClient.createClient({
      fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel, pollIntervalMs:50,
    });
    client.startSession(context);
    const polling = client.pollTask(context, 'task-art-running');
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalled());

    client.stopSession();

    await expect(polling).rejects.toMatchObject({name:'AbortError'});
    expect(fetchImpl.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
    client.destroy();
  });

  it('preserves HTTP status on poll failures for controller classification', async () => {
    const fetchImpl = vi.fn(() => jsonResponse({detail:'task registry entry missing'}, 404));
    const client = window.HstarOpenShopAiClient.createClient({
      fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel,
    });
    client.startSession(context);

    await expect(client.pollTask(context, 'task-missing')).rejects.toMatchObject({
      status:404,
      message:'task registry entry missing',
    });
    client.destroy();
  });

  it('rejects a late artistic-font create response after the node scope changes', async () => {
    let resolvePost;
    const postResponse = new Promise(resolve => { resolvePost = resolve; });
    const fetchImpl = vi.fn(() => postResponse);
    const client = window.HstarOpenShopAiClient.createClient({fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel});
    client.startSession(context);
    const creating = client.createTask(context, {
      toolId:'art-font-restore', sourceLayerId:'source-layer-1', sourceAssetId:'a'.repeat(64),
      apiConfigId:'vision', modelId:'gemini-3-pro-image', options:{artFont:{}},
    });
    await vi.waitFor(() => expect(fetchImpl).toHaveBeenCalledOnce());

    client.startSession({...context, nodeId:'node-2', projectId:'project-2'});
    resolvePost(new Response(JSON.stringify({task_id:'task-art-posted', status:'queued'}), {
      status:200, headers:{'Content-Type':'application/json'},
    }));

    await expect(creating).rejects.toMatchObject({name:'AbortError'});
    expect(fetchImpl.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
    client.destroy();
  });

  it('treats a partially successful parent task as terminal', async () => {
    const statuses = ['partial', 'failed'];
    const fetchImpl = vi.fn((url) => {
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/task-partial?')) {
        const status = statuses.shift() || 'failed';
        return jsonResponse({task:{taskId:'task-partial', status, completedCount:2, failedCount:1}});
      }
      return jsonResponse({detail:'unexpected'}, 404);
    });
    const client = window.HstarOpenShopAiClient.createClient({
      fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel, pollIntervalMs:1,
    });
    client.startSession(context);

    const completed = await client.pollTask(context, 'task-partial');

    expect(completed.status).toBe('partial');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    client.destroy();
  });

  it('rejects a late poll response after the node session changes', async () => {
    let resolveResponse;
    const delayed = new Promise(resolve => { resolveResponse = resolve; });
    const fetchImpl = vi.fn((url) => {
      if(url === '/api/openshop/ai/catalog') return jsonResponse(catalog());
      if(url.startsWith('/api/openshop/projects/project-1/ai-tasks/task-late?')) return delayed;
      return jsonResponse({detail:'unexpected'}, 404);
    });
    const client = window.HstarOpenShopAiClient.createClient({fetchImpl, BroadcastChannelImpl:FakeBroadcastChannel, pollIntervalMs:1});
    client.startSession(context);
    const polling = client.pollTask(context, 'task-late');
    client.startSession({...context, nodeId:'node-2', projectId:'project-2'});
    resolveResponse(new Response(JSON.stringify({task:{taskId:'task-late', status:'succeeded'}}), {
      status:200,
      headers:{'Content-Type':'application/json'},
    }));

    await expect(polling).rejects.toMatchObject({name:'AbortError'});
    client.destroy();
  });
});
