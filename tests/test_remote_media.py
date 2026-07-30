import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from hstar_runtime.remote_media import (
    RemoteMediaError,
    RemoteMediaLimits,
    download_remote_media,
)


class RemoteMediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._temp = TemporaryDirectory()
        self.temp_dir = Path(self._temp.name)

    async def asyncTearDown(self):
        self._temp.cleanup()

    async def test_private_dns_result_is_rejected_before_connect(self):
        with self.assertRaises(RemoteMediaError) as context:
            await download_remote_media(
                "https://media.example/a.png",
                self.temp_dir,
                RemoteMediaLimits(max_bytes=1024),
                resolve_host=lambda *_: ["127.0.0.1"],
            )
        self.assertEqual(context.exception.code, "unsafe_address")
        self.assertEqual(list(self.temp_dir.iterdir()), [])

    async def test_redirect_to_private_address_is_revalidated(self):
        with self.assertRaises(RemoteMediaError) as context:
            await download_remote_media(
                "https://media.example/a.png",
                self.temp_dir,
                RemoteMediaLimits(max_bytes=1024),
                fake_responses=[
                    (302, {"location": "http://127.0.0.1/private"}, b""),
                ],
            )
        self.assertEqual(context.exception.code, "unsafe_address")
        self.assertEqual(list(self.temp_dir.iterdir()), [])

    async def test_streaming_limit_removes_request_temp_file(self):
        with self.assertRaises(RemoteMediaError) as context:
            await download_remote_media(
                "https://media.example/a.png",
                self.temp_dir,
                RemoteMediaLimits(max_bytes=4),
                fake_responses=[
                    (200, {"content-type": "image/png"}, [b"12", b"345"]),
                ],
            )
        self.assertEqual(context.exception.code, "too_large")
        self.assertEqual(list(self.temp_dir.iterdir()), [])

    async def test_success_streams_to_unique_file_and_reports_metadata(self):
        calls = []
        media = await download_remote_media(
            "https://media.example/path/card.png?token=secret",
            self.temp_dir,
            RemoteMediaLimits(max_bytes=1024),
            fake_responses=[
                (200, {"content-type": "image/png"}, [b"abc", b"def"]),
            ],
            consume_bytes=lambda count: calls.append(count),
        )

        self.assertTrue(media.path.exists())
        self.assertEqual(media.path.read_bytes(), b"abcdef")
        self.assertEqual(media.content_type, "image/png")
        self.assertEqual(media.byte_count, 6)
        self.assertEqual(media.source_name, "card.png")
        self.assertEqual(calls, [3, 3])

    async def test_content_limit_callback_can_reduce_effective_limit(self):
        with self.assertRaises(RemoteMediaError) as context:
            await download_remote_media(
                "https://media.example/a.png",
                self.temp_dir,
                RemoteMediaLimits(max_bytes=1024),
                fake_responses=[
                    (200, {"content-type": "image/png"}, [b"12345"]),
                ],
                content_limit=lambda _content_type, _source_name: 4,
            )
        self.assertEqual(context.exception.code, "too_large")
        self.assertEqual(list(self.temp_dir.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
