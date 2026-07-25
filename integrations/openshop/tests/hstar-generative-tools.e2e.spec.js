import { expect, test } from '@playwright/test';
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const canvasCleanup = createTestCanvasCleanup(baseUrl);
const openshopUrl = `${baseUrl}/static/openshop/index.html`;
const sourceImage = '/static/images/logo.png';

test.describe.configure({mode:'serial'});

test.afterEach(async ({page, request}) => {
  await page.close();
  await canvasCleanup.purgeAll(request);
});

function capabilityCatalog(){
  const provider = {
    id:'e2e-image-api', name:'E2E 图像 API', available:true,
    models:[{
      id:'e2e-image-model-with-a-long-descriptive-name',
      name:'E2E 图像模型（最长名称布局验证）',
      available:true,
      capabilities:{
        maxOutputs:5,
        maxReferenceImages:12,
        sizes:['auto', '2048x2048'],
        qualities:['auto', 'high'],
      },
    }],
  };
  return {
    primaryProviderId:provider.id,
    tools:{
      'generative-fill':{id:'generative-fill', label:'生成式填充', providers:[provider]},
      'local-redraw':{id:'local-redraw', label:'局部重绘', providers:[provider]},
    },
  };
}

async function prepareDirectEditor(page){
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopReferenceManager
    && window.HstarOpenShopGenerativeTools
  ));
  await page.evaluate(async () => {
    const welcome = document.getElementById('welcome-overlay');
    if(welcome) welcome.style.display = 'none';
    OS.createNewDocument(800, 600);
    const sourceLayer = OS.layers[OS.activeLayerIdx];
    sourceLayer.layerId = 'source-layer';
    sourceLayer.objects.forEach(object => { object.hstarLayerId = 'source-layer'; });
    OS.updateLayersPanel();
    const context = {
      canvasType:'classic', canvasId:'visual-canvas', nodeId:'visual-node', projectId:'visual-project',
    };
    const runtime = {
      getState:() => ({activeSession:{context}}),
      requestSave:async () => {
        window.__generativeE2E.saveCount += 1;
        return {ok:true};
      },
    };
    const catalog = {
      primaryProviderId:'e2e-image-api',
      tools:{
        'generative-fill':{id:'generative-fill', providers:[{
          id:'e2e-image-api', name:'E2E 图像 API', available:true,
          models:[{
            id:'e2e-image-model-with-a-long-descriptive-name',
            name:'E2E 图像模型（最长名称布局验证）', available:true,
            capabilities:{maxOutputs:5, maxReferenceImages:12, sizes:['auto', '2048x2048'], qualities:['auto', 'high']},
          }],
        }]},
        'local-redraw':{id:'local-redraw', providers:[{
          id:'e2e-image-api', name:'E2E 图像 API', available:true,
          models:[{
            id:'e2e-image-model-with-a-long-descriptive-name',
            name:'E2E 图像模型（最长名称布局验证）', available:true,
            capabilities:{maxOutputs:5, maxReferenceImages:12, sizes:['auto', '2048x2048'], qualities:['auto', 'high']},
          }],
        }]},
      },
    };
    const aiClient = {
      loadCatalog:async () => catalog,
      subscribe:() => () => {},
      getCatalog:() => catalog,
      resolvePreference(toolId) {
        const provider = catalog.tools[toolId].providers[0];
        const model = provider.models[0];
        return {
          available:true, mode:'global', apiConfigId:provider.id, modelId:model.id,
          providerName:provider.name, modelName:model.name,
        };
      },
    };
    let assetSequence = 0;
    const assetApi = {
      async upload(payload){
        assetSequence += 1;
        const assetId = assetSequence.toString(16).padStart(64, '0');
        return {assetId, url:`/api/openshop/assets/${assetId}`, width:payload.width || 800, height:payload.height || 600};
      },
    };
    const outputIds = ['d', 'e', 'f', 'a', 'b'].map(value => value.repeat(64));
    let frozenRequest = null;
    const taskFor = (taskId, status, children, retryOfTaskId='') => ({
      taskId, kind:'parent', toolId:'local-redraw', status,
      targetCount:children.length, completedCount:children.filter(child => child.status === 'succeeded').length,
      failedCount:children.filter(child => child.status === 'failed').length,
      apiConfigId:'e2e-image-api', modelId:'e2e-image-model-with-a-long-descriptive-name',
      retryOfTaskId,
      snapshot:{...frozenRequest, originalTargetCount:5},
      children,
    });
    const initialChildren = [0, 1, 2, 3, 4].map(index => index === 1
      ? {childTaskId:`child-${index}`, index, status:'failed', outputAssetId:'', error:'timeout'}
      : {childTaskId:`child-${index}`, index, status:'succeeded', outputAssetId:outputIds[index], result:{url:'/static/images/logo.png'}});
    const generativeClient = {
      startSession(){}, stopSession(){}, restoreTasks:async () => [], cancelTask:async (_context, taskId) => ({taskId, status:'cancelled'}),
      async createTask(_context, request){
        frozenRequest = structuredClone(request);
        return {task_id:'parent-1', status:'queued', task:taskFor('parent-1', 'queued', initialChildren)};
      },
      async pollTask(_context, taskId, options={}){
        options.onUpdate?.({...taskFor(taskId, 'running', initialChildren), completedCount:2, failedCount:0});
        await new Promise(resolve => setTimeout(resolve, 30));
        if(taskId === 'parent-retry'){
          return taskFor('parent-retry', 'succeeded', [{
            childTaskId:'child-retry-1', index:1, status:'succeeded', outputAssetId:'c'.repeat(64), result:{url:'/static/images/logo.png'},
          }], 'parent-1');
        }
        return taskFor('parent-1', 'partial', initialChildren);
      },
      async retryMissing(){
        return {task_id:'parent-retry', status:'queued', task:taskFor('parent-retry', 'queued', [{
          childTaskId:'child-retry-1', index:1, status:'queued', outputAssetId:'',
        }], 'parent-1')};
      },
    };
    window.__generativeE2E = {context, saveCount:0, getRequest:() => frozenRequest};
    const referenceManager = window.HstarOpenShopReferenceManager.createManager({
      editor:OS,
      runtime,
      assetApi,
      assetExists:async () => true,
    });
    const controller = window.HstarOpenShopGenerativeTools.createController({
      editor:OS,
      runtime,
      aiClient,
      generativeClient,
      assetApi,
      referenceManager,
      fabricRef:window.fabric,
    });
    window.__generativeE2E.referenceManager = referenceManager;
    window.__generativeE2E.controller = controller;
    await controller.start();
  });
}

