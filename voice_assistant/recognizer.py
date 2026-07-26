import gc
import contextlib
import importlib
import os
import pkgutil
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


_DLL_HANDLES = []
_FUNASR_IMPORT_LOCK = threading.Lock()
_FUNASR_NANO_MODULES = (
    "funasr.frontends.wav_frontend",
    "funasr.models.llm_asr.adaptor",
    "funasr.models.sense_voice.model",
    "funasr.tokenizer.hf_tokenizer",
    "funasr.tokenizer.whisper_tokenizer",
    "funasr.models.fun_asr_nano.model",
)


class VoiceRecognitionError(RuntimeError):
    def __init__(self, code: str, message: str):
        self.code = code
        super().__init__(f"{code}: {message}")


def prepend_runtime_site(runtime_site: str) -> None:
    site = str(Path(runtime_site).resolve())
    if site not in sys.path:
        sys.path.insert(0, site)
    if os.name == "nt" and hasattr(os, "add_dll_directory"):
        for dll_dir in (
            Path(site) / "torch" / "lib",
            Path(site) / "torchaudio" / "lib",
        ):
            if dll_dir.is_dir():
                _DLL_HANDLES.append(os.add_dll_directory(str(dll_dir)))


def _import_funasr_nano_modules() -> None:
    from concurrent.futures import ThreadPoolExecutor

    with ThreadPoolExecutor(max_workers=min(4, len(_FUNASR_NANO_MODULES))) as executor:
        list(executor.map(importlib.import_module, _FUNASR_NANO_MODULES))


def _funasr_auto_model():
    loaded_package = sys.modules.get("funasr")
    if loaded_package is not None and "AutoModel" in vars(loaded_package):
        return loaded_package.AutoModel

    with _FUNASR_IMPORT_LOCK:
        loaded_package = sys.modules.get("funasr")
        if loaded_package is None:
            original_walk_packages = pkgutil.walk_packages
            pkgutil.walk_packages = lambda *_args, **_kwargs: []
            try:
                importlib.import_module("funasr")
            finally:
                pkgutil.walk_packages = original_walk_packages

        _import_funasr_nano_modules()
        return importlib.import_module("funasr.auto.auto_model").AutoModel


def funasr_language(language: str) -> str | None:
    return {
        "zh": "中文",
        "en": "英文",
        "ja": "日文",
    }.get(str(language or "").lower())


@dataclass
class RecognitionState:
    sequence: int = -1
    text: str = ""

    def accept(self, *, sequence: int, text: str) -> bool:
        if sequence <= self.sequence:
            return False
        self.sequence = sequence
        self.text = text
        return True


class FunAsrRecognizer:
    def __init__(
        self,
        model_path: str | Path,
        *,
        model_factory: Callable | None = None,
        audio_converter: Callable[[bytes], object] | None = None,
    ):
        self.model_path = Path(model_path).resolve()
        self.model_factory = model_factory
        self.audio_converter = audio_converter or self._convert_pcm16
        self.model = None
        self.device = ""
        self._inference_lock = threading.Lock()

    def load(self, requested_device: str = "auto") -> str:
        requested = str(requested_device or "auto").lower()
        if requested not in {"auto", "cuda", "cpu"}:
            raise VoiceRecognitionError(
                "VOICE_MODEL_LOAD_FAILED",
                f"Unsupported device: {requested_device}",
            )
        candidates = (
            ["cuda:0", "cpu"]
            if requested == "auto"
            else ["cuda:0" if requested == "cuda" else "cpu"]
        )
        last_error = None
        for device in candidates:
            try:
                self.model = self._create_model(device)
                self.device = "cuda" if device.startswith("cuda") else "cpu"
                return self.device
            except Exception as error:
                last_error = error
                self._release_model()
                if requested == "cuda":
                    raise VoiceRecognitionError(
                        "VOICE_CUDA_UNAVAILABLE",
                        str(error),
                    ) from error
        message = str(last_error or "Unknown model load error")
        raise VoiceRecognitionError("VOICE_MODEL_LOAD_FAILED", message)

    def _create_model(self, device: str):
        if self.model_factory is not None:
            return self.model_factory(model_path=self.model_path, device=device)
        AutoModel = _funasr_auto_model()
        try:
            from transformers.modeling_utils import no_init_weights
        except (ImportError, AttributeError):
            no_init_weights = contextlib.nullcontext

        with no_init_weights():
            return AutoModel(
                model=str(self.model_path),
                trust_remote_code=False,
                device=device,
                disable_update=True,
                disable_pbar=True,
            )

    def transcribe(self, pcm16: bytes, language: str) -> str:
        if self.model is None:
            raise VoiceRecognitionError(
                "VOICE_MODEL_LOAD_FAILED",
                "Recognizer is not loaded",
            )
        if not isinstance(pcm16, bytes) or len(pcm16) % 2:
            raise VoiceRecognitionError(
                "VOICE_PCM_INVALID",
                "PCM16 payload must contain complete samples",
            )
        audio = self.audio_converter(pcm16)
        language_arg = funasr_language(language)
        options = {"language": language_arg} if language_arg else {}
        try:
            with self._inference_lock:
                result = self.model.generate(
                    input=[audio],
                    cache={},
                    batch_size=1,
                    itn=True,
                    **options,
                )
        except Exception as error:
            message = str(error)
            code = "VOICE_MODEL_OOM" if "out of memory" in message.lower() else "VOICE_RECOGNITION_FAILED"
            raise VoiceRecognitionError(code, message) from error
        if not result or not isinstance(result[0], dict):
            return ""
        return str(result[0].get("text") or "").strip()

    @staticmethod
    def _convert_pcm16(pcm16: bytes):
        import numpy
        import torch

        samples = numpy.frombuffer(pcm16, dtype="<i2").astype(numpy.float32) / 32768.0
        return torch.from_numpy(samples)

    def close(self) -> None:
        used_cuda = self.device == "cuda"
        self._release_model()
        gc.collect()
        if used_cuda and "torch" in sys.modules:
            try:
                sys.modules["torch"].cuda.empty_cache()
            except Exception:
                pass

    def _release_model(self) -> None:
        self.model = None
        self.device = ""
