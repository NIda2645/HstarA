import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from hstar_runtime.atomic import atomic_create_json, atomic_write_json


class RuntimeAtomicTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_atomic_write_failure_preserves_existing_document(self):
        target = self.root / "canvas.json"
        target.write_text('{"id":"original"}', encoding="utf-8")

        with patch("hstar_runtime.atomic.os.replace", side_effect=OSError("disk error")):
            with self.assertRaisesRegex(OSError, "disk error"):
                atomic_write_json(target, {"id": "replacement"})

        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["id"], "original")
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_atomic_create_rejects_existing_document_without_overwrite(self):
        target = self.root / "canvas.json"
        atomic_create_json(target, {"id": "first"})

        with self.assertRaises(FileExistsError):
            atomic_create_json(target, {"id": "second"})

        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["id"], "first")
        self.assertEqual(list(self.root.glob("*.tmp")), [])

    def test_atomic_create_does_not_require_hard_link_support_on_windows(self):
        target = self.root / "canvas.json"

        with patch("hstar_runtime.atomic.os.name", "nt"), patch(
            "hstar_runtime.atomic.os.link",
            side_effect=OSError("hard links are not supported"),
        ) as hard_link:
            atomic_create_json(target, {"id": "portable"})

        hard_link.assert_not_called()
        self.assertEqual(json.loads(target.read_text(encoding="utf-8"))["id"], "portable")
        self.assertEqual(list(self.root.glob("*.tmp")), [])


if __name__ == "__main__":
    unittest.main()
