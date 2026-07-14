import { expect, test } from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const imageUrls = [
  '/static/images/logo.png',
  '/static/images/RunningHub-B.png',
  '/static/images/lingjing.png',
];

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
      client_id:'openshop-e2e-seed',
    },
  }));
  return saved.canvas;
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

async function openNode(page, canvasFrame, kind, nodeId, expectedSources = null){
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
  const editor = page.frames().find(frame => frame.url().includes('/static/openshop/index.html'));
  await editor.waitForFunction(() => Boolean(typeof OS !== 'undefined' && OS.canvas && window.HstarOpenShopRuntime?.getState?.().activeSession));
  if(expectedSources !== null){
    await editor.waitForFunction(count => OS.layers.filter(layer => layer.sourceBinding).length >= count, expectedSources);
  }
  return editor;
}

async function saveEditorMarker(editor, marker){
  await editor.evaluate(value => {
    OS.addLayer();
    const layer = OS.layers[OS.activeLayerIdx];
    layer.name = value;
    const text = new fabric.IText(value, {left:48, top:48, fill:'#111827', fontSize:36});
    OS.canvas.add(text);
    layer.objects.push(text);
    OS.updateLayersPanel();
    OS.canvas.renderAll();
    window.dispatchEvent(new CustomEvent('openshop:project-dirty', {detail:{action:'e2e-marker'}}));
  }, marker);
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSave({reason:'e2e-marker'}));
}

async function editorSnapshot(editor){
  return editor.evaluate(() => ({
    layers:OS.layers.map(layer => ({name:layer.name, source:layer.sourceBinding ? {...layer.sourceBinding} : null})),
    texts:OS.canvas.getObjects().filter(object => ['i-text', 'text', 'textbox'].includes(object.type)).map(object => object.text),
    runtime:window.HstarOpenShopRuntime.getState(),
  }));
}

