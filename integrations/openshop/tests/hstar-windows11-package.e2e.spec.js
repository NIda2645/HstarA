import {expect, test} from '@playwright/test';

const baseUrl = process.env.HSTAR_BASE_URL || 'http://127.0.0.1:55500';
const expectedDataRoot = String(process.env.HSTAR_EXPECTED_DATA_ROOT || '').trim();
const migrationTarget = String(process.env.HSTAR_MIGRATION_TARGET || '').trim();
const providerId = String(process.env.HSTAR_EXPECTED_PROVIDER_ID || 'codex-package-smoke').trim();

async function responseJson(response) {
  const payload = await response.json().catch(() => ({}));
  expect(response.ok(), JSON.stringify(payload)).toBeTruthy();
  return payload;
}

test.describe.configure({mode: 'serial'});

test('loads packaged navigation surfaces without page errors', async ({page}) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.stack || error.message));
  await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => typeof window.switchUI === 'function');

  for (const [id, expectedPath] of [
    ['software-settings', '/static/software-settings.html'],
    ['api-settings', '/static/api-settings.html'],
    ['director-desk', '/static/3d-director/index.html'],
  ]) {
    await page.evaluate(pageId => window.switchUI(null, pageId, {skipRemember: true}), id);
    const frame = page.locator(`#frame-${id}`);
    await expect(frame).toHaveClass(/active/);
    await expect.poll(async () => new URL(await frame.getAttribute('src'), baseUrl).pathname)
      .toBe(expectedPath);
    const contentFrame = await (await frame.elementHandle()).contentFrame();
    await contentFrame.waitForLoadState('domcontentloaded');
    await expect(contentFrame.locator('body')).not.toBeEmpty();
  }

  await page.evaluate(() => window.switchUI(null, 'zimage', {skipRemember: true}));
  await expect(page.locator('#frame-director-desk')).not.toHaveClass(/active/);
  expect(errors).toEqual([]);
});

test('persists isolated settings and reports voice status without downloading a model', async ({request}) => {
  const settings = await responseJson(await request.get(`${baseUrl}/api/software-settings`));
  if (expectedDataRoot) {
    expect(settings.settings.active_storage_root.toLowerCase())
      .toBe(expectedDataRoot.toLowerCase());
  }

  const providerPayload = await responseJson(await request.get(`${baseUrl}/api/providers`));
  expect(providerPayload.providers.length).toBeGreaterThan(0);
  const customProvider = {
    id: providerId,
    name: 'Windows 11 package smoke',
    base_url: 'https://example.invalid/v1',
    protocol: 'openai',
    enabled: false,
    primary: false,
    image_models: [],
    chat_models: [],
    video_models: [],
  };
  const withoutPreviousProbe = providerPayload.providers
    .filter(provider => provider.id !== providerId);
  await responseJson(await request.put(`${baseUrl}/api/providers`, {
    data: [...withoutPreviousProbe, customProvider],
  }));
  const persistedProviders = await responseJson(await request.get(`${baseUrl}/api/providers`));
  expect(persistedProviders.providers.find(provider => provider.id === providerId))
    .toMatchObject(customProvider);

  const voice = await responseJson(await request.get(`${baseUrl}/api/voice-assistant/status`));
  expect(voice.status.service).toMatchObject({
    process_state: 'stopped',
    process_id: 0,
    active_sessions: 0,
  });
  expect(voice.status.task).toBeNull();
});

test('completes an isolated storage migration and requests a controlled restart', async ({request}) => {
  test.skip(!migrationTarget, 'HSTAR_MIGRATION_TARGET is required for package validation');
  const started = await responseJson(await request.post(`${baseUrl}/api/storage-migrations`, {
    data: {storage_root: migrationTarget},
  }));
  const taskId = started.task.id;
  expect(taskId).toBeTruthy();

  await expect.poll(async () => {
    const status = await responseJson(
      await request.get(`${baseUrl}/api/storage-migrations/${encodeURIComponent(taskId)}`),
    );
    return status.task;
  }, {timeout: 30_000}).toMatchObject({
    status: 'completed',
    restart_required: true,
  });
});