async function dragSelection(page, {
  startX = 100,
  startY = 100,
  endX = 360,
  endY = 280,
} = {}){
  const canvas = page.locator('.upper-canvas');
  const box = await canvas.boundingBox();
  expect(box).not.toBeNull();
  await page.mouse.move(box.x + startX, box.y + startY);
  await page.mouse.down();
  await page.mouse.move(box.x + endX, box.y + endY, {steps:8});
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => Boolean(OS._selectionBounds))).toBe(true);
}

for(const tool of [
  {id:'generative-fill', name:'生成式填充'},
  {id:'local-redraw', name:'局部重绘'},
]){
  test(`${tool.name} starts compact and inserts a blue selection mention`, async ({page}) => {
    await prepareDirectEditor(page);
    await page.getByRole('button', {name:tool.name}).click();

    const bar = page.locator('[data-generative-operation-bar]');
    await expect(bar).toBeVisible();
    await expect(bar).toHaveClass(/is-collapsed/);
    await expect.poll(() => page.evaluate(() => Boolean(OS._selectionBounds))).toBe(false);

    await dragSelection(page, {startX:80, startY:80, endX:220, endY:190});
    await expect(bar).not.toHaveClass(/is-collapsed/);
    await expect(page.locator('[data-reference-thumbnail]')).toHaveCount(1);

    const prompt = page.locator('[data-generative-prompt]');
    await expect(prompt).toHaveAttribute('contenteditable', 'true');
    await prompt.fill('@');
    await page.locator('[data-reference-mention="@选区1"]').click();

    const token = prompt.locator('[data-generative-mention-token]');
    await expect(token).toHaveText('@选区1');
    await expect(token).toHaveAttribute('contenteditable', 'false');
    await expect(token).toHaveCSS('background-color', 'rgb(37, 99, 235)');
    await expect(token).toHaveCSS('border-radius', '999px');
  });
}

