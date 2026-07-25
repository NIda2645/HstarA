import { chromium, expect, test } from '@playwright/test';
import { spawn, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = 'http://127.0.0.1:3011';
const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, '..', '..', '..');
const pythonExecutable = resolve(repositoryRoot, 'python', 'python.exe');
const realVoiceRoot = String(process.env.HSTAR_REAL_VOICE_ROOT || '').trim();
const recordingExtensions = new Set(['.wav', '.pcm', '.raw', '.webm', '.ogg', '.m4a']);

let serverProcess = null;
let serverOutput = '';
let testRoot = '';
let wavPath = '';
let recordingsBefore = [];

test.skip(!realVoiceRoot, 'Set HSTAR_REAL_VOICE_ROOT to run the real Fun-ASR browser test');
test.describe.configure({mode: 'serial'});

function isInside(child, parent) {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function listRecordings(root) {
  if (!existsSync(root)) return [];
  const found = [];
  const visit = folder => {
    for (const entry of readdirSync(folder, {withFileTypes: true})) {
      const path = resolve(folder, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (recordingExtensions.has(extname(entry.name).toLowerCase())) found.push(path);
    }
  };
  visit(root);
  return found.sort();
}

function prepareIsolatedData() {
  const voiceRoot = resolve(realVoiceRoot);
  const modelRoot = resolve(voiceRoot, 'FunAudioLLM', 'Fun-ASR-Nano-2512');
  const runtimeSite = resolve(voiceRoot, '.hstar-voice', 'runtime', 'site-packages');
  if (!existsSync(resolve(modelRoot, 'model.pt')) || !existsSync(runtimeSite)) {
    throw new Error(`Real voice runtime is incomplete: ${voiceRoot}`);
  }
  testRoot = mkdtempSync(resolve(tmpdir(), 'hstar-real-voice-e2e-'));
  const dataDir = resolve(testRoot, 'data');
  mkdirSync(dataDir, {recursive: true});
  writeFileSync(resolve(dataDir, 'software_settings.json'), JSON.stringify({
    storage_root: testRoot,
    voice_assistant: {
      enabled: true,
      storage_mode: 'custom',
      storage_root: voiceRoot,
      model_path: modelRoot,
      model_revision: 'master',
      language: 'auto',
      input_device_id: 'default',
      shortcut: 'Shift+Q',
      prewarm_on_startup: false,
    },
  }, null, 2), 'utf8');

  wavPath = resolve(testRoot, 'official-zh-with-silence.wav');
  const prepared = spawnSync(pythonExecutable, [
    '-X',
    'utf8',
    resolve(repositoryRoot, 'tools', 'voice-assistant-real-smoke.py'),
    '--voice-root',
    voiceRoot,
    '--prepare-browser-wav',
    wavPath,
  ], {
    cwd: repositoryRoot,
    windowsHide: true,
    encoding: 'utf8',
  });
  if (prepared.status !== 0 || !existsSync(wavPath)) {
    throw new Error(`Failed to prepare real microphone WAV:\n${prepared.stdout}\n${prepared.stderr}`);
  }
  recordingsBefore = listRecordings(voiceRoot);
}

async function serverResponds(timeout = 500) {
  try {
    const response = await fetch(`${baseUrl}/api/app-info`, {
      signal: AbortSignal.timeout(timeout),
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function startIsolatedServer() {
  if (await serverResponds()) {
    throw new Error('Port 3011 is already in use; refusing to stop an unknown process');
  }
  prepareIsolatedData();
  const environment = {
    ...process.env,
    HSTAR_DATA_DIR: testRoot,
    HSTAR_PORT: '3011',
    PYTHONUTF8: '1',
    PYTHONIOENCODING: 'utf-8',
  };
  delete environment.HSTAR_VOICE_TEST_MODE;
  serverProcess = spawn(pythonExecutable, [
    '-X',
    'utf8',
    '-m',
    'uvicorn',
    'main:app',
    '--host',
    '127.0.0.1',
    '--port',
    '3011',
    '--ws-ping-interval',
    '0',
  ], {
    cwd: repositoryRoot,
    windowsHide: true,
    env: environment,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = chunk => {
    serverOutput = `${serverOutput}${chunk.toString('utf8')}`.slice(-30_000);
  };
  serverProcess.stdout.on('data', collect);
  serverProcess.stderr.on('data', collect);

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (serverProcess.exitCode !== null) {
      throw new Error(`Isolated Hstar server exited early:\n${serverOutput}`);
    }
    if (await serverResponds(1_000)) return;
    await new Promise(resolveDelay => setTimeout(resolveDelay, 200));
  }
  throw new Error(`Timed out waiting for isolated Hstar server:\n${serverOutput}`);
}

async function stopIsolatedServer() {
  try {
    await fetch(`${baseUrl}/api/voice-assistant/service/stop`, {
      method: 'POST',
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    // A failed cold-load test may not have started the child service.
  }
  if (serverProcess?.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await Promise.race([
      new Promise(resolveExit => serverProcess.once('exit', resolveExit)),
      new Promise(resolveDelay => setTimeout(resolveDelay, 10_000)),
    ]);
  }
  serverProcess = null;

  if (realVoiceRoot) {
    expect(listRecordings(resolve(realVoiceRoot))).toEqual(recordingsBefore);
  }
  if (testRoot) {
    if (!isInside(testRoot, tmpdir())) {
      throw new Error(`Refusing to delete non-temporary E2E root: ${testRoot}`);
    }
    rmSync(testRoot, {recursive: true, force: true});
  }
}

async function launchVoiceBrowser() {
  const browser = await chromium.launch({
    headless: true,
    args: [
      '--use-fake-device-for-media-stream',
      '--use-fake-ui-for-media-stream',
      `--use-file-for-fake-audio-capture=${wavPath}`,
      '--autoplay-policy=no-user-gesture-required',
    ],
  });
  const context = await browser.newContext({
    permissions: ['microphone'],
    viewport: {width: 1440, height: 1000},
  });
  return {browser, context};
}

async function openMainPage(context) {
  const page = await context.newPage();
  await page.addInitScript(() => {
    window.__hstarVoicePerformanceEvents = [];
    window.addEventListener('hstar-voice-state-change', event => {
      window.__hstarVoicePerformanceEvents.push({
        at: performance.now(),
        state: event.detail?.state || '',
      });
    });
  });
  await page.goto(baseUrl, {waitUntil: 'domcontentloaded'});
  await page.waitForFunction(() => Boolean(window.HstarVoiceAssistant));
  return page;
}

async function switchSection(page, id, selector) {
  await page.evaluate(sectionId => window.switchUI(null, sectionId), id);
  const frame = page.frameLocator(`#frame-${id}`);
  await expect(frame.locator(selector)).toBeVisible({timeout: 15_000});
  return frame;
}

async function waitForActiveVoice(page, timeout) {
  await expect.poll(
    () => page.evaluate(() => window.HstarVoiceAssistant?.state),
    {timeout},
  ).toMatch(/^(listening|recognizing)$/);
}

async function waitForReadyVoice(page, timeout = 20_000) {
  await expect.poll(
    () => page.evaluate(() => window.HstarVoiceAssistant?.state),
    {timeout},
  ).toBe('ready');
}

async function serviceProcessId(context) {
  const response = await context.request.get(`${baseUrl}/api/voice-assistant/status`);
  expect(response.ok()).toBe(true);
  return Number((await response.json()).status?.service?.process_id || 0);
}

async function beginWarmMeasurement(page) {
  await page.evaluate(() => {
    window.__hstarVoicePerformanceEvents = [];
    window.__hstarVoicePerformanceStartedAt = performance.now();
  });
}

async function warmActivationMilliseconds(page) {
  return page.evaluate(() => {
    const event = (window.__hstarVoicePerformanceEvents || []).find(item => (
      item.state === 'listening' || item.state === 'recognizing'
    ));
    return event ? event.at - window.__hstarVoicePerformanceStartedAt : Number.POSITIVE_INFINITY;
  });
}

async function assertChineseTranscript(locator) {
  await expect.poll(
    () => locator.evaluate(element => (
      'value' in element ? element.value : element.textContent
    )),
    {timeout: 25_000},
  ).toMatch(/时间早上九点至下午五点/);
}

test.beforeAll(async () => {
  await startIsolatedServer();
});

test.afterAll(async () => {
  await stopIsolatedServer();
});

test('runs the real model through GPT, smart canvas, and OpenShop without restarting it', async () => {
  test.setTimeout(180_000);
  let processId = 0;
  const browserMetrics = {};

  {
    const {browser, context} = await launchVoiceBrowser();
    try {
      const page = await openMainPage(context);
      const gptFrame = await switchSection(page, 'gpt-chat', '#messageInput');
      const input = gptFrame.locator('#messageInput');
      await input.fill('');
      await input.focus();
      await beginWarmMeasurement(page);
      await input.press('Shift+Q');

      const responsiveAt = Date.now();
      const appInfo = await context.request.get(`${baseUrl}/api/app-info`);
      expect(appInfo.ok()).toBe(true);
      browserMetrics.mainResponseDuringColdLoadMs = Date.now() - responsiveAt;
      expect(browserMetrics.mainResponseDuringColdLoadMs).toBeLessThan(2_000);

      await waitForActiveVoice(page, 75_000);
      browserMetrics.coldClickToListeningMs = await warmActivationMilliseconds(page);
      await assertChineseTranscript(input);
      await waitForReadyVoice(page);
      processId = await serviceProcessId(context);
      expect(processId).toBeGreaterThan(0);
    } finally {
      await browser.close();
    }
  }

  {
    const {browser, context} = await launchVoiceBrowser();
    try {
      const page = await openMainPage(context);
      const created = await context.request.post(`${baseUrl}/api/canvases`, {
        data: {title: 'Real Voice E2E', kind: 'smart', icon: 'sparkles'},
      });
      expect(created.ok()).toBe(true);
      const canvas = (await created.json()).canvas;
      const smartUrl = `/static/smart-canvas.html?id=${encodeURIComponent(canvas.id)}`;
      await page.evaluate(url => {
        window.switchUI(null, 'canvas');
        document.getElementById('frame-canvas').src = url;
      }, smartUrl);
      const prompt = page.frameLocator('#frame-canvas').locator('#promptInput');
      await expect(prompt).toBeVisible({timeout: 15_000});
      await prompt.fill('');
      await prompt.focus();
      await beginWarmMeasurement(page);
      await prompt.press('Shift+Q');
      await waitForActiveVoice(page, 5_000);
      browserMetrics.smartCanvasWarmClickToListeningMs = await warmActivationMilliseconds(page);
      expect(browserMetrics.smartCanvasWarmClickToListeningMs).toBeLessThanOrEqual(500);
      await assertChineseTranscript(prompt);
      await waitForReadyVoice(page);
      expect(await serviceProcessId(context)).toBe(processId);
    } finally {
      await browser.close();
    }
  }

  {
    const {browser, context} = await launchVoiceBrowser();
    try {
      const page = await openMainPage(context);
      await page.evaluate(url => {
        window.switchUI(null, 'canvas');
        document.getElementById('frame-canvas').src = url;
      }, '/static/openshop/index.html');
      const openshop = page.frameLocator('#frame-canvas');
      await openshop.locator('body').waitFor();
      const openshopFrame = page.frames().find(frame => frame.url().includes('/static/openshop/index.html'));
      await openshopFrame.waitForFunction(() => Boolean(
        typeof OS !== 'undefined'
        && OS.canvas
        && window.HstarOpenShopGenerativeToolsController
      ));
      await openshopFrame.evaluate(() => {
        OS.dismissWelcome();
        OS.createNewDocument(640, 480);
        window.HstarOpenShopGenerativeToolsController.openTool('generative-fill');
        document.querySelector('[data-generative-action="zoom-panel"]')?.click();
        const editor = document.querySelector('[data-generative-prompt]');
        editor.innerHTML = '';
        editor.focus();
      });
      const editor = openshop.locator('[data-generative-prompt]');
      await expect(editor).toBeVisible();
      await beginWarmMeasurement(page);
      await editor.press('Shift+Q');
      await waitForActiveVoice(page, 5_000);
      browserMetrics.openShopWarmClickToListeningMs = await warmActivationMilliseconds(page);
      expect(browserMetrics.openShopWarmClickToListeningMs).toBeLessThanOrEqual(500);
      await assertChineseTranscript(editor);
      await waitForReadyVoice(page);
      expect(await serviceProcessId(context)).toBe(processId);
    } finally {
      await browser.close();
    }
  }
  console.log(`HSTAR_REAL_VOICE_METRICS ${JSON.stringify({processId, ...browserMetrics})}`);
});
