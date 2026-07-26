import hashlib
import shutil
import tempfile
import threading
import unittest
from datetime import datetime, timezone
from pathlib import Path
from unittest.mock import patch

from hstar_runtime.bootstrap import BootstrapConfig, BootstrapStore
from hstar_runtime.migration import MigrationManager


class RuntimeMigrationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.program = self.root / "program"
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.program.mkdir()
        self.source.mkdir()
        self.bootstrap = BootstrapStore(
            self.root / "appdata",
            "windows11",
            self.program,
            clock=lambda: datetime(2026, 7, 26, 16, 30, tzinfo=timezone.utc),
        )
        self.bootstrap.save(
            BootstrapConfig(1, "windows11", str(self.source))
        )

    def tearDown(self):
        self.temporary.cleanup()

    def manager(self, **overrides):
        return MigrationManager(
            self.bootstrap,
            self.program,
            clock=lambda: datetime(2026, 7, 26, 16, 30, tzinfo=timezone.utc),
            **overrides,
        )

    def test_copies_and_verifies_without_removing_source(self):
        source_file = self.source / "projects" / "canvases" / "canvas.json"
        source_file.parent.mkdir(parents=True)
        source_file.write_text('{"title":"测试"}', encoding="utf-8")

        manager = self.manager()
        task = manager.start(self.source, self.target)
        state = manager.wait(task.id, timeout=5)

        self.assertEqual(state.status, "completed")
        self.assertTrue(source_file.is_file())
        self.assertEqual(
            (self.target / "projects" / "canvases" / "canvas.json").read_text(encoding="utf-8"),
            '{"title":"测试"}',
        )
        self.assertEqual(self.bootstrap.require().data_root, str(self.target.resolve()))
        persisted = self.source / "backups" / "migrations" / f"{task.id}.json"
        self.assertTrue(persisted.is_file())

    def test_rejects_overlapping_source_and_target(self):
        manager = self.manager()
        task = manager.start(self.source, self.source / "nested")

        state = manager.wait(task.id, timeout=5)

        self.assertEqual(state.status, "failed")
        self.assertIn("不能互相包含", state.error)
        self.assertEqual(self.bootstrap.require().data_root, str(self.source.resolve()))

    def test_rejects_insufficient_space(self):
        (self.source / "large.bin").write_bytes(b"x" * 1024)
        disk_usage = shutil._ntuple_diskusage(total=2048, used=2048, free=0)
        manager = self.manager(disk_usage=lambda _path: disk_usage)

        task = manager.start(self.source, self.target)
        state = manager.wait(task.id, timeout=5)

        self.assertEqual(state.status, "failed")
        self.assertIn("空间不足", state.error)
        self.assertFalse((self.target / "large.bin").exists())

    def test_verification_failure_keeps_bootstrap_and_transaction(self):
        (self.source / "projects").mkdir()
        (self.source / "projects" / "canvas.json").write_bytes(b"canvas")

        def corrupt_target_hash(path: Path) -> str:
            if ".hstar-migration-" in str(path):
                return "0" * 64
            return hashlib.sha256(path.read_bytes()).hexdigest()

        manager = self.manager(hash_file=corrupt_target_hash)
        task = manager.start(self.source, self.target)
        state = manager.wait(task.id, timeout=5)

        self.assertEqual(state.status, "failed")
        self.assertIn("校验失败", state.error)
        self.assertEqual(self.bootstrap.require().data_root, str(self.source.resolve()))
        self.assertTrue((self.target / f".hstar-migration-{task.id}").is_dir())
        self.assertFalse((self.target / "projects" / "canvas.json").exists())

    def test_cancelled_copy_can_resume(self):
        (self.source / "projects").mkdir()
        (self.source / "projects" / "large.bin").write_bytes(b"a" * (256 * 1024))
        entered = threading.Event()
        release = threading.Event()
        blocked_once = False

        def after_chunk(_state):
            nonlocal blocked_once
            if blocked_once:
                return
            blocked_once = True
            entered.set()
            release.wait(timeout=5)

        manager = self.manager(copy_chunk_size=1024, after_chunk=after_chunk)
        task = manager.start(self.source, self.target)
        self.assertTrue(entered.wait(timeout=5))
        manager.cancel(task.id)
        release.set()
        cancelled = manager.wait(task.id, timeout=5)

        self.assertEqual(cancelled.status, "cancelled")
        self.assertTrue((self.target / f".hstar-migration-{task.id}").is_dir())

        resumed = manager.resume(task.id)
        completed = manager.wait(resumed.id, timeout=5)
        self.assertEqual(completed.status, "completed")
        self.assertEqual(
            (self.target / "projects" / "large.bin").stat().st_size,
            256 * 1024,
        )

    def test_existing_target_content_is_not_overwritten(self):
        self.target.mkdir()
        existing = self.target / "projects" / "canvas.json"
        existing.parent.mkdir()
        existing.write_text("existing", encoding="utf-8")
        (self.source / "projects").mkdir()
        (self.source / "projects" / "canvas.json").write_text("source", encoding="utf-8")

        manager = self.manager()
        task = manager.start(self.source, self.target)
        state = manager.wait(task.id, timeout=5)

        self.assertEqual(state.status, "failed")
        self.assertIn("目标目录必须为空", state.error)
        self.assertEqual(existing.read_text(encoding="utf-8"), "existing")

    def test_bootstrap_switch_failure_rolls_files_back_into_transaction(self):
        (self.source / "projects").mkdir()
        (self.source / "projects" / "canvas.json").write_text("source", encoding="utf-8")
        manager = self.manager()

        with patch.object(self.bootstrap, "save", side_effect=OSError("bootstrap locked")):
            task = manager.start(self.source, self.target)
            state = manager.wait(task.id, timeout=5)

        self.assertEqual(state.status, "failed")
        self.assertIn("bootstrap locked", state.error)
        self.assertEqual(self.bootstrap.require().data_root, str(self.source.resolve()))
        transaction_file = (
            self.target
            / f".hstar-migration-{task.id}"
            / "projects"
            / "canvas.json"
        )
        self.assertTrue(transaction_file.is_file())
        self.assertFalse((self.target / "projects").exists())

if __name__ == "__main__":
    unittest.main()
