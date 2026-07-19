import { expect, test } from '@playwright/test';
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const TEST_ID_PREFIX = 'codex-e2e-openshop-';
const canvasCleanup = createTestCanvasCleanup(baseUrl, {requiredPrefix:TEST_ID_PREFIX});
const imageUrls = [
  '/static/images/logo.png',
  '/static/images/RunningHub-B.png',
  '/static/images/lingjing.png',
];

test.describe.configure({mode:'serial'});

test.afterEach(async ({page, request}) => {
  await page.close();
  await canvasCleanup.purgeAll(request);
});

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
      client_id:'openshop-e2e-seed',
    },
  }));
  nodes.filter(node => node.type === 'openshop-layered').forEach(node => {
    canvasCleanup.trackProject({
      projectId:node.projectId,
      canvasType:kind,
      canvasId:canvas.id,
      nodeId:node.id,
    });
  });
  return saved.canvas;
}

async function saveCanvasGraph(request, canvas, {nodes, connections}){
  return (await apiJson(await request.put(`${baseUrl}/api/canvases/${canvas.id}`, {
    data:{
      title:canvas.title,
      icon:canvas.icon,
      nodes,
      connections,
      viewport:canvas.viewport || {x:0, y:0, scale:1},
      logs:canvas.logs || [],
      settings:canvas.settings || {},
      base_updated_at:canvas.updated_at,
      client_id:'openshop-e2e-update',
    },
  }))).canvas;
}

async function solidPngBuffer(page, width, height){
  const dataUrl = await page.evaluate(({w, h}) => {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const context = canvas.getContext('2d');
    context.fillStyle = '#2c7be5';
    context.fillRect(0, 0, w, h);
    context.fillStyle = '#ffffff';
    context.font = '96px sans-serif';
    context.fillText(`${w} x ${h}`, 120, 180);
    return canvas.toDataURL('image/png');
  }, {w:width, h:height});
  return Buffer.from(dataUrl.split(',')[1], 'base64');
}

async function decodedImageSize(frame, url){
  return frame.evaluate(source => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve({width:image.naturalWidth, height:image.naturalHeight});
    image.onerror = () => reject(new Error(`Unable to decode ${source}`));
    image.src = source;
  }), url);
}

async function decodedImageEdgeAlpha(frame, url){
  return frame.evaluate(source => new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = image.naturalWidth;
      canvas.height = image.naturalHeight;
      const context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const points = [
        [0, 0], [canvas.width - 1, 0],
        [0, canvas.height - 1], [canvas.width - 1, canvas.height - 1],
        [Math.floor(canvas.width / 2), 0], [Math.floor(canvas.width / 2), canvas.height - 1],
        [0, Math.floor(canvas.height / 2)], [canvas.width - 1, Math.floor(canvas.height / 2)],
      ];
      resolve(points.map(([x, y]) => context.getImageData(x, y, 1, 1).data[3]));
    };
    image.onerror = () => reject(new Error(`Unable to decode ${source}`));
    image.src = source;
  }), url);
}

async function canvasRecord(request, canvasId){
  return (await apiJson(await request.get(`${baseUrl}/api/canvases/${canvasId}`))).canvas;
}

async function projectRecord(request, context){
  const params = new URLSearchParams({
    canvas_type:context.canvasType,
    canvas_id:context.canvasId,
    node_id:context.nodeId,
  });
  const response = await request.get(`${baseUrl}/api/openshop/projects/${context.projectId}?${params}`);
  return {response, body:await response.json().catch(() => ({}))};
}

function canvasPage(kind, id){
  return `/static/${kind === 'smart' ? 'smart-canvas' : 'canvas'}.html?id=${encodeURIComponent(id)}&v=${Date.now()}`;
}

async function mountCanvas(page, kind, canvasId){
  if(!page.url().startsWith(baseUrl)){
    await page.goto(baseUrl, {waitUntil:'domcontentloaded'});
    await page.waitForFunction(() => Boolean(window.HstarOpenShopHost));
  }
  const target = canvasPage(kind, canvasId);
  await page.evaluate(src => {
    const frame = document.getElementById('frame-canvas');
    frame.src = src;
  }, target);
  await expect.poll(() => {
    const frame = page.frames().find(candidate => candidate.url().includes(`${kind === 'smart' ? 'smart-canvas' : 'canvas'}.html`));
    return frame?.url() || '';
  }).toContain(`id=${canvasId}`);
  const frame = page.frames().find(candidate => candidate.url().includes(`${kind === 'smart' ? 'smart-canvas' : 'canvas'}.html`) && candidate.url().includes(`id=${canvasId}`));
  await frame.waitForFunction(canvasKind => canvasKind === 'smart'
    ? Boolean(window.HstarSmartOpenShopAdapter && window.HstarSmartCanvasOpenShopHooks?.getNode)
    : Boolean(window.HstarClassicOpenShopAdapter && window.HstarClassicOpenShopHooks?.getNodes), kind);
  return frame;
}

