import unittest

from voice_assistant.audio import FRAME_BYTES, VadSession, VoiceAudioError


SILENT_20MS_FRAME = bytes(FRAME_BYTES)
NOISY_20MS_FRAME = b"\x01\x00" * (FRAME_BYTES // 2)


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
        sequence = [True, True] + [False] * 35
        session = VadSession(vad=SequenceVad(sequence), clock=self.clock)

        events = []
        for _ in sequence:
            events.append(session.accept_pcm(NOISY_20MS_FRAME))
            self.clock.advance(0.02)

        self.assertTrue(events[0].speech_active)
        self.assertIsNotNone(events[-1].final_utterance_pcm)
        self.assertGreater(len(events[-1].final_utterance_pcm), 2 * FRAME_BYTES)

    def test_partial_snapshots_are_rate_limited(self):
        session = VadSession(
            vad=FakeVad(True),
            clock=self.clock,
            partial_interval_seconds=0.8,
        )

        first = session.accept_pcm(NOISY_20MS_FRAME)
        self.clock.advance(0.79)
        early = session.accept_pcm(NOISY_20MS_FRAME)
        self.clock.advance(0.01)
        due = session.accept_pcm(NOISY_20MS_FRAME)

        self.assertIsNone(first.partial_pcm)
        self.assertIsNone(early.partial_pcm)
        self.assertIsNotNone(due.partial_pcm)

    def test_utterance_cap_finalizes_without_stopping_session(self):
        session = VadSession(
            vad=FakeVad(True),
            clock=self.clock,
            max_utterance_seconds=0.06,
        )

        session.accept_pcm(NOISY_20MS_FRAME)
        session.accept_pcm(NOISY_20MS_FRAME)
        event = session.accept_pcm(NOISY_20MS_FRAME)

        self.assertIsNotNone(event.final_utterance_pcm)
        self.assertEqual(event.stop_reason, "")

    def test_rejects_non_twenty_millisecond_pcm_frames(self):
        session = VadSession(vad=FakeVad(False), clock=self.clock)

        with self.assertRaisesRegex(VoiceAudioError, "VOICE_PCM_FRAME_SIZE"):
            session.accept_pcm(b"short")


if __name__ == "__main__":
    unittest.main()
