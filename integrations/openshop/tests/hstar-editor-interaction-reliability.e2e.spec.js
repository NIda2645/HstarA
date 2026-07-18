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
    window.__hstarE2EFontManager = fontManager;
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
    const rows = window.__hstarE2EFontManager.catalogRows();
    const chineseSectionIndex = rows.findIndex(row => row.key === 'section-zh');
    const englishSectionIndex = rows.findIndex(row => row.key === 'section-en');
    const fontIndexes = rows
      .map((row, index) => row.kind === 'font' ? index : -1)
      .filter(index => index >= 0);
    return {
      count:fontIndexes.length,
      mounted:document.querySelectorAll('[data-text-font-list] [data-family]').length,
      sectionKeys:rows.filter(row => row.kind === 'section').map(row => row.key),
      chineseSectionIndex,
      englishSectionIndex,
      fontsBeforeChinese:fontIndexes.filter(index => index < chineseSectionIndex).length,
      chineseSectionFonts:fontIndexes.filter(index => index > chineseSectionIndex && index < englishSectionIndex).length,
      englishSectionFonts:fontIndexes.filter(index => index > englishSectionIndex).length,
      englishCommercialGroupIndex:rows.findIndex(row => row.key === 'group-03'),
    };
  });
  expect(ordering.count).toBeGreaterThan(20);
  expect(ordering.mounted).toBeLessThanOrEqual(Math.ceil(210 / 30) + (4 * 2));
  expect(ordering.sectionKeys).toEqual(['section-zh', 'section-en']);
  expect(ordering.chineseSectionIndex).toBeGreaterThanOrEqual(0);
  expect(ordering.englishSectionIndex).toBeGreaterThan(ordering.chineseSectionIndex);
  expect(ordering.fontsBeforeChinese).toBe(0);
  expect(ordering.chineseSectionFonts).toBeGreaterThan(0);
  expect(ordering.englishSectionFonts).toBeGreaterThan(0);
  expect(ordering.englishCommercialGroupIndex).toBeGreaterThan(ordering.englishSectionIndex);

  await page.locator('#statusbar').click({position:{x:4, y:4}});
  await expect(list).toBeHidden();
  expect(await list.evaluate(element => ({hidden:element.hidden, display:getComputedStyle(element).display})))
    .toEqual({hidden:true, display:'none'});

  await trigger.click();
  await list.evaluate(element => {
    const rows = window.__hstarE2EFontManager.catalogRows();
    const index = rows.findIndex(row => row.kind === 'font' && row.family === '\u7b49\u7ebf');
    if(index < 0) throw new Error('Expected DengXian family in catalog rows');
    element.scrollTop = index * 30;
    element.dispatchEvent(new Event('scroll'));
  });
  const dengXian = list.locator('[data-family="\u7b49\u7ebf"]');
  await expect(dengXian).toHaveCount(1);
  await expect(list.locator('[data-family="\u7b49\u7ebf Light"]')).toHaveCount(0);
  await dengXian.click();
  await expect(page.locator('[data-text-family-label]')).toHaveText('\u7b49\u7ebf');
  const styleLabels = await page.locator('[data-text-style] option').allTextContents();
  expect(styleLabels).toEqual(expect.arrayContaining(['Regular', 'Light']));
  await page.locator('[data-text-style]').selectOption({label:'Light'});
  expect(await page.evaluate(() => (
    OS.canvas.getObjects().find(object => object.type === 'i-text')?.fontFamily
  ))).toBe('\u7b49\u7ebf Light');

  const textResult = await page.evaluate(() => {
    const text = OS.canvas.getObjects().find(object => object.type === 'i-text');
    OS.setTool('text');
    const originalGetPointer = OS.canvas.getPointer;
    OS.canvas.getPointer = () => ({x:100, y:110});
    const before = OS.canvas.getObjects().filter(object => object.type === 'i-text').length;
    const layersBefore = OS.layers.length;
    OS.onMouseDown({e:{}, target:text});
    const afterExisting = OS.canvas.getObjects().filter(object => object.type === 'i-text').length;
    const layersAfterExisting = OS.layers.length;
    const editing = text.isEditing;
    OS.canvas.getPointer = () => ({x:420, y:320});
    OS.onMouseDown({e:{}, target:null});
    const afterEmpty = OS.canvas.getObjects().filter(object => object.type === 'i-text').length;
    const textLayer = OS.layers.at(-1);
    OS.canvas.getPointer = originalGetPointer;
    return {
      before, afterExisting, afterEmpty, editing,
      layersBefore, layersAfterExisting, layersAfterEmpty:OS.layers.length,
      textLayerObjects:textLayer.objects.length,
      textLayerType:textLayer.objects[0]?.type,
    };
  });
  expect(textResult).toEqual({
    before:1, afterExisting:1, afterEmpty:2, editing:true,
    layersBefore:2, layersAfterExisting:2, layersAfterEmpty:3,
    textLayerObjects:1, textLayerType:'i-text',
  });

  const shapeResult = await page.evaluate(() => {
    const originalGetPointer = OS.canvas.getPointer;
    OS.canvas.getPointer = event => ({x:event.x, y:event.y});
    OS.setTool('rect');
    const layersBefore = OS.layers.length;
    OS.onMouseDown({e:{x:60, y:70}});
    OS.onMouseMove({e:{x:260, y:190}});
    OS.onMouseUp({e:{x:260, y:190}});
    OS.canvas.getPointer = originalGetPointer;
    const layer = OS.layers.at(-1);
    return {
      layersBefore,
      layersAfter:OS.layers.length,
      layerName:layer.name,
      objectCount:layer.objects.length,
      objectType:layer.objects[0]?.type,
    };
  });
  expect(shapeResult).toEqual({
    layersBefore:3, layersAfter:4, layerName:'Rectangle', objectCount:1, objectType:'rect',
  });
  expect(pageErrors).toEqual([]);
});

