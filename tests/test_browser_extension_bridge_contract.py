import json
import unittest

from starlette.requests import Request


STORE_EXTENSION_ORIGIN = "chrome-extension://ajfhnbklbmpfaaookhfakohabnpmlcic"


def make_request(
    path,
    method="GET",
    origin=STORE_EXTENSION_ORIGIN,
    client="127.0.0.1",
    host="127.0.0.1:3000",
    requested_method="",
    headers=None,
    body_chunks=None,
):
    raw_headers = [
        (b"host", host.encode("ascii")),
        (b"origin", origin.encode("ascii")),
    ]
    if requested_method:
        raw_headers.append(
            (b"access-control-request-method", requested_method.encode("ascii"))
        )
    for key, value in (headers or {}).items():
        raw_headers.append((key.lower().encode("ascii"), value.encode("ascii")))

    chunks = list(body_chunks or [])

    async def receive():
        if chunks:
            body = chunks.pop(0)
            return {"type": "http.request", "body": body, "more_body": bool(chunks)}
        return {"type": "http.request", "body": b"", "more_body": False}

    return Request(
        {
            "type": "http",
            "method": method,
            "path": path,
            "scheme": "http",
            "query_string": b"",
            "server": ("127.0.0.1", 3000),
            "client": (client, 51000),
            "headers": raw_headers,
        },
        receive=receive,
    )


class BrowserExtensionPolicyTests(unittest.TestCase):
    def test_fixed_identity_and_only_two_routes_are_allowed(self):
        from browser_extension_bridge import bridge_request_allowed

        self.assertTrue(bridge_request_allowed(make_request("/api/providers")))
        self.assertTrue(
            bridge_request_allowed(
                make_request("/api/local-assets/import-urls", method="POST")
            )
        )
        self.assertTrue(
            bridge_request_allowed(
                make_request(
                    "/api/local-assets/import-urls",
                    method="OPTIONS",
                    requested_method="POST",
                )
            )
        )
        self.assertFalse(
            bridge_request_allowed(make_request("/api/software-settings"))
        )
        self.assertFalse(
            bridge_request_allowed(
                make_request("/api/providers", origin="chrome-extension://other")
            )
        )
        self.assertFalse(
            bridge_request_allowed(make_request("/api/providers", client="10.0.0.2"))
        )
        self.assertFalse(
            bridge_request_allowed(
                make_request("/api/providers", host="192.168.1.20:3000")
            )
        )

    def test_identity_and_route_failures_have_distinct_codes(self):
        from browser_extension_bridge import bridge_request_error_code

        self.assertEqual(
            bridge_request_error_code(
                make_request("/api/providers", origin="chrome-extension://other")
            ),
            "extension_forbidden",
        )
        self.assertEqual(
            bridge_request_error_code(make_request("/api/software-settings")),
            "extension_route_forbidden",
        )

    def test_ipv6_loopback_host_is_allowed(self):
        from browser_extension_bridge import bridge_request_allowed

        self.assertTrue(
            bridge_request_allowed(
                make_request("/api/providers", client="::1", host="[::1]:5000")
            )
        )


