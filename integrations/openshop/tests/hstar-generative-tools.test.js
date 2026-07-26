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
  const providers = [
    {
      id:'image-api', name:'生图 API', available,
      models:[
        {
          id:'image-model', name:'图像模型', available,
          capabilities:{
            maxOutputs, maxReferenceImages:12,
            sizes:['auto', '2048x2048'], qualities:['auto', 'high'],
          },
        },
        {
          id:'image-model-alt', name:'备用图像模型', available,
          capabilities:{
            maxOutputs, maxReferenceImages:12,
            sizes:['auto'], qualities:['auto', 'medium', 'high'],
          },
        },
      ],
    },
    {
      id:'backup-api', name:'备用 API', available,
      models:[{
        id:'backup-model', name:'备用模型', available,
        capabilities:{
          maxOutputs:4, maxReferenceImages:8,
          sizes:['auto'], qualities:['auto', 'low', 'high'],
        },
      }],
    },
  ];
  return {
    primaryProviderId:'image-api',
    tools:{
      'generative-fill':{
        id:'generative-fill', label:'生成式填充', providers,
      },
      'local-redraw':{
        id:'local-redraw', label:'局部重绘', providers,
      },
    },
  };
}

function createHarness({modelAvailable=true, maxOutputs=6, terminalTasks=[], retryTask=null, restoredTasks=[]}={}) {
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
    clearSelection:vi.fn(() => {
      editor._selectionBounds = null;
      editor._selectionMask = null;
      editor._selectionDocumentBounds = null;
      editor._selectionRegions = [];
    }),
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
      const providers = currentCatalog.tools[toolId].providers;
      const projectMode = preference.mode === 'project';
      const provider = projectMode
        ? providers.find(item => item.id === preference.apiConfigId)
        : providers.find(item => item.id === currentCatalog.primaryProviderId);
      const model = projectMode
        ? provider?.models.find(item => item.id === preference.modelId)
        : provider?.models[0];
      const resolvedAvailable = Boolean(modelAvailable && provider && model);
      return {
        available:resolvedAvailable,
        mode:projectMode ? 'project' : 'global',
        apiConfigId:projectMode ? preference.apiConfigId : (provider?.id || 'image-api'),
        modelId:projectMode ? preference.modelId : (model?.id || 'image-model'),
        providerName:provider?.name || preference.apiConfigId || '生图 API',
        modelName:model?.name || preference.modelId || '图像模型',
        model,
        reason:resolvedAvailable ? '' : '配置不可用',
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
    restoreTasks:vi.fn(async (_records, options={}) => {
      restoredTasks.forEach(task => options.onUpdate?.(task));
      return restoredTasks;
    }),
  };
  const assetApi = {
    upload:vi.fn(async payload => ({
      assetId:payload.role === 'ai-mask' ? MASK_ASSET_ID : SOURCE_ASSET_ID,
      url:`/api/openshop/assets/${payload.role === 'ai-mask' ? MASK_ASSET_ID : SOURCE_ASSET_ID}`,
    })),
  };
  const references = [{
    assetId:PRIMARY_ASSET_ID, referenceKey:PRIMARY_ASSET_ID,
    alias:'参考图1', mention:'@参考图1', sourceType:'primary', order:0,
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
    addLocalFile:vi.fn(async file => ({
      alias:'本地参考图1', mention:'@本地参考图1', sourceType:'local',
      dataUrl:'data:image/png;base64,LOCAL', name:file.name,
    })),
    removeReference:vi.fn(alias => {
      const index = references.findIndex(item => item.alias === alias);
      if(index < 0) return false;
      references.splice(index, 1);
      return true;
    }),
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

function setPrompt(prompt, value){
  prompt.textContent = value;
  prompt.dispatchEvent(new Event('input', {bubbles:true}));
}

function placeCaretAtEnd(element){
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  window.getSelection().removeAllRanges();
  window.getSelection().addRange(range);
}

function expectCaretAfter(node){
  const selection = window.getSelection();
  expect(selection.rangeCount).toBe(1);
  const range = selection.getRangeAt(0);
  expect(range.collapsed).toBe(true);
  expect(range.startContainer).toBe(node.parentNode);
  expect(range.startOffset).toBe(Array.from(node.parentNode.childNodes).indexOf(node) + 1);
}

function selectRegion(editor, bounds={x:10, y:20, w:300, h:200}){
  editor._selectionBounds = {...bounds};
  editor._selectionRegions = [{...bounds}];
  window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
    detail:{
      reason:'marquee',
      hasSelection:true,
      regions:[{...bounds}],
      regionCount:1,
    },
  }));
}