async function openNode(page, canvasFrame, kind, nodeId, expectedSources = null, {welcome = null} = {}){
  await canvasFrame.waitForFunction(({canvasKind, id}) => canvasKind === 'smart'
    ? Boolean(window.HstarSmartCanvasOpenShopHooks?.getNode?.(id))
    : Boolean(window.HstarClassicOpenShopHooks?.getNodes?.().some(node => node.id === id)), {canvasKind:kind, id:nodeId});
  const opened = await canvasFrame.evaluate(({canvasKind, id}) => canvasKind === 'smart'
    ? window.HstarSmartOpenShopAdapter.openNode(id)
    : window.HstarClassicOpenShopAdapter.openNode(id), {canvasKind:kind, id:nodeId});
  expect(opened).toBe(true);
  await page.waitForFunction(({id}) => {
    const state = window.HstarOpenShopHost?.getState?.();
    return state?.activeSession?.context?.nodeId === id && state.editorReady;
  }, {id:nodeId});
  const activeSession = await page.evaluate(() => window.HstarOpenShopHost.getState().activeSession);
  const frameElement = page.locator(`iframe.openshop-session-frame[data-project-id="${activeSession.context.projectId}"]`);
  await frameElement.waitFor();
  const editor = await (await frameElement.elementHandle()).contentFrame();
  await editor.waitForFunction(id => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopRuntime?.getState?.().activeSession?.context?.nodeId === id
  ), nodeId);
  if(welcome === 'visible') await expect(editor.locator('#welcome-overlay')).toBeVisible();
  if(welcome === 'hidden') await expect(editor.locator('#welcome-overlay')).toBeHidden();
  if(expectedSources !== null){
    await editor.waitForFunction(count => OS.layers.filter(layer => layer.sourceBinding).length >= count, expectedSources);
  }
  const expectedPersistence = {
    mode:'embedded-hstara',
    timerActive:false,
    dirty:false,
    recoveryStarted:false,
    recoveryControlCount:0,
  };
  let settledObservations = 0;
  await expect.poll(async () => {
    const state = await editor.evaluate(() => ({
      mode:OS._persistenceMode,
      timerActive:OS._autoSaveTimer !== null,
      dirty:Boolean(window.HstarOpenShopRuntime?.getState?.().dirty),
      recoveryStarted:Boolean(OS._recoveryStartupStarted),
      recoveryControlCount:document.querySelectorAll('[data-recovery-restore], [data-recovery-discard]').length,
    }));
    const matches = Object.entries(expectedPersistence).every(([key, value]) => state[key] === value);
    settledObservations = matches ? settledObservations + 1 : 0;
    return settledObservations >= 3 ? state : null;
  }, {
    message:`OpenShop recovery state did not settle for node ${nodeId}`,
    timeout:10000,
    intervals:[200, 300, 500],
  }).toEqual(expectedPersistence);
  await expect(editor.locator('[data-recovery-restore]')).toHaveCount(0);
  await expect(editor.locator('[data-recovery-discard]')).toHaveCount(0);
  return editor;
}

async function saveEditorMarker(editor, marker){
  await editor.evaluate(value => {
    OS.addLayer();
    const layer = OS.layers[OS.activeLayerIdx];
    layer.name = value;
    const text = new fabric.IText(value, {
      left:48, top:48, scaleX:1.05, scaleY:0.95, angle:3,
      fill:'#111827', fontSize:36, name:`${value} marker`,
    });
    const stackingProbe = new fabric.Rect({
      left:112, top:104, width:24, height:16, scaleX:0.75, scaleY:1.25, angle:7,
      fill:'#2563eb', name:`${value} stacking probe`, selectable:false, evented:false,
    });
    OS.canvas.add(text);
    OS.canvas.add(stackingProbe);
    layer.objects.push(text, stackingProbe);
    OS.updateLayersPanel();
    OS.canvas.renderAll();
    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'e2e-marker'}}));
  }, marker);
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSave({reason:'e2e-marker'}));
}

