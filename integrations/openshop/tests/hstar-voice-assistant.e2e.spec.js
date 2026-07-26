import { chromium, expect, test } from '@playwright/test';
import { spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const baseUrl = 'http://127.0.0.1:3011';
const testDir = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(testDir, '..', '..', '..');
const pythonExecutable = resolve(repositoryRoot, 'python', 'python.exe');
const requiredModelPaths = [
  'configuration.json',
  'config.yaml',
  'model.pt',
  'multilingual.tiktoken',
  'Qwen3-0.6B/config.json',
  'Qwen3-0.6B/generation_config.json',
  'Qwen3-0.6B/merges.txt',
  'Qwen3-0.6B/tokenizer.json',
  'Qwen3-0.6B/tokenizer_config.json',
  'Qwen3-0.6B/vocab.json',
];

let serverProcess = null;
let serverOutput = '';
let testRoot = '';
let voiceRoot = '';
let wavPath = '';

function isInside(child, parent) {
  const value = relative(resolve(parent), resolve(child));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function createVoiceWav(path) {
  const sampleRate = 48_000;
  const speechSeconds = 4.9;
  const totalSeconds = 17;
  const samples = sampleRate * totalSeconds;
  const pcm = Buffer.alloc(samples * 2);
  for (let index = 0; index < samples; index += 1) {
    const seconds = index / sampleRate;
    const value = seconds < speechSeconds
      ? Math.round(Math.sin(2 * Math.PI * 440 * seconds) * 8_000)
      : 0;
    pcm.writeInt16LE(value, index * 2);
  }

  const wav = Buffer.alloc(44 + pcm.length);
  wav.write('RIFF', 0, 'ascii');
  wav.writeUInt32LE(36 + pcm.length, 4);
  wav.write('WAVE', 8, 'ascii');
  wav.write('fmt ', 12, 'ascii');
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(sampleRate, 24);
  wav.writeUInt32LE(sampleRate * 2, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36, 'ascii');
  wav.writeUInt32LE(pcm.length, 40);
  pcm.copy(wav, 44);
  writeFileSync(path, wav);
}

function prepareIsolatedData() {
  testRoot = mkdtempSync(resolve(tmpdir(), 'hstar-voice-e2e-'));
  voiceRoot = resolve(testRoot, 'voice-assistant');
  const modelRoot = resolve(voiceRoot, 'FunAudioLLM', 'Fun-ASR-Nano-2512');
  for (const modelPath of requiredModelPaths) {
    const target = resolve(modelRoot, ...modelPath.split('/'));
    mkdirSync(dirname(target), {recursive: true});
    writeFileSync(target, '');
  }

  const dataDir = resolve(testRoot, 'data');
  mkdirSync(dataDir, {recursive: true});
  const runtimeManifest = JSON.parse(readFileSync(
    resolve(repositoryRoot, 'voice_assistant', 'runtime_manifest.json'),
    'utf8',
  ));
  const runtimeState = resolve(voiceRoot, '.hstar-voice', 'state');
  mkdirSync(resolve(voiceRoot, '.hstar-voice', 'runtime', 'site-packages'), {recursive: true});
  mkdirSync(runtimeState, {recursive: true});
  writeFileSync(resolve(runtimeState, 'runtime-install.json'), JSON.stringify({
    profile: 'cpu',
    packages: runtimeManifest.packages,
  }), 'utf8');
  writeFileSync(resolve(dataDir, 'software_settings.json'), JSON.stringify({
    storage_root: testRoot,
    voice_assistant: {
      enabled: true,
      storage_mode: 'custom',
      storage_root: voiceRoot,
      model_path: modelRoot,
      model_revision: 'fake-e2e',
      language: 'auto',
      input_device_id: 'default',
      shortcut: 'Shift+Q',
      prewarm_on_startup: false,
    },
  }, null, 2), 'utf8');

  wavPath = resolve(testRoot, 'fake-microphone.wav');
  createVoiceWav(wavPath);
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
    env: {
      ...process.env,
      HSTAR_DATA_DIR: testRoot,
      HSTAR_PORT: '3011',
      HSTAR_VOICE_TEST_MODE: '1',
      PYTHONUTF8: '1',
      PYTHONIOENCODING: 'utf-8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = chunk => {
    serverOutput = `${serverOutput}${chunk.toString('utf8')}`.slice(-20_000);
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
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    // The service may not have been started by a failed test.
  }
  if (serverProcess?.exitCode === null) {
    serverProcess.kill('SIGTERM');
    await Promise.race([
      new Promise(resolveExit => serverProcess.once('exit', resolveExit)),
      new Promise(resolveDelay => setTimeout(resolveDelay, 5_000)),
    ]);
  }
  serverProcess = null;

  if (testRoot) {
    if (!isInside(testRoot, tmpdir())) {
      throw new Error(`Refusing to delete non-temporary E2E root: ${testRoot}`);
    }
    rmSync(testRoot, {recursive: true, force: true});
  }
}

async function launchVoiceBrowser() {
  if (!existsSync(wavPath)) throw new Error('Fake microphone WAV is missing');
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
    window.__hstarVoiceEvents = [];
    window.addEventListener('hstar-voice-state-change', event => {
      window.__hstarVoiceEvents.push({
        at: Date.now(),
        detail: JSON.parse(JSON.stringify(event.detail || {})),
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

async function waitForActiveVoice(page) {
  await expect.poll(
    () => page.evaluate(() => window.HstarVoiceAssistant?.state),
    {timeout: 10_000},
  ).toMatch(/^(listening|recognizing)$/);
}

async function waitForReadyVoice(page, timeout = 5_000) {
  await expect.poll(
    () => page.evaluate(() => window.HstarVoiceAssistant?.state),
    {timeout},
  ).toBe('ready');
}

test.beforeAll(async () => {
  await startIsolatedServer();
});

test.afterAll(async () => {
  await stopIsolatedServer();
});

test('dictates into the focused smart-canvas prompt without duplicate partials and stops after silence', async () => {
  test.setTimeout(40_000);
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    const created = await context.request.post(`${baseUrl}/api/canvases`, {
      data: {title: 'Voice E2E', kind: 'smart', icon: 'sparkles'},
    });
    expect(created.ok()).toBe(true);
    const canvas = (await created.json()).canvas;
    const smartUrl = `/static/smart-canvas.html?id=${encodeURIComponent(canvas.id)}`;
    await page.evaluate(url => {
      window.switchUI(null, 'canvas');
      document.getElementById('frame-canvas').src = url;
    }, smartUrl);

    const smartFrame = page.frameLocator('#frame-canvas');
    const prompt = smartFrame.locator('#promptInput');
    await expect(prompt).toBeVisible({timeout: 15_000});
    await prompt.fill('');
    await prompt.focus();
    await prompt.press('Shift+Q');
    await waitForActiveVoice(page);

    await expect(prompt).toHaveText('测试语音完成。', {timeout: 10_000});
    await page.evaluate(() => {
      window.HstarVoiceAssistant._handleSocketMessage({
        data: JSON.stringify({type: 'partial', text: '过期结果', sequence: 1}),
      });
    });
    await expect(prompt).toHaveText('测试语音完成。');

    await waitForReadyVoice(page, 12_000);
    const result = await page.evaluate(() => {
      const events = window.__hstarVoiceEvents || [];
      const finalEvent = events.find(item => item.detail?.type === 'final');
      const stoppedEvent = events.find(item => item.detail?.reason === 'silence-timeout');
      return {
        debug: window.HstarVoiceAssistant.debugState(),
        silenceElapsed: finalEvent && stoppedEvent ? stoppedEvent.at - finalEvent.at : -1,
        stoppedReason: stoppedEvent?.detail?.reason || '',
      };
    });
    expect(result.stoppedReason).toBe('silence-timeout');
    expect(result.silenceElapsed).toBeGreaterThanOrEqual(8_000);
    expect(result.silenceElapsed).toBeLessThanOrEqual(11_000);
    expect(result.debug).toMatchObject({
      state: 'ready',
      trackCount: 0,
      hasAudioContext: false,
      hasSocket: false,
    });
  } finally {
    await browser.close();
  }
});

test('replaces selected GPT text, supports Ctrl+Z, and rejects a competing microphone session', async () => {
  test.setTimeout(30_000);
  const {browser, context} = await launchVoiceBrowser();
  try {
    const firstPage = await openMainPage(context);
    const gptFrame = await switchSection(firstPage, 'gpt-chat', '#messageInput');
    const input = gptFrame.locator('#messageInput');
    await input.evaluate(element => {
      element.value = '前缀旧内容后缀';
      element.focus();
      element.setSelectionRange(2, 5);
    });
    await input.press('Shift+Q');
    await waitForActiveVoice(firstPage);

    const secondPage = await openMainPage(context);
    const assetFrame = await switchSection(secondPage, 'asset-manager', '#assetSearch');
    const search = assetFrame.locator('#assetSearch');
    await search.focus();
    await search.press('Shift+Q');
    await expect.poll(
      () => secondPage.evaluate(() => window.HstarVoiceAssistant?.state),
      {timeout: 8_000},
    ).toBe('error');
    const contention = await secondPage.evaluate(() => ({
      debug: window.HstarVoiceAssistant.debugState(),
      busy: window.__hstarVoiceEvents.some(item => item.detail?.code === 'VOICE_MIC_BUSY'),
    }));
    expect(contention.busy).toBe(true);
    expect(contention.debug).toMatchObject({
      trackCount: 0,
      hasAudioContext: false,
      hasSocket: false,
    });

    await expect(input).toHaveValue('前缀测试语音完成。后缀', {timeout: 10_000});
    await input.press('Control+Z');
    await expect(input).toHaveValue('前缀旧内容后缀');
    await input.press('Shift+Q');
    await waitForReadyVoice(firstPage);
  } finally {
    await browser.close();
  }
});

test('dictates a complete query into the rerendering asset-library search field', async () => {
  test.setTimeout(25_000);
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    const assetFrame = await switchSection(page, 'asset-manager', '#assetSearch');
    const search = assetFrame.locator('#assetSearch');
    await search.fill('');
    await search.focus();
    await search.press('Shift+Q');
    await waitForActiveVoice(page);
    await expect(search).toHaveValue('测试语音完成。', {timeout: 10_000});
    await page.evaluate(() => window.HstarVoiceAssistant.stop('test-cleanup'));
    await waitForReadyVoice(page);
  } finally {
    await browser.close();
  }
});

test('preserves OpenShop mention capsules while replacing selected rich text', async () => {
  test.setTimeout(30_000);
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    await page.evaluate(url => {
      window.switchUI(null, 'canvas');
      document.getElementById('frame-canvas').src = url;
    }, '/static/openshop/index.html');
    const openshop = page.frameLocator('#frame-canvas');
    await openshop.locator('body').waitFor();
    await expect.poll(() => page.frames().some(frame => (
      frame.url().includes('/static/openshop/index.html')
      && frame.url() !== page.url()
    )), {timeout: 15_000}).toBe(true);
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
    });
    await page.waitForTimeout(300);
    await openshopFrame.evaluate(() => {
      const editor = document.querySelector('[data-generative-prompt]');
      editor.innerHTML = '<span class="hstar-generative-mention-token" contenteditable="false" data-generative-mention-token="true" data-reference-key="selection-1" data-mention="@选区1">@选区1</span><span data-test-tail>旧描述</span>';
      editor.dispatchEvent(new InputEvent('input', {bubbles: true, inputType: 'insertText'}));
      editor.focus();
      const range = document.createRange();
      range.selectNodeContents(editor.querySelector('[data-test-tail]'));
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    });

    const editor = openshop.locator('[data-generative-prompt]');
    await expect(editor).toBeVisible();
    await openshopFrame.evaluate(() => {
      document.querySelector('[data-generative-prompt]').dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Q',
        shiftKey: true,
        bubbles: true,
        cancelable: true,
      }));
    });
    await waitForActiveVoice(page);
    await expect(editor).toHaveText('@选区1测试语音完成。', {timeout: 10_000});
    const richText = await editor.evaluate(element => ({
      mentionCount: element.querySelectorAll('[data-generative-mention-token]').length,
      mention: element.querySelector('[data-generative-mention-token]')?.textContent,
      compositionCount: element.querySelectorAll('[data-voice-composition]').length,
    }));
    expect(richText).toEqual({
      mentionCount: 1,
      mention: '@选区1',
      compositionCount: 0,
    });
    await editor.press('Shift+Q');
    await waitForReadyVoice(page);
  } finally {
    await browser.close();
  }
});

