import { expect, test } from '@playwright/test';
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const canvasCleanup = createTestCanvasCleanup(baseUrl);
const SOURCE_IMAGE = '/static/images/logo.png';

test.describe.configure({mode:'serial'});

test.afterEach(async ({page, request}) => {
  await page.close();
  await canvasCleanup.purgeAll(request);
});

async function solidPngDataUrl(page, width, height) {
  return page.evaluate(({w, h}) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    context.fillStyle = '#1d4ed8';
    context.fillRect(0, 0, w, h);
    context.fillStyle = '#ffffff';
    context.font = '96px sans-serif';
    context.fillText(`${w} x ${h}`, 160, 220);
    return canvas.toDataURL('image/png');
  }, {w:width, h:height});
}

async function apiJson(response){
  const value = await response.json().catch(() => ({}));
  expect(response.ok(), JSON.stringify(value)).toBeTruthy();
  return value;
}

async function createCanvas(request, {kind, title, nodes, connections}){
  await canvasCleanup.assertStorageIsolated(request);
  const created = await apiJson(await request.post(`${baseUrl}/api/canvases`, {
    data:{kind, title, icon:kind === 'smart' ? 'sparkles' : 'layers'},
  }));
  canvasCleanup.track(created.canvas);
  const canvas = created.canvas;
  const saved = await apiJson(await request.put(`${baseUrl}/api/canvases/${canvas.id}`, {
    data:{
      title,
      icon:canvas.icon,
      nodes,
      connections,
      viewport:{x:0, y:0, scale:1},
      logs:[],
      settings:{},
      base_updated_at:canvas.updated_at,
      client_id:'openshop-text-tools-e2e',
    },
  }));
  return saved.canvas;
}

function canvasPage(kind, id){
  return `/static/${kind === 'smart' ? 'smart-canvas' : 'canvas'}.html?id=${encodeURIComponent(id)}&v=${Date.now()}`;
}

async function mountCanvas(page, kind, canvasId){
  if(!page.url().startsWith(baseUrl)){
    await page.goto(baseUrl, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.HstarOpenShopHost));
  }
  await page.evaluate(src => {
    document.getElementById('frame-canvas').src = src;
  }, canvasPage(kind, canvasId));
  await expect.poll(() => {
    const file = kind === 'smart' ? 'smart-canvas.html' : 'canvas.html';
    return page.frames().find(frame => frame.url().includes(file) && frame.url().includes(`id=${canvasId}`))?.url() || '';
  }).toContain(`id=${canvasId}`);
  const file = kind === 'smart' ? 'smart-canvas.html' : 'canvas.html';
  const frame = page.frames().find(candidate => candidate.url().includes(file) && candidate.url().includes(`id=${canvasId}`));
  await frame.waitForFunction(canvasKind => canvasKind === 'smart'
    ? Boolean(window.HstarSmartOpenShopAdapter && window.HstarSmartCanvasOpenShopHooks?.getNode)
    : Boolean(window.HstarClassicOpenShopAdapter && window.HstarClassicOpenShopHooks?.getNodes), kind);
  return frame;
}

async function openNode(page, canvasFrame, kind, nodeId, expectedSources){
  await canvasFrame.waitForFunction(({canvasKind, id}) => canvasKind === 'smart'
    ? Boolean(window.HstarSmartCanvasOpenShopHooks?.getNode?.(id))
    : Boolean(window.HstarClassicOpenShopHooks?.getNodes?.().some(node => node.id === id)), {canvasKind:kind, id:nodeId});
  const opened = await canvasFrame.evaluate(({canvasKind, id}) => canvasKind === 'smart'
    ? window.HstarSmartOpenShopAdapter.openNode(id)
    : window.HstarClassicOpenShopAdapter.openNode(id), {canvasKind:kind, id:nodeId});
  expect(opened).toBe(true);
  await page.waitForFunction(id => {
    const state = window.HstarOpenShopHost?.getState?.();
    return state?.activeSession?.context?.nodeId === id && state.editorReady;
  }, nodeId);
  const activeSession = await page.evaluate(() => window.HstarOpenShopHost.getState().activeSession);
  const frameElement = page.locator(`iframe.openshop-session-frame[data-project-id="${activeSession.context.projectId}"]`);
  await frameElement.waitFor();
  const editor = await (await frameElement.elementHandle()).contentFrame();
  await editor.waitForFunction(id => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopTextToolsController
    && window.HstarOpenShopRuntime?.getState?.().activeSession?.context?.nodeId === id
  ), nodeId);
  await expect(editor.locator('#welcome-overlay')).toBeHidden();
  await editor.waitForFunction(count => OS.layers.filter(layer => layer.sourceBinding).length >= count, expectedSources);
  return editor;
}

