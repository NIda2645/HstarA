import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installFabricMock } from './os-harness.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const toolsPath = resolve(testDir, '..', 'host', 'openshop-text-tools.js');
const writingModePath = resolve(testDir, '..', 'host', 'openshop-writing-mode.js');
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

function httpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function createOcrBlock({id='ocr-race', text='Deferred OCR'} = {}) {
  return {
    id, text, language:'en', script:'en', confidence:0.96, lowConfidence:false,
    quad:[{x:0.1,y:0.1},{x:0.4,y:0.1},{x:0.4,y:0.2},{x:0.1,y:0.2}],
    runs:[{
      start:0, end:Array.from(text).length, script:'en', familyCandidates:['Arial'],
      size:40, weight:400, style:'normal', artistic:false, styleDescription:'clean sans',
      color:'#112233', letterSpacing:0, lineHeight:1.16,
      strokeColor:'#00000000', strokeWidth:0,
      shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0},
    }],
    align:'left', writingMode:'horizontal', rotation:0, paragraphId:'p1', lineIndex:0,
  };
}

function upgradeBlockToV5(block) {
  if(Array.isArray(block?.runs)) return block;
  const font = block?.font && typeof block.font === 'object' ? block.font : {};
  return {
    ...block,
    runs:[{
      start:0,
      end:Array.from(String(block?.text ?? '')).length,
      script:block?.script || 'mixed',
      familyCandidates:Array.isArray(font.familyCandidates) ? font.familyCandidates : [],
      size:Number(font.size || 40),
      weight:Number(font.weight || 400),
      style:font.style === 'italic' ? 'italic' : 'normal',
      artistic:font.artistic === true,
      styleDescription:String(font.styleDescription || ''),
      color:block?.color || block?.fill || '#ffffff',
      letterSpacing:Number(font.letterSpacing || 0),
      lineHeight:Number(font.lineHeight || 1.16),
      strokeColor:font.strokeColor || '#00000000',
      strokeWidth:Number(font.strokeWidth || 0),
      shadow:font.shadow || {color:'#00000000', blur:0, offsetX:0, offsetY:0},
    }],
  };
}

function artVisualProfile(writingMode = 'horizontal') {
  return {
    writingMode, script:'en', dominantScript:'', fill:'#112233', alignment:'left', rotation:0,
    artistic:false, familyCandidates:['Arial'], size:40, weight:700, style:'normal',
    styleDescription:'painted title', letterSpacing:25, lineHeight:1.2,
    strokeColor:'#00000000', strokeWidth:0,
    shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0},
  };
}