async function exactLayerSummary(editor){
  return editor.evaluate(() => {
    const normalizedNumber = (value, fallback) => {
      const number = Number(value ?? fallback);
      if(!Number.isFinite(number)) return null;
      const rounded = Math.round(number * 1e6) / 1e6;
      return Object.is(rounded, -0) ? 0 : rounded;
    };
    const summarizeObject = (object, index) => ({
      index,
      type:String(object?.type || ''),
      name:String(object?.name || ''),
      text:typeof object?.text === 'string' ? object.text : null,
      left:normalizedNumber(object?.left, 0),
      top:normalizedNumber(object?.top, 0),
      scaleX:normalizedNumber(object?.scaleX, 1),
      scaleY:normalizedNumber(object?.scaleY, 1),
      angle:normalizedNumber(object?.angle, 0),
    });
    const objectOwners = new Map();
    const layersById = new Map();
    const layers = OS.layers.map((layer, index) => {
      const identity = {
        index,
        layerId:String(layer?.layerId || ''),
        name:String(layer?.name || ''),
        type:String(layer?.type || 'normal'),
      };
      if(identity.layerId) layersById.set(identity.layerId, identity);
      (Array.isArray(layer?.objects) ? layer.objects : []).forEach(object => objectOwners.set(object, identity));
      return {
        index,
        name:identity.name,
        type:identity.type,
        visible:layer?.visible !== false,
        opacity:normalizedNumber(layer?.opacity, 100),
        blend:String(layer?.blend || 'source-over'),
        locked:Boolean(layer?.locked),
        objects:(Array.isArray(layer?.objects) ? layer.objects : []).map(summarizeObject),
      };
    });
    const canvasObjects = OS.canvas.getObjects().map((object, index) => {
      const objectLayerId = String(object?.hstarLayerId || '');
      const owner = objectOwners.get(object) || layersById.get(objectLayerId) || null;
      return {
        ...summarizeObject(object, index),
        owner:owner ? {
          index:owner.index,
          layerId:owner.layerId || objectLayerId,
          name:owner.name,
          type:owner.type,
        } : null,
      };
    });
    return {
      layers,
      canvasObjects,
    };
  });
}

async function editorSnapshot(editor){
  return editor.evaluate(() => ({
    layers:OS.layers.map(layer => ({name:layer.name, source:layer.sourceBinding ? {...layer.sourceBinding} : null})),
    texts:OS.canvas.getObjects().filter(object => ['i-text', 'text', 'textbox'].includes(object.type)).map(object => object.text),
    runtime:window.HstarOpenShopRuntime.getState(),
  }));
}

test('keeps OpenShop node actions visible inside classic and smart canvas cards', async ({page, request}) => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for(const kind of ['classic', 'smart']){
    const nodeId = `${TEST_ID_PREFIX}layout-${kind}-${runId}`;
    const node = {
      id:nodeId, type:'openshop-layered', projectId:`${TEST_ID_PREFIX}layout-project-${kind}-${runId}`,
      projectName:`OpenShop layout ${kind}`, x:220, y:180, w:340, h:260,
      documentWidth:1920, documentHeight:1080, layerCount:0, sourceUpdateCount:0,
      autosaveVersion:0, saveState:'new', created_at:Date.now(),
    };
    const canvas = await createCanvas(request, {
      kind, title:`OpenShop layout ${kind}`, nodes:[node], connections:[],
    });
    const frame = await mountCanvas(page, kind, canvas.id);
    const card = frame.locator(`.openshop-layered-node[data-id="${nodeId}"]`);
    await expect(card).toBeVisible();

    const geometry = await card.evaluate(element => {
      const rect = target => {
        const value = target.getBoundingClientRect();
        return {top:value.top, right:value.right, bottom:value.bottom, left:value.left, width:value.width, height:value.height};
      };
      return {
        node:rect(element),
        body:rect(element.querySelector('.node-body')),
        preview:rect(element.querySelector('.openshop-layered-preview')),
        meta:rect(element.querySelector('.openshop-layered-meta')),
        button:rect(element.querySelector('.openshop-layered-open')),
      };
    });

    expect(geometry.button.width).toBeGreaterThan(0);
    expect(geometry.button.height).toBeGreaterThan(0);
    expect(geometry.preview.bottom).toBeLessThanOrEqual(geometry.meta.top + 0.5);
    expect(geometry.meta.bottom).toBeLessThanOrEqual(geometry.button.top + 0.5);
    expect(geometry.button.bottom).toBeLessThanOrEqual(geometry.body.bottom + 0.5);
    expect(geometry.button.bottom).toBeLessThanOrEqual(geometry.node.bottom + 0.5);
  }
});

