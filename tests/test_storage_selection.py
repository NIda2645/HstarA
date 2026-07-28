import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import main
from hstar_runtime.migration import MigrationState


class StorageSelectionTests(unittest.TestCase):
    def test_storage_selection_routes_to_pointer_switch_without_copy_migration(self):
        source = Path(r"Y:\Hstar缓存")
        target = Path(r"X:\Hstar缓存")
        payload = main.StorageMigrationRequest(storage_root=str(target))
        state = MigrationState(
            id="storage-switch",
            status="preflight",
            source=str(source.resolve()),
            target=str(target.resolve()),
            operation="switch_storage",
        )
        manager = SimpleNamespace(
            switch_storage=lambda actual_source, actual_target: state,
            start=lambda *_args, **_kwargs: self.fail("storage selection must not copy data"),
        )
        request = SimpleNamespace(client=SimpleNamespace(host="127.0.0.1"))

        with (
            patch.object(main, "normalize_storage_root", return_value=str(target.resolve())),
            patch.object(main, "validate_storage_migration_target"),
            patch.object(main, "STORAGE_MIGRATIONS", manager),
            patch.object(main, "STORAGE_ROOT", str(source.resolve())),
        ):
            response = main.start_storage_migration(payload, request)

        self.assertTrue(response["ok"])
        self.assertEqual(response["task"]["operation"], "switch_storage")
        self.assertFalse(response["task"]["restart_required"])


if __name__ == "__main__":
    unittest.main()
