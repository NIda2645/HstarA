import asyncio
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
    async def test_voice_prewarm_starts_before_startup_maintenance(self):
        events = []
        voice_manager = StartupVoiceManager(events)

        def record_sync():
            events.append(("sync-static", voice_manager.prewarm_started))

        def record_maintenance(name):
            return lambda: events.append(name)

        with (
            patch.object(main, "VOICE_ASSISTANT", voice_manager),
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


if __name__ == "__main__":
    unittest.main()
