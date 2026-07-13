import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mainPath = join(repoRoot, 'main.py');
const mainPy = readFileSync(mainPath, 'utf8');
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
