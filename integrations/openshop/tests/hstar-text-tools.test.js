import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const toolsPath = resolve(testDir, '..', 'host', 'openshop-text-tools.js');
const editorHtmlPath = resolve(testDir, '..', 'index.html');
const hostScriptPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'openshop-host.js');

const context = {
  canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
};
const SOURCE_ASSET_ID = 'a'.repeat(64);
const MASK_ASSET_ID = 'b'.repeat(64);
const OUTPUT_ASSET_ID = 'c'.repeat(64);

class FakeIText {
  constructor(text, options={}) {
    this.type = 'i-text';
    this.text = text;
    this.width = Math.max(1, text.length * Number(options.fontSize || 16) * 0.55);
    this.height = Math.max(1, Number(options.fontSize || 16) * 1.2);
    Object.assign(this, options);
  }

  set(values) {
    Object.assign(this, values);
  }
}

function createEditor() {
  const sourceImage = {
    type:'image', name:'source.png', visible:true, width:1920, height:1080,
    hstarAssetId:'source-existing', set(values){ Object.assign(this, values); },
  };
  const objects = [sourceImage];
  const sourceLayer = {
    layerId:'layer-source', name:'来源图片', visible:true, opacity:100,
    blend:'source-over', objects:[sourceImage],
  };
  const editor = {
    canvasW:1920,
    canvasH:1080,
    activeLayerIdx:0,
    layers:[sourceLayer],
    __hstarAiToolPreferences:{},
    __hstarAiTaskRecords:[],
    canvas:{
      viewportTransform:[1, 0, 0, 1, 0, 0],
      getObjects:vi.fn(() => objects),
      toDataURL:vi.fn(() => 'data:image/png;base64,ACTIVE_LAYER'),
      add:vi.fn(object => objects.push(object)),
      moveTo:vi.fn((object, index) => {
        const current = objects.indexOf(object);
        if(current >= 0) objects.splice(current, 1);
        objects.splice(index, 0, object);
      }),
      renderAll:vi.fn(),
    },
    updateLayersPanel:vi.fn(),
    saveHistory:vi.fn(),
  };
  return {editor, sourceImage, sourceLayer, objects};
}

function createHarness({pollResults={}} = {}) {
  const {editor, sourceImage, sourceLayer, objects} = createEditor();
  let taskSequence = 0;
  const createdTasks = [];
  const catalog = {
    primaryProviderId:'vision-api',
    tools:{
      'text-extract':{
        providers:[
          {id:'vision-api', name:'视觉 API', available:true, models:[
            {id:'gemini-3.1-pro-high', name:'gemini-3.1-pro-high', available:true},
          ]},
          {id:'vision-custom', name:'备用视觉 API', available:true, models:[
            {id:'vision-model-a', name:'视觉模型 A', available:true},
            {id:'vision-model-b', name:'视觉模型 B', available:true},
          ]},
        ],
      },
      'text-remove':{
        providers:[
          {id:'image-api', name:'生图 API', available:true, models:[
            {id:'gemini-3-pro-image', name:'gemini-3-pro-image', available:true},
          ]},
        ],
      },
    },
  };
  const aiClient = {
    loadCatalog:vi.fn(async () => catalog),
    subscribe:vi.fn(() => () => {}),
    startSession:vi.fn(),
    stopSession:vi.fn(),
    resolvePreference:vi.fn((toolId, preference={}) => ({
      available:true,
      mode:preference.mode === 'project' ? 'project' : 'global',
      apiConfigId:preference.apiConfigId || (toolId === 'text-extract' ? 'vision-api' : 'image-api'),
      modelId:preference.modelId || (toolId === 'text-extract' ? 'gemini-3.1-pro-high' : 'gemini-3-pro-image'),
      providerName:toolId === 'text-extract' ? '视觉 API' : '生图 API',
      modelName:preference.modelId || (toolId === 'text-extract' ? 'gemini-3.1-pro-high' : 'gemini-3-pro-image'),
      reason:'',
    })),
    createTask:vi.fn(async (_context, request) => {
      createdTasks.push(request);
      taskSequence += 1;
      return {task_id:`task-${taskSequence}`, status:'queued'};
    }),
    pollTask:vi.fn(async (_context, taskId) => {
      const request = createdTasks[Number(taskId.split('-')[1]) - 1];
      return pollResults[request.toolId] || {taskId, status:'failed', error:'missing test result'};
    }),
    cancelTask:vi.fn(async (_context, taskId) => ({taskId, status:'cancelled'})),
    discoverModels:vi.fn(async () => ({total:2, all:['model-a', 'model-b']})),
    getCatalog:vi.fn(() => catalog),
  };
  const assetApi = {
    upload:vi.fn(async payload => {
      if(payload.role === 'ai-mask') return {assetId:MASK_ASSET_ID, url:`/api/openshop/assets/${MASK_ASSET_ID}`};
      return {assetId:SOURCE_ASSET_ID, url:`/api/openshop/assets/${SOURCE_ASSET_ID}`};
    }),
  };
  const fontManager = {
    isAvailable:vi.fn(family => family !== 'Missing Font'),
    scanEditor:vi.fn(() => []),
    replaceFont:vi.fn(),
    listCommonFonts:vi.fn(() => [
      {family:'Microsoft YaHei UI', label:'微软雅黑 UI', status:'available'},
      {family:'Arial', label:'Arial', status:'available'},
    ]),
  };
  const imageLoader = vi.fn(async result => ({
    type:'image', width:960, height:540, src:result.url,
    set(values){ Object.assign(this, values); },
  }));
  const runtime = {
    getState:() => ({activeSession:{context}}),
    requestSave:vi.fn(async () => ({saved:true})),
  };
  const controller = window.HstarOpenShopTextTools.createController({
    editor,
    runtime,
    aiClient,
    assetApi,
    fontManager,
    fabricRef:{IText:FakeIText},
    imageLoader,
    maskRenderer:vi.fn(() => 'data:image/png;base64,SELECTION_MASK'),
  });
  return {controller, editor, sourceImage, sourceLayer, objects, aiClient, assetApi, fontManager, imageLoader, runtime, createdTasks};
}

