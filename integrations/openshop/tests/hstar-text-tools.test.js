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
const TRANSPARENT_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M/wHwAF/gL+X8XzAAAAAElFTkSuQmCC';

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {promise, resolve:resolvePromise, reject:rejectPromise};
}

function createOcrBlock({id='ocr-race', text='Deferred OCR'} = {}) {
  return {
    id, text, language:'en', script:'en', confidence:0.96, lowConfidence:false,
    quad:[{x:0.1,y:0.1},{x:0.4,y:0.1},{x:0.4,y:0.2},{x:0.1,y:0.2}],
    font:{familyCandidates:['Arial'], size:40, weight:400, style:'normal'},
    color:'#112233', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
  };
}

function artVisualProfile() {
  return {
    script:'en', dominantScript:'', fill:'#112233', alignment:'left', rotation:0,
    artistic:false, familyCandidates:['Arial'], size:40, weight:700, style:'normal',
    styleDescription:'painted title', letterSpacing:25, lineHeight:1.2,
    strokeColor:'#00000000', strokeWidth:0,
    shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0},
  };
}

function addArtCarrier(harness, {layerId='text-layer-1', blockId='ocr-title', text='Edited title'} = {}) {
  const object = new FakeIText(text, {
    name:text,
    hstarLayerId:layerId,
    hstarOcrSourceAssetId:SOURCE_ASSET_ID,
    hstarOcrSourceLayerId:'layer-source',
    hstarOcrBlockId:blockId,
    hstarOcrQuad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
    hstarOcrVisualProfile:artVisualProfile(),
    hstarOcrOriginalText:'Original title',
    hstarArtFontRequestGeneration:0,
    visible:true,
  });
  const layer = {
    layerId, name:text, visible:true, locked:false, opacity:100, blend:'source-over', objects:[object],
  };
  harness.editor.layers.push(layer);
  harness.objects.push(object);
  return {layer, object};
}

function artResult({assetId=OUTPUT_ASSET_ID, width=360, height=120} = {}) {
  return {
    assetId, url:TRANSPARENT_PNG, name:'art-font.png', mime:'image/png', width, height,
    contentBox:{x:10, y:5, width:340, height:110},
  };
}

class FakeIText {
  constructor(text, options={}) {
    this.type = 'i-text';
    this.text = text;
    this.initialOptions = {...options};
    this.setHistory = [];
    this.width = Math.max(1, text.length * Number(options.fontSize || 16) * 0.55);
    this.height = Math.max(1, Number(options.fontSize || 16) * 1.2);
    Object.assign(this, options);
  }

  set(values) {
    this.setHistory.push({...values});
    Object.assign(this, values);
  }

  initDimensions() {
    const spacing = Number(this.charSpacing || 0) * Number(this.fontSize || 16) / 1000;
    this.width = Math.max(1, this.text.length * Number(this.fontSize || 16) * 0.55
      + Math.max(0, this.text.length - 1) * spacing);
    this.height = Math.max(1, Number(this.fontSize || 16) * 1.2);
  }
}

class FakeShadow {
  constructor(options={}) {
    Object.assign(this, options);
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
      insertAt:vi.fn((object, index) => objects.splice(index, 0, object)),
      remove:vi.fn(object => {
        const index = objects.indexOf(object);
        if(index >= 0) objects.splice(index, 1);
      }),
      moveTo:vi.fn((object, index) => {
        const current = objects.indexOf(object);
        if(current >= 0) objects.splice(current, 1);
        objects.splice(index, 0, object);
      }),
      renderAll:vi.fn(),
      setActiveObject:vi.fn(),
    },
    updateLayersPanel:vi.fn(),
    saveHistory:vi.fn(),
  };
  return {editor, sourceImage, sourceLayer, objects};
}

