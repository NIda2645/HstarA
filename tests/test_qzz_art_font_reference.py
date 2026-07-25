import base64
import json
import unittest
from io import BytesIO
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

import main


class QzzArtFontReferenceTests(unittest.TestCase):
    @staticmethod
    def data_url(image):
        buffer = BytesIO()
        image.save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

    def test_flattens_and_compacts_transparent_art_reference_before_qzz_request(self):
        image = Image.new("RGBA", (800, 400), (0, 0, 0, 0))
        for y in range(80, 320):
            for x in range(320, 480):
                image.putpixel((x, y), (65, 107, 75, 255))

        result = main.qzz_reference_image_value({"url": self.data_url(image)})

        self.assertTrue(result.startswith("data:image/png;base64,"))
        decoded = Image.open(BytesIO(base64.b64decode(result.split(",", 1)[1])))
        self.assertEqual(decoded.mode, "RGB")
        self.assertLessEqual(max(decoded.size), 384)
        self.assertEqual(decoded.getpixel((0, 0)), (248, 248, 248))
        center = decoded.getpixel((decoded.width // 2, decoded.height // 2))
        self.assertLess(center[0], 100)
        self.assertGreater(center[1], center[0])

    def test_preserves_qzz_error_body_for_manual_retry_diagnostics(self):
        response = SimpleNamespace(
            status_code=400,
            text=json.dumps({"error": {"message": "reference image is required"}}),
            reason_phrase="Bad Request",
        )

        detail = main.qzz_image_error_detail(response, "auto", "gpt-image-2")

        self.assertIn("上游没有识别到参考图片", detail)
        self.assertIn("reference image is required", detail)
        self.assertIn("不会自动重试", detail)


class _FakeQzzResponse:
    def __init__(self, payload=None, status_code=200, text=""):
        self.status_code = status_code
        self._payload = payload or {"data": [{"url": "https://example.test/result.png"}]}
        self.text = text
        self.reason_phrase = "Bad Request" if status_code >= 400 else "OK"

    def json(self):
        return self._payload


class _RecordingQzzClient:
    calls = []

    def __init__(self, *args, **kwargs):
        self.init_kwargs = kwargs

    async def __aenter__(self):
        return self

    async def __aexit__(self, exc_type, exc, tb):
        return False

    async def post(self, url, **kwargs):
        files = []
        for field, upload in kwargs.get("files") or []:
            filename, handle, content_type = upload
            files.append((field, filename, content_type, handle.read()))
            handle.seek(0)
        self.__class__.calls.append({"url": url, **kwargs, "files_snapshot": files})
        return _FakeQzzResponse()


class QzzProviderProtocolTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        _RecordingQzzClient.calls = []
        self.provider = {
            "id": "qzz-test",
            "name": "QZZ test",
            "base_url": "https://img.688.qzz.io",
            "protocol": "openai",
            "image_request_mode": "openai",
            "image_generation_endpoint": "/custom/images/generations",
            "image_edit_endpoint": "/custom/images/edits",
        }

    @staticmethod
    def reference_data_url():
        buffer = BytesIO()
        Image.new("RGB", (16, 12), (240, 240, 240)).save(buffer, format="PNG")
        return "data:image/png;base64," + base64.b64encode(buffer.getvalue()).decode("ascii")

    async def test_reference_image_uses_configured_multipart_edit_endpoint_once(self):
        with (
            patch.object(main.httpx, "AsyncClient", _RecordingQzzClient),
            patch.object(main, "api_headers", return_value={"Authorization": "Bearer test"}),
        ):
            image, _raw = await main.generate_qzz_provider_image(
                "remove all text",
                "1024x1024",
                "gpt-image-2",
                [{"url": self.reference_data_url(), "name": "source.png", "role": "source"}],
                self.provider,
                quality="high",
            )

        self.assertEqual(image["value"], "https://example.test/result.png")
        self.assertEqual(len(_RecordingQzzClient.calls), 1)
        call = _RecordingQzzClient.calls[0]
        self.assertEqual(call["url"], "https://img.688.qzz.io/custom/images/edits")
        self.assertNotIn("json", call)
        self.assertEqual(call["data"]["model"], "gpt-image-2")
        self.assertEqual(call["data"]["prompt"], "remove all text")
        self.assertEqual(call["data"]["quality"], "high")
        self.assertEqual(len(call["files_snapshot"]), 1)
        field, filename, content_type, content = call["files_snapshot"][0]
        self.assertEqual(field, "image")
        self.assertTrue(filename.endswith(".png"))
        self.assertEqual(content_type, "image/png")
        self.assertTrue(content.startswith(b"\x89PNG\r\n\x1a\n"))

    async def test_prompt_only_generation_uses_configured_json_endpoint_once(self):
        with (
            patch.object(main.httpx, "AsyncClient", _RecordingQzzClient),
            patch.object(main, "api_headers", return_value={"Authorization": "Bearer test"}),
        ):
            await main.generate_qzz_provider_image(
                "make a clean background",
                "1024x1024",
                "gpt-image-2",
                [],
                self.provider,
            )

        self.assertEqual(len(_RecordingQzzClient.calls), 1)
        call = _RecordingQzzClient.calls[0]
        self.assertEqual(call["url"], "https://img.688.qzz.io/custom/images/generations")
        self.assertNotIn("files", call)
        self.assertEqual(call["json"]["prompt"], "make a clean background")


if __name__ == "__main__":
    unittest.main()
