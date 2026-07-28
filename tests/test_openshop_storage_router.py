import base64
import tempfile
import unittest
from pathlib import Path

from openshop_projects import OpenShopNotFound, OpenShopProjectStore, OpenShopStorageRouter


PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
)


class OpenShopStorageRouterTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        root = Path(self.temporary.name)
        self.primary_canvas_dir = root / "modern-canvases"
        self.legacy_canvas_dir = root / "legacy-canvases"
        self.primary_canvas_dir.mkdir()
        self.legacy_canvas_dir.mkdir()
        self.primary_store = OpenShopProjectStore(
            root / "modern-openshop", canvas_dir=self.primary_canvas_dir
        )
        self.legacy_store = OpenShopProjectStore(
            root / "legacy-openshop",
            canvas_dir=self.legacy_canvas_dir,
            migrate_legacy_projects=False,
        )
        self.router = OpenShopStorageRouter(
            self.primary_store,
            self.legacy_store,
            primary_canvas_dir=str(self.primary_canvas_dir),
            legacy_canvas_dir=str(self.legacy_canvas_dir),
        )
        self.owner = {
            "canvasType": "classic",
            "canvasId": "legacy-canvas",
            "nodeId": "legacy-node",
        }
        (self.legacy_canvas_dir / "legacy-canvas.json").write_text("{}", encoding="utf-8")

    def tearDown(self):
        self.temporary.cleanup()

    def test_legacy_assets_are_collected_only_when_explicitly_requested(self):
        project = self.router.initialize(
            "legacy-project", self.owner, {"width": 1, "height": 1}
        )
        asset = self.router.store_image(
            "legacy-project", self.owner, PNG_1X1, "image/png", "legacy.png", "asset"
        )
        project["assetRefs"] = [asset["assetId"]]
        self.router.save(
            "legacy-project", self.owner, project, project["autosaveVersion"]
        )
        self.router.delete("legacy-project", self.owner)

        self.assertEqual(self.router.collect_garbage(), [])
        self.assertTrue(Path(self.legacy_store.asset_path(asset["assetId"])[0]).is_file())

        self.assertEqual(
            self.router.collect_garbage(include_legacy=True), [asset["assetId"]]
        )
        with self.assertRaises(OpenShopNotFound):
            self.legacy_store.asset_path(asset["assetId"])


if __name__ == "__main__":
    unittest.main()
