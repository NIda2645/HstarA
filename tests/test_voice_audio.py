import unittest

from voice_assistant.audio import FRAME_BYTES, VadSession, VoiceAudioError


SILENT_20MS_FRAME = bytes(FRAME_BYTES)
NOISY_20MS_FRAME = b"\x01\x00" * (FRAME_BYTES // 2)


def pcm_frame(amplitude):
    sample = int(amplitude).to_bytes(2, "little", signed=True)
    return sample * (FRAME_BYTES // 2)


def alternating_pcm_frame(amplitude):
    positive = int(amplitude).to_bytes(2, "little", signed=True)
    negative = int(-amplitude).to_bytes(2, "little", signed=True)
    return (positive + negative) * (FRAME_BYTES // 4)


class FakeClock:
    def __init__(self):
        self.value = 100.0

    def __call__(self):
        return self.value

    def advance(self, seconds):
        self.value += seconds


class SequenceVad:
    def __init__(self, values):
        self.values = iter(values)

    def is_speech(self, frame):
        return next(self.values, False)


class FakeVad:
    def __init__(self, value):
        self.value = value

    def is_speech(self, frame):
        return self.value


class VoiceAudioTests(unittest.TestCase):
    def setUp(self):
        self.clock = FakeClock()

    def test_stops_after_ten_seconds_without_speech(self):
        session = VadSession(
            vad=FakeVad(False),
            clock=self.clock,
            silence_seconds=10,
        )

        event = None
        for _ in range(500):
            self.clock.advance(0.02)
            event = session.accept_pcm(SILENT_20MS_FRAME)

        self.assertEqual(event.stop_reason, "silence-timeout")
        self.assertEqual(event.silence_remaining_ms, 0)

    def test_buffered_frames_advance_silence_when_wall_clock_stalls(self):
        session = VadSession(
            vad=FakeVad(False),
            clock=self.clock,
            silence_seconds=0.1,
        )

        event = None
        for _ in range(6):
            event = session.accept_pcm(SILENT_20MS_FRAME)

        self.assertEqual(event.stop_reason, "silence-timeout")
        self.assertEqual(event.silence_remaining_ms, 0)

    def test_noise_does_not_reset_timer_when_vad_rejects_it(self):
        session = VadSession(
            vad=FakeVad(False),
            clock=self.clock,
            silence_seconds=10,
        )
        started_at = session.started_at
        self.clock.advance(1)

        session.accept_pcm(NOISY_20MS_FRAME)

        self.assertEqual(session.last_speech_at, started_at)

    def test_valid_speech_resets_timer_and_emits_utterance_after_hangover(self):
        sequence = [True] * 9 + [False] * 70
        session = VadSession(vad=SequenceVad(sequence), clock=self.clock)

        events = []
        for _ in sequence:
            events.append(session.accept_pcm(pcm_frame(3000)))
            self.clock.advance(0.02)

        self.assertFalse(events[0].speech_active)
        self.assertTrue(events[8].speech_active)
        final = next(event.final_utterance_pcm for event in events if event.final_utterance_pcm)
        self.assertGreater(len(final), 2 * FRAME_BYTES)

    def test_vad_positive_low_energy_noise_does_not_start_speech(self):
        session = VadSession(vad=FakeVad(True), clock=self.clock)

        for _ in range(25):
            event = session.accept_pcm(pcm_frame(8))
            self.clock.advance(0.02)

        self.assertFalse(event.speech_active)
        self.assertIsNone(event.partial_pcm)
        self.assertEqual(session.last_speech_at, session.started_at)

    def test_speech_requires_confirmation_but_keeps_pre_roll(self):
        session = VadSession(vad=FakeVad(True), clock=self.clock)

        for _ in range(8):
            event = session.accept_pcm(pcm_frame(3000))
            self.clock.advance(0.02)
        self.assertFalse(event.speech_active)

        event = session.accept_pcm(pcm_frame(3000))

        self.assertTrue(event.speech_active)

    def test_short_high_energy_transient_does_not_start_speech(self):
        sequence = [True] * 8 + [False]
        session = VadSession(vad=SequenceVad(sequence), clock=self.clock)

        for active in sequence:
            event = session.accept_pcm(pcm_frame(3000 if active else 0))
            self.clock.advance(0.02)

        self.assertFalse(event.speech_active)
        self.assertEqual(session.last_speech_at, session.started_at)

    def test_vad_positive_high_frequency_background_noise_does_not_start_speech(self):
        session = VadSession(vad=FakeVad(True), clock=self.clock)

        for _ in range(50):
            event = session.accept_pcm(alternating_pcm_frame(1200))
            self.clock.advance(0.02)

        self.assertFalse(event.speech_active)
        self.assertIsNone(event.partial_pcm)
        self.assertEqual(session.last_speech_at, session.started_at)

    def test_device_partial_intervals_keep_live_text_below_one_second(self):
        cpu = VadSession.for_device("cpu", vad=FakeVad(True), clock=self.clock)
        cuda = VadSession.for_device("cuda", vad=FakeVad(True), clock=self.clock)

        self.assertLessEqual(cpu.partial_interval_seconds, 0.9)
        self.assertLessEqual(cuda.partial_interval_seconds, 0.5)

    def test_short_pause_does_not_finalize_utterance(self):
        sequence = [True] * 10 + [False] * 40 + [True] * 10
        session = VadSession(vad=SequenceVad(sequence), clock=self.clock)

        finals = []
        for active in sequence:
            event = session.accept_pcm(pcm_frame(3000 if active else 0))
            finals.append(event.final_utterance_pcm)
            self.clock.advance(0.02)

        self.assertTrue(event.speech_active)
        self.assertTrue(all(value is None for value in finals))

    def test_partial_snapshots_are_rate_limited(self):
        session = VadSession(
            vad=FakeVad(True),
            clock=self.clock,
            partial_interval_seconds=0.8,
            speech_confirmation_seconds=0.02,
        )

        first = session.accept_pcm(pcm_frame(3000))
        self.clock.advance(0.79)
        early = session.accept_pcm(pcm_frame(3000))
        self.clock.advance(0.01)
        due = session.accept_pcm(pcm_frame(3000))

        self.assertIsNone(first.partial_pcm)
        self.assertIsNone(early.partial_pcm)
        self.assertIsNotNone(due.partial_pcm)

    def test_utterance_cap_finalizes_without_stopping_session(self):
        session = VadSession(
            vad=FakeVad(True),
            clock=self.clock,
            max_utterance_seconds=0.06,
            speech_confirmation_seconds=0.02,
        )

        event = None
        for _ in range(6):
            event = session.accept_pcm(pcm_frame(3000))

        self.assertIsNotNone(event.final_utterance_pcm)
        self.assertEqual(event.stop_reason, "")

    def test_rejects_non_twenty_millisecond_pcm_frames(self):
        session = VadSession(vad=FakeVad(False), clock=self.clock)

        with self.assertRaisesRegex(VoiceAudioError, "VOICE_PCM_FRAME_SIZE"):
            session.accept_pcm(b"short")


if __name__ == "__main__":
    unittest.main()