test('keeps empty guidance separated and numbers additive selections', async ({page}) => {
  await page.setViewportSize({width:1440, height:1000});
  await prepareDirectEditor(page);
  await page.getByRole('button', {name:'局部重绘'}).click();

  const bar = page.locator('[data-generative-operation-bar]');
  const hint = page.locator('[data-generative-selection-hint]');
  const feedback = page.locator('.hstar-generative-feedback');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/is-collapsed/);
  await expect(hint).toBeHidden();
  await expect(feedback).toBeHidden();

  await dragSelection(page, {startX:80, startY:80, endX:220, endY:190});
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/is-collapsed/);
  await expect(feedback).toBeVisible();
  await expect.poll(() => page.evaluate(() => ({
    status:window.__generativeE2E.controller.getState().status,
    error:window.__generativeE2E.controller.getState().error,
  }))).toEqual({status:'ready', error:''});
  await expect(page.locator('body')).not.toContainText('发生错误，请查看控制台');
  await expect(page.locator('.hstar-selection-region-marker')).toHaveText(['1']);

  const zoomButton = bar.locator('[data-generative-action="zoom-panel"]');
  await expect(zoomButton).toHaveAttribute('aria-label', '缩放面板');
  await zoomButton.click();
  await expect(bar).toHaveClass(/is-collapsed/);
  await expect(zoomButton).toHaveAttribute('aria-label', '恢复面板');
  await expect(bar.locator('[data-generative-workbench-top]')).toBeVisible();

  await page.keyboard.down('Shift');
  await dragSelection(page, {startX:330, startY:250, endX:470, endY:370});
  await page.keyboard.up('Shift');
  await expect.poll(() => page.evaluate(() => OS._selectionRegions.length)).toBe(2);
  await expect(page.locator('.hstar-selection-region-marker')).toHaveText(['1', '2']);
  await expect.poll(() => page.locator('[data-reference-thumbnail]').count()).toBe(2);
  await expect(bar).not.toHaveClass(/is-collapsed/);
  await expect(zoomButton).toHaveAttribute('aria-label', '缩放面板');
  await expect(bar).not.toHaveClass(/is-expanded/);
  const thumbnailFit = await page.locator('[data-primary-reference-thumbnail] img').evaluate(element => ({
    fit:getComputedStyle(element).objectFit,
    position:getComputedStyle(element).objectPosition,
  }));
  expect(thumbnailFit).toEqual({fit:'cover', position:'50% 50%'});
  await page.locator('.hstar-primary-reference .hstar-reference-delete').click();
  await expect.poll(() => page.evaluate(() => OS._selectionRegions.length)).toBe(1);
  await expect.poll(() => page.locator('[data-reference-thumbnail]').count()).toBe(1);
});

test('adds a library reference after transient selections with contiguous persisted order', async ({page}) => {
  await page.route('**/api/asset-library', route => route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify({library:{libraries:[{
      id:'library-e2e',
      name:'E2E 素材库',
      categories:[{
        id:'category-e2e',
        name:'图片',
        type:'image',
        items:[{
          id:'item-e2e',
          name:'素材图',
          kind:'image',
          url:'/static/images/logo.png',
        }],
      }],
    }]}}),
  }));
  await page.route('**/api/openshop/projects/visual-project/asset-imports', route => route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify({asset:{
      assetId:'9'.repeat(64),
      url:'/static/images/logo.png',
      width:512,
      height:512,
      role:'ai-reference',
    }}),
  }));
  await prepareDirectEditor(page);
  await page.getByRole('button', {name:'局部重绘'}).click();
  await dragSelection(page, {startX:80, startY:80, endX:220, endY:190});
  await page.keyboard.down('Shift');
  await dragSelection(page, {startX:330, startY:250, endX:470, endY:370});
  await page.keyboard.up('Shift');

  await page.locator('[data-generative-action="toggle-reference-menu"]').click();
  await page.locator('[data-reference-add="library"]').click();
  await page.getByRole('dialog', {name:'选择素材库参考图'}).getByRole('button', {name:/素材图/}).click();

  await expect.poll(() => page.evaluate(() => OS.__hstarAiReferenceRecords)).toEqual([expect.objectContaining({
    sourceType:'library',
    alias:'参考图1',
    order:0,
  })]);
  await expect(page.locator('body')).not.toContainText('OpenShop reference order must be contiguous');
  await expect.poll(() => page.evaluate(() => window.__generativeE2E.controller.getState().error)).toBe('');
});

