import base64
import inspect
import os
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

import main


HAS_REQUEST_CONTRACT = all(
    "request" in inspect.signature(endpoint).parameters
    for endpoint in (main.save_output_as, main.save_output_batch)
)


def local_request(path, *, client="127.0.0.1", origin="http://127.0.0.1:3000"):
    return Request({
        "type": "http",
        "method": "POST",
        "path": path,
        "scheme": "http",
        "query_string": b"",
        "server": ("127.0.0.1", 3000),
        "client": (client, 51000),
        "headers": [
            (b"host", b"127.0.0.1:3000"),
            (b"origin", origin.encode("ascii")),
        ],
    })


class NativeOutputSaveTests(unittest.TestCase):
    def test_native_save_endpoints_require_request_context(self):
        self.assertIn("request", inspect.signature(main.save_output_as).parameters)
        self.assertIn("request", inspect.signature(main.save_output_batch).parameters)

    @unittest.skipUnless(HAS_REQUEST_CONTRACT, "request contract not implemented")
    def test_batch_decodes_every_item_before_opening_picker(self):
        payload = main.SaveOutputBatchRequest(items=[
            {
                "name": "design.png",
                "content_base64": base64.b64encode(b"png").decode("ascii"),
            },
            {"name": "design.pdf", "content_base64": "not-base64"},
        ])

        with patch.object(main, "choose_folder_path") as picker:
            with self.assertRaises(HTTPException) as error:
                main.save_output_batch(
                    payload,
                    local_request("/api/native/save-output-batch"),
                )

        self.assertEqual(error.exception.status_code, 400)
        picker.assert_not_called()

    @unittest.skipUnless(HAS_REQUEST_CONTRACT, "request contract not implemented")
    def test_batch_saves_base64_items_with_collision_numbers(self):
        with tempfile.TemporaryDirectory() as folder:
            existing = os.path.join(folder, "design.png")
            with open(existing, "wb") as handle:
                handle.write(b"old")
            payload = main.SaveOutputBatchRequest(items=[
                {
                    "name": "design.png",
                    "content_base64": base64.b64encode(b"one").decode("ascii"),
                },
                {
                    "name": "design.png",
                    "content_base64": base64.b64encode(b"two").decode("ascii"),
                },
            ])

            with (
                patch.object(main, "choose_folder_path", return_value=folder),
                patch.object(main, "load_software_settings", return_value={}),
                patch.object(main, "save_software_settings"),
            ):
                result = main.save_output_batch(
                    payload,
                    local_request("/api/native/save-output-batch"),
                )

            self.assertEqual(
                [item["filename"] for item in result["files"]],
                ["design-2.png", "design-3.png"],
            )
            with open(os.path.join(folder, "design-2.png"), "rb") as handle:
                self.assertEqual(handle.read(), b"one")
            with open(os.path.join(folder, "design-3.png"), "rb") as handle:
                self.assertEqual(handle.read(), b"two")

    @unittest.skipUnless(HAS_REQUEST_CONTRACT, "request contract not implemented")
    def test_single_save_uses_extension_specific_filter_and_silent_cancel(self):
        scripts = []

        def runner(command, **_kwargs):
            scripts.append(command[4])
            return SimpleNamespace(returncode=0, stdout="", stderr="")

        with patch.object(main.subprocess, "run", side_effect=runner):
            result = main.save_output_as(
                main.SaveOutputAsRequest(
                    name="layout.psd",
                    content_base64=base64.b64encode(b"8BPS").decode("ascii"),
                ),
                local_request("/api/native/save-output-as"),
            )

        self.assertTrue(result["cancelled"])
        self.assertIn("Photoshop Document (*.psd)|*.psd", scripts[0])

    @unittest.skipUnless(HAS_REQUEST_CONTRACT, "request contract not implemented")
    def test_native_save_rejects_remote_and_cross_origin_requests(self):
        payload = main.SaveOutputAsRequest(
            name="output.png",
            content_base64=base64.b64encode(b"png").decode("ascii"),
        )
        with patch.object(main, "choose_save_output_path") as picker:
            with self.assertRaises(HTTPException) as remote:
                main.save_output_as(
                    payload,
                    local_request(
                        "/api/native/save-output-as",
                        client="192.168.1.8",
                    ),
                )
            with self.assertRaises(HTTPException) as cross_origin:
                main.save_output_as(
                    payload,
                    local_request(
                        "/api/native/save-output-as",
                        origin="http://example.test",
                    ),
                )

        self.assertEqual(remote.exception.status_code, 403)
        self.assertEqual(cross_origin.exception.status_code, 403)
        picker.assert_not_called()

    @unittest.skipUnless(HAS_REQUEST_CONTRACT, "request contract not implemented")
    def test_single_save_writes_base64_content_and_updates_folder(self):
        with tempfile.TemporaryDirectory() as folder:
            target = os.path.join(folder, "saved.svg")
            payload = main.SaveOutputAsRequest(
                name="saved.svg",
                content_base64=base64.b64encode(b"<svg/>").decode("ascii"),
            )
            with (
                patch.object(main, "choose_save_output_path", return_value=(target, folder)),
                patch.object(main, "load_software_settings", return_value={}),
                patch.object(main, "save_software_settings") as save_settings,
            ):
                result = main.save_output_as(
                    payload,
                    local_request("/api/native/save-output-as"),
                )

            with open(target, "rb") as handle:
                self.assertEqual(handle.read(), b"<svg/>")
            self.assertEqual(result["filename"], "saved.svg")
            self.assertEqual(
                save_settings.call_args.args[0]["output_download_folder"],
                folder,
            )


if __name__ == "__main__":
    unittest.main()