async function saveEditor(editor, reason){
  await editor.evaluate(value => window.HstarOpenShopRuntime.requestSave({reason:value}), reason);
}

function catalog(enabled = true){
  const provider = enabled ? [{
    id:'e2e-ai', name:'E2E AI', protocol:'openai', available:true,
    models:[
      {id:'e2e-vision', name:'e2e-vision', available:true},
      {id:'e2e-image', name:'e2e-image', available:true},
    ],
  }] : [];
  return {
    schemaVersion:1,
    primaryProviderId:enabled ? 'e2e-ai' : '',
    tools:{
      'text-extract':{id:'text-extract', label:'文字提取', capability:'structured-ocr-layout', providers:provider},
      'text-remove':{id:'text-remove', label:'去除文字', capability:'image-edit', providers:provider},
    },
  };
}

async function installAiRoutes(page, options = {}){
  let catalogEnabled = true;
  let sequence = 0;
  let holdNextRemoval = false;
  const tasks = new Map();
  const heldGets = [];
  const ocrBlocks = options.ocrBlocks || [
    {
      id:'zh', text:'中文标题', language:'zh-CN', confidence:0.97, lowConfidence:false,
      quad:[{x:0.08,y:0.12},{x:0.42,y:0.12},{x:0.42,y:0.22},{x:0.08,y:0.22}],
      font:{familyCandidates:['Microsoft YaHei UI'], size:52, weight:600, style:'normal'},
      color:'#111827', align:'left', rotation:0, paragraphId:'p1', lineIndex:0,
    },
    {
      id:'en', text:'English subtitle', language:'en', confidence:0.93, lowConfidence:false,
      quad:[{x:0.08,y:0.28},{x:0.52,y:0.28},{x:0.52,y:0.36},{x:0.08,y:0.36}],
      font:{familyCandidates:['Arial'], size:38, weight:400, style:'normal'},
      color:'#1f2937', align:'left', rotation:0, paragraphId:'p2', lineIndex:0,
    },
    {
      id:'mixed', text:'混排 Mixed 2026', language:'mixed', confidence:0.62, lowConfidence:true,
      quad:[{x:0.08,y:0.42},{x:0.48,y:0.42},{x:0.48,y:0.5},{x:0.08,y:0.5}],
      font:{familyCandidates:['Microsoft YaHei UI', 'Arial'], size:40, weight:500, style:'normal'},
      color:'#374151', align:'left', rotation:0, paragraphId:'p3', lineIndex:0,
    },
  ];

  await page.route('**/api/openshop/ai/catalog', route => route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify(catalog(catalogEnabled)),
  }));
  await page.route(/\/api\/openshop\/projects\/[^/]+\/ai-tasks(?:\?.*)?$/, async route => {
    if(route.request().method() !== 'POST'){
      await route.continue();
      return;
    }
    const body = route.request().postDataJSON();
    sequence += 1;
    const taskId = `e2e-task-${sequence}`;
    tasks.set(taskId, {
      body,
      held:body.tool_id === 'text-remove' && holdNextRemoval,
      cancelled:false,
    });
    holdNextRemoval = false;
    await route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify({task_id:taskId, status:'queued'}),
    });
  });
  await page.route(/\/api\/openshop\/projects\/[^/]+\/ai-tasks\/([^?]+)(?:\?.*)?$/, async route => {
    const taskId = decodeURIComponent(new URL(route.request().url()).pathname.split('/').at(-1));
    const task = tasks.get(taskId);
    if(!task){
      await route.fulfill({status:404, contentType:'application/json', body:JSON.stringify({detail:'missing task'})});
      return;
    }
    if(route.request().method() === 'DELETE'){
      task.cancelled = true;
      await route.fulfill({
        status:200,
        contentType:'application/json',
        body:JSON.stringify({ok:true, task:{taskId, status:'cancelled'}}),
      });
      return;
    }
    if(task.held){
      heldGets.push({route, taskId, task});
      return;
    }
    const result = task.body.tool_id === 'text-extract'
      ? {
          schemaVersion:1,
          width:Number(options.width || 1920),
          height:Number(options.height || 1080),
          blocks:ocrBlocks,
        }
      : {
          assetId:task.body.source_asset_id,
          url:`/api/openshop/assets/${task.body.source_asset_id}`,
          name:'e2e-removed.png', width:1920, height:1080, mime:'image/png',
        };
    await route.fulfill({
      status:200,
      contentType:'application/json',
      body:JSON.stringify({task:{taskId, status:'succeeded', result, outputAssetId:result.assetId || ''}}),
    });
  });

  return {
    ocrBlocks,
    disableCatalog(){ catalogEnabled = false; },
    holdRemoval(){ holdNextRemoval = true; },
    async releaseLateSuccess(){
      const held = heldGets.shift();
      expect(held, 'a delayed task GET should be waiting').toBeTruthy();
      const result = {
        assetId:held.task.body.source_asset_id,
        url:`/api/openshop/assets/${held.task.body.source_asset_id}`,
        name:'late-removed.png', width:1920, height:1080, mime:'image/png',
      };
      await held.route.fulfill({
        status:200,
        contentType:'application/json',
        body:JSON.stringify({task:{taskId:held.taskId, status:'succeeded', result, outputAssetId:result.assetId}}),
      });
    },
  };
}

