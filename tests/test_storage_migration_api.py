import asyncio
import atexit
import os
import tempfile
import threading
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx

_MODULE_RUNTIME = tempfile.TemporaryDirectory(prefix="hstar-storage-api-runtime-")
atexit.register(_MODULE_RUNTIME.cleanup)
os.environ["HSTAR_DATA_DIR"] = str(Path(_MODULE_RUNTIME.name) / "data")
os.environ["HSTAR_EDITION"] = "test-storage-api"

import main
from hstar_runtime.bootstrap import BootstrapConfig, BootstrapStore
from hstar_runtime.migration import MigrationManager


class StorageMigrationApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.program = self.root / "program"
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.program.mkdir()
        self.source.mkdir()
        (self.source / "projects").mkdir()
        (self.source / "projects" / "canvas.json").write_text("canvas", encoding="utf-8")
        self.bootstrap = BootstrapStore(
            self.root / "appdata",
            "windows11",
            self.program,
        )
        self.bootstrap.save(BootstrapConfig(1, "windows11", str(self.source)))
        self.manager = MigrationManager(self.bootstrap, self.program)
        self.patchers = [
            patch.object(main, "STORAGE_MIGRATIONS", self.manager, create=True),
            patch.object(main, "STORAGE_ROOT", str(self.source)),
            patch.object(main, "DATA_DIR", str(self.source / "config")),
            patch.object(main, "ASSETS_DIR", str(self.source / "assets")),
            patch.object(main, "OUTPUT_DIR", str(self.source / "outputs")),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app, client=("127.0.0.1", 42000)),
            base_url="http://127.0.0.1",
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    async def wait_for_terminal_state(self, task_id):
        for _ in range(100):
            response = await self.client.get(f"/api/storage-migrations/{task_id}")
            self.assertEqual(response.status_code, 200, response.text)
            task = response.json()["task"]
            if task["status"] in {"completed", "cancelled", "failed"}:
                return task
            await asyncio.sleep(0.01)
        self.fail("migration did not reach a terminal state")

    async def test_start_and_poll_completed_migration(self):
        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        task_id = response.json()["task"]["id"]
        task = await self.wait_for_terminal_state(task_id)
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["copied_bytes"], task["total_bytes"])
        self.assertTrue(task["restart_required"])

    async def test_overlapping_target_returns_localized_400(self):
        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.source / "nested")},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("不能互相包含", response.json()["detail"])

    async def test_cancel_is_idempotent(self):
        entered = threading.Event()
        release = threading.Event()

        def after_chunk(_state):
            entered.set()
            release.wait(timeout=5)

        self.manager = MigrationManager(
            self.bootstrap,
            self.program,
            copy_chunk_size=1,
            after_chunk=after_chunk,
        )
        main.STORAGE_MIGRATIONS = self.manager
        (self.source / "projects" / "canvas.json").write_text("canvas-data", encoding="utf-8")
        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )
        task_id = response.json()["task"]["id"]
        self.assertTrue(await asyncio.to_thread(entered.wait, 5))

        first = await self.client.delete(f"/api/storage-migrations/{task_id}")
        second = await self.client.delete(f"/api/storage-migrations/{task_id}")
        release.set()
        task = await self.wait_for_terminal_state(task_id)

        self.assertEqual(first.status_code, 200)
        self.assertEqual(second.status_code, 200)
        self.assertEqual(task["status"], "cancelled")

    async def test_remote_status_does_not_expose_source_path(self):
        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )
        task_id = response.json()["task"]["id"]
        await self.wait_for_terminal_state(task_id)
        remote = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app, client=("10.20.30.40", 42000)),
            base_url="http://hstar.test",
        )
        try:
            status = await remote.get(f"/api/storage-migrations/{task_id}")
        finally:
            await remote.aclose()

        self.assertEqual(status.status_code, 200)
        self.assertNotIn("source", status.json()["task"])

    async def test_old_blocking_endpoint_returns_410(self):
        response = await self.client.post(
            "/api/software-settings/storage",
            json={"storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 410)
        self.assertEqual(response.json()["detail"]["endpoint"], "/api/storage-migrations")


if __name__ == "__main__":
    unittest.main()
