import math
import sys
import time
from array import array
from collections import deque
from dataclasses import dataclass
from typing import Callable, Protocol


SAMPLE_RATE = 16_000
SAMPLE_WIDTH_BYTES = 2
FRAME_MILLISECONDS = 20
SAMPLES_PER_FRAME = SAMPLE_RATE * FRAME_MILLISECONDS // 1000
FRAME_BYTES = SAMPLES_PER_FRAME * SAMPLE_WIDTH_BYTES
DEFAULT_PRE_ROLL_SECONDS = 0.3
DEFAULT_HANGOVER_SECONDS = 1.3
DEFAULT_MAX_UTTERANCE_SECONDS = 30.0
DEFAULT_SPEECH_CONFIRMATION_SECONDS = 0.12
DEFAULT_MIN_RMS = 0.003
DEFAULT_MIN_SNR_DB = 6.0
DEFAULT_NOISE_FLOOR = 0.001


class VoiceAudioError(ValueError):
    def __init__(self, code: str, message: str = ""):
        self.code = code
        super().__init__(f"{code}: {message}" if message else code)


class VadLike(Protocol):
    def is_speech(self, frame: bytes) -> bool:
        ...


@dataclass(frozen=True)
class VadEvent:
    speech_active: bool
    partial_pcm: bytes | None = None
    final_utterance_pcm: bytes | None = None
    silence_remaining_ms: int = 10_000
    stop_reason: str = ""


class WebRtcVad:
    def __init__(self, aggressiveness: int = 3):
        if aggressiveness not in {0, 1, 2, 3}:
            raise ValueError("WebRTC VAD aggressiveness must be between 0 and 3")
        import webrtcvad

        self._vad = webrtcvad.Vad(aggressiveness)

    def is_speech(self, frame: bytes) -> bool:
        return bool(self._vad.is_speech(frame, SAMPLE_RATE))


def pcm_rms(frame: bytes) -> float:
    samples = array("h")
    samples.frombytes(frame)
    if sys.byteorder != "little":
        samples.byteswap()
    if not samples:
        return 0.0
    square_sum = sum(sample * sample for sample in samples)
    return math.sqrt(square_sum / len(samples)) / 32768.0


