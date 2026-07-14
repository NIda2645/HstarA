import { expect, test } from '@playwright/test';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const editorUrl = pathToFileURL(resolve('index.html')).href;

test('default shell uses Simplified Chinese application text', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

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
