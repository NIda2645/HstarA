import asyncio
import os
import sys
from dataclasses import asdict
from pathlib import Path
from typing import Any, Callable, Mapping

from .installer import (
    VoiceInstaller,
    migrate_voice_root,
    uninstall_voice_data,
)
from .registry import ModelRegistry
from .settings import VoiceSettings, normalize_voice_settings, voice_paths
from .supervisor import VoiceServiceConnection, VoiceServiceSupervisor


class VoiceManagerError(RuntimeError):
    def __init__(self, code: str, message: str = ""):
        self.code = code
        self.message = message
        super().__init__(f"{code}: {message}" if message else code)

    def as_event(self) -> dict[str, Any]:
        return {
            "type": "error",
            "code": self.code,
            "message": self.message,
            "recoverable": True,
        }


class VoiceAssistantManager:
    def __init__(
        self,
        *,
        app_data_root: str,
        load_settings: Callable[[], dict],
        save_settings: Callable[[dict], None],
        path_validator: Callable[[str], str] | None = None,
        python_executable: str | None = None,
        test_mode: bool = False,
        registry: ModelRegistry | None = None,
    ):
        self.app_data_root = str(Path(app_data_root).resolve())
        self.load_settings = load_settings
        self.save_settings = save_settings
        self.path_validator = path_validator or self._validate_writable_path
        self.python_executable = str(python_executable or sys.executable)
        self.test_mode = test_mode
        self.registry = registry or ModelRegistry()
        self._session_lock = asyncio.Lock()
        self._reaper_task = None
        self._prewarm_task = None
        self._configure(self.load_settings())

    def _configure(self, software_settings: Mapping[str, Any]) -> None:
        self.settings = normalize_voice_settings(
            software_settings,
            app_data_root=self.app_data_root,
        )
        self.paths = voice_paths(self.settings)
        model_path = self.settings.model_path or str(self.paths["model"])
        self.installer = VoiceInstaller(
            self.paths,
            python_executable=self.python_executable,
        )
        self.supervisor = VoiceServiceSupervisor(
            python_executable=self.python_executable,
            runtime_site=self.paths["runtime_site"],
            model_path=Path(model_path),
            test_mode=self.test_mode,
            warm_idle_seconds=self.settings.warm_idle_seconds,
        )

    def status(self) -> dict[str, Any]:
        selected = self.settings.model_path or str(self.paths["root"])
        detection = self.registry.detect(selected)
        active = self.installer.active_task()
        return {
            "settings": asdict(self.settings),
            "runtime": self.installer.runtime_status(),
            "model": asdict(detection),
            "service": asdict(self.supervisor.status()),
            "task": asdict(active) if active else None,
        }

    def install(self, profile: str = "auto") -> dict[str, Any]:
        return asdict(self.installer.start_install(profile=profile))

    def task_status(self, task_id: str) -> dict[str, Any]:
        try:
            return asdict(self.installer.status(task_id))
        except KeyError as error:
            raise VoiceManagerError("VOICE_TASK_NOT_FOUND", task_id) from error

    def cancel_install(self, task_id: str) -> dict[str, Any]:
        try:
            return asdict(self.installer.cancel(task_id))
        except KeyError as error:
            raise VoiceManagerError("VOICE_TASK_NOT_FOUND", task_id) from error

    async def update_settings(self, values: Mapping[str, Any]) -> dict[str, Any]:
        current = self.load_settings()
        current = dict(current) if isinstance(current, Mapping) else {}
        voice = current.get("voice_assistant")
        voice = dict(voice) if isinstance(voice, Mapping) else {}
        allowed = {
            "enabled",
            "storage_mode",
            "storage_root",
            "language",
            "input_device_id",
            "shortcut",
            "prewarm_on_startup",
        }
        for key in allowed:
            if key in values:
                voice[key] = values[key]
        if voice.get("storage_mode") == "custom":
            requested = str(voice.get("storage_root") or "").strip()
            if not requested:
                raise VoiceManagerError(
                    "VOICE_STORAGE_NOT_WRITABLE",
                    "Voice storage folder is required",
                )
            try:
                voice["storage_root"] = await asyncio.to_thread(
                    self.path_validator,
                    requested,
                )
            except VoiceManagerError:
                raise
            except Exception as error:
                detail = getattr(error, "detail", str(error))
                raise VoiceManagerError(
                    "VOICE_STORAGE_NOT_WRITABLE",
                    str(detail),
                ) from error

        candidate = {**current, "voice_assistant": voice}
        normalize_voice_settings(candidate, app_data_root=self.app_data_root)
        await self.supervisor.shutdown()
        self.save_settings(candidate)
        self._configure(candidate)
        return asdict(self.settings)

    async def detect_model(self, selected: str) -> dict[str, Any]:
        detection = await asyncio.to_thread(self.registry.detect, selected)
        if not detection.ready:
            return asdict(detection)
        current = self.load_settings()
        current = dict(current) if isinstance(current, Mapping) else {}
        voice = current.get("voice_assistant")
        voice = dict(voice) if isinstance(voice, Mapping) else {}
        voice["model_path"] = detection.model_path
        voice["model_revision"] = detection.revision
        current["voice_assistant"] = voice
        await self.supervisor.shutdown()
        self.save_settings(current)
        self._configure(current)
        return asdict(detection)

    async def migrate(self, target_root: str) -> dict[str, Any]:
        try:
            target = await asyncio.to_thread(self.path_validator, target_root)
        except Exception as error:
            detail = getattr(error, "detail", str(error))
            raise VoiceManagerError("VOICE_STORAGE_NOT_WRITABLE", str(detail)) from error
        source = Path(self.settings.effective_root)
        destination = Path(target)

        def validator(root: Path) -> bool:
            model = self.registry.detect(root)
            return model.ready or not (source / "FunAudioLLM").exists()

        await self.supervisor.shutdown()
        await asyncio.to_thread(
            migrate_voice_root,
            source,
            destination,
            validator=validator,
        )
        updated = self.load_settings()
        updated = dict(updated) if isinstance(updated, Mapping) else {}
        voice = updated.get("voice_assistant")
        voice = dict(voice) if isinstance(voice, Mapping) else {}
        voice.update({"storage_mode": "custom", "storage_root": str(destination)})
        updated["voice_assistant"] = voice
        self.save_settings(updated)
        self._configure(updated)
        return asdict(self.settings)

    async def uninstall(
        self,
        *,
        delete_external_model: bool = False,
        confirmation_token: str = "",
    ) -> tuple[str, ...]:
        await self.supervisor.shutdown()
        return await asyncio.to_thread(
            uninstall_voice_data,
            self.paths,
            delete_external_model=delete_external_model,
            confirmation_token=confirmation_token,
        )

    async def open_session(self, session_id: str) -> VoiceServiceConnection:
        if self._session_lock.locked():
            raise VoiceManagerError("VOICE_MIC_BUSY", "Another voice session is active")
        await self._session_lock.acquire()
        try:
            endpoint = await self.supervisor.ensure_ready()
            return await self.supervisor.connect(endpoint, session_id)
        except Exception:
            self._session_lock.release()
            raise

    async def close_session(self, connection: VoiceServiceConnection) -> None:
        try:
            await connection.close()
        finally:
            if self._session_lock.locked():
                self._session_lock.release()
            await self.supervisor.session_finished()

    async def start_service(self, device: str = "auto") -> dict[str, Any]:
        runtime = self.installer.runtime_status()
        if not runtime["ready"]:
            raise VoiceManagerError(
                "VOICE_RUNTIME_MISSING",
                "Voice runtime is not installed or failed validation",
            )
        status = self.supervisor.status()
        if status.model_state != "loaded":
            task = self._prewarm_task
            if task is None or task.done():
                task = asyncio.create_task(self.supervisor.prewarm(device))
                self._prewarm_task = task
            await asyncio.shield(task)
        return asdict(self.supervisor.status())

    async def stop_service(self) -> dict[str, Any]:
        await self.supervisor.shutdown()
        return asdict(self.supervisor.status())

    def schedule_background_tasks(self) -> None:
        if self._reaper_task is None or self._reaper_task.done():
            self._reaper_task = asyncio.create_task(self._reaper_loop())
        if self.settings.enabled and self.settings.prewarm_on_startup:
            detection = self.registry.detect(
                self.settings.model_path or str(self.paths["root"])
            )
            if detection.ready and (
                self._prewarm_task is None or self._prewarm_task.done()
            ):
                self._prewarm_task = asyncio.create_task(self.supervisor.prewarm())

    async def _reaper_loop(self) -> None:
        while True:
            await asyncio.sleep(15)
            if self.supervisor.is_running():
                await self.supervisor.reap_idle()

    async def shutdown(self) -> None:
        pending = []
        for task in (self._prewarm_task, self._reaper_task):
            if task and not task.done():
                task.cancel()
                pending.append(task)
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await self.supervisor.shutdown()

    @staticmethod
    def _validate_writable_path(value: str) -> str:
        path = Path(os.path.expandvars(os.path.expanduser(value))).resolve()
        path.mkdir(parents=True, exist_ok=True)
        marker = path / ".hstar-voice-write-test"
        try:
            marker.write_text("ok", encoding="utf-8")
            marker.unlink()
        except Exception as error:
            raise VoiceManagerError("VOICE_STORAGE_NOT_WRITABLE", str(error)) from error
        return str(path)
