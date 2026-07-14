import { expect, test } from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const SOURCE_IMAGE = '/static/images/logo.png';

test.describe.configure({mode:'serial'});

async function apiJson(response){
  const value = await response.json().catch(() => ({}));
  expect(response.ok(), JSON.stringify(value)).toBeTruthy();
  return value;
}

async function createCanvas(request, {kind, title, nodes, connections}){
  const created = await apiJson(await request.post(`${baseUrl}/api/canvases`, {
    data:{kind, title, icon:kind === 'smart' ? 'sparkles' : 'layers'},
  }));
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
  const editor = page.frames().find(frame => frame.url().includes('/static/openshop/index.html'));
  await editor.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopTextToolsController
    && window.HstarOpenShopRuntime?.getState?.().activeSession
  ));
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

async function installAiRoutes(page){
  let catalogEnabled = true;
  let sequence = 0;
  let holdNextRemoval = false;
  const tasks = new Map();
  const heldGets = [];
  const ocrBlocks = [
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
      ? {schemaVersion:1, width:1920, height:1080, blocks:ocrBlocks}
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