test('crops selection thumbnails in document coordinates after zoom and pan', async ({page}) => {
  await prepareDirectEditor(page);
  await page.getByRole('button', {name:'局部重绘'}).click();
  await page.evaluate(() => {
    const region = {x:400, y:0, w:400, h:300};
    const block = new fabric.Rect({
      left:region.x,
      top:region.y,
      width:region.w,
      height:region.h,
      fill:'#16c784',
      strokeWidth:0,
      selectable:false,
    });
    OS.canvas.add(block);
    OS.layers[OS.activeLayerIdx].objects.push(block);
    OS.canvas.viewportTransform = [0.5, 0, 0, 0.5, 240, 160];
    OS._selectionBounds = {x:440, y:160, w:200, h:150};
    OS._selectionDocumentBounds = {...region};
    OS._selectionRegions = [{...region}];
    OS.canvas.renderAll();
    window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
      detail:{
        reason:'marquee',
        hasSelection:true,
        bounds:{...region},
        screenBounds:{...OS._selectionBounds},
        regions:[{...region}],
        regionCount:1,
        incomingBounds:{...region},
      },
    }));
  });
  const thumbnail = page.locator('[data-primary-reference-thumbnail] img');
  await expect(thumbnail).toBeVisible();
  const sample = await thumbnail.evaluate(async image => {
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.naturalWidth;
    canvas.height = image.naturalHeight;
    const context = canvas.getContext('2d');
    context.drawImage(image, 0, 0);
    const pixel = context.getImageData(
      Math.floor(canvas.width / 2),
      Math.floor(canvas.height / 2),
      1,
      1,
    ).data;
    return {width:canvas.width, height:canvas.height, pixel:Array.from(pixel)};
  });

  expect(sample.width).toBe(400);
  expect(sample.height).toBe(300);
  expect(sample.pixel[0]).toBeLessThan(40);
  expect(sample.pixel[1]).toBeGreaterThan(180);
  expect(sample.pixel[2]).toBeGreaterThan(100);
  expect(sample.pixel[3]).toBe(255);
});

