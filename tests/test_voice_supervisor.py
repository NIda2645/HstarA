import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path

from voice_assistant.supervisor import (
    VoiceServiceSupervisor,
    sanitized_child_env,
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


if __name__ == "__main__":
    unittest.main()