test('dictates into OpenShop horizontal and vertical text editors', async () => {
  test.setTimeout(30_000);
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    await page.evaluate(url => {
      window.switchUI(null, 'canvas');
      document.getElementById('frame-canvas').src = url;
    }, '/static/openshop/index.html');
    const openshop = page.frameLocator('#frame-canvas');
    await openshop.locator('body').waitFor();
    await expect.poll(() => page.frames().some(frame => (
      frame.url().includes('/static/openshop/index.html')
      && frame.url() !== page.url()
    )), {timeout: 15_000}).toBe(true);
    const openshopFrame = page.frames().find(frame => frame.url().includes('/static/openshop/index.html'));
    await openshopFrame.waitForFunction(() => Boolean(
      typeof OS !== 'undefined'
      && OS.canvas
      && window.HstarOpenShopWritingMode
    ));
    await openshopFrame.evaluate(() => {
      OS.dismissWelcome();
      OS.createNewDocument(640, 480);
      const text = new fabric.IText('', {
        left: 80,
        top: 80,
        fontSize: 42,
        fill: '#111111',
        editable: true,
      });
      OS.canvas.add(text);
      OS.layers[OS.activeLayerIdx].objects.push(text);
      OS.canvas.setActiveObject(text);
      text.enterEditing();
      text.selectionStart = text.selectionEnd = 0;
      text._updateTextarea();
      text.hiddenTextarea.dataset.voiceTest = 'horizontal';
      text.hiddenTextarea.focus();
      window.__hstarVoiceHorizontalText = text;
    });
    await expect.poll(() => page.evaluate(() => (
      window.HstarVoiceAssistant?._activeTarget?.hstarVoiceFrameTarget === true
    )), {timeout: 5_000}).toBe(true);
    await page.keyboard.press('Shift+Q');
    await waitForActiveVoice(page);
    await page.evaluate(() => window.HstarVoiceAssistant._handleSocketMessage({
      data: JSON.stringify({type: 'final', text: '\u6a2a\u6392\u8bed\u97f3', sequence: 9999}),
    }));
    await expect.poll(() => openshopFrame.evaluate(() => (
      window.__hstarVoiceHorizontalText.text
    ))).toBe('\u6a2a\u6392\u8bed\u97f3');
    await page.evaluate(() => window.HstarVoiceAssistant.stop('test-cleanup'));
    await waitForReadyVoice(page);

    await openshopFrame.evaluate(() => {
      const horizontal = window.__hstarVoiceHorizontalText;
      horizontal.exitEditing();
      const text = window.HstarOpenShopWritingMode.createTextObject(
        fabric,
        '',
        {
          left: 180,
          top: 80,
          fontSize: 42,
          fill: '#111111',
          hstarWritingMode: 'vertical',
        },
      );
      OS.canvas.add(text);
      OS.layers[OS.activeLayerIdx].objects.push(text);
      OS.canvas.setActiveObject(text);
      text.enterEditing();
      const editor = document.querySelector('textarea[data-hstar-vertical-editor]');
      editor.dataset.voiceTest = 'vertical';
      editor.focus();
      window.__hstarVoiceVerticalText = text;
    });
    await expect.poll(() => page.evaluate(() => (
      window.HstarVoiceAssistant?._activeTarget?.hstarVoiceFrameTarget === true
    )), {timeout: 5_000}).toBe(true);
    await page.keyboard.press('Shift+Q');
    await waitForActiveVoice(page);
    await page.evaluate(() => window.HstarVoiceAssistant._handleSocketMessage({
      data: JSON.stringify({type: 'final', text: '\u7ad6\u6392\u8bed\u97f3', sequence: 9999}),
    }));
    await expect.poll(() => openshopFrame.evaluate(() => (
      window.__hstarVoiceVerticalText.text
    ))).toBe('\u7ad6\u6392\u8bed\u97f3');
    await page.evaluate(() => window.HstarVoiceAssistant.stop('test-cleanup'));
    await waitForReadyVoice(page);
  } finally {
    await browser.close();
  }
});