test('runs selection, references, multi-output layers and retry in the inline editor', async ({page}) => {
  test.setTimeout(120000);
  await prepareDirectEditor(page);
  const fill = page.getByRole('button', {name:'生成式填充'});
  const redraw = page.getByRole('button', {name:'局部重绘'});
  await expect(fill).toBeEnabled();
  await expect(redraw).toBeEnabled();
  await redraw.click();
  expect(await page.evaluate(() => OS.state.tool)).toBe('marquee-rect');
  expect(await page.evaluate(() => window.__generativeE2E.getRequest())).toBeNull();

  const bar = page.locator('[data-generative-operation-bar]');
  await expect(bar).toBeVisible();
  await expect(bar).toHaveClass(/is-collapsed/);

  await dragSelection(page);
  await expect(bar).toBeVisible();
  await expect(bar).not.toHaveClass(/is-collapsed/);
  await expect(bar).not.toHaveClass(/is-expanded/);
  const thumbnail = page.locator('[data-primary-reference-thumbnail] img');
  await expect(thumbnail).toBeVisible();
  const selectionThumbnail = await thumbnail.getAttribute('src');
  await expect(page.locator('[data-reference-mode="selection"]')).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => ({
    mode:window.__generativeE2E.controller.getState().referenceMode,
    primaryType:window.__generativeE2E.referenceManager.getPrimary()?.sourceType,
  }))).toMatchObject({mode:'selection', primaryType:'selection'});
  await page.locator('[data-reference-mode="full"]').click();
  await expect.poll(() => page.evaluate(() => ({
    mode:window.__generativeE2E.controller.getState().referenceMode,
    primaryType:window.__generativeE2E.referenceManager.getPrimary()?.sourceType,
  }))).toMatchObject({mode:'full', primaryType:'primary'});
  const fullThumbnail = await thumbnail.getAttribute('src');
  expect(fullThumbnail).not.toBe(selectionThumbnail);
  await expect.poll(() => page.evaluate(() => {
    const primary = window.__generativeE2E.referenceManager.getPrimary();
    return {width:primary?.width, height:primary?.height, canvasWidth:OS.canvasW, canvasHeight:OS.canvasH};
  })).toEqual({width:800, height:600, canvasWidth:800, canvasHeight:600});
  await page.locator('[data-reference-mode="selection"]').click();
  await expect.poll(() => page.evaluate(() => ({
    mode:window.__generativeE2E.controller.getState().referenceMode,
    primaryType:window.__generativeE2E.referenceManager.getPrimary()?.sourceType,
  }))).toMatchObject({mode:'selection', primaryType:'selection'});
  await expect.poll(() => thumbnail.getAttribute('src')).not.toBe(fullThumbnail);

  await page.locator('[data-generative-action="toggle-reference-menu"]').click();
  await page.locator('[data-reference-add="selection"]').click();
  await page.locator('[data-generative-action="toggle-reference-menu"]').click();
  await page.locator('[data-reference-add="layer"]').click();
  await expect.poll(() => page.evaluate(() => window.__generativeE2E.referenceManager.list().length)).toBe(3);

  const prompt = page.locator('[data-generative-prompt]');
  await prompt.fill('@');
  await page.locator('[data-reference-mention="@参考图1"]').click();
  await expect(prompt).toContainText('@参考图1');
  const mentionToken = prompt.locator('[data-generative-mention-token]');
  await expect(mentionToken).toHaveCount(1);
  await expect(mentionToken).toHaveCSS('background-color', 'rgb(37, 99, 235)');
  await expect(mentionToken).toHaveCSS('border-radius', '999px');
  await prompt.fill('把选区改成 @参考图1 的材质');
  await page.locator('[data-generative-menu-trigger="count"]').click();
  await page.locator('[data-generative-count-option="5"]').click();
  await page.locator('[data-generative-submit]').click();

  await expect.poll(() => page.evaluate(() => OS.layers.filter(layer => layer.hstarAiGeneration).length)).toBe(4);
  await expect(page.getByRole('button', {name:/补生成剩余 1 张/})).toBeVisible();
  await page.getByRole('button', {name:/补生成剩余 1 张/}).click();
  await expect.poll(() => page.evaluate(() => OS.layers.filter(layer => layer.hstarAiGeneration).length)).toBe(5);

  const snapResult = await page.evaluate(() => {
    const layer = OS.layers.find(item => item.hstarAiGeneration?.toolId === 'local-redraw');
    const object = layer.objects[0];
    const original = {
      left:object.left,
      top:object.top,
      scaleX:object.scaleX,
      scaleY:object.scaleY,
    };
    object.set({
      left:3,
      top:2,
      scaleX:OS.canvasW / object.width,
      scaleY:OS.canvasH / object.height,
    });
    object.setCoords();
    OS.canvas.fire('object:moving', {target:object});
    const snapped = {left:object.left, top:object.top};
    object.set({left:80, top:0});
    object.setCoords();
    OS.canvas.fire('object:moving', {target:object});
    const released = {left:object.left, top:object.top};
    const anchor = structuredClone(object.hstarSnapAnchor || null);
    const selection = structuredClone(layer.hstarAiGeneration.selection);
    object.set(original);
    object.setCoords();
    return {snapped, released, anchor, selection};
  });

  expect(snapResult.snapped).toEqual({left:0, top:0});
  expect(snapResult.released.left).toBe(80);
  expect(snapResult.anchor).toMatchObject({
    type:'selection',
    documentWidth:800,
    documentHeight:600,
  });
  expect(snapResult.anchor).toMatchObject({
    x:snapResult.selection.x,
    y:snapResult.selection.y,
    width:snapResult.selection.width,
    height:snapResult.selection.height,
  });

  const result = await page.evaluate(() => ({
    layers:OS.layers.filter(layer => layer.hstarAiGeneration).map(layer => ({
      name:layer.name,
      visible:layer.visible,
      left:layer.objects[0]?.left,
      top:layer.objects[0]?.top,
      metadata:layer.hstarAiGeneration,
    })),
    request:window.__generativeE2E.getRequest(),
    saveCount:window.__generativeE2E.saveCount,
  }));
  expect(result.layers.map(layer => layer.name).sort()).toEqual([
    '局部重绘 1/5', '局部重绘 2/5', '局部重绘 3/5', '局部重绘 4/5', '局部重绘 5/5',
  ].sort());
  expect(result.layers.every(layer => layer.visible && layer.left === 0 && layer.top === 0)).toBe(true);
  expect(result.request.targetCount).toBe(5);
  expect(result.request.references).toHaveLength(3);
  expect(result.saveCount).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(result)).not.toMatch(/seed|data:image\/|blob:/i);
  await expect(page.locator('[data-generative-seed]')).toHaveCount(0);
});

async function expectNoOverlap(leftLocator, rightLocator){
  const left = await leftLocator.boundingBox();
  const right = await rightLocator.boundingBox();
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  const separated = left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y;
  expect(separated).toBe(true);
}