function openToolWithSelection(controller, editor, toolId, bounds){
  controller.openTool(toolId);
  selectRegion(editor, bounds);
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
    delete window.HstarVoiceInputAdapter;
    document.querySelectorAll('link[href*="openshop-generative-tools.css"]').forEach(link => link.remove());
    document.body.innerHTML = `
      <div id="tool-options"><div id="opt-marquee"></div></div>
      <div id="canvas-area"></div>`;
    await import(`${pathToFileURL(toolsPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('reuses the versioned generative stylesheet instead of appending an unversioned duplicate', async () => {
    const stylesheet = document.createElement('link');
    stylesheet.rel = 'stylesheet';
    stylesheet.href = './host/openshop-generative-tools.css?v=runtime-revision';
    document.head.appendChild(stylesheet);
    const {controller} = createHarness();

    await controller.start();

    const stylesheets = document.querySelectorAll('link[href*="openshop-generative-tools.css"]');
    expect(stylesheets).toHaveLength(1);
    expect(stylesheets[0].href).toContain('v=runtime-revision');
    expect(stylesheets[0].dataset.hstarGenerativeStyles).toBe('true');
    controller.destroy();
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
    expect(controller.getState().selectionActive).toBe(false);
    expect(controller.getState().collapsed).toBe(true);
    expect(document.querySelector('[data-generative-operation-bar]').hidden).toBe(false);
    expect(document.querySelector('[data-generative-selection-hint]').textContent)
      .toContain('请先选择要修改的区域');
    expect(assetApi.upload).not.toHaveBeenCalled();
    expect(generativeClient.createTask).not.toHaveBeenCalled();

    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
    expect(controller.getState().status).toBe('ready');
    expect(controller.getState().selectionActive).toBe(false);
    expect(document.querySelector('[data-generative-operation-bar]').hidden).toBe(false);
    const prompt = document.querySelector('[data-generative-prompt]');
    setPrompt(prompt, '保留的未提交提示词');

    editor._selectionBounds = null;
    window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
    expect(controller.getState().status).toBe('selecting');
    expect(controller.getState().prompt).toBe('保留的未提交提示词');
    controller.destroy();
  });

  it.each(['generative-fill', 'local-redraw'])(
    'starts %s compact and expands only after a fresh selection',
    async toolId => {
      const {controller, editor} = createHarness();
      editor._selectionBounds = {x:10, y:20, w:300, h:200};
      await controller.start();

      controller.openTool(toolId);

      const bar = document.querySelector('[data-generative-operation-bar]');
      expect(editor.clearSelection).toHaveBeenCalledTimes(1);
      expect(editor.setTool).toHaveBeenCalledWith('marquee-rect');
      expect(controller.getState()).toMatchObject({
        activeTool:toolId,
        status:'selecting',
        collapsed:true,
        selectionActive:false,
        selectionCount:0,
        selectionRegions:[],
      });
      expect(bar.hidden).toBe(false);
      expect(bar.classList.contains('is-collapsed')).toBe(true);

      editor._selectionBounds = {x:30, y:40, w:180, h:120};
      window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
        detail:{
          reason:'marquee',
          hasSelection:true,
          regions:[{x:30, y:40, w:180, h:120}],
          regionCount:1,
          incomingBounds:{x:30, y:40, w:180, h:120},
        },
      }));

      expect(controller.getState()).toMatchObject({
        status:'ready',
        collapsed:false,
        selectionActive:false,
        selectionCount:1,
      });
      expect(bar.hidden).toBe(false);
      expect(bar.classList.contains('is-collapsed')).toBe(false);
      controller.destroy();
    },
  );

  it('keeps mention capsules intact across voice commit and cancellation', async () => {
    let registration = null;
    window.HstarVoiceInputAdapter = {
      register: vi.fn((target, adapter) => {
        registration = {target, adapter};
        return vi.fn();
      }),
    };
    const {controller, editor} = createHarness();
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw');
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.innerHTML = '保留 <span class="hstar-generative-mention-token" contenteditable="false" data-generative-mention-token="true" data-reference-key="primary-key" data-mention="@参考图1">@参考图1</span> ';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));
    placeCaretAtEnd(prompt);

    expect(registration?.target).toBe(prompt);
    const transaction = registration.adapter.beginComposition(registration.adapter.getSelection());
    transaction.updateComposition('语');
    transaction.updateComposition('语音@文字');
    transaction.commitComposition('语音@文字完成');

    expect(prompt.querySelectorAll('[data-generative-mention-token]')).toHaveLength(1);
    expect(prompt.querySelector('[data-generative-mention-token]').textContent).toBe('@参考图1');
    expect(prompt.textContent).toContain('语音@文字完成');
    expect(prompt.querySelectorAll('[data-generative-mention-token]')).toHaveLength(1);
    expect(controller.getState().prompt).toContain('语音@文字完成');

    placeCaretAtEnd(prompt);
    const beforeCancel = prompt.innerHTML;
    const cancelled = registration.adapter.beginComposition(registration.adapter.getSelection());
    cancelled.updateComposition('未提交');
    cancelled.cancelComposition();
    expect(prompt.innerHTML).toBe(beforeCancel);
    expect(prompt.querySelectorAll('[data-generative-mention-token]')).toHaveLength(1);
    controller.destroy();
  });

  it.each(['generative-fill', 'local-redraw'])(
    'keeps the live voice caret after partial text and appends consecutive phrases for %s',
    async toolId => {
      let registration = null;
      window.HstarVoiceInputAdapter = {
        register: vi.fn((target, adapter) => {
          registration = {target, adapter};
          return vi.fn();
        }),
      };
      const {controller, editor} = createHarness();
      await controller.start();
      openToolWithSelection(controller, editor, toolId);
      const prompt = document.querySelector('[data-generative-prompt]');
      setPrompt(prompt, '开头');
      prompt.focus();
      placeCaretAtEnd(prompt);

      const first = registration.adapter.beginComposition(registration.adapter.getSelection());
      first.updateComposition('第一');
      const marker = prompt.querySelector('[data-voice-composition]');
      expect(marker.textContent).toBe('第一');
      expectCaretAfter(marker);
      first.updateComposition('第一句');
      expectCaretAfter(marker);
      first.commitComposition('第一句。');

      const second = registration.adapter.beginComposition(registration.adapter.getSelection());
      second.updateComposition('第二');
      expectCaretAfter(prompt.querySelector('[data-voice-composition]'));
      second.commitComposition('第二句。');

      expect(prompt.textContent).toBe('开头第一句。第二句。');
      expect(prompt.querySelector('[data-voice-composition]')).toBeNull();
      controller.destroy();
    },
  );

  it('hides while a canvas selection is being drawn and restores the normal panel when it completes', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');
    editor.state.tool = 'marquee-rect';

    const bar = document.querySelector('[data-generative-operation-bar]');
    expect(controller.getState()).toMatchObject({collapsed:true, expanded:false});
    expect(bar.classList.contains('is-collapsed')).toBe(true);
    expect(bar.querySelector('[data-generative-action="zoom-panel"]').getAttribute('aria-label')).toBe('恢复面板');
    expect(bar.querySelector('[data-panel-zoom-icon="restore"]')).not.toBeNull();
    document.getElementById('canvas-area').dispatchEvent(new Event('pointerdown', {bubbles:true}));

    expect(controller.getState()).toMatchObject({
      selectionActive:true, expanded:false, collapsed:false, autoHidden:false,
    });
    expect(bar.hidden).toBe(true);

    editor._selectionBounds = {x:30, y:40, w:180, h:120};
    window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
      detail:{
        reason:'marquee', hasSelection:true,
        regions:[{x:30, y:40, w:180, h:120}], regionCount:1,
        incomingBounds:{x:30, y:40, w:180, h:120},
      },
    }));

    expect(controller.getState()).toMatchObject({
      selectionActive:false, expanded:false, collapsed:false, autoHidden:false, status:'ready',
    });
    expect(bar.hidden).toBe(false);
    expect(bar.classList.contains('is-expanded')).toBe(false);
    expect(bar.classList.contains('is-collapsed')).toBe(false);
    expect(bar.querySelector('[data-generative-action="zoom-panel"]').getAttribute('aria-label')).toBe('缩放面板');
    expect(bar.querySelector('[data-panel-zoom-icon="shrink"]')).not.toBeNull();
    controller.destroy();
  });

  it('does not resurrect a destroyed operation bar from delayed selection feedback', async () => {
    vi.useFakeTimers();
    try {
      const {controller, editor} = createHarness();
      await controller.start();
      controller.openTool('local-redraw');
      editor._selectionBounds = {x:10, y:20, w:300, h:200};
      window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
        detail:{
          reason:'marquee', hasSelection:true,
          regions:[{x:10, y:20, w:300, h:200}], regionCount:1,
          incomingBounds:{x:10, y:20, w:300, h:200},
        },
      }));

      controller.destroy();
      await vi.advanceTimersByTimeAsync(1800);

      expect(document.querySelector('[data-generative-operation-bar]')).toBeNull();
      expect(document.querySelector('[data-hstar-generative-entries]')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('toggles the active tool closed and only auto-hides the panel during outside canvas operations', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    const fill = document.querySelector('[data-hstar-generative-tool="generative-fill"]');

    fill.click();
    expect(controller.getState()).toMatchObject({
      activeTool:'generative-fill', expanded:false, collapsed:true,
    });
    expect(document.querySelector('[data-generative-operation-bar]').classList.contains('is-collapsed')).toBe(true);

    document.querySelector('[data-generative-action="zoom-panel"]').click();
    expect(controller.getState()).toMatchObject({expanded:false, collapsed:false});
    expect(document.querySelector('[data-generative-operation-bar]').classList.contains('is-collapsed')).toBe(false);

    fill.click();
    expect(controller.getState().activeTool).toBe('');

    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    fill.click();
    document.getElementById('canvas-area').dispatchEvent(new Event('pointerdown', {bubbles:true}));
    expect(controller.getState()).toMatchObject({
      activeTool:'generative-fill', expanded:false, collapsed:false,
      autoHidden:false, selectionActive:true,
    });
    expect(document.querySelector('[data-generative-operation-bar]').hidden).toBe(true);
    expect(document.querySelector('[data-generative-operation-bar]').classList.contains('is-collapsed')).toBe(false);
    selectRegion(editor);
    expect(controller.getState()).toMatchObject({
      expanded:false, collapsed:false, autoHidden:false, selectionActive:false,
    });
    expect(document.querySelector('[data-generative-operation-bar]').hidden).toBe(false);
    expect(document.querySelector('[data-generative-operation-bar]').classList.contains('is-expanded')).toBe(false);
    controller.destroy();
  });

  it('uses selection-first redraw defaults and closes option popovers outside their control', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');

    expect(controller.getState()).toMatchObject({referenceMode:'selection', ratio:'selection'});
    expect(document.querySelector('[data-reference-mode="selection"]').getAttribute('aria-pressed')).toBe('true');
    expect(document.querySelector('[data-generative-menu-trigger="ratio"]').textContent).toContain('按选区');

    document.querySelector('[data-generative-menu-trigger="provider"]').click();
    expect(document.querySelector('[data-generative-provider-option="__global__"]')).toBeNull();
    expect(document.querySelector('[data-generative-popover="provider"]').hidden).toBe(false);
    document.querySelector('[data-generative-prompt-stage]').dispatchEvent(new Event('pointerdown', {bubbles:true}));
    expect(document.querySelector('[data-generative-popover="provider"]').hidden).toBe(true);
    controller.destroy();
  });

  it('keeps the local file input alive until the selected image change is handled', async () => {
    const {controller, editor, referenceManager} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('generative-fill');

    document.querySelector('[data-generative-action="toggle-reference-menu"]').click();
    const input = document.querySelector('[data-reference-local-input]');
    const clickSpy = vi.spyOn(input, 'click').mockImplementation(() => {});
    document.querySelector('[data-reference-add="local"]').click();

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(document.querySelector('[data-reference-local-input]')).toBe(input);

    const file = new File(['image'], 'reference.png', {type:'image/png'});
    Object.defineProperty(input, 'files', {configurable:true, value:[file]});
    input.dispatchEvent(new Event('change', {bubbles:true}));
    await vi.waitFor(() => {
      expect(referenceManager.addLocalFile).toHaveBeenCalledWith(file);
    });
    controller.destroy();
  });

  it('does not close an active generative tool when Escape is pressed', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');

    window.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));

    expect(controller.getState().activeTool).toBe('local-redraw');
    expect(document.querySelector('[data-generative-operation-bar]').hidden).toBe(false);
    controller.destroy();
  });

  it('keeps the existing bottom control order unchanged', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');

    expect(Array.from(document.querySelectorAll('.hstar-generative-bottom [data-generative-menu-trigger]'))
      .map(button => button.dataset.generativeMenuTrigger))
      .toEqual(['provider', 'model', 'resolution', 'ratio', 'quality', 'count']);
    expect(document.querySelector('.hstar-generative-bottom [data-generative-submit]')).not.toBeNull();
    controller.destroy();
  });

  it('renders local references without asset ids next to their primary reference', async () => {
    const {controller, editor, referenceManager} = createHarness();
    const primary = {assetId:'', alias:'本地参考图1', dataUrl:'data:image/png;base64,PRIMARY'};
    const secondary = {assetId:'', alias:'本地参考图2', dataUrl:'data:image/png;base64,SECONDARY'};
    referenceManager.list.mockReturnValue([primary, secondary]);
    referenceManager.getPrimary.mockReturnValue(primary);
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');

    expect(document.querySelector('[data-reference-thumbnail="本地参考图2"]')).not.toBeNull();
    controller.destroy();
  });

  it('opens the operation-window thumbnail detail without breaking delete', async () => {
    const {controller, editor, referenceManager} = createHarness();
    const primary = {assetId:'', alias:'selection-1', mention:'@selection-1', dataUrl:'data:image/png;base64,PRIMARY'};
    const secondary = {assetId:'', alias:'selection-2', mention:'@selection-2', dataUrl:'data:image/png;base64,SECONDARY'};
    referenceManager.list.mockReturnValue([primary, secondary]);
    referenceManager.getPrimary.mockReturnValue(primary);
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    controller.openTool('local-redraw');

    document.querySelector('[data-reference-thumbnail="selection-1"]').click();
    const modal = document.querySelector('[data-reference-detail-modal]');
    expect(modal).not.toBeNull();
    expect(modal.getAttribute('aria-label')).toBe('参考图详情');
    expect(modal.querySelector('[data-reference-detail-image]').src).toContain('data:image/png;base64,PRIMARY');
    expect(modal.querySelector('[data-reference-detail-image]').style.objectFit).toBe('contain');

    modal.querySelector('[data-reference-detail-close]').click();
    expect(document.querySelector('[data-reference-detail-modal]')).toBeNull();
    document.querySelector('[data-reference-thumbnail="selection-2"] .hstar-reference-delete').click();
    expect(referenceManager.removeReference).toHaveBeenCalledWith('selection-2');
    expect(document.querySelector('[data-reference-detail-modal]')).toBeNull();
    controller.destroy();
  });

  it('keeps a missing redraw selection in the waiting state', async () => {
    const {controller, referenceManager} = createHarness();
    await controller.start();

    controller.openTool('local-redraw');
    await new Promise(resolve => setTimeout(resolve, 0));
    referenceManager.setPrimaryMode.mockRejectedValueOnce(new Error('selection unavailable'));
    document.querySelector('[data-reference-mode="selection"]').click();
    await new Promise(resolve => setTimeout(resolve, 0));

    expect(controller.getState().status).toBe('selecting');
    expect(controller.getState().error).toBe('');
    controller.destroy();
  });

  it('shows the reference row for both tools and range/mention controls for local redraw', async () => {
    const {controller, editor, referenceManager} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();

    openToolWithSelection(controller, editor, 'generative-fill');
    expect(document.querySelector('[data-reference-mode]')).toBeNull();
    expect(document.querySelector('[data-reference-strip]')).not.toBeNull();

    openToolWithSelection(controller, editor, 'local-redraw');
    expect(document.querySelector('[data-reference-mode="selection"]')).not.toBeNull();
    expect(document.querySelector('[data-reference-mode="full"]')).not.toBeNull();
    expect(document.querySelector('[data-primary-reference-thumbnail] img').src)
      .toContain('/api/openshop/assets/primary');
    expect(referenceManager.itemsForMentionPicker).toHaveBeenCalled();
    controller.destroy();
  });

  it.each(['generative-fill', 'local-redraw'])(
    'renders a shared contenteditable mention editor for %s',
    async toolId => {
      const {controller, editor} = createHarness();
      await controller.start();
      controller.openTool(toolId);
      editor._selectionBounds = {x:10, y:20, w:300, h:200};
      window.dispatchEvent(new CustomEvent('openshop:selection-changed'));

      const prompt = document.querySelector('[data-generative-prompt]');
      expect(prompt.tagName).toBe('DIV');
      expect(prompt.getAttribute('contenteditable')).toBe('true');
      expect(prompt.getAttribute('role')).toBe('textbox');
      setPrompt(prompt, '保留主体\n增强光线');
      expect(controller.getState().prompt).toBe('保留主体\n增强光线');
      controller.destroy();
    },
  );

  it.each(['generative-fill', 'local-redraw'])(
    'inserts and serializes a mention token for %s',
    async toolId => {
      const {controller, editor} = createHarness();
      await controller.start();
      openToolWithSelection(controller, editor, toolId);
      const prompt = document.querySelector('[data-generative-prompt]');
      prompt.focus();
      prompt.textContent = '替换为 @';
      placeCaretAtEnd(prompt);
      prompt.dispatchEvent(new Event('input', {bubbles:true}));

      const picker = document.querySelector('[data-reference-mention-picker]');
      expect(picker).not.toBeNull();
      expect(picker.hidden).toBe(false);
      document.querySelector('[data-reference-mention="@参考图1"]').click();

      const token = prompt.querySelector('[data-generative-mention-token]');
      expect(token.textContent).toBe('@参考图1');
      expect(token.getAttribute('contenteditable')).toBe('false');
      expect(controller.getState().prompt).toBe('替换为 @参考图1 ');
      controller.destroy();
    },
  );

  it.each(['generative-fill', 'local-redraw'])(
    'does not reopen mention choices from an existing mention token for %s',
    async toolId => {
      const {controller, editor} = createHarness();
      await controller.start();
      openToolWithSelection(controller, editor, toolId);
      const prompt = document.querySelector('[data-generative-prompt]');
      prompt.focus();
      prompt.textContent = '@';
      placeCaretAtEnd(prompt);
      prompt.dispatchEvent(new Event('input', {bubbles:true}));
      document.querySelector('[data-reference-mention]').click();

      const token = prompt.querySelector('[data-generative-mention-token]');
      expect(token).not.toBeNull();
      expect(prompt.querySelectorAll('[data-generative-mention-token]')).toHaveLength(1);
      const range = document.createRange();
      range.setStart(prompt, 1);
      range.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      prompt.dispatchEvent(new Event('input', {bubbles:true}));
      expect(prompt.querySelectorAll('[data-generative-mention-token]')).toHaveLength(1);
      prompt.click();

      const picker = document.querySelector('[data-reference-mention-picker]');
      expect(picker.hidden).toBe(true);
      expect(prompt.querySelectorAll('[data-generative-mention-token]')).toHaveLength(1);
      controller.destroy();
    },
  );

  it('deletes mention tokens atomically and pastes external markup as text', async () => {
    const {controller, editor} = createHarness();
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw');
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.innerHTML = '材质 <span class="hstar-generative-mention-token" contenteditable="false" data-generative-mention-token="true" data-reference-key="primary-key" data-mention="@参考图1">@参考图1</span> ';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));

    const token = prompt.querySelector('[data-generative-mention-token]');
    const spacer = token.nextSibling;
    const range = document.createRange();
    range.setStart(spacer, 0);
    range.collapse(true);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(range);
    prompt.dispatchEvent(new KeyboardEvent('keydown', {key:'Backspace', bubbles:true, cancelable:true}));
    expect(prompt.querySelector('[data-generative-mention-token]')).toBeNull();

    placeCaretAtEnd(prompt);
    const paste = new Event('paste', {bubbles:true, cancelable:true});
    Object.defineProperty(paste, 'clipboardData', {
      value:{getData:type => type === 'text/plain' ? '<b>纯文本</b>' : ''},
    });
    prompt.dispatchEvent(paste);
    expect(prompt.querySelector('b')).toBeNull();
    expect(prompt.textContent).toContain('<b>纯文本</b>');
    controller.destroy();
  });

  it('removes an inserted mention token when its reference is deleted', async () => {
    const {controller, editor} = createHarness();
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw');
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.textContent = '@';
    placeCaretAtEnd(prompt);
    prompt.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('[data-reference-mention="@参考图1"]').click();
    expect(prompt.querySelector('[data-generative-mention-token]')).not.toBeNull();

    document.querySelector('[data-generative-remove-reference="参考图1"]').click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-generative-prompt] [data-generative-mention-token]')).toBeNull();
    });
    expect(controller.getState().prompt).not.toContain('@参考图1');
    controller.destroy();
  });

  it('renders generative fill as the compact prompt workbench', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();

    openToolWithSelection(controller, editor, 'generative-fill');

    const bar = document.querySelector('[data-generative-operation-bar]');
    expect(bar.querySelector('[data-generative-workbench-top]')).not.toBeNull();
    expect(bar.querySelector('[data-generative-mode-summary]').textContent)
      .toContain('生成式填充 · 1 个选区');
    expect(bar.querySelector('[data-generative-prompt-stage]')).not.toBeNull();
    expect(bar.querySelector('[data-generative-provider]').textContent).toContain('生图 API');
    expect(bar.querySelector('[data-generative-model]').textContent).toContain('图像模型');
    expect(bar.querySelector('[data-generative-menu-trigger="resolution"]')).not.toBeNull();
    expect(bar.querySelector('[data-generative-menu-trigger="ratio"]')).not.toBeNull();
    expect(bar.querySelector('[data-generative-menu-trigger="quality"]')).not.toBeNull();
    expect(bar.querySelector('[data-generative-menu-trigger="count"]')).not.toBeNull();
    expect(bar.querySelector('[data-generative-submit]').textContent).toContain('运行');
    expect(bar.classList.contains('is-collapsed')).toBe(false);
    expect(bar.querySelector('[data-generative-action="zoom-panel"]').getAttribute('aria-label')).toBe('缩放面板');
    expect(bar.querySelector('select')).toBeNull();
    controller.destroy();
  });

  it('shows one bottom-right prompt message without the ready duplication', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();

    openToolWithSelection(controller, editor, 'local-redraw');
    const localFeedback = document.querySelector('.hstar-generative-feedback');
    expect(localFeedback.textContent.match(/局部重绘需要填写修改要求/g)).toHaveLength(1);
    expect(localFeedback.textContent).not.toContain('可以提交');
    expect(document.querySelector('[data-generative-status]').textContent.trim())
      .toBe('局部重绘需要填写修改要求');
    expect(document.querySelector('[data-generative-disabled-reason]').textContent.trim()).toBe('');

    openToolWithSelection(controller, editor, 'generative-fill');
    expect(document.querySelector('.hstar-generative-feedback').textContent).not.toContain('可以提交');
    controller.destroy();
  });

  it('does not render an empty primary thumbnail before a reference exists', async () => {
    const {controller, editor, referenceManager} = createHarness();
    editor._selectionBounds = null;
    referenceManager.list.mockReturnValue([]);
    referenceManager.getPrimary.mockReturnValue(null);
    referenceManager.setPrimaryMode.mockResolvedValue(null);
    await controller.start();
    controller.openTool('generative-fill');

    expect(document.querySelector('[data-primary-reference-thumbnail]')).toBeNull();
    expect(document.querySelector('.hstar-reference-marker')).not.toBeNull();
    expect(document.querySelector('.hstar-reference-add')).not.toBeNull();
    expect(document.querySelector('.hstar-generative-reference-row').textContent).not.toContain('1');
    controller.destroy();
  });

  it('uses separate API and model dropdowns backed by the API generation catalog', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    openToolWithSelection(controller, editor, 'generative-fill');

    document.querySelector('[data-generative-menu-trigger="provider"]').click();
    expect(document.querySelector('[data-generative-popover="provider"]').hidden).toBe(false);
    document.querySelector('[data-generative-provider-option="backup-api"]').click();

    expect(editor.__hstarAiToolPreferences['generative-fill']).toMatchObject({
      mode:'project', apiConfigId:'backup-api', modelId:'backup-model',
    });
    expect(document.querySelector('[data-generative-provider]').textContent).toBe('备用 API');
    expect(document.querySelector('[data-generative-model]').textContent).toBe('备用模型');
    document.querySelector('[data-generative-menu-trigger="model"]').click();
    expect(document.querySelector('[data-generative-popover="model"]').hidden).toBe(false);
    expect(document.querySelectorAll('[data-generative-model-option]')).toHaveLength(1);
    controller.destroy();
  });

  it('maps API generation resolution, ratio, quality and count options into the task request', async () => {
    const {controller, editor, generativeClient} = createHarness({maxOutputs:6});
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw');

    document.querySelector('[data-generative-menu-trigger="ratio"]').click();
    expect(Array.from(document.querySelectorAll('[data-generative-size-ratio]')).map(button => button.textContent.trim()))
      .toEqual(expect.arrayContaining(['按选区', '1:1', '16:9', '适配比例', '自定义']));
    document.querySelector('[data-generative-size-ratio="wide"]').click();
    document.querySelector('[data-generative-menu-trigger="resolution"]').click();
    expect(Array.from(document.querySelectorAll('[data-generative-size-resolution]')).map(button => button.textContent.trim()))
      .toEqual(expect.arrayContaining(['自动', '1K', '2K', '4K', '自定义']));
    document.querySelector('[data-generative-size-resolution="4k"]').click();
    document.querySelector('[data-generative-menu-trigger="quality"]').click();
    expect(Array.from(document.querySelectorAll('[data-generative-quality-option]')).map(button => button.textContent.trim()))
      .toEqual(['Q auto', 'Q low', 'Q med', 'Q high']);
    document.querySelector('[data-generative-quality-option="high"]').click();
    document.querySelector('[data-generative-menu-trigger="count"]').click();
    document.querySelector('[data-generative-count-option="3"]').click();

    const prompt = document.querySelector('[data-generative-prompt]');
    setPrompt(prompt, '替换为 @参考图1 的材质');
    await controller.submit();

    expect(controller.getState()).toMatchObject({
      ratio:'wide', resolution:'4k', size:'3840x2160', quality:'high', count:3,
    });
    expect(generativeClient.createTask).toHaveBeenCalledWith(context, expect.objectContaining({
      apiConfigId:'image-api', modelId:'image-model',
      size:'3840x2160', quality:'high', targetCount:3,
    }));
    controller.destroy();
  });

  it('submits generative-fill mention references through snapshotForTask', async () => {
    const {controller, editor, referenceManager, generativeClient} = createHarness();
    referenceManager.snapshotForTask.mockResolvedValue({
      primaryReferenceAssetId:'b'.repeat(64),
      references:[{
        assetId:'c'.repeat(64),
        alias:'参考图2',
        mention:'@参考图2',
        sourceType:'library',
        order:1,
      }],
    });
    await controller.start();
    openToolWithSelection(controller, editor, 'generative-fill');
    setPrompt(document.querySelector('[data-generative-prompt]'), '使用 @参考图2 的材质');

    await controller.submit();

    expect(referenceManager.snapshotForTask).toHaveBeenCalledWith(expect.objectContaining({
      mode:'full',
      maxReferences:expect.any(Number),
      fullCompositeAsset:expect.any(Object),
    }));
    expect(generativeClient.createTask).toHaveBeenCalledWith(
      context,
      expect.objectContaining({
        prompt:'使用 @参考图2 的材质',
        primaryReferenceAssetId:'b'.repeat(64),
        references:[expect.objectContaining({mention:'@参考图2'})],
      }),
    );
    controller.destroy();
  });

  it('keeps the live selection aspect ratio when the 4K pixel cap applies', async () => {
    const {controller, editor, generativeClient} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw', {x:1897, y:1095, w:551, h:726});
    const prompt = document.querySelector('[data-generative-prompt]');
    setPrompt(prompt, '将选区变为一个锤子');

    await controller.submit();

    expect(controller.getState().size).toBe('2496x3296');
    expect(generativeClient.createTask).toHaveBeenCalledWith(context, expect.objectContaining({
      size:'2496x3296',
      selection:{x:1897, y:1095, width:551, height:726, feather:0},
    }));
    controller.destroy();
  });

  it('surfaces a failed child error instead of the generic parent status', async () => {
    const failedTask = generationTask({
      status:'failed', targetCount:1, completedCount:0, failedCount:1, error:'',
      children:[{
        childTaskId:'child-failed', index:0, status:'failed', outputAssetId:'',
        error:'OpenShop generated crop aspect ratio is misaligned',
      }],
    });
    const {controller, editor} = createHarness({terminalTasks:[failedTask]});
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw');
    const prompt = document.querySelector('[data-generative-prompt]');
    setPrompt(prompt, '修改选区');

    await controller.submit();

    expect(controller.getState()).toMatchObject({
      status:'failed', error:'OpenShop generated crop aspect ratio is misaligned',
    });
    expect(document.querySelector('[data-generative-status]').textContent)
      .toContain('OpenShop generated crop aspect ratio is misaligned');
    controller.destroy();
  });

  it('does not publish a succeeded task before generated layers are inserted', async () => {
    const succeededTask = generationTask({
      status:'succeeded', targetCount:1, completedCount:1, failedCount:0,
      children:[{
        childTaskId:'child-decode-failed', index:0, status:'succeeded',
        outputAssetId:'6'.repeat(64), result:{url:'/api/openshop/assets/6'},
      }],
    });
    const {controller, editor, imageLoader} = createHarness({terminalTasks:[succeededTask]});
    imageLoader.mockRejectedValueOnce(new Error('generated image decode failed'));
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw');
    const prompt = document.querySelector('[data-generative-prompt]');
    setPrompt(prompt, '修改选区');

    await expect(controller.submit()).rejects.toThrow('generated image decode failed');

    expect(editor.__hstarAiTaskRecords.find(task => task.taskId === 'parent-1')?.status)
      .not.toBe('succeeded');
    expect(editor.layers).toHaveLength(1);
    controller.destroy();
  });

  it('uses dynamic model limits and submits a frozen multi-reference snapshot', async () => {
    const {controller, editor, assetApi, referenceManager, generativeClient} = createHarness({maxOutputs:6});
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    await controller.start();
    openToolWithSelection(controller, editor, 'local-redraw');

    document.querySelector('[data-generative-menu-trigger="count"]').click();
    expect(document.querySelectorAll('[data-generative-count-option]')).toHaveLength(6);
    document.querySelector('[data-generative-count-option="3"]').click();
    document.querySelector('[data-generative-menu-trigger="ratio"]').click();
    document.querySelector('[data-generative-size-ratio="square"]').click();
    document.querySelector('[data-generative-menu-trigger="resolution"]').click();
    document.querySelector('[data-generative-size-resolution="2k"]').click();
    document.querySelector('[data-generative-menu-trigger="quality"]').click();
    document.querySelector('[data-generative-quality-option="high"]').click();
    const prompt = document.querySelector('[data-generative-prompt]');
    setPrompt(prompt, '替换为 @参考图1 的材质');

    const task = await controller.submit();

    expect(task.status).toBe('succeeded');
    expect(assetApi.upload).toHaveBeenCalledWith(expect.objectContaining({role:'ai-source'}));
    expect(assetApi.upload).toHaveBeenCalledWith(expect.objectContaining({role:'ai-mask'}));
    expect(referenceManager.snapshotForTask).toHaveBeenCalledWith(expect.objectContaining({
      mode:'selection', maxReferences:12,
    }));
    expect(generativeClient.createTask).toHaveBeenCalledWith(context, expect.objectContaining({
      toolId:'local-redraw', sourceAssetId:SOURCE_ASSET_ID, maskAssetId:MASK_ASSET_ID,
      primaryReferenceAssetId:PRIMARY_ASSET_ID, targetCount:3,
      size:'2048x2048', quality:'high', sourceLayerId:'source-layer',
      referenceMode:'selection', references:[expect.objectContaining({alias:'参考图1'})],
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
    openToolWithSelection(controller, editor, 'local-redraw');

    expect(document.querySelector('[data-hstar-generative-tool="local-redraw"]').disabled).toBe(false);
    expect(document.querySelector('[data-generative-model]').textContent).toContain('deleted-model');
    expect(document.querySelector('[data-generative-submit]').disabled).toBe(true);
    expect(document.querySelector('[data-generative-status]').textContent).toContain('配置不可用');
    expect(document.querySelector('[data-generative-disabled-reason]').textContent.trim()).toBe('');
    controller.destroy();
  });

  it('shows one prominent green running message while a task is being prepared', async () => {
    const {controller, editor, referenceManager} = createHarness();
    editor._selectionDocumentBounds = {x:10, y:20, w:300, h:200};
    let releaseCapture;
    referenceManager.captureVisibleComposite.mockImplementationOnce(() => new Promise(resolve => {
      releaseCapture = resolve;
    }));
    await controller.start();
    openToolWithSelection(controller, editor, 'generative-fill');

    const submission = controller.submit();
    await vi.waitFor(() => {
      expect(controller.getState().status).toBe('preparing');
    });

    const feedback = document.querySelector('.hstar-generative-feedback');
    const status = document.querySelector('[data-generative-status]');
    expect(feedback.textContent.match(/正在执行中/g)).toHaveLength(1);
    expect(status.textContent.trim()).toBe('正在执行中');
    expect(status.classList.contains('is-running')).toBe(true);
    expect(document.querySelector('[data-generative-disabled-reason]').textContent.trim()).toBe('');

    releaseCapture({dataUrl:'data:image/png;base64,FULL', width:1920, height:1080});
    await submission;
    controller.destroy();
  });

  it('routes pixel and rectangle selection completion through one selection event contract', () => {
    const source = readFileSync(indexPath, 'utf8');
    expect(source).toContain("_emitSelectionChanged(reason='updated', extra={})");
    expect(source).toContain('this._emitSelectionChanged(reason, {');
    expect(source).toContain('data-selection-mode="add"');
    expect(source).toContain('selectionRegions');
    expect(source).toContain("'magic-wand'");
    expect(source).toContain("'lasso'");
    expect(source).toContain("this._marqueeMode, 'marquee'");
    for(const reason of ['reselected', 'inverted', 'recalculated', 'cleared']) {
      expect(source).toContain(`_emitSelectionChanged('${reason}')`);
    }
  });

  it('styles complete thumbnails, removable references, collapsed panel and numbered selections', () => {
    const styles = readFileSync(stylesPath, 'utf8');
    const source = readFileSync(indexPath, 'utf8');
    expect(styles).toMatch(/hstar-generative-reference-row[\s\S]*?object-fit:\s*cover/);
    expect(styles).toContain('.hstar-reference-delete');
    expect(styles).toContain('  opacity: .86;');
    expect(styles).toContain('.hstar-generative-bar.is-collapsed');
    expect(styles).toContain('.hstar-selection-region-marker');
    const markerLayer = styles.match(/\.hstar-selection-region-markers\s*\{[\s\S]*?z-index:\s*(\d+)/);
    const selectionMask = source.match(/\.selection-mask-overlay\{[^}]*z-index:\s*(\d+)/);
    const operationWindow = styles.match(/\.hstar-generative-bar\s*\{[\s\S]*?z-index:\s*(\d+)/);
    expect(Number(markerLayer?.[1])).toBeGreaterThan(Number(selectionMask?.[1]));
    expect(Number(operationWindow?.[1])).toBeGreaterThan(Number(markerLayer?.[1]));
    expect(styles).toMatch(/\.hstar-selection-region-markers\s*\{[\s\S]*?overflow:\s*visible/);
    expect(styles).toMatch(/\.hstar-selection-region-marker\s*\{[\s\S]*?background:\s*#f5f5f7/);
    expect(styles).toMatch(/\.hstar-selection-region-marker\s*\{[\s\S]*?box-shadow:\s*0 0 0 1px/);
    expect(styles).toContain('.hstar-reference-detail-modal');
    expect(styles).toContain('data-reference-detail-image');
    expect(source).toContain('.selection-mode-toolbar');
    expect(source).toContain('.selection-mode-btn');
  });

  it('styles the contenteditable prompt and blue mention capsules without textarea selectors', () => {
    const styles = readFileSync(stylesPath, 'utf8');

    expect(styles).not.toMatch(/\.hstar-generative-prompt\s+textarea/);
    expect(styles).toContain('.hstar-generative-prompt-editor');
    expect(styles).toContain('.hstar-generative-prompt-editor[data-placeholder]:empty::before');
    const tokenRule = styles.match(/\.hstar-generative-mention-token\s*\{([^}]*)\}/)?.[1] || '';
    expect(tokenRule).toMatch(/background:\s*#2563eb/);
    expect(tokenRule).toMatch(/border-radius:\s*999px/);
    expect(tokenRule).toMatch(/max-width:\s*100%/);
    expect(tokenRule).toMatch(/text-overflow:\s*ellipsis/);
  });

  it('clears the active selection when the user closes a generative tool', async () => {
    const {controller, editor} = createHarness();
    editor._selectionBounds = {x:10, y:20, w:300, h:200};
    editor._selectionRegions = [{x:10, y:20, w:300, h:200}];
    await controller.start();

    controller.openTool('local-redraw');
    controller.close();

    expect(editor.clearSelection).toHaveBeenCalledTimes(1);
    expect(controller.getState().activeTool).toBe('');
    expect(controller.getState().selectionRegions).toEqual([]);
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
    expect(generated.every(layer => JSON.stringify(layer.objects[0].hstarSnapAnchor) === JSON.stringify({
      type:'selection', x:10, y:20, width:300, height:200,
      documentWidth:1920, documentHeight:1080,
    }))).toBe(true);
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
    openToolWithSelection(controller, editor, 'local-redraw');
    const prompt = document.querySelector('[data-generative-prompt]');
    setPrompt(prompt, '修改天空');
    document.querySelector('[data-generative-menu-trigger="count"]').click();
    document.querySelector('[data-generative-count-option="4"]').click();
    await controller.submit();

    const completed = await controller.retryMissing();

    expect(generativeClient.retryMissing).toHaveBeenCalledWith(context, 'parent-1');
    expect(completed.taskId).toBe('parent-retry');
    expect(editor.layers.find(layer => layer.hstarAiGeneration?.childTaskId === 'child-retry-1')?.name)
      .toBe('局部重绘 2/4');
    controller.destroy();
  });

  it('resumes persisted background tasks and pending children when a project loads', async () => {
    const restored = generationTask({
      taskId:'parent-restored', status:'succeeded', targetCount:1, completedCount:1, failedCount:0,
      children:[{childTaskId:'child-restored', index:0, status:'succeeded', outputAssetId:'7'.repeat(64)}],
    });
    const {controller, editor, generativeClient} = createHarness({restoredTasks:[restored]});
    editor.__hstarAiTaskRecords = [{...restored, status:'running', children:[]}];
    editor.__hstarAiPendingResults = [{
      task:generationTask({taskId:'parent-pending', status:'succeeded'}),
      child:{childTaskId:'child-pending', index:1, status:'succeeded', outputAssetId:'8'.repeat(64)},
    }];
    await controller.start();

    window.dispatchEvent(new CustomEvent('openshop:project-loaded'));
    await vi.waitFor(() => {
      expect(editor.layers.some(layer => layer.hstarAiGeneration?.childTaskId === 'child-restored')).toBe(true);
      expect(editor.layers.some(layer => layer.hstarAiGeneration?.childTaskId === 'child-pending')).toBe(true);
    });

    expect(generativeClient.restoreTasks).toHaveBeenCalledWith(
      [expect.objectContaining({taskId:'parent-restored', status:'running'})],
      expect.objectContaining({onUpdate:expect.any(Function)}),
    );
    expect(editor.__hstarAiPendingResults).toEqual([]);
    controller.destroy();
  });
});
