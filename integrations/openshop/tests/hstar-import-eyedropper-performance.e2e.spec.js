import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const openshopUrl = `${baseUrl}/static/openshop/index.html`;
const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, '..', '..', '..');
const pngBytes = readFileSync(resolve(repositoryRoot, 'static', 'images', 'logo.png'));
const gifBytes = readFileSync(resolve(repositoryRoot, 'static', 'images', 'modelscope.gif'));

test.describe.configure({mode:'serial'});

async function openEditor(page) {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopCanvasSampler
    && window.HstarOpenShopUpdateScheduler
  ));
  await page.evaluate(() => {
    OS.dismissWelcome();
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
  });
  return pageErrors;
}

test('imports PNG and GIF as independent layers without replacing the document', async ({page}) => {
  test.setTimeout(60000);
  let openCount = 0;
  await page.route('**/api/native/open-local-file', async route => {
    openCount += 1;
    const gif = openCount === 2;
    await route.fulfill({
      status:200,
      contentType:gif ? 'image/gif' : 'image/png',
      headers:{
        'Cache-Control':'no-store',
        'X-Hstar-Filename':encodeURIComponent(gif ? 'motion.gif' : 'reference.png'),
      },
      body:gif ? gifBytes : pngBytes,
    });
  });
  const pageErrors = await openEditor(page);

  const before = await page.evaluate(() => {
    OS.createNewDocument(1920, 1080);
    OS._docName = 'existing-editor-document';
    const marker = new fabric.Rect({
      left:420,
      top:180,
      width:160,
      height:100,
      fill:'#22c55e',
      name:'Existing marker',
    });
    OS.canvas.add(marker);
    OS.layers[OS.activeLayerIdx].objects.push(marker);
    OS.saveHistory('Existing marker');
    OS.zoom = 0.75;
    OS.canvas.setViewportTransform([0.75, 0, 0, 0.75, 72, 48]);
    return {
      width:OS.canvasW,
      height:OS.canvasH,
      docName:OS._docName,
      viewport:[...OS.canvas.viewportTransform],
      layerNames:OS.layers.map(layer => layer.name),
      historyActions:OS.history.map(entry => entry.action),
    };
  });

  await page.evaluate(() => OS.openFile());
  await expect.poll(() => page.evaluate(() => {
    const layer = OS.layers.find(item => item.name === 'reference.png');
    const image = layer?.objects?.find(object => object.type === 'image');
    return image ? {
      width:image.width,
      height:image.height,
      left:image.left,
      top:image.top,
      scaleX:image.scaleX,
      scaleY:image.scaleY,
    } : null;
  })).toEqual({width:150, height:150, left:0, top:0, scaleX:1, scaleY:1});

  const afterPng = await page.evaluate(() => ({
    width:OS.canvasW,
    height:OS.canvasH,
    docName:OS._docName,
    viewport:[...OS.canvas.viewportTransform],
    marker:OS.canvas.getObjects().some(object => object.name === 'Existing marker'),
    priorLayerNames:OS.layers.slice(0, -1).map(layer => layer.name),
    priorHistoryActions:OS.history.slice(0, -1).map(entry => entry.action),
    lastHistoryAction:OS.history.at(-1)?.action,
  }));
  expect(afterPng).toEqual({
    width:before.width,
    height:before.height,
    docName:before.docName,
    viewport:before.viewport,
    marker:true,
    priorLayerNames:before.layerNames,
    priorHistoryActions:before.historyActions,
    lastHistoryAction:'Import Image',
  });

  await page.evaluate(() => OS.openFile());
  await expect.poll(() => page.evaluate(() => {
    const layer = OS.layers.find(item => item.name === 'motion.gif');
    return layer ? {
      frameCount:layer.animationFrames?.length || 0,
      imageCount:layer.objects.filter(object => object.type === 'image').length,
    } : null;
  }), {timeout:30000}).toEqual({frameCount:expect.any(Number), imageCount:1});

  const frameCount = await page.evaluate(() => (
    OS.layers.find(layer => layer.name === 'motion.gif')?.animationFrames?.length || 0
  ));
  expect(frameCount).toBeGreaterThan(1);
  await page.evaluate(() => {
    const layer = OS.layers.find(item => item.name === 'motion.gif');
    OS._activateAnimationLayer(layer);
    OS.selectFrame(1);
  });
  await expect.poll(() => page.evaluate(() => (
    OS.layers.find(layer => layer.name === 'motion.gif')?.animationIndex
  ))).toBe(1);
  expect(await page.evaluate(() => ({
    width:OS.canvasW,
    height:OS.canvasH,
    marker:OS.canvas.getObjects().some(object => object.name === 'Existing marker'),
    png:OS.canvas.getObjects().some(object => object.name === 'reference.png'),
    gif:OS.canvas.getObjects().some(object => object.name === 'motion.gif'),
  }))).toEqual({width:1920, height:1080, marker:true, png:true, gif:true});
  expect(pageErrors).toEqual([]);
});