for(const viewport of [
  {width:1440, height:1000, name:'1440'},
  {width:1920, height:1080, name:'1920'},
  {width:430, height:932, name:'mobile'},
  {width:4096, height:4096, name:'4k'},
]){
  test(`keeps the inline operation bar framed at ${viewport.name}`, async ({page}, testInfo) => {
    test.setTimeout(120000);
    await page.setViewportSize({width:viewport.width, height:viewport.height});
    await prepareDirectEditor(page);
    await page.getByRole('button', {name:'局部重绘'}).click();
    await page.evaluate(() => {
      const region = {x:80, y:60, w:300, h:220};
      OS._selectionBounds = {...region};
      OS._selectionDocumentBounds = {...region};
      OS._selectionRegions = [{...region}];
      window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
        detail:{reason:'marquee', hasSelection:true, regions:[{...region}], regionCount:1},
      }));
    });
    const bar = page.locator('[data-generative-operation-bar]');
    const prompt = page.locator('[data-generative-prompt]');
    await prompt.fill('@');
    await expect(page.locator('[data-reference-mention-picker]')).toBeVisible();
    const panels = page.locator('#panels');
    const statusbar = page.locator('#statusbar');
    const toolbar = page.locator('#toolbar');
    await expect(bar).toBeVisible();
    if(await panels.isVisible()) await expectNoOverlap(bar, panels);
    if(await statusbar.isVisible()) await expectNoOverlap(bar, statusbar);
    if(await toolbar.isVisible()) await expectNoOverlap(bar, toolbar);
    const modelLayout = await page.locator('[data-generative-model]').evaluate(element => {
      const content = element.getBoundingClientRect();
      const button = element.closest('button').getBoundingClientRect();
      return {
        contained:content.left >= button.left && content.right <= button.right + 1,
        overflow:getComputedStyle(element).overflow,
      };
    });
    expect(modelLayout.contained).toBe(true);
    expect(modelLayout.overflow).toBe('hidden');
    const pickerBox = await page.locator('[data-reference-mention-picker]').boundingBox();
    expect(pickerBox.x).toBeGreaterThanOrEqual(0);
    expect(pickerBox.y).toBeGreaterThanOrEqual(0);
    expect(pickerBox.x + pickerBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(pickerBox.y + pickerBox.height).toBeLessThanOrEqual(viewport.height + 1);
    const submitBox = await page.locator('[data-generative-submit]').boundingBox();
    expect(submitBox).not.toBeNull();
    expect(submitBox.x).toBeGreaterThanOrEqual(0);
    expect(submitBox.x + submitBox.width).toBeLessThanOrEqual(viewport.width + 1);
    const barBox = await bar.boundingBox();
    if(viewport.width >= 900){
      expect(barBox.width).toBeLessThanOrEqual(940);
      expect(barBox.height).toBeLessThanOrEqual(420);
      const typography = await page.locator('[data-generative-prompt]').evaluate(element => ({
        prompt:Number.parseFloat(getComputedStyle(element).fontSize),
        mode:Number.parseFloat(getComputedStyle(document.querySelector('.hstar-generative-mode-chip strong')).fontSize),
      }));
      expect(typography.prompt).toBeLessThanOrEqual(12);
      expect(typography.mode).toBeLessThanOrEqual(11);
    }
    expect(submitBox.y).toBeGreaterThanOrEqual(barBox.y);
    expect(submitBox.y + submitBox.height).toBeLessThanOrEqual(barBox.y + barBox.height + 1);
    const modeBoxes = await page.locator('[data-reference-mode]').evaluateAll(elements => (
      elements.map(element => element.getBoundingClientRect().height)
    ));
    expect(modeBoxes.every(height => height <= 30)).toBe(true);

    await prompt.fill('test prompt');
    await page.locator('[data-generative-menu-trigger="resolution"]').click();
    const resolutionMenu = page.locator('[data-generative-popover="resolution"]');
    await expect(resolutionMenu).toBeVisible();
    for(const value of ['auto', '1k', '2k', '4k', 'custom']) {
      await expect(resolutionMenu.locator(`[data-generative-size-resolution="${value}"]`)).toBeVisible();
    }
    const resolutionBox = await resolutionMenu.boundingBox();
    expect(resolutionBox.x).toBeGreaterThanOrEqual(0);
    expect(resolutionBox.y).toBeGreaterThanOrEqual(0);
    expect(resolutionBox.x + resolutionBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(resolutionBox.y + resolutionBox.height).toBeLessThanOrEqual(viewport.height + 1);
    await resolutionMenu.locator('[data-generative-size-resolution="2k"]').click();
    await expect(page.locator('[data-generative-menu-trigger="resolution"]')).toContainText('2K');

    await page.locator('[data-generative-menu-trigger="ratio"]').click();
    const ratioMenu = page.locator('[data-generative-popover="ratio"]');
    await expect(ratioMenu).toBeVisible();
    for(const value of ['selection', 'square', 'portrait', 'landscape', 'portrait43', 'landscape43', 'story', 'wide', 'ultrawide', 'ultratall', 'source', 'custom']) {
      await expect(ratioMenu.locator(`[data-generative-size-ratio="${value}"]`)).toBeVisible();
    }
    const ratioBox = await ratioMenu.boundingBox();
    expect(ratioBox.x).toBeGreaterThanOrEqual(0);
    expect(ratioBox.y).toBeGreaterThanOrEqual(0);
    expect(ratioBox.x + ratioBox.width).toBeLessThanOrEqual(viewport.width + 1);
    expect(ratioBox.y + ratioBox.height).toBeLessThanOrEqual(viewport.height + 1);
    await page.screenshot({path:testInfo.outputPath(`openshop-generative-${viewport.name}.png`), fullPage:true});
  });
}

