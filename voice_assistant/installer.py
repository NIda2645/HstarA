import json
import os
import shutil
import subprocess
import sys
import threading
import time
import uuid
from dataclasses import asdict, dataclass, replace
from pathlib import Path
from typing import Callable, Iterable, Mapping

from .registry import (
    ModelRegistry,
    fetch_official_manifest,
    load_cached_manifest,
    save_cached_manifest,
    verify_against_manifest,
)
from .settings import MODEL_ID


TERMINAL_STATES = frozenset({"completed", "cancelled", "failed"})


class InstallCancelled(RuntimeError):
    pass


class InstallCommandError(RuntimeError):
    def __init__(self, return_code: int, output: str):
        super().__init__(output or f"Installer subprocess exited with {return_code}")
        self.return_code = return_code
        self.output = output


@dataclass(frozen=True)
class InstallTaskState:
    task_id: str
    kind: str
    profile: str
    status: str
    stage: str
    downloaded_bytes: int = 0
    total_bytes: int = 0
    speed_bps: float = 0.0
    eta_seconds: float | None = None
    error_code: str = ""
    error_message: str = ""
    cancel_requested: bool = False
    resume_available: bool = False
    runtime_ready: bool = False
    model_ready: bool = False


@dataclass
class _TaskRecord:
    state: InstallTaskState
    cancel_event: threading.Event
    done_event: threading.Event
    thread: threading.Thread | None = None


def build_pip_install_command(
    *,
    python_executable: str,
    runtime_site: Path,
    packages: Iterable[str],
    index_url: str,
    extra_index_url: str,
) -> list[str]:
    return [
        str(python_executable),
        "-m",
        "pip",
        "install",
        "--disable-pip-version-check",
        "--no-input",
        "--upgrade",
        "--target",
        str(Path(runtime_site).resolve()),
        "--index-url",
        index_url,
        "--extra-index-url",
        extra_index_url,
        *packages,
    ]


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink(missing_ok=True)
    elif path.is_dir():
        shutil.rmtree(path)


def activate_directory(staging: Path, target: Path) -> None:
    staging = staging.resolve()
    target = target.resolve()
    if not staging.is_dir():
        raise FileNotFoundError(staging)
    target.parent.mkdir(parents=True, exist_ok=True)
    backup = target.with_name(f"{target.name}.backup")
    _remove_path(backup)
    had_target = target.exists()
    if had_target:
        target.replace(backup)
    try:
        staging.replace(target)
    except Exception:
        if had_target and backup.exists() and not target.exists():
            backup.replace(target)
        raise
    _remove_path(backup)


def migrate_voice_root(
    source: Path,
    target: Path,
    *,
    validator: Callable[[Path], bool],
) -> Path:
    source = source.expanduser().resolve()
    target = target.expanduser().resolve()
    if not source.is_dir():
        raise FileNotFoundError(source)
    if source == target or source in target.parents or target in source.parents:
        raise ValueError("Voice migration roots must be separate directories")
    staging = target.with_name(f"{target.name}.migration-partial")
    _remove_path(staging)
    try:
        shutil.copytree(source, staging)
        if not validator(staging):
            raise RuntimeError("Voice migration validation failed")
        activate_directory(staging, target)
    except Exception:
        _remove_path(staging)
        raise
    _remove_path(source)
    return target


def _is_hstar_managed_model(model_path: Path) -> bool:
    marker = model_path / ".hstar-model.json"
    if not marker.is_file():
        return False
    try:
        payload = json.loads(marker.read_text(encoding="utf-8"))
        return payload.get("managed_by") == "HstarA"
    except (OSError, ValueError, TypeError):
        return False


def uninstall_voice_data(
    paths: Mapping[str, Path],
    *,
    delete_external_model: bool = False,
    confirmation_token: str = "",
) -> tuple[str, ...]:
    resolved = {name: Path(path).expanduser().resolve() for name, path in paths.items()}
    deleted = []
    model = resolved["model"]
    may_delete_external = (
        delete_external_model and confirmation_token == "DELETE_EXTERNAL_VOICE_MODEL"
    )
    if model.exists() and (_is_hstar_managed_model(model) or may_delete_external):
        _remove_path(model)
        deleted.append(str(model))
    managed = resolved["managed"]
    if managed.exists():
        _remove_path(managed)
        deleted.append(str(managed))
    return tuple(deleted)


