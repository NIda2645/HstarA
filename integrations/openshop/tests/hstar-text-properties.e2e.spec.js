import { expect, test } from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const openshopUrl = `${baseUrl}/static/openshop/index.html`;

async function openOpenShopFrame(page){
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined'
    && OS.canvas
    && window.HstarOpenShopFontCatalog
    && window.HstarOpenShopTextProperties
  ));
  await page.evaluate(async () => {
    const fontManager = window.HstarOpenShopFontCatalog.createManager();
    window.HstarOpenShopTextPropertiesController = window.HstarOpenShopTextProperties.createController({
      editor:OS,
      fontManager,
      documentRef:document,
    });
    await window.HstarOpenShopTextPropertiesController.start();
  });
  return page.mainFrame();
}

test('edits mixed-language text with installed fonts and preserves the project state', async ({page, request}) => {
  test.setTimeout(120000);
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));

  const fontResponse = await request.get(`${baseUrl}/api/openshop/fonts`);
  expect(fontResponse.ok()).toBeTruthy();
  const fontPayload = await fontResponse.json();
  expect(fontPayload.fonts.length).toBeGreaterThan(0);
  expect(JSON.stringify(fontPayload).toLowerCase()).not.toMatch(/\.ttf|\.otf|path/);
  const selectedFamily = fontPayload.fonts.find(font => font.family === 'Microsoft YaHei UI')?.family
    || fontPayload.fonts[0].family;
  const secondaryFamily = fontPayload.fonts.find(font => font.family !== selectedFamily)?.family
    || selectedFamily;

  const frame = await openOpenShopFrame(page);
  await frame.evaluate(() => {
    OS.dismissWelcome();
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
    OS.createNewDocument(800, 600);
    const sample = new fabric.Rect({
      left:0, top:0, width:40, height:40, fill:'#7c3aed', selectable:false, evented:false,
    });
    const text = new fabric.IText('中文 English', {
      left:80, top:90, fontFamily:'Microsoft YaHei UI', fontSize:48,
      fill:'#ffffff', editable:true,
    });
    OS.canvas.add(sample);
    OS.layers[OS.activeLayerIdx].objects.push(sample);
    OS.canvas.add(text);
    OS.layers[OS.activeLayerIdx].objects.push(text);
    OS.canvas.setActiveObject(text);
    OS.canvas.fire('selection:created', {selected:[text], target:text});
  });

  await expect(frame.locator('[data-hstar-text-properties-tab]')).toHaveClass(/active/);
  await expect(frame.locator('#ptg1-layers')).toHaveClass(/active/);
  await expect(frame.locator('#hstar-text-properties-panel')).toHaveAttribute('data-group', 'ptg2');
  expect(await frame.locator('[data-hstar-text-properties-tab]').evaluate(tab => (
    tab.parentElement === document.getElementById('ptg2-color')?.parentElement?.querySelector('.panel-tabs')
  ))).toBe(true);
  const familyTrigger = frame.locator('[data-text-family="zh"]');
  await expect(familyTrigger).toHaveJSProperty('tagName', 'BUTTON');
  await familyTrigger.click();
  await expect(frame.locator('[data-text-font-list]')).toBeVisible();
  const listMetrics = await frame.locator('[data-text-font-list]').evaluate(list => ({
    clientHeight:list.clientHeight,
    scrollHeight:list.scrollHeight,
  }));
  expect(listMetrics.scrollHeight).toBeGreaterThan(listMetrics.clientHeight);
  await expect(frame.locator(`[data-family="${selectedFamily.replaceAll('"', '\\"')}"]`).first()).toHaveAttribute('aria-selected', 'true');
  await frame.locator('#tool-options').click({position:{x:4, y:4}});
  await expect(frame.locator('[data-text-font-list]')).toBeHidden();
  await familyTrigger.click();
  await frame.locator(`[data-family="${selectedFamily.replaceAll('"', '\\"')}"]`).first().click();
  await expect(frame.locator('[data-text-font-list]')).toBeHidden();

  await frame.locator('[data-text-size]').fill('48');
  await frame.locator('[data-text-size]').dispatchEvent('change');
  await frame.locator('[data-text-line-height]').fill('1.35');
  await frame.locator('[data-text-line-height]').dispatchEvent('change');
  await frame.locator('[data-text-tracking]').fill('18');
  await frame.locator('[data-text-tracking]').dispatchEvent('change');
  await frame.locator('[data-text-align]').selectOption('center');
  await frame.locator('[data-text-kerning-mode]').selectOption('auto');
  await frame.locator('[data-text-kerning-mode]').selectOption('metrics');
  await frame.locator('[data-text-kerning-mode]').selectOption('numeric');
  await frame.locator('[data-text-kerning]').fill('12');
  await frame.locator('[data-text-kerning]').dispatchEvent('change');
  await frame.locator('[data-text-bold]').click();
  const textColor = frame.locator('[data-text-color]');
  await expect(textColor).toHaveJSProperty('tagName', 'BUTTON');
  const colorHistoryBefore = await frame.evaluate(() => OS.history.length);
  await textColor.click();
  const colorPanel = frame.locator('[data-hstar-color-panel]');
  await expect(colorPanel).toBeVisible();
  await expect(colorPanel.locator('[data-color-title]')).toHaveText('选择文字颜色');
  await page.screenshot({path:'test-results/hstar-text-color-panel.png'});
  await colorPanel.locator('[data-color-r]').fill('34');
  await colorPanel.locator('[data-color-g]').fill('197');
  await colorPanel.locator('[data-color-b]').fill('94');
  await expect.poll(() => frame.evaluate(() => OS.canvas.getActiveObject()?.fill)).toBe('#22c55e');
  expect(await frame.evaluate(() => OS.history.length)).toBe(colorHistoryBefore);
  await frame.locator('#canvas-area').click({position:{x:700, y:500}});
  await expect(colorPanel).toBeHidden();
  expect(await frame.evaluate(() => OS.history.length)).toBe(colorHistoryBefore + 1);

  await frame.evaluate(() => {
    const text = OS.canvas.getObjects().find(object => object.type === 'i-text');
    OS.canvas.setActiveObject(text);
    OS.canvas.fire('selection:created', {selected:[text], target:text});
  });
  await textColor.click();
  await colorPanel.locator('[data-color-sample]').click();
  await frame.evaluate(() => {
    const rect = OS.canvas.lowerCanvasEl.getBoundingClientRect();
    const screen = fabric.util.transformPoint({x:10, y:10}, OS.canvas.viewportTransform);
    const originalGetPointer = OS.canvas.getPointer;
    OS.canvas.getPointer = () => ({x:10, y:10});
    OS.onMouseDown({
      e:{
        offsetX:screen.x,
        offsetY:screen.y,
        clientX:rect.left + screen.x,
        clientY:rect.top + screen.y,
      },
      target:null,
    });
    OS.canvas.getPointer = originalGetPointer;
  });
  await expect(colorPanel).toBeHidden();
  await expect.poll(() => frame.evaluate(() => OS.canvas.getActiveObject()?.fill)).toBe('#7c3aed');
  const underline = frame.locator('[data-text-underline]');
  await underline.click();
  const underlineState = await frame.evaluate(() => ({
    isEditing:OS.canvas.getActiveObject()?.isEditing,
    objectValue:OS.canvas.getActiveObject()?.underline,
    controlValue:document.querySelector('[data-text-underline]')?.checked,
  }));
  expect(underlineState).toEqual({isEditing:false, objectValue:true, controlValue:true});

  const allSelectionControls = await frame.evaluate(() => {
    const text = OS.canvas.getActiveObject();
    text.enterEditing();
    text.selectionStart = 0;
    text.selectionEnd = text.text.length;
    OS.canvas.fire('text:selection:changed', {target:text});
    return {
      family:document.querySelector('[data-text-family-label]')?.textContent,
      style:document.querySelector('[data-text-style]')?.value,
      size:document.querySelector('[data-text-size]')?.value,
      topFamily:document.querySelector('#text-font')?.value,
      topSize:document.querySelector('#text-size')?.value,
    };
  });
  expect(allSelectionControls).toMatchObject({
    family:selectedFamily,
    size:'48',
    topFamily:selectedFamily,
    topSize:'48',
  });
  expect(allSelectionControls.style).not.toBe('');

  const selectedRange = await frame.evaluate(family => {
    const text = OS.canvas.getActiveObject();
    text.enterEditing();
    text.selectionStart = 0;
    text.selectionEnd = 2;
    OS.canvas.fire('text:selection:changed', {target:text});
    window.HstarOpenShopTextPropertiesController.applyProperty('fontFamily', family);
    window.HstarOpenShopTextPropertiesController.applyProperty('fontStyle', 'italic');
    return text.getSelectionStyles(0, 2, true);
  }, secondaryFamily);
  expect(selectedRange).toHaveLength(2);
  expect(selectedRange.every(style => style.fontFamily === secondaryFamily && style.fontStyle === 'italic')).toBe(true);

  await frame.evaluate(() => {
    const text = OS.canvas.getActiveObject();
    text.selectionStart = text.selectionEnd = text.text.length;
    OS.canvas.fire('text:selection:changed', {target:text});
    window.HstarOpenShopTextPropertiesController.applyProperty('fill', '#22c55e');
    text._updateTextarea();
    text.hiddenTextarea?.focus();
  });
  await page.keyboard.type('X');
  await expect.poll(() => frame.evaluate(() => OS.canvas.getActiveObject()?.text)).toBe('中文 EnglishX');
  const insertedStyle = await frame.evaluate(() => {
    const text = OS.canvas.getActiveObject();
    return text.getSelectionStyles(text.text.length - 1, text.text.length, true)[0];
  });
  expect(insertedStyle.fill).toBe('#22c55e');

  const serialized = await frame.evaluate(() => window.HstarOpenShopProjectAdapter.serializeProject({
    editor:OS,
    context:{canvasType:'classic', canvasId:'text-properties-e2e', nodeId:'node-1', projectId:'text-properties-e2e-project'},
    now:() => 1000,
  }));
  expect(serialized.document).toEqual({width:800, height:600, resolution:72, colorSpace:'srgb'});
  expect(serialized.fontRefs.some(ref => ref.family === selectedFamily)).toBe(true);
  expect(serialized.fontRefs.some(ref => ref.family === secondaryFamily)).toBe(true);
  expect(serialized.editor.objects.some(object => object.hstarKerningMode === 'numeric')).toBe(true);
  expect(serialized.editor.objects.some(object => object.styles && Object.keys(object.styles).length > 0)).toBe(true);

  const restored = await frame.evaluate(async project => {
    await window.HstarOpenShopProjectAdapter.restoreProject({
      editor:OS,
      project,
      assetResolver:async assetId => `/api/openshop/assets/${encodeURIComponent(assetId)}`,
    });
    const text = OS.canvas.getObjects().find(object => object.type === 'i-text');
    return {
      text:text?.text,
      family:text?.fontFamily,
      kerning:text?.hstarKerningMode,
      width:OS.canvasW,
      height:OS.canvasH,
      insertedFill:text?.getSelectionStyles(text.text.length - 1, text.text.length, true)?.[0]?.fill,
      nonblank:OS.canvas.toDataURL('image/png').length > 100,
    };
  }, serialized);
  expect(restored).toMatchObject({
    text:'中文 EnglishX', family:selectedFamily, kerning:'numeric', insertedFill:'#22c55e',
    width:800, height:600, nonblank:true,
  });

  for (const viewport of [
    {width:1440, height:1000, name:'desktop'},
    {width:1920, height:1080, name:'wide'},
    {width:430, height:932, name:'mobile'},
    {width:4096, height:2160, name:'4k'},
  ]) {
    await page.setViewportSize(viewport);
    const panels = frame.locator('#panels');
    if (viewport.width < 768) {
      await frame.locator('.mobile-panel-toggle').click();
      await expect(panels).toHaveClass(/mobile-open/);
      await page.waitForFunction(() => {
        const element = document.querySelector('#panels');
        const rect = element?.getBoundingClientRect();
        return rect && getComputedStyle(element).right === '0px'
          && Math.abs(rect.right - window.innerWidth) < 0.01;
      });
    }
    if (viewport.name === 'desktop' || viewport.name === 'mobile') {
      await familyTrigger.click();
      const fontList = frame.locator('[data-text-font-list]');
      await expect(fontList).toBeVisible();
      const listBox = await fontList.boundingBox();
      expect(listBox).not.toBeNull();
      expect(listBox.x).toBeGreaterThanOrEqual(0);
      expect(listBox.x + listBox.width).toBeLessThanOrEqual(viewport.width);
      expect(listBox.y + listBox.height).toBeLessThanOrEqual(viewport.height);
      const dropdownScreenshot = await page.screenshot({
        path:`test-results/hstar-font-dropdown-${viewport.name}.png`,
      });
      expect(dropdownScreenshot.length).toBeGreaterThan(1000);
      await familyTrigger.click();
    }
    const panel = frame.locator('#hstar-text-properties-panel');
    const box = await panel.boundingBox();
    expect(box).not.toBeNull();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    const screenshot = await page.screenshot({path:`test-results/hstar-text-properties-${viewport.name}.png`});
    expect(screenshot.length).toBeGreaterThan(1000);
    if (viewport.width < 768) {
      await panels.evaluate(element => element.classList.remove('mobile-open'));
    }
  }

  expect(pageErrors).toEqual([]);
});

