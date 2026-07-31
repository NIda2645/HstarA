import asyncio
import base64
import json
import socket
import time
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import httpx
from fastapi import HTTPException

import browser_plugin_import
import main


ONE_PIXEL_PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGA"
    "WjR9awAAAABJRU5ErkJggg=="
)
EXTENSION_ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"


class _RedirectResponse:
    status_code = 302
    headers = {"location": "http://127.0.0.1/private.png"}

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def raise_for_status(self):
        return None

    def iter_content(self, chunk_size):
        del chunk_size
        return iter(())


class BrowserPluginImportTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        root = Path(self.temp.name)
        self.upload_root = root / "uploads"
        self.assets_root = root / "assets"
        self.upload_root.mkdir(parents=True)
        (self.assets_root / "output").mkdir(parents=True)
        self.patches = [
            patch.object(main, "LOCAL_UPLOAD_DIR", str(self.upload_root)),
            patch.object(main, "ASSETS_DIR", str(self.assets_root)),
            patch.object(main, "SHELL_TOKEN", "test-shell-token"),
        ]
        for current in self.patches:
            current.start()
        self.client = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51060)),
            base_url="http://127.0.0.1:3000",
        )

    async def asyncTearDown(self):
        await self.client.aclose()
        for current in reversed(self.patches):
            current.stop()
        self.temp.cleanup()

    async def post_import(self, item, headers=None):
        return await self.client.post(
            "/api/local-assets/import-urls",
            headers=headers or {"Origin": EXTENSION_ORIGIN, "Content-Type": "application/json"},
            content=json.dumps(
                {"folder": "网页采集", "classify": False, "items": [item]}
            ).encode("utf-8"),
        )

    async def test_plugin_can_probe_providers_without_shell_token(self):
        response = await self.client.get(
            "/api/providers",
            headers={"Origin": EXTENSION_ORIGIN},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("providers", response.json())
        self.assertEqual(
            response.headers["access-control-allow-origin"],
            EXTENSION_ORIGIN,
        )

    async def test_installed_extension_without_origin_uses_browser_fetch_metadata(self):
        response = await self.client.get(
            "/api/providers",
            headers={"Sec-Fetch-Mode": "cors", "Sec-Fetch-Site": "none"},
        )
        self.assertEqual(response.status_code, 200)
        self.assertIn("providers", response.json())

    async def test_installed_extension_without_origin_can_import_assets(self):
        response = await self.post_import(
            {
                "name": "installed-extension.png",
                "content_type": "image/png",
                "data": base64.b64encode(ONE_PIXEL_PNG).decode("ascii"),
            },
            headers={
                "Sec-Fetch-Mode": "cors",
                "Sec-Fetch-Site": "none",
                "Content-Type": "application/json",
            },
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 1)

    async def test_originless_local_connector_can_access_an_unregistered_api(self):
        probe = await self.client.get("/api/providers")
        assets = await self.client.get("/api/local-assets")
        future_api = await self.client.get("/api/software-settings")

        self.assertEqual(probe.status_code, 200)
        self.assertEqual(assets.status_code, 200)
        self.assertEqual(future_api.status_code, 200)
        self.assertIn("settings", future_api.json())

    async def test_chrome_connector_can_access_an_unregistered_api(self):
        response = await self.client.get(
            "/api/software-settings",
            headers={"Origin": EXTENSION_ORIGIN},
        )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.headers["access-control-allow-origin"],
            EXTENSION_ORIGIN,
        )

    async def test_remote_originless_photoshop_request_is_rejected(self):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app, client=("192.168.1.50", 51061)),
            base_url="http://127.0.0.1:3000",
        ) as client:
            remote = await client.get("/api/providers")

        self.assertNotEqual(remote.status_code, 200)

    async def test_untrusted_web_origin_cannot_use_photoshop_allowlist(self):
        response = await self.client.get(
            "/api/providers",
            headers={"Origin": "https://attacker.example"},
        )
        self.assertEqual(response.status_code, 403)

    async def test_untrusted_web_origin_is_rejected_on_unregistered_api(self):
        response = await self.client.get(
            "/api/software-settings",
            headers={"Origin": "https://attacker.example"},
        )
        self.assertEqual(response.status_code, 403)

    async def test_plugin_bypass_rejects_invalid_extension_origin(self):
        response = await self.client.get(
            "/api/providers",
            headers={"Origin": "chrome-extension://not-a-chrome-extension-id"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access-control-allow-origin", response.headers)

    async def test_plugin_bypass_rejects_non_loopback_client(self):
        async with httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app, client=("192.168.1.50", 51061)),
            base_url="http://127.0.0.1:3000",
        ) as client:
            response = await client.get(
                "/api/providers",
                headers={"Origin": EXTENSION_ORIGIN},
            )
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access-control-allow-origin", response.headers)

    async def test_plugin_bypass_rejects_non_loopback_host_header(self):
        response = await self.client.get(
            "/api/providers",
            headers={"Origin": EXTENSION_ORIGIN, "Host": "attacker.example"},
        )
        self.assertEqual(response.status_code, 403)
        self.assertNotIn("access-control-allow-origin", response.headers)

    async def test_development_mode_rejects_untrusted_web_origins_on_plugin_routes(self):
        with patch.object(main, "SHELL_TOKEN", ""):
            probe = await self.client.get(
                "/api/providers",
                headers={"Origin": "https://attacker.example"},
            )
            imported = await self.client.post(
                "/api/local-assets/import-urls",
                headers={"Origin": "https://attacker.example", "Content-Type": "application/json"},
                content=json.dumps(
                    {
                        "folder": "网页采集",
                        "items": [
                            {
                                "name": "inline.png",
                                "content_type": "image/png",
                                "data": base64.b64encode(ONE_PIXEL_PNG).decode("ascii"),
                            }
                        ],
                    }
                ).encode("utf-8"),
            )
        self.assertEqual(probe.status_code, 403)
        self.assertEqual(imported.status_code, 403)
        self.assertNotIn("access-control-allow-origin", probe.headers)
        self.assertNotIn("access-control-allow-origin", imported.headers)
        self.assertFalse(any(self.upload_root.rglob("*.*")))

    async def test_development_mode_keeps_same_origin_asset_import_available(self):
        with patch.object(main, "SHELL_TOKEN", ""):
            response = await self.client.post(
                "/api/local-assets/import-urls",
                headers={
                    "Origin": "http://127.0.0.1:3000",
                    "Content-Type": "application/json",
                },
                content=json.dumps(
                    {
                        "folder": "网页采集",
                        "items": [
                            {
                                "name": "inline.png",
                                "content_type": "image/png",
                                "data": base64.b64encode(ONE_PIXEL_PNG).decode("ascii"),
                            }
                        ],
                    }
                ).encode("utf-8"),
            )
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 1)

    async def test_inline_image_imports_into_existing_asset_library(self):
        response = await self.post_import(
            {
                "name": "inline.png",
                "content_type": "image/png",
                "data": "data:image/png;base64," + base64.b64encode(ONE_PIXEL_PNG).decode("ascii"),
            }
        )
        data = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["count"], 1)
        self.assertTrue((self.upload_root / data["items"][0]["file"]).is_file())

    async def test_hstar_preview_url_imports_original_local_media(self):
        source = self.assets_root / "output" / "source.png"
        source.write_bytes(ONE_PIXEL_PNG)
        preview_url = (
            "http://127.0.0.1:3000/api/media-preview"
            "?w=256&url=%2Fassets%2Foutput%2Fsource.png"
        )
        response = await self.post_import({"url": preview_url, "name": "source.png"})
        data = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["count"], 1)
        imported = self.upload_root / data["items"][0]["file"]
        self.assertEqual(imported.read_bytes(), ONE_PIXEL_PNG)

    async def test_request_body_limit_is_enforced_before_import(self):
        body = json.dumps(
            {
                "folder": "网页采集",
                "classify": False,
                "items": [
                    {
                        "name": "inline.png",
                        "content_type": "image/png",
                        "data": "data:image/png;base64," + base64.b64encode(ONE_PIXEL_PNG).decode("ascii"),
                    }
                ],
            }
        ).encode("utf-8")
        with patch.object(browser_plugin_import, "MAX_PLUGIN_REQUEST_BYTES", 100, create=True):
            response = await self.client.post(
                "/api/local-assets/import-urls",
                headers={"Origin": EXTENSION_ORIGIN, "Content-Type": "application/json"},
                content=body,
            )
        self.assertEqual(response.status_code, 413)
        self.assertIn("请求", response.json()["detail"])
        self.assertFalse(any(self.upload_root.rglob("*.*")))

    async def test_more_than_supported_item_count_is_rejected_without_truncation(self):
        response = await self.client.post(
            "/api/local-assets/import-urls",
            headers={"Origin": EXTENSION_ORIGIN, "Content-Type": "application/json"},
            content=json.dumps(
                {
                    "folder": "网页采集",
                    "classify": False,
                    "items": [{"url": "ftp://invalid/item.png"} for _ in range(501)],
                }
            ).encode("utf-8"),
        )
        self.assertEqual(response.status_code, 422)
        self.assertIn("500", response.text)
        self.assertFalse(any(self.upload_root.rglob("*.*")))

    async def test_inline_item_and_total_limits_are_enforced(self):
        encoded = base64.b64encode(b"12345").decode("ascii")
        with (
            patch.object(browser_plugin_import, "MAX_INLINE_ITEM_BYTES", 4, create=True),
            patch.object(browser_plugin_import, "MAX_INLINE_TOTAL_BYTES", 8, create=True),
        ):
            item_response = await self.post_import(
                {"name": "oversized.png", "content_type": "image/png", "data": encoded}
            )
        self.assertEqual(item_response.status_code, 413)
        self.assertIn("单个", item_response.json()["detail"])

        with (
            patch.object(browser_plugin_import, "MAX_INLINE_ITEM_BYTES", 8, create=True),
            patch.object(browser_plugin_import, "MAX_INLINE_TOTAL_BYTES", 8, create=True),
        ):
            total_response = await self.client.post(
                "/api/local-assets/import-urls",
                headers={"Origin": EXTENSION_ORIGIN, "Content-Type": "application/json"},
                content=json.dumps(
                    {
                        "folder": "网页采集",
                        "classify": False,
                        "items": [
                            {"name": "a.png", "content_type": "image/png", "data": encoded},
                            {"name": "b.png", "content_type": "image/png", "data": encoded},
                        ],
                    }
                ).encode("utf-8"),
            )
        self.assertEqual(total_response.status_code, 413)
        self.assertIn("总大小", total_response.json()["detail"])

    async def test_all_item_failures_return_non_success_http_status(self):
        response = await self.post_import({"url": "ftp://invalid/item.png", "name": "item.png"})
        data = response.json()
        self.assertEqual(response.status_code, 422)
        self.assertFalse(data["ok"])
        self.assertEqual(data["count"], 0)
        self.assertEqual(len(data["items"]), 1)
        self.assertFalse(data["items"][0]["ok"])

    async def test_mixed_result_reports_every_selected_item(self):
        response = await self.client.post(
            "/api/local-assets/import-urls",
            headers={"Origin": EXTENSION_ORIGIN, "Content-Type": "application/json"},
            content=json.dumps(
                {
                    "folder": "网页采集",
                    "classify": False,
                    "items": [
                        {
                            "name": "inline.png",
                            "content_type": "image/png",
                            "data": base64.b64encode(ONE_PIXEL_PNG).decode("ascii"),
                        },
                        {"url": "ftp://invalid/item.png", "name": "item.png"},
                    ],
                }
            ).encode("utf-8"),
        )
        data = response.json()
        self.assertEqual(response.status_code, 200)
        self.assertTrue(data["ok"])
        self.assertEqual(data["count"], 1)
        self.assertEqual(len(data["items"]), 2)
        self.assertEqual(sum(1 for item in data["items"] if not item["ok"]), 1)

    async def test_remote_fetch_does_not_block_event_loop(self):
        def slow_fetch(*_args, **_kwargs):
            time.sleep(0.25)
            return ONE_PIXEL_PNG, "image/png"

        ticks = 0

        async def heartbeat():
            nonlocal ticks
            deadline = asyncio.get_running_loop().time() + 0.18
            while asyncio.get_running_loop().time() < deadline:
                await asyncio.sleep(0.02)
                ticks += 1

        with patch.object(main, "fetch_remote_media_bytes", side_effect=slow_fetch):
            request_task = asyncio.create_task(
                self.post_import({"url": "https://public.example/image.png", "name": "image.png"})
            )
            heartbeat_task = asyncio.create_task(heartbeat())
            response, _ = await asyncio.gather(request_task, heartbeat_task)
        self.assertGreaterEqual(ticks, 6)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["count"], 1)

    def test_remote_redirect_to_private_network_is_rejected(self):
        public_resolution = [
            (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, "", ("93.184.216.34", 443))
        ]
        with (
            patch("socket.getaddrinfo", return_value=public_resolution),
            patch.object(main.requests, "get", return_value=_RedirectResponse()) as remote_get,
        ):
            with self.assertRaises(HTTPException) as caught:
                main.fetch_remote_media_bytes("https://public.example/start.png")
        self.assertEqual(caught.exception.status_code, 400)
        self.assertIn("内网", str(caught.exception.detail))
        remote_get.assert_called_once()

    def test_development_server_defaults_to_loopback(self):
        with (
            patch.dict(main.os.environ, {}, clear=False),
            patch.object(main, "EDITION", "development"),
        ):
            main.os.environ.pop("HSTAR_HOST", None)
            self.assertEqual(main.resolve_server_host(), "127.0.0.1")


if __name__ == "__main__":
    unittest.main()
