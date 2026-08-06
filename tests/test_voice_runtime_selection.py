import tempfile
import unittest
from pathlib import Path

from voice_assistant import manager as manager_module


class VoiceRuntimeSelectionTests(unittest.TestCase):
    def test_packaged_app_prefers_bundled_voice_python(self):
        resolver = getattr(manager_module, "resolve_voice_python_executable", None)
        self.assertTrue(callable(resolver), "voice runtime resolver is required")

        with tempfile.TemporaryDirectory() as root:
            program_root = Path(root)
            bundled = program_root / "runtime" / "voice-python" / "python.exe"
            bundled.parent.mkdir(parents=True)
            bundled.touch()

            selected = resolver(program_root, "C:/fallback/python.exe", environ={})

        self.assertEqual(selected, str(bundled.resolve()))

    def test_development_app_uses_current_python_without_bundle(self):
        resolver = getattr(manager_module, "resolve_voice_python_executable", None)
        self.assertTrue(callable(resolver), "voice runtime resolver is required")

        with tempfile.TemporaryDirectory() as root:
            selected = resolver(root, "C:/dev/python.exe", environ={})

        self.assertEqual(selected, "C:/dev/python.exe")


if __name__ == "__main__":
    unittest.main()
