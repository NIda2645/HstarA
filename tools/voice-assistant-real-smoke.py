import argparse
import asyncio
import ctypes
import json
import os
import sys
import time
import wave
from datetime import datetime, timezone
from pathlib import Path

from voice_assistant.installer import VoiceInstaller
from voice_assistant.recognizer import (
    FunAsrRecognizer,
    VoiceRecognitionError,
    prepend_runtime_site,
)
from voice_assistant.registry import ModelRegistry
from voice_assistant.settings import normalize_voice_settings, voice_paths


REPOSITORY_ROOT = Path(__file__).resolve().parents[1]
TERMINAL_INSTALL_STATES = {"completed", "cancelled", "failed"}


def is_inside(path: Path, parent: Path) -> bool:
    resolved = path.resolve()
    root = parent.resolve()
    return resolved == root or root in resolved.parents


async def wait_for_install(installer: VoiceInstaller, task_id: str):
    previous_phase = None
    last_reported_at = 0.0
    while True:
        state = installer.status(task_id)
        phase = (state.status, state.stage)
        now = time.monotonic()
        if (
            phase != previous_phase
            or state.status in TERMINAL_INSTALL_STATES
            or now - last_reported_at >= 5.0
        ):
            print(
                json.dumps(
                    {
                        "type": "install-progress",
                        "status": state.status,
                        "stage": state.stage,
                        "downloaded_bytes": state.downloaded_bytes,
                        "total_bytes": state.total_bytes,
                        "speed_bps": state.speed_bps,
                        "eta_seconds": state.eta_seconds,
                    },
                    ensure_ascii=False,
                ),
                flush=True,
            )
            previous_phase = phase
            last_reported_at = now
        if state.status in TERMINAL_INSTALL_STATES:
            if state.status != "completed" or not state.model_ready:
                detail = state.error_message or state.error_code or state.status
                raise RuntimeError(f"Voice install failed: {detail}")
            return state
        await asyncio.sleep(0.5)


def load_pcm16(path: Path, runtime_site: Path) -> tuple[bytes, float]:
    prepend_runtime_site(str(runtime_site))
    import numpy
    import soundfile
    import torch
    from torchaudio.functional import resample

    samples, sample_rate = soundfile.read(path, dtype="float32", always_2d=True)
    mono = samples.mean(axis=1)
    if sample_rate != 16_000:
        mono = resample(torch.from_numpy(mono), sample_rate, 16_000).numpy()
    mono = numpy.clip(mono, -1.0, 1.0)
    pcm16 = (mono * 32767.0).astype("<i2").tobytes()
    return pcm16, len(mono) / 16_000.0


def process_peak_rss_bytes() -> int:
    if os.name != "nt":
        import resource

        return int(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss) * 1024

    from ctypes import wintypes

    class ProcessMemoryCounters(ctypes.Structure):
        _fields_ = [
            ("cb", wintypes.DWORD),
            ("PageFaultCount", wintypes.DWORD),
            ("PeakWorkingSetSize", ctypes.c_size_t),
            ("WorkingSetSize", ctypes.c_size_t),
            ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPagedPoolUsage", ctypes.c_size_t),
            ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
            ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
            ("PagefileUsage", ctypes.c_size_t),
            ("PeakPagefileUsage", ctypes.c_size_t),
        ]

    counters = ProcessMemoryCounters()
    counters.cb = ctypes.sizeof(counters)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    get_current_process = kernel32.GetCurrentProcess
    get_current_process.argtypes = []
    get_current_process.restype = wintypes.HANDLE
    psapi = ctypes.WinDLL("psapi", use_last_error=True)
    get_memory_info = psapi.GetProcessMemoryInfo
    get_memory_info.argtypes = [
        wintypes.HANDLE,
        ctypes.POINTER(ProcessMemoryCounters),
        wintypes.DWORD,
    ]
    get_memory_info.restype = wintypes.BOOL
    ok = get_memory_info(
        get_current_process(),
        ctypes.byref(counters),
        counters.cb,
    )
    return int(counters.PeakWorkingSetSize) if ok else 0


