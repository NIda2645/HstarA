import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


_TEMP_ROOT = tempfile.TemporaryDirectory(prefix="hstar-canvas-llm-test-")
_APP_ROOT = Path(_TEMP_ROOT.name) / "app"
_STORAGE_ROOT = Path(_TEMP_ROOT.name) / "storage"
(_APP_ROOT / "data").mkdir(parents=True, exist_ok=True)
(_APP_ROOT / "data" / "software_settings.json").write_text(
    json.dumps({"storage_root": str(_STORAGE_ROOT)}),
    encoding="utf-8",
)
os.environ["HSTAR_DATA_DIR"] = str(_APP_ROOT)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import httpx
import main


class _Response:
    status_code = 200
    content = b'{"choices":[{"message":{"content":"OK"}}]}'
    text = content.decode("utf-8")

    def raise_for_status(self):
        return None

    def json(self):
        return json.loads(self.content)


class _TransientDisconnectClient:
    def __init__(self):
        self.attempts = 0

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return None

    async def post(self, *_args, **_kwargs):
        self.attempts += 1
        if self.attempts == 1:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return _Response()

    async def request(self, _method, *_args, **_kwargs):
        return await self.post(*_args, **_kwargs)


class CanvasLlmRetryTests(unittest.IsolatedAsyncioTestCase):
    async def test_retries_a_transient_upstream_disconnect_once(self):
        client = _TransientDisconnectClient()
        payload = main.CanvasLLMRequest(
            provider="test-vision",
            model="vision-model",
            message="read the image",
            images=[],
        )

        with (
            patch.object(main, "get_api_provider", return_value={"id": "test-vision"}),
            patch.object(
                main,
                "resolve_chat_provider",
                return_value=("https://example.invalid/v1", {"Authorization": "Bearer test"}, "vision-model"),
            ),
            patch.object(main.httpx, "AsyncClient", return_value=client),
            patch.object(main.asyncio, "sleep", new=AsyncMock()),
        ):
            try:
                result = await main.canvas_llm(payload)
            except main.HTTPException:
                result = None

        self.assertEqual(client.attempts, 2)
        self.assertEqual(result["text"], "OK")


if __name__ == "__main__":
    unittest.main()
