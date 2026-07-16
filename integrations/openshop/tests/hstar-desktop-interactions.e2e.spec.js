import { expect, test } from '@playwright/test';

const hstarBaseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3000';
const openshopUrl = `${hstarBaseUrl}/static/openshop/index.html`;

function layerRow(page, name) {
  const exactName = new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`);
  return page.locator('#layers-list .layer-item').filter({
    has:page.locator('.layer-name', {hasText:exactName}),
  });
}

async function openPreparedEditor(page) {
  await page.goto(openshopUrl, {waitUntil:'domcontentloaded'});
  await page.waitForFunction(() => Boolean(
    typeof OS !== 'undefined' && OS.canvas && window.HstarOpenShopDesktopInput
  ));
  await page.evaluate(() => {
    OS.dismissWelcome();
    document.querySelectorAll('.modal-overlay').forEach(overlay => overlay.remove());
    const welcome = document.getElementById('welcome-overlay');
    if (welcome) welcome.style.display = 'none';
    OS.createNewDocument(800, 600);
    OS.canvas.clear();
    const background = OS._createCheckerBoundary(800, 600);
    OS.canvas.add(background);
    OS.layers = [
      {name:'Background', visible:true, locked:true, opacity:100, blend:'source-over', objects:[background]},
      ...['A', 'B', 'C'].map(name => ({
        name, visible:true, locked:false, opacity:100, blend:'source-over', objects:[],
      })),
    ];
    OS.activeLayerIdx = 1;
    OS._resetLayerSelection(OS.layers[1]);
    OS.updateLayersPanel();
  });
}

test('shows unclipped Chinese tooltips and edits multiple layers with desktop controls', async ({page}) => {
  await openPreparedEditor(page);

  const marquee = page.locator('#toolbar > .tool-group[data-group="selection"] > .tool-btn');
  await marquee.hover();
  const tooltip = page.locator('#tool-tooltip');
  await expect(tooltip).toHaveText('矩形选框工具（M）');
  await expect(tooltip).toBeVisible();
  const box = await tooltip.boundingBox();
  expect(box.x).toBeGreaterThan(46);

  await marquee.click();
  const lasso = page.locator('#flyout-host .tool-btn[data-tool="lasso"]');
  await lasso.hover();
  await expect(tooltip).toHaveText('套索工具（L）');

  await layerRow(page, 'A').click();
  await layerRow(page, 'C').click({modifiers:['Shift']});
  await page.keyboard.press('Delete');
  await expect.poll(() => page.evaluate(() => OS.layers.map(layer => layer.name))).toEqual(['Background']);
});

test('supports additive selection and batch layer properties', async ({page}) => {
  await openPreparedEditor(page);
  await layerRow(page, 'A').click();
  await layerRow(page, 'C').click({modifiers:['Control']});
  await page.locator('#layer-opacity').evaluate(input => {
    input.value = '42';
    input.dispatchEvent(new Event('input', {bubbles:true}));
    input.dispatchEvent(new Event('change', {bubbles:true}));
  });
  await page.locator('#layer-blend').selectOption('multiply');

  expect(await page.evaluate(() => OS.layers.map(layer => ({
    name:layer.name, opacity:layer.opacity, blend:layer.blend,
  })))).toEqual([
    {name:'Background', opacity:100, blend:'source-over'},
    {name:'A', opacity:42, blend:'multiply'},
    {name:'B', opacity:100, blend:'source-over'},
    {name:'C', opacity:42, blend:'multiply'},
  ]);

  await layerRow(page, 'A').locator('.layer-vis').click();
  await layerRow(page, 'A').locator('.layer-lock').click();
  expect(await page.evaluate(() => OS.layers
    .filter(layer => ['A', 'C'].includes(layer.name))
    .map(layer => ({visible:layer.visible, locked:layer.locked})))).toEqual([
    {visible:false, locked:true},
    {visible:false, locked:true},
  ]);
});

test('drags selected rows as one ordered block', async ({page}) => {
  await openPreparedEditor(page);
  await layerRow(page, 'A').click();
  await layerRow(page, 'C').click({modifiers:['Control']});
  await layerRow(page, 'C').dragTo(layerRow(page, 'Background'));

  await expect.poll(() => page.evaluate(() => OS.layers.map(layer => layer.name)))
    .toEqual(['A', 'C', 'Background', 'B']);
});

test('keeps Delete context separate and suppresses shortcuts while editing', async ({page}) => {
  await openPreparedEditor(page);
  await layerRow(page, 'B').click();
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => OS.layers.some(layer => layer.name === 'B'))).toBe(false);

  await page.locator('#canvas-area').click({position:{x:100, y:100}});
  await page.evaluate(() => {
    const object = new fabric.Rect({left:10, top:10, width:40, height:40});
    OS.canvas.add(object);
    OS.layers[OS.activeLayerIdx].objects.push(object);
    OS.canvas.setActiveObject(object);
  });
  const beforeCanvasDelete = await page.evaluate(() => OS.layers.length);
  const beforeObjectDelete = await page.evaluate(() => OS.canvas.getObjects().length);
  await page.keyboard.press('Delete');
  expect(await page.evaluate(() => OS.layers.length)).toBe(beforeCanvasDelete);
  expect(await page.evaluate(() => OS.canvas.getObjects().length)).toBe(beforeObjectDelete - 1);

  await layerRow(page, 'A').locator('.layer-name').dblclick();
  const rename = page.locator('.layer-name-input');
  await rename.fill('A Delete U');
  await rename.press('Backspace');
  expect(await rename.inputValue()).toBe('A Delete ');
  expect(await page.evaluate(() => OS.layers.length)).toBe(beforeCanvasDelete);
});

test('confirms text editing with NumpadEnter while regular Enter inserts a newline', async ({page}) => {
  await openPreparedEditor(page);
  const initialHistoryLength = await page.evaluate(() => {
    const text = new fabric.IText('中文 English', {
      left:80,
      top:80,
      fontFamily:'Microsoft YaHei UI',
      fontSize:48,
      fill:'#ffffff',
      editable:true,
    });
    OS.canvas.add(text);
    OS.layers[OS.activeLayerIdx].objects.push(text);
    OS.canvas.setActiveObject(text);
    text.enterEditing();
    text.selectionStart = text.selectionEnd = text.text.length;
    text._updateTextarea();
    text.hiddenTextarea.focus();
    window.__hstarTextConfirmTarget = text;
    return OS.history.length;
  });

  await page.keyboard.press('NumpadEnter');
  expect(await page.evaluate(() => ({
    editing:window.__hstarTextConfirmTarget.isEditing,
    selected:OS.canvas.getActiveObject() === window.__hstarTextConfirmTarget,
    historyLength:OS.history.length,
  }))).toEqual({editing:false, selected:true, historyLength:initialHistoryLength + 1});

  const beforeNewline = await page.evaluate(() => {
    const text = window.__hstarTextConfirmTarget;
    text.enterEditing();
    text.selectionStart = text.selectionEnd = text.text.length;
    text._updateTextarea();
    text.hiddenTextarea.focus();
    return text.text;
  });
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => window.__hstarTextConfirmTarget.text)).toBe(`${beforeNewline}\n`);
  expect(await page.evaluate(() => window.__hstarTextConfirmTarget.isEditing)).toBe(true);
});

for (const viewport of [{width:1440, height:1000}, {width:3840, height:2160}]) {
  test(`frames tooltips at ${viewport.width}`, async ({page}) => {
    await page.setViewportSize(viewport);
    await openPreparedEditor(page);
    const tool = page.locator('#toolbar > .tool-btn[data-tool="note"]');
    await tool.hover();
    const tooltip = page.locator('#tool-tooltip');
    await expect(tooltip).toHaveClass(/visible/);
    const box = await tooltip.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(46);
    expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
  });
}
