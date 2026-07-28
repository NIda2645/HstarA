import atexit
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

_MODULE_RUNTIME = tempfile.TemporaryDirectory(prefix="hstar-canvas-safety-runtime-")
atexit.register(_MODULE_RUNTIME.cleanup)
os.environ["HSTAR_DATA_DIR"] = str(Path(_MODULE_RUNTIME.name) / "data")
os.environ["HSTAR_EDITION"] = "test-canvas-safety"

import main


class CanvasStorageSafetyTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.canvas_dir = Path(self.temporary.name) / "canvases"
        self.canvas_dir.mkdir()
        self.patchers = [
            patch.object(main, "CANVAS_DIR", str(self.canvas_dir)),
            patch.object(main, "LEGACY_CANVAS_DIR", ""),
        ]
        for patcher in self.patchers:
            patcher.start()

    def tearDown(self):
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    def test_canvas_id_validation_rejects_lossy_normalization(self):
        self.assertEqual(main.cleaned_canvas_id("canvas-1_ok"), "canvas-1_ok")
        for invalid in ("canvas-1!", "../canvas-1", "canvas 1", "x" * 121):
            with self.subTest(invalid=invalid):
                with self.assertRaises(main.HTTPException) as error:
                    main.cleaned_canvas_id(invalid)
                self.assertEqual(error.exception.status_code, 400)

    def test_load_rejects_document_id_that_disagrees_with_filename(self):
        path = self.canvas_dir / "requested.json"
        path.write_text(
            json.dumps({"id": "different", "nodes": [], "connections": []}),
            encoding="utf-8",
        )

        with self.assertRaises(main.HTTPException) as error:
            main.load_canvas("requested")

        self.assertEqual(error.exception.status_code, 409)
        self.assertEqual(json.loads(path.read_text(encoding="utf-8"))["id"], "different")

    def test_removing_openshop_nodes_collects_legacy_assets(self):
        owner = {"canvasType": "classic", "canvasId": "canvas-1", "nodeId": "node-1"}
        with (
            patch.object(main.OPENSHOP_STORE, "delete", return_value=True),
            patch.object(main.OPENSHOP_AI_TASKS, "cancel_project"),
            patch.object(main, "collect_openshop_garbage") as collect,
        ):
            removed = main.remove_openshop_projects(
                {("node-1", "project-1")}, "classic", "canvas-1"
            )

        self.assertEqual(removed, ["project-1"])
        collect.assert_called_once_with(include_legacy=True)

    def test_purging_canvas_collects_legacy_assets(self):
        path = self.canvas_dir / "canvas-1.json"
        path.write_text(
            json.dumps({"id": "canvas-1", "kind": "classic", "nodes": [], "connections": []}),
            encoding="utf-8",
        )
        removed_record = {"projectId": "project-1", "owner": {"canvasId": "canvas-1"}}
        with (
            patch.object(main.OPENSHOP_STORE, "delete_canvas_projects", return_value=[removed_record]),
            patch.object(main.OPENSHOP_AI_TASKS, "cancel_project"),
            patch.object(main, "collect_openshop_garbage") as collect,
        ):
            deleted = main.purge_canvas_storage("canvas-1")

        self.assertTrue(deleted)
        collect.assert_called_once_with(include_legacy=True)


if __name__ == "__main__":
    unittest.main()
