import asyncio
import atexit
import os
import tempfile
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
from hstar_runtime.storage_barrier import StorageMutationBarrier


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
        self.barrier = StorageMutationBarrier()
        self.manager = MigrationManager(
            self.bootstrap,
            self.program,
            switch_guard=self.barrier.switch_to_read_only,
        )
        self.patchers = [
            patch.object(main, "STORAGE_MIGRATIONS", self.manager, create=True),
            patch.object(main, "STORAGE_WRITE_BARRIER", self.barrier, create=True),
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

    async def test_empty_target_switches_without_copying_source_data(self):
        source_canvas = self.source / "projects" / "canvas.json"
        source_before = source_canvas.stat()
        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        task_id = response.json()["task"]["id"]
        task = await self.wait_for_terminal_state(task_id)
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["operation"], "switch_storage")
        self.assertEqual(task["copied_bytes"], 0)
        self.assertEqual(task["total_bytes"], 0)
        self.assertTrue(task["restart_required"])
        self.assertFalse((self.target / "projects" / "canvas.json").exists())
        self.assertEqual(source_canvas.read_text(encoding="utf-8"), "canvas")
        self.assertEqual(source_canvas.stat().st_mtime_ns, source_before.st_mtime_ns)

    async def test_overlapping_target_returns_localized_400(self):
        nested_target = self.source / "nested"
        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(nested_target)},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("不能互相包含", response.json()["detail"])
        self.assertFalse(nested_target.exists())

    async def test_existing_legacy_hstar_root_is_activated_without_modification(self):
        legacy_canvas = self.target / "data" / "canvases" / "legacy.json"
        legacy_canvas.parent.mkdir(parents=True)
        legacy_canvas.write_bytes(b'{"id":"legacy"}')
        original_stat = legacy_canvas.stat()

        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        task_id = response.json()["task"]["id"]
        task = await self.wait_for_terminal_state(task_id)
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["operation"], "switch_storage")
        self.assertTrue(task["restart_required"])
        self.assertEqual(self.bootstrap.require().data_root, str(self.target.resolve()))
        self.assertEqual(legacy_canvas.read_bytes(), b'{"id":"legacy"}')
        self.assertEqual(legacy_canvas.stat().st_mtime_ns, original_stat.st_mtime_ns)
        self.assertFalse((self.target / "projects").exists())

    async def test_existing_root_can_replace_an_explicit_in_program_runtime_source(self):
        explicit_source = self.program / "temporary-runtime-data"
        explicit_source.mkdir()
        (explicit_source / "session.txt").write_text("temporary", encoding="utf-8")
        legacy_canvas = self.target / "data" / "canvases" / "legacy.json"
        legacy_canvas.parent.mkdir(parents=True)
        legacy_canvas.write_text('{"id":"legacy"}', encoding="utf-8")
        self.bootstrap.path.unlink()
        main.STORAGE_ROOT = str(explicit_source)

        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        task = await self.wait_for_terminal_state(response.json()["task"]["id"])
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["operation"], "switch_storage")
        self.assertEqual(self.bootstrap.require().data_root, str(self.target.resolve()))
        self.assertEqual(legacy_canvas.read_text(encoding="utf-8"), '{"id":"legacy"}')

    async def test_empty_root_can_replace_an_explicit_in_program_runtime_source(self):
        explicit_source = self.program / "temporary-runtime-data"
        explicit_source.mkdir()
        (explicit_source / "session.txt").write_text("temporary", encoding="utf-8")
        self.bootstrap.path.unlink()
        main.STORAGE_ROOT = str(explicit_source)

        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        task = await self.wait_for_terminal_state(response.json()["task"]["id"])
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["operation"], "switch_storage")
        self.assertEqual(self.bootstrap.require().data_root, str(self.target.resolve()))
        self.assertFalse((self.target / "session.txt").exists())
        self.assertEqual((explicit_source / "session.txt").read_text(encoding="utf-8"), "temporary")

    async def test_unrecognized_nonempty_target_switches_without_modification(self):
        self.target.mkdir()
        existing = self.target / "notes.txt"
        existing.write_text("keep", encoding="utf-8")
        original_stat = existing.stat()

        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        task = await self.wait_for_terminal_state(response.json()["task"]["id"])
        self.assertEqual(task["status"], "completed")
        self.assertEqual(task["operation"], "switch_storage")
        self.assertEqual(existing.read_text(encoding="utf-8"), "keep")
        self.assertEqual(existing.stat().st_mtime_ns, original_stat.st_mtime_ns)
        self.assertEqual(self.bootstrap.require().data_root, str(self.target.resolve()))

    async def test_completed_migration_keeps_reads_available_and_rejects_new_writes(self):
        response = await self.client.post(
            "/api/storage-migrations",
            json={"storage_root": str(self.target)},
        )
        task_id = response.json()["task"]["id"]
        task = await self.wait_for_terminal_state(task_id)
        self.assertEqual(task["status"], "completed")

        read_response = await self.client.get("/api/software-settings")
        write_response = await self.client.post(
            "/api/software-settings/storage",
            json={"storage_root": str(self.root / "unused")},
        )

        self.assertEqual(read_response.status_code, 200, read_response.text)
        self.assertEqual(write_response.status_code, 503, write_response.text)
        self.assertEqual(write_response.json()["detail"]["code"], "STORAGE_RESTART_REQUIRED")

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