test('releases the session when its target is removed or its iframe navigates', async () => {
  test.setTimeout(25_000);
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    await page.evaluate(() => {
      const target = document.createElement('textarea');
      target.id = 'voice-removal-target';
      target.dataset.voiceInput = 'on';
      target.style.cssText = 'position:fixed;left:200px;top:100px;width:240px;height:80px;z-index:9999';
      document.body.appendChild(target);
      target.focus();
    });
    const directTarget = page.locator('#voice-removal-target');
    await directTarget.press('Shift+Q');
    await waitForActiveVoice(page);
    await directTarget.evaluate(element => element.remove());
    await waitForReadyVoice(page, 3_000);
    expect(await page.evaluate(() => window.HstarVoiceAssistant.debugState())).toMatchObject({
      trackCount: 0,
      hasAudioContext: false,
      hasSocket: false,
    });

    const gptFrame = await switchSection(page, 'gpt-chat', '#messageInput');
    const input = gptFrame.locator('#messageInput');
    await input.focus();
    await input.press('Shift+Q');
    await waitForActiveVoice(page);
    await page.evaluate(() => {
      document.getElementById('frame-gpt-chat').src = '/static/asset-manager.html?voice-navigation=1';
    });
    await waitForReadyVoice(page, 5_000);
    expect(await page.evaluate(() => window.HstarVoiceAssistant.debugState())).toMatchObject({
      trackCount: 0,
      hasAudioContext: false,
      hasSocket: false,
    });
  } finally {
    await browser.close();
  }
});

