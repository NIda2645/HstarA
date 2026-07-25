import sys
import tempfile
import unittest
from pathlib import Path

from voice_assistant.recognizer import (
    FunAsrRecognizer,
    RecognitionState,
    funasr_language,
)


class FakeModel:
    def __init__(self):
        self.inputs = []

    def generate(self, **kwargs):
        self.inputs.append(kwargs)
        return [{"text": "  测试完成。  "}]


class FakeModelFactory:
    def __init__(self, cuda_error=None):
        self.cuda_error = cuda_error
        self.calls = []
        self.models = []

    def __call__(self, *, model_path, device):
        self.calls.append(device)
        if device == "cuda:0" and self.cuda_error:
            raise self.cuda_error
        model = FakeModel()
        self.models.append(model)
        return model


class VoiceRecognizerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.model_path = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_cuda_failure_falls_back_to_cpu(self):
        factory = FakeModelFactory(cuda_error=RuntimeError("CUDA unavailable"))
        recognizer = FunAsrRecognizer(self.model_path, model_factory=factory)

        recognizer.load("auto")

        self.assertEqual(recognizer.device, "cpu")
        self.assertEqual(factory.calls, ["cuda:0", "cpu"])

    def test_explicit_cuda_failure_does_not_fall_back(self):
        factory = FakeModelFactory(cuda_error=RuntimeError("CUDA unavailable"))
        recognizer = FunAsrRecognizer(self.model_path, model_factory=factory)

        with self.assertRaisesRegex(Exception, "VOICE_CUDA_UNAVAILABLE"):
            recognizer.load("cuda")

        self.assertEqual(factory.calls, ["cuda:0"])

    def test_partial_results_keep_only_stable_monotonic_sequence(self):
        state = RecognitionState()

        self.assertTrue(state.accept(sequence=2, text="你好"))
        self.assertFalse(state.accept(sequence=1, text="你"))
        self.assertEqual(state.text, "你好")

    def test_language_is_limited_to_supported_values(self):
        self.assertEqual(funasr_language("zh"), "中文")
        self.assertEqual(funasr_language("en"), "英文")
        self.assertEqual(funasr_language("ja"), "日文")
        self.assertIsNone(funasr_language("auto"))
        self.assertIsNone(funasr_language("xx"))

    def test_transcribe_passes_float_audio_and_omits_auto_language(self):
        factory = FakeModelFactory()
        recognizer = FunAsrRecognizer(
            self.model_path,
            model_factory=factory,
            audio_converter=lambda pcm: [0.0, 32767 / 32768],
        )
        recognizer.load("cpu")

        text = recognizer.transcribe(b"\x00\x00\xff\x7f", "auto")

        self.assertEqual(text, "测试完成。")
        options = factory.models[0].inputs[0]
        self.assertNotIn("language", options)
        self.assertEqual(options["batch_size"], 1)
        self.assertEqual(len(options["input"][0]), 2)

    def test_module_import_does_not_load_optional_runtime(self):
        self.assertNotIn("funasr", sys.modules)
        self.assertNotIn("webrtcvad", sys.modules)


if __name__ == "__main__":
    unittest.main()
