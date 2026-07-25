import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const hstarBaseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const openshopUrl = `${hstarBaseUrl}/static/openshop/index.html`;
const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, '..', '..', '..');

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

  await expect.poll(() => page.frames().some(frame => frame.url() === openshopUrl)).toBe(true);
  const openshopFrame = page.frames().find(frame => frame.url() === openshopUrl);
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

test('keeps a top menu open while the pointer crosses into its dropdown', async ({ page }) => {
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(typeof OS !== 'undefined' && OS.canvas));
  await page.evaluate(() => {
    OS.dismissWelcome();
    OS.createNewDocument(800, 600);
  });
  await expect(page.locator('#welcome-overlay')).toBeHidden();

  const layerMenu = page.locator('.menu-item[data-i18n="Layer"]');
  const dropdown = layerMenu.locator(':scope > .menu-dropdown');
  const newLayer = dropdown.locator(':scope > .dd-item[data-i18n="New Layer"]');
  const initialLayerCount = await page.evaluate(() => OS.layers.length);

  await layerMenu.hover();
  await expect(dropdown).toBeVisible();

  const menuBox = await layerMenu.boundingBox();
  expect(menuBox).not.toBeNull();
  await page.mouse.move(
    menuBox.x + menuBox.width / 2,
    menuBox.y + menuBox.height + 1
  );

  await expect(dropdown).toBeVisible();
  await newLayer.click();
  await expect.poll(() => page.evaluate(() => OS.layers.length)).toBe(initialLayerCount + 1);
});

test('keeps OCR font size when horizontal text is converted to vertical text', async ({ page }) => {
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopWritingMode
  ));

  const metrics = await page.evaluate(() => {
    const source = new fabric.IText('微风不燥，', {
      fontFamily:'阿里巴巴普惠体 3.0 55 Regular',
      fontSize:56.539119,
      fontWeight:400,
      lineHeight:1.18,
      fill:'#315f3f',
      hstarWritingMode:'horizontal',
    });
    const vertical = window.HstarOpenShopWritingMode.convertTextObject(fabric, source, 'vertical');
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('2d');
    const descriptor = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(context), 'font');
    const acceptedFonts = [];
    Object.defineProperty(context, 'font', {
      configurable:true,
      get(){ return descriptor.get.call(context); },
      set(value){
        descriptor.set.call(context, value);
        acceptedFonts.push(descriptor.get.call(context));
      },
    });

    vertical._render(context);

    return {
      type:vertical.type,
      writingMode:vertical.hstarWritingMode,
      fontSize:vertical.fontSize,
      width:vertical.width,
      height:vertical.height,
      acceptedFonts,
    };
  });

  expect(metrics).toMatchObject({
    type:'hstar-vertical-text',
    writingMode:'vertical',
    fontSize:56.539119,
  });
  expect(metrics.width).toBeCloseTo(56.539119, 5);
  expect(metrics.height).toBeGreaterThan(300);
  expect(metrics.acceptedFonts).toHaveLength(5);
  expect(metrics.acceptedFonts.every(font => font.includes('56.5391px'))).toBe(true);
});