def write_report(paths, report: dict) -> Path:
    log_dir = paths["logs"]
    log_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    report_path = log_dir / f"real-smoke-{stamp}.json"
    report_path.write_text(
        json.dumps(report, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return report_path


def prepare_browser_wav(root: Path, target: Path, language: str) -> dict:
    settings = normalize_voice_settings(
        {"voice_assistant": {"storage_mode": "custom", "storage_root": str(root)}},
        app_data_root=str(root.parent),
    )
    paths = voice_paths(settings)
    detection = ModelRegistry().detect(root)
    if not detection.ready:
        raise RuntimeError(f"Voice model is incomplete: {detection.missing}")
    source = Path(detection.model_path) / "example" / f"{language}.mp3"
    pcm16, audio_seconds = load_pcm16(source, paths["runtime_site"])
    trailing_silence_seconds = 12
    silence = b"\0\0" * 16_000 * trailing_silence_seconds
    target.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(target), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(16_000)
        output.writeframes(pcm16 + silence)
    return {
        "ok": True,
        "source": str(source),
        "target": str(target),
        "audio_seconds": audio_seconds,
        "trailing_silence_seconds": trailing_silence_seconds,
    }


async def run_real_smoke(
    root: Path,
    install: bool,
    device: str,
    languages: list[str],
) -> dict:
    settings = normalize_voice_settings(
        {"voice_assistant": {"storage_mode": "custom", "storage_root": str(root)}},
        app_data_root=str(root.parent),
    )
    paths = voice_paths(settings)
    installer = VoiceInstaller(paths, python_executable=sys.executable)
    if install:
        task = installer.start_install(profile=device)
        await wait_for_install(installer, task.task_id)

    detection = ModelRegistry().detect(root)
    if not detection.ready:
        report = {
            "ok": False,
            "error_code": "VOICE_MODEL_MISSING",
            "missing": detection.missing,
        }
        report["report_path"] = str(write_report(paths, report))
        return report

    prepend_runtime_site(str(paths["runtime_site"]))
    import torch

    if torch.cuda.is_available():
        torch.cuda.reset_peak_memory_stats()

    recognizer = FunAsrRecognizer(detection.model_path)
    started = time.perf_counter()
    try:
        selected_device = await asyncio.to_thread(recognizer.load, device)
    except VoiceRecognitionError as error:
        report = {
            "ok": False,
            "error_code": error.code,
            "message": str(error),
        }
        report["report_path"] = str(write_report(paths, report))
        return report
    cold_load_seconds = time.perf_counter() - started

    results = []
    try:
        test_cases = [(language, language) for language in languages]
        test_cases += [("auto", language) for language in languages]
        for requested_language, sample_language in test_cases:
            audio_path = Path(detection.model_path) / "example" / f"{sample_language}.mp3"
            pcm16, audio_seconds = load_pcm16(audio_path, paths["runtime_site"])
            started = time.perf_counter()
            transcript = await asyncio.to_thread(
                recognizer.transcribe,
                pcm16,
                requested_language,
            )
            elapsed = time.perf_counter() - started
            result = {
                "requested_language": requested_language,
                "sample_language": sample_language,
                "transcript": transcript,
                "audio_seconds": audio_seconds,
                "inference_seconds": elapsed,
                "real_time_factor": elapsed / audio_seconds,
            }
            results.append(result)
            print(json.dumps({"type": "recognition", **result}, ensure_ascii=False), flush=True)
        report = {
            "ok": all(item["transcript"] for item in results),
            "model_path": detection.model_path,
            "revision": detection.revision,
            "device": selected_device,
            "cold_load_seconds": cold_load_seconds,
            "warm_session_seconds": min(item["inference_seconds"] for item in results),
            "peak_rss_bytes": process_peak_rss_bytes(),
            "peak_vram_bytes": (
                int(torch.cuda.max_memory_allocated()) if selected_device == "cuda" else 0
            ),
            "results": results,
        }
    finally:
        recognizer.close()

    report["report_path"] = str(write_report(paths, report))
    return report


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--voice-root", required=True)
    parser.add_argument("--install", action="store_true")
    parser.add_argument("--device", choices=("auto", "cuda", "cpu"), default="auto")
    parser.add_argument("--languages", nargs="+", default=["zh", "en", "ja"])
    parser.add_argument("--prepare-browser-wav")
    parser.add_argument("--browser-language", choices=("zh", "en", "ja"), default="zh")
    args = parser.parse_args()
    root = Path(args.voice_root).expanduser().resolve()
    if is_inside(root, REPOSITORY_ROOT):
        parser.error("real model root must stay outside repository")
    if args.prepare_browser_wav:
        target = Path(args.prepare_browser_wav).expanduser().resolve()
        if is_inside(target, REPOSITORY_ROOT) or is_inside(target, root):
            parser.error("browser WAV must stay outside the repository and voice root")
        print(
            json.dumps(
                prepare_browser_wav(root, target, args.browser_language),
                ensure_ascii=False,
                indent=2,
            )
        )
        return 0
    report = asyncio.run(
        run_real_smoke(root, args.install, args.device, args.languages)
    )
    print(json.dumps(report, ensure_ascii=False, indent=2))
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
