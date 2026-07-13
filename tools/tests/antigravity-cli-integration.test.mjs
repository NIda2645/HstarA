import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mainPath = join(repoRoot, 'main.py');
const mainPy = readFileSync(mainPath, 'utf8');
const apiSettingsHtml = readFileSync(join(repoRoot, 'static', 'api-settings.html'), 'utf8');
const apiSettingsPath = join(repoRoot, 'static', 'js', 'api-settings.js');
const apiSettings = readFileSync(apiSettingsPath, 'utf8');

assert.match(apiSettings, /function isAntigravityPickerMode\(/);
assert.match(apiSettings, /selectedByCategory:\s*\{\s*image:\s*new Set/);
assert.match(apiSettings, /selectedByCategory\.chat/);
assert.match(apiSettings, /selectedByCategory\.image/);
assert.match(apiSettings, /item\.image_models = selected\.image_models/);
assert.match(apiSettings, /item\.chat_models = selected\.chat_models/);
assert.match(apiSettings, /pickerState\.independent[\s\S]*pickerState\.order/);
assert.match(apiSettings, /function syncPickerTabVisibility\([\s\S]*style\.display =/);
assert.match(apiSettings, /function syncPickerTabVisibility\([\s\S]*disabled =/);
assert.match(apiSettings, /syncPickerTabVisibility\(true\)/);
assert.match(apiSettings, /syncPickerTabVisibility\(false\)/);
assert.match(apiSettings, /const ids = pickerState\.independent \? pickerState\.order : Object\.keys\(pickerState\.category\)\.sort\(\);/);
assert.match(apiSettings, /const cat = pickerState\.category\[id\];/);
assert.match(apiSettings, /if\(pickerState\.independent\)\{[\s\S]*return;\s*}\s*const image = \[\], chat = \[\], video = \[\];/);
assert.match(apiSettings, /catch\(e\)\{[\s\S]*alert\('.*拉取失败/);
assert.match(apiSettings, /catch\(e\)\{[\s\S]*setStatus\('.*拉取失败/);
const fetchModelsStart = apiSettings.indexOf('async function fetchModels(){');
const fetchModelsEnd = apiSettings.indexOf('function isAntigravityPickerMode(', fetchModelsStart);
const fetchModelsBlock = apiSettings.slice(fetchModelsStart, fetchModelsEnd);
assert.match(fetchModelsBlock, /storeFetchedPickerState\(data, item\);/);
assert.doesNotMatch(fetchModelsBlock, /item\.(image_models|chat_models|video_models)\s*=/, 'failed fetch must not clear saved model configuration');
assert.equal((apiSettings.match(/storeFetchedPickerState\(data, item\);/g) || []).length, 3);
assert.match(
  apiSettingsHtml,
  /<button class="action-btn" type="button" onclick="openGeminiCliHelp\(\)">[\s\S]*?<button class="action-btn" type="button" onclick="launchGeminiCli\(\)" title="[^"]+">[\s\S]*data-lucide="(?:play|square-terminal)"/,
  'launch must be immediately to the right of Antigravity help',
);
assert.match(apiSettings, /async function launchGeminiCli\(\)/);
const launchFunctionStart = apiSettings.indexOf('async function launchGeminiCli(){');
const launchFunctionEnd = apiSettings.indexOf('function currentProviderApiKey(', launchFunctionStart);
const launchFunctionBlock = apiSettings.slice(launchFunctionStart, launchFunctionEnd);
assert.match(launchFunctionBlock, /fetch\('\/api\/gemini-cli\/launch',\s*\{\s*method:'POST'\s*\}\)/);
assert.match(launchFunctionBlock, /readApiJsonResponse\(/);
assert.match(launchFunctionBlock, /geminiCliInfo\.textContent/);
assert.match(launchFunctionBlock, /alert\(/);

function createPickerHarness() {
  const calls = {
    alerts: [],
    statuses: [],
    renderModels: [],
    renderMsLoras: 0,
    closeModelPicker: 0,
    applyModelPicker: 0,
    openModelPicker: 0,
  };
  const elements = new Map();
  const makeElement = (id = '') => {
    const classes = new Set();
    const attributes = {};
    const count = { textContent: '' };
    const element = {
      id,
      value: '',
      disabled: false,
      style: {},
      dataset: {},
      innerHTML: '',
      textContent: '',
      classList: {
        toggle(name, force) {
          const enabled = force === undefined ? !classes.has(name) : force;
          if (enabled) classes.add(name);
          else classes.delete(name);
          return enabled;
        },
        add(name) { classes.add(name); },
        remove(name) { classes.delete(name); },
        contains(name) { return classes.has(name); },
      },
      addEventListener() {},
      querySelector(selector) {
        if (selector === '.cat-count') return count;
        if (selector === 'span') return { textContent: '' };
        return null;
      },
      querySelectorAll() { return []; },
      setAttribute(name, value) { attributes[name] = String(value); },
      removeAttribute(name) { delete attributes[name]; },
      getAttribute(name) { return attributes[name] ?? null; },
    };
    element.__count = count;
    elements.set(id, element);
    return element;
  };
  const tabs = ['all', 'image', 'chat', 'video'].map((cat) => {
    const tab = makeElement(`tab-${cat}`);
    tab.dataset.cat = cat;
    tab.classList.add('picker-cat-tab');
    return tab;
  });
  const document = {
    body: makeElement('body'),
    getElementById(id) { return elements.get(id) || makeElement(id); },
    querySelectorAll(selector) {
      return selector === '.picker-cat-tab' ? tabs : [];
    },
    querySelector(selector) {
      if (selector === '.picker-cat-tab.active') return tabs.find(tab => tab.classList.contains('active')) || null;
      return null;
    },
    addEventListener() {},
  };
  const window = {
    addEventListener() {},
    parent: { postMessage() {} },
    top: { postMessage() {} },
  };
  const context = {
    console,
    document,
    window,
    fetch() { return Promise.reject(new Error('unexpected fetch')); },
    alert(message) { calls.alerts.push(message); },
    setTimeout,
    clearTimeout,
    __calls: calls,
    __elements: elements,
    __tabs: tabs,
  };
  vm.createContext(context);
  vm.runInContext(`${apiSettings}
renderModels = (...args) => __calls.renderModels.push(args);
renderMsLoras = () => { __calls.renderMsLoras += 1; };
setStatus = message => __calls.statuses.push(message);
closeModelPicker = () => { __calls.closeModelPicker += 1; };
const actualApplyModelPicker = applyModelPicker;
applyModelPicker = (...args) => {
  __calls.applyModelPicker += 1;
  return actualApplyModelPicker(...args);
};
const actualOpenModelPicker = openModelPicker;
openModelPicker = (...args) => {
  __calls.openModelPicker += 1;
  return actualOpenModelPicker(...args);
};
syncEditor = () => {
  const item = provider();
  if (item) item.name = 'Synced editor field';
};
currentProviderApiKey = () => 'test-key';
isRunningHubContext = () => false;
tr = () => '';
isProviderTemporarilyHidden = () => false;
syncRecommendView = () => {};
renderRecommendApi = () => {};
renderEditor = () => {};
this.__pickerApi = {
  hooks: {
    isAntigravityPickerMode,
    buildAntigravityPickerState,
    toggleAntigravityPickerSelection,
    countAntigravityPickerSelections,
    applyAntigravityPickerSelection,
  },
  openModelPicker,
  selectPickerCat,
  selectProvider,
  togglePickerRow,
  applyModelPicker,
  fetchModels,
  launchGeminiCli,
  setProviders(values, id = values[0]?.id) { providers = values; selectedId = id; },
  setProvider(value) { providers = [value]; selectedId = value.id; lastFetchedContextKey = ''; },
  setFetched(value) {
    lastFetchedAll = value;
    lastFetchedSuggestion = null;
    lastFetchedModelProtocols = {};
    lastFetchedContextKey = fetchedPickerContextKey(provider());
  },
  getState() { return pickerState; },
  getElement(id) { return document.getElementById(id); },
  getFetchedContextKey() { return lastFetchedContextKey; },
  setFetch(value) { fetch = value; },
  calls: __calls,
  elements: __elements,
  tabs: __tabs,
};`, context, { filename: apiSettingsPath });
  return context.__pickerApi;
}

const pickerApi = createPickerHarness();
const pickerHooks = pickerApi.hooks;
const initialState = pickerHooks.buildAntigravityPickerState(
  ['Model C', 'Model A', 'Model C'],
  { protocol: 'gemini-cli', image_models: ['Saved Image', 'Model A'], chat_models: ['Saved Chat', 'Model A'] },
);
assert.equal(initialState.independent, true);
assert.deepEqual([...initialState.order], ['Model C', 'Model A', 'Saved Image', 'Saved Chat']);
assert.deepEqual([...initialState.selectedByCategory.image], ['Saved Image', 'Model A']);
assert.deepEqual([...initialState.selectedByCategory.chat], ['Saved Chat', 'Model A']);
assert.deepEqual(
  [...pickerHooks.buildAntigravityPickerState(['Zeta', 'Alpha'], { protocol: 'openai', image_models: [], chat_models: [] }).order],
  ['Zeta', 'Alpha'],
  'stable order must retain fetched Antigravity order rather than sorting it',
);
assert.deepEqual(
  [...pickerHooks.buildAntigravityPickerState(
    ['  Fetched Model  ', 'Same', 'same', '   '],
    { protocol: 'gemini-cli', image_models: [' Saved Image ', 'Same'], chat_models: ['SAME', 'Saved Chat'] },
  ).order],
  ['  Fetched Model  ', 'Same', 'same', ' Saved Image ', 'SAME', 'Saved Chat'],
  'stable order must preserve non-empty model identifiers exactly',
);
assert.equal(pickerHooks.isAntigravityPickerMode({ protocol: 'gemini-cli' }), true);
assert.equal(pickerHooks.isAntigravityPickerMode({ protocol: 'openai' }), false);

const toggledImage = pickerHooks.toggleAntigravityPickerSelection(
  pickerHooks.buildAntigravityPickerState(['Shared'], { protocol: 'gemini-cli', image_models: [], chat_models: ['Shared'] }),
  'image',
  'Shared',
);
assert.equal(toggledImage.selectedByCategory.image.has('Shared'), true);
assert.equal(toggledImage.selectedByCategory.chat.has('Shared'), true, 'image toggles must not change chat selections');
const counts = pickerHooks.countAntigravityPickerSelections(toggledImage);
assert.equal(counts.image, 1);
assert.equal(counts.chat, 1);

const applied = pickerHooks.applyAntigravityPickerSelection(
  toggledImage,
);
assert.deepEqual([...applied.image_models], ['Shared']);
assert.deepEqual([...applied.chat_models], ['Shared']);
assert.deepEqual([...applied.video_models], []);

const antigravityProvider = {
  id: 'gemini-cli',
  protocol: 'gemini-cli',
  image_models: ['Zeta', 'Legacy Image'],
  chat_models: ['Chat Only', 'Legacy Chat'],
  video_models: ['stale-video'],
};
pickerApi.elements.get('protocolInput').value = 'gemini-cli';
pickerApi.setProvider(antigravityProvider);
pickerApi.setFetched(['Zeta', 'Alpha', 'Shared']);
const beforeOpen = JSON.stringify(antigravityProvider);
pickerApi.openModelPicker();

const tabByCategory = Object.fromEntries(pickerApi.tabs.map(tab => [tab.dataset.cat, tab]));
assert.equal(tabByCategory.all.style.display, 'none');
assert.equal(tabByCategory.all.disabled, true);
assert.equal(tabByCategory.all.getAttribute('aria-hidden'), 'true');
assert.equal(tabByCategory.video.style.display, 'none');
assert.equal(tabByCategory.video.disabled, true);
assert.equal(tabByCategory.video.getAttribute('aria-hidden'), 'true');
assert.equal(tabByCategory.image.style.display, '');
assert.equal(tabByCategory.image.disabled, false);
assert.equal(tabByCategory.image.getAttribute('aria-hidden'), 'false');
assert.equal(tabByCategory.chat.style.display, '');
assert.equal(tabByCategory.chat.disabled, false);
assert.equal(tabByCategory.chat.getAttribute('aria-hidden'), 'false');
assert.equal(tabByCategory.image.classList.contains('active'), true);
assert.equal(tabByCategory.chat.classList.contains('active'), false);

let pickerState = pickerApi.getState();
assert.equal(pickerState.independent, true);
assert.deepEqual([...pickerState.order], ['Zeta', 'Alpha', 'Shared', 'Legacy Image', 'Chat Only', 'Legacy Chat']);
assert.deepEqual([...pickerState.selectedByCategory.image], ['Zeta', 'Legacy Image']);
assert.deepEqual([...pickerState.selectedByCategory.chat], ['Chat Only', 'Legacy Chat']);
assert.equal(JSON.stringify(antigravityProvider), beforeOpen, 'opening must not mutate provider configuration');

pickerApi.selectPickerCat('chat');
const imageBeforeChatToggle = [...pickerApi.getState().selectedByCategory.image];
pickerApi.togglePickerRow('Zeta');
pickerState = pickerApi.getState();
assert.equal(JSON.stringify([...pickerState.selectedByCategory.image]), JSON.stringify(imageBeforeChatToggle));
assert.equal(pickerState.selectedByCategory.chat.has('Zeta'), true, 'one model may be selected for both channels');
assert.equal(JSON.stringify(antigravityProvider), beforeOpen, 'toggling must not mutate provider configuration');

pickerApi.applyModelPicker();
assert.equal(JSON.stringify(antigravityProvider.image_models), JSON.stringify(['Zeta', 'Legacy Image']));
assert.equal(JSON.stringify(antigravityProvider.chat_models), JSON.stringify(['Zeta', 'Chat Only', 'Legacy Chat']));
assert.equal(JSON.stringify(antigravityProvider.video_models), JSON.stringify([]));
assert.equal(JSON.stringify(pickerApi.calls.renderModels.map(args => [...args])), JSON.stringify([['image'], ['chat'], ['video']]));
assert.equal(pickerApi.calls.renderMsLoras, 1);
assert.equal(pickerApi.calls.statuses.length, 1);
assert.equal(pickerApi.calls.closeModelPicker, 1);

const normalProvider = {
  id: 'normal-provider',
  protocol: 'openai',
  image_models: ['Saved Image'],
  chat_models: ['Saved Chat'],
  video_models: ['Saved Video'],
};
pickerApi.setProviders([antigravityProvider, normalProvider], antigravityProvider.id);
pickerApi.setFetched(['A stale model']);
const openPickerButton = pickerApi.getElement('openPickerBtn');
pickerApi.elements.get('protocolInput').value = 'openai';
pickerApi.selectProvider(normalProvider.id);
assert.equal(openPickerButton.disabled, true);
assert.equal(openPickerButton.style.opacity, '0.55');
const staleAlertCount = pickerApi.calls.alerts.length;
const staleOpenCalls = pickerApi.calls.openModelPicker;
pickerApi.openModelPicker();
assert.equal(pickerApi.calls.openModelPicker, staleOpenCalls + 1);
assert.equal(pickerApi.calls.alerts.length, staleAlertCount + 1);
assert.equal(pickerApi.getFetchedContextKey(), '');

pickerApi.elements.get('baseInput').value = normalProvider.base_url || 'https://normal.example/v1';
pickerApi.setFetch(() => Promise.resolve({
  ok: true,
  text: async () => JSON.stringify({
    all: ['Normal First', 'Normal Second'],
    image_models: [],
    chat_models: [],
    video_models: [],
    total: 2,
  }),
}));
await pickerApi.fetchModels();
assert.equal(openPickerButton.disabled, false);
assert.equal(openPickerButton.style.opacity, '1');
assert.deepEqual(
  [...pickerApi.getState().order],
  ['Normal First', 'Normal Second', 'Saved Image', 'Saved Chat', 'Saved Video'],
);
assert.equal(pickerApi.getFetchedContextKey(), 'normal-provider::openai');
assert.equal(tabByCategory.all.style.display, '');
assert.equal(tabByCategory.all.disabled, false);
assert.equal(tabByCategory.all.getAttribute('aria-hidden'), 'false');
assert.equal(tabByCategory.video.style.display, '');
assert.equal(tabByCategory.video.disabled, false);
assert.equal(tabByCategory.video.getAttribute('aria-hidden'), 'false');
assert.equal(tabByCategory.image.style.display, '');
assert.equal(tabByCategory.image.getAttribute('aria-hidden'), 'false');
assert.equal(tabByCategory.chat.style.display, '');
assert.equal(tabByCategory.chat.getAttribute('aria-hidden'), 'false');
assert.equal(tabByCategory.all.classList.contains('active'), true);
assert.equal(tabByCategory.image.classList.contains('active'), false);
pickerState = pickerApi.getState();
assert.equal(pickerState.independent, false);
assert.equal(pickerState.category['Saved Image'], 'image');
assert.equal(pickerState.category['Saved Chat'], 'chat');
assert.equal(pickerState.selected['Saved Image'], true);
assert.equal(pickerState.selected['Saved Chat'], true);
assert.equal(pickerState.selected['Normal First'], false);

const mismatchedProvider = { id: 'mismatched-provider', protocol: 'openai', image_models: [], chat_models: [], video_models: [] };
pickerApi.setProviders([normalProvider, mismatchedProvider], normalProvider.id);
pickerApi.setFetched(['Normal stale model']);
openPickerButton.disabled = false;
openPickerButton.style.opacity = '1';
pickerApi.setProviders([normalProvider, mismatchedProvider], mismatchedProvider.id);
const mismatchAlertCount = pickerApi.calls.alerts.length;
pickerApi.openModelPicker();
assert.equal(pickerApi.calls.alerts.length, mismatchAlertCount + 1);
assert.equal(pickerApi.getFetchedContextKey(), '');
assert.equal(openPickerButton.disabled, true);

const failedProvider = {
  id: 'failed-provider',
  protocol: 'openai',
  base_url: 'https://example.test/v1',
  image_models: ['Keep Image'],
  chat_models: ['Keep Chat'],
  video_models: ['Keep Video'],
};
pickerApi.elements.get('protocolInput').value = 'openai';
pickerApi.elements.get('baseInput').value = failedProvider.base_url;
pickerApi.setProvider(failedProvider);
const beforeFailedModels = JSON.stringify({
  image_models: failedProvider.image_models,
  chat_models: failedProvider.chat_models,
  video_models: failedProvider.video_models,
});
const applyCallsBeforeFailedFetch = pickerApi.calls.applyModelPicker;
const openCallsBeforeFailedFetch = pickerApi.calls.openModelPicker;
pickerApi.setFetch(() => Promise.reject(new Error('network down')));
await pickerApi.fetchModels();
assert.equal(failedProvider.name, 'Synced editor field');
assert.equal(JSON.stringify({
  image_models: failedProvider.image_models,
  chat_models: failedProvider.chat_models,
  video_models: failedProvider.video_models,
}), beforeFailedModels, 'failed fetch must preserve saved channels byte-for-byte');
assert.equal(pickerApi.calls.applyModelPicker, applyCallsBeforeFailedFetch);
assert.equal(pickerApi.calls.openModelPicker, openCallsBeforeFailedFetch);

const launchInfo = pickerApi.getElement('geminiCliInfo');
const launchFetchCalls = [];
pickerApi.setFetch((url, options) => {
  launchFetchCalls.push([url, options]);
  return Promise.resolve({
    ok: true,
    text: async () => JSON.stringify({ ok: true, pid: 4321, message: '已启动 Antigravity CLI 交互终端。' }),
  });
});
await pickerApi.launchGeminiCli();
assert.equal(launchFetchCalls[0][0], '/api/gemini-cli/launch');
assert.equal(launchFetchCalls[0][1].method, 'POST');
assert.equal(launchInfo.textContent, '已启动 Antigravity CLI 交互终端。');

pickerApi.setFetch(() => Promise.resolve({
  ok: false,
  text: async () => JSON.stringify({ detail: '仅支持 Windows。' }),
}));
const launchAlertCount = pickerApi.calls.alerts.length;
await pickerApi.launchGeminiCli();
assert.equal(launchInfo.textContent, '仅支持 Windows。');
assert.equal(pickerApi.calls.alerts.length, launchAlertCount + 1);
assert.equal(pickerApi.calls.alerts.at(-1), '仅支持 Windows。');

const pythonEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};
const bundledCandidates = process.platform === 'win32'
  ? [join(repoRoot, 'python', 'python.exe')]
  : [join(repoRoot, 'python', 'bin', 'python3'), join(repoRoot, 'python', 'bin', 'python')];
const configuredPython = String(process.env.PYTHON || '').trim();
const fallbackCandidates = process.platform === 'win32'
  ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
  : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
const pythonCandidates = [
  ...bundledCandidates.filter(existsSync).map((command) => ({ command, args: [] })),
  ...(configuredPython ? [{ command: configuredPython, args: [] }] : []),
  ...fallbackCandidates,
];
const probeFailures = [];
let python;
for (const candidate of pythonCandidates) {
  const probe = spawnSync(
    candidate.command,
    [...candidate.args, '-X', 'utf8', '-c', 'import os, sys; sys.path.insert(0, os.getcwd()); import main'],
    { cwd: repoRoot, encoding: 'utf8', env: pythonEnv, timeout: 20_000 },
  );
  if (!probe.error && probe.status === 0) {
    python = candidate;
    break;
  }
  probeFailures.push(
    `${candidate.command}: ${probe.error?.message || probe.stderr || `exit ${probe.status}`}`.trim(),
  );
}

assert.ok(
  python,
  `No usable Python interpreter could import main and its dependencies:\n${probeFailures.join('\n')}`,
);

const backendHarness = String.raw`
import asyncio
import copy
import json
import os
import sys
import time
from unittest.mock import patch
import inspect
from types import SimpleNamespace

sys.path.insert(0, os.getcwd())

from fastapi import HTTPException

import main

sample = (
    "\x1b[32mModel Zeta (High)\x1b[0m\r\n"
    "\r\n"
    "Available Models:\r\n"
    "Model Alpha\x07\r\n"
    "\x1b[1mModel Zeta (High)\x1b[0m\r\n"
    "Model Beta\r\n"
    "Model Alpha\r\n"
    "Model Gamma\r\n"
)
expected = [
    "Model Zeta (High)",
    "Model Alpha",
    "Model Beta",
    "Model Gamma",
]

assert main.gemini_cli_parse_models_output(sample) == expected

sanitized = main.gemini_cli_parse_models_output(
    "模型 Alpha\t (Thinking)\r\n"
    "\x1b]0;temporary title\x07Gemini Pro (High)\r\n"
    "\x1b]2;secondary title\x1b\\Claude Sonnet 4.6 (Thinking)\r\n"
    "Gemini Pro (High)\r\n"
)
assert sanitized == [
    "模型 Alpha (Thinking)",
    "Gemini Pro (High)",
    "Claude Sonnet 4.6 (Thinking)",
], sanitized

terminal_controls = main.gemini_cli_parse_models_output(
    "\x9b31m8-bit CSI Model (High)\x9b0m\r\n"
    "\x1bPprivate DCS payload\x1b\\DCS Model (One)\r\n"
    "\x90private 8-bit DCS payload\x1b\\DCS Model (Two)\r\n"
    "\x1bXprivate SOS payload\x1b\\SOS Model\r\n"
    "\x9eprivate PM payload\x9cPM Model\r\n"
    "\x1b_private APC payload\x1b\\APC Model\r\n"
    "\x9dprivate OSC title\x9cOSC Model\r\n"
    "NEL First\x85NEL Second\r\n"
    "模型\u00a0Pro  (Thinking)\r\n"
    "\x1b]unterminated title and hidden payload"
)
assert terminal_controls == [
    "8-bit CSI Model (High)",
    "DCS Model (One)",
    "DCS Model (Two)",
    "SOS Model",
    "PM Model",
    "APC Model",
    "OSC Model",
    "NEL First",
    "NEL Second",
    "模型\u00a0Pro  (Thinking)",
], terminal_controls

assert main.gemini_cli_parse_models_output(
    "\x1bPpayload with BEL \x07 still hidden\x1b\\DCS Visible\r\n"
    "\x1bXunterminated SOS hidden"
) == ["DCS Visible"]

adversarial = "\x1b]" * 100_000
started = time.perf_counter()
assert main.gemini_cli_parse_models_output(adversarial) == []
assert time.perf_counter() - started < 5.0

legacy_raw = {"status": {"installed": True}}
for legacy_payload in (
    main.gemini_cli_models_payload(legacy_raw),
    main.gemini_cli_models_payload(raw=legacy_raw),
):
    assert legacy_payload["raw"] == legacy_raw
    assert legacy_payload["image_models"] == main.GEMINI_CLI_DEFAULT_IMAGE_MODELS
    assert legacy_payload["chat_models"] == main.GEMINI_CLI_DEFAULT_CHAT_MODELS
    assert legacy_payload["all"] == ["auto"]
    assert legacy_payload["total"] == 1
    assert "status" not in legacy_payload["all"]

for count in (1, 4, 9):
    dynamic = [f"Dynamic Model {index}" for index in range(count)]
    parsed = main.gemini_cli_parse_models_output("\r\n".join(dynamic))
    assert parsed == dynamic
    payload = main.gemini_cli_discovered_models_payload(parsed)
    assert payload["total"] == count
    assert payload["model_count"] == count


class FakeProcess:
    def __init__(self, stdout=b"", stderr=b"", returncode=0, delay=0, drain_failure=False):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode
        self.delay = delay
        self.killed = False
        self.waited = False
        self.communicate_calls = 0
        self.drain_failure = drain_failure

    async def communicate(self):
        self.communicate_calls += 1
        if self.communicate_calls > 1 and self.drain_failure:
            raise RuntimeError("drain failed")
        if self.delay:
            await asyncio.sleep(self.delay)
        return self.stdout, self.stderr

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        self.waited = True
        return self.returncode


async def discover_with(process, timeout=main.GEMINI_CLI_MODELS_TIMEOUT):
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return process

    with patch.object(main, "gemini_cli_executable", return_value="agy.exe"):
        with patch.object(main.asyncio, "create_subprocess_exec", side_effect=fake_exec):
            result = await main.discover_gemini_cli_models(timeout=timeout)
    assert len(calls) == 1
    args, kwargs = calls[0]
    assert list(args) == ["agy.exe", "models"]
    assert kwargs["cwd"] == main.BASE_DIR
    assert kwargs["stdout"] is asyncio.subprocess.PIPE
    assert kwargs["stderr"] is asyncio.subprocess.PIPE
    return result


async def discover_with_real_sleeping_process(timeout=0.01):
    real_create_subprocess_exec = asyncio.create_subprocess_exec
    captured = {}

    async def real_exec(*args, **kwargs):
        captured["process"] = await real_create_subprocess_exec(
            sys.executable,
            "-c",
            "import time; time.sleep(30)",
            **kwargs,
        )
        return captured["process"]

    with patch.object(main, "gemini_cli_executable", return_value="agy.exe"):
        with patch.object(main.asyncio, "create_subprocess_exec", side_effect=real_exec):
            started = time.perf_counter()
            try:
                await main.discover_gemini_cli_models(timeout=timeout)
            except HTTPException as exc:
                timeout_error = exc
            else:
                raise AssertionError("Expected HTTP 504")
            elapsed = time.perf_counter() - started

    assert timeout_error.status_code == 504
    assert elapsed < max(timeout + (main.GEMINI_CLI_CLEANUP_TIMEOUT * 2) + 1.0, 3.0), elapsed
    process = captured["process"]
    assert process.returncode is not None
    assert await process.wait() == process.returncode
    if os.name != "nt":
        try:
            os.waitpid(process.pid, os.WNOHANG)
        except ChildProcessError:
            pass
        else:
            raise AssertionError("timed-out child was not reaped")


async def expect_http_error(process, status_code, timeout=main.GEMINI_CLI_MODELS_TIMEOUT):
    try:
        await discover_with(process, timeout=timeout)
    except HTTPException as exc:
        assert exc.status_code == status_code
        assert "保留原有模型配置" in str(exc.detail)
        return exc
    raise AssertionError(f"Expected HTTP {status_code}")


async def run_cli_with_capture(prompt, model, allow_tools=False, delay=0):
    calls = []

    async def fake_exec(*args, **kwargs):
        calls.append((args, kwargs))
        return FakeProcess(delay=delay)

    with patch.object(main, "gemini_cli_executable", return_value="agy.exe"):
        with patch.object(main.asyncio, "create_subprocess_exec", side_effect=fake_exec):
            with patch.object(main.logging, "info") as info:
                await main.run_gemini_cli(prompt, model=model, timeout=30, allow_tools=allow_tools)
    return calls, info


async def run():
    success = FakeProcess(stdout=sample.encode("utf-8"))
    payload = await discover_with(success)
    assert payload["all"] == expected
    assert payload["image_models"] == expected
    assert payload["chat_models"] == expected
    assert payload["total"] == len(expected)
    assert payload["model_count"] == len(expected)
    assert payload["raw"] == {}

    non_zero = FakeProcess(stderr="模型命令失败".encode("utf-8"), returncode=7)
    non_zero_error = await expect_http_error(non_zero, 502)
    assert "拉取模型失败" in str(non_zero_error.detail)
    assert "exit=7" in str(non_zero_error.detail)

    secret = FakeProcess(
        stderr=b"Authorization: Bearer super-secret-token password=hidden-value " + b"x" * 5000,
        returncode=23,
    )
    secret_error = await expect_http_error(secret, 502)
    assert "super-secret-token" not in str(secret_error.detail)
    assert "hidden-value" not in str(secret_error.detail)
    assert len(str(secret_error.detail)) <= 1200

    empty = FakeProcess(stdout=b"\x1b[32mAvailable Models:\x1b[0m\r\n\r\n")
    empty_error = await expect_http_error(empty, 502)
    assert "未返回可用模型" in str(empty_error.detail)

    timed_out = FakeProcess(delay=0.1, returncode=None)
    timeout_error = await expect_http_error(timed_out, 504, timeout=0.001)
    assert "拉取模型超时" in str(timeout_error.detail)
    assert timed_out.killed
    assert timed_out.waited

    await discover_with_real_sleeping_process()

    cleanup_failure = FakeProcess(delay=0.1, returncode=None, drain_failure=True)
    with patch.object(main.logging, "warning") as warning:
        timeout_error = await expect_http_error(cleanup_failure, 504, timeout=0.001)
    assert timeout_error.status_code == 504
    assert warning.called

    discovered_payload = main.gemini_cli_discovered_models_payload(
        ["Live Chat Model", "Live Image Model"],
        raw={"source": "agy models"},
    )
    discovery_calls = 0

    async def fake_discover():
        nonlocal discovery_calls
        discovery_calls += 1
        return discovered_payload

    with patch.object(main, "discover_gemini_cli_models", side_effect=fake_discover):
        tested = await main.test_provider_connection(main.TestConnectionPayload(protocol="gemini-cli"))
        fetched = await main.fetch_models_from_upstream("", "", "gemini-cli")
    assert discovery_calls == 2
    assert tested["all"] == discovered_payload["all"]
    assert fetched["all"] == discovered_payload["all"]
    assert tested["raw"] == {"source": "agy models"}

    exact_model = "Claude Sonnet 4.6 (Thinking)"
    calls, info = await run_cli_with_capture(
        "private prompt Authorization: Bearer super-secret-token",
        exact_model,
        allow_tools=True,
    )
    args = list(calls[0][0])
    assert args[args.index("--model") + 1] == exact_model
    assert args.count(exact_model) == 1
    assert info.call_args.args == ("Antigravity CLI request model=%s tools=%s", exact_model, True)
    assert "private prompt" not in repr(info.call_args)
    assert "super-secret-token" not in repr(info.call_args)

    concurrent_calls = []

    async def concurrent_exec(*args, **kwargs):
        concurrent_calls.append(list(args))
        return FakeProcess(delay=0.01)

    with patch.object(main, "gemini_cli_executable", return_value="agy.exe"):
        with patch.object(main.asyncio, "create_subprocess_exec", side_effect=concurrent_exec):
            await asyncio.gather(
                main.run_gemini_cli("prompt one", model="Model One", timeout=30),
                main.run_gemini_cli("prompt two", model="Model Two", timeout=30),
            )
    assert len(concurrent_calls) == 2
    expected_concurrent_requests = {
        "prompt one": "Model One",
        "prompt two": "Model Two",
    }
    observed_concurrent_requests = {}
    for args in concurrent_calls:
        assert args.count("--model") == 1
        assert args.count("-p") == 1
        model_index = args.index("--model") + 1
        prompt_index = args.index("-p") + 1
        captured_model = args[model_index]
        captured_prompt = args[prompt_index]
        assert captured_prompt in expected_concurrent_requests
        assert captured_model == expected_concurrent_requests[captured_prompt]
        assert captured_prompt not in observed_concurrent_requests
        observed_concurrent_requests[captured_prompt] = captured_model
    assert observed_concurrent_requests == expected_concurrent_requests

    provider = {
        "id": "gemini-cli",
        "protocol": "gemini-cli",
        "image_models": ["Current Image"],
        "chat_models": ["Current Chat"],
    }
    def assert_model_warning(provider_value, model_value, channel, expected):
        provider_before = copy.deepcopy(provider_value)
        model_before = model_value
        with patch.object(main.logging, "warning") as warning:
            result = main.warn_unlisted_gemini_cli_model(provider_value, model_value, channel)
        assert result is None
        assert provider_value == provider_before
        assert model_value == model_before
        if expected:
            assert warning.call_count == 1
            assert warning.call_args.args == (
                "Antigravity CLI using saved canvas model outside current %s list: %s",
                channel,
                model_value,
            )
        else:
            warning.assert_not_called()

    assert_model_warning(provider, "auto", "image", expected=False)
    assert_model_warning(
        {**provider, "image_models": []},
        "Legacy Image",
        "image",
        expected=False,
    )
    assert_model_warning(provider, "Current Image", "image", expected=False)
    assert_model_warning(provider, "Legacy Image", "image", expected=True)

    image_calls = []

    async def fake_image(*args):
        image_calls.append(args)
        return {"image": "ok"}

    with patch.object(main, "get_api_provider", return_value=provider):
        with patch.object(main, "warn_unlisted_gemini_cli_model") as warn_image:
            with patch.object(main, "generate_gemini_cli_provider_image", side_effect=fake_image):
                image_result = await main.generate_ai_image(
                    "image prompt", "1024x1024", "standard", "Legacy Image", [], "gemini-cli"
                )
    assert image_result == {"image": "ok"}
    assert image_calls[0][2] == "Legacy Image"
    assert warn_image.call_args.args == (provider, "Legacy Image", "image")

    chat_calls = []

    async def fake_chat(payload, history):
        chat_calls.append((payload, history))
        return "reply", {"text": "reply"}

    canvas_payload = main.CanvasLLMRequest(
        message="canvas message",
        model="Legacy Chat",
        provider="gemini-cli",
    )
    with patch.object(main, "get_api_provider", return_value=provider):
        with patch.object(main, "warn_unlisted_gemini_cli_model") as warn_chat:
            with patch.object(main, "gemini_cli_chat_text", side_effect=fake_chat):
                canvas_result = await main.canvas_llm(canvas_payload)
    assert canvas_result["text"] == "reply"
    assert canvas_result["model"] == "Legacy Chat"
    assert chat_calls[0][0].model == "Legacy Chat"
    assert warn_chat.call_args.args == (provider, "Legacy Chat", "chat")

    signature = inspect.signature(main.launch_gemini_cli)
    assert list(signature.parameters) == ["request"]
    assert signature.parameters["request"].annotation is main.Request

    class FakeLaunchedProcess:
        pid = 4321

    request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))
    agy = r"C:\\Users\\test\\agy.exe"
    powershell = r"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
    original_environment = dict(os.environ)
    with patch.object(main.os, "name", "nt"):
        with patch.object(main, "gemini_cli_executable", return_value=agy):
            with patch.object(main, "is_antigravity_cli", return_value=True):
                with patch.object(main.shutil, "which", side_effect=lambda name: powershell if name == "powershell.exe" else None):
                    with patch.object(main.subprocess, "CREATE_NEW_CONSOLE", 0x10, create=True):
                        with patch.object(main.subprocess, "Popen", return_value=FakeLaunchedProcess()) as popen:
                            result = await main.launch_gemini_cli(request)
    assert result == {"ok": True, "pid": 4321, "message": "已启动 Antigravity CLI 交互终端。"}
    popen.assert_called_once()
    args, kwargs = popen.call_args
    assert list(args[0]) == [
        powershell,
        "-NoLogo",
        "-NoExit",
        "-Command",
        "& $env:HSTARA_ANTIGRAVITY_LAUNCH_EXE",
    ]
    assert kwargs["cwd"] == main.BASE_DIR
    assert kwargs["creationflags"] == 0x10
    assert "shell" not in kwargs or kwargs["shell"] is False
    assert kwargs["env"] is not os.environ
    assert kwargs["env"] == {**original_environment, "HSTARA_ANTIGRAVITY_LAUNCH_EXE": agy}
    assert not hasattr(request, "command")

    with patch.object(main.os, "name", "nt"):
        with patch.object(main, "gemini_cli_executable", return_value=agy):
            with patch.object(main, "is_antigravity_cli", return_value=True):
                with patch.object(main.shutil, "which", return_value=powershell):
                    with patch.object(main.subprocess, "CREATE_NEW_CONSOLE", 0x10, create=True):
                        with patch.object(main.subprocess, "Popen", return_value=FakeLaunchedProcess()) as independent_popen:
                            await main.launch_gemini_cli(request)
                            await main.launch_gemini_cli(request)
    assert independent_popen.call_count == 2, "each click must launch an independent session"

    for host in ("::1", "localhost"):
        local_request = SimpleNamespace(client=SimpleNamespace(host=host))
        with patch.object(main.os, "name", "nt"):
            with patch.object(main, "gemini_cli_executable", return_value=agy):
                with patch.object(main, "is_antigravity_cli", return_value=True):
                    with patch.object(main.shutil, "which", return_value=powershell):
                        with patch.object(main.subprocess, "CREATE_NEW_CONSOLE", 0x10, create=True):
                            with patch.object(main.subprocess, "Popen", return_value=FakeLaunchedProcess()) as local_popen:
                                local_result = await main.launch_gemini_cli(local_request)
        assert local_result["ok"] is True
        local_popen.assert_called_once()

    with patch.object(main.subprocess, "Popen") as remote_popen:
        try:
            await main.launch_gemini_cli(SimpleNamespace(client=SimpleNamespace(host="192.168.1.8")))
        except HTTPException as exc:
            assert exc.status_code == 403
        else:
            raise AssertionError("remote clients must be rejected")
    remote_popen.assert_not_called()

    with patch.object(main.os, "name", "posix"):
        try:
            await main.launch_gemini_cli(request)
        except HTTPException as exc:
            assert exc.status_code == 400
            assert "Windows" in str(exc.detail)
        else:
            raise AssertionError("non-Windows clients must be rejected")

    with patch.object(main.os, "name", "nt"):
        with patch.object(main, "gemini_cli_executable", return_value=""):
            try:
                await main.launch_gemini_cli(request)
            except HTTPException as exc:
                assert exc.status_code == 400
                assert "Antigravity CLI" in str(exc.detail)
            else:
                raise AssertionError("missing agy must be rejected")

        with patch.object(main, "gemini_cli_executable", return_value="gemini.exe"):
            with patch.object(main, "is_antigravity_cli", return_value=False):
                try:
                    await main.launch_gemini_cli(request)
                except HTTPException as exc:
                    assert exc.status_code == 400
                    assert "Antigravity" in str(exc.detail)
                else:
                    raise AssertionError("non-agy executables must be rejected")

        with patch.object(main, "gemini_cli_executable", return_value=agy):
            with patch.object(main, "is_antigravity_cli", return_value=True):
                with patch.object(main.shutil, "which", return_value=None):
                    try:
                        await main.launch_gemini_cli(request)
                    except HTTPException as exc:
                        assert exc.status_code == 400
                        assert "powershell.exe" in str(exc.detail)
                    else:
                        raise AssertionError("missing PowerShell must be rejected")

        with patch.object(main, "gemini_cli_executable", return_value=agy):
            with patch.object(main, "is_antigravity_cli", return_value=True):
                with patch.object(main.shutil, "which", return_value=powershell):
                    with patch.object(main.subprocess, "CREATE_NEW_CONSOLE", 0x10, create=True):
                        with patch.object(main.subprocess, "Popen", side_effect=OSError("launch failed")):
                            try:
                                await main.launch_gemini_cli(request)
                            except HTTPException as exc:
                                assert exc.status_code == 500
                                assert "启动" in str(exc.detail)
                            else:
                                raise AssertionError("Popen failures must be reported")


asyncio.run(run())
print(json.dumps({"ok": True}))
`;

const backend = spawnSync(python.command, [...python.args, '-X', 'utf8', '-c', backendHarness], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: pythonEnv,
  timeout: 60_000,
});

assert.ok(!backend.error, `Python harness failed to launch: ${backend.error?.message}`);
assert.equal(backend.status, 0, backend.stderr || backend.stdout);
assert.match(backend.stdout, /"ok": true/);
assert.match(mainPy, /async def discover_gemini_cli_models\(/);
assert.match(mainPy, /def gemini_cli_models_payload\(raw=None\):/);
assert.match(mainPy, /def gemini_cli_discovered_models_payload\(models, raw=None\):/);

console.log('Antigravity CLI integration tests passed');
