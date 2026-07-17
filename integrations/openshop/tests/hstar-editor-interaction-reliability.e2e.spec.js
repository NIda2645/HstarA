import { expect, test } from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const openshopUrl = `${baseUrl}/static/openshop/index.html`;

async function openStandaloneEditor(page){
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopFontCatalog
    && window.HstarOpenShopTextProperties
    && window.HstarOpenShopRasterTools
    && window.HstarOpenShopColorPanelController
  ));
  await page.evaluate(() => {
    OS.dismissWelcome();
    const welcome = document.getElementById('welcome-overlay');
    if(welcome) welcome.style.display = 'none';
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
  });
}

test('closes and sorts the font list while editing existing text in place', async ({page}) => {
  test.setTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await openStandaloneEditor(page);

  await page.evaluate(async () => {
    OS.createNewDocument(800, 600);
    const fontManager = window.HstarOpenShopFontCatalog.createManager();
    window.HstarOpenShopTextPropertiesController?.destroy?.();
    window.HstarOpenShopTextPropertiesController = window.HstarOpenShopTextProperties.createController({
      editor:OS,
      fontManager,
      documentRef:document,
    });
    await window.HstarOpenShopTextPropertiesController.start();
    const text = new fabric.IText('中文 English', {
      left:80,
      top:90,
      fontFamily:'Microsoft YaHei UI',
      fontSize:48,
      fill:'#ffffff',
      editable:true,
    });
    OS.canvas.add(text);
    OS.layers[OS.activeLayerIdx].objects.push(text);
    OS.canvas.setActiveObject(text);
    OS.canvas.fire('selection:created', {selected:[text], target:text});
  });

  const trigger = page.locator('[data-text-family]');
  const list = page.locator('[data-text-font-list]');
  await trigger.click();
  await expect(list).toBeVisible();
  const ordering = await page.evaluate(() => {
    const options = [...document.querySelectorAll('[data-text-font-list] [data-family]')].map(option => ({
      family:option.dataset.family || '',
      label:option.textContent || '',
    }));
    const isChinese = option => /[\u3400-\u9fff]/u.test(`${option.family} ${option.label}`);
    const flags = options.map(isChinese);
    const firstOther = flags.indexOf(false);
    return {
      count:options.length,
      firstOther,
      chineseAfterOther:firstOther >= 0 && flags.slice(firstOther).some(Boolean),
    };
  });
  expect(ordering.count).toBeGreaterThan(20);
  expect(ordering.firstOther).toBeGreaterThan(0);
  expect(ordering.chineseAfterOther).toBe(false);

  await page.locator('#statusbar').click({position:{x:4, y:4}});
  await expect(list).toBeHidden();
  expect(await list.evaluate(element => ({hidden:element.hidden, display:getComputedStyle(element).display})))
    .toEqual({hidden:true, display:'none'});

  await trigger.click();
  const dengXian = list.locator('[data-family="等线"]');
  await expect(dengXian).toHaveCount(1);
  await expect(list.locator('[data-family="等线 Light"]')).toHaveCount(0);
  await dengXian.click();
  await expect(page.locator('[data-text-family-label]')).toHaveText('等线');
  const styleLabels = await page.locator('[data-text-style] option').allTextContents();
  expect(styleLabels).toEqual(expect.arrayContaining(['Regular', 'Light']));
  await page.locator('[data-text-style]').selectOption({label:'Light'});
  expect(await page.evaluate(() => (
    OS.canvas.getObjects().find(object => object.type === 'i-text')?.fontFamily
  ))).toBe('等线 Light');

  const textResult = await page.evaluate(() => {
    const text = OS.canvas.getObjects().find(object => object.type === 'i-text');
    OS.setTool('text');
    const originalGetPointer = OS.canvas.getPointer;
    OS.canvas.getPointer = () => ({x:100, y:110});
    const before = OS.canvas.getObjects().filter(object => object.type === 'i-text').length;
    OS.onMouseDown({e:{}, target:text});
    const afterExisting = OS.canvas.getObjects().filter(object => object.type === 'i-text').length;
    const editing = text.isEditing;
    OS.canvas.getPointer = () => ({x:420, y:320});
    OS.onMouseDown({e:{}, target:null});
    const afterEmpty = OS.canvas.getObjects().filter(object => object.type === 'i-text').length;
    OS.canvas.getPointer = originalGetPointer;
    return {before, afterExisting, afterEmpty, editing};
  });
  expect(textResult).toEqual({before:1, afterExisting:1, afterEmpty:2, editing:true});
  expect(pageErrors).toEqual([]);
});