test('virtualizes a deterministic 2500-font catalog without moving the parent panel', async ({page}) => {
  test.setTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  const catalogGroups = [
    {prefix:'Chinese Common', languageGroup:'zh-hans', freeCommercialCategory:''},
    {prefix:'01免 Simplified', languageGroup:'zh-hans', freeCommercialCategory:'01'},
    {prefix:'02免 Traditional', languageGroup:'zh-hant', freeCommercialCategory:'02'},
    {prefix:'03免 English', languageGroup:'en', freeCommercialCategory:'03'},
    {prefix:'English Other', languageGroup:'en', freeCommercialCategory:''},
  ];
  const fonts = Array.from({length:2500}, (_, index) => {
    const group = catalogGroups[Math.floor(index / 500)];
    const family = `${group.prefix} ${String(index).padStart(4, '0')}`;
    return {...group, family, label:family, styles:[]};
  });
  await page.route('**/api/openshop/fonts*', route => route.fulfill({
    status:200,
    contentType:'application/json',
    body:JSON.stringify({platform:'e2e', cached:false, fonts}),
  }));
  await openStandaloneEditor(page);

  await page.evaluate(async () => {
    OS.createNewDocument(800, 600);
    const fontManager = window.HstarOpenShopFontCatalog.createManager();
    window.__hstarVirtualFontManager = fontManager;
    window.HstarOpenShopTextPropertiesController?.destroy?.();
    window.HstarOpenShopTextPropertiesController = window.HstarOpenShopTextProperties.createController({
      editor:OS,
      fontManager,
      documentRef:document,
    });
    await window.HstarOpenShopTextPropertiesController.start();
    const text = new fabric.IText('Virtual font test', {
      left:80,
      top:90,
      fontFamily:'02免 Traditional 1250',
      fontSize:48,
      fill:'#ffffff',
      editable:true,
    });
    OS.canvas.add(text);
    OS.layers[OS.activeLayerIdx].objects.push(text);
    OS.canvas.setActiveObject(text);
    OS.canvas.fire('selection:created', {selected:[text], target:text});
    text.enterEditing();
    text.selectionStart = 7;
    text.selectionEnd = 7;
    text.hiddenTextarea.focus();
    text.hiddenTextarea.setSelectionRange(7, 7);
    OS.canvas.fire('text:editing:entered', {target:text});
    OS.canvas.fire('text:selection:changed', {target:text});
  });

  const trigger = page.locator('[data-text-family]');
  const list = page.locator('[data-text-font-list]');
  const catalogAudit = await page.evaluate(() => {
    const rows = window.__hstarVirtualFontManager.catalogRows();
    let sectionKey = '';
    let groupKey = '';
    const violations = [];
    rows.forEach((row, index) => {
      if(row.kind === 'section') {
        sectionKey = row.key;
        groupKey = '';
        return;
      }
      if(row.kind === 'group') {
        groupKey = row.key;
        return;
      }
      if(row.kind !== 'font') return;
      const languageGroup = String(row.font?.languageGroup || '').toLowerCase();
      const category = String(row.font?.freeCommercialCategory || '');
      const expectedSection = languageGroup.startsWith('zh') ? 'section-zh' : 'section-en';
      const expectedGroup = category
        ? `group-${category}`
        : (languageGroup.startsWith('zh') ? 'group-zh-unprefixed' : 'group-en-unprefixed');
      if(sectionKey !== expectedSection || groupKey !== expectedGroup) {
        violations.push({index, family:row.family, sectionKey, groupKey, expectedSection, expectedGroup});
      }
    });
    return {
      fontCount:rows.filter(row => row.kind === 'font').length,
      sectionKeys:rows.filter(row => row.kind === 'section').map(row => row.key),
      groupKeys:rows.filter(row => row.kind === 'group').map(row => row.key),
      violations,
    };
  });
  expect(catalogAudit.fontCount).toBeGreaterThanOrEqual(2500);
  expect(catalogAudit.sectionKeys).toEqual(['section-zh', 'section-en']);
  expect(catalogAudit.groupKeys).toEqual([
    'group-zh-unprefixed', 'group-01', 'group-02', 'group-03', 'group-en-unprefixed',
  ]);
  expect(catalogAudit.violations).toEqual([]);
  const editingFocusState = () => page.evaluate(() => {
    const text = OS.canvas.getObjects().find(object => object.type === 'i-text');
    return {
      isEditing:text.isEditing,
      selectionStart:text.selectionStart,
      selectionEnd:text.selectionEnd,
      hiddenTextareaFocused:document.activeElement === text.hiddenTextarea,
    };
  });
  const expectedEditingFocus = {
    isEditing:true,
    selectionStart:7,
    selectionEnd:7,
    hiddenTextareaFocused:true,
  };
  expect(await editingFocusState()).toEqual(expectedEditingFocus);
  await trigger.click();
  await expect(list).toBeVisible();
  expect(await editingFocusState()).toEqual(expectedEditingFocus);
  await trigger.click();
  await expect(list).toBeHidden();
  expect(await editingFocusState()).toEqual(expectedEditingFocus);
  const openMetrics = await page.evaluate(() => {
    const triggerElement = document.querySelector('[data-text-family]');
    const listElement = document.querySelector('[data-text-font-list]');
    let scrollingAncestor = triggerElement.parentElement;
    while(scrollingAncestor) {
      const overflowY = getComputedStyle(scrollingAncestor).overflowY;
      if(/auto|scroll/.test(overflowY) && scrollingAncestor.scrollHeight > scrollingAncestor.clientHeight) break;
      scrollingAncestor = scrollingAncestor.parentElement;
    }
    if(!scrollingAncestor) throw new Error('Expected a real scrolling ancestor for the font trigger');
    const maximumScrollTop = scrollingAncestor.scrollHeight - scrollingAncestor.clientHeight;
    const requestedScrollTop = Math.min(12, maximumScrollTop);
    scrollingAncestor.scrollTop = requestedScrollTop;
    const beforeRect = scrollingAncestor.getBoundingClientRect();
    const beforeScrollTop = scrollingAncestor.scrollTop;
    const startedAt = performance.now();
    triggerElement.click();
    const duration = performance.now() - startedAt;
    const afterRect = scrollingAncestor.getBoundingClientRect();
    return {
      duration,
      scrollingAncestorId:scrollingAncestor.id,
      maximumScrollTop,
      requestedScrollTop,
      beforeScrollTop,
      afterScrollTop:scrollingAncestor.scrollTop,
      beforeRect:{top:beforeRect.top, left:beforeRect.left, width:beforeRect.width, height:beforeRect.height},
      afterRect:{top:afterRect.top, left:afterRect.left, width:afterRect.width, height:afterRect.height},
      mounted:listElement.querySelectorAll('[role="option"]').length,
      spacerHeight:listElement.querySelector('[data-font-spacer]')?.style.height,
      rowCount:window.__hstarVirtualFontManager.catalogRows().length,
    };
  });
  expect(openMetrics.duration).toBeLessThan(250);
  expect(openMetrics.mounted).toBeGreaterThan(0);
  expect(openMetrics.mounted).toBeLessThanOrEqual(Math.ceil(210 / 30) + (4 * 2));
  expect(openMetrics.scrollingAncestorId).toBe('hstar-text-properties-panel');
  expect(openMetrics.maximumScrollTop).toBeGreaterThan(0);
  expect(openMetrics.beforeScrollTop).toBe(openMetrics.requestedScrollTop);
  expect(openMetrics.beforeScrollTop).toBeGreaterThan(0);
  expect(openMetrics.afterScrollTop).toBe(openMetrics.beforeScrollTop);
  expect(openMetrics.afterRect).toEqual(openMetrics.beforeRect);
  expect(openMetrics.spacerHeight).toBe(`${openMetrics.rowCount * 30}px`);
  await expect(list).toBeVisible();

  const targetFamily = 'English Other 2000';
  await list.evaluate((element, family) => {
    const rows = window.__hstarVirtualFontManager.catalogRows();
    const index = rows.findIndex(row => row.kind === 'font' && row.family === family);
    if(index < 0) throw new Error(`Missing deterministic font row: ${family}`);
    element.scrollTop = index * 30;
    element.dispatchEvent(new Event('scroll'));
  }, targetFamily);
  const target = list.locator(`[data-family="${targetFamily}"]`);
  await expect(target).toHaveCount(1);
  expect(await list.locator('[role="option"]').count()).toBeLessThanOrEqual(16);
  await target.click();
  await expect(list).toBeHidden();
  expect(await page.evaluate(() => (
    OS.canvas.getObjects().find(object => object.type === 'i-text')?.fontFamily
  ))).toBe('02免 Traditional 1250');
  const editingResult = await page.evaluate(() => {
    const text = OS.canvas.getObjects().find(object => object.type === 'i-text');
    return {
      isEditing:text.isEditing,
      selectionStart:text.selectionStart,
      selectionEnd:text.selectionEnd,
      hiddenTextareaFocused:document.activeElement === text.hiddenTextarea,
      caretFamily:window.HstarOpenShopTextPropertiesController.getState().caretStyles.fontFamily,
    };
  });
  expect(editingResult).toEqual({
    isEditing:true,
    selectionStart:7,
    selectionEnd:7,
    hiddenTextareaFocused:true,
    caretFamily:targetFamily,
  });

  await trigger.click();
  await expect(list).toBeVisible();
  await page.locator('#statusbar').dispatchEvent('mousedown');
  await expect(list).toBeHidden();
  expect(pageErrors).toEqual([]);
});

test('snaps movement and scaling while raster tools stay inside the active layer', async ({page}) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));
  await openStandaloneEditor(page);

  const snapResult = await page.evaluate(() => {
    OS.createNewDocument(1000, 800);
    const object = new fabric.Rect({left:797, top:603, width:200, height:200, fill:'#ef4444', strokeWidth:0});
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
    object.set({left:100, top:200, width:900, height:600, scaleX:0.997, scaleY:0.997});
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
