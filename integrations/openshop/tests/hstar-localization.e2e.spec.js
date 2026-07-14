import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const editorUrl = pathToFileURL(resolve('index.html')).href;
const hstarBaseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3010';
const hstarEditorUrl = `${hstarBaseUrl}/static/openshop/index.html`;

test('default shell uses Simplified Chinese application text', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

  await page.goto(editorUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));

  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-CN');
  for (const menu of ['文件', '编辑', '图像', '图层', '选择', '滤镜']) {
    await expect(page.getByRole('menuitem', { name: menu, exact: true })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: /移动工具/ })).toBeVisible();
  await expect(page.getByRole('dialog', { name: '欢迎使用 OpenShop' })).toBeVisible();

  const untranslated = await page.evaluate(() => {
    const allowlist = [
      'OpenShop', 'RGB', 'CMYK', 'HSL', 'HEX', 'PNG', 'JPEG', 'WebP', 'PSD',
      'PDF', 'SVG', 'GIF', 'AI', 'px', 'fps',
      'Photoshop', 'JSON', 'USM', 'OLED',
      'HD', 'UHD', 'QHD', 'A4', '1080p', '4K',
    ];
    const selector = [
      '[title]', '[aria-label]', '[placeholder]', '.menu-item', '.dd-item',
      '.panel-tab', '.tool-btn', '#statusbar [id]', '#welcome-overlay button',
      '#welcome-overlay p', '.template-card .tpl-name',
    ].join(',');
    const values = [];
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      return style.display !== 'none' && style.visibility !== 'hidden';
    };
    const directText = (element) => Array.from(element.childNodes)
      .filter((node) => node.nodeType === Node.TEXT_NODE)
      .map((node) => node.textContent.trim())
      .filter(Boolean)
      .join(' ');
    for (const element of document.querySelectorAll(selector)) {
      if (element.matches('#canvas-area, #layers-list *, #statusbar [id]')) continue;
      if (!isVisible(element) && !element.matches('[title], [aria-label], [placeholder]')) continue;
      const candidates = [
        ['text', directText(element)],
        ['title', element.getAttribute('title') || ''],
        ['aria-label', element.getAttribute('aria-label') || ''],
        ['placeholder', element.getAttribute('placeholder') || ''],
      ];
      for (const [kind, value] of candidates) {
        if (!value || values.some((entry) => entry.kind === kind && entry.value === value)) continue;
        values.push({ kind, value });
      }
    }
    return values.filter(({ value }) => {
      let remaining = value
        .replace(/v\d+(?:\.\d+)*/gi, '')
        .replace(/[（(](?:Ctrl\+|Alt\+|Shift\+)*[A-Z](?:\+[A-Z])*[）)]/gi, '')
        .replace(/\b\d+\s*x\s*\d+\b/gi, '')
        .replace(/\b[XY]:\s*\d+/g, '');
      for (const allowed of [...allowlist].sort((left, right) => right.length - left.length)) {
        remaining = remaining.replace(new RegExp(allowed, 'gi'), '');
      }
      return /[A-Za-z]/.test(remaining);
    });
  });

  expect(untranslated).toEqual([]);
  expect(pageErrors).toEqual([]);
});