test('snaps movement and scaling while raster tools stay inside the active layer', async ({page}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await openStandaloneEditor(page);

  const snapResult = await page.evaluate(() => {
    OS.createNewDocument(1000, 800);
    const object = new fabric.Rect({left:797, top:603, width:200, height:200, fill:'#ef4444'});
    OS.canvas.add(object);
    OS.layers[OS.activeLayerIdx].objects.push(object);
    OS._prefs.snapTolerance = 5;
    OS.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    OS._applyObjectSnapping(object);
    const atOne = {left:object.left, top:object.top, rect:object.getBoundingRect(true, true)};

    object.set({left:789, top:590});
    object.setCoords();
    OS.canvas.setViewportTransform([0.28, 0, 0, 0.28, 0, 0]);
    OS._applyObjectSnapping(object);
    const atFit = {left:object.left, top:object.top, rect:object.getBoundingRect(true, true)};
    const sources = [
      window.HstarOpenShopSnapEngine.resolveMovement({
        position:{left:3, top:143},
        objectRect:{left:3, top:143, width:200, height:200},
        documentRect:{left:0, top:0, width:1000, height:800},
        tolerance:5,
      }).sourceX,
      window.HstarOpenShopSnapEngine.resolveMovement({
        position:{left:797, top:143},
        objectRect:{left:797, top:143, width:200, height:200},
        documentRect:{left:0, top:0, width:1000, height:800},
        tolerance:5,
      }).sourceX,
      window.HstarOpenShopSnapEngine.resolveMovement({
        position:{left:137, top:-4},
        objectRect:{left:137, top:-4, width:200, height:200},
        documentRect:{left:0, top:0, width:1000, height:800},
        tolerance:5,
      }).sourceY,
      window.HstarOpenShopSnapEngine.resolveMovement({
        position:{left:137, top:603},
        objectRect:{left:137, top:603, width:200, height:200},
        documentRect:{left:0, top:0, width:1000, height:800},
        tolerance:5,
      }).sourceY,
    ];
    object.set({left:100, top:200, width:900, height:600, scaleX:0.997, scaleY:0.995});
    object.setCoords();
    OS.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    OS._applyObjectScaleSnapping(object, {corner:'br'});
    const scaled = object.getBoundingRect(true, true);
    return {atOne, atFit, sources, scaled};
  });
  expect(snapResult.atOne.rect.left + snapResult.atOne.rect.width).toBe(1000);
  expect(snapResult.atOne.rect.top + snapResult.atOne.rect.height).toBe(800);
  expect(snapResult.atFit.rect.left + snapResult.atFit.rect.width).toBe(1000);
  expect(snapResult.atFit.rect.top + snapResult.atFit.rect.height).toBe(800);
  expect(snapResult.sources).toEqual(['document-left', 'document-right', 'document-top', 'document-bottom']);
  expect(snapResult.scaled.left + snapResult.scaled.width).toBeCloseTo(1000, 5);
  expect(snapResult.scaled.top + snapResult.scaled.height).toBeCloseTo(800, 5);

  const rasterResult = await page.evaluate(() => {
    OS.createNewDocument(200, 200);
    OS.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    const makeImage = color => {
      const source = document.createElement('canvas');
      source.width = 200;
      source.height = 200;
      const context = source.getContext('2d');
      context.fillStyle = color;
      context.fillRect(0, 0, 200, 200);
      return new fabric.Image(source, {left:0, top:0, originX:'left', originY:'top', selectable:true});
    };
    const lower = makeImage('#ef4444');
    OS.canvas.add(lower);
    OS.layers[OS.activeLayerIdx].objects.push(lower);
    OS.layers[OS.activeLayerIdx].name = 'Lower';
    OS.addLayer();
    const upper = makeImage('#2563eb');
    OS.canvas.add(upper);
    OS.layers[OS.activeLayerIdx].objects.push(upper);
    OS.canvas.setActiveObject(upper);
    const objectCount = OS.canvas.getObjects().length;

    OS._rasterTools.begin('eraser', {x:50, y:50});
    OS._rasterTools.move({x:80, y:50});
    OS._rasterTools.end();
    const erasedUpper = [...upper.getElement().getContext('2d').getImageData(50, 50, 1, 1).data];
    const intactLower = [...lower.getElement().getContext('2d').getImageData(50, 50, 1, 1).data];

    OS.state.fgColor = '#22c55e';
    OS.state.brushOpacity = 100;
    OS._rasterTools.begin('brush', {x:50, y:50});
    OS._rasterTools.move({x:70, y:50});
    OS._rasterTools.end();
    const paintedUpper = [...upper.getElement().getContext('2d').getImageData(50, 50, 1, 1).data];

    OS._rasterTools.setCloneSource({x:50, y:50});
    OS._rasterTools.begin('clone', {x:120, y:120});
    OS._rasterTools.end();
    const clonedUpper = [...upper.getElement().getContext('2d').getImageData(120, 120, 1, 1).data];
    return {
      erasedUpper,
      intactLower,
      paintedUpper,
      clonedUpper,
      objectCount,
      finalObjectCount:OS.canvas.getObjects().length,
      sameUpper:OS.layers[OS.activeLayerIdx].objects[0] === upper,
    };
  });
  expect(rasterResult.erasedUpper[3]).toBe(0);
  expect(rasterResult.intactLower[3]).toBe(255);
  expect(rasterResult.intactLower[0]).toBeGreaterThan(200);
  expect(rasterResult.paintedUpper[1]).toBeGreaterThan(150);
  expect(rasterResult.clonedUpper[1]).toBeGreaterThan(150);
  expect(rasterResult.finalObjectCount).toBe(rasterResult.objectCount);
  expect(rasterResult.sameUpper).toBe(true);
  expect(pageErrors).toEqual([]);
});