test('opens empty OpenShop nodes on templates and sourced nodes directly in the workspace', async ({page, request}) => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sourceImages = [
    {
      id:'entry-source-image-1', type:'image', x:60, y:120, w:260, h:240,
      url:`${imageUrls[0]}?entry=${runId}-1`, name:'entry-source-1.png', mediaKind:'image', assetVersion:`entry-${runId}-1`,
    },
    {
      id:'entry-source-image-2', type:'image', x:60, y:420, w:280, h:220,
      url:`${imageUrls[1]}?entry=${runId}-2`, name:'entry-source-2.png', mediaKind:'image', assetVersion:`entry-${runId}-2`,
    },
  ];
  const emptyNode = {
    id:`${TEST_ID_PREFIX}entry-empty-${runId}`, type:'openshop-layered',
    projectId:`${TEST_ID_PREFIX}entry-empty-project-${runId}`,
    projectName:'Empty OpenShop entry', x:420, y:100, w:340, h:260,
    documentWidth:1920, documentHeight:1080, saveState:'new', created_at:Date.now(),
  };
  const sourcedNode = {
    ...emptyNode, id:`${TEST_ID_PREFIX}entry-sourced-${runId}`,
    projectId:`${TEST_ID_PREFIX}entry-sourced-project-${runId}`,
    projectName:'Sourced OpenShop entry', x:420, y:440,
  };
  const canvas = await createCanvas(request, {
    kind:'classic', title:'OpenShop entry modes', nodes:[...sourceImages, emptyNode, sourcedNode],
    connections:sourceImages.map((source, index) => ({id:`entry-source-edge-${index + 1}`, from:source.id, to:sourcedNode.id})),
  });
  const frame = await mountCanvas(page, 'classic', canvas.id);

  await openNode(page, frame, 'classic', emptyNode.id, 0, {welcome:'visible'});
  await page.evaluate(() => window.HstarOpenShopHost.close());

  await page.evaluate(projectId => {
    window.__openshopEntrySamples = [];
    window.__openshopEntrySampling = true;
    const sample = () => {
      if(!window.__openshopEntrySampling) return;
      const frameElement = document.querySelector(`iframe.openshop-session-frame[data-project-id="${projectId}"]`);
      const welcome = frameElement?.contentDocument?.getElementById('welcome-overlay');
      if(frameElement && welcome){
        const style = frameElement.contentWindow.getComputedStyle(welcome);
        window.__openshopEntrySamples.push({
          frameHidden:Boolean(frameElement.hidden),
          welcomeVisible:style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0',
        });
      }
      requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  }, sourcedNode.projectId);

  const sourcedEditor = await openNode(page, frame, 'classic', sourcedNode.id, 2, {welcome:'hidden'});
  await sourcedEditor.waitForFunction(() => {
    const vpt = OS.canvas?.viewportTransform;
    if(!Array.isArray(vpt) || !Number.isFinite(Number(vpt[0])) || Number(vpt[0]) <= 0) return false;
    const documentCenter = {
      x:Number(OS.canvasW) * Number(vpt[0]) / 2 + Number(vpt[4]),
      y:Number(OS.canvasH) * Number(vpt[3]) / 2 + Number(vpt[5]),
    };
    return Math.abs(documentCenter.x - Number(OS.canvas.width) / 2) < 1
      && Math.abs(documentCenter.y - Number(OS.canvas.height) / 2) < 1;
  });
  const placement = await sourcedEditor.evaluate(() => {
    const sourceLayers = OS.layers.filter(layer => layer.sourceBinding);
    const vpt = OS.canvas.viewportTransform.map(Number);
    return {
      layers:sourceLayers.map(layer => {
        const center = layer.objects?.[0]?.getCenterPoint?.();
        return {
          sequence:Number(layer.sourceBinding.sequence),
          center:{x:Number(center?.x), y:Number(center?.y)},
        };
      }),
      document:{width:OS.canvasW, height:OS.canvasH},
      viewport:{
        zoom:vpt[0],
        width:Number(OS.canvas.width),
        height:Number(OS.canvas.height),
        documentLeft:vpt[4],
        documentTop:vpt[5],
        documentRight:vpt[4] + Number(OS.canvasW) * vpt[0],
        documentBottom:vpt[5] + Number(OS.canvasH) * vpt[3],
      },
    };
  });
  const samples = await page.evaluate(() => {
    window.__openshopEntrySampling = false;
    return window.__openshopEntrySamples || [];
  });

  expect(samples.length).toBeGreaterThan(0);
  expect(samples.some(sample => !sample.frameHidden && sample.welcomeVisible)).toBe(false);
  expect(placement.viewport.zoom).toBeGreaterThan(0);
  expect(placement.viewport.documentLeft).toBeGreaterThanOrEqual(0);
  expect(placement.viewport.documentTop).toBeGreaterThanOrEqual(0);
  expect(placement.viewport.documentRight).toBeLessThanOrEqual(placement.viewport.width);
  expect(placement.viewport.documentBottom).toBeLessThanOrEqual(placement.viewport.height);
  expect(placement.layers.map(layer => layer.sequence)).toEqual([0, 1]);
  placement.layers.forEach(layer => {
    expect(layer.center.x).toBeCloseTo(placement.document.width / 2, 3);
    expect(layer.center.y).toBeCloseTo(placement.document.height / 2, 3);
  });
});

