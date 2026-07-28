import unittest
from unittest.mock import patch

import main


class StorageSelectionTests(unittest.TestCase):
    def test_storage_selection_saves_pointer_without_migration(self):
        saved = []
        payload = main.SoftwareStorageRequest(storage_root=r"X:\Hstar缓存")

        with (
            patch.object(main, "load_software_settings", return_value={}),
            patch.object(main, "save_software_settings", side_effect=lambda value: saved.append(value)),
            patch.object(main, "normalize_storage_root", return_value=r"X:\Hstar缓存"),
            patch.object(
                main,
                "migrate_runtime_data_to_storage",
                side_effect=AssertionError("storage selection must not migrate data"),
            ),
            patch.object(main, "STORAGE_ROOT", r"Y:\Hstar缓存"),
        ):
            response = main.save_software_storage(payload)

        self.assertEqual(saved, [{"storage_root": r"X:\Hstar缓存"}])
        self.assertEqual(response["settings"]["storage_root"], r"X:\Hstar缓存")
        self.assertTrue(response["settings"]["restart_required"])
        self.assertNotIn("migration", response["settings"])


if __name__ == "__main__":
    unittest.main()
