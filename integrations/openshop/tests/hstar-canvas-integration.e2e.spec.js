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

test('keeps OpenShop node actions visible inside classic and smart canvas cards', async ({page, request}) => {
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  for(const kind of ['classic', 'smart']){
    const nodeId = `openshop-layout-${kind}`;
    const node = {
      id:nodeId, type:'openshop-layered', projectId:`e2e_layout_${kind}_${runId}`,
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
    id:'entry-empty', type:'openshop-layered', projectId:`e2e_entry_empty_${runId}`,
    projectName:'Empty OpenShop entry', x:420, y:100, w:340, h:260,
    documentWidth:1920, documentHeight:1080, saveState:'new', created_at:Date.now(),
  };
  const sourcedNode = {
    ...emptyNode, id:'entry-sourced', projectId:`e2e_entry_sourced_${runId}`,
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

test('classic canvas preserves isolated projects, ordered sources, updates, clones, and deletion', async ({page, request}) => {
  test.setTimeout(180000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const nodeA = {
    id:'openshop-a', type:'openshop-layered', projectId:`e2e_project_a_${runId}`, projectName:'项目 A',
    x:640, y:180, w:340, h:260, documentWidth:1920, documentHeight:1080,
    layerCount:0, sourceUpdateCount:0, autosaveVersion:0, saveState:'new', created_at:Date.now(),
  };
  const nodeB = {...nodeA, id:'openshop-b', projectId:`e2e_project_b_${runId}`, projectName:'项目 B', x:640, y:520};
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
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  const classicNode = {
    id:'classic-output-source', type:'openshop-layered', projectId:`e2e_output_classic_${runId}`, projectName:'普通输出',
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
    id:'smart-output-source', type:'openshop-layered', projectId:`e2e_output_smart_${runId}`, projectName:'智能输出',
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