class VadSession:
    def __init__(
        self,
        *,
        vad: VadLike,
        clock: Callable[[], float] = time.monotonic,
        silence_seconds: float = 10.0,
        pre_roll_seconds: float = DEFAULT_PRE_ROLL_SECONDS,
        hangover_seconds: float = DEFAULT_HANGOVER_SECONDS,
        max_utterance_seconds: float = DEFAULT_MAX_UTTERANCE_SECONDS,
        partial_interval_seconds: float = 0.8,
        speech_confirmation_seconds: float = DEFAULT_SPEECH_CONFIRMATION_SECONDS,
        min_rms: float = DEFAULT_MIN_RMS,
        min_snr_db: float = DEFAULT_MIN_SNR_DB,
        noise_floor: float = DEFAULT_NOISE_FLOOR,
    ):
        for name, value in (
            ("silence_seconds", silence_seconds),
            ("pre_roll_seconds", pre_roll_seconds),
            ("hangover_seconds", hangover_seconds),
            ("max_utterance_seconds", max_utterance_seconds),
            ("partial_interval_seconds", partial_interval_seconds),
            ("speech_confirmation_seconds", speech_confirmation_seconds),
            ("min_rms", min_rms),
            ("noise_floor", noise_floor),
        ):
            if value <= 0:
                raise ValueError(f"{name} must be positive")
        self.vad = vad
        self.clock = clock
        self.silence_seconds = float(silence_seconds)
        self.hangover_seconds = float(hangover_seconds)
        self.partial_interval_seconds = float(partial_interval_seconds)
        self.min_rms = float(min_rms)
        self.min_snr_ratio = 10 ** (float(min_snr_db) / 20.0)
        self.noise_floor = float(noise_floor)
        self.confirmation_frames = max(
            1,
            math.ceil(speech_confirmation_seconds * 1000 / FRAME_MILLISECONDS),
        )
        self.max_utterance_bytes = int(
            SAMPLE_RATE * SAMPLE_WIDTH_BYTES * max_utterance_seconds
        )
        pre_roll_frames = max(
            1,
            round(pre_roll_seconds * 1000 / FRAME_MILLISECONDS),
        )
        self._pre_roll: deque[bytes] = deque(maxlen=pre_roll_frames)
        self._utterance = bytearray()
        self._speech_active = False
        self._candidate_frames = 0
        self._ended = False
        self.started_at = float(clock())
        self.last_speech_at = self.started_at
        self._last_partial_at = self.started_at

    @classmethod
    def for_device(
        cls,
        device: str,
        *,
        vad: VadLike,
        clock: Callable[[], float] = time.monotonic,
        silence_seconds: float = 10.0,
    ) -> "VadSession":
        interval = 0.8 if device == "cuda" else 2.0
        return cls(
            vad=vad,
            clock=clock,
            silence_seconds=silence_seconds,
            partial_interval_seconds=interval,
        )

    def accept_pcm(self, frame: bytes) -> VadEvent:
        if not isinstance(frame, bytes) or len(frame) != FRAME_BYTES:
            raise VoiceAudioError(
                "VOICE_PCM_FRAME_SIZE",
                f"Expected {FRAME_BYTES} bytes",
            )
        now = float(self.clock())
        if self._ended:
            return self._event(now, stop_reason="silence-timeout")

        vad_speech = bool(self.vad.is_speech(frame))
        rms = pcm_rms(frame)
        energy_threshold = max(self.min_rms, self.noise_floor * self.min_snr_ratio)
        is_speech = vad_speech and rms >= energy_threshold
        if not is_speech:
            alpha = 0.08 if rms < self.noise_floor else 0.02
            self.noise_floor = max(
                1 / 32768,
                self.noise_floor + alpha * (rms - self.noise_floor),
            )
        partial = None
        final = None
        if self._speech_active and is_speech:
            self.last_speech_at = now
            self._utterance.extend(frame)
        elif self._speech_active:
            self._utterance.extend(frame)
            if now - self.last_speech_at + 1e-9 >= self.hangover_seconds:
                final = self._finish_utterance()
        else:
            self._pre_roll.append(frame)
            if is_speech:
                self._candidate_frames += 1
                if self._candidate_frames >= self.confirmation_frames:
                    self._utterance = bytearray(b"".join(self._pre_roll))
                    self._pre_roll.clear()
                    self._speech_active = True
                    self.last_speech_at = now
                    self._last_partial_at = now
            else:
                self._candidate_frames = 0

        if self._speech_active and len(self._utterance) >= self.max_utterance_bytes:
            final = self._finish_utterance()
        elif (
            self._speech_active
            and now - self._last_partial_at + 1e-9 >= self.partial_interval_seconds
        ):
            partial = bytes(self._utterance)
            self._last_partial_at = now

        stop_reason = ""
        if now - self.last_speech_at + 1e-9 >= self.silence_seconds:
            if self._speech_active and final is None:
                final = self._finish_utterance()
            self._ended = True
            stop_reason = "silence-timeout"

        return self._event(
            now,
            partial_pcm=partial,
            final_utterance_pcm=final,
            stop_reason=stop_reason,
        )

    def flush(self) -> VadEvent:
        now = float(self.clock())
        final = self._finish_utterance() if self._speech_active else None
        self._ended = True
        return self._event(now, final_utterance_pcm=final, stop_reason="user")

    def _finish_utterance(self) -> bytes | None:
        if not self._utterance:
            self._speech_active = False
            self._candidate_frames = 0
            return None
        final = bytes(self._utterance)
        self._utterance.clear()
        self._speech_active = False
        self._candidate_frames = 0
        return final

    def _event(
        self,
        now: float,
        *,
        partial_pcm: bytes | None = None,
        final_utterance_pcm: bytes | None = None,
        stop_reason: str = "",
    ) -> VadEvent:
        remaining = max(0.0, self.silence_seconds - (now - self.last_speech_at))
        return VadEvent(
            speech_active=self._speech_active,
            partial_pcm=partial_pcm,
            final_utterance_pcm=final_utterance_pcm,
            silence_remaining_ms=round(remaining * 1000),
            stop_reason=stop_reason,
        )