def default_hardware_probe() -> str:
    system_root = Path(os.environ.get("SystemRoot") or "C:/Windows")
    nvidia_smi = system_root / "System32" / "nvidia-smi.exe"
    if not nvidia_smi.is_file():
        return "cpu"
    try:
        result = subprocess.run(
            [str(nvidia_smi), "--query-gpu=name", "--format=csv,noheader"],
            check=False,
            capture_output=True,
            text=True,
            timeout=5,
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
        return "cuda" if result.returncode == 0 and result.stdout.strip() else "cpu"
    except (OSError, subprocess.SubprocessError):
        return "cpu"


class SubprocessRunner:
    def __call__(
        self,
        command: list[str],
        *,
        env: Mapping[str, str],
        cancel_event: threading.Event,
        on_tick: Callable[[], None],
    ) -> None:
        process = subprocess.Popen(
            command,
            cwd=str(Path(__file__).resolve().parents[1]),
            env=dict(env),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            creationflags=(subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0),
        )
        output = ""
        while True:
            if cancel_event.is_set():
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait(timeout=5)
                raise InstallCancelled()
            try:
                stdout, _ = process.communicate(timeout=0.25)
                output += stdout or ""
                break
            except subprocess.TimeoutExpired as pending:
                if pending.output:
                    output = str(pending.output)
                on_tick()
        if process.returncode:
            raise InstallCommandError(process.returncode, output[-8000:])


class VoiceInstaller:
    def __init__(
        self,
        paths: Mapping[str, Path],
        *,
        runner: Callable | None = None,
        python_executable: str | None = None,
        hardware_probe: Callable[[], str] | None = None,
    ):
        self.paths = {name: Path(path).resolve() for name, path in paths.items()}
        self.runner = runner or SubprocessRunner()
        self.python_executable = str(python_executable or sys.executable)
        self.hardware_probe = hardware_probe or default_hardware_probe
        self._lock = threading.RLock()
        self._tasks: dict[str, _TaskRecord] = {}
        self._active_task_id = ""

    def start_install(self, profile: str = "auto") -> InstallTaskState:
        with self._lock:
            active = self._tasks.get(self._active_task_id)
            if active and active.state.status not in TERMINAL_STATES:
                return replace(active.state)
            resolved_profile = self._resolve_profile(profile)
            task_id = uuid.uuid4().hex
            state = InstallTaskState(
                task_id=task_id,
                kind="install",
                profile=resolved_profile,
                status="queued",
                stage="checking-runtime",
            )
            record = _TaskRecord(state, threading.Event(), threading.Event())
            self._tasks[task_id] = record
            self._active_task_id = task_id
            self._persist(record.state)
            record.thread = threading.Thread(
                target=self._run_install,
                args=(task_id,),
                name=f"hstar-voice-install-{task_id[:8]}",
                daemon=True,
            )
            record.thread.start()
            return replace(record.state)

    def active_task(self) -> InstallTaskState | None:
        with self._lock:
            record = self._tasks.get(self._active_task_id)
            return replace(record.state) if record else None

    def runtime_status(self) -> dict[str, object]:
        manifest = self._load_runtime_manifest()
        marker = self.paths["state"] / "runtime-install.json"
        if not marker.is_file() or not self.paths["runtime_site"].is_dir():
            return {"ready": False, "profile": ""}
        try:
            installed = json.loads(marker.read_text(encoding="utf-8"))
        except (OSError, ValueError, TypeError):
            return {"ready": False, "profile": ""}
        profile = str(installed.get("profile") or "")
        ready = (
            profile in manifest.get("profiles", {})
            and installed.get("packages") == manifest.get("packages")
        )
        return {"ready": ready, "profile": profile if ready else ""}

    def status(self, task_id: str) -> InstallTaskState:
        with self._lock:
            record = self._tasks.get(task_id)
            if not record:
                raise KeyError(task_id)
            return replace(record.state)

    def cancel(self, task_id: str) -> InstallTaskState:
        with self._lock:
            record = self._tasks.get(task_id)
            if not record:
                raise KeyError(task_id)
            if record.state.status not in TERMINAL_STATES:
                record.cancel_event.set()
                self._update(task_id, cancel_requested=True)
            return replace(record.state)

    def wait(self, task_id: str, timeout: float | None = None) -> InstallTaskState:
        with self._lock:
            record = self._tasks.get(task_id)
            if not record:
                raise KeyError(task_id)
            event = record.done_event
        if not event.wait(timeout):
            raise TimeoutError(task_id)
        return self.status(task_id)

    def _resolve_profile(self, profile: str) -> str:
        if profile not in {"auto", "cuda", "cpu"}:
            raise ValueError(f"Unsupported voice runtime profile: {profile}")
        if profile == "auto":
            profile = self.hardware_probe()
        if profile not in {"cuda", "cpu"}:
            raise ValueError(f"Hardware probe returned an invalid profile: {profile}")
        return profile

    def _run_install(self, task_id: str) -> None:
        record = self._tasks[task_id]
        try:
            self._prepare_directories()
            self._update(task_id, status="running", stage="checking-runtime")
            manifest = self._load_runtime_manifest()
            if not self._runtime_ready(manifest, record.state.profile):
                self._install_runtime(task_id, manifest, record.state.profile)
            self._update(task_id, runtime_ready=True, stage="resolving-manifest")
            official_revision, official_files = self._resolve_model_manifest()
            total = sum(item.size for item in official_files)
            self._update(task_id, total_bytes=total)

            detection = ModelRegistry().detect(self.paths["model"])
            if not detection.ready:
                self._install_model(
                    task_id,
                    revision=official_revision,
                    manifest=official_files,
                    profile=record.state.profile,
                )
            self._write_managed_marker(official_revision)
            self._update(
                task_id,
                status="completed",
                stage="ready",
                runtime_ready=True,
                model_ready=True,
                resume_available=False,
                eta_seconds=0.0,
            )
        except InstallCancelled:
            self._update(
                task_id,
                status="cancelled",
                stage="cancelled",
                model_ready=False,
                resume_available=True,
                error_code="VOICE_INSTALL_CANCELLED",
            )
        except Exception as error:
            code = getattr(error, "code", "VOICE_INSTALL_FAILED")
            self._update(
                task_id,
                status="failed",
                stage="failed",
                model_ready=False,
                resume_available=True,
                error_code=str(code),
                error_message=str(error),
            )
        finally:
            record.done_event.set()

    def _prepare_directories(self) -> None:
        for name in ("managed", "downloads", "cache", "state", "logs"):
            self.paths[name].mkdir(parents=True, exist_ok=True)

    @staticmethod
    def _load_runtime_manifest() -> dict:
        path = Path(__file__).with_name("runtime_manifest.json")
        return json.loads(path.read_text(encoding="utf-8"))

    def _runtime_ready(self, manifest: dict, profile: str) -> bool:
        marker = self.paths["state"] / "runtime-install.json"
        if not marker.is_file() or not self.paths["runtime_site"].is_dir():
            return False
        try:
            current = json.loads(marker.read_text(encoding="utf-8"))
            return (
                current.get("profile") == profile
                and current.get("packages") == manifest.get("packages")
            )
        except (OSError, ValueError, TypeError):
            return False

    def _install_runtime(self, task_id: str, manifest: dict, profile: str) -> None:
        self._update(task_id, stage="installing-runtime")
        candidate_root = self.paths["downloads"] / f"runtime-{profile}.partial"
        candidate_manifest = {
            "profile": profile,
            "packages": manifest["packages"],
        }
        partial_marker = candidate_root / ".runtime-manifest.json"
        if partial_marker.is_file():
            try:
                previous = json.loads(partial_marker.read_text(encoding="utf-8"))
            except (OSError, ValueError, TypeError):
                previous = None
            if previous != candidate_manifest:
                _remove_path(candidate_root)
        candidate_site = candidate_root / "site-packages"
        candidate_site.mkdir(parents=True, exist_ok=True)
        self._write_json_atomic(partial_marker, candidate_manifest)
        profile_config = manifest["profiles"][profile]
        command = build_pip_install_command(
            python_executable=self.python_executable,
            runtime_site=candidate_site,
            packages=manifest["packages"],
            index_url=profile_config["indexUrl"],
            extra_index_url=profile_config["extraIndexUrl"],
        )
        self.runner(
            command,
            env=self._child_environment(),
            cancel_event=self._tasks[task_id].cancel_event,
            on_tick=lambda: self._check_cancel(task_id),
        )
        activate_directory(candidate_root, self.paths["managed"] / "runtime")
        self._write_json_atomic(
            self.paths["state"] / "runtime-install.json",
            {"profile": profile, "packages": manifest["packages"]},
        )

    def _resolve_model_manifest(self):
        cache_path = self.paths["state"] / "model-manifest.json"
        try:
            files = fetch_official_manifest("master")
            save_cached_manifest(cache_path, revision="master", files=files)
            return "master", files
        except Exception:
            revision, files = load_cached_manifest(cache_path)
            if files:
                return revision or "master", files
            raise

    def _install_model(self, task_id: str, *, revision, manifest, profile: str) -> None:
        self._update(task_id, stage="downloading-model")
        staging = self.paths["downloads"] / f"model-{revision}.partial"
        staging.mkdir(parents=True, exist_ok=True)
        started_at = time.monotonic()
        starting_bytes = self._directory_size(staging)

        def update_progress() -> None:
            self._check_cancel(task_id)
            downloaded = self._directory_size(staging)
            elapsed = max(0.001, time.monotonic() - started_at)
            speed = max(0.0, (downloaded - starting_bytes) / elapsed)
            total = self.status(task_id).total_bytes
            remaining = max(0, total - downloaded)
            self._update(
                task_id,
                downloaded_bytes=downloaded,
                speed_bps=speed,
                eta_seconds=(remaining / speed if speed > 0 else None),
                resume_available=downloaded > 0,
            )

        self.runner(
            [
                self.python_executable,
                "-X",
                "utf8",
                "-m",
                "voice_assistant.modelscope_worker",
                "download",
                "--runtime-site",
                str(self.paths["runtime_site"]),
                "--model-id",
                MODEL_ID,
                "--revision",
                revision,
                "--staging-dir",
                str(staging),
            ],
            env=self._child_environment(),
            cancel_event=self._tasks[task_id].cancel_event,
            on_tick=update_progress,
        )
        update_progress()
        self._update(task_id, stage="verifying-files")
        invalid = verify_against_manifest(staging, manifest)
        if invalid:
            raise RuntimeError(f"Model verification failed: {', '.join(invalid[:10])}")
        metadata = {
            "managed_by": "HstarA",
            "model_id": MODEL_ID,
            "revision": revision,
        }
        self._write_json_atomic(staging / ".hstar-model.json", metadata)
        self._update(task_id, stage="loading-smoke-test")
        self.runner(
            [
                self.python_executable,
                "-X",
                "utf8",
                "-m",
                "voice_assistant.modelscope_worker",
                "smoke",
                "--runtime-site",
                str(self.paths["runtime_site"]),
                "--model-path",
                str(staging),
                "--device",
                profile,
            ],
            env=self._child_environment(),
            cancel_event=self._tasks[task_id].cancel_event,
            on_tick=lambda: self._check_cancel(task_id),
        )
        activate_directory(staging, self.paths["model"])

    def _child_environment(self) -> dict[str, str]:
        allowed = {
            "ALLUSERSPROFILE",
            "APPDATA",
            "COMSPEC",
            "CUDA_PATH",
            "CUDA_VISIBLE_DEVICES",
            "HOMEDRIVE",
            "HOMEPATH",
            "LOCALAPPDATA",
            "NUMBER_OF_PROCESSORS",
            "PATH",
            "PATHEXT",
            "PROCESSOR_ARCHITECTURE",
            "PROGRAMDATA",
            "PROGRAMFILES",
            "PROGRAMFILES(X86)",
            "SYSTEMDRIVE",
            "SYSTEMROOT",
            "TEMP",
            "TMP",
            "USERPROFILE",
            "WINDIR",
            "HTTP_PROXY",
            "HTTPS_PROXY",
            "NO_PROXY",
        }
        env = {key: value for key, value in os.environ.items() if key.upper() in allowed}
        env.update(
            {
                "PYTHONNOUSERSITE": "1",
                "PYTHONUTF8": "1",
                "MODELSCOPE_CACHE": str(self.paths["cache"]),
            }
        )
        return env

    def _check_cancel(self, task_id: str) -> None:
        if self._tasks[task_id].cancel_event.is_set():
            raise InstallCancelled()

    def _update(self, task_id: str, **changes) -> InstallTaskState:
        with self._lock:
            record = self._tasks[task_id]
            record.state = replace(record.state, **changes)
            self._persist(record.state)
            return replace(record.state)

    def _persist(self, state: InstallTaskState) -> None:
        self._write_json_atomic(
            self.paths["state"] / f"install-{state.task_id}.json",
            asdict(state),
        )

    @staticmethod
    def _write_json_atomic(path: Path, payload: dict) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}-{threading.get_ident()}")
        temporary.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        os.replace(temporary, path)

    def _write_managed_marker(self, revision: str) -> None:
        self._write_json_atomic(
            self.paths["state"] / "managed-install.json",
            {
                "managed_by": "HstarA",
                "model_id": MODEL_ID,
                "revision": revision,
                "model_path": str(self.paths["model"]),
                "runtime_path": str(self.paths["runtime_site"]),
            },
        )

    @staticmethod
    def _directory_size(path: Path) -> int:
        total = 0
        if not path.is_dir():
            return total
        for root, _, files in os.walk(path, followlinks=False):
            for name in files:
                try:
                    total += (Path(root) / name).stat().st_size
                except OSError:
                    continue
        return total