async function apiJson(response){
  const value = await response.json().catch(() => ({}));
  expect(response.ok(), JSON.stringify(value)).toBeTruthy();
  return value;
}

async function createCanvas(request, nodes, connections){
  await canvasCleanup.assertStorageIsolated(request);
  const created = await apiJson(await request.post(`${baseUrl}/api/canvases`, {
    data:{kind:'classic', title:'OpenShop background generation', icon:'layers'},
  }));
  canvasCleanup.track(created.canvas);
  return (await apiJson(await request.put(`${baseUrl}/api/canvases/${created.canvas.id}`, {
    data:{
      title:'OpenShop background generation', icon:'layers', nodes, connections,
      viewport:{x:0, y:0, scale:1}, logs:[], settings:{},
      base_updated_at:created.canvas.updated_at, client_id:'openshop-generative-e2e',
    },
  }))).canvas;
}

async function installHeldGenerationRoutes(page){
  const held = [];
  const tasks = new Map();
  let sequence = 0;
  await page.route('**/api/openshop/ai/catalog', route => route.fulfill({
    status:200, contentType:'application/json', body:JSON.stringify(capabilityCatalog()),
  }));
  await page.route(/\/api\/openshop\/projects\/[^/]+\/ai-tasks(?:\?.*)?$/, async route => {
    if(route.request().method() !== 'POST'){ await route.continue(); return; }
    sequence += 1;
    const taskId = `held-parent-${sequence}`;
    const body = route.request().postDataJSON();
    const task = {
      taskId, kind:'parent', toolId:body.tool_id, status:'queued', targetCount:body.target_count,
      completedCount:0, failedCount:0, apiConfigId:body.provider_id, modelId:body.model_id,
      snapshot:{
        toolId:body.tool_id, sourceAssetId:body.source_asset_id, maskAssetId:body.mask_asset_id,
        primaryReferenceAssetId:body.primary_reference_asset_id, references:body.reference_assets,
        prompt:body.prompt, size:body.size, quality:body.quality, targetCount:body.target_count,
        originalTargetCount:body.target_count, referenceMode:body.reference_mode,
        sourceLayerId:body.source_layer_id, sourceLayerIndex:body.source_layer_index,
        document:body.document, selection:body.selection,
      },
      children:[],
    };
    tasks.set(taskId, task);
    await route.fulfill({status:200, contentType:'application/json', body:JSON.stringify({task_id:taskId, status:'queued', task})});
  });
  await page.route(/\/api\/openshop\/projects\/[^/]+\/ai-tasks\/([^/?]+)(?:\?.*)?$/, async route => {
    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    const task = tasks.get(taskId);
    if(!task){
      await route.fulfill({status:404, contentType:'application/json', body:JSON.stringify({detail:'missing task'})});
      return;
    }
    held.push({route, task});
  });
  return {
    held,
    async releaseOne(){
      const item = held.shift();
      expect(item).toBeTruthy();
      const children = Array.from({length:item.task.targetCount}, (_, index) => ({
        childTaskId:`${item.task.taskId}-child-${index}`, index, status:'succeeded',
        outputAssetId:(index + 10).toString(16).repeat(64).slice(0, 64),
        result:{url:'/static/images/logo.png'},
      }));
      await item.route.fulfill({
        status:200,
        contentType:'application/json',
        body:JSON.stringify({task:{
          ...item.task, status:'succeeded', completedCount:children.length, failedCount:0, children,
        }}),
      });
    },
  };
}