test('samples the visible composite after zoom and pan without changing color outside the document', async ({page}) => {
  const pageErrors = await openEditor(page);
  const samplePoint = await page.evaluate(async () => {
    OS.createNewDocument(800, 600);
    OS.canvas.clear();
    OS.layers = [{name:'Composite', visible:true, locked:false, opacity:100, blend:'source-over', objects:[]}];
    OS.activeLayerIdx = 0;
    OS._resetLayerSelection(OS.layers[0]);
    const red = new fabric.Rect({left:100, top:100, width:240, height:180, fill:'#ff0000', name:'Red'});
    const blue = new fabric.Rect({left:100, top:100, width:240, height:180, fill:'#0000ff', opacity:0.5, name:'Blue'});
    OS.canvas.add(red, blue);
    OS.layers[0].objects.push(red, blue);
    OS.zoom = 0.8;
    OS.canvas.setViewportTransform([0.8, 0, 0, 0.8, 120, 80]);
    OS.canvas.requestRenderAll();
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const element = OS.canvas.lowerCanvasEl;
    const rect = element.getBoundingClientRect();
    const vpt = OS.canvas.viewportTransform;
    const clientX = rect.left + 180 * vpt[0] + vpt[4];
    const clientY = rect.top + 160 * vpt[3] + vpt[5];
    const backingX = Math.floor((clientX - rect.left) * element.width / rect.width);
    const backingY = Math.floor((clientY - rect.top) * element.height / rect.height);
    const pixel = element.getContext('2d').getImageData(backingX, backingY, 1, 1).data;
    const expected = `#${[pixel[0], pixel[1], pixel[2]]
      .map(value => value.toString(16).padStart(2, '0')).join('')}`;
    OS.setTool('eyedropper');
    return {clientX, clientY, expected, rect:{left:rect.left, top:rect.top}, vpt:[...vpt]};
  });

  await page.mouse.click(samplePoint.clientX, samplePoint.clientY);
  await expect.poll(() => page.evaluate(() => OS.state.fgColor)).toBe(samplePoint.expected);

  const outsidePoint = await page.evaluate(() => {
    const rect = OS.canvas.lowerCanvasEl.getBoundingClientRect();
    const vpt = OS.canvas.viewportTransform;
    return {
      x:rect.left + (-20 * vpt[0]) + vpt[4],
      y:rect.top + (20 * vpt[3]) + vpt[5],
      before:OS.state.fgColor,
    };
  });
  await page.mouse.click(outsidePoint.x, outsidePoint.y);
  expect(await page.evaluate(() => OS.state.fgColor)).toBe(outsidePoint.before);
  expect(pageErrors).toEqual([]);
});

test('uses one bounded analysis path across low and high resolution documents', async ({page}) => {
  test.setTimeout(60000);
  const pageErrors = await openEditor(page);
  const metrics = await page.evaluate(async () => {
    const dimensions = [
      [800, 600],
      [3840, 2160],
      [7680, 4320],
      [10000, 8000],
    ];
    const results = [];
    for (const [width, height] of dimensions) {
      OS.canvas.clear();
      const boundary = OS._createCheckerBoundary(width, height);
      OS.canvas.add(boundary);
      OS.layers = [{name:'Boundary', visible:true, locked:true, opacity:100, blend:'source-over', objects:[boundary]}];
      OS.activeLayerIdx = 0;
      OS.canvasW = width;
      OS.canvasH = height;
      OS.zoom = 0.5;
      OS.canvas.setViewportTransform([0.5, 0, 0, 0.5, 37, 29]);
      OS._analysisRevision = (OS._analysisRevision || 0) + 1;
      OS._analysisPreviewCache = null;
      const viewport = [...OS.canvas.viewportTransform];
      let previewCalls = 0;
      const originalToCanvasElement = OS.canvas.toCanvasElement.bind(OS.canvas);
      OS.canvas.toCanvasElement = (...args) => {
        previewCalls += 1;
        return originalToCanvasElement(...args);
      };
      const started = performance.now();
      const first = OS._getAnalysisPreview();
      const second = OS._getAnalysisPreview();
      const elapsedMs = performance.now() - started;
      const data = first.getContext('2d').getImageData(0, 0, first.width, first.height).data;
      let nonTransparent = 0;
      for (let index = 3; index < data.length; index += 4) {
        if (data[index] > 0) nonTransparent += 1;
      }
      results.push({
        width,
        height,
        previewWidth:first.width,
        previewHeight:first.height,
        previewCalls,
        cacheReused:first === second,
        viewportUnchanged:JSON.stringify(viewport) === JSON.stringify(OS.canvas.viewportTransform),
        nonTransparent,
        elapsedMs,
      });
      OS.canvas.toCanvasElement = originalToCanvasElement;
    }

    document.getElementById('ptg3-history').classList.remove('active');
    document.getElementById('ptg3-nav').classList.add('active');
    let minimapCalls = 0;
    let histogramCalls = 0;
    const originalMinimap = OS._renderMinimap.bind(OS);
    const originalHistogram = OS._renderHistogram.bind(OS);
    OS._renderMinimap = () => { minimapCalls += 1; return originalMinimap(); };
    OS._renderHistogram = () => { histogramCalls += 1; return originalHistogram(); };
    for (let index = 0; index < 10; index += 1) {
      OS.updateMinimap();
      OS.updateHistogram();
    }
    await new Promise(resolve => setTimeout(resolve, 350));

    const toolStarted = performance.now();
    for (let index = 0; index < 20; index += 1) {
      OS.setTool(index % 2 ? 'brush' : 'select');
    }
    const toolSwitchMs = performance.now() - toolStarted;
    return {results, minimapCalls, histogramCalls, toolSwitchMs};
  });

  console.log(`HSTAR_HIGH_RES_PERF=${JSON.stringify(metrics)}`);
  expect(metrics.results).toHaveLength(4);
  for (const result of metrics.results) {
    expect(result.previewWidth).toBeLessThanOrEqual(320);
    expect(result.previewHeight).toBeLessThanOrEqual(320);
    expect(result.previewCalls).toBe(1);
    expect(result.cacheReused).toBe(true);
    expect(result.viewportUnchanged).toBe(true);
    expect(result.nonTransparent).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeGreaterThanOrEqual(0);
  }
  expect(metrics.minimapCalls).toBe(1);
  expect(metrics.histogramCalls).toBe(1);
  expect(metrics.toolSwitchMs).toBeGreaterThanOrEqual(0);
  expect(pageErrors).toEqual([]);
});
