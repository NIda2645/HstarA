import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const toolsPath = resolve(testDir, '..', 'host', 'openshop-text-tools.js');

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
  const aiClient = {
    loadCatalog:vi.fn(async () => ({})),
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
    getCatalog:vi.fn(() => ({primaryProviderId:'vision-api', tools:{}})),
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
  const controller = window.HstarOpenShopTextTools.createController({
    editor,
    runtime:{getState:() => ({activeSession:{context}})},
    aiClient,
    assetApi,
    fontManager,
    fabricRef:{IText:FakeIText},
    imageLoader,
    maskRenderer:vi.fn(() => 'data:image/png;base64,SELECTION_MASK'),
  });
  return {controller, editor, sourceImage, sourceLayer, objects, aiClient, assetApi, fontManager, imageLoader, createdTasks};
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
    expect(panel.textContent).toContain('选择 API / 模型');
    expect(panel.textContent).toContain('执行文字提取');

    removeButton.click();
    expect(panel.dataset.toolId).toBe('text-remove');
    expect(panel.textContent).toContain('整层自动去字');
    expect(panel.textContent).toContain('选区去字');
    expect(panel.textContent).toContain('执行去除文字');
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

    const layer = controller.applyTextExtraction();
    expect(layer.name).toBe('提取文字');
    expect(layer.objects).toHaveLength(1);
    expect(layer.objects[0]).toMatchObject({
      type:'i-text', text:'中文 English', left:192, top:216,
      fontFamily:'Microsoft YaHei UI', fontSize:48, fill:'#112233', fontWeight:600,
    });
    expect(editor.layers).toHaveLength(2);
    expect(sourceLayer.objects).toContain(sourceImage);
    expect(editor.saveHistory).toHaveBeenCalledWith('文字提取');
    expect(aiClient.createTask).toHaveBeenCalledTimes(1);
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
});
