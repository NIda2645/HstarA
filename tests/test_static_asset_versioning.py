import unittest
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


if __name__ == "__main__":
    unittest.main()