function createHarness({pollResults={}, fontManagerOverrides={}} = {}) {
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
      'art-font-restore':{
        providers:[
          {id:'image-api', name:'生图 API', available:true, models:[
            {id:'gemini-3-pro-image', name:'gemini-3-pro-image', available:true, imageInput:true},
            {id:'image-model-b', name:'生图模型 B', available:true, imageInput:true},
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
    loadSystemFonts:vi.fn(async () => []),
    matchOcrFont:vi.fn(block => ({
      faceFamily:['zh', 'zh-hans', 'zh-hant', 'mixed'].includes(block.script || block.language)
        ? 'Microsoft YaHei UI'
        : 'Arial',
      weight:Number(block.font?.weight || 400),
      italic:block.font?.style === 'italic',
    })),
    scanEditor:vi.fn(() => []),
    replaceFont:vi.fn(),
    listCommonFonts:vi.fn(() => [
      {family:'Microsoft YaHei UI', label:'微软雅黑 UI', status:'available'},
      {family:'Arial', label:'Arial', status:'available'},
    ]),
    ...fontManagerOverrides,
  };
  const imageLoader = vi.fn(async result => ({
    type:'image', width:Number(result.width || 960), height:Number(result.height || 540), src:result.url,
    set(values){ Object.assign(this, values); },
  }));
  const runtime = {
    getState:vi.fn(() => ({activeSession:{context}})),
    requestSave:vi.fn(async () => ({saved:true})),
  };
  const controller = window.HstarOpenShopTextTools.createController({
    editor,
    runtime,
    aiClient,
    assetApi,
    fontManager,
    fabricRef:{IText:FakeIText, Shadow:FakeShadow},
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
    const extractedLayers = await controller.applyTextExtraction();
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

    const layers = await controller.applyTextExtraction();
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
        id:'ocr-title', text:'经典奶茶', language:'zh', script:'zh-hans', confidence:0.98, lowConfidence:false,
        quad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
        font:{
          artistic:true, familyCandidates:['Missing Font', 'Microsoft YaHei UI'], size:48,
          weight:700, style:'normal', styleDescription:'painted condensed title',
          letterSpacing:125, lineHeight:1.4, strokeColor:'#12345678', strokeWidth:3.5,
          shadow:{color:'#10203080', blur:6, offsetX:2, offsetY:-3},
        },
        color:'#7b3f12', align:'center', rotation:0, paragraphId:'title', lineIndex:0,
      },
      {
        id:'ocr-subtitle', text:'Bubble Milk Tea', language:'en', script:'en', confidence:0.94, lowConfidence:false,
        quad:[{x:0.2,y:0.4},{x:0.7,y:0.42},{x:0.69,y:0.46},{x:0.19,y:0.44}],
        font:{
          artistic:false, familyCandidates:['Missing Font', 'Arial'], size:22, weight:400,
          style:'italic', styleDescription:'clean italic sans', letterSpacing:20, lineHeight:1.16,
          strokeColor:'#00000000', strokeWidth:0,
          shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0},
        },
        color:'#d77721', align:'left', rotation:2, paragraphId:'subtitle', lineIndex:0,
      },
    ];
    const loadSystemFonts = vi.fn(async () => []);
    const matchOcrFont = vi.fn(block => block.id === 'ocr-title'
      ? {faceFamily:'01免Title Face', weight:800, italic:true}
      : {faceFamily:'03免Subtitle Face', weight:500, italic:false});
    const {controller, editor, sourceLayer, sourceImage, objects, fontManager} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:960, height:540, blocks}}},
      fontManagerOverrides:{loadSystemFonts, matchOcrFont},
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

    const reviewedBlocks = [{...blocks[0], text:'经典奶茶（校对）'}, blocks[1]];
    const layers = await controller.applyTextExtraction(reviewedBlocks);
    expect(layers).toHaveLength(2);
    expect(editor.layers).toEqual([sourceLayer, ...layers, existingTopLayer]);
    expect(objects).toEqual([sourceImage, ...layers.map(layer => layer.objects[0]), existingTopObject]);
    expect(sourceLayer.objects).toEqual([sourceImage]);
    expect(layers.map(layer => layer.name)).toEqual(['经典奶茶（校对）', 'Bubble Milk Tea']);
    expect(layers.every(layer => layer.objects.length === 1)).toBe(true);
    expect(new Set(layers.map(layer => layer.layerId)).size).toBe(2);
    expect(loadSystemFonts).toHaveBeenCalledOnce();
    expect(matchOcrFont).toHaveBeenNthCalledWith(1, reviewedBlocks[0]);
    expect(matchOcrFont).toHaveBeenNthCalledWith(2, reviewedBlocks[1]);
    expect(loadSystemFonts.mock.invocationCallOrder[0]).toBeLessThan(matchOcrFont.mock.invocationCallOrder[0]);
    expect(matchOcrFont.mock.invocationCallOrder[1]).toBeLessThan(editor.canvas.add.mock.invocationCallOrder.at(-1));

    const title = layers[0].objects[0];
    expect(title).toMatchObject({
      type:'i-text', text:'经典奶茶（校对）', left:192, top:216,
      fontFamily:'01免Title Face', fontSize:96, fill:'#7b3f12', fontWeight:800,
      fontStyle:'italic', textAlign:'center', lineHeight:1.4, editable:true,
      stroke:'#12345678', strokeWidth:7,
      hstarOcrBlockId:'ocr-title', hstarOcrSourceLayerId:'layer-source',
      hstarOcrSourceAssetId:SOURCE_ASSET_ID,
      hstarOcrFontCandidates:['Missing Font', 'Microsoft YaHei UI'],
      hstarOcrOriginalText:'经典奶茶', hstarArtFontRequestGeneration:0,
    });
    expect(title.initialOptions.charSpacing).toBe(125);
    expect(title.initialOptions.charSpacing).not.toBe(250);
    expect(title.charSpacing).not.toBe(title.initialOptions.charSpacing);
    const spacingMutationIndex = title.setHistory.findIndex(values => 'charSpacing' in values);
    const scaleMutationIndex = title.setHistory.findIndex(values => 'scaleX' in values || 'scaleY' in values);
    expect(spacingMutationIndex).toBeGreaterThanOrEqual(0);
    expect(spacingMutationIndex).toBeLessThan(scaleMutationIndex);
    expect(title.shadow).toEqual(expect.objectContaining({color:'#10203080', blur:12, offsetX:4, offsetY:-6}));
    expect(title.shadow).toBeInstanceOf(FakeShadow);
    expect(title.scaleX).toBeCloseTo(title.scaleY, 10);
    expect(title.width * title.scaleX).toBeLessThanOrEqual(576.001);
    expect(title.height * title.scaleY).toBeLessThanOrEqual(108.001);
    expect(title.hstarOcrQuad).toEqual(blocks[0].quad);
    expect(title.hstarOcrVisualProfile).toEqual({
      script:'zh-hans', dominantScript:'', fill:'#7b3f12', alignment:'center', rotation:0,
      artistic:true, familyCandidates:['Missing Font', 'Microsoft YaHei UI'], size:48,
      weight:700, style:'normal', styleDescription:'painted condensed title',
      letterSpacing:125, lineHeight:1.4, strokeColor:'#12345678', strokeWidth:3.5,
      shadow:{color:'#10203080', blur:6, offsetX:2, offsetY:-3},
    });

    const subtitle = layers[1].objects[0];
    expect(subtitle).toMatchObject({
      type:'i-text', text:'Bubble Milk Tea', left:384, top:432,
      fontFamily:'03免Subtitle Face', fontSize:44, fill:'#d77721', fontWeight:500,
      fontStyle:'normal', textAlign:'left', editable:true,
      hstarOcrBlockId:'ocr-subtitle', hstarOcrSourceLayerId:'layer-source',
      hstarOcrFontCandidates:['Missing Font', 'Arial'],
    });
    expect(subtitle.angle).toBeCloseTo(1.289, 2);
    expect(subtitle.scaleX).toBeCloseTo(subtitle.scaleY, 10);
    expect(editor.activeLayerIdx).toBe(2);
    expect(fontManager.scanEditor).toHaveBeenCalledWith(editor);
    controller.destroy();
  });

  it('preflights every OCR font match before canvas mutation and leaves no partial text on failure', async () => {
    const blocks = [
      {
        id:'ocr-ok', text:'First', script:'en', confidence:0.9,
        quad:[{x:0.1,y:0.1},{x:0.3,y:0.1},{x:0.3,y:0.2},{x:0.1,y:0.2}],
        font:{familyCandidates:['Arial'], size:32, weight:400, style:'normal'}, color:'#112233',
      },
      {
        id:'ocr-missing', text:'Second', script:'en', confidence:0.9,
        quad:[{x:0.1,y:0.3},{x:0.3,y:0.3},{x:0.3,y:0.4},{x:0.1,y:0.4}],
        font:{familyCandidates:['Missing Face'], size:32, weight:400, style:'normal'}, color:'#445566',
      },
    ];
    const matchOcrFont = vi.fn(block => {
      if(block.id === 'ocr-missing') throw new Error('No free-commercial local font match');
      return {faceFamily:'03免Arial', weight:400, italic:false};
    });
    const {controller, editor, objects} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:960, height:540, blocks}}},
      fontManagerOverrides:{matchOcrFont},
    });
    await controller.start();
    await controller.runTextExtraction();
    const originalLayers = [...editor.layers];
    const originalObjects = [...objects];

    await expect(controller.applyTextExtraction()).rejects.toThrow('No free-commercial local font match');

    expect(matchOcrFont).toHaveBeenCalledTimes(2);
    expect(editor.layers).toEqual(originalLayers);
    expect(objects).toEqual(originalObjects);
    expect(editor.canvas.add).not.toHaveBeenCalled();
    expect(editor.saveHistory).not.toHaveBeenCalledWith('文字提取');
    controller.destroy();
  });

  it('surfaces review-button font preflight failures without an unhandled async apply', async () => {
    const blocks = [{
      id:'ocr-missing-click', text:'Missing', script:'en', confidence:0.9,
      quad:[{x:0.1,y:0.1},{x:0.3,y:0.1},{x:0.3,y:0.2},{x:0.1,y:0.2}],
      font:{familyCandidates:['Missing Face'], size:32, weight:400, style:'normal'}, color:'#112233',
    }];
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:960, height:540, blocks}}},
      fontManagerOverrides:{matchOcrFont:vi.fn(() => { throw new Error('No local OCR face'); })},
    });
    await controller.start();
    await controller.runTextExtraction();

    document.querySelector('[data-hstar-action="apply-extraction"]').click();

    await vi.waitFor(() => expect(controller.getState()).toMatchObject({
      status:'failed', error:'No local OCR face',
    }));
    expect(editor.canvas.add).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('coalesces rapid OCR applies while font loading is pending', async () => {
    const blocks = [createOcrBlock()];
    const fontLoad = createDeferred();
    const loadSystemFonts = vi.fn(() => fontLoad.promise);
    const {controller, editor, fontManager} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
      fontManagerOverrides:{loadSystemFonts},
    });
    await controller.start();
    await controller.runTextExtraction();

    const firstApply = controller.applyTextExtraction();
    const secondApply = controller.applyTextExtraction();

    const loadCallsWhilePending = loadSystemFonts.mock.calls.length;
    const canvasCallsWhilePending = editor.canvas.add.mock.calls.length;
    fontLoad.resolve([]);
    const [firstLayers, secondLayers] = await Promise.all([firstApply, secondApply]);
    const finalLayerCount = editor.layers.length;
    const finalCanvasCalls = editor.canvas.add.mock.calls.length;
    const finalHistoryCalls = editor.saveHistory.mock.calls.length;
    const finalScanCalls = fontManager.scanEditor.mock.calls.length;
    controller.destroy();

    expect(loadCallsWhilePending).toBe(1);
    expect(canvasCallsWhilePending).toBe(0);
    expect(secondLayers).toBe(firstLayers);
    expect(firstLayers).toHaveLength(1);
    expect(finalLayerCount).toBe(2);
    expect(finalCanvasCalls).toBe(1);
    expect(finalHistoryCalls).toBe(1);
    expect(finalScanCalls).toBe(2);
  });

  it('abandons a pending OCR apply when a new project owns the review panel', async () => {
    const oldBlocks = [createOcrBlock({id:'ocr-old-project', text:'Old project OCR'})];
    const newBlocks = [createOcrBlock({id:'ocr-new-project', text:'New project OCR'})];
    const fontLoad = createDeferred();
    const {controller, editor, runtime} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks:oldBlocks}}},
      fontManagerOverrides:{loadSystemFonts:vi.fn(() => fontLoad.promise)},
    });
    await controller.start();
    await controller.runTextExtraction();
    const oldRecord = editor.__hstarAiTaskRecords[0];
    const dirty = vi.fn();
    window.addEventListener('openshop:project-dirty', dirty);

    const pendingApply = controller.applyTextExtraction();
    const newContext = {...context, canvasId:'canvas-2', nodeId:'node-2', projectId:'project-2'};
    const newRecord = {
      taskId:'task-new-project', toolId:'text-extract', status:'succeeded',
      sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID,
      createdAt:3, updatedAt:4, completedAt:4, appliedAt:0, error:'',
      result:{width:1920, height:1080, blocks:newBlocks},
    };
    runtime.getState.mockReturnValue({activeSession:{context:newContext}});
    editor.__hstarAiTaskRecords = [newRecord];
    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-2'}}}));
    await vi.waitFor(() => expect(controller.getState()).toMatchObject({status:'review', reviewBlocks:newBlocks}));

    fontLoad.resolve([]);
    await pendingApply;

    const finalState = controller.getState();
    const finalReviewText = document.querySelector('[data-hstar-ocr-index="0"]')?.value;
    const finalApplyDisabled = document.querySelector('[data-hstar-action="apply-extraction"]')?.disabled;
    const finalLayerCount = editor.layers.length;
    const finalCanvasCalls = editor.canvas.add.mock.calls.length;
    const finalHistoryCalls = editor.saveHistory.mock.calls.length;
    const finalDirtyCalls = dirty.mock.calls.length;
    window.removeEventListener('openshop:project-dirty', dirty);
    controller.destroy();

    expect(finalLayerCount).toBe(1);
    expect(finalCanvasCalls).toBe(0);
    expect(finalHistoryCalls).toBe(0);
    expect(finalDirtyCalls).toBe(0);
    expect(oldRecord.appliedAt).toBe(0);
    expect(newRecord.appliedAt).toBe(0);
    expect(finalState).toMatchObject({status:'review', reviewBlocks:newBlocks});
    expect(finalReviewText).toBe('New project OCR');
    expect(finalApplyDisabled).toBe(false);
  });

  it('checks protocol context again after deferred font loading', async () => {
    const blocks = [createOcrBlock({id:'ocr-context-change'})];
    const fontLoad = createDeferred();
    const {controller, editor, runtime} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
      fontManagerOverrides:{loadSystemFonts:vi.fn(() => fontLoad.promise)},
    });
    await controller.start();
    await controller.runTextExtraction();

    const pendingApply = controller.applyTextExtraction();
    runtime.getState.mockReturnValue({
      activeSession:{context:{...context, canvasType:'smart', canvasId:'smart-canvas-1'}},
    });
    fontLoad.resolve([]);
    await pendingApply;

    const finalLayerCount = editor.layers.length;
    const finalCanvasCalls = editor.canvas.add.mock.calls.length;
    const finalHistoryCalls = editor.saveHistory.mock.calls.length;
    controller.destroy();

    expect(finalLayerCount).toBe(1);
    expect(finalCanvasCalls).toBe(0);
    expect(finalHistoryCalls).toBe(0);
  });

  it('disables apply during font preflight and restores it for the same review', async () => {
    const blocks = [createOcrBlock({id:'ocr-button-pending'})];
    const fontLoad = createDeferred();
    const matchOcrFont = vi.fn(() => { throw new Error('Deferred font match failed'); });
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
      fontManagerOverrides:{loadSystemFonts:vi.fn(() => fontLoad.promise), matchOcrFont},
    });
    await controller.start();
    await controller.runTextExtraction();

    document.querySelector('[data-hstar-action="apply-extraction"]').click();

    const disabledWhilePending = document.querySelector('[data-hstar-action="apply-extraction"]')?.disabled;
    const canvasCallsWhilePending = editor.canvas.add.mock.calls.length;
    fontLoad.resolve([]);
    await vi.waitFor(() => expect(controller.getState()).toMatchObject({
      status:'failed', error:'Deferred font match failed',
    }));

    const disabledAfterCompletion = document.querySelector('[data-hstar-action="apply-extraction"]')?.disabled;
    const finalCanvasCalls = editor.canvas.add.mock.calls.length;
    controller.destroy();

    expect(disabledWhilePending).toBe(true);
    expect(canvasCallsWhilePending).toBe(0);
    expect(matchOcrFont).toHaveBeenCalledOnce();
    expect(disabledAfterCompletion).toBe(false);
    expect(finalCanvasCalls).toBe(0);
  });

  it.each([
    ['session reset', controller => window.dispatchEvent(new CustomEvent('openshop:session-opened', {
      detail:{session:{context:{...context, projectId:'project-reset'}}},
    }))],
    ['controller destroy', controller => controller.destroy()],
  ])('invalidates a pending OCR apply on %s', async (_label, invalidate) => {
    const blocks = [createOcrBlock({id:'ocr-invalidated'})];
    const fontLoad = createDeferred();
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
      fontManagerOverrides:{loadSystemFonts:vi.fn(() => fontLoad.promise)},
    });
    await controller.start();
    await controller.runTextExtraction();

    const pendingApply = controller.applyTextExtraction();
    invalidate(controller);
    fontLoad.resolve([]);
    await pendingApply;

    const finalLayerCount = editor.layers.length;
    const finalCanvasCalls = editor.canvas.add.mock.calls.length;
    const finalHistoryCalls = editor.saveHistory.mock.calls.length;
    const finalState = controller.getState();
    const panelExists = Boolean(document.getElementById('hstar-text-tools-panel'));
    controller.destroy();

    expect(finalLayerCount).toBe(1);
    expect(finalCanvasCalls).toBe(0);
    expect(finalHistoryCalls).toBe(0);
    if(_label === 'controller destroy'){
      expect(panelExists).toBe(false);
    } else {
      expect(finalState).toMatchObject({status:'idle', reviewBlocks:[]});
    }
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

    await controller.applyTextExtraction();
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

  it('renders and persists an artistic-font image model independently from OCR', async () => {
    const {controller, editor, runtime} = createHarness();
    await controller.start();
    controller.openTool('text-extract');

    const ocrModel = document.querySelector('[data-model-tool="text-extract"]');
    const artModel = document.querySelector('[data-model-tool="art-font-restore"]');
    expect(ocrModel).toBeTruthy();
    expect(artModel).toBeTruthy();
    expect(artModel.compareDocumentPosition(ocrModel) & Node.DOCUMENT_POSITION_PRECEDING).toBeTruthy();

    artModel.value = 'image-model-b';
    artModel.dispatchEvent(new Event('change', {bubbles:true}));

    expect(editor.__hstarAiToolPreferences['art-font-restore']).toMatchObject({
      toolId:'art-font-restore', mode:'project', apiConfigId:'image-api', modelId:'image-model-b',
    });
    expect(editor.__hstarAiToolPreferences['text-extract']).toBeUndefined();
    expect(runtime.requestSave).toHaveBeenLastCalledWith({reason:'ai-preference'});
    controller.destroy();
  });

  it('persists generation and task identity before polling, then applies one exact correlated raster', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, runtime, imageLoader} = harness;
    const {layer:carrierLayer, object:carrier} = addArtCarrier(harness);
    const recordSave = createDeferred();
    runtime.requestSave
      .mockResolvedValueOnce({saved:true})
      .mockImplementationOnce(() => recordSave.promise)
      .mockResolvedValue({saved:true});
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-1', status:'succeeded', outputAssetId:OUTPUT_ASSET_ID, result:artResult(),
    });
    imageLoader.mockResolvedValue({
      type:'image', width:360, height:120, set(values){ Object.assign(this, values); },
    });
    await controller.start();

    const restoring = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(aiClient.createTask).toHaveBeenCalledTimes(1));

    expect(carrier.hstarArtFontRequestGeneration).toBe(1);
    expect(runtime.requestSave).toHaveBeenNthCalledWith(1, {reason:'art-font-generation'});
    expect(aiClient.createTask.mock.calls[0][1]).toMatchObject({
      toolId:'art-font-restore', sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID,
      options:{artFont:{
        textLayerId:'text-layer-1', ocrBlockId:'ocr-title', originalText:'Original title',
        currentText:'Edited title', requestGeneration:1,
        document:{width:1920, height:1080}, quad:carrier.hstarOcrQuad,
        visualProfile:carrier.hstarOcrVisualProfile,
      }},
    });
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:'task-1', toolId:'art-font-restore', status:'queued', reconcileState:'pending',
      sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID,
      snapshot:{textLayerId:'text-layer-1', currentText:'Edited title', requestGeneration:1},
    });
    expect(aiClient.pollTask).not.toHaveBeenCalled();

    recordSave.resolve({saved:true});
    await restoring;

    expect(aiClient.pollTask).toHaveBeenCalledWith(context, 'task-1', expect.any(Object));
    expect(editor.layers).toHaveLength(3);
    expect(editor.layers[1]).toBe(carrierLayer);
    const generated = editor.layers[2];
    expect(generated.hstarAiGeneration).toEqual({
      taskId:'task-1', textLayerId:'text-layer-1', requestGeneration:1, outputAssetId:OUTPUT_ASSET_ID,
      toolId:'art-font-restore', contentBox:{x:10, y:5, width:340, height:110},
    });
    expect(generated.objects[0].hstarAiGeneration).toEqual(generated.hstarAiGeneration);
    expect(generated.objects[0].scaleX).toBe(generated.objects[0].scaleY);
    expect(carrierLayer.visible).toBe(false);
    expect(carrier.visible).toBe(false);
    expect(editor.saveHistory).toHaveBeenCalledOnce();
    expect(editor.saveHistory).toHaveBeenCalledWith('艺术字体处理');
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'succeeded', reconcileState:'applied', outputAssetId:OUTPUT_ASSET_ID,
      generatedLayerId:generated.layerId,
    });

    await controller.restorePendingArtTasks();
    expect(editor.layers).toHaveLength(3);
    expect(editor.saveHistory).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('runs different text layers concurrently while deduplicating repeat clicks on one layer', async () => {
    const harness = createHarness();
    const {controller, aiClient, editor} = harness;
    addArtCarrier(harness, {layerId:'text-layer-a', blockId:'ocr-a', text:'Alpha'});
    addArtCarrier(harness, {layerId:'text-layer-b', blockId:'ocr-b', text:'Beta'});
    const pending = new Map();
    aiClient.pollTask.mockImplementation((_context, taskId) => {
      const deferred = createDeferred();
      pending.set(taskId, deferred);
      return deferred.promise;
    });
    await controller.start();

    const first = controller.restoreArtFont('text-layer-a');
    const duplicate = controller.restoreArtFont('text-layer-a');
    const second = controller.restoreArtFont('text-layer-b');
    await vi.waitFor(() => expect(aiClient.pollTask).toHaveBeenCalledTimes(2));

    expect(aiClient.createTask).toHaveBeenCalledTimes(2);
    expect(controller.isArtFontBusy('text-layer-a')).toBe(true);
    expect(controller.isArtFontBusy('text-layer-b')).toBe(true);
    pending.get('task-1').resolve({taskId:'task-1', status:'succeeded', result:artResult({assetId:'d'.repeat(64)})});
    pending.get('task-2').resolve({taskId:'task-2', status:'succeeded', result:artResult({assetId:'e'.repeat(64)})});
    await Promise.all([first, duplicate, second]);

    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(2);
    expect(controller.isArtFontBusy('text-layer-a')).toBe(false);
    expect(controller.isArtFontBusy('text-layer-b')).toBe(false);
    controller.destroy();
  });

  it('marks changed text stale and invalid or failed insertions discarded without hiding the carrier', async () => {
    const staleHarness = createHarness();
    const staleCarrier = addArtCarrier(staleHarness);
    const terminal = createDeferred();
    staleHarness.aiClient.pollTask.mockReturnValue(terminal.promise);
    await staleHarness.controller.start();
    const staleRun = staleHarness.controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(staleHarness.aiClient.pollTask).toHaveBeenCalled());
    staleCarrier.object.text = 'Changed while running';
    terminal.resolve({taskId:'task-1', status:'succeeded', result:artResult()});
    await staleRun;

    expect(staleHarness.editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'succeeded', reconcileState:'stale', reconcileReason:'text-changed',
    });
    expect(staleCarrier.layer.visible).toBe(true);
    expect(staleCarrier.object.visible).toBe(true);
    expect(staleHarness.editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    staleHarness.controller.destroy();

    const invalidHarness = createHarness();
    const invalidCarrier = addArtCarrier(invalidHarness);
    invalidHarness.aiClient.pollTask.mockResolvedValue({
      taskId:'task-1', status:'succeeded', result:{
        ...artResult(), contentBox:{x:10, y:5, width:400, height:110},
      },
    });
    await invalidHarness.controller.start();
    await invalidHarness.controller.restoreArtFont('text-layer-1');

    expect(invalidHarness.editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'succeeded', reconcileState:'discarded', reconcileReason:'invalid-output',
    });
    expect(invalidCarrier.layer.visible).toBe(true);
    expect(invalidCarrier.object.visible).toBe(true);
    expect(invalidHarness.editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    invalidHarness.controller.destroy();

    const rollbackHarness = createHarness();
    const rollbackCarrier = addArtCarrier(rollbackHarness);
    rollbackHarness.aiClient.pollTask.mockResolvedValue({
      taskId:'task-1', status:'succeeded', result:artResult(),
    });
    rollbackHarness.editor.canvas.insertAt.mockImplementation(() => { throw new Error('stack insertion failed'); });
    await rollbackHarness.controller.start();
    await rollbackHarness.controller.restoreArtFont('text-layer-1');

    expect(rollbackHarness.editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'succeeded', reconcileState:'discarded', reconcileReason:'apply-failed',
    });
    expect(rollbackCarrier.layer.visible).toBe(true);
    expect(rollbackCarrier.object.visible).toBe(true);
    expect(rollbackHarness.editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    rollbackHarness.controller.destroy();
  });

  it('rolls back a verified insertion when the applied record cannot be saved', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, runtime} = harness;
    const carrier = addArtCarrier(harness);
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-1', status:'succeeded', result:artResult(),
    });
    runtime.requestSave.mockImplementation(({reason}) => (
      reason === 'art-font-applied'
        ? Promise.reject(new Error('project save rejected'))
        : Promise.resolve({saved:true})
    ));
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    expect(carrier.layer.visible).toBe(true);
    expect(carrier.object.visible).toBe(true);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'succeeded', reconcileState:'discarded', reconcileReason:'apply-failed',
    });
    controller.destroy();
  });

  it('keeps a hidden-session art task pending and applies it once after the same node reopens', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient} = harness;
    const hiddenCarrier = addArtCarrier(harness);
    hiddenCarrier.object.hstarArtFontRequestGeneration = 1;
    const firstPoll = createDeferred();
    aiClient.pollTask.mockReturnValueOnce(firstPoll.promise).mockResolvedValueOnce({
      taskId:'task-art-hidden', status:'succeeded', result:artResult(),
    });
    editor.__hstarAiTaskRecords = [{
      taskId:'task-art-hidden', toolId:'art-font-restore', status:'running', reconcileState:'pending',
      reconcileReason:'', apiConfigId:'image-api', modelId:'gemini-3-pro-image', mode:'layer',
      context:{...context}, owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1'},
      sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID, outputAssetId:'', generatedLayerId:'',
      snapshot:{
        textLayerId:'text-layer-1', ocrBlockId:'ocr-title', originalText:'Original title',
        currentText:'Edited title', requestGeneration:1, document:{width:1920,height:1080},
        quad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
        visualProfile:artVisualProfile(),
      },
      createdAt:1, updatedAt:1, completedAt:0, appliedAt:0, staleAt:0, discardedAt:0,
    }];
    await controller.start();
    window.dispatchEvent(new CustomEvent('openshop:project-loaded'));
    await vi.waitFor(() => expect(aiClient.pollTask).toHaveBeenCalledTimes(1));

    window.dispatchEvent(new CustomEvent('openshop:session-hidden', {detail:{context}}));
    firstPoll.reject(new DOMException('hidden', 'AbortError'));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({status:'running', reconcileState:'pending'});
    expect(aiClient.stopSession).not.toHaveBeenCalled();
    expect(aiClient.cancelTask).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent('openshop:session-visible', {detail:{context}}));
    await vi.waitFor(() => expect(editor.__hstarAiTaskRecords[0].reconcileState).toBe('applied'));
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(1);
    expect(aiClient.cancelTask).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('persists a posted identity after hide and resumes it without creating a second task', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient} = harness;
    addArtCarrier(harness);
    const post = createDeferred();
    aiClient.createTask.mockReturnValue(post.promise);
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-posted-before-hide', status:'succeeded', result:artResult(),
    });
    await controller.start();

    const creating = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(aiClient.createTask).toHaveBeenCalledOnce());
    window.dispatchEvent(new CustomEvent('openshop:session-hidden', {detail:{context}}));
    post.resolve({task_id:'task-posted-before-hide', status:'queued'});
    await creating;

    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:'task-posted-before-hide', status:'queued', reconcileState:'pending',
    });
    expect(aiClient.pollTask).not.toHaveBeenCalled();
    expect(aiClient.cancelTask).not.toHaveBeenCalled();

    window.dispatchEvent(new CustomEvent('openshop:session-visible', {detail:{context}}));
    await vi.waitFor(() => expect(editor.__hstarAiTaskRecords[0].reconcileState).toBe('applied'));
    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(aiClient.pollTask).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('isolates a late create response after a node and project switch', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, runtime} = harness;
    addArtCarrier(harness);
    const post = createDeferred();
    aiClient.createTask.mockReturnValue(post.promise);
    await controller.start();
    const creating = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(aiClient.createTask).toHaveBeenCalledOnce());

    const contextB = {...context, nodeId:'node-2', projectId:'project-2'};
    runtime.getState.mockReturnValue({activeSession:{context:contextB}});
    window.dispatchEvent(new CustomEvent('openshop:session-opened', {detail:{session:{context:contextB}}}));
    editor.__hstarAiTaskRecords = [];
    const savesBeforeResponse = runtime.requestSave.mock.calls.length;
    post.resolve({task_id:'task-from-node-1', status:'queued'});
    await creating;

    expect(editor.__hstarAiTaskRecords).toEqual([]);
    expect(runtime.requestSave).toHaveBeenCalledTimes(savesBeforeResponse);
    expect(aiClient.pollTask).not.toHaveBeenCalled();
    expect(controller.getState().detachedArtTaskCount).toBe(1);
    controller.destroy();
  });

  it('revalidates edited text after deferred image decode before mutating the canvas', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, imageLoader} = harness;
    const carrier = addArtCarrier(harness);
    const decoded = createDeferred();
    imageLoader.mockReturnValue(decoded.promise);
    aiClient.pollTask.mockResolvedValue({taskId:'task-1', status:'succeeded', result:artResult()});
    await controller.start();
    const restoring = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(imageLoader).toHaveBeenCalledOnce());

    carrier.object.text = 'Changed during decode';
    decoded.resolve({type:'image', width:360, height:120, set(values){ Object.assign(this, values); }});
    await restoring;

    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'succeeded', reconcileState:'stale', reconcileReason:'text-changed',
    });
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    expect(carrier.layer.visible).toBe(true);
    expect(carrier.object.visible).toBe(true);
    expect(editor.saveHistory).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('isolates a decoded result after a node switch without updating the new project UI', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, imageLoader, runtime} = harness;
    addArtCarrier(harness);
    const decoded = createDeferred();
    imageLoader.mockReturnValue(decoded.promise);
    aiClient.pollTask.mockResolvedValue({taskId:'task-1', status:'succeeded', result:artResult()});
    await controller.start();
    const restoring = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(imageLoader).toHaveBeenCalledOnce());

    const contextB = {...context, nodeId:'node-2', projectId:'project-2'};
    runtime.getState.mockReturnValue({activeSession:{context:contextB}});
    window.dispatchEvent(new CustomEvent('openshop:session-opened', {detail:{session:{context:contextB}}}));
    editor.__hstarAiTaskRecords = [];
    editor.layers = [{layerId:'node-2-layer', name:'Node 2', visible:true, objects:[]}];
    editor.updateLayersPanel.mockClear();
    editor.canvas.renderAll.mockClear();
    editor.saveHistory.mockClear();
    runtime.requestSave.mockClear();
    decoded.resolve({type:'image', width:360, height:120, set(values){ Object.assign(this, values); }});
    await restoring;

    expect(editor.__hstarAiTaskRecords).toEqual([]);
    expect(editor.layers).toEqual([{layerId:'node-2-layer', name:'Node 2', visible:true, objects:[]}]);
    expect(editor.updateLayersPanel).not.toHaveBeenCalled();
    expect(editor.canvas.renderAll).not.toHaveBeenCalled();
    expect(editor.saveHistory).not.toHaveBeenCalled();
    expect(runtime.requestSave).not.toHaveBeenCalled();
    expect(controller.getState().detachedArtTaskCount).toBe(1);
    controller.destroy();
  });

  it('requires original OCR text and a live source layer before creating art work', async () => {
    const missingOriginal = createHarness();
    const originalCarrier = addArtCarrier(missingOriginal);
    delete originalCarrier.object.hstarOcrOriginalText;
    await missingOriginal.controller.start();
    await missingOriginal.controller.restoreArtFont('text-layer-1');
    expect(missingOriginal.aiClient.createTask).not.toHaveBeenCalled();
    expect(originalCarrier.object.hstarArtFontRequestGeneration).toBe(0);
    missingOriginal.controller.destroy();

    const deletedSource = createHarness();
    const sourceCarrier = addArtCarrier(deletedSource);
    deletedSource.editor.layers = deletedSource.editor.layers.filter(layer => layer !== deletedSource.sourceLayer);
    await deletedSource.controller.start();
    await deletedSource.controller.restoreArtFont('text-layer-1');
    expect(deletedSource.aiClient.createTask).not.toHaveBeenCalled();
    expect(sourceCarrier.object.hstarArtFontRequestGeneration).toBe(0);
    deletedSource.controller.destroy();
  });

  it('marks a succeeded result stale when its live OCR source layer was deleted', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, sourceLayer} = harness;
    const carrier = addArtCarrier(harness);
    const terminal = createDeferred();
    aiClient.pollTask.mockReturnValue(terminal.promise);
    await controller.start();
    const restoring = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(aiClient.pollTask).toHaveBeenCalledOnce());

    editor.layers = editor.layers.filter(layer => layer !== sourceLayer);
    terminal.resolve({taskId:'task-1', status:'succeeded', result:artResult()});
    await restoring;

    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      reconcileState:'stale', reconcileReason:'source-layer-missing',
    });
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    expect(carrier.layer.visible).toBe(true);
    expect(editor.saveHistory).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('rejects new art work at the active record cap without changing the carrier', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient} = harness;
    const carrier = addArtCarrier(harness);
    editor.__hstarAiTaskRecords = Array.from({length:100}, (_, index) => ({
      taskId:`active-${index}`, toolId:'art-font-restore', status:index % 2 ? 'running' : 'queued',
      reconcileState:'pending', createdAt:index + 1,
    }));
    await controller.start();

    const result = await controller.restoreArtFont('text-layer-1');

    expect(result).toBeNull();
    expect(aiClient.createTask).not.toHaveBeenCalled();
    expect(carrier.object.hstarArtFontRequestGeneration).toBe(0);
    expect(editor.__hstarAiTaskRecords).toHaveLength(100);
    controller.destroy();
  });
});
