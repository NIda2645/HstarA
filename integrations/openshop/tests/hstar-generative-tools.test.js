import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const toolsPath = resolve(testDir, '..', 'host', 'openshop-generative-tools.js');
const stylesPath = resolve(testDir, '..', 'host', 'openshop-generative-tools.css');
const indexPath = resolve(testDir, '..', 'index.html');

const context = {
  canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
};
const SOURCE_ASSET_ID = 'a'.repeat(64);
const MASK_ASSET_ID = 'b'.repeat(64);
const PRIMARY_ASSET_ID = 'c'.repeat(64);

function catalog({available=true, maxOutputs=6}={}) {
  return {
    primaryProviderId:'image-api',
    tools:{
      'generative-fill':{
        id:'generative-fill', label:'生成式填充', providers:[{
          id:'image-api', name:'生图 API', available,
          models:[{
            id:'image-model', name:'图像模型', available,
            capabilities:{
              maxOutputs, maxReferenceImages:12,
              sizes:['auto', '2048x2048'], qualities:['auto', 'high'],
            },
          }],
        }],
      },
      'local-redraw':{
        id:'local-redraw', label:'局部重绘', providers:[{
          id:'image-api', name:'生图 API', available,
          models:[{
            id:'image-model', name:'图像模型', available,
            capabilities:{
              maxOutputs, maxReferenceImages:12,
              sizes:['auto', '2048x2048'], qualities:['auto', 'high'],
            },
          }],
        }],
      },
    },
  };
}

function createHarness({modelAvailable=true, maxOutputs=6, terminalTasks=[], retryTask=null}={}) {
  const canvasObjects = [];
  const sourceLayer = {layerId:'source-layer', name:'来源图层', visible:true, objects:[]};
  const editor = {
    canvasW:1920,
    canvasH:1080,
    historyIdx:17,
    activeLayerIdx:0,
    layers:[sourceLayer],
    state:{tool:'select'},
    _selectionBounds:null,
    _selectionMask:null,
    __hstarAiToolPreferences:{},
    __hstarAiTaskRecords:[],
    __hstarAiPendingResults:[],
    setTool:vi.fn(tool => { editor.state.tool = tool; }),
    updateLayersPanel:vi.fn(),
    saveHistory:vi.fn(),
    canvas:{
      add:vi.fn(object => canvasObjects.push(object)),
      moveTo:vi.fn((object, index) => {
        const current = canvasObjects.indexOf(object);
        if(current >= 0) canvasObjects.splice(current, 1);
        canvasObjects.splice(index, 0, object);
      }),
      getObjects:vi.fn(() => canvasObjects),
      renderAll:vi.fn(),
    },
  };
  const runtime = {
    getState:vi.fn(() => ({activeSession:{context}})),
    requestSave:vi.fn(async () => ({ok:true})),
  };
  const currentCatalog = catalog({available:modelAvailable, maxOutputs});
  const aiClient = {
    loadCatalog:vi.fn(async () => currentCatalog),
    subscribe:vi.fn(() => () => {}),
    getCatalog:vi.fn(() => currentCatalog),
    resolvePreference:vi.fn((toolId, preference={}) => {
      const model = currentCatalog.tools[toolId].providers[0].models[0];
      return {
        available:modelAvailable,
        mode:preference.mode === 'project' ? 'project' : 'global',
        apiConfigId:preference.apiConfigId || 'image-api',
        modelId:preference.modelId || 'image-model',
        providerName:'生图 API',
        modelName:preference.modelId || '图像模型',
        model,
        reason:modelAvailable ? '' : '配置不可用',
      };
    }),
  };
  const generativeClient = {
    startSession:vi.fn(),
    stopSession:vi.fn(),
    createTask:vi.fn(async (_context, request) => ({
      task_id:'parent-1', status:'queued',
      task:{taskId:'parent-1', kind:'parent', status:'queued', targetCount:request.targetCount},
    })),
    pollTask:vi.fn(async (_context, taskId, options={}) => {
      options.onUpdate?.({taskId, kind:'parent', status:'running', targetCount:3, completedCount:1, failedCount:0});
      return terminalTasks.shift() || {taskId, kind:'parent', status:'succeeded', targetCount:3, completedCount:3, failedCount:0, children:[]};
    }),
    cancelTask:vi.fn(async (_context, taskId) => ({taskId, status:'cancelled'})),
    retryMissing:vi.fn(async () => retryTask || ({
      task_id:'parent-retry', status:'queued',
      task:{taskId:'parent-retry', kind:'parent', status:'queued', targetCount:1, retryOfTaskId:'parent-1'},
    })),
    restoreTasks:vi.fn(async () => []),
  };
  const assetApi = {
    upload:vi.fn(async payload => ({
      assetId:payload.role === 'ai-mask' ? MASK_ASSET_ID : SOURCE_ASSET_ID,
      url:`/api/openshop/assets/${payload.role === 'ai-mask' ? MASK_ASSET_ID : SOURCE_ASSET_ID}`,
    })),
  };
  const references = [{
    assetId:PRIMARY_ASSET_ID, alias:'参考图1', mention:'@参考图1', sourceType:'primary', order:0,
    thumbnailUrl:'/api/openshop/assets/primary',
  }];
  const referenceManager = {
    setPrimaryMode:vi.fn(async () => references[0]),
    captureVisibleComposite:vi.fn(async () => ({dataUrl:'data:image/png;base64,FULL', width:1920, height:1080})),
    captureSelectionMask:vi.fn(() => ({dataUrl:'data:image/png;base64,MASK', width:1920, height:1080})),
    snapshotForTask:vi.fn(async () => ({
      primaryReferenceAssetId:PRIMARY_ASSET_ID,
      references:references.map(({thumbnailUrl, ...record}) => record),
    })),
    list:vi.fn(() => references),
    getPrimary:vi.fn(() => references[0]),
    itemsForMentionPicker:vi.fn(() => references),
    insertMention:vi.fn((text, start, end, mention) => ({
      text:`${text.slice(0, start)}${mention} ${text.slice(end)}`,
      cursor:start + mention.length + 1,
    })),
    destroy:vi.fn(),
  };
  const imageLoader = vi.fn(async result => ({
    type:'image', src:result.url, width:1920, height:1080,
    set(values){ Object.assign(this, values); },
  }));
  const controller = window.HstarOpenShopGenerativeTools.createController({
    editor, runtime, aiClient, generativeClient, assetApi, referenceManager, imageLoader,
  });
  return {
    controller, editor, runtime, aiClient, generativeClient, assetApi, referenceManager,
    imageLoader, sourceLayer, canvasObjects,
  };
}