test('uses the first source dimensions and exports the full 4K document without cropping', async ({page, request}) => {
  test.setTimeout(180000);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const sourceNode = {
    id:'source-4k', type:'image', x:60, y:120, w:260, h:240,
    url:imageUrls[0], name:'source-4k.png', mediaKind:'image', assetVersion:`4k-${runId}`,
    natural_w:3840, natural_h:2160,
  };
  const layeredNode = {
    id:`${TEST_ID_PREFIX}4k-node-${runId}`, type:'openshop-layered',
    projectId:`${TEST_ID_PREFIX}4k-project-${runId}`,
    projectName:'OpenShop 4K source', x:420, y:160, w:340, h:260,
    documentWidth:1920, documentHeight:1080, saveState:'new', created_at:Date.now(),
  };
  let canvas = await createCanvas(request, {
    kind:'classic', title:'OpenShop 4K source', nodes:[sourceNode, layeredNode],
    connections:[{id:'edge-4k', from:sourceNode.id, to:layeredNode.id}],
  });
  await apiJson(await request.post(`${baseUrl}/api/openshop/projects/${layeredNode.projectId}/initialize`, {
    data:{
      owner:{canvasType:'classic', canvasId:canvas.id, nodeId:layeredNode.id},
      document:{width:1920, height:1080},
    },
  }));
  const uploaded = await apiJson(await request.post(`${baseUrl}/api/openshop/projects/${layeredNode.projectId}/assets`, {
    multipart:{
      canvas_type:'classic', canvas_id:canvas.id, node_id:layeredNode.id, role:'source',
      file:{name:'source-4k.png', mimeType:'image/png', buffer:await solidPngBuffer(page, 3840, 2160)},
    },
  }));
  sourceNode.url = uploaded.asset.url;
  sourceNode.assetVersion = uploaded.asset.assetId;
  canvas = await saveCanvasGraph(request, canvas, {
    nodes:[sourceNode, layeredNode],
    connections:[{id:'edge-4k', from:sourceNode.id, to:layeredNode.id}],
  });

  const frame = await mountCanvas(page, 'classic', canvas.id);
  const editor = await openNode(page, frame, 'classic', layeredNode.id, 1, {welcome:'hidden'});
  await expect.poll(() => editor.evaluate(() => ({width:OS.canvasW, height:OS.canvasH}))).toEqual({width:3840, height:2160});
  const initialLayers = await editor.evaluate(() => {
    OS.setTool('select');
    return OS.layers.map(layer => ({
      name:layer.name,
      locked:Boolean(layer.locked),
      sourceAssetId:layer.sourceBinding?.assetId || '',
      objects:layer.objects.map(object => ({
        name:object.name,
        width:object.width,
        height:object.height,
        selectable:Boolean(object.selectable),
        evented:Boolean(object.evented),
      })),
    }));
  });
  expect(initialLayers).toHaveLength(2);
  expect(initialLayers[0]).toMatchObject({name:'Background', locked:true, sourceAssetId:''});
  expect(initialLayers[0].objects[0]).toMatchObject({
    name:'__boundary__', width:3840, height:2160, selectable:false, evented:false,
  });
  expect(initialLayers[1]).toMatchObject({locked:false, sourceAssetId:uploaded.asset.assetId});
  expect(initialLayers[1].objects[0]).toMatchObject({width:3840, height:2160, selectable:true, evented:true});

  await editor.evaluate(() => {
    OS.addLayer();
    const overlay = new fabric.Rect({
      left:960, top:540, width:640, height:360, fill:'#ef4444',
      name:'4K overlay', selectable:true, evented:true,
    });
    OS.canvas.add(overlay);
    OS.layers[OS.activeLayerIdx].objects.push(overlay);
    OS.saveHistory('4K overlay');
    OS.updateLayersPanel();
  });
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await expect.poll(() => frame.evaluate(id => {
    return window.HstarClassicOpenShopHooks.getNodes().filter(node => node.openshopSourceNodeId === id).length;
  }, layeredNode.id)).toBe(1);
  const output = await frame.evaluate(id => {
    return window.HstarClassicOpenShopHooks.getNodes().find(node => node.openshopSourceNodeId === id);
  }, layeredNode.id);
  const syncedLayeredNode = await frame.evaluate(id => window.HstarClassicOpenShopHooks.getNodes().find(node => node.id === id), layeredNode.id);

  expect(output).toMatchObject({natural_w:3840, natural_h:2160});
  expect(syncedLayeredNode).toMatchObject({documentWidth:3840, documentHeight:2160});
  expect(await decodedImageSize(frame, output.url)).toEqual({width:3840, height:2160});
  expect(await decodedImageEdgeAlpha(frame, output.url)).toEqual([255, 255, 255, 255, 255, 255, 255, 255]);
  expect((await request.get(`${baseUrl}${output.url}`)).status()).toBe(200);
  const storedProject = await projectRecord(request, {
    canvasType:'classic', canvasId:canvas.id, nodeId:layeredNode.id, projectId:layeredNode.projectId,
  });
  expect(storedProject.body.project.document).toMatchObject({width:3840, height:2160});
  expect(storedProject.body.project.layers).toHaveLength(3);
  expect(storedProject.body.project.layers[0]).toMatchObject({name:'Background', locked:true});
  expect(storedProject.body.project.exportRecords.at(-1)).toMatchObject({
    assetId:output.openshopAssetId,
    width:3840,
    height:2160,
  });
  expect(storedProject.body.project.assetRefs).toContain(output.openshopAssetId);
});