async function projectRecord(request, context){
  const params = new URLSearchParams({
    canvas_type:context.canvasType,
    canvas_id:context.canvasId,
    node_id:context.nodeId,
  });
  return apiJson(await request.get(`${baseUrl}/api/openshop/projects/${context.projectId}?${params}`));
}

test('classic canvas keeps OCR, removal, cancellation and API state isolated per node', async ({page, request}) => {
  test.setTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const ai = await installAiRoutes(page);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:'text-source', type:'image', x:80, y:120, w:280, h:240,
    url:SOURCE_IMAGE, name:'文字测试源图.png', mediaKind:'image', assetVersion:'text-v1',
  };
  const baseNode = {
    type:'openshop-layered', x:560, y:160, w:340, h:260,
    documentWidth:1920, documentHeight:1080, layerCount:0,
    sourceUpdateCount:0, autosaveVersion:0, saveState:'new', created_at:Date.now(),
  };
  const nodeA = {...baseNode, id:'text-node-a', projectId:`e2e_text_project_a_${runId}`, projectName:'文字提取 A'};
  const nodeB = {...baseNode, id:'text-node-b', projectId:`e2e_text_project_b_${runId}`, projectName:'去字 B', y:500};
  const classic = await createCanvas(request, {
    kind:'classic',
    title:'OpenShop text tools classic E2E',
    nodes:[image, nodeA, nodeB],
    connections:[
      {id:'text-edge-a', from:image.id, to:nodeA.id},
      {id:'text-edge-b', from:image.id, to:nodeB.id},
    ],
  });

  const canvas = await mountCanvas(page, 'classic', classic.id);
  let editor = await openNode(page, canvas, 'classic', nodeA.id, 1);
  await editor.locator('[data-hstar-text-tool="text-extract"]').click();
  await expect(editor.locator('[data-text-provider]')).toHaveValue('e2e-ai');
  await expect(editor.locator('[data-text-model]')).toHaveValue('e2e-vision');
  await expect(editor.getByText('选择 API / 模型', {exact:true})).toHaveCount(0);
  await editor.locator('[data-hstar-action="run-extraction"]').click();
  await expect(editor.locator('.hstar-ocr-row')).toHaveCount(3);
  await expect(editor.locator('.hstar-ocr-confidence.low')).toContainText('低置信度');
  await editor.locator('[data-hstar-action="apply-extraction"]').click();
  await expect.poll(() => editor.evaluate(() => OS.canvas.getObjects()
    .filter(object => object.type === 'i-text')
    .map(object => object.text))).toEqual(ai.ocrBlocks.map(block => block.text));
  await saveEditor(editor, 'e2e-ocr');

  editor = await openNode(page, canvas, 'classic', nodeB.id, 1);
  await editor.evaluate(() => { OS._selectionBounds = {x:120, y:90, w:640, h:320}; });
  await editor.locator('[data-hstar-text-tool="text-remove"]').click();
  await editor.locator('[data-hstar-remove-mode="selection"]').click();
  await editor.locator('[data-hstar-action="run-removal"]').click();
  await editor.waitForFunction(() => OS.layers.some(layer => layer.name === '去除文字'));
  await saveEditor(editor, 'e2e-selection-removal');

  const layerCountBeforeCancel = await editor.evaluate(() => OS.layers.length);
  ai.holdRemoval();
  await editor.locator('[data-hstar-action="run-removal"]').click();
  await expect(editor.locator('[data-hstar-action="cancel"]')).toBeEnabled();
  await editor.locator('[data-hstar-action="cancel"]').click();
  await ai.releaseLateSuccess();
  await page.waitForTimeout(150);
  expect(await editor.evaluate(() => OS.layers.length)).toBe(layerCountBeforeCancel);
  expect(await editor.evaluate(() => OS.__hstarAiTaskRecords.at(-1).status)).toBe('cancelled');
  await saveEditor(editor, 'e2e-cancelled-removal');

  editor = await openNode(page, canvas, 'classic', nodeA.id, 1);
  const aSnapshot = await editor.evaluate(() => ({
    layerNames:OS.layers.map(layer => layer.name),
    texts:OS.canvas.getObjects().filter(object => object.type === 'i-text').map(object => object.text),
    records:OS.__hstarAiTaskRecords,
  }));
  expect(aSnapshot.texts).toEqual(ai.ocrBlocks.map(block => block.text));
  expect(aSnapshot.layerNames).not.toContain('去除文字');
  expect(aSnapshot.records).toHaveLength(1);
  expect(aSnapshot.records[0]).toMatchObject({toolId:'text-extract', status:'succeeded'});

  await editor.evaluate(() => {
    const sourceAssetId = OS.__hstarAiTaskRecords[0].sourceAssetId;
    OS.__hstarAiTaskRecords.push({
      taskId:'lost-after-service-restart', toolId:'text-extract', status:'running',
      apiConfigId:'e2e-ai', modelId:'e2e-vision', mode:'layer',
      sourceAssetId, maskAssetId:'', outputAssetId:'',
      createdAt:1, updatedAt:1, completedAt:0, appliedAt:0, error:'',
    });
    window.dispatchEvent(new CustomEvent('openshop:project-loaded', {
      detail:{project:{projectId:window.HstarOpenShopRuntime.getState().activeSession.context.projectId}},
    }));
  });
  await expect.poll(() => editor.evaluate(() => OS.__hstarAiTaskRecords.at(-1).status)).toBe('failed');
  expect(await editor.evaluate(() => OS.__hstarAiTaskRecords.at(-1).error)).toContain('恢复任务失败');
  await saveEditor(editor, 'e2e-lost-server-task');

  editor = await openNode(page, canvas, 'classic', nodeB.id, 1);
  const bSnapshot = await editor.evaluate(() => ({
    layerNames:OS.layers.map(layer => layer.name),
    texts:OS.canvas.getObjects().filter(object => object.type === 'i-text').map(object => object.text),
    records:OS.__hstarAiTaskRecords,
  }));
  expect(bSnapshot.texts).toEqual([]);
  expect(bSnapshot.layerNames).toContain('去除文字');
  expect(bSnapshot.records.map(record => record.status)).toEqual(['succeeded', 'cancelled']);

  ai.disableCatalog();
  await editor.evaluate(() => window.postMessage({type:'providers-changed'}, location.origin));
  await expect(editor.locator('#hstar-text-tools-panel')).toContainText('配置不可用');
  await expect(editor.locator('[data-hstar-action="run-removal"]')).toBeDisabled();

  const projectA = (await projectRecord(request, {
    canvasType:'classic', canvasId:classic.id, nodeId:nodeA.id, projectId:nodeA.projectId,
  })).project;
  const projectB = (await projectRecord(request, {
    canvasType:'classic', canvasId:classic.id, nodeId:nodeB.id, projectId:nodeB.projectId,
  })).project;
  expect(projectA.aiTaskRecords.map(record => record.toolId)).toEqual(['text-extract', 'text-extract']);
  expect(projectA.aiTaskRecords.map(record => record.status)).toEqual(['succeeded', 'failed']);
  expect(projectA.aiTaskRecords[0].sourceLayerId).toBeTruthy();
  expect(projectB.aiTaskRecords.map(record => record.toolId)).toEqual(['text-remove', 'text-remove']);
  expect(JSON.stringify([projectA, projectB])).not.toMatch(/apiKey|authorization|data:image\//i);
  expect(pageErrors).toEqual([]);
});

