import { expect, test } from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:3000';

test('studio shell loads without uncaught page errors', async ({ page }) => {
  const pageErrors = [];
  page.on('pageerror', error => pageErrors.push(error.stack || error.message));

  await page.goto(`${baseUrl}/?shellHealth=${Date.now()}`, {
    waitUntil: 'networkidle',
  });

  expect(pageErrors).toEqual([]);
});
