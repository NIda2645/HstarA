import { expect, test } from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';

const canvases = Array.from({length:36}, (_, index) => ({
  id:`canvas-list-centering-${index + 1}`,
  title:`Canvas ${index + 1}`,
  kind:index % 5 === 0 ? 'smart' : 'classic',
  project:'default',
  board_x:40 + (index % 6) * 276,
  board_y:40 + Math.floor(index / 6) * 176,
  node_count:index + 1,
  created_at:1_700_000_000 + index,
  updated_at:1_700_000_000 + index,
}));

async function mockCanvasListApi(page){
  await page.route('**/api/projects', route => route.fulfill({
    contentType:'application/json',
    body:JSON.stringify({projects:[{id:'default', name:'Default', order:0, canvas_count:canvases.length}]}),
  }));
  await page.route('**/api/canvases', route => route.fulfill({
    contentType:'application/json',
    body:JSON.stringify({canvases}),
  }));
  await page.route('**/api/canvases/trash', route => route.fulfill({
    contentType:'application/json',
    body:JSON.stringify({canvases:[]}),
  }));
}

async function canvasListGeometry(page){
  return page.evaluate(() => {
    const board = document.querySelector('.ws-board').getBoundingClientRect();
    const cards = Array.from(document.querySelectorAll('.ws-card')).map(card => card.getBoundingClientRect());
    const bounds = cards.reduce((result, rect) => ({
      left:Math.min(result.left, rect.left),
      top:Math.min(result.top, rect.top),
      right:Math.max(result.right, rect.right),
      bottom:Math.max(result.bottom, rect.bottom),
    }), {left:Infinity, top:Infinity, right:-Infinity, bottom:-Infinity});
    return {
      boardCenter:{x:board.left + board.width / 2, y:board.top + board.height / 2},
      cardsCenter:{x:(bounds.left + bounds.right) / 2, y:(bounds.top + bounds.bottom) / 2},
      cardsBounds:bounds,
      viewportTransform:document.getElementById('boardWorld').style.transform,
    };
  });
}

async function arrangeCardGrid(page, {count, columns}){
  await page.evaluate(({count, columns}) => {
    const cards = Array.from(document.querySelectorAll('.ws-card'));
    cards.slice(count).forEach(card => card.remove());
    cards.slice(0, count).forEach((card, index) => {
      card.style.left = `${40 + (index % columns) * 276}px`;
      card.style.top = `${40 + Math.floor(index / columns) * 176}px`;
    });
    document.getElementById('boardResetView').click();
  }, {count, columns});
}

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width:2048, height:1200});
  await mockCanvasListApi(page);
  await page.goto(`${baseUrl}/static/canvas-list.html`, {waitUntil:'domcontentloaded'});
  await expect(page.locator('.ws-card')).toHaveCount(canvases.length);
});

test('centers the initial 6x6 canvas-card group in the right board after desktop scale settles', async ({page}) => {
  await page.evaluate(() => {
    window.postMessage({type:'studio-ui-scale', mode:'custom', scale:1.2}, window.location.origin);
  });
  await page.waitForFunction(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--studio-ui-scale').trim() === '1.200');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const geometry = await canvasListGeometry(page);
  expect(Math.abs(geometry.cardsCenter.x - geometry.boardCenter.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.cardsCenter.y - geometry.boardCenter.y)).toBeLessThanOrEqual(2);
});

test('recenters arbitrary manually arranged canvas-card grids in the right board', async ({page}) => {
  for(const layout of [
    {count:35, columns:7},
    {count:25, columns:5},
    {count:17, columns:4},
  ]){
    await arrangeCardGrid(page, layout);
    const geometry = await canvasListGeometry(page);
    expect(Math.abs(geometry.cardsCenter.x - geometry.boardCenter.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(geometry.cardsCenter.y - geometry.boardCenter.y)).toBeLessThanOrEqual(2);
  }
});

test('keeps a user-panned viewport when later scale and resize events arrive', async ({page}) => {
  const board = page.locator('#board');
  const rect = await board.boundingBox();
  await page.mouse.move(rect.x + 60, rect.y + 60);
  await page.mouse.down();
  await page.mouse.move(rect.x + 180, rect.y + 140, {steps:4});
  await page.mouse.up();
  const afterPan = await canvasListGeometry(page);

  await page.evaluate(() => {
    window.postMessage({type:'studio-ui-scale', mode:'custom', scale:1.1}, window.location.origin);
    window.dispatchEvent(new Event('resize'));
  });
  await page.waitForTimeout(150);

  const afterLayoutEvents = await canvasListGeometry(page);
  expect(afterLayoutEvents.viewportTransform).toBe(afterPan.viewportTransform);
});

test('keeps a dragged canvas card under the pointer when the studio UI is scaled down', async ({page}) => {
  await page.evaluate(() => {
    window.postMessage({type:'studio-ui-scale', mode:'custom', scale:0.8}, window.location.origin);
  });
  await page.waitForFunction(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--studio-ui-scale').trim() === '0.800');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const card = page.locator('.ws-card[data-canvas-id="canvas-list-centering-1"]');
  const before = await card.boundingBox();
  const pointerDelta = {x:240, y:120};

  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(
    before.x + before.width / 2 + pointerDelta.x,
    before.y + before.height / 2 + pointerDelta.y,
    {steps:8},
  );
  await page.mouse.up();

  const after = await card.boundingBox();
  expect(after.x - before.x).toBeCloseTo(pointerDelta.x, 0);
  expect(after.y - before.y).toBeCloseTo(pointerDelta.y, 0);
});

test('reset view returns the canvas-card group to the right-board center', async ({page}) => {
  const board = page.locator('#board');
  const rect = await board.boundingBox();
  await page.mouse.move(rect.x + 60, rect.y + 60);
  await page.mouse.down();
  await page.mouse.move(rect.x + 180, rect.y + 140, {steps:4});
  await page.mouse.up();

  await page.locator('#boardResetView').click();
  const geometry = await canvasListGeometry(page);
  expect(Math.abs(geometry.cardsCenter.x - geometry.boardCenter.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.cardsCenter.y - geometry.boardCenter.y)).toBeLessThanOrEqual(2);
});