test('resizes and independently scrolls the layers and text panel regions', async ({page}) => {
  await page.setViewportSize({width:1440, height:1000});
  const frame = await openOpenShopFrame(page);
  await frame.evaluate(() => {
    OS.dismissWelcome();
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
    OS.createNewDocument(800, 600);
    for(let index = 0; index < 24; index += 1) {
      OS.layers.push({
        name:`测试图层 ${index + 1}`,
        visible:true,
        locked:false,
        opacity:100,
        blend:'source-over',
        objects:[],
      });
    }
    const text = new fabric.IText('Panel sizing', {
      left:80, top:90, fontFamily:'Microsoft YaHei UI', fontSize:48,
      fill:'#000000', editable:true,
    });
    OS.layers.at(-1).objects.push(text);
    OS.activeLayerIdx = OS.layers.length - 1;
    OS._resetLayerSelection(OS.layers.at(-1));
    OS.canvas.add(text);
    OS.canvas.setActiveObject(text);
    OS.canvas.fire('selection:created', {selected:[text], target:text});
    OS.updateLayersPanel();
  });

  const primary = frame.locator('#ptg1-group');
  const secondary = frame.locator('#ptg2-group');
  const splitter = frame.locator('#panel-group-splitter');
  const textPanel = frame.locator('#hstar-text-properties-panel');
  const layersList = frame.locator('#layers-list');
  await expect(primary).toBeVisible();
  await expect(secondary).toBeVisible();
  const before = await frame.evaluate(() => ({
    primary:document.getElementById('ptg1-group').getBoundingClientRect().height,
    secondary:document.getElementById('ptg2-group').getBoundingClientRect().height,
    textClient:document.getElementById('hstar-text-properties-panel').clientHeight,
    textScroll:document.getElementById('hstar-text-properties-panel').scrollHeight,
    layersClient:document.getElementById('layers-list').clientHeight,
    layersScroll:document.getElementById('layers-list').scrollHeight,
  }));
  expect(before.primary).toBeGreaterThan(before.secondary);
  expect(before.textScroll).toBeGreaterThan(before.textClient);
  expect(before.layersScroll).toBeGreaterThan(before.layersClient);

  await textPanel.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => textPanel.evaluate(element => element.scrollTop)).toBeGreaterThan(0);
  await layersList.hover();
  await page.mouse.wheel(0, 300);
  await expect.poll(() => layersList.evaluate(element => element.scrollTop)).toBeGreaterThan(0);

  const splitterBox = await splitter.boundingBox();
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(splitterBox.x + splitterBox.width / 2, splitterBox.y + splitterBox.height / 2 + 80);
  await page.mouse.up();

  const after = await frame.evaluate(() => ({
    primary:document.getElementById('ptg1-group').getBoundingClientRect().height,
    secondary:document.getElementById('ptg2-group').getBoundingClientRect().height,
    saved:Number(localStorage.getItem('openshop.panel.secondaryHeight')),
  }));
  expect(after.primary).toBeGreaterThan(before.primary + 60);
  expect(after.secondary).toBeLessThan(before.secondary - 60);
  expect(after.saved).toBe(Math.round(after.secondary));
  await expect(splitter).toHaveAttribute('aria-grabbed', 'false');
  await page.screenshot({path:'test-results/hstar-resizable-panels.png'});
});