test('keeps the microphone anchored, preserves iframe focus, and hides it on section switch', async () => {
  test.setTimeout(30_000);
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    const gptFrame = await switchSection(page, 'gpt-chat', '#messageInput');
    const input = gptFrame.locator('#messageInput');
    await input.evaluate(element => {
      element.value = '前后';
      element.focus();
      element.setSelectionRange(1, 1);
    });
    const entry = page.locator('.hstar-voice-entry');
    const button = page.locator('.hstar-voice-button');
    await expect(entry).toBeVisible();

    const targetBefore = await input.boundingBox();
    const entryBefore = await entry.boundingBox();
    expect(Math.abs(entryBefore.x - (targetBefore.x + targetBefore.width - 34))).toBeLessThanOrEqual(8);
    expect(Math.abs(entryBefore.y - (targetBefore.y + 6))).toBeLessThanOrEqual(8);

    await page.setViewportSize({width: 1200, height: 820});
    await expect.poll(async () => {
      const [targetAfter, entryAfter] = await Promise.all([
        input.boundingBox(),
        entry.boundingBox(),
      ]);
      if (!targetAfter || !entryAfter) return Number.POSITIVE_INFINITY;
      return Math.max(
        Math.abs(entryAfter.x - (targetAfter.x + targetAfter.width - 34)),
        Math.abs(entryAfter.y - (targetAfter.y + 6)),
      );
    }, {timeout: 2_000}).toBeLessThanOrEqual(8);

    await button.click();
    expect(await input.evaluate(element => ({
      focused: element.ownerDocument.activeElement === element,
      start: element.selectionStart,
      end: element.selectionEnd,
    }))).toEqual({focused: true, start: 1, end: 1});
    await waitForActiveVoice(page);
    await page.evaluate(() => window.HstarVoiceAssistant.stop('test-cleanup'));
    await waitForReadyVoice(page);

    await page.evaluate(() => window.switchUI(null, 'asset-manager'));
    await expect(page.frameLocator('#frame-asset-manager').locator('#assetSearch')).toBeVisible();
    await expect(entry).toBeHidden();
  } finally {
    await browser.close();
  }
});

