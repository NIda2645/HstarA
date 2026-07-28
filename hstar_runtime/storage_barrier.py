from __future__ import annotations

import asyncio
import threading
from contextlib import contextmanager
from contextvars import ContextVar
from typing import Coroutine, Iterator


class StorageMutationBlocked(RuntimeError):
    def __init__(self, reason: str):
        self.reason = reason
        message = (
            "数据目录迁移正在完成，请稍候"
            if reason == "switching"
            else "数据目录已切换，请重启 Hstar 后继续操作"
        )
        super().__init__(message)


class StorageMutationBarrier:
    """Coordinates the final storage switch with process-local writers."""

    def __init__(self):
        self._condition = threading.Condition(threading.RLock())
        self._active_mutations = 0
        self._background_tasks = 0
        self._switching = False
        self._read_only = False
        self._admitted_work = ContextVar(
            f"hstar_storage_admitted_{id(self)}",
            default=False,
        )

    @contextmanager
    def mutation(self) -> Iterator[None]:
        with self._condition:
            self._raise_if_blocked()
            self._active_mutations += 1
        try:
            yield
        finally:
            with self._condition:
                self._active_mutations -= 1
                self._condition.notify_all()

    def create_task(self, coroutine: Coroutine) -> asyncio.Task:
        with self._condition:
            if self._read_only:
                raise StorageMutationBlocked("read-only")
            if (
                self._switching
                and not self._active_mutations
                and not self._admitted_work.get()
            ):
                raise StorageMutationBlocked("switching")
            self._background_tasks += 1

        async def run_admitted():
            admission = self._admitted_work.set(True)
            try:
                return await coroutine
            finally:
                self._admitted_work.reset(admission)

        admitted_coroutine = run_admitted()
        try:
            task = asyncio.create_task(admitted_coroutine)
        except BaseException:
            admitted_coroutine.close()
            close_coroutine = getattr(coroutine, "close", None)
            if callable(close_coroutine):
                close_coroutine()
            with self._condition:
                self._background_tasks -= 1
                self._condition.notify_all()
            raise
        task.add_done_callback(self._background_task_finished)
        return task

    @contextmanager
    def switch_to_read_only(self) -> Iterator[None]:
        with self._condition:
            self._raise_if_blocked()
            self._switching = True
            while self._active_mutations or self._background_tasks:
                self._condition.wait()
        try:
            yield
        except BaseException:
            with self._condition:
                self._switching = False
                self._condition.notify_all()
            raise
        else:
            with self._condition:
                self._switching = False
                self._read_only = True
                self._condition.notify_all()

    def _background_task_finished(self, _task: asyncio.Task) -> None:
        with self._condition:
            self._background_tasks -= 1
            self._condition.notify_all()

    def _raise_if_blocked(self) -> None:
        if self._read_only:
            raise StorageMutationBlocked("read-only")
        if self._switching:
            raise StorageMutationBlocked("switching")