test('classic canvas preserves isolated projects, ordered sources, updates, clones, and deletion', async ({page, request}) => {
  test.setTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));

  const nodeA = {
    id:'openshop-a', type:'openshop-layered', projectId:'e2e_project_a', projectName:'项目 A',
    x:640, y:180, w:340, h:260, documentWidth:1920, documentHeight:1080,
    layerCount:0, sourceUpdateCount:0, autosaveVersion:0, saveState:'new', created_at:Date.now(),
  };
  const nodeB = {...nodeA, id:'openshop-b', projectId:'e2e_project_b', projectName:'项目 B', x:640, y:520};
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

  editor = await openNode(page, frame, 'classic', nodeB.id, 0);
  await saveEditorMarker(editor, 'B 独立文字');
  editor = await openNode(page, frame, 'classic', nodeA.id, 3);
  snapshot = await editorSnapshot(editor);
  expect(snapshot.texts).toContain('A 独立文字');
  expect(snapshot.texts).not.toContain('B 独立文字');

  await page.evaluate(() => window.HstarOpenShopHost.close({force:true}));
  await page.reload({waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(window.HstarOpenShopHost));
  frame = await mountCanvas(page, 'classic', classic.id);
  editor = await openNode(page, frame, 'classic', nodeA.id, 3);
  expect((await editorSnapshot(editor)).texts).toContain('A 独立文字');

  await frame.evaluate(async () => {
    const source = window.HstarClassicOpenShopHooks.getNodes().find(node => node.id === 'classic-image-2');
    source.url = '/static/images/RunningHub-W.png';
    source.assetVersion = 'classic-v2-2';
    await window.HstarClassicOpenShopHooks.saveCanvas();
  });
  editor = await openNode(page, frame, 'classic', nodeA.id, 3);
  await expect.poll(() => page.evaluate(() => window.HstarOpenShopHost.getState().sourceUpdateCount)).toBe(1);
  await page.locator('[data-openshop-sources]').click();
  await page.getByRole('button', {name:'作为新图层加入'}).click();
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

  const cloneInfo = await frame.evaluate(async () => {
    const hooks = window.HstarClassicOpenShopHooks;
    const source = hooks.getNodes().find(node => node.id === 'openshop-a');
    const copy = JSON.parse(JSON.stringify(source));
    copy.id = 'openshop-c';
    copy.x += 430;
    window.HstarClassicOpenShopAdapter.prepareClone(source, copy);
    hooks.addNode(copy);
    hooks.render();
    await hooks.saveCanvas();
    return {projectId:copy.projectId, sourceProjectId:source.projectId};
  });
  expect(cloneInfo.projectId).not.toBe(cloneInfo.sourceProjectId);
  editor = await openNode(page, frame, 'classic', 'openshop-c', 0);
  expect((await editorSnapshot(editor)).texts).toContain('A 独立文字');
  await saveEditorMarker(editor, 'C 克隆文字');
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
    if(index >= 0) nodes.splice(index, 1);
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
  expect(projectA.body.project.sourceBindings.some(binding => binding.state === 'detached')).toBe(true);
  expect(JSON.stringify(await canvasRecord(request, classic.id))).not.toMatch(/data:image\//);
  expect(JSON.stringify(projectA.body.project)).not.toMatch(/data:image\//);
  expect(pageErrors).toEqual([]);
});

test('classic and smart canvases receive every OpenShop output as new image nodes', async ({page, request}) => {
  test.setTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));

  const classicNode = {
    id:'classic-output-source', type:'openshop-layered', projectId:'e2e_output_classic', projectName:'普通输出',
    x:200, y:180, w:340, h:260, documentWidth:640, documentHeight:480, saveState:'new', created_at:Date.now(),
  };
  const classic = await createCanvas(request, {kind:'classic', title:'Classic output', nodes:[classicNode], connections:[]});
  let frame = await mountCanvas(page, 'classic', classic.id);
  let editor = await openNode(page, frame, 'classic', classicNode.id, 0);
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await editor.evaluate(() => window.HstarOpenShopRuntime.requestSendToCanvas());
  await expect.poll(() => frame.evaluate(() => window.HstarClassicOpenShopHooks.getNodes().filter(node => node.sourceType === 'openshop-layered').length)).toBe(2);
  const classicRecord = await canvasRecord(request, classic.id);
  const classicOutputs = classicRecord.nodes.filter(node => node.sourceType === 'openshop-layered');
  expect(classicOutputs).toHaveLength(2);
  expect(classicOutputs.every(node => /^\/api\/openshop\/assets\//.test(node.url))).toBe(true);
  expect(new Set(classicOutputs.map(node => node.id)).size).toBe(2);

  const smartImage = {
    id:'smart-source-image', type:'smart-image', x:40, y:100,
    images:[{url:imageUrls[0], name:'智能来源.png', kind:'image', assetVersion:'smart-v1'}], created_at:Date.now(),
  };
  const smartNode = {
    id:'smart-output-source', type:'openshop-layered', projectId:'e2e_output_smart', projectName:'智能输出',
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
  await expect.poll(() => frame.evaluate(() => {
    const hooks = window.HstarSmartCanvasOpenShopHooks;
    return ['smart-output-source'].flatMap(id => {
      const source = hooks.getNode(id);
      return source ? hooks.getConnections().filter(connection => connection.from === source.id && (connection.kind || 'flow') === 'flow') : [];
    }).length;
  })).toBe(2);
  const smartRecord = await canvasRecord(request, smart.id);
  const smartOutputs = smartRecord.nodes.filter(node => node.sourceType === 'openshop-layered');
  expect(smartOutputs).toHaveLength(2);
  expect(smartOutputs.every(node => /^\/api\/openshop\/assets\//.test(node.images?.[0]?.url))).toBe(true);
  expect(new Set(smartOutputs.map(node => node.id)).size).toBe(2);
  expect(smartNode.projectId).not.toBe(classicNode.projectId);
  expect(JSON.stringify(smartRecord)).not.toMatch(/data:image\//);
  expect(pageErrors).toEqual([]);
});
