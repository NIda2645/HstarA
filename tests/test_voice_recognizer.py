import sys
import tempfile
import threading
import time
import types
import unittest
from pathlib import Path
from unittest.mock import patch

from voice_assistant.recognizer import (
    FunAsrRecognizer,
    RecognitionState,
    _FUNASR_NANO_MODULES,
    _import_funasr_nano_modules,
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

    def test_default_converter_returns_torch_tensor_for_fun_asr_nano(self):
        class FakeArray:
            def astype(self, _dtype):
                return self

            def __truediv__(self, _value):
                return self

        samples = FakeArray()
        tensor = object()
        numpy_module = types.ModuleType("numpy")
        numpy_module.float32 = object()
        numpy_module.frombuffer = lambda *_args, **_kwargs: samples
        torch_module = types.ModuleType("torch")
        torch_module.from_numpy = lambda value: tensor if value is samples else None

        with patch.dict(
            sys.modules,
            {"numpy": numpy_module, "torch": torch_module},
        ):
            converted = FunAsrRecognizer._convert_pcm16(b"\x00\x00")

        self.assertIs(converted, tensor)

    def test_default_factory_disables_update_check_and_progress_ui(self):
        options = {}
        funasr_module = types.ModuleType("funasr")

        def create_model(**kwargs):
            options.update(kwargs)
            return object()

        funasr_module.AutoModel = create_model
        recognizer = FunAsrRecognizer(self.model_path)

        with patch.dict(sys.modules, {"funasr": funasr_module}):
            recognizer._create_model("cpu")

        self.assertTrue(options["disable_update"])
        self.assertTrue(options["disable_pbar"])
        self.assertFalse(options["trust_remote_code"])

    def test_required_nano_modules_import_in_parallel(self):
        imported = []
        worker_threads = set()

        def import_module(name):
            imported.append(name)
            worker_threads.add(threading.get_ident())
            time.sleep(0.02)
            return object()

        with patch("voice_assistant.recognizer.importlib.import_module", import_module):
            _import_funasr_nano_modules()

        self.assertCountEqual(imported, _FUNASR_NANO_MODULES)
        self.assertGreater(len(worker_threads), 1)

    def test_module_import_does_not_load_optional_runtime(self):
        self.assertNotIn("funasr", sys.modules)
        self.assertNotIn("webrtcvad", sys.modules)


if __name__ == "__main__":
    unittest.main()
