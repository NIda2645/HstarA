import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mainPath = join(repoRoot, 'main.py');
const mainPy = readFileSync(mainPath, 'utf8');
const python = join(repoRoot, 'python', 'python.exe');
const dependencyPath = [
  join(repoRoot, 'python', 'Lib', 'site-packages'),
  join(repoRoot, '..', '..', 'python', 'Lib', 'site-packages'),
].find(existsSync);

assert.ok(existsSync(python), `Bundled Python was not found at ${python}`);
assert.ok(dependencyPath, 'Bundled Python dependencies were not found');

const backendHarness = String.raw`
import asyncio
import json
import os
import sys
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])
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

for count in (1, 4, 9):
    dynamic = [f"Dynamic Model {index}" for index in range(count)]
    parsed = main.gemini_cli_parse_models_output("\r\n".join(dynamic))
    assert parsed == dynamic
    payload = main.gemini_cli_models_payload(parsed)
    assert payload["total"] == count
    assert payload["model_count"] == count


class FakeProcess:
    def __init__(self, stdout=b"", stderr=b"", returncode=0, delay=0):
        self.stdout = stdout
        self.stderr = stderr
        self.returncode = returncode
        self.delay = delay
        self.killed = False
        self.waited = False

    async def communicate(self):
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

    non_zero = FakeProcess(stderr="模型命令失败".encode("utf-8"), returncode=7)
    non_zero_error = await expect_http_error(non_zero, 502)
    assert "拉取模型失败" in str(non_zero_error.detail)

    empty = FakeProcess(stdout=b"\x1b[32mAvailable Models:\x1b[0m\r\n\r\n")
    empty_error = await expect_http_error(empty, 502)
    assert "未返回可用模型" in str(empty_error.detail)

    timed_out = FakeProcess(delay=0.1, returncode=None)
    timeout_error = await expect_http_error(timed_out, 504, timeout=0.001)
    assert "拉取模型超时" in str(timeout_error.detail)
    assert timed_out.killed
    assert timed_out.waited


asyncio.run(run())
print(json.dumps({"ok": True}))
`;

const backend = spawnSync(python, ['-X', 'utf8', '-c', backendHarness, dependencyPath], {
  cwd: repoRoot,
  encoding: 'utf8',
  env: {
    ...process.env,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
  },
});

assert.ok(!backend.error, backend.error?.message);
assert.equal(backend.status, 0, backend.stderr || backend.stdout);
assert.match(backend.stdout, /"ok": true/);
assert.match(mainPy, /async def discover_gemini_cli_models\(/);
assert.doesNotMatch(mainPy, /模型列表使用 auto 默认模型/);

console.log('Antigravity CLI integration tests passed');
