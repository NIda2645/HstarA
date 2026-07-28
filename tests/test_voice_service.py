import asyncio
import threading
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, call

from voice_assistant.service import VoiceConnection


class BlockingRecognizer:
    def __init__(self):
        self.started = threading.Event()
        self.release = threading.Event()

    def transcribe(self, pcm, _language):
        self.started.set()
        self.release.wait(timeout=2)
        return pcm.decode("utf-8")


class VoiceServiceConnectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_completed_partial_is_sent_while_a_newer_snapshot_is_waiting(self):
        recognizer = BlockingRecognizer()
        connection = VoiceConnection(
            SimpleNamespace(recognizer=recognizer),
            reader=None,
            writer=None,
        )
        connection.vad_session = object()
        connection.language = "zh"
        connection.send = AsyncMock()
        connection.pending_partial = b"first"

        task = asyncio.create_task(connection._drain_partials())
        started = await asyncio.to_thread(recognizer.started.wait, 1)
        self.assertTrue(started)
        connection.pending_partial = b"second"
        recognizer.release.set()
        await task

        self.assertEqual(
            connection.send.await_args_list,
            [
                call({"type": "partial", "text": "first"}),
                call({"type": "partial", "text": "second"}),
            ],
        )


if __name__ == "__main__":
    unittest.main()