describe('Hstar OpenShop multilingual text tools', () => {
  beforeEach(async () => {
    expect(existsSync(toolsPath), `${toolsPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopTextTools;
    document.body.innerHTML = `
      <div id="toolbar"></div>
      <div id="tool-options"><div id="opt-text"><select id="text-font"><option>Arial</option></select></div></div>
      <div id="canvas-area"></div>`;
    await import(`${pathToFileURL(toolsPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('adds two explicit independent tool buttons and right-side panels', async () => {
    const {controller} = createHarness();
    await controller.start();

    const extractButton = document.querySelector('[data-hstar-text-tool="text-extract"]');
    const removeButton = document.querySelector('[data-hstar-text-tool="text-remove"]');
    expect(extractButton?.title).toBe('文字提取');
    expect(removeButton?.title).toBe('去除文字');

    extractButton.click();
    const panel = document.getElementById('hstar-text-tools-panel');
    expect(panel.dataset.toolId).toBe('text-extract');
    expect(panel.querySelector('[data-text-provider]')).not.toBeNull();
    expect(panel.querySelector('[data-text-model]')).not.toBeNull();
    expect(panel.textContent).not.toContain('选择 API / 模型');
    expect(panel.textContent).toContain('执行文字提取');

    removeButton.click();
    expect(panel.dataset.toolId).toBe('text-remove');
    expect(panel.textContent).toContain('整层自动去字');
    expect(panel.textContent).toContain('选区去字');
    expect(panel.textContent).toContain('执行去除文字');
    controller.destroy();
  });

  it('cache-busts both the OpenShop editor and text tools runtime', () => {
    const editorHtml = readFileSync(editorHtmlPath, 'utf8');
    const hostScript = readFileSync(hostScriptPath, 'utf8');
    const textToolsVersion = editorHtml.match(/openshop-text-tools\.js\?v=([0-9.]+)/)?.[1];
    const editorVersion = hostScript.match(/openshop\/index\.html\?v=([0-9.]+)/)?.[1];
    expect(textToolsVersion).toBeTruthy();
    expect(editorVersion).toBe(textToolsVersion);
  });

  it('stores inline API and model selections without opening a separate dialog', async () => {
    const {controller, editor, runtime} = createHarness();
    await controller.start();
    controller.openTool('text-extract');

    const panel = document.getElementById('hstar-text-tools-panel');
    const provider = panel.querySelector('[data-text-provider]');
    expect(provider.value).toBe('vision-api');
    provider.value = 'vision-custom';
    provider.dispatchEvent(new Event('change', {bubbles:true}));
    expect(runtime.requestSave).toHaveBeenLastCalledWith({reason:'ai-preference'});

    const model = panel.querySelector('[data-text-model]');
    expect(model.value).toBe('vision-model-a');
    expect([...model.options].map(option => option.value)).toEqual(['vision-model-a', 'vision-model-b']);
    model.value = 'vision-model-b';
    model.dispatchEvent(new Event('change', {bubbles:true}));

    expect(editor.__hstarAiToolPreferences['text-extract']).toEqual({
      toolId:'text-extract', mode:'project', apiConfigId:'vision-custom', modelId:'vision-model-b',
    });
    expect(runtime.requestSave).toHaveBeenCalledTimes(2);
    expect(runtime.requestSave).toHaveBeenLastCalledWith({reason:'ai-preference'});
    expect(document.getElementById('hstar-api-selector')).toBeNull();
    controller.destroy();
  });

  it('extracts from the topmost visible image layer when the active layer is empty', async () => {
    const blocks = [{
      id:'ocr-fallback', text:'可识别文字', language:'zh', confidence:0.95, lowConfidence:false,
      quad:[{x:0.1,y:0.1},{x:0.4,y:0.1},{x:0.4,y:0.2},{x:0.1,y:0.2}],
      font:{familyCandidates:['Microsoft YaHei UI'], size:40, weight:400, style:'normal'},
      color:'#111111', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    }];
    const {controller, editor, sourceLayer, createdTasks} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
    });
    editor.layers.unshift({layerId:'layer-empty', name:'Layer 1', visible:true, opacity:100, blend:'source-over', objects:[]});
    editor.activeLayerIdx = 0;

    await controller.start();
    controller.openTool('text-extract');
    expect(document.querySelector('[data-hstar-action="run-extraction"]').disabled).toBe(false);

    const result = await controller.runTextExtraction();
    expect(result.blocks).toEqual(blocks);
    expect(createdTasks[0]).toMatchObject({toolId:'text-extract', sourceAssetId:SOURCE_ASSET_ID});
    expect(sourceLayer.objects).toHaveLength(1);
    const extractedLayers = controller.applyTextExtraction();
    expect(extractedLayers).toHaveLength(1);
    expect(editor.layers.indexOf(extractedLayers[0])).toBe(editor.layers.indexOf(sourceLayer) + 1);
    controller.destroy();
  });

  it('keeps OCR non-destructive until review is confirmed, then creates editable mixed-language text', async () => {
    const blocks = [{
      id:'ocr-1', text:'中文 English', language:'mixed', confidence:0.62, lowConfidence:true,
      quad:[{x:0.1,y:0.2},{x:0.5,y:0.2},{x:0.5,y:0.3},{x:0.1,y:0.3}],
      font:{familyCandidates:['Microsoft YaHei UI', 'Arial'], size:48, weight:600, style:'normal'},
      color:'#112233', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    }];
    const {controller, editor, sourceLayer, sourceImage, aiClient, assetApi, createdTasks} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
    });
    await controller.start();
    const result = await controller.runTextExtraction();

    expect(result.blocks).toEqual(blocks);
    expect(editor.layers).toHaveLength(1);
    expect(sourceLayer.objects).toContain(sourceImage);
    expect(createdTasks[0]).toMatchObject({
      toolId:'text-extract', sourceAssetId:SOURCE_ASSET_ID,
      apiConfigId:'vision-api', modelId:'gemini-3.1-pro-high', mode:'layer',
    });
    expect(assetApi.upload).toHaveBeenCalledWith(expect.objectContaining({role:'ai-source'}));
    expect(document.getElementById('hstar-text-tools-panel').textContent).toContain('低置信度');

    const layers = controller.applyTextExtraction();
    expect(layers).toHaveLength(1);
    expect(layers[0].name).toBe('中文 English');
    expect(layers[0].objects).toHaveLength(1);
    expect(layers[0].objects[0]).toMatchObject({
      type:'i-text', text:'中文 English', left:192, top:216,
      fontFamily:'Microsoft YaHei UI', fontSize:48, fill:'#112233', fontWeight:600,
    });
    expect(editor.layers).toHaveLength(2);
    expect(sourceLayer.objects).toContain(sourceImage);
    expect(editor.saveHistory).toHaveBeenCalledWith('文字提取');
    expect(aiClient.createTask).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('creates one precisely fitted editable layer per OCR block in reading order', async () => {
    const blocks = [
      {
        id:'ocr-title', text:'经典奶茶', language:'zh', confidence:0.98, lowConfidence:false,
        quad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
        font:{familyCandidates:['Missing Font', 'Microsoft YaHei UI'], size:48, weight:700, style:'normal'},
        color:'#7b3f12', align:'center', rotation:0, paragraphId:'title', lineIndex:0,
      },
      {
        id:'ocr-subtitle', text:'Bubble Milk Tea', language:'en', confidence:0.94, lowConfidence:false,
        quad:[{x:0.2,y:0.4},{x:0.7,y:0.42},{x:0.69,y:0.46},{x:0.19,y:0.44}],
        font:{familyCandidates:['Missing Font', 'Arial'], size:22, weight:400, style:'italic'},
        color:'#d77721', align:'left', rotation:2, paragraphId:'subtitle', lineIndex:0,
      },
    ];
    const {controller, editor, sourceLayer, sourceImage, objects} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:960, height:540, blocks}}},
    });
    const existingTopObject = {type:'rect', name:'existing top object'};
    const existingTopLayer = {
      layerId:'layer-existing-top', name:'Existing top layer', visible:true, opacity:100,
      blend:'source-over', objects:[existingTopObject],
    };
    editor.layers.push(existingTopLayer);
    editor.canvas.add(existingTopObject);
    await controller.start();
    await controller.runTextExtraction();

    const layers = controller.applyTextExtraction();
    expect(layers).toHaveLength(2);
    expect(editor.layers).toEqual([sourceLayer, ...layers, existingTopLayer]);
    expect(objects).toEqual([sourceImage, ...layers.map(layer => layer.objects[0]), existingTopObject]);
    expect(sourceLayer.objects).toEqual([sourceImage]);
    expect(layers.map(layer => layer.name)).toEqual(['经典奶茶', 'Bubble Milk Tea']);
    expect(layers.every(layer => layer.objects.length === 1)).toBe(true);
    expect(new Set(layers.map(layer => layer.layerId)).size).toBe(2);

    const title = layers[0].objects[0];
    expect(title).toMatchObject({
      type:'i-text', text:'经典奶茶', left:192, top:216,
      fontFamily:'Microsoft YaHei UI', fontSize:96, fill:'#7b3f12', fontWeight:700,
      fontStyle:'normal', textAlign:'center', editable:true,
      hstarOcrBlockId:'ocr-title', hstarOcrSourceLayerId:'layer-source',
      hstarOcrFontCandidates:['Missing Font', 'Microsoft YaHei UI'],
    });
    expect(title.width * title.scaleX).toBeCloseTo(576, 3);
    expect(title.height * title.scaleY).toBeCloseTo(108, 3);

    const subtitle = layers[1].objects[0];
    expect(subtitle).toMatchObject({
      type:'i-text', text:'Bubble Milk Tea', left:384, top:432,
      fontFamily:'Arial', fontSize:44, fill:'#d77721', fontWeight:400,
      fontStyle:'italic', textAlign:'left', editable:true,
      hstarOcrBlockId:'ocr-subtitle', hstarOcrSourceLayerId:'layer-source',
      hstarOcrFontCandidates:['Missing Font', 'Arial'],
    });
    expect(subtitle.angle).toBeCloseTo(1.289, 2);
    expect(subtitle.width * subtitle.scaleX).toBeCloseTo(960.243, 2);
    expect(subtitle.height * subtitle.scaleY).toBeCloseTo(47.275, 2);
    expect(editor.activeLayerIdx).toBe(2);
    controller.destroy();
  });

  it('removes text without OCR and adds a new pixel layer while preserving the source', async () => {
    const output = {
      assetId:OUTPUT_ASSET_ID,
      url:`/api/openshop/assets/${OUTPUT_ASSET_ID}`,
      name:'removed.png', width:1920, height:1080, mime:'image/png',
    };
    const {controller, editor, sourceLayer, sourceImage, aiClient, createdTasks} = createHarness({
      pollResults:{'text-remove':{taskId:'task-1', status:'succeeded', result:output}},
    });
    await controller.start();
    const layer = await controller.runTextRemoval({mode:'layer', quality:'high', prompt:'保留纸张纹理'});

    expect(layer.name).toBe('去除文字');
    expect(layer.objects[0]).toMatchObject({
      type:'image', hstarAssetId:OUTPUT_ASSET_ID, hstarAssetRole:'ai-output', left:0, top:0,
    });
    expect(editor.layers).toHaveLength(2);
    expect(sourceLayer.objects).toContain(sourceImage);
    expect(createdTasks[0]).toMatchObject({
      toolId:'text-remove', apiConfigId:'image-api', modelId:'gemini-3-pro-image', mode:'layer',
      options:{quality:'high', prompt:'保留纸张纹理'},
    });
    expect(createdTasks.some(task => task.toolId === 'text-extract')).toBe(false);
    expect(aiClient.createTask).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('uploads an explicit selection mask for selection-only text removal', async () => {
    const output = {assetId:OUTPUT_ASSET_ID, url:`/api/openshop/assets/${OUTPUT_ASSET_ID}`, name:'selection.png', width:1920, height:1080};
    const {controller, editor, assetApi, createdTasks} = createHarness({
      pollResults:{'text-remove':{taskId:'task-1', status:'succeeded', result:output}},
    });
    editor._selectionBounds = {x:100, y:80, w:500, h:200};
    await controller.start();
    await controller.runTextRemoval({mode:'selection'});

    expect(assetApi.upload).toHaveBeenCalledWith(expect.objectContaining({
      role:'ai-mask', dataUrl:'data:image/png;base64,SELECTION_MASK',
    }));
    expect(createdTasks[0]).toMatchObject({
      toolId:'text-remove', mode:'selection', maskAssetId:MASK_ASSET_ID,
    });
    controller.destroy();
  });

  it('does not create a layer when removal fails or is cancelled', async () => {
    const failedHarness = createHarness({
      pollResults:{'text-remove':{taskId:'task-1', status:'failed', error:'上游拒绝'}},
    });
    await failedHarness.controller.start();
    const failed = await failedHarness.controller.runTextRemoval({mode:'layer'});
    expect(failed).toBeNull();
    expect(failedHarness.editor.layers).toHaveLength(1);
    expect(failedHarness.editor.__hstarAiTaskRecords.at(-1).status).toBe('failed');
    failedHarness.controller.destroy();

    let rejectPoll;
    const cancelHarness = createHarness();
    cancelHarness.aiClient.pollTask.mockImplementation(() => new Promise((_resolve, reject) => { rejectPoll = reject; }));
    cancelHarness.aiClient.cancelTask.mockImplementation(async (_context, taskId) => {
      const error = new DOMException('cancelled', 'AbortError');
      rejectPoll(error);
      return {taskId, status:'cancelled'};
    });
    await cancelHarness.controller.start();
    const running = cancelHarness.controller.runTextRemoval({mode:'layer'});
    await vi.waitFor(() => expect(cancelHarness.aiClient.pollTask).toHaveBeenCalled());
    await cancelHarness.controller.cancelActiveTask();
    await running;

    expect(cancelHarness.editor.layers).toHaveLength(1);
    expect(cancelHarness.editor.__hstarAiTaskRecords.at(-1).status).toBe('cancelled');
    cancelHarness.controller.destroy();
  });

  it('stores independent API preferences for extraction and removal', async () => {
    const {controller, editor} = createHarness();
    await controller.start();
    controller.setPreference('text-extract', {
      mode:'project', apiConfigId:'vision-custom', modelId:'vision-model',
    });
    controller.setPreference('text-remove', {
      mode:'project', apiConfigId:'image-custom', modelId:'image-model',
    });

    expect(editor.__hstarAiToolPreferences).toEqual({
      'text-extract':{
        toolId:'text-extract', mode:'project', apiConfigId:'vision-custom', modelId:'vision-model',
      },
      'text-remove':{
        toolId:'text-remove', mode:'project', apiConfigId:'image-custom', modelId:'image-model',
      },
    });
    controller.destroy();
  });

  it('restores completed unapplied OCR results for review after reopening a project', async () => {
    const blocks = [{
      id:'ocr-restored', text:'恢复的 Mixed 文本', language:'mixed', confidence:0.91, lowConfidence:false,
      quad:[{x:0.15,y:0.2},{x:0.55,y:0.2},{x:0.55,y:0.3},{x:0.15,y:0.3}],
      font:{familyCandidates:['Microsoft YaHei UI', 'Arial'], size:42, weight:400, style:'normal'},
      color:'#223344', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    }];
    const {controller, editor, aiClient} = createHarness();
    editor.__hstarAiTaskRecords = [{
      taskId:'task-restored-ocr', toolId:'text-extract', status:'succeeded',
      apiConfigId:'vision-api', modelId:'gemini-3.1-pro-high', mode:'layer',
      sourceAssetId:SOURCE_ASSET_ID, maskAssetId:'', outputAssetId:'',
      createdAt:1, updatedAt:2, completedAt:2, appliedAt:0, error:'',
      result:{schemaVersion:1, width:1920, height:1080, blocks},
    }];
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-1'}}}));
    await vi.waitFor(() => expect(controller.getState().status).toBe('review'));

    expect(controller.getState()).toMatchObject({activeTool:'text-extract', reviewBlocks:blocks});
    expect(document.querySelector('.hstar-ocr-preview img')?.getAttribute('src'))
      .toBe(`/api/openshop/assets/${SOURCE_ASSET_ID}`);
    expect(aiClient.pollTask).not.toHaveBeenCalled();

    controller.applyTextExtraction();
    expect(editor.__hstarAiTaskRecords[0].appliedAt).toBeGreaterThan(0);
    controller.destroy();
  });

  it('resumes an unfinished removal task and applies its output only once', async () => {
    const output = {
      assetId:OUTPUT_ASSET_ID,
      url:`/api/openshop/assets/${OUTPUT_ASSET_ID}`,
      name:'restored-removal.png', width:1920, height:1080,
    };
    const {controller, editor, aiClient} = createHarness();
    const record = {
      taskId:'task-restored-removal', toolId:'text-remove', status:'running',
      apiConfigId:'image-api', modelId:'gemini-3-pro-image', mode:'layer',
      sourceAssetId:SOURCE_ASSET_ID, maskAssetId:'', outputAssetId:'',
      createdAt:1, updatedAt:1, completedAt:0, appliedAt:0, error:'',
    };
    editor.__hstarAiTaskRecords = [record];
    aiClient.pollTask.mockResolvedValue({
      taskId:record.taskId, status:'succeeded', outputAssetId:OUTPUT_ASSET_ID, result:output,
    });
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-1'}}}));
    await vi.waitFor(() => expect(editor.layers).toHaveLength(2));

    expect(aiClient.pollTask).toHaveBeenCalledWith(context, record.taskId);
    expect(aiClient.createTask).not.toHaveBeenCalled();
    expect(record).toMatchObject({status:'succeeded', outputAssetId:OUTPUT_ASSET_ID});
    expect(record.appliedAt).toBeGreaterThan(0);

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-1'}}}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.layers).toHaveLength(2);
    expect(aiClient.pollTask).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('reports a restored output decode failure without losing the retryable task record', async () => {
    const {controller, editor, imageLoader} = createHarness();
    const record = {
      taskId:'task-restored-output', toolId:'text-remove', status:'succeeded',
      apiConfigId:'image-api', modelId:'gemini-3-pro-image', mode:'layer',
      sourceAssetId:SOURCE_ASSET_ID, maskAssetId:'', outputAssetId:OUTPUT_ASSET_ID,
      createdAt:1, updatedAt:2, completedAt:2, appliedAt:0, error:'',
    };
    editor.__hstarAiTaskRecords = [record];
    imageLoader.mockRejectedValue(new Error('image decode failed'));
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-1'}}}));
    await vi.waitFor(() => expect(controller.getState().status).toBe('failed'));

    expect(controller.getState().error).toContain('image decode failed');
    expect(record).toMatchObject({status:'succeeded', appliedAt:0});
    expect(editor.layers).toHaveLength(1);
    controller.destroy();
  });
});