test('smart canvas runs the same text extraction workflow with smart project ownership', async ({page, request}) => {
  test.setTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const ai = await installAiRoutes(page);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:'smart-text-source', type:'smart-image', x:60, y:120,
    images:[{url:SOURCE_IMAGE, name:'智能文字源图.png', kind:'image', assetVersion:'smart-text-v1'}],
    created_at:Date.now(),
  };
  const node = {
    id:'smart-text-node', type:'openshop-layered', projectId:`e2e_smart_text_project_${runId}`,
    projectName:'智能文字提取', x:520, y:180, w:340, h:260,
    documentWidth:1920, documentHeight:1080, saveState:'new', inputNodeIds:[image.id], created_at:Date.now(),
  };
  const smart = await createCanvas(request, {
    kind:'smart',
    title:'OpenShop text tools smart E2E',
    nodes:[image, node],
    connections:[{id:'smart-text-edge', from:image.id, to:node.id, kind:'input'}],
  });

  const canvas = await mountCanvas(page, 'smart', smart.id);
  const editor = await openNode(page, canvas, 'smart', node.id, 1);
  await editor.locator('[data-hstar-text-tool="text-extract"]').click();
  await editor.locator('[data-hstar-action="run-extraction"]').click();
  await expect(editor.locator('.hstar-ocr-row')).toHaveCount(3);
  await editor.locator('[data-hstar-action="apply-extraction"]').click();
  await saveEditor(editor, 'e2e-smart-ocr');

  const project = (await projectRecord(request, {
    canvasType:'smart', canvasId:smart.id, nodeId:node.id, projectId:node.projectId,
  })).project;
  expect(project.owner).toEqual({canvasType:'smart', canvasId:smart.id, nodeId:node.id});
  expect(project.aiTaskRecords).toHaveLength(1);
  expect(project.aiTaskRecords[0]).toMatchObject({toolId:'text-extract', status:'succeeded'});
  expect(project.editor.objects.filter(object => object.type === 'i-text').map(object => object.text))
    .toEqual(ai.ocrBlocks.map(block => block.text));
  expect(pageErrors).toEqual([]);
});

