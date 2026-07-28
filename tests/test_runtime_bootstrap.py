import json
import tempfile
import unittest
from datetime import datetime, timezone
from pathlib import Path

from hstar_runtime.bootstrap import BootstrapConfig, BootstrapStore


class BootstrapStoreTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.program_root = self.root / "program"
        self.appdata_root = self.root / "appdata"
        self.data_root = self.root / "data"
        self.program_root.mkdir()
        self.store = BootstrapStore(
            self.appdata_root,
            "windows11",
            self.program_root,
            clock=lambda: datetime(2026, 7, 26, 16, 30, tzinfo=timezone.utc),
        )

    def tearDown(self):
        self.temporary.cleanup()

    def test_missing_bootstrap_returns_none_and_require_raises(self):
        self.assertIsNone(self.store.load())
        with self.assertRaisesRegex(RuntimeError, "尚未配置 Hstar 数据目录"):
            self.store.require()

    def test_atomic_save_round_trips_exact_schema(self):
        config = BootstrapConfig(
            schema_version=1,
            edition="windows11",
            data_root=str(self.data_root),
            last_started_version="2026.07.26.1630000001",
            migration_id="migration-1",
            migration_status="copying",
            previous_data_root=str(self.root / "old-data"),
        )

        self.store.save(config)

        loaded = self.store.require()
        self.assertEqual(loaded.data_root, str(self.data_root.resolve()))
        self.assertEqual(loaded.migration_id, "migration-1")
        self.assertEqual(loaded.migration_status, "copying")
        document = json.loads(self.store.path.read_text(encoding="utf-8"))
        self.assertEqual(document["schemaVersion"], 1)
        self.assertEqual(document["dataRoot"], str(self.data_root.resolve()))
        self.assertEqual(document["migration"]["previousDataRoot"], str(self.root / "old-data"))
        self.assertEqual(list(self.store.path.parent.glob("*.tmp")), [])

    def test_save_rejects_edition_mismatch(self):
        config = BootstrapConfig(
            schema_version=1,
            edition="classic",
            data_root=str(self.data_root),
        )

        with self.assertRaisesRegex(ValueError, "版本不匹配"):
            self.store.save(config)

    def test_save_rejects_data_root_inside_program_root(self):
        config = BootstrapConfig(
            schema_version=1,
            edition="windows11",
            data_root=str(self.program_root / "data"),
        )

        with self.assertRaisesRegex(ValueError, "不能位于 Hstar 程序目录内"):
            self.store.save(config)

    def test_truncated_json_is_quarantined_before_returning_none(self):
        self.store.path.parent.mkdir(parents=True)
        self.store.path.write_text('{"schemaVersion": 1,', encoding="utf-8")

        self.assertIsNone(self.store.load())

        corrupt = self.store.path.with_name("bootstrap.json.corrupt-20260726-163000")
        self.assertTrue(corrupt.is_file())
        self.assertFalse(self.store.path.exists())

    def test_wrong_edition_document_is_quarantined(self):
        self.store.path.parent.mkdir(parents=True)
        self.store.path.write_text(
            json.dumps(
                {
                    "schemaVersion": 1,
                    "edition": "classic",
                    "dataRoot": str(self.data_root.resolve()),
                }
            ),
            encoding="utf-8",
        )

        self.assertIsNone(self.store.load())
        self.assertTrue(
            self.store.path.with_name("bootstrap.json.corrupt-20260726-163000").is_file()
        )


if __name__ == "__main__":
    unittest.main()
