import { expect, test } from '@playwright/test';
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const TEST_ID_PREFIX = 'codex-e2e-openshop-';
const canvasCleanup = createTestCanvasCleanup(baseUrl, {requiredPrefix:TEST_ID_PREFIX});
const SOURCE_IMAGE = '/static/images/logo.png';
const SECOND_SOURCE_IMAGE = '/static/images/lingjing.png';
const TRANSPARENT_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAC0lEQVR4nGNgQAcAABIAAXfx+gAAAAAASUVORK5CYII=';

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
  const id = `${TEST_ID_PREFIX}${kind}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const created = await apiJson(await request.post(`${baseUrl}/api/canvases`, {
    data:{id, kind, title, icon:kind === 'smart' ? 'sparkles' : 'layers'},
  }));
  expect(created.canvas.id).toBe(id);
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
  nodes.filter(node => node.type === 'openshop-layered').forEach(node => {
    canvasCleanup.trackProject({
      canvasType:kind,
      canvasId:canvas.id,
      nodeId:node.id,
      projectId:node.projectId,
    });
  });
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
    const frame = document.getElementById('frame-canvas');
    window.switchUI?.(null, 'canvas', {skipRemember:true});
    frame.src = src;
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

function artisticWorkflowCatalog(){
  return {
    schemaVersion:1,
    primaryProviderId:'codex-e2e-openshop-ocr-provider',
    tools:{
      'text-extract':{
        id:'text-extract', label:'文字提取', capability:'structured-ocr-layout',
        providers:[{
          id:'codex-e2e-openshop-ocr-provider', name:'OCR Provider', protocol:'openai', available:true,
          models:[{id:'codex-e2e-openshop-ocr-model', name:'OCR Model', available:true}],
        }],
      },
      'text-remove':{id:'text-remove', label:'去除文字', capability:'image-edit', providers:[]},
      'art-font-restore':{
        id:'art-font-restore', label:'艺术字体处理', capability:'image-edit',
        providers:[
          {
            id:'codex-e2e-openshop-art-provider-a', name:'Art Provider A', protocol:'openai', available:true,
            models:[{id:'codex-e2e-openshop-art-model-a', name:'Art Model A', available:true, imageInput:true}],
          },
          {
            id:'codex-e2e-openshop-art-provider-b', name:'Art Provider B', protocol:'openai', available:true,
            models:[{id:'codex-e2e-openshop-art-model-b', name:'Art Model B', available:true, imageInput:true}],
          },
        ],
      },
    },
  };
}

function deterministicFonts(){
  const font = (family, languageGroup, freeCommercialCategory, styles) => ({
    family, label:family, languageGroup, freeCommercialCategory,
    sortName:family.replace(/^(?:01|02|03)免\s*/u, ''), styles,
  });
  const style = (id, family, weight, italic = false) => ({
    id, family, label:`${weight}${italic ? ' Italic' : ''}`, weight, italic, localNames:[],
  });
  return [
    font('01免简墨黑体', 'zh-hans', '01', [
      style('codex-hans-regular', '01免简墨黑体 Regular', 400),
      style('codex-hans-semibold', '01免简墨黑体 SemiBold', 600),
    ]),
    font('02免繁墨明體', 'zh-hant', '02', [
      style('codex-hant-regular', '02免繁墨明體 Regular', 400),
      style('codex-hant-bold', '02免繁墨明體 Bold', 700),
    ]),
    font('03免Codex Sans', 'en', '03', [
      style('codex-en-regular', '03免Codex Sans Regular', 400),
      style('codex-en-bold', '03免Codex Sans Bold', 700),
    ]),
    font('阿里巴巴普惠体 3.0', 'zh-hans', '', [
      style('codex-alibaba-regular', '阿里巴巴普惠体 3.0 Regular', 400),
      style('codex-alibaba-heavy', '阿里巴巴普惠体 3.0 Heavy', 800),
    ]),
  ];
}

function artisticOcrBlocks(){
  return [
    {
      id:'codex-e2e-openshop-hans', text:'简体标题', language:'zh-CN', script:'zh-hans',
      confidence:0.99, lowConfidence:false,
      quad:[{x:0.08,y:0.1},{x:0.38,y:0.1},{x:0.38,y:0.2},{x:0.08,y:0.2}],
      font:{familyCandidates:['简墨黑体'], size:52, weight:560, style:'normal'},
      color:'#111827', align:'left', rotation:0, paragraphId:'codex-hans', lineIndex:0,
    },
    {
      id:'codex-e2e-openshop-hant', text:'繁體標題', language:'zh-TW', script:'zh-hant',
      confidence:0.98, lowConfidence:false,
      quad:[{x:0.08,y:0.25},{x:0.38,y:0.25},{x:0.38,y:0.35},{x:0.08,y:0.35}],
      font:{familyCandidates:['繁墨明體'], size:50, weight:680, style:'normal'},
      color:'#1f2937', align:'left', rotation:0, paragraphId:'codex-hant', lineIndex:0,
    },
    {
      id:'codex-e2e-openshop-en', text:'OpenShop Studio', language:'en', script:'en',
      confidence:0.97, lowConfidence:false,
      quad:[{x:0.08,y:0.4},{x:0.46,y:0.4},{x:0.46,y:0.49},{x:0.08,y:0.49}],
      font:{familyCandidates:['Codex Sans'], size:46, weight:650, style:'normal'},
      color:'#374151', align:'left', rotation:0, paragraphId:'codex-en', lineIndex:0,
    },
    {
      id:'codex-e2e-openshop-artistic', text:'原始艺术标题', language:'zh-CN', script:'zh-hans',
      confidence:0.96, lowConfidence:false,
      quad:[{x:0.08,y:0.56},{x:0.5,y:0.56},{x:0.5,y:0.7},{x:0.08,y:0.7}],
      font:{
        artistic:true, familyCandidates:['手绘标题体'], size:64, weight:760, style:'normal',
        styleDescription:'hand painted display lettering',
      },
      color:'#7f1d1d', align:'left', rotation:0, paragraphId:'codex-art', lineIndex:0,
    },
  ];
}

async function installArtisticWorkflowRoutes(page){
  const ocrBlocks = artisticOcrBlocks();
  const tasks = new Map();
  const artPosts = [];
  const artPolls = [];
  const deleteRequests = [];
  let expectedOwner = null;
  let heldArtPost = null;
  let artReleased = false;
  let artTask = null;
  let outputAsset = null;

  function parseTaskRoute(url){
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/api\/openshop\/projects\/([^/]+)\/ai-tasks(?:\/([^/]+))?$/);
    expect(match, `unexpected OpenShop AI task route: ${parsed.pathname}`).toBeTruthy();
    return {
      projectId:decodeURIComponent(match[1]),
      taskId:match[2] ? decodeURIComponent(match[2]) : '',
    };
  }

  function ownerWithoutProject(owner){
    return {
      canvasType:owner.canvasType,
      canvasId:owner.canvasId,
      nodeId:owner.nodeId,
    };
  }

  function assertExpectedOwner(routeInfo, bodyOwner){
    expect(expectedOwner, 'the artistic workflow route owner should be configured').toBeTruthy();
    expect(routeInfo.projectId, 'AI task URL projectId must match the active project')
      .toBe(expectedOwner.projectId);
    if(bodyOwner){
      expect(bodyOwner, 'AI task body.owner must match the active canvas node')
        .toEqual(ownerWithoutProject(expectedOwner));
      if(Object.hasOwn(bodyOwner, 'projectId')){
        expect(bodyOwner.projectId, 'AI task body.owner projectId must match the URL')
          .toBe(routeInfo.projectId);
      }
    }
  }

  function assertTaskOwnership(routeInfo, task){
    assertExpectedOwner(routeInfo);
    expect(task.projectId, 'AI task must stay associated with its creating project')
      .toBe(routeInfo.projectId);
    expect(task.owner, 'AI task must stay associated with its creating canvas node')
      .toEqual(expectedOwner);
  }

  await page.route('**/api/openshop/fonts*', route => route.fulfill({
    status:200, contentType:'application/json',
    body:JSON.stringify({platform:'codex-e2e', cached:false, fonts:deterministicFonts()}),
  }));
  await page.route('**/api/openshop/ai/catalog', route => route.fulfill({
    status:200, contentType:'application/json', body:JSON.stringify(artisticWorkflowCatalog()),
  }));
  await page.route(/\/api\/openshop\/projects\/[^/]+\/ai-tasks(?:\?.*)?$/, async route => {
    const request = route.request();
    if(request.method() !== 'POST'){
      await route.continue();
      return;
    }
    const routeInfo = parseTaskRoute(request.url());
    if(expectedOwner && routeInfo.projectId !== expectedOwner.projectId){
      await route.fulfill({
        status:404, contentType:'application/json',
        body:JSON.stringify({detail:'AI task project ownership mismatch'}),
      });
      return;
    }
    const body = request.postDataJSON();
    assertExpectedOwner(routeInfo, body.owner);
    if(body.tool_id === 'art-font-restore'){
      artPosts.push(body);
      const taskId = `codex-e2e-openshop-art-task-${artPosts.length}`;
      artTask = {taskId, projectId:routeInfo.projectId, owner:{...expectedOwner}, body};
      tasks.set(taskId, artTask);
      heldArtPost = route;
      return;
    }
    const taskId = `codex-e2e-openshop-ocr-task-${tasks.size + 1}`;
    tasks.set(taskId, {taskId, projectId:routeInfo.projectId, owner:{...expectedOwner}, body});
    await route.fulfill({
      status:200, contentType:'application/json', body:JSON.stringify({task_id:taskId, status:'queued'}),
    });
  });
  await page.route(/\/api\/openshop\/projects\/[^/]+\/ai-tasks\/([^?]+)(?:\?.*)?$/, async route => {
    const request = route.request();
    const routeInfo = parseTaskRoute(request.url());
    const taskId = routeInfo.taskId;
    const task = tasks.get(taskId);
    if(!task){
      await route.fulfill({status:404, contentType:'application/json', body:JSON.stringify({detail:'missing task'})});
      return;
    }
    if(expectedOwner && routeInfo.projectId !== expectedOwner.projectId){
      await route.fulfill({
        status:404, contentType:'application/json',
        body:JSON.stringify({detail:'AI task project ownership mismatch'}),
      });
      return;
    }
    assertTaskOwnership(routeInfo, task);
    if(request.method() === 'DELETE'){
      deleteRequests.push({taskId, projectId:routeInfo.projectId});
      await route.fulfill({
        status:200, contentType:'application/json',
        body:JSON.stringify({task:{taskId, status:'cancelled'}}),
      });
      return;
    }
    if(task === artTask){
      artPolls.push({taskId, projectId:routeInfo.projectId});
      expect(outputAsset, 'the artistic output asset should be registered before polling').toBeTruthy();
      const result = {
        assetId:outputAsset.assetId,
        url:outputAsset.url,
        name:outputAsset.name, mime:'image/png', width:2, height:2,
        contentBox:{x:0, y:0, width:2, height:2},
      };
      await route.fulfill({
        status:200, contentType:'application/json',
        body:JSON.stringify({task:{
          taskId, status:artReleased ? 'succeeded' : 'running',
          ...(artReleased ? {result, outputAssetId:outputAsset.assetId} : {}),
        }}),
      });
      return;
    }
    await route.fulfill({
      status:200, contentType:'application/json',
      body:JSON.stringify({task:{
        taskId, status:'succeeded',
        result:{schemaVersion:1, width:1920, height:1080, blocks:ocrBlocks},
      }}),
    });
  });

  return {
    ocrBlocks,
    get outputAssetId(){ return outputAsset?.assetId || ''; },
    get artTaskId(){ return artTask?.taskId || ''; },
    artPosts,
    artPolls,
    deleteRequests,
    setExpectedOwner(owner){
      expectedOwner = {...owner};
    },
    useOutputAsset(asset){
      expect(expectedOwner, 'the artistic workflow asset owner should be configured').toBeTruthy();
      expect(asset).toMatchObject({assetId:expect.any(String), url:expect.any(String), owner:expectedOwner});
      expect(asset.owner, 'artistic output asset must belong to the active canvas node')
        .toEqual(expectedOwner);
      expect(asset.url).toBe(`/api/openshop/assets/${asset.assetId}`);
      outputAsset = {...asset};
    },
    async releaseArtTask(){
      expect(heldArtPost, 'the artistic task POST should be held').toBeTruthy();
      artReleased = true;
      const route = heldArtPost;
      heldArtPost = null;
      await route.fulfill({
        status:200, contentType:'application/json',
        body:JSON.stringify({task_id:artTask.taskId, status:'queued'}),
      });
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

async function uploadTransparentArtAsset(request, context){
  const uploaded = await apiJson(await request.post(
    `${baseUrl}/api/openshop/projects/${context.projectId}/assets`,
    {multipart:{
      canvas_type:context.canvasType,
      canvas_id:context.canvasId,
      node_id:context.nodeId,
      role:'output',
      file:{
        name:'codex-e2e-openshop-art-font.png',
        mimeType:'image/png',
        buffer:Buffer.from(TRANSPARENT_PNG_BASE64, 'base64'),
      },
    }},
  ));
  return {
    ...uploaded.asset,
    owner:{
      canvasType:context.canvasType,
      canvasId:context.canvasId,
      nodeId:context.nodeId,
      projectId:context.projectId,
    },
  };
}

test('artistic OCR continues across hide, stays isolated, and follows real undo history', async ({page, request}, testInfo) => {
  test.setTimeout(240000);
  await page.setViewportSize({width:1440, height:1000});
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const ai = await installArtisticWorkflowRoutes(page);
  const runId = `${TEST_ID_PREFIX}workflow-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const editedText = '焕新艺术标题';
  const sourceA = {
    id:`${runId}-source-a`, type:'image', x:60, y:100, w:280, h:220,
    url:SOURCE_IMAGE, name:'艺术字体源图 A.png', mediaKind:'image', assetVersion:`${runId}-source-a-v1`,
  };
  const sourceB = {
    id:`${runId}-source-b`, type:'image', x:60, y:480, w:280, h:220,
    url:SECOND_SOURCE_IMAGE, name:'隔离源图 B.png', mediaKind:'image', assetVersion:`${runId}-source-b-v1`,
  };
  const baseNode = {
    type:'openshop-layered', x:540, y:120, w:360, h:270,
    documentWidth:1920, documentHeight:1080, layerCount:0,
    sourceUpdateCount:0, autosaveVersion:0, saveState:'new', created_at:Date.now(),
  };
  const nodeA = {
    ...baseNode, id:`${runId}-node-a`, projectId:`${runId}-project-a`, projectName:'艺术字体工作流 A',
  };
  const nodeB = {
    ...baseNode, id:`${runId}-node-b`, projectId:`${runId}-project-b`, projectName:'隔离节点 B', y:500,
  };
  const classic = await createCanvas(request, {
    kind:'classic', title:`${runId}-canvas`, nodes:[sourceA, sourceB, nodeA, nodeB],
    connections:[
      {id:`${runId}-edge-a`, from:sourceA.id, to:nodeA.id},
      {id:`${runId}-edge-b`, from:sourceB.id, to:nodeB.id},
    ],
  });
  expect([classic.id, nodeA.id, nodeA.projectId, nodeB.id, nodeB.projectId]
    .every(id => id.startsWith(TEST_ID_PREFIX))).toBe(true);
  const ownerA = {
    canvasType:'classic', canvasId:classic.id, nodeId:nodeA.id, projectId:nodeA.projectId,
  };
  ai.setExpectedOwner(ownerA);

  const canvas = await mountCanvas(page, 'classic', classic.id);
  let editor = await openNode(page, canvas, 'classic', nodeA.id, 1);
  ai.useOutputAsset(await uploadTransparentArtAsset(request, {
    canvasType:'classic', canvasId:classic.id, nodeId:nodeA.id, projectId:nodeA.projectId,
  }));
  await editor.locator('[data-hstar-text-tool="text-extract"]').click();
  await expect(editor.locator('[data-provider-tool="text-extract"]'))
    .toHaveValue('codex-e2e-openshop-ocr-provider');
  await expect(editor.locator('[data-model-tool="text-extract"]'))
    .toHaveValue('codex-e2e-openshop-ocr-model');
  await editor.locator('[data-hstar-action="run-extraction"]').click();
  await expect(editor.locator('.hstar-ocr-row')).toHaveCount(4);
  await editor.locator('[data-hstar-action="apply-extraction"]').click();
  await expect.poll(() => editor.evaluate(() => (
    OS.canvas.getObjects().filter(object => object.type === 'i-text').length
  ))).toBe(4);

  const fontAudit = await editor.evaluate(blockIds => Object.fromEntries(blockIds.map(blockId => {
    const object = OS.canvas.getObjects().find(item => item.hstarOcrBlockId === blockId);
    return [blockId, {
      text:object?.text,
      family:object?.fontFamily,
      weight:object?.fontWeight,
      scaleX:object?.scaleX,
      scaleY:object?.scaleY,
      originalText:object?.hstarOcrOriginalText,
      layerId:object?.hstarLayerId,
    }];
  })), ai.ocrBlocks.map(block => block.id));
  expect(fontAudit['codex-e2e-openshop-hans']).toMatchObject({
    family:'01免简墨黑体 SemiBold', weight:600,
  });
  expect(fontAudit['codex-e2e-openshop-hant']).toMatchObject({
    family:'02免繁墨明體 Bold', weight:700,
  });
  expect(fontAudit['codex-e2e-openshop-en']).toMatchObject({
    family:'03免Codex Sans Bold', weight:700,
  });
  expect(fontAudit['codex-e2e-openshop-artistic']).toMatchObject({
    family:'阿里巴巴普惠体 3.0 Heavy', weight:800, originalText:'原始艺术标题',
  });
  for(const block of Object.values(fontAudit)) expect(block.scaleX).toBe(block.scaleY);

  const artisticLayerId = fontAudit['codex-e2e-openshop-artistic'].layerId;
  await editor.evaluate(({blockId, text}) => {
    const object = OS.canvas.getObjects().find(item => item.hstarOcrBlockId === blockId);
    object.set({text});
    object.initDimensions?.();
    object.setCoords?.();
    OS.canvas.setActiveObject(object);
    OS.canvas.fire('text:changed', {target:object});
    OS.canvas.renderAll();
    OS.saveHistory('Edit Text');
    OS.updateLayersPanel();
  }, {blockId:'codex-e2e-openshop-artistic', text:editedText});
  expect(await editor.evaluate(blockId => (
    OS.canvas.getObjects().find(item => item.hstarOcrBlockId === blockId)?.text
  ), 'codex-e2e-openshop-artistic')).toBe(editedText);

  await editor.locator('[data-provider-tool="art-font-restore"]')
    .selectOption('codex-e2e-openshop-art-provider-b');
  await expect(editor.locator('[data-model-tool="art-font-restore"]'))
    .toHaveValue('codex-e2e-openshop-art-model-b');
  const artisticLayerIndex = await editor.evaluate(layerId => (
    OS.layers.findIndex(layer => layer.layerId === layerId)
  ), artisticLayerId);
  const artisticRow = editor.locator(`.layer-item[data-layer-index="${artisticLayerIndex}"]`);
  await expect(artisticRow.locator('.layer-art-font')).toBeEnabled();
  await artisticRow.locator('.layer-art-font').click();
  await expect.poll(() => ai.artPosts.length).toBe(1);
  const artPost = ai.artPosts[0];
  expect(artPost).toMatchObject({
    tool_id:'art-font-restore', provider_id:'codex-e2e-openshop-art-provider-b',
    model_id:'codex-e2e-openshop-art-model-b',
    owner:{canvasType:'classic', canvasId:classic.id, nodeId:nodeA.id},
    options:{artFont:{
      textLayerId:artisticLayerId, originalText:'原始艺术标题', currentText:editedText,
    }},
  });
  expect(artPost.options.artFont.currentText).not.toBe(artPost.options.artFont.originalText);
  expect(artPost.client_request_id).toMatch(/^art-font-request\./);

  const wrongProjectRoute = await page.evaluate(({projectId, taskId, owner}) => {
    const params = new URLSearchParams({
      canvas_type:owner.canvasType,
      canvas_id:owner.canvasId,
      node_id:owner.nodeId,
    });
    return fetch(`/api/openshop/projects/${encodeURIComponent(`${projectId}-wrong`)}/ai-tasks/${encodeURIComponent(taskId)}?${params}`)
      .then(async response => ({status:response.status, body:await response.json()}));
  }, {projectId:nodeA.projectId, taskId:ai.artTaskId, owner:ownerA});
  expect(wrongProjectRoute).toEqual({
    status:404, body:{detail:'AI task project ownership mismatch'},
  });

  await expect.poll(async () => {
    const project = (await projectRecord(request, {
      canvasType:'classic', canvasId:classic.id, nodeId:nodeA.id, projectId:nodeA.projectId,
    })).project;
    return project.aiTaskRecords.find(record => record.clientRequestId === artPost.client_request_id) || null;
  }).toMatchObject({
    taskId:`provisional:${artPost.client_request_id}`,
    clientRequestId:artPost.client_request_id,
    creationState:'provisional', status:'queued', reconcileState:'pending',
  });

  await page.locator('[data-openshop-back]').click();
  await expect(page.locator('#openshop-host')).not.toHaveClass(/is-open/);
  await ai.releaseArtTask();
  await expect.poll(() => editor.evaluate(() => (
    window.HstarOpenShopTextToolsController.getState().artBusyLayerIds.length
  ))).toBe(0);
  expect(ai.deleteRequests).toEqual([]);

  editor = await openNode(page, canvas, 'classic', nodeA.id, 1);
  await expect.poll(() => editor.evaluate(() => (
    OS.layers.filter(layer => layer.hstarAiGeneration?.toolId === 'art-font-restore').length
  )), {timeout:30000}).toBe(1);
  expect(ai.artPolls).toEqual([{taskId:ai.artTaskId, projectId:nodeA.projectId}]);

  const appliedAudit = await editor.evaluate(({layerId, outputAssetId}) => {
    const record = OS.__hstarAiTaskRecords.find(item => (
      item.toolId === 'art-font-restore' && item.outputAssetId === outputAssetId
    ));
    const carrierIndex = OS.layers.findIndex(layer => layer.layerId === layerId);
    const carrier = OS.layers[carrierIndex];
    const generated = OS.layers.filter(layer => layer.hstarAiGeneration?.toolId === 'art-font-restore');
    const raster = generated[0]?.objects?.[0];
    const pixelCanvas = document.createElement('canvas');
    pixelCanvas.width = 1;
    pixelCanvas.height = 1;
    const pixelContext = pixelCanvas.getContext('2d', {willReadFrequently:true});
    pixelContext.drawImage(raster.getElement(), 0, 0, 1, 1);
    return {
      record,
      carrierIndex,
      generatedIndex:OS.layers.indexOf(generated[0]),
      generatedCount:generated.length,
      carrierVisible:carrier.visible,
      carrierObjectVisibility:carrier.objects.map(object => object.visible),
      rasterType:raster?.type,
      rasterAssetId:raster?.hstarAssetId,
      rasterAlpha:pixelContext.getImageData(0, 0, 1, 1).data[3],
      layerGeneration:generated[0]?.hstarAiGeneration,
      objectGeneration:raster?.hstarAiGeneration,
    };
  }, {layerId:artisticLayerId, outputAssetId:ai.outputAssetId});
  expect(appliedAudit).toMatchObject({
    generatedCount:1, carrierVisible:false, rasterType:'image',
    rasterAssetId:ai.outputAssetId, rasterAlpha:0,
    record:{
      taskId:ai.artTaskId, clientRequestId:artPost.client_request_id,
      status:'succeeded', reconcileState:'applied', outputAssetId:ai.outputAssetId,
    },
  });
  expect(appliedAudit.generatedIndex).toBe(appliedAudit.carrierIndex + 1);
  expect(appliedAudit.carrierObjectVisibility.every(visible => visible === false)).toBe(true);
  expect(appliedAudit.layerGeneration).toEqual(appliedAudit.objectGeneration);
  expect(appliedAudit.layerGeneration).toEqual({
    taskId:ai.artTaskId, textLayerId:artisticLayerId,
    requestGeneration:1, outputAssetId:ai.outputAssetId, toolId:'art-font-restore',
    contentBox:{x:0, y:0, width:2, height:2},
  });

  await page.locator('[data-openshop-back]').click();
  editor = await openNode(page, canvas, 'classic', nodeA.id, 1);
  expect(await editor.evaluate(() => (
    OS.layers.filter(layer => layer.hstarAiGeneration?.toolId === 'art-font-restore').length
  ))).toBe(1);

  await editor.evaluate(() => OS.undo());
  await expect.poll(() => editor.evaluate(() => ({
    generated:OS.layers.filter(layer => layer.hstarAiGeneration?.toolId === 'art-font-restore').length,
    carrierVisible:OS.layers.find(layer => layer.objects?.some(object => (
      object.hstarOcrBlockId === 'codex-e2e-openshop-artistic'
    )))?.visible,
    objectVisible:OS.canvas.getObjects().find(object => (
      object.hstarOcrBlockId === 'codex-e2e-openshop-artistic'
    ))?.visible,
  }))).toEqual({generated:0, carrierVisible:true, objectVisible:true});
  await editor.evaluate(() => OS.redo());
  await expect.poll(() => editor.evaluate(() => (
    OS.layers.filter(layer => layer.hstarAiGeneration?.toolId === 'art-font-restore').length
  ))).toBe(1);
  await saveEditor(editor, 'codex-e2e-openshop-redo');

  const layoutAudit = await editor.evaluate(() => {
    OS.canvas.renderAll();
    const canvas = OS.canvas.lowerCanvasEl;
    const sample = document.createElement('canvas');
    sample.width = 64;
    sample.height = 64;
    const context = sample.getContext('2d', {willReadFrequently:true});
    context.drawImage(canvas, 0, 0, 64, 64);
    const pixels = context.getImageData(0, 0, 64, 64).data;
    let visiblePixels = 0;
    for(let index = 3; index < pixels.length; index += 4) if(pixels[index] > 0) visiblePixels += 1;
    const panel = document.getElementById('hstar-text-tools-panel');
    const selectors = [...panel.querySelectorAll('select')];
    const row = [...document.querySelectorAll('.layer-item')].find(item => item.querySelector('.layer-art-font'));
    const action = row.querySelector('.layer-art-font').getBoundingClientRect();
    const info = row.querySelector('.layer-info').getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    return {
      visiblePixels,
      panel:{left:panelRect.left, top:panelRect.top, right:panelRect.right, bottom:panelRect.bottom},
      viewport:{width:innerWidth, height:innerHeight},
      panelOverflow:panel.scrollWidth - panel.clientWidth,
      selectorOverflow:selectors.map(select => select.scrollWidth - select.clientWidth),
      rowActionOverlapsInfo:action.right > info.left,
    };
  });
  expect(layoutAudit.visiblePixels).toBeGreaterThan(0);
  expect(layoutAudit.panel.left).toBeGreaterThanOrEqual(0);
  expect(layoutAudit.panel.top).toBeGreaterThanOrEqual(0);
  expect(layoutAudit.panel.right).toBeLessThanOrEqual(layoutAudit.viewport.width);
  expect(layoutAudit.panel.bottom).toBeLessThanOrEqual(layoutAudit.viewport.height);
  expect(layoutAudit.panelOverflow).toBeLessThanOrEqual(0);
  expect(layoutAudit.selectorOverflow.every(value => value <= 0)).toBe(true);
  expect(layoutAudit.rowActionOverlapsInfo).toBe(false);
  await page.screenshot({path:testInfo.outputPath('artistic-workflow.png'), animations:'disabled'});

  await page.locator('[data-openshop-back]').click();
  editor = await openNode(page, canvas, 'classic', nodeB.id, 1);
  const isolatedEditor = await editor.evaluate(() => ({
    preferences:OS.__hstarAiToolPreferences,
    taskRecords:OS.__hstarAiTaskRecords,
    texts:OS.canvas.getObjects().filter(object => object.type === 'i-text').map(object => object.text),
    generatedLayers:OS.layers.filter(layer => layer.hstarAiGeneration).length,
    sourceAssetIds:OS.layers.map(layer => layer.sourceBinding?.assetId).filter(Boolean),
    objectAssetIds:OS.canvas.getObjects().map(object => object.hstarAssetId).filter(Boolean),
  }));
  const projectA = (await projectRecord(request, {
    canvasType:'classic', canvasId:classic.id, nodeId:nodeA.id, projectId:nodeA.projectId,
  })).project;
  const projectB = (await projectRecord(request, {
    canvasType:'classic', canvasId:classic.id, nodeId:nodeB.id, projectId:nodeB.projectId,
  })).project;
  expect(isolatedEditor.preferences['art-font-restore']).toBeUndefined();
  expect(isolatedEditor.taskRecords).toEqual([]);
  expect(isolatedEditor.texts).toEqual([]);
  expect(isolatedEditor.generatedLayers).toBe(0);
  expect(isolatedEditor.objectAssetIds).not.toContain(ai.outputAssetId);
  expect(projectB.aiToolPreferences['art-font-restore']).toBeUndefined();
  expect(projectB.aiTaskRecords).toEqual([]);
  expect(projectB.editor.objects.filter(object => object.type === 'i-text')).toEqual([]);
  expect(projectB.layers.some(layer => layer.hstarAiGeneration)).toBe(false);
  const sourceAssetsA = projectA.sourceBindings.map(binding => binding.assetId);
  const sourceAssetsB = projectB.sourceBindings.map(binding => binding.assetId);
  expect(sourceAssetsA).not.toEqual(sourceAssetsB);
  expect(sourceAssetsB.some(assetId => sourceAssetsA.includes(assetId))).toBe(false);
  expect(projectB.assetRefs).not.toContain(ai.outputAssetId);
  expect(projectA.aiToolPreferences['art-font-restore']).toMatchObject({
    apiConfigId:'codex-e2e-openshop-art-provider-b', modelId:'codex-e2e-openshop-art-model-b',
  });

  await page.locator('[data-openshop-back]').click();
  editor = await openNode(page, canvas, 'classic', nodeA.id, 1);
  expect(await editor.evaluate(() => ({
    generated:OS.layers.filter(layer => layer.hstarAiGeneration?.toolId === 'art-font-restore').length,
    text:OS.canvas.getObjects().find(object => object.hstarOcrBlockId === 'codex-e2e-openshop-artistic')?.text,
    artPreference:OS.__hstarAiToolPreferences['art-font-restore'],
  }))).toMatchObject({
    generated:1, text:editedText,
    artPreference:{
      apiConfigId:'codex-e2e-openshop-art-provider-b', modelId:'codex-e2e-openshop-art-model-b',
    },
  });
  expect(ai.artPosts).toHaveLength(1);
  expect(ai.deleteRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('classic canvas keeps OCR, removal, cancellation and API state isolated per node', async ({page, request}) => {
  test.setTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const ai = await installAiRoutes(page);
  const runId = `${TEST_ID_PREFIX}classic-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:`${runId}-source`, type:'image', x:80, y:120, w:280, h:240,
    url:SOURCE_IMAGE, name:'文字测试源图.png', mediaKind:'image', assetVersion:'text-v1',
  };
  const baseNode = {
    type:'openshop-layered', x:560, y:160, w:340, h:260,
    documentWidth:1920, documentHeight:1080, layerCount:0,
    sourceUpdateCount:0, autosaveVersion:0, saveState:'new', created_at:Date.now(),
  };
  const nodeA = {...baseNode, id:`${runId}-node-a`, projectId:`${runId}-project-a`, projectName:'文字提取 A'};
  const nodeB = {...baseNode, id:`${runId}-node-b`, projectId:`${runId}-project-b`, projectName:'去字 B', y:500};
  const classic = await createCanvas(request, {
    kind:'classic',
    title:'OpenShop text tools classic E2E',
    nodes:[image, nodeA, nodeB],
    connections:[
      {id:`${runId}-edge-a`, from:image.id, to:nodeA.id},
      {id:`${runId}-edge-b`, from:image.id, to:nodeB.id},
    ],
  });

  const canvas = await mountCanvas(page, 'classic', classic.id);
  let editor = await openNode(page, canvas, 'classic', nodeA.id, 1);
  await editor.locator('[data-hstar-text-tool="text-extract"]').click();
  await expect(editor.locator('[data-provider-tool="text-extract"]')).toHaveValue('e2e-ai');
  await expect(editor.locator('[data-model-tool="text-extract"]')).toHaveValue('e2e-vision');
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
  const runId = `${TEST_ID_PREFIX}smart-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:`${runId}-source`, type:'smart-image', x:60, y:120,
    images:[{url:SOURCE_IMAGE, name:'智能文字源图.png', kind:'image', assetVersion:'smart-text-v1'}],
    created_at:Date.now(),
  };
  const node = {
    id:`${runId}-node`, type:'openshop-layered', projectId:`${runId}-project`,
    projectName:'智能文字提取', x:520, y:180, w:340, h:260,
    documentWidth:1920, documentHeight:1080, saveState:'new', inputNodeIds:[image.id], created_at:Date.now(),
  };
  const smart = await createCanvas(request, {
    kind:'smart',
    title:'OpenShop text tools smart E2E',
    nodes:[image, node],
    connections:[{id:`${runId}-edge`, from:image.id, to:node.id, kind:'input'}],
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
  const runId = `${TEST_ID_PREFIX}visual-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:`${runId}-source`, type:'image', x:80, y:120, w:280, h:240,
    url:SOURCE_IMAGE, name:'视觉检查源图.png', mediaKind:'image', assetVersion:'visual-v1',
  };
  const node = {
    id:`${runId}-node`, type:'openshop-layered', projectId:`${runId}-project`,
    projectName:'文字工具视觉检查', x:560, y:160, w:340, h:260,
    documentWidth:1920, documentHeight:1080, saveState:'new', created_at:Date.now(),
  };
  const classic = await createCanvas(request, {
    kind:'classic', title:'OpenShop text tools visual E2E', nodes:[image, node],
    connections:[{id:`${runId}-edge`, from:image.id, to:node.id}],
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
  const runId = `${TEST_ID_PREFIX}4k-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const image = {
    id:`${runId}-source`, type:'image', x:80, y:120, w:280, h:240,
    url:fourKSource, name:'4K 测试源图.png', mediaKind:'image', assetVersion:'4k-v1',
  };
  const node = {
    id:`${runId}-node`, type:'openshop-layered', projectId:`${runId}-project`,
    projectName:'4K 文字工具', x:560, y:160, w:340, h:260,
    documentWidth:4096, documentHeight:4096, saveState:'new', created_at:Date.now(),
  };
  const classic = await createCanvas(request, {
    kind:'classic', title:'OpenShop text tools 4K E2E', nodes:[image, node],
    connections:[{id:`${runId}-edge`, from:image.id, to:node.id}],
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
  expect(metrics.layerNames).toEqual(expect.arrayContaining(blocks.map(block => block.text)));
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