test('text tool panel stays inside desktop and mobile workspaces', async ({page, request}, testInfo) => {
  test.setTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await installAiRoutes(page);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:'visual-text-source', type:'image', x:80, y:120, w:280, h:240,
    url:SOURCE_IMAGE, name:'视觉检查源图.png', mediaKind:'image', assetVersion:'visual-v1',
  };
  const node = {
    id:'visual-text-node', type:'openshop-layered', projectId:`e2e_visual_text_${runId}`,
    projectName:'文字工具视觉检查', x:560, y:160, w:340, h:260,
    documentWidth:1920, documentHeight:1080, saveState:'new', created_at:Date.now(),
  };
  const classic = await createCanvas(request, {
    kind:'classic', title:'OpenShop text tools visual E2E', nodes:[image, node],
    connections:[{id:'visual-text-edge', from:image.id, to:node.id}],
  });
  const canvas = await mountCanvas(page, 'classic', classic.id);
  const editor = await openNode(page, canvas, 'classic', node.id, 1);
  await editor.locator('[data-hstar-text-tool="text-extract"]').click();

  for(const viewport of [
    {width:1440, height:1000, name:'desktop-1440'},
    {width:1920, height:1080, name:'desktop-1920'},
    {width:430, height:932, name:'mobile-430'},
  ]){
    await page.setViewportSize({width:viewport.width, height:viewport.height});
    await page.waitForTimeout(100);
    const geometry = await editor.evaluate(() => {
      const panel = document.getElementById('hstar-text-tools-panel');
      const toolbar = document.getElementById('toolbar');
      const panelRect = panel.getBoundingClientRect();
      const toolbarRect = toolbar.getBoundingClientRect();
      const buttons = [...panel.querySelectorAll('button')].map(button => ({
        text:button.textContent.trim(),
        width:button.getBoundingClientRect().width,
        scrollWidth:button.scrollWidth,
      }));
      return {
        viewport:{width:innerWidth, height:innerHeight},
        panel:{left:panelRect.left, top:panelRect.top, right:panelRect.right, bottom:panelRect.bottom},
        toolbar:{left:toolbarRect.left, top:toolbarRect.top, right:toolbarRect.right, bottom:toolbarRect.bottom},
        clientWidth:panel.clientWidth,
        scrollWidth:panel.scrollWidth,
        buttons,
      };
    });
    expect(geometry.panel.left).toBeGreaterThanOrEqual(0);
    expect(geometry.panel.top).toBeGreaterThanOrEqual(0);
    expect(geometry.panel.right).toBeLessThanOrEqual(geometry.viewport.width);
    expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.viewport.height);
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.clientWidth);
    expect(geometry.buttons.every(button => button.scrollWidth <= Math.ceil(button.width))).toBe(true);
    if(viewport.width < 768){
      expect(geometry.panel.bottom).toBeLessThanOrEqual(geometry.toolbar.top);
    }
    await page.screenshot({
      path:testInfo.outputPath(`${viewport.name}.png`),
      animations:'disabled',
    });
  }
  expect(pageErrors).toEqual([]);
});

