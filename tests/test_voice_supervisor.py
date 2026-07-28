import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from voice_assistant.supervisor import (
    VoiceServiceSupervisor,
    sanitized_child_env,
    service_command,
)


class FakeClock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class VoiceSupervisorTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.runtime_site = root / "runtime" / "site-packages"
        self.model_path = root / "model"
        self.runtime_site.mkdir(parents=True)
        self.model_path.mkdir(parents=True)
        self.clock = FakeClock()
        self.supervisor = VoiceServiceSupervisor(
            python_executable=sys.executable,
            runtime_site=self.runtime_site,
            model_path=self.model_path,
            test_mode=True,
            clock=self.clock,
            warm_idle_seconds=600,
        )

    async def asyncTearDown(self):
        await self.supervisor.shutdown()
        self.temporary.cleanup()

    async def test_concurrent_start_reuses_one_process(self):
        first, second = await asyncio.gather(
            self.supervisor.ensure_ready(),
            self.supervisor.ensure_ready(),
        )

        self.assertEqual(first.port, second.port)
        self.assertEqual(first.process_id, second.process_id)
        self.assertEqual(self.supervisor.start_count, 1)

    async def test_authenticated_connection_loads_fake_model(self):
        endpoint = await self.supervisor.ensure_ready()

        connection = await self.supervisor.connect(endpoint, "session-1")
        await connection.send_json({"type": "load", "device": "cpu"})
        event = await connection.receive_event()
        await connection.close()

        self.assertEqual(event["type"], "loaded")
        self.assertEqual(event["device"], "cpu")

    async def test_idle_timeout_unloads_model_but_keeps_supervisor_usable(self):
        endpoint = await self.supervisor.ensure_ready()
        connection = await self.supervisor.connect(endpoint, "session-1")
        await connection.send_json({"type": "load", "device": "cpu"})
        await connection.receive_event()
        await connection.close()
        await self.supervisor.session_finished()
        self.clock.advance(600)

        await self.supervisor.reap_idle()

        self.assertEqual(self.supervisor.status().model_state, "unloaded")
        self.assertEqual((await self.supervisor.ensure_ready()).port, endpoint.port)

    async def test_shutdown_terminates_child(self):
        endpoint = await self.supervisor.ensure_ready()

        await self.supervisor.shutdown()

        self.assertFalse(self.supervisor.is_running())
        self.assertGreater(endpoint.process_id, 0)

    async def test_early_child_exit_reports_stderr_diagnostics(self):
        process = SimpleNamespace(
            pid=4321,
            returncode=1,
            stdout=SimpleNamespace(readline=AsyncMock(return_value=b"")),
            stderr=SimpleNamespace(
                read=AsyncMock(side_effect=(b"startup failed\n", b""))
            ),
            wait=AsyncMock(return_value=1),
        )

        with patch(
            "voice_assistant.supervisor.asyncio.create_subprocess_exec",
            new=AsyncMock(return_value=process),
        ):
            with self.assertRaisesRegex(RuntimeError, "startup failed"):
                await self.supervisor.ensure_ready()

        self.assertIn("startup failed", self.supervisor.status().last_error)

    async def test_early_child_exit_drains_stderr_while_waiting_for_process(self):
        stderr_read_started = asyncio.Event()
        stderr_chunks = iter((b"x" * (64 * 1024), b"final diagnostic\n", b""))

        async def wait_for_stderr_reader():
            await asyncio.wait_for(stderr_read_started.wait(), timeout=0.1)
            return 1

        async def read_stderr_chunk(_limit=-1):
            stderr_read_started.set()
            return next(stderr_chunks)

        process = SimpleNamespace(
            pid=4322,
            returncode=1,
            stdout=SimpleNamespace(readline=AsyncMock(return_value=b"")),
            stderr=SimpleNamespace(read=read_stderr_chunk),
            wait=AsyncMock(side_effect=wait_for_stderr_reader),
        )

        with patch(
            "voice_assistant.supervisor.asyncio.create_subprocess_exec",
            new=AsyncMock(return_value=process),
        ):
            with self.assertRaisesRegex(RuntimeError, "final diagnostic"):
                await self.supervisor.ensure_ready()

        self.assertTrue(stderr_read_started.is_set())

    async def test_stdout_eof_from_live_child_is_bounded_and_terminated(self):
        terminated = asyncio.Event()

        async def wait_until_terminated():
            await terminated.wait()
            return 1

        process = SimpleNamespace(
            pid=4323,
            returncode=None,
            stdout=SimpleNamespace(readline=AsyncMock(return_value=b"")),
            stderr=SimpleNamespace(read=AsyncMock(return_value=b"stdout closed unexpectedly\n")),
            wait=AsyncMock(side_effect=wait_until_terminated),
        )

        def terminate():
            process.returncode = 1
            terminated.set()

        process.terminate = terminate
        process.kill = terminate

        try:
            with patch(
                "voice_assistant.supervisor.asyncio.create_subprocess_exec",
                new=AsyncMock(return_value=process),
            ):
                with self.assertRaisesRegex(RuntimeError, "stdout closed unexpectedly"):
                    await asyncio.wait_for(self.supervisor.ensure_ready(), timeout=0.25)
        finally:
            terminate()

        self.assertTrue(terminated.is_set())
        self.assertIsNone(self.supervisor._process)

    def test_sanitized_environment_excludes_application_secrets(self):
        env = sanitized_child_env(
            {
                "PATH": os.environ.get("PATH", ""),
                "SYSTEMROOT": os.environ.get("SYSTEMROOT", ""),
                "HSTAR_API_KEY": "secret",
                "OPENAI_API_KEY": "secret",
            }
        )

        self.assertNotIn("HSTAR_API_KEY", env)
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertEqual(env["PYTHONUTF8"], "1")

    def test_voice_child_disables_bytecode_cache(self):
        env = sanitized_child_env({"PYTHONDONTWRITEBYTECODE": "0"})
        command = service_command(
            sys.executable,
            self.runtime_site,
            self.model_path,
            "test-token",
        )

        self.assertEqual(env["PYTHONDONTWRITEBYTECODE"], "1")
        self.assertIn("-B", command[1 : command.index("-m")])

    def test_service_command_binds_child_lifetime_to_parent(self):
        command = service_command(
            sys.executable,
            self.runtime_site,
            self.model_path,
            "test-token",
            parent_pid=12345,
        )

        parent_index = command.index("--parent-pid")
        self.assertEqual(command[parent_index + 1], "12345")


if __name__ == "__main__":
    unittest.main()
