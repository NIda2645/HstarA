import asyncio
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from fastapi import HTTPException

import main
from voice_assistant.manager import VoiceAssistantManager, VoiceManagerError
from voice_assistant.registry import ModelDetection
from voice_assistant.supervisor import VoiceSupervisorStatus


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


class DeferredPrewarmSupervisor:
    def __init__(self):
        self.calls = 0
        self.started = asyncio.Event()
        self.release = asyncio.Event()
        self.loaded = False

    async def prewarm(self, device="auto"):
        self.calls += 1
        self.started.set()
        await self.release.wait()
        self.loaded = True

    def status(self):
        return VoiceSupervisorStatus(
            process_state="running",
            model_state="loaded" if self.loaded else "unloaded",
            process_id=1,
            port=1234,
            active_sessions=0,
            last_error="",
        )


class VoiceApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.fake_manager = FakeManager()

    async def test_status_does_not_start_service(self):
        with patch.object(main, "VOICE_ASSISTANT", self.fake_manager):
            response = main.voice_assistant_status()

        self.assertTrue(response["ok"])
        self.assertEqual(response["status"]["service"]["process_state"], "stopped")
        self.assertEqual(self.fake_manager.start_count, 0)

    async def test_manager_status_reports_runtime_without_starting_service(self):
        with tempfile.TemporaryDirectory() as root:
            manager = VoiceAssistantManager(
                app_data_root=root,
                load_settings=lambda: {},
                save_settings=lambda value: None,
                test_mode=True,
            )

            status = manager.status()

        self.assertEqual(status["runtime"], {"ready": False, "profile": ""})
        self.assertEqual(status["service"]["process_state"], "stopped")

    async def test_manager_status_uses_lightweight_model_detection(self):
        with tempfile.TemporaryDirectory() as root:
            manager = VoiceAssistantManager(
                app_data_root=root,
                load_settings=lambda: {},
                save_settings=lambda value: None,
                test_mode=True,
            )
            manager.registry.detect = Mock(return_value=ModelDetection(
                ready=False,
                model_path="",
                revision="",
                missing=(),
                size_bytes=0,
                source="external",
            ))

            manager.status()

        manager.registry.detect.assert_called_once_with(
            manager.settings.model_path or str(manager.paths["root"]),
            include_size=False,
        )

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

    async def test_cancelled_client_does_not_duplicate_shared_model_prewarm(self):
        manager = object.__new__(VoiceAssistantManager)
        manager.installer = SimpleNamespace(
            runtime_status=lambda: {"ready": True, "profile": "cpu"},
        )
        manager.supervisor = DeferredPrewarmSupervisor()
        manager._prewarm_task = None

        first = asyncio.create_task(manager.start_service("auto"))
        await manager.supervisor.started.wait()
        first.cancel()
        with self.assertRaises(asyncio.CancelledError):
            await first

        second = asyncio.create_task(manager.start_service("auto"))
        await asyncio.sleep(0)
        self.assertEqual(manager.supervisor.calls, 1)
        manager.supervisor.release.set()

        status = await second
        self.assertEqual(status["model_state"], "loaded")
        self.assertEqual(manager.supervisor.calls, 1)

    async def test_start_service_rejects_an_unvalidated_runtime_before_prewarm(self):
        manager = object.__new__(VoiceAssistantManager)
        manager.installer = SimpleNamespace(
            runtime_status=lambda: {"ready": False, "profile": ""},
            validate_existing_runtime=Mock(
                return_value={"ready": False, "profile": ""},
            ),
        )
        manager.supervisor = SimpleNamespace(
            status=lambda: VoiceSupervisorStatus(
                process_state="stopped",
                model_state="unloaded",
                process_id=0,
                port=0,
                active_sessions=0,
                last_error="",
            ),
            prewarm=AsyncMock(),
        )
        manager._prewarm_task = None

        with self.assertRaises(VoiceManagerError) as error:
            await manager.start_service("auto")

        self.assertEqual(error.exception.code, "VOICE_RUNTIME_MISSING")
        manager.installer.validate_existing_runtime.assert_called_once_with()
        manager.supervisor.prewarm.assert_not_awaited()

    async def test_start_service_probe_validates_a_legacy_runtime_before_prewarm(self):
        manager = object.__new__(VoiceAssistantManager)
        manager.installer = SimpleNamespace(
            runtime_status=lambda: {"ready": False, "profile": ""},
            validate_existing_runtime=Mock(
                return_value={"ready": True, "profile": "cpu"},
            ),
        )
        manager.supervisor = DeferredPrewarmSupervisor()
        manager._prewarm_task = None
        manager.supervisor.release.set()

        status = await manager.start_service("auto")

        self.assertEqual(status["model_state"], "loaded")
        manager.installer.validate_existing_runtime.assert_called_once_with()

    async def test_startup_prewarm_skips_an_unvalidated_runtime(self):
        manager = object.__new__(VoiceAssistantManager)
        manager.settings = SimpleNamespace(
            enabled=True,
            prewarm_on_startup=True,
            model_path="E:/Speech/model",
        )
        manager.paths = {"root": "E:/Speech"}
        manager.registry = SimpleNamespace(
            detect=Mock(return_value=ModelDetection(
                ready=True,
                model_path="E:/Speech/model",
                revision="",
                missing=(),
                size_bytes=0,
                source="external",
            )),
        )
        manager.installer = SimpleNamespace(
            runtime_status=Mock(return_value={"ready": False, "profile": ""}),
        )
        manager.supervisor = SimpleNamespace(prewarm=AsyncMock())
        manager._reaper_task = asyncio.create_task(asyncio.sleep(30))
        manager._prewarm_task = None
        try:
            manager.schedule_background_tasks()
            await asyncio.sleep(0)

            self.assertIsNone(manager._prewarm_task)
            manager.supervisor.prewarm.assert_not_awaited()
        finally:
            manager._reaper_task.cancel()
            await asyncio.gather(manager._reaper_task, return_exceptions=True)


if __name__ == "__main__":
    unittest.main()