function addArtCarrier(harness, {
  layerId='text-layer-1', blockId='ocr-title', text='Edited title', writingMode='horizontal',
} = {}) {
  const TextClass = writingMode === 'vertical' ? FakeVerticalText : FakeIText;
  const object = new TextClass(text, {
    hstarWritingMode:writingMode,
    name:text,
    hstarLayerId:layerId,
    hstarOcrSourceAssetId:SOURCE_ASSET_ID,
    hstarOcrSourceLayerId:'layer-source',
    hstarOcrBlockId:blockId,
    hstarOcrQuad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
    hstarOcrVisualProfile:artVisualProfile(writingMode),
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

function artResult({
  assetId=OUTPUT_ASSET_ID,
  width=360,
  height=120,
  placementBox={x:180, y:200, width, height},
} = {}) {
  return {
    assetId, url:TRANSPARENT_PNG, name:'art-font.png', mime:'image/png', width, height,
    placementBox,
  };
}

function provisionalArtRecord({
  layerId='text-layer-1', blockId='ocr-title', text='Edited title', requestGeneration=1,
  clientRequestId=`art-font-request.project-1.node-1.${layerId}.${requestGeneration}`,
} = {}) {
  return {
    taskId:`provisional:${clientRequestId}`,
    clientRequestId,
    creationState:'provisional',
    toolId:'art-font-restore', apiConfigId:'image-api', modelId:'gemini-3-pro-image',
    status:'queued', reconcileState:'pending', reconcileReason:'', mode:'layer',
    context:{...context}, owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1'},
    sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID, maskAssetId:'',
    outputAssetId:'', generatedLayerId:'',
    snapshot:{
      textLayerId:layerId, ocrBlockId:blockId, originalText:'Original title',
      currentText:text, requestGeneration, document:{width:1920,height:1080},
      quad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
      visualProfile:artVisualProfile(),
    },
    createdAt:1, updatedAt:1, completedAt:0, appliedAt:0, staleAt:0, discardedAt:0,
    error:'',
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

class FakeVerticalText extends FakeIText {
  constructor(text, options={}) {
    super(text, options);
    this.type = 'hstar-vertical-text';
    this.initDimensions();
  }

  initDimensions() {
    const fontSize = Number(this.fontSize || 16);
    const graphemeCount = Array.from(this.text).length;
    const spacing = Number(this.charSpacing || 0) * fontSize / 1000;
    this.width = Math.max(1, fontSize * 1.2);
    this.height = Math.max(1, graphemeCount * fontSize * 1.2
      + Math.max(0, graphemeCount - 1) * spacing);
  }
}

class FakeShadow {
  constructor(options={}) {
    Object.assign(this, options);
  }
}

function createFakeWritingModeRuntime() {
  return {
    createTextObject:vi.fn((fabric, text, options={}) => (
      options.hstarWritingMode === 'vertical'
        ? new fabric.HstarVerticalText(text, options)
        : new fabric.IText(text, options)
    )),
  };
}

function createFakeOcrLayoutRuntime() {
  return {
    quadGeometry:vi.fn((quad, documentWidth, documentHeight, fallbackRotation=0) => {
      const points = quad.map(point => ({x:point.x * documentWidth, y:point.y * documentHeight}));
      const topEdge = {x:points[1].x - points[0].x, y:points[1].y - points[0].y};
      const sideEdge = {x:points[3].x - points[0].x, y:points[3].y - points[0].y};
      const angle = Math.atan2(topEdge.y, topEdge.x) * 180 / Math.PI;
      return {
        left:points[0].x,
        top:points[0].y,
        width:Math.hypot(topEdge.x, topEdge.y),
        height:Math.hypot(sideEdge.x, sideEdge.y),
        angle:Math.abs(angle) > 0.01 ? angle : fallbackRotation,
      };
    }),
    fitLineObject:vi.fn((object, geometry, options={}) => {
      object.set({
        left:geometry.left,
        top:geometry.top,
        angle:geometry.angle,
        scaleX:1,
        scaleY:1,
      });
      object.setCoords?.();
      return {writingMode:options.writingMode};
    }),
    paragraphPlan:vi.fn(() => ({merge:false, reason:'single-line'})),
  };
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

function createHarness({pollResults={}, fontManagerOverrides={}, aiClientOverrides={}, controllerOptions={}} = {}) {
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
      const task = pollResults[request.toolId] || {taskId, status:'failed', error:'missing test result'};
      if(
        request.toolId !== 'text-extract'
        || task.status !== 'succeeded'
        || !task.result
        || task.result.schemaVersion !== undefined
      ) return task;
      return {
        ...task,
        result:{
          ...task.result,
          schemaVersion:5,
          blocks:(task.result.blocks || []).map(upgradeBlockToV5),
        },
      };
    }),
    cancelTask:vi.fn(async (_context, taskId) => ({taskId, status:'cancelled'})),
    discoverModels:vi.fn(async () => ({total:2, all:['model-a', 'model-b']})),
    getCatalog:vi.fn(() => catalog),
    ...aiClientOverrides,
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
    matchOcrRun:vi.fn(run => ({
      family:['zh', 'zh-hans', 'zh-hant', 'mixed'].includes(run.script)
        ? '阿里巴巴普惠体 3.0'
        : '阿里妈妈灵动体',
      faceFamily:['zh', 'zh-hans', 'zh-hant', 'mixed'].includes(run.script)
        ? 'Microsoft YaHei UI'
        : 'Arial',
      styleId:'fixture-style',
      weight:Number(run.weight || 400),
      italic:run.style === 'italic',
      fallback:false,
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
  const writingModeRuntime = controllerOptions.writingModeRuntime || window.HstarOpenShopWritingMode;
  const ocrLayout = controllerOptions.ocrLayout || window.HstarOpenShopOcrLayout;
  const controller = window.HstarOpenShopTextTools.createController({
    editor,
    runtime,
    aiClient,
    assetApi,
    fontManager,
    fabricRef:{IText:FakeIText, HstarVerticalText:FakeVerticalText, Shadow:FakeShadow},
    imageLoader,
    maskRenderer:vi.fn(() => 'data:image/png;base64,SELECTION_MASK'),
    ocrLayout,
    ...controllerOptions,
  });
  return {
    controller, editor, sourceImage, sourceLayer, objects, aiClient, assetApi, fontManager,
    imageLoader, runtime, writingModeRuntime, ocrLayout, createdTasks,
  };
}

describe('Hstar OpenShop multilingual text tools', () => {
  beforeEach(async () => {
    expect(existsSync(toolsPath), `${toolsPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopTextTools;
    window.HstarOpenShopWritingMode = createFakeWritingModeRuntime();
    window.HstarOpenShopOcrLayout = createFakeOcrLayoutRuntime();
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
    expect(panel.textContent).not.toContain('处理范围');
    expect(panel.textContent).toContain('执行去除文字');
    controller.destroy();
  });

  it('waits for the initial API catalog before exposing text tool controls', async () => {
    const catalogPending = createDeferred();
    let loadedCatalog = null;
    let catalogListener = null;
    const initialCatalog = {
      tools:{
        'text-remove':{
          providers:[
            {id:'image-api', name:'生图 API', available:true, models:[
              {id:'gemini-3-pro-image', name:'gemini-3-pro-image', available:true},
            ]},
            {id:'image-custom', name:'备用生图 API', available:true, models:[
              {id:'image-model-b', name:'生图模型 B', available:true},
            ]},
          ],
        },
      },
    };
    const {controller, aiClient} = createHarness({
      aiClientOverrides:{
        getCatalog:vi.fn(() => loadedCatalog),
        subscribe:vi.fn(listener => {
          catalogListener = listener;
          return () => { catalogListener = null; };
        }),
        loadCatalog:vi.fn(async () => {
          loadedCatalog = await catalogPending.promise;
          catalogListener?.(loadedCatalog);
          return loadedCatalog;
        }),
      },
    });

    const start = controller.start();
    await vi.waitFor(() => expect(aiClient.loadCatalog).toHaveBeenCalledOnce());
    expect(document.querySelector('[data-hstar-text-tool="text-remove"]')).toBeNull();

    catalogPending.resolve(initialCatalog);
    await start;
    document.querySelector('[data-hstar-text-tool="text-remove"]').click();

    const provider = document.querySelector('[data-provider-tool="text-remove"]');
    expect([...provider.options].map(option => option.value)).toEqual(['image-api', 'image-custom']);
    controller.destroy();
  });

  it('uses one whole-layer removal workflow without range controls', async () => {
    const {controller} = createHarness();
    await controller.start();
    controller.openTool('text-remove');

    const panel = document.getElementById('hstar-text-tools-panel');
    expect(panel.textContent).not.toContain('处理范围');
    expect(panel.textContent).not.toContain('整层自动去字');
    expect(panel.textContent).not.toContain('选区去字');
    expect(panel.querySelector('[data-hstar-remove-mode]')).toBeNull();
    expect(panel.querySelector('[data-hstar-action="run-removal"]')).not.toBeNull();
    controller.destroy();
  });

  it('defaults text removal to 4K with the source aspect ratio available', async () => {
    const {controller} = createHarness();
    await controller.start();
    controller.openTool('text-remove');

    expect(document.getElementById('hstar-remove-resolution').value).toBe('4k');
    expect(document.getElementById('hstar-remove-ratio').value).toBe('source');
    expect(document.getElementById('hstar-remove-ratio').disabled).toBe(false);
    controller.destroy();
  });

  it('shows a bold green processing state while OCR is running', async () => {
    const pending = createDeferred();
    const {controller, aiClient} = createHarness();
    aiClient.pollTask.mockReturnValue(pending.promise);
    await controller.start();
    const extraction = controller.runTextExtraction();
    await vi.waitFor(() => expect(controller.getState().status).toBe('running'));

    const panel = document.getElementById('hstar-text-tools-panel');
    const status = panel.querySelector('.hstar-text-status');
    expect(status.textContent).toBe('模型正在处理');
    expect(panel.dataset.status).toBe('running');
    expect(document.getElementById('hstar-text-tools-style').textContent).toContain('font-weight:800');

    pending.resolve({
      taskId:'task-1',
      status:'succeeded',
      result:{width:1920, height:1080, blocks:[createOcrBlock()]},
    });
    await extraction;
    controller.destroy();
  });

  it('shows a bold green processing state while text removal is running', async () => {
    const pending = createDeferred();
    const {controller, aiClient} = createHarness();
    aiClient.pollTask.mockReturnValue(pending.promise);
    await controller.start();
    controller.openTool('text-remove');
    const removal = controller.runTextRemoval({mode:'layer'});
    await vi.waitFor(() => expect(controller.getState().status).toBe('running'));

    const panel = document.getElementById('hstar-text-tools-panel');
    const status = panel.querySelector('.hstar-text-status');
    expect(status.textContent).toBe('模型正在处理');
    expect(panel.dataset.status).toBe('running');
    expect(getComputedStyle(status).color).toBe('rgb(66, 217, 133)');
    expect(getComputedStyle(status).fontWeight).toBe('800');

    pending.resolve({
      taskId:'task-1',
      status:'succeeded',
      result:{assetId:OUTPUT_ASSET_ID, url:TRANSPARENT_PNG, width:1920, height:1080},
    });
    await removal;
    controller.destroy();
  });

  it('cache-busts both the OpenShop editor and text tools runtime', () => {
    const editorHtml = readFileSync(editorHtmlPath, 'utf8');
    const hostScript = readFileSync(hostScriptPath, 'utf8');
    const textToolsVersion = editorHtml.match(/openshop-text-tools\.js\?v=([0-9.]+)/)?.[1];
    const editorVersion = hostScript.match(/OPENSHOP_RUNTIME_REVISION\s*=\s*'([^']+)'/)?.[1]
      || hostScript.match(/openshop\/index\.html\?v=([0-9.]+)/)?.[1];
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
    const blocks = [upgradeBlockToV5({
      id:'ocr-fallback', text:'可识别文字', language:'zh', confidence:0.95, lowConfidence:false,
      quad:[{x:0.1,y:0.1},{x:0.4,y:0.1},{x:0.4,y:0.2},{x:0.1,y:0.2}],
      font:{familyCandidates:['Microsoft YaHei UI'], size:40, weight:400, style:'normal'},
      color:'#111111', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    })];
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

  it('rejects legacy OCR results before font loading or canvas mutation', async () => {
    const block = createOcrBlock({id:'ocr-v4'});
    const {controller, editor, fontManager, objects} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-v4', status:'succeeded',
        result:{schemaVersion:4, width:1920, height:1080, blocks:[block]},
      }},
    });
    await controller.start();
    await controller.runTextExtraction();
    const previousLayers = [...editor.layers];
    const previousObjects = [...objects];

    await expect(controller.applyTextExtraction()).rejects.toThrow('旧版识别结果，请重新执行文字提取');

    expect(fontManager.loadSystemFonts).not.toHaveBeenCalled();
    expect(editor.layers).toEqual(previousLayers);
    expect(objects).toEqual(previousObjects);
    expect(editor.canvas.add).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('rejects OCR source dimensions that differ from the current canvas', async () => {
    const block = createOcrBlock({id:'ocr-wrong-size'});
    const {controller, editor, fontManager} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-size', status:'succeeded',
        result:{schemaVersion:5, width:960, height:540, blocks:[block]},
      }},
    });
    await controller.start();
    await controller.runTextExtraction();

    await expect(controller.applyTextExtraction()).rejects.toThrow('识别图像尺寸与当前画板不一致');

    expect(fontManager.matchOcrRun).not.toHaveBeenCalled();
    expect(editor.canvas.add).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('creates one editable mixed-script object with independent Unicode run styles', async () => {
    const text = 'Open夏日';
    const block = {
      ...createOcrBlock({id:'ocr-mixed-runs', text}),
      language:'mixed', script:'mixed',
      runs:[
        {...createOcrBlock({text:'Open'}).runs[0], start:0, end:4, script:'en', size:48, weight:300, color:'#112233', letterSpacing:125},
        {...createOcrBlock({text:'夏日'}).runs[0], start:4, end:6, script:'zh-hans', size:52, weight:700, color:'#cc3300', letterSpacing:30},
      ],
    };
    const matchOcrRun = vi.fn(run => run.script === 'en'
      ? {family:'03免Poster', faceFamily:'03免Poster Light', styleId:'poster-light', weight:300, italic:false, fallback:false}
      : {family:'01免海报体', faceFamily:'01免海报体 Bold', styleId:'poster-bold', weight:700, italic:false, fallback:false});
    const {controller, editor, fontManager} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-mixed', status:'succeeded',
        result:{schemaVersion:5, width:1920, height:1080, blocks:[block]},
      }},
      fontManagerOverrides:{matchOcrRun},
    });
    await controller.start();
    await controller.runTextExtraction();

    const [layer] = await controller.applyTextExtraction();
    const object = layer.objects[0];

    expect(matchOcrRun).toHaveBeenCalledTimes(2);
    expect(object.text).toBe(text);
    expect(object.styles[0][0]).toMatchObject({fontFamily:'03免Poster Light', fontWeight:300, fill:'#112233'});
    expect(object.styles[0][3]).toMatchObject({fontFamily:'03免Poster Light', fontWeight:300});
    expect(object.styles[0][4]).toMatchObject({fontFamily:'01免海报体 Bold', fontWeight:700, fill:'#cc3300'});
    expect(object.styles[0][5]).toMatchObject({fontFamily:'01免海报体 Bold', fontWeight:700});
    expect(object.styles[0][0]).not.toHaveProperty('charSpacing');
    expect(object.styles[0][4]).not.toHaveProperty('charSpacing');
    expect(object).toMatchObject({hstarOcrSchemaVersion:5, charSpacing:0, scaleX:1, scaleY:1});
    expect(object).not.toHaveProperty('hstarOcrFontMetricQuad');
    expect(object).not.toHaveProperty('hstarOcrGlyphQuads');
    expect(fontManager.scanEditor).toHaveBeenCalledWith(editor);
    controller.destroy();
  });

  it('reconciles edited Unicode text and keeps creation repeatable', async () => {
    const original = 'Open夏日';
    const edited = 'OpenAI夏日';
    const block = {
      ...createOcrBlock({id:'ocr-edited-runs', text:original}),
      language:'mixed', script:'mixed',
      runs:[
        {...createOcrBlock({text:'Open'}).runs[0], start:0, end:4, script:'en'},
        {...createOcrBlock({text:'夏日'}).runs[0], start:4, end:6, script:'zh-hans', color:'#884400'},
      ],
    };
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-edited', status:'succeeded',
        result:{schemaVersion:5, width:1920, height:1080, blocks:[block]},
      }},
    });
    await controller.start();
    await controller.runTextExtraction();
    const reviewed = [{...block, text:edited}];

    const first = await controller.applyTextExtraction(reviewed);
    const second = await controller.applyTextExtraction(reviewed);

    expect(first[0].objects[0].styles[0][4].fontFamily).toBe('Arial');
    expect(first[0].objects[0].styles[0][5].fontFamily).toBe('Arial');
    expect(first[0].objects[0].styles[0][6].fontFamily).toBe('Microsoft YaHei UI');
    expect(first[0].objects[0].hstarOcrRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({start:0, end:6, script:'en'}),
      expect.objectContaining({start:6, end:8, script:'zh-hans'}),
    ]));
    expect(second[0]).not.toBe(first[0]);
    expect(editor.layers).toHaveLength(3);
    controller.destroy();
  });

  it('merges representable paragraph lines into one editable text layer', async () => {
    const blocks = [
      {...createOcrBlock({id:'line-1', text:'Line A'}), paragraphId:'paragraph-a', lineIndex:0,
        quad:[{x:0.1,y:0.1},{x:0.4,y:0.1},{x:0.4,y:0.16},{x:0.1,y:0.16}]},
      {...createOcrBlock({id:'line-2', text:'Line B'}), paragraphId:'paragraph-a', lineIndex:1,
        quad:[{x:0.1,y:0.18},{x:0.4,y:0.18},{x:0.4,y:0.24},{x:0.1,y:0.24}]},
    ];
    const ocrLayout = createFakeOcrLayoutRuntime();
    ocrLayout.paragraphPlan.mockReturnValue({
      merge:true, paragraphId:'paragraph-a', writingMode:'horizontal', rotation:0,
      interval:86.4, crossSize:64.8,
    });
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-paragraph', status:'succeeded',
        result:{schemaVersion:5, width:1920, height:1080, blocks},
      }},
      controllerOptions:{writingModeRuntime:createFakeWritingModeRuntime(), ocrLayout},
    });
    await controller.start();
    await controller.runTextExtraction();

    const layers = await controller.applyTextExtraction();

    expect(layers).toHaveLength(1);
    expect(layers[0].objects).toHaveLength(1);
    expect(layers[0].objects[0].text).toBe('Line A\nLine B');
    expect(editor.canvas.add).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('keeps fitted paragraph lines separate when their flow scales differ', async () => {
    const blocks = [
      {...createOcrBlock({id:'scaled-line-1', text:'Wide line'}), paragraphId:'scaled-paragraph', lineIndex:0},
      {...createOcrBlock({id:'scaled-line-2', text:'Narrow line'}), paragraphId:'scaled-paragraph', lineIndex:1},
    ];
    const ocrLayout = createFakeOcrLayoutRuntime();
    ocrLayout.fitLineObject
      .mockImplementationOnce(object => {
        object.set({left:100, top:100, scaleX:1.25, scaleY:1});
      })
      .mockImplementationOnce(object => {
        object.set({left:100, top:180, scaleX:0.8, scaleY:1});
      });
    ocrLayout.paragraphPlan.mockReturnValue({
      merge:true, paragraphId:'scaled-paragraph', writingMode:'horizontal', rotation:0,
      interval:80, crossSize:60,
    });
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-scaled-paragraph', status:'succeeded',
        result:{schemaVersion:5, width:1920, height:1080, blocks},
      }},
      controllerOptions:{writingModeRuntime:createFakeWritingModeRuntime(), ocrLayout},
    });
    await controller.start();
    await controller.runTextExtraction();

    const layers = await controller.applyTextExtraction();

    expect(layers).toHaveLength(2);
    expect(layers.map(layer => layer.objects[0].scaleX)).toEqual([1.25, 0.8]);
    expect(editor.canvas.add).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it('does not mutate canvas, layers, or history when any v5 line layout fails', async () => {
    const blocks = [
      {...createOcrBlock({id:'line-ok', text:'First'}), paragraphId:'p-1'},
      {...createOcrBlock({id:'line-fail', text:'Second'}), paragraphId:'p-2', lineIndex:1},
    ];
    const ocrLayout = createFakeOcrLayoutRuntime();
    ocrLayout.fitLineObject
      .mockImplementationOnce((object, geometry) => {
        object.set({left:geometry.left, top:geometry.top, scaleX:1, scaleY:1});
        return {visibleBox:{left:0, top:0, width:100, height:40}};
      })
      .mockImplementationOnce(() => { throw new Error('second line cannot be measured'); });
    const {controller, editor, objects} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-atomic', status:'succeeded',
        result:{schemaVersion:5, width:1920, height:1080, blocks},
      }},
      controllerOptions:{writingModeRuntime:createFakeWritingModeRuntime(), ocrLayout},
    });
    await controller.start();
    await controller.runTextExtraction();
    const previousLayers = [...editor.layers];
    const previousObjects = [...objects];

    await expect(controller.applyTextExtraction()).rejects.toThrow('second line cannot be measured');

    expect(editor.layers).toEqual(previousLayers);
    expect(objects).toEqual(previousObjects);
    expect(editor.canvas.add).not.toHaveBeenCalled();
    expect(editor.saveHistory).not.toHaveBeenCalledWith('文字提取');
    controller.destroy();
  });

  it('keeps OCR non-destructive until review is confirmed, then creates editable mixed-language text', async () => {
    const blocks = [upgradeBlockToV5({
      id:'ocr-1', text:'中文 English', language:'mixed', confidence:0.62, lowConfidence:true,
      quad:[{x:0.1,y:0.2},{x:0.5,y:0.2},{x:0.5,y:0.3},{x:0.1,y:0.3}],
      font:{familyCandidates:['Microsoft YaHei UI', 'Arial'], size:48, weight:600, style:'normal'},
      color:'#112233', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    })];
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
    expect(layers[0].objects[0].scaleX).toBe(1);
    expect(layers[0].objects[0].scaleY).toBe(1);
    expect(editor.layers).toHaveLength(2);
    const repeatedLayers = await controller.applyTextExtraction();
    expect(repeatedLayers).toHaveLength(1);
    expect(editor.layers).toHaveLength(3);
    expect(repeatedLayers[0]).not.toBe(layers[0]);
    expect(document.querySelector('[data-hstar-action="apply-extraction"]')?.disabled).toBe(false);
    expect(sourceLayer.objects).toContain(sourceImage);
    expect(editor.saveHistory).toHaveBeenCalledWith('文字提取');
    expect(controller.getState()).toMatchObject({status:'applied', reviewBlocks:blocks});
    expect(document.querySelector('[data-hstar-action="apply-extraction"]')?.disabled).toBe(false);
    expect(document.querySelector('.hstar-text-status').textContent).toBe('已创建新图层');
    expect(aiClient.createTask).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('localizes unreliable OCR position failures inside the extraction panel', async () => {
    const {controller} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-unreliable-position', status:'failed',
        error:'OCR model did not return reliable text positions',
      }},
    });
    await controller.start();

    const result = await controller.runTextExtraction();

    expect(result).toBeNull();
    expect(controller.getState()).toMatchObject({status:'failed'});
    expect(document.querySelector('.hstar-text-status').textContent)
      .toContain('OCR 模型没有返回可靠的文字位置，请重新执行文字提取');
    expect(document.getElementById('hstar-text-tools-panel').textContent)
      .not.toContain('OCR model did not return reliable text positions');
    controller.destroy();
  });

  it('preserves vertical column newlines while reviewing and editing OCR text', async () => {
    const block = {
      ...createOcrBlock({id:'ocr-columns', text:'甲乙\n丙'}),
      writingMode:'vertical',
      quad:[{x:0.1,y:0.1},{x:0.2,y:0.1},{x:0.2,y:0.6},{x:0.1,y:0.6}],
    };
    const {controller, editor:openShopEditor} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks:[block]},
      }},
    });
    await controller.start();
    await controller.runTextExtraction();

    const editor = document.querySelector('textarea[data-hstar-ocr-index="0"]');
    expect(editor).not.toBeNull();
    expect(editor.dataset.voiceInput).toBe('on');
    expect(editor.dataset.voiceLabel).toBe('识别文字 1');
    expect(editor.value).toBe('甲乙\n丙');

    editor.value = '甲乙\n丙丁';
    editor.dispatchEvent(new Event('input', {bubbles:true}));

    expect(controller.getState().reviewBlocks[0].text).toBe('甲乙\n丙丁');
    expect(openShopEditor.__hstarAiTaskRecords[0].reviewBlocks[0].text).toBe('甲乙\n丙丁');
    expect(openShopEditor.__hstarAiTaskRecords[0].result.blocks[0].text).toBe('甲乙\n丙');
    controller.destroy();
  });

  it.skip('legacy v4 integration fixture is replaced by schema v5 mixed-run and layout tests', async () => {
    const verticalText = ' 甲乙 \n丙 ';
    const blocks = [
      {
        id:'ocr-title', text:'经典奶茶', language:'zh', script:'zh-hans', confidence:0.98, lowConfidence:false,
        writingMode:'horizontal',
        quad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
        font:{
          artistic:true, familyCandidates:['Missing Font', 'Microsoft YaHei UI'], size:48,
          weight:700, style:'normal', styleDescription:'painted condensed title',
          letterSpacing:125, lineHeight:1.4, strokeColor:'#12345678', strokeWidth:3.5,
          shadow:{color:'#10203080', blur:6, offsetX:2, offsetY:-3},
        },
        color:'#7b3f12', align:'center', rotation:90, paragraphId:'title', lineIndex:0,
      },
      {
        id:'ocr-subtitle', text:verticalText, language:'zh', script:'zh-hans', confidence:0.94, lowConfidence:false,
        writingMode:'vertical',
        quad:[{x:0.55,y:0.25},{x:0.61,y:0.26},{x:0.56,y:0.66},{x:0.5,y:0.65}],
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
    const injectedWritingModeRuntime = createFakeWritingModeRuntime();
    const injectedOcrLayout = createFakeOcrLayoutRuntime();
    const {
      controller, editor, sourceLayer, sourceImage, objects, fontManager, writingModeRuntime, ocrLayout,
    } = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:960, height:540, blocks}}},
      fontManagerOverrides:{loadSystemFonts, matchOcrFont},
      controllerOptions:{
        writingModeRuntime:injectedWritingModeRuntime,
        ocrLayout:injectedOcrLayout,
      },
    });
    expect(writingModeRuntime).toBe(injectedWritingModeRuntime);
    expect(ocrLayout).toBe(injectedOcrLayout);
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
    expect(layers.map(layer => layer.name)).toEqual(['经典奶茶（校对）', '甲乙 丙']);
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
      hstarWritingMode:'horizontal',
      stroke:'#12345678', strokeWidth:7,
      hstarOcrBlockId:'ocr-title', hstarOcrSourceLayerId:'layer-source',
      hstarOcrSourceAssetId:SOURCE_ASSET_ID,
      hstarOcrFontCandidates:['Missing Font', 'Microsoft YaHei UI'],
      hstarOcrOriginalText:'经典奶茶', hstarArtFontRequestGeneration:0,
    });
    expect(title.initialOptions.charSpacing).toBe(125);
    expect(title.initialOptions.charSpacing).not.toBe(250);
    expect(title.charSpacing).toBe(title.initialOptions.charSpacing);
    const spacingMutationIndex = title.setHistory.findIndex(values => 'charSpacing' in values);
    const scaleMutationIndex = title.setHistory.findIndex(values => 'scaleX' in values || 'scaleY' in values);
    expect(spacingMutationIndex).toBe(-1);
    expect(scaleMutationIndex).toBeGreaterThanOrEqual(0);
    expect(title.shadow).toEqual(expect.objectContaining({color:'#10203080', blur:12, offsetX:4, offsetY:-6}));
    expect(title.shadow).toBeInstanceOf(FakeShadow);
    expect(title.scaleX).toBe(1);
    expect(title.scaleY).toBe(1);
    expect(title.hstarOcrQuad).toEqual(blocks[0].quad);
    expect(title.angle).toBe(90);
    expect(title.hstarOcrVisualProfile).toEqual({
      writingMode:'horizontal',
      script:'zh-hans', dominantScript:'', fill:'#7b3f12', alignment:'center', rotation:90,
      artistic:true, familyCandidates:['Missing Font', 'Microsoft YaHei UI'], size:48,
      weight:700, style:'normal', styleDescription:'painted condensed title',
      letterSpacing:125, lineHeight:1.4, strokeColor:'#12345678', strokeWidth:3.5,
      shadow:{color:'#10203080', blur:6, offsetX:2, offsetY:-3},
    });

    const subtitle = layers[1].objects[0];
    expect(subtitle).toBeInstanceOf(FakeVerticalText);
    expect(subtitle).toMatchObject({
      type:'hstar-vertical-text', text:verticalText, left:1056, top:270,
      fontFamily:'03免Subtitle Face', fontSize:44, fill:'#d77721', fontWeight:500,
      fontStyle:'normal', textAlign:'left', editable:true,
      hstarWritingMode:'vertical', charSpacing:20, lineHeight:1.16,
      stroke:'#00000000', strokeWidth:0,
      hstarOcrBlockId:'ocr-subtitle', hstarOcrSourceLayerId:'layer-source',
      hstarOcrSourceAssetId:SOURCE_ASSET_ID,
      hstarOcrFontCandidates:['Missing Font', 'Arial'],
      hstarOcrOriginalText:verticalText,
    });
    expect(subtitle.text.match(/\n/g)).toHaveLength(1);
    expect(subtitle.angle).toBeCloseTo(5.356, 2);
    expect(subtitle.scaleX).toBe(1);
    expect(subtitle.scaleY).toBe(1);
    expect(subtitle.shadow).toEqual(expect.objectContaining({
      color:'#00000000', blur:0, offsetX:0, offsetY:0,
    }));
    expect(subtitle).toMatchObject({
      hstarOcrQuad:blocks[1].quad,
      hstarOcrVisualProfile:{
        writingMode:'vertical',
        script:'zh-hans', dominantScript:'', fill:'#d77721', alignment:'left', rotation:2,
        artistic:false, familyCandidates:['Missing Font', 'Arial'], size:22, weight:400,
        style:'italic', styleDescription:'clean italic sans', letterSpacing:20, lineHeight:1.16,
        strokeColor:'#00000000', strokeWidth:0,
        shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0},
      },
    });
    expect(writingModeRuntime.createTextObject).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({IText:FakeIText, HstarVerticalText:FakeVerticalText}),
      '经典奶茶（校对）',
      expect.objectContaining({hstarWritingMode:'horizontal', angle:90}),
    );
    expect(writingModeRuntime.createTextObject).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({IText:FakeIText, HstarVerticalText:FakeVerticalText}),
      verticalText,
      expect.objectContaining({hstarWritingMode:'vertical'}),
    );
    expect(ocrLayout.fitTextObject).toHaveBeenNthCalledWith(
      1,
      title,
      expect.objectContaining({left:192, top:216, width:576, height:108}),
      expect.objectContaining({writingMode:'horizontal'}),
    );
    expect(ocrLayout.fitTextObject).toHaveBeenNthCalledWith(
      2,
      subtitle,
      expect.objectContaining({left:1056, top:270}),
      expect.objectContaining({writingMode:'vertical'}),
    );
    expect(editor.activeLayerIdx).toBe(2);
    expect(fontManager.scanEditor).toHaveBeenCalledWith(editor);
    controller.destroy();
  });

  it('fits real multi-column HstarVerticalText objects without changing OCR newlines', async () => {
    installFabricMock();
    delete window.HstarOpenShopWritingMode;
    await import(`${pathToFileURL(writingModePath).href}?integration=${Date.now()}-${Math.random()}`);
    const realWritingModeRuntime = window.HstarOpenShopWritingMode;
    const verticalText = '甲乙\n丙丁';
    const block = {
      id:'ocr-real-vertical', text:verticalText, language:'zh', script:'zh-hans',
      writingMode:'vertical', confidence:0.98, lowConfidence:false,
      quad:[{x:0.2,y:0.2},{x:0.32,y:0.2},{x:0.32,y:0.7},{x:0.2,y:0.7}],
      font:{
        familyCandidates:['Microsoft YaHei UI'], size:36, weight:700, style:'normal',
        letterSpacing:30, lineHeight:1.2, strokeColor:'#123456', strokeWidth:1,
        shadow:{color:'#00000080', blur:2, offsetX:1, offsetY:2},
      },
      color:'#445566', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    };
    const {controller} = createHarness({
      pollResults:{'text-extract':{
        taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks:[block]},
      }},
      controllerOptions:{writingModeRuntime:realWritingModeRuntime, fabricRef:globalThis.fabric},
    });
    await controller.start();
    await controller.runTextExtraction();

    const [layer] = await controller.applyTextExtraction();
    const object = layer.objects[0];

    expect(object).toBeInstanceOf(globalThis.fabric.HstarVerticalText);
    expect(object).toMatchObject({
      type:'hstar-vertical-text', hstarWritingMode:'vertical', text:verticalText,
      left:384, top:216, angle:0, fontFamily:'Microsoft YaHei UI', fontWeight:700,
      fill:'#445566', hstarOcrBlockId:'ocr-real-vertical',
      hstarOcrOriginalText:verticalText, hstarOcrQuad:block.quad,
    });
    expect(object._hstarVerticalLayout.columns).toEqual([['甲', '乙'], ['丙', '丁']]);
    expect(object.width).toBeGreaterThan(object.fontSize);
    expect(object.height).toBeGreaterThan(object.fontSize);
    expect(object.scaleX).toBeCloseTo(object.scaleY, 10);
    expect(object.width * object.scaleX).toBeLessThanOrEqual(230.401);
    expect(object.height * object.scaleY).toBeLessThanOrEqual(540.001);
    expect(object.hstarOcrVisualProfile).toMatchObject({writingMode:'vertical'});
    controller.destroy();
    realWritingModeRuntime.destroy();
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
    const matchOcrRun = vi.fn(run => {
      if(run.familyCandidates?.includes('Missing Face')) throw new Error('No free-commercial local font match');
      return {faceFamily:'03免Arial', weight:400, italic:false};
    });
    const {controller, editor, objects} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
      fontManagerOverrides:{matchOcrRun},
    });
    await controller.start();
    await controller.runTextExtraction();
    const originalLayers = [...editor.layers];
    const originalObjects = [...objects];

    await expect(controller.applyTextExtraction()).rejects.toThrow('No free-commercial local font match');

    expect(matchOcrRun).toHaveBeenCalledTimes(2);
    expect(editor.layers).toEqual(originalLayers);
    expect(objects).toEqual(originalObjects);
    expect(editor.canvas.add).not.toHaveBeenCalled();
    expect(editor.saveHistory).not.toHaveBeenCalledWith('文字提取');
    controller.destroy();
  });

  it('surfaces review-button font preflight failures without an unhandled async apply', async () => {
    const blocks = [upgradeBlockToV5({
      id:'ocr-missing-click', text:'Missing', script:'en', confidence:0.9,
      quad:[{x:0.1,y:0.1},{x:0.3,y:0.1},{x:0.3,y:0.2},{x:0.1,y:0.2}],
      font:{familyCandidates:['Missing Face'], size:32, weight:400, style:'normal'}, color:'#112233',
    })];
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
      fontManagerOverrides:{matchOcrRun:vi.fn(() => { throw new Error('No local OCR face'); })},
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
      result:{schemaVersion:5, width:1920, height:1080, blocks:newBlocks},
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
    const matchOcrRun = vi.fn(() => { throw new Error('Deferred font match failed'); });
    const {controller, editor} = createHarness({
      pollResults:{'text-extract':{taskId:'task-1', status:'succeeded', result:{width:1920, height:1080, blocks}}},
      fontManagerOverrides:{loadSystemFonts:vi.fn(() => fontLoad.promise), matchOcrRun},
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
    expect(matchOcrRun).toHaveBeenCalledOnce();
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

  it('removes all text from only the selected image layer and inserts the result directly above it', async () => {
    const output = {
      assetId:OUTPUT_ASSET_ID,
      url:`/api/openshop/assets/${OUTPUT_ASSET_ID}`,
      name:'removed.png', width:1920, height:1080, mime:'image/png',
    };
    const {controller, editor, sourceLayer, sourceImage, aiClient, assetApi, createdTasks} = createHarness({
      pollResults:{'text-remove':{taskId:'task-1', status:'succeeded', result:output}},
    });
    await controller.start();
    controller.openTool('text-remove');
    const resolution = document.getElementById('hstar-remove-resolution');
    expect([...resolution.options].map(option => [option.value, option.textContent])).toEqual([
      ['auto', '自动'], ['1k', '1K'], ['2k', '2K'], ['4k', '4K'],
    ]);
    expect(resolution.value).toBe('4k');
    expect(document.getElementById('hstar-remove-ratio').disabled).toBe(false);
    editor._selectionBounds = {x:100, y:80, w:500, h:200};
    resolution.value = '4k';
    resolution.dispatchEvent(new Event('change', {bubbles:true}));
    const ratio = document.getElementById('hstar-remove-ratio');
    expect([...ratio.options].map(option => [option.value, option.textContent])).toEqual([
      ['source', '适配原图'], ['square', '1:1'], ['portrait', '2:3'], ['landscape', '3:2'],
      ['portrait43', '3:4'], ['landscape43', '4:3'], ['story', '9:16'], ['wide', '16:9'],
      ['ultrawide', '21:9'], ['ultratall', '9:21'],
    ]);
    expect(ratio.disabled).toBe(false);
    ratio.value = 'square';
    ratio.dispatchEvent(new Event('change', {bubbles:true}));
    const quality = document.getElementById('hstar-remove-quality');
    quality.value = 'high';
    quality.dispatchEvent(new Event('change', {bubbles:true}));
    const prompt = document.getElementById('hstar-remove-prompt');
    expect(prompt.dataset.voiceInput).toBe('on');
    expect(prompt.dataset.voiceLabel).toBe('去除文字补充要求');
    prompt.value = '保留纸张纹理';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('[data-hstar-action="run-removal"]').click();
    await vi.waitFor(() => expect(editor.layers).toHaveLength(2));
    const layer = editor.layers[1];

    expect(layer.name).toBe('去除文字');
    expect(layer.objects[0]).toMatchObject({
      type:'image', hstarAssetId:OUTPUT_ASSET_ID, hstarAssetRole:'ai-output', left:0, top:0,
    });
    expect(editor.layers).toHaveLength(2);
    expect(editor.layers[0]).toBe(sourceLayer);
    expect(editor.layers[1]).toBe(layer);
    expect(editor.activeLayerIdx).toBe(1);
    expect(sourceLayer.objects).toContain(sourceImage);
    expect(createdTasks[0]).toMatchObject({
      toolId:'text-remove', apiConfigId:'image-api', modelId:'gemini-3-pro-image', mode:'layer',
      sourceLayerId:sourceLayer.layerId, sourceAssetId:SOURCE_ASSET_ID, maskAssetId:'',
      options:{resolution:'4k', ratio:'square', quality:'high', prompt:'保留纸张纹理'},
    });
    expect(assetApi.upload).toHaveBeenCalledTimes(1);
    expect(assetApi.upload).toHaveBeenCalledWith(expect.objectContaining({role:'ai-source'}));
    expect(createdTasks.some(task => task.toolId === 'text-extract')).toBe(false);
    expect(aiClient.createTask).toHaveBeenCalledTimes(1);
    controller.destroy();
  });

  it('centers a changed-aspect removal result without stretching it', async () => {
    const {controller, editor} = createHarness();
    await controller.start();

    const layer = await controller.createRemovedImageLayer({
      assetId:OUTPUT_ASSET_ID, url:TRANSPARENT_PNG, name:'square.png', width:1024, height:1024,
    });
    const image = layer.objects[0];

    expect(image.scaleX).toBeCloseTo(1.0546875);
    expect(image.scaleY).toBeCloseTo(1.0546875);
    expect(image.left).toBeCloseTo(420);
    expect(image.top).toBe(0);
    expect(editor.layers.at(-1)).toBe(layer);
    controller.destroy();
  });

  it('keeps a removal image below existing text layers in the canvas object stack', async () => {
    const {controller, editor, sourceLayer, sourceImage, objects} = createHarness();
    const firstText = new FakeIText('小暑', {hstarLayerId:'text-layer-first'});
    const secondText = new FakeIText('节气', {hstarLayerId:'text-layer-second'});
    const firstTextLayer = {
      layerId:'text-layer-first', name:'小暑', visible:true, opacity:100,
      blend:'source-over', objects:[firstText],
    };
    const secondTextLayer = {
      layerId:'text-layer-second', name:'节气', visible:true, opacity:100,
      blend:'source-over', objects:[secondText],
    };
    editor.layers.push(firstTextLayer, secondTextLayer);
    objects.push(firstText, secondText);
    await controller.start();

    const layer = await controller.createRemovedImageLayer({
      assetId:OUTPUT_ASSET_ID, url:TRANSPARENT_PNG, name:'removed.png', width:1920, height:1080,
    }, {
      toolId:'text-remove', status:'succeeded', sourceLayerId:sourceLayer.layerId,
      appliedAt:0, updatedAt:0,
    });

    expect(editor.layers).toEqual([sourceLayer, layer, firstTextLayer, secondTextLayer]);
    expect(objects).toEqual([sourceImage, layer.objects[0], firstText, secondText]);
    controller.destroy();
  });

  it('repairs a persisted removal-image stack when the project is loaded', async () => {
    const {controller, editor, sourceImage, objects} = createHarness();
    const removalImage = {type:'image', hstarLayerId:'remove-layer'};
    const text = new FakeIText('小暑', {hstarLayerId:'text-layer'});
    const removalLayer = {
      layerId:'remove-layer', name:'去除文字', visible:true, opacity:100,
      blend:'source-over', objects:[removalImage],
    };
    const textLayer = {
      layerId:'text-layer', name:'小暑', visible:true, opacity:100,
      blend:'source-over', objects:[text],
    };
    editor.layers.push(removalLayer, textLayer);
    objects.push(text, removalImage);
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {
      detail:{project:{projectId:'project-1'}},
    }));

    expect(objects).toEqual([sourceImage, removalImage, text]);
    controller.destroy();
  });

  it('does not fall back to another image layer when the selected layer has no image', async () => {
    const output = {assetId:OUTPUT_ASSET_ID, url:`/api/openshop/assets/${OUTPUT_ASSET_ID}`, name:'removed.png', width:1920, height:1080};
    const {controller, editor, assetApi, aiClient, createdTasks} = createHarness({
      pollResults:{'text-remove':{taskId:'task-1', status:'succeeded', result:output}},
    });
    editor.layers.unshift({
      layerId:'layer-empty', name:'当前空图层', visible:true, opacity:100,
      blend:'source-over', objects:[],
    });
    editor.activeLayerIdx = 0;
    await controller.start();
    const result = await controller.runTextRemoval();

    expect(result).toBeNull();
    expect(controller.getState()).toMatchObject({
      status:'failed', error:'请先选择一个包含图片的像素图层',
    });
    expect(assetApi.upload).not.toHaveBeenCalled();
    expect(aiClient.createTask).not.toHaveBeenCalled();
    expect(createdTasks).toEqual([]);
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

  it('restores legacy OCR results for review but requires a new extraction before apply', async () => {
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

    await expect(controller.applyTextExtraction()).rejects.toThrow('旧版识别结果，请重新执行文字提取');
    expect(editor.__hstarAiTaskRecords[0].appliedAt).toBe(0);
    controller.destroy();
  });

  it('restores the last applied OCR review until the next extraction run', async () => {
    const blocks = [createOcrBlock({id:'ocr-applied-restored', text:'已转图层的文字'})];
    const {controller, editor} = createHarness();
    editor.__hstarAiTaskRecords = [{
      taskId:'task-applied-restored', toolId:'text-extract', status:'succeeded',
      apiConfigId:'vision-api', modelId:'gemini-3.1-pro-high', mode:'layer',
      sourceAssetId:SOURCE_ASSET_ID, maskAssetId:'', outputAssetId:'',
      createdAt:1, updatedAt:2, completedAt:2, appliedAt:3, error:'',
      result:{schemaVersion:3, width:1920, height:1080, blocks},
    }];
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-1'}}}));
    await vi.waitFor(() => expect(controller.getState().status).toBe('applied'));

    expect(controller.getState()).toMatchObject({activeTool:'text-extract', reviewBlocks:blocks});
    expect(document.querySelector('[data-hstar-action="apply-extraction"]')?.disabled).toBe(true);
    controller.destroy();
  });

  it('keeps the OCR reported size while fitting vertical glyphs without transform scaling', async () => {
    const block = {
      id:'ocr-vertical-size', text:'甲乙丙丁', language:'zh', script:'zh-hans',
      confidence:0.98, lowConfidence:false, writingMode:'vertical',
      quad:[{x:0.2,y:0.2},{x:0.26,y:0.2},{x:0.26,y:0.62},{x:0.2,y:0.62}],
      font:{familyCandidates:['Microsoft YaHei UI'], size:48, weight:600, style:'normal',
        letterSpacing:0, lineHeight:1.1, strokeColor:'#00000000', strokeWidth:0,
        shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0}},
      color:'#123456', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    };
    const injectedWritingModeRuntime = createFakeWritingModeRuntime();
    const injectedOcrLayout = createFakeOcrLayoutRuntime();
    const {controller, fontManager} = createHarness({
      pollResults:{'text-extract':{taskId:'task-vertical-size', status:'succeeded', result:{width:1920, height:1080, blocks:[block]}}},
      controllerOptions:{writingModeRuntime:injectedWritingModeRuntime, ocrLayout:injectedOcrLayout},
    });
    fontManager.matchOcrRun = vi.fn(() => ({family:'01免测试', faceFamily:'Microsoft YaHei UI', weight:600, italic:false}));
    await controller.start();
    await controller.runTextExtraction();
    const [layer] = await controller.applyTextExtraction();
    const object = layer.objects[0];

    expect(object.fontSize).toBe(48);
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expect(injectedOcrLayout.fitLineObject).toHaveBeenCalledWith(
      object,
      expect.objectContaining({left:384, top:216, height:453.6}),
      expect.objectContaining({writingMode:'vertical'}),
    );
    expect(injectedOcrLayout.fitLineObject.mock.calls[0][1].width).toBeCloseTo(115.2, 8);
    controller.destroy();
  });

  it.skip('schema v4 fontMetricQuad fitting is intentionally removed', async () => {
    const block = {
      id:'ocr-vertical-punctuation', text:'微风不燥，', language:'zh', script:'zh-hans',
      confidence:0.98, lowConfidence:false, writingMode:'vertical',
      quad:[{x:0.2,y:0.2},{x:0.26,y:0.2},{x:0.26,y:0.62},{x:0.2,y:0.62}],
      fontMetricQuad:[{x:0.205,y:0.2},{x:0.255,y:0.2},{x:0.255,y:0.53},{x:0.205,y:0.53}],
      font:{familyCandidates:['Microsoft YaHei UI'], size:48, weight:600, style:'normal',
        letterSpacing:0, lineHeight:1.1, strokeColor:'#00000000', strokeWidth:0,
        shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0}},
      color:'#123456', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    };
    const injectedWritingModeRuntime = createFakeWritingModeRuntime();
    const injectedOcrLayout = createFakeOcrLayoutRuntime();
    const {controller, fontManager} = createHarness({
      pollResults:{'text-extract':{taskId:'task-vertical-punctuation', status:'succeeded', result:{width:1920, height:1080, blocks:[block]}}},
      controllerOptions:{writingModeRuntime:injectedWritingModeRuntime, ocrLayout:injectedOcrLayout},
    });
    fontManager.matchOcrFont = vi.fn(() => ({faceFamily:'Microsoft YaHei UI', weight:600, italic:false}));
    await controller.start();
    await controller.runTextExtraction();
    await controller.applyTextExtraction();

    const [, geometry, options] = injectedOcrLayout.fitTextObject.mock.calls[0];
    expect(geometry).toMatchObject({left:384, top:216, height:453.6});
    expect(geometry.width).toBeCloseTo(115.2, 8);
    expect(options).toMatchObject({writingMode:'vertical', metricText:'微风不燥'});
    expect(options.metricGeometry).toMatchObject({top:216, height:356.4});
    expect(options.metricGeometry.left).toBeCloseTo(393.6, 8);
    expect(options.metricGeometry.width).toBeCloseTo(96, 8);
    controller.destroy();
  });

  it.skip('schema v4 glyphQuads fitting is intentionally removed', async () => {
    const block = {
      id:'ocr-glyph-positions', text:'微风，', language:'zh', script:'zh-hans',
      confidence:0.98, lowConfidence:false, writingMode:'vertical',
      quad:[{x:0.2,y:0.2},{x:0.26,y:0.2},{x:0.26,y:0.62},{x:0.2,y:0.62}],
      glyphQuads:[
        {charIndex:0, text:'微', role:'primary', quad:[{x:0.205,y:0.2},{x:0.255,y:0.2},{x:0.255,y:0.28},{x:0.205,y:0.28}]},
        {charIndex:1, text:'风', role:'primary', quad:[{x:0.205,y:0.34},{x:0.255,y:0.34},{x:0.255,y:0.42},{x:0.205,y:0.42}]},
        {charIndex:2, text:'，', role:'punctuation', quad:[{x:0.235,y:0.58},{x:0.25,y:0.58},{x:0.25,y:0.61},{x:0.235,y:0.61}]},
      ],
      font:{familyCandidates:['Microsoft YaHei UI'], size:48, weight:600, style:'normal',
        letterSpacing:0, lineHeight:1.1, strokeColor:'#00000000', strokeWidth:0,
        shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0}},
      color:'#123456', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    };
    const injectedOcrLayout = createFakeOcrLayoutRuntime();
    const {controller, fontManager} = createHarness({
      pollResults:{'text-extract':{taskId:'task-glyph-positions', status:'succeeded', result:{width:1920, height:1080, blocks:[block]}}},
      controllerOptions:{writingModeRuntime:createFakeWritingModeRuntime(), ocrLayout:injectedOcrLayout},
    });
    fontManager.matchOcrFont = vi.fn(() => ({faceFamily:'Microsoft YaHei UI', weight:600, italic:false}));
    await controller.start();
    await controller.runTextExtraction();
    const [layer] = await controller.applyTextExtraction();

    const object = layer.objects[0];
    const options = injectedOcrLayout.fitTextObject.mock.calls[0][2];
    expect(options).toMatchObject({metricText:'微风'});
    expect(options.metricGeometry.top).toBe(216);
    expect(options.metricGeometry.left).toBeCloseTo(393.6, 8);
    expect(options.metricGeometry.width).toBeCloseTo(96, 8);
    expect(options.metricGeometry.height).toBeCloseTo(237.6, 8);
    expect(object.hstarOcrGlyphQuads).toEqual(block.glyphQuads);
    controller.destroy();
  });

  it.skip('schema v4 punctuation metric fitting is intentionally removed', async () => {
    const block = {
      id:'ocr-legacy-punctuation', text:'微风不燥，', language:'zh', script:'zh-hans',
      confidence:0.98, lowConfidence:false, writingMode:'vertical',
      quad:[{x:0.2,y:0.2},{x:0.26,y:0.2},{x:0.26,y:0.62},{x:0.2,y:0.62}],
      font:{familyCandidates:['Microsoft YaHei UI'], size:48, weight:600, style:'normal',
        letterSpacing:0, lineHeight:1.1, strokeColor:'#00000000', strokeWidth:0,
        shadow:{color:'#00000000', blur:0, offsetX:0, offsetY:0}},
      color:'#123456', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    };
    const injectedOcrLayout = createFakeOcrLayoutRuntime();
    const {controller, fontManager} = createHarness({
      pollResults:{'text-extract':{taskId:'task-legacy-punctuation', status:'succeeded', result:{width:1920, height:1080, blocks:[block]}}},
      controllerOptions:{writingModeRuntime:createFakeWritingModeRuntime(), ocrLayout:injectedOcrLayout},
    });
    fontManager.matchOcrFont = vi.fn(() => ({faceFamily:'Microsoft YaHei UI', weight:600, italic:false}));
    await controller.start();
    await controller.runTextExtraction();
    await controller.applyTextExtraction();

    const options = injectedOcrLayout.fitTextObject.mock.calls[0][2];
    expect(options.metricText).toBe('微风不燥');
    expect(options.metricGeometry.top).toBe(216);
    expect(options.metricGeometry.height).toBeCloseTo(432, 8);
    controller.destroy();
  });

  it('leaves persisted legacy OCR text unchanged when a project is reopened', async () => {
    const injectedOcrLayout = createFakeOcrLayoutRuntime();
    const {controller, editor, runtime} = createHarness({
      controllerOptions:{ocrLayout:injectedOcrLayout},
    });
    const legacy = new FakeVerticalText('AB', {
      fontSize:120,
      lineHeight:1.16,
      charSpacing:-1000,
      scaleX:1,
      scaleY:1,
      hstarWritingMode:'vertical',
      hstarOcrBlockId:'legacy-vertical',
      hstarOcrQuad:[{x:0.1,y:0.2},{x:0.2,y:0.2},{x:0.2,y:0.5},{x:0.1,y:0.5}],
      hstarOcrVisualProfile:{writingMode:'vertical', rotation:0},
    });
    editor.layers.push({
      layerId:'legacy-text-layer', name:'Legacy OCR', visible:true, opacity:100,
      blend:'source-over', objects:[legacy],
    });
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded'));
    await Promise.resolve();

    expect(injectedOcrLayout.fitLineObject).not.toHaveBeenCalled();
    expect(legacy.charSpacing).toBe(-1000);
    expect(legacy.hstarOcrLayoutVersion).toBeUndefined();
    expect(runtime.requestSave).not.toHaveBeenCalledWith({reason:'ocr-layout-migrated'});
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

  it('persists a provisional identity before POST, then applies one exact correlated raster', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, runtime, imageLoader} = harness;
    const {layer:carrierLayer, object:carrier} = addArtCarrier(harness);
    const provisionalSave = createDeferred();
    runtime.requestSave
      .mockImplementationOnce(() => provisionalSave.promise)
      .mockResolvedValue({saved:true});
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-1', status:'succeeded', outputAssetId:OUTPUT_ASSET_ID, result:artResult(),
    });
    imageLoader.mockResolvedValue({
      type:'image', width:360, height:120, set(values){ Object.assign(this, values); },
    });
    await controller.start();

    const restoring = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(runtime.requestSave).toHaveBeenCalledTimes(1));

    expect(carrier.hstarArtFontRequestGeneration).toBe(1);
    expect(runtime.requestSave).toHaveBeenNthCalledWith(1, {reason:'art-font-provisional'});
    expect(aiClient.createTask).not.toHaveBeenCalled();
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:expect.stringMatching(/^provisional:/), clientRequestId:expect.any(String),
      creationState:'provisional', toolId:'art-font-restore', status:'queued', reconcileState:'pending',
      sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID,
      snapshot:{textLayerId:'text-layer-1', currentText:'Edited title', requestGeneration:1},
    });
    const clientRequestId = editor.__hstarAiTaskRecords[0].clientRequestId;

    provisionalSave.resolve({saved:true});
    await vi.waitFor(() => expect(aiClient.createTask).toHaveBeenCalledTimes(1));
    expect(aiClient.createTask.mock.calls[0][1]).toMatchObject({
      toolId:'art-font-restore', sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID,
      clientRequestId,
      options:{artFont:{
        textLayerId:'text-layer-1', ocrBlockId:'ocr-title', originalText:'Original title',
        currentText:'Edited title', requestGeneration:1,
        document:{width:1920, height:1080}, quad:carrier.hstarOcrQuad,
        visualProfile:carrier.hstarOcrVisualProfile,
      }},
    });
    await restoring;

    expect(aiClient.pollTask).toHaveBeenCalledWith(context, 'task-1', expect.any(Object));
    expect(editor.layers).toHaveLength(3);
    expect(editor.layers[1]).toBe(carrierLayer);
    const generated = editor.layers[2];
    expect(generated.hstarAiGeneration).toEqual({
      taskId:'task-1', textLayerId:'text-layer-1', requestGeneration:1, outputAssetId:OUTPUT_ASSET_ID,
      toolId:'art-font-restore', placementBox:{x:180, y:200, width:360, height:120},
    });
    expect(generated.objects[0].hstarAiGeneration).toEqual(generated.hstarAiGeneration);
    expect(generated.objects[0]).toMatchObject({
      left:180, top:200, angle:0, scaleX:1, scaleY:1,
    });
    expect(carrierLayer.visible).toBe(false);
    expect(carrier.visible).toBe(false);
    expect(editor.saveHistory).toHaveBeenCalledOnce();
    expect(editor.saveHistory).toHaveBeenCalledWith('艺术字体处理');
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:'task-1', clientRequestId, creationState:'created',
      status:'succeeded', reconcileState:'applied', outputAssetId:OUTPUT_ASSET_ID,
      generatedLayerId:generated.layerId,
    });

    await controller.restorePendingArtTasks();
    expect(editor.layers).toHaveLength(3);
    expect(editor.saveHistory).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('creates an artistic-font task from a vertical carrier without losing writing mode', async () => {
    const harness = createHarness();
    const {controller, aiClient, editor} = harness;
    const {object} = addArtCarrier(harness, {
      layerId:'vertical-text-layer', blockId:'ocr-vertical', text:'甲乙\n丙丁', writingMode:'vertical',
    });
    await controller.start();

    await controller.restoreArtFont('vertical-text-layer');

    expect(object).toBeInstanceOf(FakeVerticalText);
    expect(aiClient.createTask).toHaveBeenCalledWith(context, expect.objectContaining({
      toolId:'art-font-restore',
      options:{artFont:expect.objectContaining({
        textLayerId:'vertical-text-layer', currentText:'甲乙\n丙丁',
        visualProfile:expect.objectContaining({writingMode:'vertical'}),
      })},
    }));
    expect(editor.__hstarAiTaskRecords.at(-1).snapshot.visualProfile.writingMode).toBe('vertical');
    controller.destroy();
  });

  it('retries one failed provisional save with the same identity before issuing one POST', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, runtime} = harness;
    const carrier = addArtCarrier(harness);
    let provisionalSaveAttempts = 0;
    runtime.requestSave.mockImplementation(({reason}) => {
      if(reason === 'art-font-provisional' && ++provisionalSaveAttempts === 1){
        return Promise.reject(new Error('provisional storage unavailable'));
      }
      return Promise.resolve({saved:true});
    });
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-after-save-retry', status:'succeeded', result:artResult(),
    });
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    expect(aiClient.createTask).not.toHaveBeenCalled();
    expect(editor.__hstarAiTaskRecords).toHaveLength(1);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:expect.stringMatching(/^provisional:/), creationState:'provisional',
      provisionalSaveState:'failed', error:'provisional storage unavailable',
      snapshot:{textLayerId:'text-layer-1', requestGeneration:1},
    });
    const clientRequestId = editor.__hstarAiTaskRecords[0].clientRequestId;

    await controller.restoreArtFont('text-layer-1');

    expect(provisionalSaveAttempts).toBe(2);
    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(aiClient.createTask.mock.calls[0][1].clientRequestId).toBe(clientRequestId);
    expect(editor.__hstarAiTaskRecords).toHaveLength(1);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:'task-1', clientRequestId, creationState:'created',
      snapshot:{textLayerId:'text-layer-1', requestGeneration:1},
    });
    expect(carrier.object.hstarArtFontRequestGeneration).toBe(1);
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

  it('keeps a restored running layer busy while another layer runs independently', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient} = harness;
    const firstCarrier = addArtCarrier(harness, {layerId:'text-layer-a', blockId:'ocr-a', text:'Alpha'});
    addArtCarrier(harness, {layerId:'text-layer-b', blockId:'ocr-b', text:'Beta'});
    firstCarrier.object.hstarArtFontRequestGeneration = 1;
    editor.__hstarAiTaskRecords = [{
      ...provisionalArtRecord({layerId:'text-layer-a', blockId:'ocr-a', text:'Alpha'}),
      taskId:'task-restored-a', creationState:'created', status:'running',
    }];
    const polls = new Map();
    aiClient.pollTask.mockImplementation((_context, taskId) => {
      const deferred = createDeferred();
      polls.set(taskId, deferred);
      return deferred.promise;
    });
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded'));
    await vi.waitFor(() => expect(polls.has('task-restored-a')).toBe(true));
    expect(controller.isArtFontBusy('text-layer-a')).toBe(true);
    expect(controller.isArtFontBusy('text-layer-b')).toBe(false);

    const sameLayer = controller.restoreArtFont('text-layer-a');
    const otherLayer = controller.restoreArtFont('text-layer-b');
    await vi.waitFor(() => expect(aiClient.pollTask).toHaveBeenCalledTimes(2));

    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(controller.isArtFontBusy('text-layer-a')).toBe(true);
    expect(controller.isArtFontBusy('text-layer-b')).toBe(true);
    polls.get('task-restored-a').resolve({
      taskId:'task-restored-a', status:'succeeded', result:artResult({assetId:'d'.repeat(64)}),
    });
    polls.get('task-1').resolve({
      taskId:'task-1', status:'succeeded', result:artResult({assetId:'e'.repeat(64)}),
    });
    await Promise.all([sameLayer, otherLayer]);

    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(2);
    expect(controller.isArtFontBusy('text-layer-a')).toBe(false);
    expect(controller.isArtFontBusy('text-layer-b')).toBe(false);
    controller.destroy();
  });

  it('retries transient poll errors with bounded backoff and applies after recovery', async () => {
    const retryWait = vi.fn(async () => {});
    const harness = createHarness({controllerOptions:{artPollMaxAttempts:3, artPollRetryWait:retryWait}});
    const {controller, editor, aiClient} = harness;
    addArtCarrier(harness);
    aiClient.pollTask
      .mockRejectedValueOnce(new TypeError('network unavailable'))
      .mockRejectedValueOnce(httpError(503, 'provider unavailable'))
      .mockResolvedValueOnce({taskId:'task-1', status:'succeeded', result:artResult()});
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    expect(aiClient.pollTask).toHaveBeenCalledTimes(3);
    expect(retryWait).toHaveBeenCalledTimes(2);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'succeeded', reconcileState:'applied', error:'',
    });
    controller.destroy();
  });

  it('keeps a task pending after bounded poll exhaustion and resumes the same task manually', async () => {
    const retryWait = vi.fn(async () => {});
    const harness = createHarness({controllerOptions:{artPollMaxAttempts:3, artPollRetryWait:retryWait}});
    const {controller, editor, aiClient} = harness;
    const carrier = addArtCarrier(harness);
    aiClient.pollTask
      .mockRejectedValueOnce(new TypeError('network attempt 1'))
      .mockRejectedValueOnce(new TypeError('network attempt 2'))
      .mockRejectedValueOnce(httpError(502, 'network attempt 3'))
      .mockResolvedValueOnce({taskId:'task-1', status:'succeeded', result:artResult()});
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    const pending = editor.__hstarAiTaskRecords[0];
    expect(aiClient.pollTask).toHaveBeenCalledTimes(3);
    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(pending).toMatchObject({
      taskId:'task-1', status:'queued', reconcileState:'pending', error:'network attempt 3',
    });
    expect(controller.isArtFontBusy('text-layer-1')).toBe(false);

    await controller.restoreArtFont('text-layer-1');

    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(aiClient.pollTask).toHaveBeenCalledTimes(4);
    expect(editor.__hstarAiTaskRecords).toHaveLength(1);
    expect(editor.__hstarAiTaskRecords[0]).toBe(pending);
    expect(pending.reconcileState).toBe('applied');
    expect(carrier.object.hstarArtFontRequestGeneration).toBe(1);
    controller.destroy();
  });

  it('recreates a missing backend task with the same client request identity after 404', async () => {
    const harness = createHarness({controllerOptions:{artPollRetryWait:vi.fn(async () => {})}});
    const {controller, editor, aiClient} = harness;
    addArtCarrier(harness);
    aiClient.createTask
      .mockResolvedValueOnce({task_id:'task-lost', status:'queued'})
      .mockResolvedValueOnce({task_id:'task-recreated', status:'queued'});
    aiClient.pollTask
      .mockRejectedValueOnce(httpError(404, 'task registry entry missing'))
      .mockResolvedValueOnce({taskId:'task-recreated', status:'succeeded', result:artResult()});
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    expect(aiClient.createTask).toHaveBeenCalledTimes(2);
    expect(aiClient.createTask.mock.calls[1][1].clientRequestId)
      .toBe(aiClient.createTask.mock.calls[0][1].clientRequestId);
    expect(editor.__hstarAiTaskRecords).toHaveLength(1);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:'task-recreated', status:'succeeded', reconcileState:'applied',
    });
    controller.destroy();
  });

  it('continues when idempotent 404 recovery returns the same backend task identity', async () => {
    const harness = createHarness({controllerOptions:{artPollRetryWait:vi.fn(async () => {})}});
    const {controller, editor, aiClient} = harness;
    addArtCarrier(harness);
    aiClient.createTask.mockResolvedValue({task_id:'task-same', status:'queued'});
    aiClient.pollTask
      .mockRejectedValueOnce(httpError(404, 'transient registry lookup miss'))
      .mockResolvedValueOnce({taskId:'task-same', status:'succeeded', result:artResult()});
    await controller.start();

    const restoring = controller.restoreArtFont('text-layer-1');
    const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('404 recovery deadlocked')), 100));
    await expect(Promise.race([restoring, timeout])).resolves.toMatchObject({reconcileState:'applied'});

    expect(aiClient.createTask).toHaveBeenCalledTimes(2);
    expect(aiClient.pollTask).toHaveBeenCalledTimes(2);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:'task-same', status:'succeeded', reconcileState:'applied',
    });
    controller.destroy();
  });

  it('terminals authentication poll errors without automatic retry', async () => {
    const retryWait = vi.fn(async () => {});
    const harness = createHarness({controllerOptions:{artPollMaxAttempts:3, artPollRetryWait:retryWait}});
    const {controller, editor, aiClient} = harness;
    const carrier = addArtCarrier(harness);
    aiClient.pollTask.mockRejectedValue(httpError(401, 'API authentication expired'));
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    expect(aiClient.pollTask).toHaveBeenCalledOnce();
    expect(retryWait).not.toHaveBeenCalled();
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      status:'failed', reconcileState:'discarded', reconcileReason:'poll-auth-error',
      error:'API authentication expired',
    });
    expect(carrier.layer.visible).toBe(true);
    expect(carrier.object.visible).toBe(true);
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
        ...artResult(), placementBox:{x:180, y:200, width:400, height:120},
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

  it('keeps a previously hidden carrier hidden when decode fails before mutation', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, imageLoader} = harness;
    const carrier = addArtCarrier(harness);
    carrier.layer.visible = false;
    carrier.object.visible = false;
    aiClient.pollTask.mockResolvedValue({taskId:'task-1', status:'succeeded', result:artResult()});
    imageLoader.mockRejectedValue(new Error('PNG decode failed'));
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    expect(carrier.layer.visible).toBe(false);
    expect(carrier.object.visible).toBe(false);
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      reconcileState:'discarded', reconcileReason:'apply-failed',
    });
    controller.destroy();
  });

  it('restores exact mixed carrier visibility after a failure following hide mutation', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, objects} = harness;
    const carrier = addArtCarrier(harness);
    const hiddenCompanion = {type:'image', visible:false, hstarLayerId:'text-layer-1'};
    carrier.layer.objects.push(hiddenCompanion);
    objects.push(hiddenCompanion);
    aiClient.pollTask.mockResolvedValue({taskId:'task-1', status:'succeeded', result:artResult()});
    editor.canvas.setActiveObject.mockImplementation(() => { throw new Error('selection failed after hide'); });
    await controller.start();

    await controller.restoreArtFont('text-layer-1');

    expect(carrier.layer.visible).toBe(true);
    expect(carrier.object.visible).toBe(true);
    expect(hiddenCompanion.visible).toBe(false);
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(0);
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      reconcileState:'discarded', reconcileReason:'apply-failed',
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

  it('serializes art reconciliation when a hidden POST save overlaps visible-session polling', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, imageLoader, runtime} = harness;
    addArtCarrier(harness);
    const createdTask = createDeferred();
    const creationSave = createDeferred();
    const decodedImage = createDeferred();
    let artTaskSaveCount = 0;
    runtime.requestSave.mockImplementation(({reason}) => {
      if(reason === 'art-font-task'){
        artTaskSaveCount += 1;
        if(artTaskSaveCount === 1) return creationSave.promise;
      }
      return Promise.resolve({saved:true});
    });
    aiClient.createTask.mockReturnValue(createdTask.promise);
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-overlapping-reconcile', status:'succeeded', result:artResult(),
    });
    imageLoader.mockReturnValue(decodedImage.promise);
    await controller.start();

    const creating = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(aiClient.createTask).toHaveBeenCalledOnce());
    window.dispatchEvent(new CustomEvent('openshop:session-hidden', {detail:{context}}));
    createdTask.resolve({task_id:'task-overlapping-reconcile', status:'queued'});
    await vi.waitFor(() => expect(artTaskSaveCount).toBe(1));

    window.dispatchEvent(new CustomEvent('openshop:session-visible', {detail:{context}}));
    await vi.waitFor(() => expect(imageLoader).toHaveBeenCalledOnce());
    creationSave.resolve({saved:true});
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(imageLoader).toHaveBeenCalledOnce();
    decodedImage.resolve({
      type:'image', width:360, height:120,
      set(values){ Object.assign(this, values); },
    });
    await creating;
    await vi.waitFor(() => expect(editor.__hstarAiTaskRecords[0].reconcileState).toBe('applied'));
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(1);
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

  it('reconciles a late POST result through the current visible session without duplicating work', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient} = harness;
    addArtCarrier(harness);
    const post = createDeferred();
    aiClient.createTask.mockReturnValue(post.promise);
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-after-reopen', status:'succeeded', result:artResult(),
    });
    await controller.start();

    const creating = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(aiClient.createTask).toHaveBeenCalledOnce());

    window.dispatchEvent(new CustomEvent('openshop:session-opened', {detail:{session:{context}}}));
    window.dispatchEvent(new CustomEvent('openshop:session-visible', {detail:{context}}));
    post.resolve({task_id:'task-after-reopen', status:'queued'});
    await creating;

    await vi.waitFor(() => expect(editor.__hstarAiTaskRecords[0].reconcileState).toBe('applied'));
    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(aiClient.pollTask).toHaveBeenCalledOnce();
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(1);
    controller.destroy();
  });

  it('retries an aborted POST once through the reopened visible session', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient} = harness;
    addArtCarrier(harness);
    const firstPost = createDeferred();
    aiClient.createTask.mockReturnValueOnce(firstPost.promise).mockResolvedValueOnce({
      task_id:'task-after-abort-retry', status:'queued',
    });
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-after-abort-retry', status:'succeeded', result:artResult(),
    });
    await controller.start();

    const creating = controller.restoreArtFont('text-layer-1');
    await vi.waitFor(() => expect(aiClient.createTask).toHaveBeenCalledOnce());
    const clientRequestId = aiClient.createTask.mock.calls[0][1].clientRequestId;

    window.dispatchEvent(new CustomEvent('openshop:session-stopped', {detail:{context}}));
    window.dispatchEvent(new CustomEvent('openshop:session-opened', {detail:{session:{context}}}));
    window.dispatchEvent(new CustomEvent('openshop:session-visible', {detail:{context}}));
    const concurrentRestore = controller.restorePendingArtTasks();
    firstPost.reject(new DOMException('session stopped', 'AbortError'));
    await Promise.all([creating, concurrentRestore]);

    await vi.waitFor(() => expect(editor.__hstarAiTaskRecords[0].reconcileState).toBe('applied'));
    expect(aiClient.createTask).toHaveBeenCalledTimes(2);
    expect(aiClient.createTask.mock.calls.map(([, request]) => request.clientRequestId)).toEqual([
      clientRequestId, clientRequestId,
    ]);
    expect(aiClient.pollTask).toHaveBeenCalledOnce();
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(1);
    controller.destroy();
  });

  it('keeps the persisted provisional record in A when a late create response crosses into B', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient, runtime} = harness;
    addArtCarrier(harness);
    const post = createDeferred();
    let savedProjectARecords = [];
    runtime.requestSave.mockImplementation(async ({reason}) => {
      if(reason === 'art-font-provisional') savedProjectARecords = structuredClone(editor.__hstarAiTaskRecords);
      return {saved:true};
    });
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

    expect(savedProjectARecords).toHaveLength(1);
    expect(savedProjectARecords[0]).toMatchObject({
      taskId:expect.stringMatching(/^provisional:/), clientRequestId:expect.any(String),
      creationState:'provisional', status:'queued', reconcileState:'pending',
      context:{nodeId:'node-1', projectId:'project-1'},
    });
    expect(editor.__hstarAiTaskRecords).toEqual([]);
    expect(runtime.requestSave).toHaveBeenCalledTimes(savesBeforeResponse);
    expect(aiClient.pollTask).not.toHaveBeenCalled();
    expect(controller.getState().detachedArtTaskCount).toBe(0);
    controller.destroy();
  });

  it('retries a persisted provisional identity on reopen and applies the existing server task once', async () => {
    const harness = createHarness();
    const {controller, editor, aiClient} = harness;
    const carrier = addArtCarrier(harness);
    carrier.object.hstarArtFontRequestGeneration = 1;
    const provisional = provisionalArtRecord();
    editor.__hstarAiTaskRecords = [provisional];
    aiClient.createTask.mockResolvedValue({
      task_id:'task-existing-for-request', status:'running',
      task:{taskId:'task-existing-for-request', status:'running', clientRequestId:provisional.clientRequestId},
    });
    aiClient.pollTask.mockResolvedValue({
      taskId:'task-existing-for-request', status:'succeeded', result:artResult(),
    });
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-1'}}}));
    await vi.waitFor(() => expect(editor.__hstarAiTaskRecords[0].reconcileState).toBe('applied'));

    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(aiClient.createTask.mock.calls[0][1]).toMatchObject({
      toolId:'art-font-restore', clientRequestId:provisional.clientRequestId,
      sourceLayerId:'layer-source', sourceAssetId:SOURCE_ASSET_ID,
      options:{artFont:provisional.snapshot},
    });
    expect(editor.__hstarAiTaskRecords[0]).toMatchObject({
      taskId:'task-existing-for-request', clientRequestId:provisional.clientRequestId,
      creationState:'created', status:'succeeded', reconcileState:'applied',
    });
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(1);

    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project:{projectId:'project-1'}}}));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(aiClient.createTask).toHaveBeenCalledOnce();
    expect(aiClient.pollTask).toHaveBeenCalledOnce();
    expect(editor.layers.filter(layer => layer.hstarAiGeneration)).toHaveLength(1);
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
