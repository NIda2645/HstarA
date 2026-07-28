import asyncio
import unittest

from voice_assistant.protocol import (
    FRAME_AUDIO,
    FRAME_JSON,
    MAX_FRAME_BYTES,
    VoiceProtocolError,
    authenticate_hello,
    decode_json,
    encode_frame,
    encode_json,
    read_frame,
)


class VoiceProtocolTests(unittest.IsolatedAsyncioTestCase):
    async def test_binary_audio_round_trip(self):
        reader = asyncio.StreamReader()
        reader.feed_data(encode_frame(FRAME_AUDIO, b"\x01\x02"))
        reader.feed_eof()

        frame_type, payload = await read_frame(reader)

        self.assertEqual(frame_type, FRAME_AUDIO)
        self.assertEqual(payload, b"\x01\x02")

    async def test_json_round_trip_preserves_unicode(self):
        reader = asyncio.StreamReader()
        reader.feed_data(encode_json({"type": "partial", "text": "你好"}))
        reader.feed_eof()

        frame_type, payload = await read_frame(reader)

        self.assertEqual(frame_type, FRAME_JSON)
        self.assertEqual(decode_json(payload)["text"], "你好")

    async def test_authentication_must_be_the_first_frame(self):
        reader = asyncio.StreamReader()
        reader.feed_data(encode_frame(FRAME_AUDIO, b"not-auth"))
        reader.feed_eof()

        with self.assertRaisesRegex(VoiceProtocolError, "VOICE_PROTOCOL_AUTH_REQUIRED"):
            await authenticate_hello(reader, "secret")

    async def test_authentication_rejects_wrong_token(self):
        reader = asyncio.StreamReader()
        reader.feed_data(encode_json({"type": "hello", "token": "wrong"}))
        reader.feed_eof()

        with self.assertRaisesRegex(VoiceProtocolError, "VOICE_PROTOCOL_AUTH_FAILED"):
            await authenticate_hello(reader, "secret")

    async def test_authentication_returns_hello_payload(self):
        reader = asyncio.StreamReader()
        reader.feed_data(
            encode_json({"type": "hello", "token": "secret", "protocol": 1})
        )
        reader.feed_eof()

        payload = await authenticate_hello(reader, "secret")

        self.assertEqual(payload["protocol"], 1)

    def test_rejects_oversized_frame(self):
        with self.assertRaisesRegex(
            VoiceProtocolError,
            "VOICE_PROTOCOL_FRAME_TOO_LARGE",
        ):
            encode_frame(FRAME_AUDIO, b"x" * (MAX_FRAME_BYTES + 1))

    def test_rejects_unknown_frame_type(self):
        with self.assertRaisesRegex(VoiceProtocolError, "VOICE_PROTOCOL_FRAME_TYPE"):
            encode_frame(99, b"")


if __name__ == "__main__":
    unittest.main()
