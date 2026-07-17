import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch


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

    async def _send(self):
        self.attempts += 1
        if self.attempts == 1:
            raise httpx.RemoteProtocolError("Server disconnected without sending a response.")
        return _Response()

    async def post(self, *_args, **_kwargs):
        return await self._send()

    async def get(self, *_args, **_kwargs):
        return await self._send()

    async def request(self, _method, *_args, **_kwargs):
        return await self._send()


class CanvasLlmRequestTests(unittest.IsolatedAsyncioTestCase):
    async def test_does_not_retry_a_transient_upstream_disconnect(self):
        client = _TransientDisconnectClient()
        client_factory = Mock(return_value=client)
        payload = main.CanvasLLMRequest(
            provider="test-vision",
            model="vision-model",
            message="read the image",
            images=[],
        )

        with (
            patch.object(
                main,
                "get_api_provider",
                return_value={"id": "test-vision", "use_system_proxy": False},
            ),
            patch.object(
                main,
                "resolve_chat_provider",
                return_value=("https://example.invalid/v1", {"Authorization": "Bearer test"}, "vision-model"),
            ),
            patch.object(main.httpx, "AsyncClient", client_factory),
        ):
            with self.assertRaises(main.HTTPException) as raised:
                await main.canvas_llm(payload)

        self.assertEqual(client.attempts, 1)
        self.assertIs(client_factory.call_args.kwargs.get("trust_env"), False)
        self.assertEqual(raised.exception.status_code, 502)
        self.assertIn("Server disconnected without sending a response.", raised.exception.detail)

    def test_provider_proxy_preference_is_normalized_with_a_safe_default(self):
        direct = main.normalize_provider({
            "id": "direct-vision",
            "name": "Direct Vision",
            "base_url": "https://example.invalid",
            "use_system_proxy": False,
        })
        defaulted = main.normalize_provider({
            "id": "default-vision",
            "name": "Default Vision",
            "base_url": "https://example.invalid",
        })

        self.assertIs(direct["use_system_proxy"], False)
        self.assertIs(defaulted["use_system_proxy"], True)

    async def test_modelscope_canvas_llm_uses_its_saved_proxy_preference(self):
        client = _TransientDisconnectClient()
        client_factory = Mock(return_value=client)
        payload = main.CanvasLLMRequest(
            provider="modelscope",
            model="vision-model",
            message="read the image",
            images=[],
        )

        with (
            patch.object(
                main,
                "get_api_provider",
                return_value={"id": "modelscope", "use_system_proxy": False},
            ),
            patch.object(
                main,
                "resolve_chat_provider",
                return_value=("https://example.invalid/v1", {"Authorization": "Bearer test"}, "vision-model"),
            ),
            patch.object(main.httpx, "AsyncClient", client_factory),
        ):
            with self.assertRaises(main.HTTPException):
                await main.canvas_llm(payload)

        self.assertIs(client_factory.call_args.kwargs.get("trust_env"), False)

    async def test_generic_image_generation_uses_provider_proxy_preference(self):
        client = _TransientDisconnectClient()
        client_factory = Mock(return_value=client)
        provider = {
            "id": "direct-image",
            "name": "Direct Image",
            "base_url": "https://example.invalid",
            "protocol": "openai",
            "image_request_mode": "openai",
            "use_system_proxy": False,
        }

        with (
            patch.object(main, "get_api_provider", return_value=provider),
            patch.object(main, "provider_env_key_value", return_value="test-key"),
            patch.object(main.httpx, "AsyncClient", client_factory),
        ):
            with self.assertRaises(httpx.RemoteProtocolError):
                await main.generate_ai_image(
                    "remove the text",
                    "1024x1024",
                    "high",
                    "image-model",
                    [],
                    provider["id"],
                )

        self.assertIs(client_factory.call_args.kwargs.get("trust_env"), False)

    async def test_modelscope_image_generation_uses_provider_proxy_preference(self):
        client = _TransientDisconnectClient()
        client_factory = Mock(return_value=client)
        provider = {
            "id": "modelscope",
            "name": "ModelScope",
            "use_system_proxy": False,
        }

        with (
            patch.object(main, "modelscope_api_key", return_value="test-key"),
            patch.object(main.httpx, "AsyncClient", client_factory),
        ):
            with self.assertRaises(httpx.RemoteProtocolError):
                await main.generate_modelscope_provider_image(
                    "remove the text",
                    "1024x1024",
                    "image-model",
                    [],
                    provider,
                )

        self.assertIs(client_factory.call_args.kwargs.get("trust_env"), False)

    async def test_runninghub_registry_uses_provider_proxy_preference(self):
        clients = []

        def client_factory(**_kwargs):
            client = _TransientDisconnectClient()
            clients.append(client)
            return client

        factory = Mock(side_effect=client_factory)
        provider = {
            "id": "runninghub",
            "name": "RunningHub",
            "base_url": "https://example.invalid",
            "api_key": "test-key",
            "use_system_proxy": False,
        }

        with patch.object(main.httpx, "AsyncClient", factory):
            await main.fetch_runninghub_model_registry(provider, include_fallback=True)

        self.assertGreaterEqual(factory.call_count, 2)
        self.assertTrue(all(
            call.kwargs.get("trust_env") is False
            for call in factory.call_args_list
        ))


if __name__ == "__main__":
    unittest.main()