test('renders contrasting app themes and a layout-stable rainbow recognition ring', async () => {
  const {browser, context} = await launchVoiceBrowser();
  try {
    const page = await openMainPage(context);
    await page.evaluate(() => {
      document.documentElement.classList.remove('theme-dark', 'studio-theme-dark');
      document.body.classList.remove('theme-dark', 'studio-theme-dark');
      const target = document.createElement('textarea');
      target.id = 'voice-theme-target';
      target.dataset.voiceInput = 'on';
      target.style.cssText = 'position:fixed;left:220px;top:140px;width:320px;height:96px';
      document.body.append(target);
      target.focus();
    });
    const button = page.locator('.hstar-voice-button');
    const entry = page.locator('.hstar-voice-entry');
    await expect(entry).toBeVisible();
    const light = await button.evaluate(element => {
      const style = getComputedStyle(element);
      return {background: style.backgroundColor, color: style.color};
    });
    expect(light).toEqual({background: 'rgb(17, 17, 17)', color: 'rgb(255, 255, 255)'});

    await page.evaluate(() => {
      document.documentElement.classList.add('theme-dark', 'studio-theme-dark');
      document.body.classList.add('theme-dark', 'studio-theme-dark');
    });
    const dark = await button.evaluate(element => {
      const style = getComputedStyle(element);
      return {background: style.backgroundColor, color: style.color};
    });
    expect(dark).toEqual({background: 'rgb(245, 245, 247)', color: 'rgb(17, 17, 17)'});

    const before = await button.boundingBox();
    await page.evaluate(() => window.HstarVoiceAssistant._setState('recognizing'));
    const after = await button.boundingBox();
    expect(after).toEqual(before);
    const visual = await page.evaluate(() => {
      const buttonElement = document.querySelector('.hstar-voice-button');
      const fallbackElement = document.querySelector('.hstar-voice-mic-fallback');
      const iconElement = buttonElement.querySelector('svg') || fallbackElement;
      const buttonRect = buttonElement.getBoundingClientRect();
      const iconRect = iconElement.getBoundingClientRect();
      const ring = getComputedStyle(document.querySelector('.hstar-voice-level'));
      const status = getComputedStyle(document.querySelector('.hstar-voice-status'));
      const fallback = getComputedStyle(fallbackElement);
      return {
        ring: ring.backgroundImage,
        statusBackground: status.backgroundColor,
        statusColor: status.color,
        statusOpacity: status.opacity,
        iconCenterOffset: {
          x: (iconRect.left + (iconRect.width / 2)) - (buttonRect.left + (buttonRect.width / 2)),
          y: (iconRect.top + (iconRect.height / 2)) - (buttonRect.top + (buttonRect.height / 2)),
        },
        hasSvg: Boolean(document.querySelector('.hstar-voice-button > svg')),
        fallbackDisplay: fallback.display,
      };
    });
    expect(visual.ring).toContain('conic-gradient');
    expect(visual.statusBackground).toBe('rgba(24, 24, 27, 0.96)');
    expect(visual.statusColor).toBe('rgb(250, 250, 250)');
    expect(visual.statusOpacity).toBe('1');
    expect(visual.hasSvg || visual.fallbackDisplay !== 'none').toBe(true);
    expect(Math.abs(visual.iconCenterOffset.x)).toBeLessThanOrEqual(0.75);
    expect(Math.abs(visual.iconCenterOffset.y)).toBeLessThanOrEqual(0.75);
  } finally {
    await browser.close();
  }
});