test('classic canvas preserves isolated projects, ordered sources, updates, clones, and deletion', async ({page, request}) => {
  test.setTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const nodeA = {
    id:`${TEST_ID_PREFIX}node-a-${runId}`, type:'openshop-layered',
    projectId:`${TEST_ID_PREFIX}project-a-${runId}`, projectName:'项目 A',
    x:640, y:180, w:340, h:260, documentWidth:1920, documentHeight:1080,
    layerCount:0, sourceUpdateCount:0, autosaveVersion:0, saveState:'new', created_at:Date.now(),
  };
  const nodeB = {
    ...nodeA, id:`${TEST_ID_PREFIX}node-b-${runId}`,
    projectId:`${TEST_ID_PREFIX}project-b-${runId}`, projectName:'项目 B', x:640, y:520,
  };
  const images = imageUrls.map((url, index) => ({
    id:`classic-image-${index + 1}`, type:'image', x:80, y:80 + index * 300, w:260, h:240,
    url, name:`来源 ${index + 1}.png`, mediaKind:'image', assetVersion:`classic-v1-${index + 1}`,
  }));
  const classic = await createCanvas(request, {
    kind:'classic',
    title:'OpenShop E2E Classic',
    nodes:[...images, nodeA, nodeB],
    connections:images.map((image, index) => ({id:`classic-edge-${index + 1}`, from:image.id, to:nodeA.id})),
  });

  let frame = await mountCanvas(page, 'classic', classic.id);
  let editor = await openNode(page, frame, 'classic', nodeA.id, 3);
  let snapshot = await editorSnapshot(editor);
  expect(snapshot.layers.filter(layer => layer.source).map(layer => layer.name)).toEqual(['来源 1.png', '来源 2.png', '来源 3.png']);
  expect(snapshot.layers.filter(layer => layer.source).map(layer => layer.source.sequence)).toEqual([0, 1, 2]);
  await saveEditorMarker(editor, 'A 独立文字');
  const nodeASummary = await exactLayerSummary(editor);

  editor = await openNode(page, frame, 'classic', nodeB.id, 0);
  await saveEditorMarker(editor, 'B 独立文字');
  const nodeBSummary = await exactLayerSummary(editor);
  editor = await openNode(page, frame, 'classic', nodeA.id, 3);
  snapshot = await editorSnapshot(editor);
  expect(snapshot.texts).toContain('A 独立文字');
  expect(snapshot.texts).not.toContain('B 独立文字');

  await page.evaluate(() => window.HstarOpenShopHost.close({force:true}));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(window.HstarOpenShopHost));
  frame = await mountCanvas(page, 'classic', classic.id);
  editor = await openNode(page, frame, 'classic', nodeA.id, 3);
  expect(await exactLayerSummary(editor)).toEqual(nodeASummary);
  snapshot = await editorSnapshot(editor);
  expect(snapshot.texts).toContain('A 独立文字');
  expect(snapshot.texts).not.toContain('B 独立文字');
  expect(await editor.evaluate(() => ({
    mode:OS._persistenceMode,
    timerActive:OS._autoSaveTimer !== null,
    dirty:OS._autoSaveDirty,
  }))).toEqual({mode:'embedded-hstara', timerActive:false, dirty:false});

  editor = await openNode(page, frame, 'classic', nodeB.id, 0);
  expect(await exactLayerSummary(editor)).toEqual(nodeBSummary);
  snapshot = await editorSnapshot(editor);
  expect(snapshot.texts).toContain('B 独立文字');
  expect(snapshot.texts).not.toContain('A 独立文字');
  expect(await editor.evaluate(() => ({
    mode:OS._persistenceMode,
    timerActive:OS._autoSaveTimer !== null,
    dirty:OS._autoSaveDirty,
  }))).toEqual({mode:'embedded-hstara', timerActive:false, dirty:false});

  editor = await openNode(page, frame, 'classic', nodeA.id, 3);

  await frame.evaluate(async () => {
    const source = window.HstarClassicOpenShopHooks.getNodes().find(node => node.id === 'classic-image-2');
    source.url = '/static/images/RunningHub-W.png';
    source.assetVersion = 'classic-v2-2';
    await window.HstarClassicOpenShopHooks.saveCanvas();
  });
  editor = await openNode(page, frame, 'classic', nodeA.id, 3);
  await expect.poll(() => page.evaluate(() => window.HstarOpenShopHost.getState().sourceUpdateCount)).toBe(1);
  const sourcePanel = page.locator('[data-openshop-source-panel]');
  await page.locator('[data-openshop-sources]').click();
  await expect(sourcePanel).toHaveClass(/\bis-open\b/);
  await expect(sourcePanel).toHaveAttribute('aria-hidden', 'false');
  const addSourceLayer = sourcePanel.locator('button', {hasText:'作为新图层加入'});
  await expect(addSourceLayer).toBeVisible();
  await addSourceLayer.click();
  await editor.waitForFunction(() => OS.layers.filter(layer => layer.sourceBinding).length === 4);
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSave({reason:'e2e-source-update'}));

  await frame.evaluate(async () => {
    const connections = window.HstarClassicOpenShopHooks.getConnections();
    const index = connections.findIndex(connection => connection.id === 'classic-edge-1');
    if(index >= 0) connections.splice(index, 1);
    await window.HstarClassicOpenShopHooks.saveCanvas();
  });
  editor = await openNode(page, frame, 'classic', nodeA.id, 2);
  await editor.waitForFunction(() => OS.layers.some(layer => layer.sourceBinding?.state === 'detached'));
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSave({reason:'e2e-detach'}));

  const cloneInfo = await frame.evaluate(async nodeAId => {
    const hooks = window.HstarClassicOpenShopHooks;
    const source = hooks.getNodes().find(node => node.id === nodeAId);
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = 'openshop-c';
    copy.x += 430;
    window.HstarClassicOpenShopAdapter.prepareClone(source, copy);
    hooks.addNode(copy);
    hooks.render();
    await hooks.saveCanvas();
    return {projectId:copy.projectId, sourceProjectId:source.projectId};
  }, nodeA.id);
  expect(cloneInfo.projectId).not.toBe(cloneInfo.sourceProjectId);
  editor = await openNode(page, frame, 'classic', 'openshop-c', 0);
  expect((await editorSnapshot(editor)).texts).toContain('A 独立文字');
  await saveEditorMarker(editor, 'C 克隆文字');
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await expect.poll(() => frame.evaluate(() => {
    return window.HstarClassicOpenShopHooks.getNodes()
      .filter(node => node.openshopSourceNodeId === 'openshop-c').length;
  })).toBe(1);
  const cloneOutput = await frame.evaluate(() => {
    const node = window.HstarClassicOpenShopHooks.getNodes()
      .find(candidate => candidate.openshopSourceNodeId === 'openshop-c');
    return {id:node.id, url:node.url, assetId:node.openshopAssetId};
  });
  editor = await openNode(page, frame, 'classic', nodeA.id, 2);
  expect((await editorSnapshot(editor)).texts).not.toContain('C 克隆文字');

  const stale = await page.evaluate(() => window.HstarOpenShopHost.getState().activeSession);
  const staleProject = (await projectRecord(request, {
    ...stale.context,
    canvasType:'classic',
  })).body.project;
  editor = await openNode(page, frame, 'classic', nodeB.id, 0);
  const beforeLate = await page.evaluate(() => window.HstarOpenShopHost.getState());
  await editor.evaluate(({session, project}) => {
    parent.postMessage(window.HstarOpenShopProtocol.createEnvelope({
      type:window.HstarOpenShopProtocol.TYPES.SAVE_PROJECT,
      sessionId:session.sessionId,
      requestId:'late-save-e2e',
      context:session.context,
      payload:{project},
    }), location.origin);
  }, {session:stale, project:staleProject});
  await page.waitForTimeout(150);
  const afterLate = await page.evaluate(() => window.HstarOpenShopHost.getState());
  expect(afterLate.activeSession.context.nodeId).toBe(nodeB.id);
  expect(afterLate.autosaveVersion).toBe(beforeLate.autosaveVersion);

  await frame.evaluate(async projectId => {
    const hooks = window.HstarClassicOpenShopHooks;
    const nodes = hooks.getNodes();
    const index = nodes.findIndex(node => node.projectId === projectId);
    if(index >= 0){
      window.HstarClassicOpenShopAdapter.disposeNode(nodes[index]);
      nodes.splice(index, 1);
    }
    const connections = hooks.getConnections();
    for(let cursor = connections.length - 1; cursor >= 0; cursor -= 1){
      if(connections[cursor].from === 'openshop-c' || connections[cursor].to === 'openshop-c') connections.splice(cursor, 1);
    }
    hooks.render();
    await hooks.saveCanvas();
  }, cloneInfo.projectId);
  await expect.poll(async () => (await projectRecord(request, {
    canvasType:'classic', canvasId:classic.id, nodeId:'openshop-c', projectId:cloneInfo.projectId,
  })).response.status()).toBe(404);

  const projectA = await projectRecord(request, {canvasType:'classic', canvasId:classic.id, nodeId:nodeA.id, projectId:nodeA.projectId});
  const projectB = await projectRecord(request, {canvasType:'classic', canvasId:classic.id, nodeId:nodeB.id, projectId:nodeB.projectId});
  expect(projectA.response.status()).toBe(200);
  expect(projectB.response.status()).toBe(200);
  const afterCloneDeletion = await canvasRecord(request, classic.id);
  expect(afterCloneDeletion.nodes.some(node => node.id === 'openshop-c')).toBe(false);
  expect(afterCloneDeletion.nodes.find(node => node.id === cloneOutput.id)).toMatchObject({
    url:cloneOutput.url,
    openshopAssetId:cloneOutput.assetId,
    openshopSourceNodeId:'openshop-c',
  });
  expect((await request.get(`${baseUrl}${cloneOutput.url}`)).status()).toBe(200);
  expect(projectA.body.project.sourceBindings.some(binding => binding.state === 'detached')).toBe(true);
  expect(JSON.stringify(await canvasRecord(request, classic.id))).not.toMatch(/data:image\//);
  expect(JSON.stringify(projectA.body.project)).not.toMatch(/data:image\//);
  expect(pageErrors).toEqual([]);
});