test('dynamic UI localizes without changing user layer or canvas text', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));

  await page.goto(editorUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));
  await page.evaluate(() => {
    const textNode = document.querySelector('#topbar .logo')?.firstChild;
    for (const type of ['click', 'mousedown', 'mouseenter']) {
      textNode?.dispatchEvent(new MouseEvent(type, { bubbles: true }));
    }
  });
  await page.locator('#welcome-overlay .welcome-actions button').last().click();
  await expect(page.locator('#toast-container')).toContainText('已准备好编辑');

  await page.evaluate(() => {
    const layer = OS.layers[OS.activeLayerIdx];
    layer.name = 'User English Layer';
    const text = new fabric.IText('Do not translate me', {
      left: 40,
      top: 40,
      fill: '#ffffff',
    });
    OS.canvas.add(text);
    layer.objects.push(text);
    OS.canvas.setActiveObject(text);
    OS.updateLayersPanel();
    OS.saveHistory('Object Modified');
  });

  await expect(page.locator('#layers-list .layer-name').first()).toHaveText('User English Layer');
  await expect(page.locator('#object-count')).toContainText('个对象');
  await expect(page.locator('#history-list .history-item.current')).toHaveText('已修改对象');
  await page.evaluate(() => {
    OS.saveHistory('Filter: Sharpen');
    OS.saveHistory('Preset: User English Preset');
  });
  await expect(page.locator('#history-list')).toContainText('滤镜：锐化');
  await expect(page.locator('#history-list')).toContainText('预设：User English Preset');
  await expect(page.locator('#canvas-area')).toHaveAttribute('aria-label', /工具：选择/);
  await expect(page.locator('#canvas-area')).toHaveAttribute('aria-label', /User English Layer/);

  await page.evaluate(() => OS.newImage());
  const modal = page.locator('.modal-overlay .modal');
  await expect(modal.locator('h3')).toHaveText('新建图像');
  await expect(modal).toContainText('宽度');
  await expect(modal).toContainText('高度');
  await expect(modal).toContainText('背景');
  await expect(modal.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(modal.getByRole('button', { name: '创建' })).toBeVisible();
  await page.locator('.modal-overlay').evaluate((element) => element.remove());
  await page.evaluate(() => OS.showPreferences());
  await expect(modal.locator('h3')).toHaveText('首选项');
  for (const label of ['画布', '默认宽度', '默认高度', '网格与吸附', '网格大小（像素）', '吸附容差', '性能', '历史记录状态', '界面', '强调色', '语言']) {
    await expect(modal).toContainText(label);
  }
  await expect(modal.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(modal.getByRole('button', { name: '应用' })).toBeVisible();

  const dialogs = [
    ['batchExport', ['批量导出', '一次将画布导出为多种格式。', '全部导出']],
    ['showColorRange', ['色彩范围', '选择：', '取样颜色', '颜色容差', '反相']],
    ['showResize', ['画布大小', '宽度', '高度']],
    ['showFreeTransform', ['自由变换', '水平缩放', '垂直缩放', '旋转', '水平斜切', '垂直斜切']],
    ['skewObject', ['斜切', '水平斜切', '垂直斜切']],
    ['addWatermark', ['添加水印', '文字', '不透明度', '平铺 / 重复']],
    ['showImageInfo', ['图像信息', '画布大小', '总对象数', '估计内存']],
    ['showExportSettings', ['导出设置', '品质', '缩放', '透明背景', '估计大小']],
    ['showShortcuts', ['键盘快捷键', '全选', '关闭']],
    ['showCurvedText', ['弯曲文字', '半径', '起始角度', '大小', '颜色']],
    ['showPresets', ['照片预设', '存储当前设置', '导入 JSON', '全部导出']],
  ];
  for (const [method, expectedTexts] of dialogs) {
    await page.locator('.modal-overlay').evaluateAll((elements) => elements.forEach((element) => element.remove()));
    await page.evaluate((name) => OS[name](), method);
    for (const expectedText of expectedTexts) await expect(modal).toContainText(expectedText);
  }

  await page.locator('.modal-overlay').evaluateAll((elements) => elements.forEach((element) => element.remove()));
  await page.evaluate(() => OS.saveCurrentAsPreset());
  for (const expectedText of ['存储预设', '名称', '取消']) {
    await expect(modal).toContainText(expectedText);
  }
  await expect(modal.getByPlaceholder('我的预设')).toBeVisible();
  await expect(modal.getByRole('button', { name: '保存' })).toBeVisible();

  await page.locator('.modal-overlay').evaluateAll((elements) => elements.forEach((element) => element.remove()));
  await page.evaluate(() => OS._openFilterPanel('i18n-filter-panel', 'Filter: Blur', '<p>Preview</p>', () => {}, () => {}));
  const filterPanel = page.locator('#i18n-filter-panel');
  await expect(filterPanel.locator('h3')).toHaveText('滤镜：模糊');
  await expect(filterPanel.getByRole('button', { name: '取消' })).toBeVisible();
  await expect(filterPanel.getByRole('button', { name: '应用' })).toBeVisible();
  await page.evaluate(() => {
    document.getElementById('i18n-filter-panel')?.remove();
    OS.toggleMacroRec();
  });
  await expect(page.locator('#macro-rec-btn')).toHaveText('停止');
  await page.evaluate(() => OS.toggleMacroRec());
  await expect(page.locator('#macro-rec-btn')).toHaveText('录制');

  await page.evaluate(() => OS.toggleCmdPalette());
  await expect(page.locator('#cmd-results .cmd-label').first()).toHaveText('新建文档');
  await expect(page.locator('#cmd-results .cmd-cat').first()).toHaveText('文件');
  const untranslatedCommands = await page.locator('#cmd-results .cmd-item').evaluateAll((items) => items
    .map((item) => `${item.querySelector('.cmd-label')?.textContent || ''} ${item.querySelector('.cmd-cat')?.textContent || ''}`
      .replace(/PNG|JPEG|WebP|PSD|PDF|SVG|AI/gi, ''))
    .filter((text) => /[A-Za-z]/.test(text)));
  expect(untranslatedCommands).toEqual([]);
  await page.evaluate(() => OS.closeCmdPalette());

  await page.evaluate(() => {
    document.querySelector('.modal-overlay')?.remove();
    OS.setLocale('en-US');
    OS.setLocale('zh-CN');
  });
  const userContent = await page.evaluate(() => ({
    layerName: OS.layers[OS.activeLayerIdx].name,
    text: OS.canvas.getObjects().find((object) => object.type === 'i-text')?.text,
  }));
  expect(userContent).toEqual({
    layerName: 'User English Layer',
    text: 'Do not translate me',
  });
  expect(pageErrors).toEqual([]);
});

