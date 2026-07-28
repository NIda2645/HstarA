import unittest
from unittest.mock import patch

import main


class StartupEventTests(unittest.IsolatedAsyncioTestCase):
    def test_packaged_startup_never_rewrites_program_static_files(self):
        with (
            patch.object(main, "EDITION", "windows11"),
            patch.object(main.os, "walk") as walk_static_tree,
        ):
            main.sync_static_html_versions()
        walk_static_tree.assert_not_called()

    async def test_startup_runs_current_maintenance_in_order(self):
        events = []

        def record_sync():
            events.append("sync-static")

        def record_maintenance(name):
            return lambda: events.append(name)

        with (
            patch.object(main, "sync_static_html_versions", record_sync),
            patch.object(
                main,
                "migrate_asset_library_into_dirs",
                record_maintenance("migrate-assets"),
            ),
            patch.object(
                main,
                "migrate_double_extension_uploads",
                record_maintenance("migrate-double-extensions"),
            ),
            patch.object(
                main,
                "migrate_mislabeled_image_extensions",
                record_maintenance("migrate-image-extensions"),
            ),
        ):
            await main.startup_event()

        self.assertEqual(
            events,
            [
                "sync-static",
                "migrate-assets",
                "migrate-double-extensions",
                "migrate-image-extensions",
            ],
        )


if __name__ == "__main__":
    unittest.main()