test('classic and smart canvases receive every OpenShop output as new image nodes', async ({page, request}) => {
  test.setTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const classicNode = {
    id:`${TEST_ID_PREFIX}classic-output-source-${runId}`, type:'openshop-layered',
    projectId:`${TEST_ID_PREFIX}output-classic-${runId}`, projectName:'普通输出',
    x:200, y:180, w:340, h:260, documentWidth:640, documentHeight:480, saveState:'new', created_at:Date.now(),
  };
  const classic = await createCanvas(request, {kind:'classic', title:'Classic output', nodes:[classicNode], connections:[]});
  let frame = await mountCanvas(page, 'classic', classic.id);
  let editor = await openNode(page, frame, 'classic', classicNode.id, 0);
  await editor.evaluate(() => OS.createNewDocument(1600, 900));
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await expect.poll(() => frame.evaluate(() => window.HstarClassicOpenShopHooks.getNodes().filter(node => node.sourceType === 'openshop-layered').length)).toBe(2);
  const classicRecord = await canvasRecord(request, classic.id);
  const classicOutputs = classicRecord.nodes.filter(node => node.sourceType === 'openshop-layered');
  const savedClassicNode = classicRecord.nodes.find(node => node.id === classicNode.id);
  expect(classicOutputs).toHaveLength(2);
  expect(classicOutputs.every(node => /^\/api\/openshop\/assets\//.test(node.url))).toBe(true);
  expect(classicOutputs.every(node => node.natural_w === 1600 && node.natural_h === 900)).toBe(true);
  expect(await decodedImageSize(frame, classicOutputs[0].url)).toEqual({width:1600, height:900});
  expect(savedClassicNode).toMatchObject({documentWidth:1600, documentHeight:900});
  expect(new Set(classicOutputs.map(node => node.id)).size).toBe(2);

  const smartImage = {
    id:'smart-source-image', type:'smart-image', x:40, y:100,
    images:[{url:imageUrls[0], name:'智能来源.png', kind:'image', assetVersion:'smart-v1'}], created_at:Date.now(),
  };
  const smartNode = {
    id:`${TEST_ID_PREFIX}smart-output-source-${runId}`, type:'openshop-layered',
    projectId:`${TEST_ID_PREFIX}output-smart-${runId}`, projectName:'智能输出',
    x:500, y:180, w:340, h:260, documentWidth:640, documentHeight:480, saveState:'new', inputNodeIds:[smartImage.id], created_at:Date.now(),
  };
  const smart = await createCanvas(request, {
    kind:'smart', title:'Smart output', nodes:[smartImage, smartNode],
    connections:[{id:'smart-output-edge', from:smartImage.id, to:smartNode.id, kind:'input'}],
  });
  frame = await mountCanvas(page, 'smart', smart.id);
  editor = await openNode(page, frame, 'smart', smartNode.id, 1);
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await expect.poll(() => frame.evaluate(nodeId => {
    const hooks = window.HstarSmartCanvasOpenShopHooks;
    return [nodeId].flatMap(id => {
      const source = hooks.getNode(id);
      return source ? hooks.getConnections().filter(connection => connection.from === source.id && (connection.kind || 'flow') === 'flow') : [];
    }).length;
  }, smartNode.id)).toBe(2);
  const smartRecord = await canvasRecord(request, smart.id);
  const smartOutputs = smartRecord.nodes.filter(node => node.sourceType === 'openshop-layered');
  expect(smartOutputs).toHaveLength(2);
  expect(smartOutputs.every(node => /^\/api\/openshop\/assets\//.test(node.images?.[0]?.url))).toBe(true);
  const decodedSmartOutput = await decodedImageSize(frame, smartOutputs[0].images[0].url);
  expect(smartOutputs[0].images[0]).toMatchObject({natural_w:decodedSmartOutput.width, natural_h:decodedSmartOutput.height});
  expect(new Set(smartOutputs.map(node => node.id)).size).toBe(2);
  expect(smartNode.projectId).not.toBe(classicNode.projectId);
  expect(JSON.stringify(smartRecord)).not.toMatch(/data:image\//);
  expect(pageErrors).toEqual([]);
});