test('uses the OpenShop panel to sample foreground and background colors', async ({page}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await openStandaloneEditor(page);
  await page.evaluate(() => {
    OS.createNewDocument(200, 200);
    OS.canvas.setViewportTransform([1, 0, 0, 1, 0, 0]);
    const fill = new fabric.Rect({left:0, top:0, width:200, height:200, fill:'#ef4444', selectable:true});
    OS.canvas.add(fill);
    OS.layers[OS.activeLayerIdx].objects.push(fill);
    OS.canvas.renderAll();
    OS.setFgColor('#ffffff');
    OS.setBgColor('#000000');
    OS.setTool('brush');
  });

  await page.locator('#fg-color').click();
  const panel = page.locator('[data-hstar-color-panel]');
  await expect(panel).toBeVisible();
  await expect(panel.locator('[data-color-title]')).toHaveText('选择前景色');
  await page.screenshot({path:'test-results/hstar-color-panel.png'});
  await panel.locator('[data-color-sample]').click();
  await expect(panel).toBeHidden();

  const foreground = await page.evaluate(() => {
    const rect = OS.canvas.lowerCanvasEl.getBoundingClientRect();
    const originalGetPointer = OS.canvas.getPointer;
    OS.canvas.getPointer = () => ({x:20, y:20});
    OS.onMouseDown({e:{clientX:rect.left + 20, clientY:rect.top + 20}, target:null});
    OS.canvas.getPointer = originalGetPointer;
    return {color:OS.state.fgColor, tool:OS.state.tool};
  });
  expect(foreground).toEqual({color:'#ef4444', tool:'brush'});

  await page.locator('#bg-color').click();
  await expect(panel.locator('[data-color-title]')).toHaveText('选择背景色');
  await panel.locator('[data-color-sample]').click();
  const background = await page.evaluate(() => {
    const rect = OS.canvas.lowerCanvasEl.getBoundingClientRect();
    const originalGetPointer = OS.canvas.getPointer;
    OS.canvas.getPointer = () => ({x:20, y:20});
    OS.onMouseDown({e:{clientX:rect.left + 20, clientY:rect.top + 20}, target:null});
    OS.canvas.getPointer = originalGetPointer;
    return {color:OS.state.bgColor, tool:OS.state.tool};
  });
  expect(background).toEqual({color:'#ef4444', tool:'brush'});

  await page.evaluate(() => OS.setFgColor('#abcdef'));
  await page.locator('#fg-color').click();
  await panel.locator('[data-color-sample]').click();
  await page.keyboard.press('Escape');
  expect(await page.evaluate(() => ({color:OS.state.fgColor, state:OS._colorPanelController.getState()})))
    .toMatchObject({color:'#abcdef', state:{sampling:false, target:null}});
  expect(pageErrors).toEqual([]);
});
