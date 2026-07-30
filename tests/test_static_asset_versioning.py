import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import main


class StaticAssetVersioningTests(unittest.TestCase):
    def test_preserves_one_revision_for_all_openshop_entry_assets(self):
        html = """
        <link href="/static/css/openshop-host.css?v=old">
        <script src="/static/openshop/host/openshop-protocol.js?v=old"></script>
        <script src="/static/js/openshop-host.js?v=old"></script>
        <script src="/static/js/canvas-openshop.js?v=old"></script>
        <script src="/static/js/smart-canvas-openshop.js?v=old"></script>
        <script src="/static/js/theme.js?v=old"></script>
        """

        with (
            patch.object(main, "current_app_version", return_value="2026.07.19"),
            patch.object(main.os.path, "isfile", return_value=True),
            patch.object(main.os.path, "getmtime", return_value=1234),
        ):
            versioned = main.versioned_static_html(html)

        revision = main.OPENSHOP_RUNTIME_REVISION
        for url in (
            "/static/css/openshop-host.css",
            "/static/openshop/host/openshop-protocol.js",
            "/static/js/openshop-host.js",
            "/static/js/canvas-openshop.js",
            "/static/js/smart-canvas-openshop.js",
        ):
            self.assertIn(f'{url}?v={revision}', versioned)
        self.assertIn('/static/js/theme.js?v=2026.07.19.1234', versioned)

    def test_sync_preserves_runtime_revision_for_openshop_relative_assets(self):
        with TemporaryDirectory() as directory:
            static_dir = Path(directory)
            openshop_dir = static_dir / "openshop"
            shared_js_dir = static_dir / "js"
            openshop_dir.mkdir()
            shared_js_dir.mkdir()
            (shared_js_dir / "voice-input-adapter.js").write_text("", encoding="utf-8")
            openshop_index = openshop_dir / "index.html"
            openshop_index.write_text(
                """
                <link href="./host/openshop-text-properties.css?v=old">
                <script src="./host/openshop-font-catalog.js?v=old"></script>
                <script src="./locales/zh-CN.js?v=old"></script>
                <script src="/static/js/voice-input-adapter.js?v=old"></script>
                """,
                encoding="utf-8",
            )

            with (
                patch.object(main, "PROGRAM_ROOT", static_dir.parent),
                patch.object(main, "STATIC_DIR", str(static_dir)),
                patch.object(main, "EDITION", "development"),
                patch.object(main, "current_app_version", return_value="2026.07.19"),
                patch.object(main.os.path, "getmtime", return_value=1234),
            ):
                main.sync_static_html_versions()

            synchronized = openshop_index.read_text(encoding="utf-8")

        revision = main.OPENSHOP_RUNTIME_REVISION
        self.assertIn(f'./host/openshop-text-properties.css?v={revision}', synchronized)
        self.assertIn(f'./host/openshop-font-catalog.js?v={revision}', synchronized)
        self.assertIn(f'./locales/zh-CN.js?v={revision}', synchronized)
        self.assertIn('/static/js/voice-input-adapter.js?v=2026.07.19.1234', synchronized)

    def test_sync_updates_shared_static_references_in_integration_entry_sources(self):
        with TemporaryDirectory() as directory:
            program_root = Path(directory)
            static_dir = program_root / "static"
            shared_js_dir = static_dir / "js"
            shared_js_dir.mkdir(parents=True)
            (shared_js_dir / "voice-input-adapter.js").write_text("", encoding="utf-8")
            static_index = static_dir / "index.html"
            static_index.write_text(
                '<script src="/static/js/voice-input-adapter.js?v=old"></script>',
                encoding="utf-8",
            )
            source_entries = (
                program_root / "integrations" / "openshop" / "index.html",
                program_root / "integrations" / "storyai-3d-director-desk" / "index.html",
            )
            for source_entry in source_entries:
                source_entry.parent.mkdir(parents=True)
                source_entry.write_text(
                    '<script src="/static/js/voice-input-adapter.js?v=old"></script>',
                    encoding="utf-8",
                )

            with (
                patch.object(main, "PROGRAM_ROOT", program_root),
                patch.object(main, "STATIC_DIR", str(static_dir)),
                patch.object(main, "EDITION", "development"),
                patch.object(main, "current_app_version", return_value="2026.07.19"),
                patch.object(main.os.path, "getmtime", return_value=1234),
            ):
                main.sync_static_html_versions()

            for entry in (static_index, *source_entries):
                synchronized = entry.read_text(encoding="utf-8")
                self.assertIn(
                    '/static/js/voice-input-adapter.js?v=2026.07.19.1234',
                    synchronized,
                )


if __name__ == "__main__":
    unittest.main()
