import { expect, test } from '@playwright/test';

const hstarBaseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const openshopUrl = `${hstarBaseUrl}/static/openshop/index.html`;

test('uses the same-origin iframe bridge with stable source layer order', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.goto(hstarBaseUrl, {waitUntil:'domcontentloaded'});
  await page.evaluate(src => {
    document.body.replaceChildren();
    const iframe = document.createElement('iframe');
    iframe.id = 'openshop-foundation-frame';
    iframe.src = src;
    iframe.style.cssText = 'width:100vw;height:100vh;border:0';
    document.body.appendChild(iframe);
  }, openshopUrl);

  const openshopFrame = await page.waitForEvent('framenavigated', {
    predicate: frame => frame.url() === openshopUrl,
  });
  await openshopFrame.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopProtocol
    && window.HstarOpenShopProjectAdapter
    && window.HstarOpenShopRuntime
  ));

  await page.evaluate(() => {
    const child = document.getElementById('openshop-foundation-frame').contentWindow;
    window.__hstarOpenShopMessages = [];
    window.addEventListener('message', event => {
      if(event.source === child && event.origin === window.location.origin){
        window.__hstarOpenShopMessages.push(event.data);
      }
    });
  });
  await openshopFrame.evaluate(() => {
    window.HstarOpenShopRuntime.start({
      editor: OS,
      protocol: window.HstarOpenShopProtocol,
      projectAdapter: window.HstarOpenShopProjectAdapter,
      parentWindow: window.parent,
      origin: window.location.origin,
      imageLoader(source){
        return new Promise((resolve, reject) => {
          const delay = source.sequence === 0 ? 120 : 10;
          setTimeout(() => {
            const raster = document.createElement('canvas');
            raster.width = 48;
            raster.height = 48;
            const context = raster.getContext('2d');
            context.fillStyle = source.sequence === 0 ? '#ef4444' : '#2563eb';
            context.fillRect(0, 0, raster.width, raster.height);
            window.fabric.Image.fromURL(raster.toDataURL('image/png'), image => {
              if(image) resolve(image);
              else reject(new Error('Generated source image could not be decoded'));
            });
          }, delay);
        });
      },
    });
  });

  const context = {
    canvasType: 'classic',
    canvasId: 'canvas-1',
    nodeId: 'node-1',
    projectId: 'project-1',
  };
  await page.evaluate(contextValue => {
    const child = document.getElementById('openshop-foundation-frame').contentWindow;
    child.postMessage({
      type: 'hstar:openshop:open-session',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: 'open-session-1',
      context: contextValue,
      payload: {},
    }, window.location.origin);
  }, context);

  await page.waitForFunction(() => window.__hstarOpenShopMessages.some(
    message => message.type === 'hstar:openshop:ready'
  ));

  await page.evaluate(contextValue => {
    const child = document.getElementById('openshop-foundation-frame').contentWindow;
    const sources = [
      {
        assetId:'asset-1', edgeId:'edge-1', sourceNodeId:'source-node-1',
        assetVersion:'1', name:'第一张.png', url:'data:image/png;base64,source-1', sequence:0,
      },
      {
        assetId:'asset-2', edgeId:'edge-2', sourceNodeId:'source-node-2',
        assetVersion:'1', name:'第二张.png', url:'data:image/png;base64,source-2', sequence:1,
      },
    ];
    sources.forEach((source, index) => child.postMessage({
      type: 'hstar:openshop:add-image-layer',
      protocolVersion: 1,
      sessionId: 'session-1',
      requestId: `add-source-${index + 1}`,
      context: contextValue,
      payload: {source},
    }, window.location.origin));
  }, context);

  await page.waitForFunction(() => window.__hstarOpenShopMessages.filter(
    message => message.type === 'hstar:openshop:project-changed'
  ).length === 2);

  const result = await page.evaluate(() => {
    const messages = window.__hstarOpenShopMessages;
    const ready = messages.find(message => message.type === 'hstar:openshop:ready');
    const changed = messages.filter(message => message.type === 'hstar:openshop:project-changed');
    const project = changed.at(-1).payload.project;
    const sourceLayers = project.layers.filter(layer => layer.sourceBinding);
    return {
      projectScope: ready.payload.projectScope,
      layerNames: sourceLayers.map(layer => layer.name),
      sourceSequences: project.sourceBindings.map(binding => binding.sequence),
    };
  });

  expect(result.projectScope).toBe('openshop:classic:canvas-1:node-1:project-1');
  expect(result.layerNames).toEqual(['第一张.png', '第二张.png']);
  expect(result.sourceSequences).toEqual([0, 1]);
  expect(pageErrors).toEqual([]);
});

