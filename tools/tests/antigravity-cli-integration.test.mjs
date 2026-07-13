import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import vm from 'node:vm';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mainPath = join(repoRoot, 'main.py');
const mainPy = readFileSync(mainPath, 'utf8');
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
assert.match(fetchModelsBlock, /lastFetchedAll = data\.all \|\| \[\];/);
assert.doesNotMatch(fetchModelsBlock, /item\.(image_models|chat_models|video_models)\s*=/, 'failed fetch must not clear saved model configuration');

function createPickerVm() {
  const makeElement = (id = '') => ({
    id,
    value: '',
    style: {},
    dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    setAttribute() {},
    removeAttribute() {},
  });
  const document = {
    body: makeElement('body'),
    getElementById: makeElement,
    querySelectorAll() { return []; },
    addEventListener() {},
  };
  const window = {
    addEventListener() {},
    parent: { postMessage() {} },
    top: { postMessage() {} },
  };
  const context = { console, document, window, fetch() {}, setTimeout, clearTimeout };
  vm.createContext(context);
  vm.runInContext(`${apiSettings}\nthis.__pickerHooks = {\n  isAntigravityPickerMode,\n  buildAntigravityPickerState,\n  toggleAntigravityPickerSelection,\n  countAntigravityPickerSelections,\n  applyAntigravityPickerSelection,\n};`, context, { filename: apiSettingsPath });
  return context.__pickerHooks;
}

const pickerHooks = createPickerVm();
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