test('fits OCR v5 visible bounds for horizontal, vertical, rotated and mixed-style text', async ({ page }) => {
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopWritingMode
    && window.HstarOpenShopOcrLayout
  ));

  const metrics = await page.evaluate(() => {
    const cases = [
      {
        id:'horizontal', text:'SUMMER', writingMode:'horizontal',
        target:{left:120, top:80, width:360, height:62, angle:0},
      },
      {
        id:'vertical', text:'\u5c0f\u6691\u8282\u6c14', writingMode:'vertical',
        target:{left:540, top:90, width:70, height:320, angle:0},
      },
      {
        id:'rotated', text:'ROTATE', writingMode:'horizontal',
        target:{left:180, top:260, width:300, height:58, angle:17},
      },
      {
        id:'punctuation', text:'\u5fae\u98ce\u4e0d\u71e5\uff0c', writingMode:'horizontal',
        target:{left:650, top:300, width:330, height:62, angle:0},
      },
      {
        id:'mixed-bold', text:'\u590f\u65e5SALE', writingMode:'horizontal',
        target:{left:220, top:430, width:340, height:66, angle:0},
        fontWeight:700,
        styles:{0:{
          0:{fontFamily:'Microsoft YaHei', fontWeight:700, fill:'#a61b1b'},
          1:{fontFamily:'Microsoft YaHei', fontWeight:700, fill:'#a61b1b'},
          2:{fontFamily:'Arial', fontWeight:700, fill:'#195b8a'},
          3:{fontFamily:'Arial', fontWeight:700, fill:'#195b8a'},
          4:{fontFamily:'Arial', fontWeight:700, fill:'#195b8a'},
          5:{fontFamily:'Arial', fontWeight:700, fill:'#195b8a'},
        }},
      },
    ];

    return cases.map(entry => {
      const object = window.HstarOpenShopWritingMode.createTextObject(fabric, entry.text, {
        fontFamily:'Arial',
        fontSize:64,
        fontWeight:entry.fontWeight || 400,
        lineHeight:1.16,
        charSpacing:0,
        fill:'#315f3f',
        styles:entry.styles || {},
        hstarWritingMode:entry.writingMode,
      });
      const result = window.HstarOpenShopOcrLayout.fitLineObject(object, entry.target, {
        writingMode:entry.writingMode,
        documentRef:document,
      });
      const radians = entry.target.angle * Math.PI / 180;
      const offsetX = result.visibleBox.left + object.width / 2;
      const offsetY = result.visibleBox.top + object.height / 2;
      const visibleOrigin = {
        x:object.left + Math.cos(radians) * offsetX - Math.sin(radians) * offsetY,
        y:object.top + Math.sin(radians) * offsetX + Math.cos(radians) * offsetY,
      };
      const crossError = entry.writingMode === 'vertical'
        ? Math.abs(result.visibleBox.width - entry.target.width)
        : Math.abs(result.visibleBox.height - entry.target.height);
      const flowError = entry.writingMode === 'vertical'
        ? Math.abs(result.visibleBox.height - entry.target.height)
        : Math.abs(result.visibleBox.width - entry.target.width);
      const crossOverflow = entry.writingMode === 'vertical'
        ? result.visibleBox.width - entry.target.width
        : result.visibleBox.height - entry.target.height;
      const flowOverflow = entry.writingMode === 'vertical'
        ? result.visibleBox.height - entry.target.height
        : result.visibleBox.width - entry.target.width;
      const glyphs = object._hstarVerticalLayout?.glyphs || [];
      const minimumGlyphGap = glyphs.slice(1).reduce((minimum, glyph, index) => {
        const previous = glyphs[index];
        return Math.min(minimum, glyph.y - (previous.y + previous.height));
      }, Number.POSITIVE_INFINITY);
      return {
        id:entry.id,
        scaleX:object.scaleX,
        scaleY:object.scaleY,
        originError:Math.hypot(
          visibleOrigin.x - entry.target.left,
          visibleOrigin.y - entry.target.top,
        ),
        crossError,
        flowError,
        crossOverflow,
        flowOverflow,
        minimumGlyphGap:Number.isFinite(minimumGlyphGap) ? minimumGlyphGap : null,
        fontWeight:object.fontWeight,
        mixedStyleFamilies:entry.id === 'mixed-bold'
          ? [object.styles?.[0]?.[0]?.fontFamily, object.styles?.[0]?.[2]?.fontFamily]
          : [],
        boldFaceAvailable:entry.id === 'mixed-bold'
          ? document.fonts.check('700 16px Arial')
          : null,
      };
    });
  });

  expect(metrics.map(item => item.id)).toEqual([
    'horizontal', 'vertical', 'rotated', 'punctuation', 'mixed-bold',
  ]);
  metrics.forEach(item => {
    expect(item.scaleX, item.id).toBe(1);
    expect(item.scaleY, item.id).toBe(1);
    expect(item.originError, item.id).toBeLessThanOrEqual(0.01);
    expect(item.crossOverflow, item.id).toBeLessThanOrEqual(1);
    expect(item.flowOverflow, item.id).toBeLessThanOrEqual(1);
    expect(Math.min(item.crossError, item.flowError), item.id).toBeLessThanOrEqual(1);
  });
  expect(metrics.find(item => item.id === 'vertical').minimumGlyphGap).toBeGreaterThanOrEqual(-1);
  expect(metrics.find(item => item.id === 'mixed-bold')).toMatchObject({
    fontWeight:700,
    mixedStyleFamilies:['Microsoft YaHei', 'Arial'],
    boldFaceAvailable:true,
  });
});

