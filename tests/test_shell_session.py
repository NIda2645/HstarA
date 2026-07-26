import logging
import unittest

import httpx

import main


class ShellSessionMiddlewareTests(unittest.IsolatedAsyncioTestCase):
    def test_access_log_redacts_shell_and_collaboration_query_secrets(self):
        record = logging.LogRecord(
            name="uvicorn.access",
            level=logging.INFO,
            pathname=__file__,
            lineno=1,
            msg='%s - "%s %s HTTP/%s" %d',
            args=(
                "127.0.0.1:51000",
                "GET",
                "/?hstar_shell_token=SECRET&collab_key=COLLAB&view=canvas",
                "1.1",
                303,
            ),
            exc_info=None,
        )

        accepted = main.QuietAccessLogFilter().filter(record)

        self.assertTrue(accepted)
        message = record.getMessage()
        self.assertNotIn("SECRET", message)
        self.assertNotIn("COLLAB", message)
        self.assertIn("view=canvas", message)

    async def asyncSetUp(self):
        self.original_token = main.SHELL_TOKEN
        self.original_consumed = main.SHELL_BOOTSTRAP_TOKEN_CONSUMED
        main.SHELL_TOKEN = "A" * 64
        main.SHELL_BOOTSTRAP_TOKEN_CONSUMED = False

    async def asyncTearDown(self):
        main.SHELL_TOKEN = self.original_token
        main.SHELL_BOOTSTRAP_TOKEN_CONSUMED = self.original_consumed

    async def test_static_assets_are_public_but_api_requires_shell_session(self):
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51000))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            static_response = await client.get("/static/index.html")
            protected_response = await client.get("/api/canvases")

        self.assertEqual(static_response.status_code, 200)
        self.assertEqual(protected_response.status_code, 401)

    async def test_health_accepts_shell_header(self):
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51001))
        async with httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1") as client:
            denied = await client.get("/api/health")
            accepted = await client.get(
                "/api/health",
                headers={main.SHELL_TOKEN_HEADER: main.SHELL_TOKEN},
            )

        self.assertEqual(denied.status_code, 401)
        self.assertEqual(accepted.status_code, 200)
        self.assertEqual(accepted.json()["edition"], main.EDITION)

    async def test_one_time_query_token_sets_http_only_cookie_and_redirects_cleanly(self):
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51002))
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
            follow_redirects=False,
        ) as client:
            bootstrap = await client.get(f"/?hstar_shell_token={main.SHELL_TOKEN}")
            authenticated = await client.get("/api/canvases")

        self.assertEqual(bootstrap.status_code, 303)
        self.assertEqual(bootstrap.headers["location"], "/")
        self.assertIn("HttpOnly", bootstrap.headers["set-cookie"])
        self.assertNotIn(main.SHELL_TOKEN, bootstrap.headers["location"])
        self.assertEqual(authenticated.status_code, 200)

        second_transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51003))
        async with httpx.AsyncClient(
            transport=second_transport,
            base_url="http://127.0.0.1",
            follow_redirects=False,
        ) as second_client:
            reused = await second_client.get(f"/?hstar_shell_token={main.SHELL_TOKEN}")
        self.assertEqual(reused.status_code, 401)

    async def test_query_token_is_accepted_only_for_root_navigation(self):
        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51005))
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
            follow_redirects=False,
        ) as client:
            response = await client.get(
                f"/api/canvases?hstar_shell_token={main.SHELL_TOKEN}"
            )

        self.assertEqual(response.status_code, 401)
        self.assertFalse(main.SHELL_BOOTSTRAP_TOKEN_CONSUMED)

    async def test_authorized_collaboration_query_establishes_its_own_session(self):
        transport = httpx.ASGITransport(app=main.app, client=("192.168.1.20", 51004))
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://192.168.1.10",
            follow_redirects=False,
        ) as client:
            bootstrap = await client.get(f"/?collab_key={main.current_collaboration_key()}")
            authenticated = await client.get("/api/canvases")

        self.assertEqual(bootstrap.status_code, 303)
        self.assertIn("HttpOnly", bootstrap.headers["set-cookie"])
        self.assertEqual(authenticated.status_code, 200)


if __name__ == "__main__":
    unittest.main()