test('4K document handles twenty OCR blocks and selection removal without a blank canvas', async ({page, request}, testInfo) => {
  test.setTimeout(180000);
  await page.setViewportSize({width:1920, height:1080});
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const blocks = Array.from({length:20}, (_, index) => {
    const column = index % 4;
    const row = Math.floor(index / 4);
    const left = 0.05 + column * 0.23;
    const top = 0.06 + row * 0.17;
    return {
      id:`block-${index + 1}`,
      text:index % 3 === 0 ? `第 ${index + 1} 段 Mixed` : `4K text block ${index + 1}`,
      language:index % 3 === 0 ? 'mixed' : 'en',
      confidence:index === 19 ? 0.61 : 0.94,
      lowConfidence:index === 19,
      quad:[
        {x:left, y:top}, {x:left + 0.18, y:top},
        {x:left + 0.18, y:top + 0.06}, {x:left, y:top + 0.06},
      ],
      font:{familyCandidates:index % 3 === 0 ? ['Microsoft YaHei UI', 'Arial'] : ['Arial'], size:64, weight:400, style:'normal'},
      color:'#f8fafc', align:'left', rotation:0, paragraphId:`p-${index + 1}`, lineIndex:0,
    };
  });
  await installAiRoutes(page, {ocrBlocks:blocks, width:4096, height:4096});
  const fourKSource = await solidPngDataUrl(page, 4096, 4096);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:'four-k-source', type:'image', x:80, y:120, w:280, h:240,
    url:fourKSource, name:'4K 测试源图.png', mediaKind:'image', assetVersion:'4k-v1',
  };
  const node = {
    id:'four-k-text-node', type:'openshop-layered', projectId:`e2e_4k_text_${runId}`,
    projectName:'4K 文字工具', x:560, y:160, w:340, h:260,
    documentWidth:4096, documentHeight:4096, saveState:'new', created_at:Date.now(),
  };
  const classic = await createCanvas(request, {
    kind:'classic', title:'OpenShop text tools 4K E2E', nodes:[image, node],
    connections:[{id:'four-k-edge', from:image.id, to:node.id}],
  });
  const canvas = await mountCanvas(page, 'classic', classic.id);
  const editor = await openNode(page, canvas, 'classic', node.id, 1);

  const startedAt = Date.now();
  await editor.locator('[data-hstar-text-tool="text-extract"]').click();
  await editor.locator('[data-hstar-action="run-extraction"]').click();
  await expect(editor.locator('.hstar-ocr-row')).toHaveCount(20);
  await expect(editor.locator('.hstar-ocr-confidence.low')).toHaveCount(1);
  await editor.locator('[data-hstar-action="apply-extraction"]').click();
  await expect.poll(() => editor.evaluate(() => OS.canvas.getObjects().filter(object => object.type === 'i-text').length)).toBe(20);

  await editor.evaluate(() => {
    OS.activeLayerIdx = OS.layers.findIndex(layer => layer.sourceBinding);
    OS._selectionBounds = {x:512, y:640, w:2048, h:1024};
    OS.updateLayersPanel();
  });
  await editor.locator('[data-hstar-text-tool="text-remove"]').click();
  await editor.locator('[data-hstar-remove-mode="selection"]').click();
  await editor.locator('[data-hstar-action="run-removal"]').click();
  await editor.waitForFunction(() => OS.layers.some(layer => layer.name === '去除文字'));
  await saveEditor(editor, 'e2e-4k-text-tools');

  const metrics = await editor.evaluate(() => {
    OS.canvas.renderAll();
    const sourceCanvas = OS.canvas.lowerCanvasEl;
    const sample = document.createElement('canvas');
    sample.width = 128;
    sample.height = 128;
    const context = sample.getContext('2d', {willReadFrequently:true});
    context.drawImage(sourceCanvas, 0, 0, sample.width, sample.height);
    const pixels = context.getImageData(0, 0, sample.width, sample.height).data;
    let visiblePixels = 0;
    for(let index = 3; index < pixels.length; index += 4){
      if(pixels[index] > 0) visiblePixels += 1;
    }
    const preview = OS.canvas.toDataURL({
      format:'png', quality:1, left:0, top:0,
      width:OS.canvasW, height:OS.canvasH, multiplier:0.125,
    });
    return {
      document:{width:OS.canvasW, height:OS.canvasH},
      textCount:OS.canvas.getObjects().filter(object => object.type === 'i-text').length,
      layerNames:OS.layers.map(layer => layer.name),
      sourceLayerCount:OS.layers.filter(layer => layer.sourceBinding).length,
      taskRecords:OS.__hstarAiTaskRecords.map(record => ({toolId:record.toolId, status:record.status, appliedAt:record.appliedAt})),
      visiblePixels,
      previewBytes:new TextEncoder().encode(preview).byteLength,
    };
  });
  expect(metrics.document).toEqual({width:4096, height:4096});
  expect(metrics.textCount).toBe(20);
  expect(metrics.layerNames).toContain('提取文字');
  expect(metrics.layerNames).toContain('去除文字');
  expect(metrics.sourceLayerCount).toBe(1);
  expect(metrics.taskRecords).toHaveLength(2);
  expect(metrics.taskRecords.every(record => record.status === 'succeeded' && record.appliedAt > 0)).toBe(true);
  expect(metrics.visiblePixels).toBeGreaterThan(0);
  expect(metrics.previewBytes).toBeGreaterThan(100);
  expect(Date.now() - startedAt).toBeLessThan(60000);
  await page.screenshot({path:testInfo.outputPath('text-tools-4k.png'), animations:'disabled'});
  expect(pageErrors).toEqual([]);
});
