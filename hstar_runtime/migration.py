from __future__ import annotations

import hashlib
import os
import shutil
import threading
from contextlib import nullcontext
from dataclasses import asdict, dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, ContextManager
from uuid import uuid4

from .atomic import atomic_write_json
from .bootstrap import BootstrapConfig, BootstrapStore


MIGRATION_STATUSES = frozenset(
    {
        "preflight",
        "copying",
        "verifying",
        "switching",
        "cancelling",
        "completed",
        "cancelled",
        "failed",
    }
)


class MigrationError(RuntimeError):
    pass


class _MigrationCancelled(MigrationError):
    pass


@dataclass(frozen=True)
class MigrationState:
    id: str
    status: str
    source: str
    target: str
    operation: str = "migrate"
    total_bytes: int = 0
    copied_bytes: int = 0
    current_path: str = ""
    error: str = ""
    started_at: str = ""
    completed_at: str = ""

    def as_dict(self) -> dict[str, object]:
        return asdict(self)


@dataclass
class _MigrationTask:
    state: MigrationState
    cancel_event: threading.Event
    finished_event: threading.Event
    thread: threading.Thread | None = None


class MigrationManager:
    def __init__(
        self,
        bootstrap: BootstrapStore,
        program_root: Path,
        *,
        clock: Callable[[], datetime] | None = None,
        disk_usage: Callable[[Path], object] = shutil.disk_usage,
        hash_file: Callable[[Path], str] | None = None,
        copy_chunk_size: int = 1024 * 1024,
        after_chunk: Callable[[MigrationState], None] | None = None,
        switch_guard: Callable[[], ContextManager] | None = None,
    ):
        if copy_chunk_size <= 0:
            raise ValueError("copy_chunk_size must be positive")
        self.bootstrap = bootstrap
        self.program_root = program_root.expanduser().resolve()
        self._clock = clock or (lambda: datetime.now(timezone.utc))
        self._disk_usage = disk_usage
        self._hash_file = hash_file
        self._copy_chunk_size = copy_chunk_size
        self._after_chunk = after_chunk
        self._switch_guard = switch_guard or nullcontext
        self._tasks: dict[str, _MigrationTask] = {}
        self._active_task_id = ""
        self._lock = threading.RLock()

    def start(self, source: Path, target: Path) -> MigrationState:
        return self._start(source, target, operation="migrate")

    def activate_existing(self, source: Path, target: Path) -> MigrationState:
        return self._start(source, target, operation="activate_existing")

    def switch_storage(self, source: Path, target: Path) -> MigrationState:
        return self._start(source, target, operation="switch_storage")

    def _start(self, source: Path, target: Path, *, operation: str) -> MigrationState:
        source_path = source.expanduser().resolve()
        target_path = target.expanduser().resolve()
        with self._lock:
            if self._active_task_id:
                active = self._tasks[self._active_task_id]
                if active.state.status not in {"completed", "cancelled", "failed"}:
                    raise MigrationError("已有数据迁移正在执行")
            task_id = uuid4().hex
            state = MigrationState(
                id=task_id,
                status="preflight",
                source=str(source_path),
                target=str(target_path),
                operation=operation,
                started_at=self._timestamp(),
            )
            task = _MigrationTask(state, threading.Event(), threading.Event())
            self._tasks[task_id] = task
            self._active_task_id = task_id
            self._persist(state)
            self._launch(task, resume=False)
            return task.state

    def status(self, task_id: str) -> MigrationState:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError(task_id)
            return replace(task.state)

    def wait(self, task_id: str, timeout: float | None = None) -> MigrationState:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError(task_id)
            finished = task.finished_event
        if not finished.wait(timeout):
            raise TimeoutError(f"等待迁移任务超时：{task_id}")
        return self.status(task_id)

    def cancel(self, task_id: str) -> MigrationState:
        state_to_persist = None
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError(task_id)
            if task.state.status not in {"completed", "cancelled", "failed"}:
                task.cancel_event.set()
                if task.state.status != "cancelling":
                    task.state = replace(task.state, status="cancelling")
                    state_to_persist = replace(task.state)
            state = replace(task.state)
        if state_to_persist is not None:
            self._persist(state_to_persist)
        return state

    def resume(self, task_id: str) -> MigrationState:
        with self._lock:
            task = self._tasks.get(task_id)
            if task is None:
                raise KeyError(task_id)
            if task.state.status not in {"cancelled", "failed"}:
                raise MigrationError("只有已取消或失败的迁移可以继续")
            if self._active_task_id and self._active_task_id != task_id:
                active = self._tasks[self._active_task_id]
                if active.state.status not in {"completed", "cancelled", "failed"}:
                    raise MigrationError("已有数据迁移正在执行")
            task.cancel_event = threading.Event()
            task.finished_event = threading.Event()
            task.state = replace(
                task.state,
                status="preflight",
                copied_bytes=0,
                current_path="",
                error="",
                completed_at="",
            )
            self._active_task_id = task_id
            self._persist(task.state)
            self._launch(task, resume=True)
            return replace(task.state)

    def _launch(self, task: _MigrationTask, *, resume: bool) -> None:
        task.thread = threading.Thread(
            target=self._run,
            args=(task.state.id, resume),
            name=f"hstar-data-migration-{task.state.id[:8]}",
            daemon=True,
        )
        task.thread.start()

    def _run(self, task_id: str, resume: bool) -> None:
        try:
            if self.status(task_id).operation in {"activate_existing", "switch_storage"}:
                self._activate_existing(task_id)
            else:
                self._execute(task_id, resume=resume)
        except _MigrationCancelled:
            self._set_state(task_id, status="cancelled", error="迁移已取消")
        except Exception as error:
            self._set_state(task_id, status="failed", error=str(error) or error.__class__.__name__)
        finally:
            with self._lock:
                task = self._tasks[task_id]
                if self._active_task_id == task_id:
                    self._active_task_id = ""
                task.finished_event.set()

    def _activate_existing(self, task_id: str) -> None:
        state = self.status(task_id)
        source = Path(state.source)
        target = Path(state.target)
        if not source.is_dir():
            raise MigrationError("源数据目录不存在")
        if not target.is_dir():
            raise MigrationError("已有 Hstar 数据目录不存在")
        if source == target or source in target.parents or target in source.parents:
            raise MigrationError("源目录与目标目录不能互相包含")
        if target == self.program_root or self.program_root in target.parents:
            raise MigrationError("目标目录不能位于 Hstar 程序目录内")
        self._raise_if_cancelled(task_id)
        self._set_state(task_id, status="switching", current_path="")
        with self._switch_guard():
            self._save_bootstrap_target(task_id, source, target)
        self._set_state(
            task_id,
            status="completed",
            current_path="",
            error="",
            completed_at=self._timestamp(),
        )

    def _execute(self, task_id: str, *, resume: bool) -> None:
        state = self.status(task_id)
        source = Path(state.source)
        target = Path(state.target)
        transaction = target / f".hstar-migration-{task_id}"
        self._raise_if_cancelled(task_id)
        self._preflight(source, target, transaction, resume=resume)
        self._raise_if_cancelled(task_id)
        manifest = self._build_manifest(task_id, source)
        total_bytes = sum(entry["size"] for entry in manifest)
        required_bytes = int(total_bytes * 1.05) + 64 * 1024 * 1024
        available_bytes = int(self._disk_usage(_existing_parent(target)).free)
        if available_bytes < required_bytes:
            raise MigrationError(
                f"目标磁盘空间不足：需要 {required_bytes} 字节，可用 {available_bytes} 字节"
            )

        transaction.mkdir(parents=True, exist_ok=True)
        atomic_write_json(
            transaction / ".manifest.json",
            {"schemaVersion": 1, "taskId": task_id, "files": manifest},
        )
        self._set_state(
            task_id,
            status="copying",
            total_bytes=total_bytes,
            copied_bytes=0,
            current_path="",
            error="",
        )

        copied_bytes = 0
        for entry in manifest:
            self._raise_if_cancelled(task_id)
            relative = entry["path"]
            source_file = source / relative
            destination = transaction / relative
            if (
                destination.is_file()
                and destination.stat().st_size == entry["size"]
                and self._hash_path(task_id, destination) == entry["sha256"]
            ):
                copied_bytes += entry["size"]
                self._set_state(
                    task_id,
                    copied_bytes=copied_bytes,
                    current_path=relative,
                    persist=False,
                )
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            partial = destination.with_name(f".{destination.name}.partial")
            file_copied = 0
            with source_file.open("rb") as source_stream, partial.open("wb") as target_stream:
                while True:
                    chunk = source_stream.read(self._copy_chunk_size)
                    if not chunk:
                        break
                    target_stream.write(chunk)
                    file_copied += len(chunk)
                    self._set_state(
                        task_id,
                        copied_bytes=copied_bytes + file_copied,
                        current_path=relative,
                        persist=False,
                    )
                    if self._after_chunk:
                        self._after_chunk(self.status(task_id))
                    self._raise_if_cancelled(task_id)
                target_stream.flush()
                os.fsync(target_stream.fileno())
            os.replace(partial, destination)
            shutil.copystat(source_file, destination, follow_symlinks=False)
            copied_bytes += entry["size"]
            self._set_state(
                task_id,
                copied_bytes=copied_bytes,
                current_path=relative,
            )

        self._set_state(task_id, status="verifying", copied_bytes=total_bytes, current_path="")
        for entry in manifest:
            self._raise_if_cancelled(task_id)
            destination = transaction / entry["path"]
            if not destination.is_file() or destination.stat().st_size != entry["size"]:
                raise MigrationError(f"迁移校验失败：{entry['path']} 大小不一致")
            if self._hash_path(task_id, destination) != entry["sha256"]:
                raise MigrationError(f"迁移校验失败：{entry['path']} SHA-256 不一致")

        with self._switch_guard():
            final_manifest = self._build_manifest(task_id, source)
            self._synchronize_transaction(task_id, source, transaction, final_manifest)
            stable_manifest = self._build_manifest(task_id, source)
            if self._manifest_content_snapshot(stable_manifest) != self._manifest_content_snapshot(final_manifest):
                raise MigrationError("源数据在最终同步期间仍在变化，未切换存储目录，请稍后重试")
            manifest = stable_manifest
            total_bytes = sum(int(entry["size"]) for entry in manifest)
            self._set_state(
                task_id,
                status="switching",
                total_bytes=total_bytes,
                copied_bytes=total_bytes,
                current_path="",
            )
            self._commit_transaction(task_id, source, target, transaction)
        self._set_state(
            task_id,
            status="completed",
            copied_bytes=total_bytes,
            current_path="",
            error="",
            completed_at=self._timestamp(),
        )

    def _preflight(
        self,
        source: Path,
        target: Path,
        transaction: Path,
        *,
        resume: bool,
    ) -> None:
        if not source.is_dir():
            raise MigrationError("源数据目录不存在")
        if source == target or source in target.parents or target in source.parents:
            raise MigrationError("源目录与目标目录不能互相包含")
        if target == self.program_root or self.program_root in target.parents:
            raise MigrationError("目标目录不能位于 Hstar 程序目录内")
        if target.exists():
            allowed = {transaction.name} if resume and transaction.exists() else set()
            unexpected = [item for item in target.iterdir() if item.name not in allowed]
            if unexpected:
                raise MigrationError("目标目录必须为空，现有数据不会被覆盖")

    def _build_manifest(self, task_id: str, source: Path) -> list[dict[str, object]]:
        manifest = []
        paths = []
        for path in source.rglob("*"):
            self._raise_if_cancelled(task_id)
            paths.append(path)
        for path in sorted(paths, key=lambda item: item.as_posix().lower()):
            self._raise_if_cancelled(task_id)
            relative = path.relative_to(source)
            if _excluded_from_migration(relative):
                continue
            if path.is_symlink():
                raise MigrationError(f"数据目录包含不支持的符号链接：{relative.as_posix()}")
            if not path.is_file():
                continue
            stat = path.stat()
            manifest.append(
                {
                    "path": relative.as_posix(),
                    "size": stat.st_size,
                    "mtimeNs": stat.st_mtime_ns,
                    "sha256": self._hash_path(task_id, path),
                }
            )
        return manifest

    def _source_snapshot(self, source: Path) -> list[tuple[str, int, int]]:
        snapshot = []
        for path in sorted(source.rglob("*"), key=lambda item: item.as_posix().lower()):
            relative = path.relative_to(source)
            if _excluded_from_migration(relative):
                continue
            if path.is_symlink():
                raise MigrationError(f"数据目录包含不支持的符号链接：{relative.as_posix()}")
            if not path.is_file():
                continue
            stat = path.stat()
            snapshot.append((relative.as_posix(), stat.st_size, stat.st_mtime_ns))
        return snapshot

    def _synchronize_transaction(
        self,
        task_id: str,
        source: Path,
        transaction: Path,
        manifest: list[dict[str, object]],
    ) -> None:
        expected = {str(entry["path"]) for entry in manifest}
        for entry in manifest:
            self._raise_if_cancelled(task_id)
            relative = str(entry["path"])
            destination = transaction / relative
            if (
                destination.is_file()
                and destination.stat().st_size == int(entry["size"])
                and self._hash_path(task_id, destination) == str(entry["sha256"])
            ):
                continue
            destination.parent.mkdir(parents=True, exist_ok=True)
            partial = destination.with_name(f".{destination.name}.partial")
            try:
                with (source / relative).open("rb") as source_stream, partial.open("wb") as target_stream:
                    shutil.copyfileobj(source_stream, target_stream, self._copy_chunk_size)
                    target_stream.flush()
                    os.fsync(target_stream.fileno())
                os.replace(partial, destination)
                shutil.copystat(source / relative, destination, follow_symlinks=False)
            finally:
                partial.unlink(missing_ok=True)

        for path in sorted(transaction.rglob("*"), key=lambda item: len(item.parts), reverse=True):
            if path == transaction / ".manifest.json":
                continue
            relative = path.relative_to(transaction).as_posix()
            if path.is_file() and relative not in expected:
                path.unlink(missing_ok=True)
            elif path.is_dir():
                try:
                    path.rmdir()
                except OSError:
                    pass

        atomic_write_json(
            transaction / ".manifest.json",
            {"schemaVersion": 1, "taskId": task_id, "files": manifest},
        )
        for entry in manifest:
            destination = transaction / str(entry["path"])
            if not destination.is_file() or destination.stat().st_size != int(entry["size"]):
                raise MigrationError(f"迁移校验失败：{entry['path']} 大小不一致")
            if self._hash_path(task_id, destination) != str(entry["sha256"]):
                raise MigrationError(f"迁移校验失败：{entry['path']} SHA-256 不一致")

    @staticmethod
    def _manifest_snapshot(manifest: list[dict[str, object]]) -> list[tuple[str, int, int]]:
        return [
            (str(entry["path"]), int(entry["size"]), int(entry["mtimeNs"]))
            for entry in manifest
        ]

    @staticmethod
    def _manifest_content_snapshot(manifest: list[dict[str, object]]) -> list[tuple[str, int, str]]:
        return [
            (str(entry["path"]), int(entry["size"]), str(entry["sha256"]))
            for entry in manifest
        ]

    def _commit_transaction(
        self,
        task_id: str,
        source: Path,
        target: Path,
        transaction: Path,
    ) -> None:
        (transaction / ".manifest.json").unlink(missing_ok=True)
        moved: list[tuple[Path, Path]] = []
        try:
            for child in sorted(transaction.iterdir(), key=lambda item: item.name.lower()):
                destination = target / child.name
                if destination.exists():
                    raise MigrationError(f"目标目录出现冲突：{destination.name}")
                os.replace(child, destination)
                moved.append((destination, child))
            transaction.rmdir()
            self._save_bootstrap_target(task_id, source, target)
        except Exception:
            transaction.mkdir(parents=True, exist_ok=True)
            for destination, original in reversed(moved):
                if destination.exists() and not original.exists():
                    os.replace(destination, original)
            raise

    def _save_bootstrap_target(self, task_id: str, source: Path, target: Path) -> None:
        previous = self.bootstrap.load()
        self.bootstrap.save(
            BootstrapConfig(
                schema_version=1,
                edition=previous.edition if previous is not None else self.bootstrap.edition,
                data_root=str(target),
                last_started_version=(
                    previous.last_started_version if previous is not None else ""
                ),
                migration_id=task_id,
                migration_status="completed",
                previous_data_root=str(source),
            )
        )

    def _raise_if_cancelled(self, task_id: str) -> None:
        with self._lock:
            if self._tasks[task_id].cancel_event.is_set():
                raise _MigrationCancelled("迁移已取消")

    def _hash_path(self, task_id: str, path: Path) -> str:
        self._raise_if_cancelled(task_id)
        if self._hash_file is None:
            digest = _sha256_file(
                path,
                cancel_check=lambda: self._raise_if_cancelled(task_id),
            )
        else:
            digest = self._hash_file(path)
        self._raise_if_cancelled(task_id)
        return digest

    def _set_state(self, task_id: str, *, persist: bool = True, **changes: object) -> MigrationState:
        with self._lock:
            task = self._tasks[task_id]
            status = changes.get("status", task.state.status)
            if status not in MIGRATION_STATUSES:
                raise ValueError(f"未知迁移状态：{status}")
            task.state = replace(task.state, **changes)
            state = replace(task.state)
        if persist:
            self._persist(state)
        return state

    def _persist(self, state: MigrationState) -> None:
        if state.operation == "switch_storage":
            return
        path = Path(state.source) / "backups" / "migrations" / f"{state.id}.json"
        atomic_write_json(path, {"schemaVersion": 1, **state.as_dict()})

    def _timestamp(self) -> str:
        return self._clock().astimezone(timezone.utc).isoformat()


def _sha256_file(
    path: Path,
    *,
    chunk_size: int = 1024 * 1024,
    cancel_check: Callable[[], None] | None = None,
) -> str:
    if chunk_size <= 0:
        raise ValueError("chunk_size must be positive")
    digest = hashlib.sha256()
    if cancel_check is not None:
        cancel_check()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(chunk_size), b""):
            digest.update(chunk)
            if cancel_check is not None:
                cancel_check()
    return digest.hexdigest()


def _existing_parent(path: Path) -> Path:
    candidate = path
    while not candidate.exists() and candidate != candidate.parent:
        candidate = candidate.parent
    return candidate


def _excluded_from_migration(relative: Path) -> bool:
    parts = relative.parts
    if not parts:
        return False
    if parts[0].lower() in {"cache", "logs", "temp"}:
        return True
    return len(parts) >= 2 and parts[0].lower() == "backups" and parts[1].lower() == "migrations"
