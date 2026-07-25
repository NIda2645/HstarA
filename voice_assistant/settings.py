import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Mapping


MODEL_ID = "FunAudioLLM/Fun-ASR-Nano-2512"
DEFAULT_SHORTCUT = "Shift+Q"
SILENCE_STOP_SECONDS = 10
WARM_IDLE_SECONDS = 600
SUPPORTED_LANGUAGES = frozenset({"auto", "zh", "en", "ja"})


@dataclass(frozen=True)
class VoiceSettings:
    enabled: bool
    storage_mode: str
    configured_root: str
    effective_root: str
    model_path: str
    model_id: str
    model_revision: str
    language: str
    input_device_id: str
    shortcut: str
    prewarm_on_startup: bool
    warm_idle_seconds: int
    silence_stop_seconds: int


def _resolved_path(value: str) -> Path:
    expanded = os.path.expandvars(os.path.expanduser(value.strip().strip('"')))
    return Path(expanded).resolve()


def normalize_voice_settings(
    software_settings: Mapping[str, Any], *, app_data_root: str
) -> VoiceSettings:
    raw = software_settings.get("voice_assistant")
    raw = raw if isinstance(raw, Mapping) else {}
    configured = str(raw.get("storage_root") or "").strip()
    software_root = str(software_settings.get("storage_root") or "").strip()
    mode = (
        "custom"
        if raw.get("storage_mode") == "custom" and configured
        else "inherit"
    )

    if mode == "custom":
        effective = _resolved_path(configured)
    elif software_root:
        effective = _resolved_path(software_root) / "voice-assistant"
    else:
        effective = _resolved_path(app_data_root) / "voice-assistant"

    language = str(raw.get("language") or "auto").lower()
    if language not in SUPPORTED_LANGUAGES:
        language = "auto"

    return VoiceSettings(
        enabled=bool(raw.get("enabled", True)),
        storage_mode=mode,
        configured_root=configured,
        effective_root=str(effective),
        model_path=str(raw.get("model_path") or ""),
        model_id=MODEL_ID,
        model_revision=str(raw.get("model_revision") or ""),
        language=language,
        input_device_id=str(raw.get("input_device_id") or "default"),
        shortcut=str(raw.get("shortcut") or DEFAULT_SHORTCUT),
        prewarm_on_startup=bool(raw.get("prewarm_on_startup", False)),
        warm_idle_seconds=WARM_IDLE_SECONDS,
        silence_stop_seconds=SILENCE_STOP_SECONDS,
    )


def voice_paths(settings: VoiceSettings) -> dict[str, Path]:
    root = Path(settings.effective_root)
    managed = root / ".hstar-voice"
    return {
        "root": root,
        "managed": managed,
        "runtime_site": managed / "runtime" / "site-packages",
        "downloads": managed / "downloads",
        "cache": managed / "cache",
        "state": managed / "state",
        "logs": managed / "logs",
        "model": root / "FunAudioLLM" / "Fun-ASR-Nano-2512",
    }