class BrowserExtensionSchemaTests(unittest.TestCase):
    def test_additive_fields_are_ignored_and_defaults_are_stable(self):
        from browser_extension_bridge import parse_import_request

        payload = parse_import_request(
            {
                "items": [
                    {
                        "url": "https://example.com/a.png",
                        "future_item": {"version": 2},
                    }
                ],
                "future_option": True,
            }
        )
        self.assertEqual(payload.folder, "网页采集")
        self.assertFalse(payload.classify)
        self.assertEqual(payload.provider, "comfly")
        self.assertEqual(payload.model, "")
        self.assertEqual(payload.prompt, "")
        self.assertEqual(payload.items[0].url, "https://example.com/a.png")

    def test_known_fields_keep_strict_types(self):
        from browser_extension_bridge import BridgeRequestError, parse_import_request

        invalid_payloads = (
            {"items": "not-an-array"},
            {"classify": "true", "items": [{"url": "https://example.com/a.png"}]},
            {"folder": {}, "items": [{"url": "https://example.com/a.png"}]},
            {"items": [{}]},
            {"items": []},
        )
        for raw in invalid_payloads:
            with self.subTest(raw=raw), self.assertRaises(BridgeRequestError):
                parse_import_request(raw)

    def test_limits_and_partial_success_response_are_centralized(self):
        from browser_extension_bridge import bridge_limits, build_import_response

        limits = bridge_limits()
        self.assertEqual(limits.max_items, 200)
        self.assertEqual(limits.max_request_bytes, 256 * 1024 * 1024)
        self.assertEqual(limits.max_inline_item_bytes, 64 * 1024 * 1024)
        self.assertEqual(limits.max_inline_batch_bytes, 192 * 1024 * 1024)
        self.assertEqual(limits.max_remote_image_bytes, 64 * 1024 * 1024)
        self.assertEqual(limits.max_remote_video_bytes, 2 * 1024 * 1024 * 1024)
        self.assertEqual(limits.max_remote_batch_bytes, 8 * 1024 * 1024 * 1024)
        self.assertEqual(limits.download_workers, 4)
        self.assertEqual(limits.classify_workers, 2)

        partial = build_import_response(
            [
                {"ok": True, "file": "网页采集/a.png", "item": {"id": "a"}},
                {"ok": False, "error_code": "invalid_base64"},
            ]
        )
        self.assertTrue(partial["ok"])
        self.assertEqual(partial["count"], 1)
        self.assertEqual(partial["files"], ["网页采集/a.png"])
        self.assertEqual(len(partial["items"]), 2)

        failed = build_import_response(
            [{"ok": False, "error_code": "unsupported_media"}]
        )
        self.assertFalse(failed["ok"])
        self.assertEqual(failed["count"], 0)

    def test_provider_projection_excludes_private_fields(self):
        from browser_extension_bridge import redact_bridge_providers

        providers = redact_bridge_providers(
            [
                {
                    "id": "vision",
                    "name": "Vision",
                    "enabled": True,
                    "chat_models": ["model-a"],
                    "api_key": "secret",
                    "base_url": "https://private.example",
                    "key_preview": "sk-***",
                    "storage_root": "D:/private",
                }
            ]
        )
        self.assertEqual(
            providers,
            [
                {
                    "id": "vision",
                    "name": "Vision",
                    "enabled": True,
                    "chat_models": ["model-a"],
                }
            ],
        )


class BrowserExtensionBodyTests(unittest.IsolatedAsyncioTestCase):
    async def test_content_length_is_rejected_before_receive(self):
        from browser_extension_bridge import BridgeRequestError, read_bounded_json

        request = make_request(
            "/api/local-assets/import-urls",
            method="POST",
            headers={
                "content-type": "application/json",
                "content-length": "10",
            },
            body_chunks=[b"{}"],
        )
        with self.assertRaises(BridgeRequestError) as context:
            await read_bounded_json(request, 4)
        self.assertEqual(context.exception.code, "import_limit_exceeded")

    async def test_chunked_body_is_bounded_before_json_parse(self):
        from browser_extension_bridge import BridgeRequestError, read_bounded_json

        request = make_request(
            "/api/local-assets/import-urls",
            method="POST",
            headers={"content-type": "application/json"},
            body_chunks=[b'{"a":', b'"12345"}'],
        )
        with self.assertRaises(BridgeRequestError) as context:
            await read_bounded_json(request, 8)
        self.assertEqual(context.exception.code, "import_limit_exceeded")

    async def test_valid_body_is_parsed(self):
        from browser_extension_bridge import read_bounded_json

        raw = json.dumps({"items": [{"url": "https://example.com/a.png"}]}).encode()
        request = make_request(
            "/api/local-assets/import-urls",
            method="POST",
            headers={"content-type": "application/json"},
            body_chunks=[raw[:10], raw[10:]],
        )
        self.assertEqual((await read_bounded_json(request, 1024))["items"][0]["url"], "https://example.com/a.png")


if __name__ == "__main__":
    unittest.main()
