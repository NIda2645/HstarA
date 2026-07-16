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
    const text = new fabric.IText('中文 English', {
      left:80, top:90, fontFamily:'Microsoft YaHei UI', fontSize:48,
      fill:'#ffffff', editable:true,
    });
    OS.canvas.add(text);
    OS.layers[OS.activeLayerIdx].objects.push(text);
    OS.canvas.setActiveObject(text);
    OS.canvas.fire('selection:created', {selected:[text], target:text});
  });

  await expect(frame.locator('[data-hstar-text-properties-tab]')).toHaveClass(/active/);
  const familyInput = frame.locator('[data-text-family]');
  await familyInput.fill(selectedFamily);
  await expect(frame.locator('[data-text-font-list]')).toBeVisible();
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
  await frame.locator('[data-text-color]').evaluate(input => {
    input.value = '#ef4444';
    input.dispatchEvent(new Event('change', {bubbles:true}));
  });
  const underline = frame.locator('[data-text-underline]');
  await underline.click();
  const underlineState = await frame.evaluate(() => ({
    isEditing:OS.canvas.getActiveObject()?.isEditing,
    objectValue:OS.canvas.getActiveObject()?.underline,
    controlValue:document.querySelector('[data-text-underline]')?.checked,
  }));
  expect(underlineState).toEqual({isEditing:false, objectValue:true, controlValue:true});

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
        const rect = document.querySelector('#panels')?.getBoundingClientRect();
        return rect && Math.abs(rect.right - window.innerWidth) < 0.5;
      });
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
