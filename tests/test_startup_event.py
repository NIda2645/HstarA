import asyncio
import os
import tempfile
import unittest
from unittest.mock import patch

import main


class StartupVoiceManager:
    def __init__(self, events):
        self.events = events
        self.prewarm_started = False
        self.prewarm_task = None

    def schedule_background_tasks(self):
        self.events.append("voice-scheduled")
        self.prewarm_task = asyncio.create_task(self._prewarm())

    async def _prewarm(self):
        self.prewarm_started = True
        self.events.append("voice-prewarm-started")


class StartupEventTests(unittest.IsolatedAsyncioTestCase):
    def test_packaged_startup_never_rewrites_program_static_files(self):
        with (
            patch.object(main, "EDITION", "windows11"),
            patch.object(main.os, "walk") as walk_static_tree,
        ):
            main.sync_static_html_versions()
        walk_static_tree.assert_not_called()

    async def test_voice_prewarm_starts_before_startup_maintenance(self):
        events = []
        voice_manager = StartupVoiceManager(events)

        def record_sync():
            events.append(("sync-static", voice_manager.prewarm_started))

        def record_maintenance(name):
            return lambda: events.append(name)

        with (
            patch.object(main, "VOICE_ASSISTANT", voice_manager),
            patch.object(main, "PRESERVE_EXISTING_DATA_ON_STARTUP", False),
            patch.object(main, "MODERN_STORAGE_ACTIVE_ON_STARTUP", True),
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
            patch.object(
                main,
                "reconcile_saved_openshop_projects",
                record_maintenance("reconcile-openshop"),
            ),
        ):
            await main.startup_event()

        if voice_manager.prewarm_task:
            await voice_manager.prewarm_task

        self.assertEqual(events[0:2], ["voice-scheduled", "voice-prewarm-started"])
        self.assertIn(("sync-static", True), events)

    async def test_existing_legacy_cache_startup_skips_data_maintenance(self):
        events = []
        voice_manager = StartupVoiceManager(events)

        def record(name):
            return lambda: events.append(name)

        with (
            patch.object(main, "VOICE_ASSISTANT", voice_manager),
            patch.object(main, "PRESERVE_EXISTING_DATA_ON_STARTUP", True),
            patch.object(main, "MODERN_STORAGE_ACTIVE_ON_STARTUP", False),
            patch.object(main, "CANVAS_DIR", os.path.join(tempfile.gettempdir(), "hstar-missing-modern-canvases")),
            patch.object(main, "sync_static_html_versions", record("sync-static")),
            patch.object(main, "migrate_asset_library_into_dirs", record("migrate-assets")),
            patch.object(main, "migrate_double_extension_uploads", record("migrate-double-extensions")),
            patch.object(main, "migrate_mislabeled_image_extensions", record("migrate-image-extensions")),
            patch.object(main, "reconcile_saved_openshop_projects", record("reconcile-openshop")),
        ):
            await main.startup_event()

        self.assertEqual(events, ["sync-static"])

    async def test_mixed_storage_startup_maintains_only_modern_layout(self):
        events = []
        voice_manager = StartupVoiceManager(events)

        def record(name):
            return lambda: events.append(name)

        with tempfile.TemporaryDirectory() as canvas_dir:
            with (
                patch.object(main, "VOICE_ASSISTANT", voice_manager),
                patch.object(main, "PRESERVE_EXISTING_DATA_ON_STARTUP", True),
                patch.object(main, "MODERN_STORAGE_ACTIVE_ON_STARTUP", True),
                patch.object(main, "CANVAS_DIR", canvas_dir),
                patch.object(main, "sync_static_html_versions", record("sync-static")),
                patch.object(main, "migrate_asset_library_into_dirs", record("migrate-assets")),
                patch.object(main, "migrate_double_extension_uploads", record("migrate-double-extensions")),
                patch.object(main, "migrate_mislabeled_image_extensions", record("migrate-image-extensions")),
                patch.object(main, "reconcile_saved_openshop_projects", record("reconcile-openshop")),
            ):
                await main.startup_event()

        if voice_manager.prewarm_task:
            await voice_manager.prewarm_task

        self.assertIn("voice-scheduled", events)
        self.assertIn("sync-static", events)
        self.assertIn("reconcile-openshop", events)
        self.assertNotIn("migrate-assets", events)
        self.assertNotIn("migrate-double-extensions", events)
        self.assertNotIn("migrate-image-extensions", events)


if __name__ == "__main__":
    unittest.main()
