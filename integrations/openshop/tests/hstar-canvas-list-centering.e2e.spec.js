import { expect, test } from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';

const canvases = Array.from({length:12}, (_, index) => ({
  id:`canvas-list-centering-${index + 1}`,
  title:`Canvas ${index + 1}`,
  kind:index % 5 === 0 ? 'smart' : 'classic',
  project:'default',
  board_x:40 + (index % 4) * 276,
  board_y:40 + Math.floor(index / 4) * 176,
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
    const workspace = document.querySelector('.workspace').getBoundingClientRect();
    const cards = Array.from(document.querySelectorAll('.ws-card')).map(card => card.getBoundingClientRect());
    const bounds = cards.reduce((result, rect) => ({
      left:Math.min(result.left, rect.left),
      top:Math.min(result.top, rect.top),
      right:Math.max(result.right, rect.right),
      bottom:Math.max(result.bottom, rect.bottom),
    }), {left:Infinity, top:Infinity, right:-Infinity, bottom:-Infinity});
    return {
      workspaceCenter:{x:workspace.left + workspace.width / 2, y:workspace.top + workspace.height / 2},
      cardsCenter:{x:(bounds.left + bounds.right) / 2, y:(bounds.top + bounds.bottom) / 2},
      cardsBounds:bounds,
      viewportTransform:document.getElementById('boardWorld').style.transform,
    };
  });
}

test.beforeEach(async ({page}) => {
  await page.setViewportSize({width:2048, height:1200});
  await mockCanvasListApi(page);
  await page.goto(`${baseUrl}/static/canvas-list.html`, {waitUntil:'domcontentloaded'});
  await expect(page.locator('.ws-card')).toHaveCount(canvases.length);
});

test('centers the initial canvas-card group in the whole workspace after desktop scale settles', async ({page}) => {
  await page.evaluate(() => {
    window.postMessage({type:'studio-ui-scale', mode:'custom', scale:1.2}, window.location.origin);
  });
  await page.waitForFunction(() => getComputedStyle(document.documentElement)
    .getPropertyValue('--studio-ui-scale').trim() === '1.200');
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

  const geometry = await canvasListGeometry(page);
  expect(Math.abs(geometry.cardsCenter.x - geometry.workspaceCenter.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.cardsCenter.y - geometry.workspaceCenter.y)).toBeLessThanOrEqual(2);
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

test('reset view returns the canvas-card group to the whole-workspace center', async ({page}) => {
  const board = page.locator('#board');
  const rect = await board.boundingBox();
  await page.mouse.move(rect.x + 60, rect.y + 60);
  await page.mouse.down();
  await page.mouse.move(rect.x + 180, rect.y + 140, {steps:4});
  await page.mouse.up();

  await page.locator('#boardResetView').click();
  const geometry = await canvasListGeometry(page);
  expect(Math.abs(geometry.cardsCenter.x - geometry.workspaceCenter.x)).toBeLessThanOrEqual(2);
  expect(Math.abs(geometry.cardsCenter.y - geometry.workspaceCenter.y)).toBeLessThanOrEqual(2);
});
