import asyncio
import os
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from voice_assistant.service import serve
from voice_assistant.testing import FakeRecognizer, FakeVad


def pcm_for_seconds(seconds: float, sample: int = 1) -> bytes:
    samples = round(16_000 * seconds)
    return int(sample).to_bytes(2, "little", signed=True) * samples


class VoiceTestingTests(unittest.TestCase):
    def test_fake_recognizer_emits_deterministic_partial_and_final_text(self):
        recognizer = FakeRecognizer("unused-in-test-mode")
        self.assertEqual(recognizer.load("auto"), "cpu")

        self.assertEqual(recognizer.transcribe(pcm_for_seconds(2.1), "auto"), "测试")
        self.assertEqual(recognizer.transcribe(pcm_for_seconds(4.1), "auto"), "测试语音")
        self.assertEqual(recognizer.transcribe(pcm_for_seconds(4.9), "auto"), "测试语音完成。")
        self.assertEqual(recognizer.transcribe(b"", "auto"), "")

    def test_fake_vad_treats_nonzero_pcm_as_speech(self):
        vad = FakeVad()
        self.assertFalse(vad.is_speech(bytes(640)))
        self.assertTrue(vad.is_speech(bytes(638) + b"\x01\x00"))

    def test_service_rejects_test_mode_without_explicit_environment(self):
        args = SimpleNamespace(
            runtime_site="unused-runtime",
            model_path="unused-model",
            token="test-token",
            test_mode=True,
        )
        environment = dict(os.environ)
        environment.pop("HSTAR_VOICE_TEST_MODE", None)

        with patch.dict(os.environ, environment, clear=True):
            with self.assertRaisesRegex(RuntimeError, "HSTAR_VOICE_TEST_MODE=1"):
                asyncio.run(serve(args))


if __name__ == "__main__":
    unittest.main()
