import unittest

import httpx

import main


class _Response:
    def __init__(self, status_code):
        self.status_code = status_code


class _Client:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.calls = 0

    async def request(self, _method, _url, **_kwargs):
        self.calls += 1
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class ProviderRequestRetrySafetyTests(unittest.IsolatedAsyncioTestCase):
    async def test_generation_post_is_never_retried(self):
        client = _Client([
            httpx.ConnectTimeout("submission state is unknown"),
            _Response(200),
        ])

        with self.assertRaises(httpx.ConnectTimeout):
            await main.httpx_request_with_transient_retries(
                client,
                "POST",
                "https://provider.example/v1/videos",
                attempts=3,
                retry_delay=0,
                json={"prompt": "one request"},
            )

        self.assertEqual(client.calls, 1)

    async def test_task_poll_get_can_retry_transient_status(self):
        client = _Client([_Response(503), _Response(200)])

        response = await main.httpx_request_with_transient_retries(
            client,
            "GET",
            "https://provider.example/v1/tasks/task-1",
            attempts=3,
            retry_delay=0,
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(client.calls, 2)


if __name__ == "__main__":
    unittest.main()