function generationTask(overrides={}) {
  return {
    taskId:'parent-1', kind:'parent', toolId:'local-redraw', status:'partial',
    targetCount:4, completedCount:3, failedCount:1,
    apiConfigId:'image-api', modelId:'image-model', retryOfTaskId:'',
    snapshot:{
      originalTargetCount:4,
      sourceLayerId:'source-layer', sourceLayerIndex:0, prompt:'修改天空',
      size:'2048x2048', quality:'high', referenceMode:'full',
      references:[{assetId:PRIMARY_ASSET_ID, alias:'参考图1', sourceType:'primary', order:0}],
      selection:{x:10, y:20, width:300, height:200, feather:0},
    },
    children:[
      {childTaskId:'child-0', index:0, status:'succeeded', outputAssetId:'d'.repeat(64), result:{url:'/api/openshop/assets/d'}},
      {childTaskId:'child-1', index:1, status:'failed', outputAssetId:'', error:'timeout'},
      {childTaskId:'child-2', index:2, status:'succeeded', outputAssetId:'e'.repeat(64), result:{url:'/api/openshop/assets/e'}},
      {childTaskId:'child-3', index:3, status:'succeeded', outputAssetId:'f'.repeat(64), result:{url:'/api/openshop/assets/f'}},
    ],
    ...overrides,
  };
}

