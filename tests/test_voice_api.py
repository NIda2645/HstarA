import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException

import main
from voice_assistant.manager import VoiceAssistantManager, VoiceManagerError


class FakeManager:
    def __init__(self):
        self.start_count = 0
        self.install_task = {
            "task_id": "task-1",
            "status": "running",
            "stage": "installing-runtime",
        }
        self.settings_updates = []

    def status(self):
        return {
            "service": {"process_state": "stopped"},
            "settings": {"storage_mode": "inherit"},
            "task": None,
        }

    def install(self, profile):
        self.start_count += 1
        return self.install_task

    async def update_settings(self, payload):
        self.settings_updates.append(payload)
        raise VoiceManagerError("VOICE_STORAGE_NOT_WRITABLE", "Folder is not writable")


class FakeConnection:
    def __init__(self):
        self.closed = False

    async def close(self):
        self.closed = True


class FakeSupervisor:
    def __init__(self):
        self.connection = FakeConnection()
        self.finished = 0

    async def ensure_ready(self):
        return SimpleNamespace(port=1234)

    async def connect(self, endpoint, session_id):
        return self.connection

    async def session_finished(self):
        self.finished += 1


class VoiceApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake_manager = FakeManager()

    async def test_status_does_not_start_service(self):
        with patch.object(main, "VOICE_ASSISTANT", self.fake_manager):
            response = main.voice_assistant_status()

        self.assertTrue(response["ok"])
        self.assertEqual(response["status"]["service"]["process_state"], "stopped")
        self.assertEqual(self.fake_manager.start_count, 0)

    async def test_repeated_install_is_idempotent(self):
        request = main.VoiceInstallRequest(profile="cpu")
        with patch.object(main, "VOICE_ASSISTANT", self.fake_manager):
            first = main.install_voice_assistant(request)
            second = main.install_voice_assistant(request)

        self.assertEqual(first["task"]["task_id"], second["task"]["task_id"])

    async def test_custom_path_failure_returns_400(self):
        request = main.VoiceSettingsRequest(
            storage_mode="custom",
            storage_root="Z:/not-writable",
        )
        with patch.object(main, "VOICE_ASSISTANT", self.fake_manager):
            with self.assertRaises(HTTPException) as error:
                await main.save_voice_assistant_settings(request)

        self.assertEqual(error.exception.status_code, 400)
        self.assertEqual(len(self.fake_manager.settings_updates), 1)

    async def test_manager_rejects_second_session_and_releases_after_close(self):
        manager = object.__new__(VoiceAssistantManager)
        manager._session_lock = __import__("asyncio").Lock()
        manager.supervisor = FakeSupervisor()

        first = await manager.open_session("first")
        with self.assertRaisesRegex(VoiceManagerError, "VOICE_MIC_BUSY"):
            await manager.open_session("second")
        await manager.close_session(first)
        second = await manager.open_session("second")

        self.assertIs(second, manager.supervisor.connection)


if __name__ == "__main__":
    unittest.main()
