import os
import unittest
from pathlib import Path

from voice_assistant.settings import normalize_voice_settings, voice_paths


class VoiceSettingsTests(unittest.TestCase):
    def test_custom_root_wins(self):
        settings = {
            "storage_root": "D:/Hstar",
            "voice_assistant": {
                "storage_mode": "custom",
                "storage_root": "E:/Speech",
            },
        }

        value = normalize_voice_settings(
            settings,
            app_data_root="C:/AppData/Hstar",
        )

        self.assertEqual(value.effective_root, os.path.abspath("E:/Speech"))

    def test_inherit_uses_software_storage(self):
        value = normalize_voice_settings(
            {"storage_root": "D:/Hstar", "voice_assistant": {}},
            app_data_root="C:/AppData/Hstar",
        )

        self.assertEqual(
            value.effective_root,
            os.path.abspath("D:/Hstar/voice-assistant"),
        )

    def test_default_uses_appdata_not_install_dir(self):
        value = normalize_voice_settings(
            {},
            app_data_root="C:/AppData/Hstar",
        )

        self.assertEqual(
            value.effective_root,
            os.path.abspath("C:/AppData/Hstar/voice-assistant"),
        )
        self.assertEqual(value.silence_stop_seconds, 10)
        self.assertEqual(value.shortcut, "Shift+Q")

    def test_voice_paths_keep_runtime_and_model_under_effective_root(self):
        value = normalize_voice_settings(
            {
                "voice_assistant": {
                    "storage_mode": "custom",
                    "storage_root": "E:/Speech",
                }
            },
            app_data_root="C:/AppData/Hstar",
        )

        paths = voice_paths(value)

        root = Path(os.path.abspath("E:/Speech"))
        self.assertEqual(paths["root"], root)
        self.assertEqual(
            paths["runtime_site"],
            root / ".hstar-voice" / "runtime" / "site-packages",
        )
        self.assertEqual(
            paths["model"],
            root / "FunAudioLLM" / "Fun-ASR-Nano-2512",
        )


if __name__ == "__main__":
    unittest.main()