test('imports local image and PSD through the crash-safe backend route', async ({ page }) => {
  test.setTimeout(60000);
  const imageBytes = readFileSync(resolve(repositoryRoot, 'static', 'images', 'logo.png'));
  const psdBytes = readFileSync(resolve(testDir, 'golden', 'openshop-text-layer-probe.psd'));
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.message));

  await page.route('**/api/native/open-local-file', async route => {
    const kind = route.request().postDataJSON().kind;
    const isPsd = kind === 'psd';
    await route.fulfill({
      status:200,
      contentType:isPsd ? 'image/vnd.adobe.photoshop' : 'image/png',
      headers:{
        'Cache-Control':'no-store',
        'X-Hstar-Filename':encodeURIComponent(isPsd ? 'openshop-text-layer-probe.psd' : 'logo.png'),
      },
      body:isPsd ? psdBytes : imageBytes,
    });
  });

  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(typeof OS !== 'undefined' && OS.canvas));
  await page.evaluate(() => {
    OS.dismissWelcome();
    OS.createNewDocument(100, 80);
    const marker = new fabric.Rect({
      left:8,
      top:12,
      width:40,
      height:30,
      fill:'#22c55e',
      name:'Existing marker',
    });
    OS.canvas.add(marker);
    OS.layers[OS.activeLayerIdx].objects.push(marker);
    window.__nativeImportCalls = {imageInput:0, psdInput:0, browserPicker:0};
    document.getElementById('file-input').click = () => { window.__nativeImportCalls.imageInput += 1; };
    document.getElementById('psd-input').click = () => { window.__nativeImportCalls.psdInput += 1; };
    window.showOpenFilePicker = async () => {
      window.__nativeImportCalls.browserPicker += 1;
      throw new Error('Browser file picker must not be used');
    };
  });

  await page.evaluate(() => OS.openFile());
  await expect.poll(() => page.evaluate(() => ({
    width:OS.canvasW,
    height:OS.canvasH,
    imageObjects:OS.canvas.getObjects().filter(object => object.type === 'image').length,
    existingMarker:OS.canvas.getObjects().some(object => object.name === 'Existing marker'),
    importedImage:(() => {
      const image = OS.layers.find(layer => layer.name === 'logo.png')?.objects
        ?.find(object => object.type === 'image');
      return image ? {
        width:image.width,
        height:image.height,
        left:Number(image.left.toFixed(3)),
        top:Number(image.top.toFixed(3)),
        scaleX:Number(image.scaleX.toFixed(3)),
        scaleY:Number(image.scaleY.toFixed(3)),
      } : null;
    })(),
  }))).toEqual({
    width:100,
    height:80,
    imageObjects:1,
    existingMarker:true,
    importedImage:{width:150, height:150, left:10, top:0, scaleX:0.533, scaleY:0.533},
  });

  await page.evaluate(() => OS.openPSD());
  await expect.poll(() => page.evaluate(() => ({
    width:OS.canvasW,
    height:OS.canvasH,
    layerCount:OS.layers.length,
    backgroundLocked:OS.layers[0]?.name === 'Background' && OS.layers[0]?.locked === true,
    composite:OS.layers[1]?.objects?.some(object => (
      object.name === 'PSD Composite'
      && object.type === 'image'
      && object.width === 1024
      && object.height === 512
    )) || false,
  })), {timeout:30000}).toEqual({
    width:1024,
    height:512,
    layerCount:2,
    backgroundLocked:true,
    composite:true,
  });

  const result = await page.evaluate(() => ({
    calls:window.__nativeImportCalls,
    errorToasts:[...document.querySelectorAll('#toast-container .toast.error')].map(item => item.textContent),
  }));
  expect(result.calls).toEqual({imageInput:0, psdInput:0, browserPicker:0});
  expect(result.errorToasts).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('high-resolution ten-layer foundation baseline using a 4096 square sample', async ({ page }) => {
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

  console.log(`HSTAR_HIGH_RES_BASELINE=${JSON.stringify(metrics)}`);
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