describe('Hstar OpenShop inline generative tools', () => {
  beforeEach(async () => {
    expect(existsSync(toolsPath), `${toolsPath} should exist`).toBe(true);
    expect(existsSync(stylesPath), `${stylesPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopGenerativeTools;
    document.body.innerHTML = `
      <div id="tool-options"><div id="opt-marquee"></div></div>
      <div id="canvas-area"></div>`;
    await import(`${pathToFileURL(toolsPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('keeps both entries enabled and moves into the selection tool when needed', async () => {
    const {controller, editor, assetApi, generativeClient} = createHarness();
    await controller.start();
    const fill = document.querySelector('[data-hstar-generative-tool="generative-fill"]');
    const redraw = document.querySelector('[data-hstar-generative-tool="local-redraw"]');

    expect(fill.disabled).toBe(false);
    expect(redraw.disabled).toBe(false);
    redraw.click();
    expect(editor.setTool).toHaveBeenCalledWith('marquee-rect');
    expect(controller.getState().status).toBe('selecting');
    expect(document.querySelector('[data-generative-selection-hint]').textContent)
      .toContain('请先选择要修改的区域');
    expect(assetApi.upload).not.toHaveBeenCalled();
    expect(generativeClient.createTask).not.toHaveBeenCalled();

    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
    expect(controller.getState().status).toBe('ready');
    expect(document.querySelector('[data-generative-operation-bar]').hidden).toBe(false);
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.value = '保留的未提交提示词';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));

    editor._selectionBounds = null;
    window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
    expect(controller.getState().status).toBe('selecting');
    expect(controller.getState().prompt).toBe('保留的未提交提示词');
    controller.destroy();
  });

  it('shows reference range, thumbnail and mention picker only for local redraw', async () => {
    const {controller, editor, referenceManager} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();

    controller.openTool('generative-fill');
    expect(document.querySelector('[data-reference-mode]')).toBeNull();
    expect(document.querySelector('[data-reference-strip]')).toBeNull();

    controller.openTool('local-redraw');
    expect(document.querySelector('[data-reference-mode="selection"]')).not.toBeNull();
    expect(document.querySelector('[data-reference-mode="full"]')).not.toBeNull();
    expect(document.querySelector('[data-primary-reference-thumbnail] img').src)
      .toContain('/api/openshop/assets/primary');
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.value = '@';
    prompt.setSelectionRange(1, 1);
    prompt.dispatchEvent(new Event('input', {bubbles:true}));
    const mention = document.querySelector('[data-reference-mention="@参考图1"]');
    expect(mention.hidden).toBe(false);
    mention.click();
    expect(referenceManager.insertMention).toHaveBeenCalled();
    expect(prompt.value).toContain('@参考图1');
    controller.destroy();
  });

  it('uses dynamic model limits and submits a frozen multi-reference snapshot', async () => {
    const {controller, editor, assetApi, referenceManager, generativeClient} = createHarness({maxOutputs:6});
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');

    const count = document.querySelector('[data-generative-count]');
    expect(count.max).toBe('6');
    count.value = '3';
    count.dispatchEvent(new Event('change', {bubbles:true}));
    const size = document.querySelector('[data-generative-size]');
    size.value = '2048x2048';
    size.dispatchEvent(new Event('change', {bubbles:true}));
    const quality = document.querySelector('[data-generative-quality]');
    quality.value = 'high';
    quality.dispatchEvent(new Event('change', {bubbles:true}));
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.value = '替换为 @参考图1 的材质';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));

    const task = await controller.submit();

    expect(task.status).toBe('succeeded');
    expect(assetApi.upload).toHaveBeenCalledWith(expect.objectContaining({role:'ai-source'}));
    expect(assetApi.upload).toHaveBeenCalledWith(expect.objectContaining({role:'ai-mask'}));
    expect(referenceManager.snapshotForTask).toHaveBeenCalledWith(expect.objectContaining({
      mode:'full', maxReferences:12,
    }));
    expect(generativeClient.createTask).toHaveBeenCalledWith(context, expect.objectContaining({
      toolId:'local-redraw', sourceAssetId:SOURCE_ASSET_ID, maskAssetId:MASK_ASSET_ID,
      primaryReferenceAssetId:PRIMARY_ASSET_ID, targetCount:3,
      size:'2048x2048', quality:'high', sourceLayerId:'source-layer',
      referenceMode:'full', references:[expect.objectContaining({alias:'参考图1'})],
    }));
    expect(JSON.stringify(generativeClient.createTask.mock.calls[0][1])).not.toMatch(/seed/i);
    expect(editor.__hstarAiTaskRecords.at(-1)).toMatchObject({
      taskId:'parent-1', status:'succeeded', completedCount:3,
    });
    controller.destroy();
  });

  it('preserves an unavailable project model and disables only submission', async () => {
    const {controller, editor} = createHarness({modelAvailable:false});
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    editor.__hstarAiToolPreferences['local-redraw'] = {
      toolId:'local-redraw', mode:'project', apiConfigId:'deleted-api', modelId:'deleted-model',
    };
    await controller.start();
    controller.openTool('local-redraw');

    expect(document.querySelector('[data-hstar-generative-tool="local-redraw"]').disabled).toBe(false);
    expect(document.querySelector('[data-generative-model]').textContent).toContain('deleted-model');
    expect(document.querySelector('[data-generative-submit]').disabled).toBe(true);
    expect(document.querySelector('[data-generative-disabled-reason]').textContent).toContain('配置不可用');
    controller.destroy();
  });

  it('emits one selection event from every OpenShop selection completion path', () => {
    const source = readFileSync(indexPath, 'utf8');
    expect(source).toContain("_emitSelectionChanged(reason='updated')");
    for(const reason of ['marquee', 'magic-wand', 'recalculated', 'lasso', 'cleared']) {
      expect(source).toContain(`_emitSelectionChanged('${reason}')`);
    }
  });

  it('uses the planned compact mobile drawer breakpoint', () => {
    const source = readFileSync(stylesPath, 'utf8');
    expect(source).toContain('@media (max-width: 640px)');
  });

  it('creates one visible transparent layer per successful child and stays idempotent', async () => {
    const {controller, editor, runtime, imageLoader} = createHarness();
    await controller.start();
    const task = generationTask();

    const inserted = await controller.applyTaskResults(task);
    const repeated = await controller.applyTaskResults(task);
    const generated = editor.layers.filter(layer => layer.hstarAiGeneration?.taskId === 'parent-1');

    expect(inserted).toHaveLength(3);
    expect(repeated).toHaveLength(0);
    expect(generated.map(layer => layer.name)).toEqual([
      '局部重绘 1/4', '局部重绘 3/4', '局部重绘 4/4',
    ]);
    expect(generated.every(layer => layer.visible)).toBe(true);
    expect(generated.every(layer => layer.objects[0].left === 0 && layer.objects[0].top === 0)).toBe(true);
    expect(generated.every(layer => !JSON.stringify(layer.hstarAiGeneration).match(/seed/i))).toBe(true);
    expect(imageLoader).toHaveBeenCalledTimes(3);
    expect(runtime.requestSave).toHaveBeenCalledWith({reason:'ai-generation'});
    controller.destroy();
  });

  it('queues successful children when the frozen source layer no longer exists', async () => {
    const {controller, editor, runtime} = createHarness();
    await controller.start();
    editor.layers = [{layerId:'unrelated', name:'其他图层', visible:true, objects:[]}];

    const inserted = await controller.applyTaskResults(generationTask({taskId:'parent-missing-source'}));

    expect(inserted).toEqual([]);
    expect(editor.__hstarAiPendingResults).toHaveLength(3);
    expect(editor.__hstarAiPendingResults.every(item => item.task.taskId === 'parent-missing-source')).toBe(true);
    expect(runtime.requestSave).toHaveBeenCalledWith({reason:'ai-generation'});
    controller.destroy();
  });

  it('never inserts results from a cancelled parent task', async () => {
    const {controller, editor, imageLoader} = createHarness();
    await controller.start();

    const inserted = await controller.applyTaskResults(generationTask({status:'cancelled'}));

    expect(inserted).toEqual([]);
    expect(editor.layers).toHaveLength(1);
    expect(imageLoader).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('retries only the missing count and applies the retry parent results', async () => {
    const retryTerminal = generationTask({
      taskId:'parent-retry', status:'succeeded', targetCount:1, completedCount:1, failedCount:0,
      retryOfTaskId:'parent-1',
      snapshot:{...generationTask().snapshot, originalTargetCount:4},
      children:[{childTaskId:'child-retry-1', index:1, status:'succeeded', outputAssetId:'9'.repeat(64), result:{url:'/api/openshop/assets/9'}}],
    });
    const originalPartial = generationTask();
    const {controller, editor, generativeClient} = createHarness({terminalTasks:[originalPartial, retryTerminal]});
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.value = '修改天空';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));
    const count = document.querySelector('[data-generative-count]');
    count.value = '4';
    count.dispatchEvent(new Event('change', {bubbles:true}));
    await controller.submit();

    const completed = await controller.retryMissing();

    expect(generativeClient.retryMissing).toHaveBeenCalledWith(context, 'parent-1');
    expect(completed.taskId).toBe('parent-retry');
    expect(editor.layers.find(layer => layer.hstarAiGeneration?.childTaskId === 'child-retry-1')?.name)
      .toBe('局部重绘 2/4');
    controller.destroy();
  });
});