test('4K ten-layer foundation baseline', async ({ page }) => {
  test.setTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined' && OS.canvas && window.HstarOpenShopProjectAdapter
  ));

  const metrics = await page.evaluate(async () => {
    const objectUrls = [];
    let result;
    try {
      const createStarted = performance.now();
      OS.createNewDocument(4096, 4096);
      OS.canvas.clear();
      OS.layers = [];

      for(let index = 0; index < 10; index += 1){
        const raster = document.createElement('canvas');
        raster.width = 512;
        raster.height = 512;
        const context = raster.getContext('2d');
        context.fillStyle = `hsl(${index * 36} 70% 55%)`;
        context.fillRect(0, 0, 512, 512);
        context.fillStyle = '#ffffff';
        context.font = 'bold 72px sans-serif';
        context.fillText(String(index + 1), 210, 290);
        const blob = await new Promise((resolve, reject) => raster.toBlob(
          value => value ? resolve(value) : reject(new Error('Raster generation failed')),
          'image/png'
        ));
        const url = URL.createObjectURL(blob);
        objectUrls.push(url);
        const layer = await HstarOpenShopProjectAdapter.queueSourceImageLayer({
          editor: OS,
          source: {
            assetId:`asset-4k-${index}`,
            edgeId:`edge-4k-${index}`,
            sourceNodeId:`source-4k-${index}`,
            assetVersion:'1',
            name:`4K 栅格图层 ${index + 1}`,
            url,
            sequence:index,
          },
        });
        layer.objects[0].set({
          left:(index % 5) * 760 + 120,
          top:Math.floor(index / 5) * 1760 + 320,
        });
      }
      OS.canvas.renderAll();
      const createMs = performance.now() - createStarted;

      const serializeStarted = performance.now();
      const project = HstarOpenShopProjectAdapter.serializeProject({
        editor:OS,
        context:{
          canvasType:'classic', canvasId:'canvas-4k', nodeId:'node-4k', projectId:'project-4k',
        },
      });
      const serialized = JSON.stringify(project);
      const serializeMs = performance.now() - serializeStarted;

      const previewStarted = performance.now();
      const viewport = OS.canvas.viewportTransform.slice();
      OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
      OS.canvas.renderAll();
      const preview = OS.canvas.toDataURL({
        format:'png', left:0, top:0, width:4096, height:4096, multiplier:0.25,
      });
      OS.canvas.viewportTransform = viewport;
      OS.canvas.renderAll();
      const previewMs = performance.now() - previewStarted;

      result = {
        createMs,
        serializeMs,
        previewMs,
        layerCount:project.sourceBindings.length,
        serializedBytes:new TextEncoder().encode(serialized).byteLength,
        previewBytes:preview.length,
      };
    } finally {
      const sourceLayers = OS.layers.filter(layer => layer.sourceBinding);
      sourceLayers.forEach(layer => layer.objects.forEach(object => OS.canvas.remove(object)));
      OS.layers = OS.layers.filter(layer => !layer.sourceBinding);
      objectUrls.forEach(url => URL.revokeObjectURL(url));
      OS.canvas.renderAll();
      if(result){
        result.remainingSourceLayers = OS.layers.filter(layer => layer.sourceBinding).length;
      }
    }
    return result;
  });

  console.log(`HSTAR_4K_BASELINE=${JSON.stringify(metrics)}`);
  expect(metrics.layerCount).toBe(10);
  expect(metrics.createMs).toBeGreaterThanOrEqual(0);
  expect(metrics.serializeMs).toBeGreaterThanOrEqual(0);
  expect(metrics.previewMs).toBeGreaterThanOrEqual(0);
  expect(metrics.serializeMs).toBeLessThan(30000);
  expect(metrics.serializedBytes).toBeGreaterThan(0);
  expect(metrics.previewBytes).toBeGreaterThan(100);
  expect(metrics.remainingSourceLayers).toBe(0);
  expect(pageErrors).toEqual([]);
});