test('language preference persists while query override stays temporary', async ({ page }) => {
  await page.goto(editorUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));
  await page.locator('#welcome-overlay .welcome-actions button').last().click();

  await page.evaluate(() => OS.showPreferences());
  const modal = page.locator('.modal-overlay .modal');
  await modal.locator('#pref-lang').selectOption('en-US');
  await modal.locator('[data-modal-action]').click();
  await expect(page.getByRole('menuitem', { name: 'File', exact: true })).toBeVisible();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('openshop_locale'))).toBe('en-US');

  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));
  await expect(page.getByRole('menuitem', { name: 'File', exact: true })).toBeVisible();

  await page.goto(`${editorUrl}?lang=zh-CN`, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));
  await expect(page.getByRole('menuitem', { name: '文件', exact: true })).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('openshop_locale'))).toBe('en-US');
});

test('built runtime supports core editing with every external request blocked', async ({ page }) => {
  const allowedOrigin = new URL(hstarEditorUrl).origin;
  const blockedExternalRequests = [];
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.stack || error.message));
  await page.route('**/*', async (route) => {
    const requestUrl = route.request().url();
    const parsed = new URL(requestUrl);
    if (['data:', 'blob:'].includes(parsed.protocol) || parsed.origin === allowedOrigin) {
      await route.continue();
      return;
    }
    blockedExternalRequests.push(requestUrl);
    await route.abort('blockedbyclient');
  });

  await page.goto(hstarEditorUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));
  await page.getByRole('button', { name: '跳过' }).click();

  const result = await page.evaluate(async () => {
    OS.createNewDocument(320, 240);
    const source = document.createElement('canvas');
    source.width = 32;
    source.height = 32;
    const context = source.getContext('2d');
    const gradient = context.createLinearGradient(0, 0, 32, 32);
    gradient.addColorStop(0, '#15304a');
    gradient.addColorStop(1, '#f2c94c');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 32, 32);

    await new Promise((resolve, reject) => {
      fabric.Image.fromURL(source.toDataURL('image/png'), (image) => {
        if (!image) {
          reject(new Error('Generated raster could not be decoded'));
          return;
        }
        image.set({ name: 'Offline Raster', left: 24, top: 24, selectable: true });
        OS.canvas.add(image);
        OS.layers[OS.activeLayerIdx].objects.push(image);
        OS.canvas.setActiveObject(image);
        OS.canvas.renderAll();
        OS.saveHistory('Add Raster');
        resolve();
      });
    });

    await OS.applyFilterDirect('Sharpen');
    await new Promise((resolve, reject) => {
      const started = performance.now();
      const poll = () => {
        if (OS.history.at(-1)?.action === 'Filter: Sharpen') resolve();
        else if (performance.now() - started > 10000) reject(new Error('Filter history timed out'));
        else setTimeout(poll, 50);
      };
      poll();
    });
    OS.undo();
    await new Promise((resolve) => setTimeout(resolve, 100));
    OS.redo();
    await new Promise((resolve) => setTimeout(resolve, 100));

    OS.showPreferences();
    const preferencesVisible = Boolean(document.querySelector('.modal-overlay .modal'));
    document.querySelector('.modal-overlay')?.remove();
    const boundary = OS.canvas.getObjects().find((object) => object.name === '__boundary__');
    if (boundary) boundary.set('opacity', 0);
    OS.canvas.renderAll();
    const preview = OS.canvas.toDataURL({
      format: 'png', left: 0, top: 0, width: OS.canvasW, height: OS.canvasH, multiplier: 0.5,
    });
    if (boundary) boundary.set('opacity', 1);
    OS.canvas.renderAll();

    return {
      layerCount: OS.layers.length,
      previewBytes: new TextEncoder().encode(preview).byteLength,
      preferencesVisible,
      historyAction: OS.history.at(-1)?.action,
    };
  });

  expect(blockedExternalRequests).toEqual([]);
  expect(pageErrors).toEqual([]);
  expect(result.layerCount).toBeGreaterThan(0);
  expect(result.previewBytes).toBeGreaterThan(100);
  expect(result.preferencesVisible).toBe(true);
  expect(result.historyAction).toBe('Filter: Sharpen');
});

test('mobile welcome actions stay in the initial viewport', async ({ page }) => {
  for (const viewport of [{ width: 375, height: 667 }, { width: 430, height: 932 }]) {
    await page.setViewportSize(viewport);
    await page.goto(editorUrl, { waitUntil: 'load' });
    await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));
    const actions = page.locator('#welcome-overlay .welcome-actions button');
    await expect(actions).toHaveCount(4);
    for (const button of await actions.all()) {
      const box = await button.boundingBox();
      expect(box).not.toBeNull();
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
    }
    await actions.last().click();
    await expect(page.locator('#welcome-overlay')).toBeHidden();
  }
});

test('mobile preferences modal stays inside the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 667 });
  await page.goto(editorUrl, { waitUntil: 'load' });
  await page.waitForFunction(() => typeof OS !== 'undefined' && Boolean(OS.canvas));
  await page.locator('#welcome-overlay .welcome-actions button').last().click();
  await page.evaluate(() => OS.showPreferences());

  const box = await page.locator('.modal-overlay .modal').boundingBox();
  expect(box).not.toBeNull();
  expect(box.x).toBeGreaterThanOrEqual(12);
  expect(box.x + box.width).toBeLessThanOrEqual(363);
});