test('keeps a node generation running while another OpenShop project is active', async ({page, request}) => {
  test.setTimeout(180000);
  const routes = await installHeldGenerationRoutes(page);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {id:'source', type:'image', x:60, y:100, w:280, h:220, url:sourceImage, name:'来源.png', mediaKind:'image'};
  const baseNode = {
    type:'openshop-layered', x:480, y:120, w:340, h:260,
    documentWidth:800, documentHeight:600, layerCount:0, sourceUpdateCount:0,
    autosaveVersion:0, saveState:'new', aiStatus:'', aiTargetCount:0, aiCompletedCount:0, aiFailedCount:0,
    created_at:Date.now(),
  };
  const nodeA = {...baseNode, id:'background-node-a', projectId:`background_project_a_${runId}`, projectName:'后台项目 A'};
  const nodeB = {...baseNode, id:'background-node-b', projectId:`background_project_b_${runId}`, projectName:'项目 B', y:450};
  const canvas = await createCanvas(request, [image, nodeA, nodeB], [
    {id:'edge-a', from:image.id, to:nodeA.id},
    {id:'edge-b', from:image.id, to:nodeB.id},
  ]);

  await page.goto(baseUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(window.HstarOpenShopHost));
  await page.evaluate(src => {
    window.switchUI?.(null, 'canvas', {skipRemember:true});
    document.getElementById('frame-canvas').src = src;
  }, `/static/canvas.html?id=${canvas.id}&v=${Date.now()}`);
  const canvasFrame = await expect.poll(() => page.frames().find(frame => frame.url().includes(`canvas.html?id=${canvas.id}`)) || null).toBeTruthy();
  const frame = page.frames().find(candidate => candidate.url().includes(`canvas.html?id=${canvas.id}`));
  await frame.waitForFunction(() => Boolean(window.HstarClassicOpenShopAdapter));
  await frame.locator(`[data-open-openshop="${nodeA.id}"]`).waitFor();
  expect(await frame.evaluate(id => window.HstarClassicOpenShopAdapter.openNode(id), nodeA.id)).toBe(true);
  await expect.poll(() => page.evaluate(projectId => {
    const editorFrame = document.querySelector(`iframe.openshop-session-frame[data-project-id="${projectId}"]`);
    return {
      host:window.HstarOpenShopHost.getState(),
      editor:editorFrame?.contentWindow?.HstarOpenShopRuntime?.getState?.() || null,
    };
  }, nodeA.projectId), {timeout:15000}).toMatchObject({
    host:{activeSession:{context:{nodeId:nodeA.id}}, editorReady:true},
    editor:{activeSession:{context:{nodeId:nodeA.id}}, started:true},
  });
  const frameElementA = page.locator(`iframe.openshop-session-frame[data-project-id="${nodeA.projectId}"]`);
  const handleA = await frameElementA.elementHandle();
  const editorA = await handleA.contentFrame();
  await editorA.waitForFunction(() => Boolean(window.HstarOpenShopGenerativeToolsController));
  await editorA.evaluate(() => {
    document.querySelector('[data-hstar-generative-tool="local-redraw"]').click();
    const region = {x:80, y:70, w:260, h:180};
    OS._selectionBounds = {...region};
    OS._selectionDocumentBounds = {...region};
    OS._selectionRegions = [{...region}];
    window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
      detail:{reason:'marquee', hasSelection:true, regions:[{...region}], regionCount:1},
    }));
  });
  await editorA.waitForFunction(() => (
    window.HstarOpenShopGenerativeToolsController.getState().status === 'ready'
  ));
  await editorA.evaluate(() => {
    const prompt = document.querySelector('[data-generative-prompt]');
    prompt.textContent = '后台生成测试';
    prompt.dispatchEvent(new Event('input', {bubbles:true}));
    document.querySelector('[data-generative-menu-trigger="count"]').click();
    document.querySelector('[data-generative-count-option="2"]').click();
    window.__backgroundMarker = 'project-a-frame';
    document.querySelector('[data-generative-submit]').click();
  });
  await expect.poll(() => routes.held.length).toBe(1);

  await page.locator('[data-openshop-back]').click();
  await expect(page.locator('#openshop-host')).not.toHaveClass(/is-open/);
  await frame.evaluate(id => window.HstarClassicOpenShopAdapter.openNode(id), nodeB.id);
  await page.waitForFunction(id => window.HstarOpenShopHost.getState().activeSession?.context?.nodeId === id && window.HstarOpenShopHost.getState().editorReady, nodeB.id);
  await routes.releaseOne();
  await expect.poll(() => editorA.evaluate(() => OS.layers.filter(layer => layer.hstarAiGeneration).length)).toBe(2);

  await frame.evaluate(id => window.HstarClassicOpenShopAdapter.openNode(id), nodeA.id);
  await page.waitForFunction(id => window.HstarOpenShopHost.getState().activeSession?.context?.nodeId === id, nodeA.id);
  const reused = await frameElementA.elementHandle();
  expect(await reused.contentFrame()).toBe(editorA);
  expect(await editorA.evaluate(() => window.__backgroundMarker)).toBe('project-a-frame');
  expect(await editorA.evaluate(() => OS.layers.filter(layer => layer.hstarAiGeneration).length)).toBe(2);
});
