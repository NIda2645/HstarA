import os
import subprocess
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from fastapi import HTTPException
from starlette.requests import Request

from native_file_picker import (
    MAX_BYTES,
    NativeFilePickerError,
    choose_open_file_path,
    selected_file_metadata,
    validate_selected_file,
)


class NativeFilePickerTests(unittest.TestCase):
    def _file(self, folder, name, content=b"file-bytes"):
        path = os.path.join(folder, name)
        with open(path, "wb") as handle:
            handle.write(content)
        return path

    def test_selects_and_validates_an_image_without_exposing_a_directory(self):
        with tempfile.TemporaryDirectory() as folder:
            selected = self._file(folder, "sample.png", b"\x89PNG\r\n\x1a\n")
            calls = []

            def runner(command, **kwargs):
                calls.append((command, kwargs))
                return SimpleNamespace(returncode=0, stdout=f"{selected}\n", stderr="")

            result = choose_open_file_path("image", runner=runner, platform="nt")
            metadata = selected_file_metadata(result, "image")

            self.assertEqual(result, os.path.abspath(selected))
            self.assertEqual(calls[0][0][:4], ["powershell", "-NoProfile", "-STA", "-Command"])
            self.assertIn("*.png;*.jpg;*.jpeg;*.webp;*.gif;*.bmp", calls[0][0][4])
            self.assertEqual(calls[0][1]["timeout"], 300)
            self.assertEqual(metadata["name"], "sample.png")
            self.assertEqual(metadata["mime"], "image/png")
            self.assertNotIn(folder, metadata["name"])

    def test_uses_a_psd_only_filter_and_mime_type(self):
        with tempfile.TemporaryDirectory() as folder:
            selected = self._file(folder, "layers.psd", b"8BPS")
            scripts = []

            def runner(command, **_kwargs):
                scripts.append(command[4])
                return SimpleNamespace(returncode=0, stdout=selected, stderr="")

            result = choose_open_file_path("psd", runner=runner, platform="nt")
            metadata = selected_file_metadata(result, "psd")

            self.assertIn("PSD Files (*.psd)|*.psd", scripts[0])
            self.assertEqual(metadata["mime"], "image/vnd.adobe.photoshop")

    def test_returns_empty_string_when_the_dialog_is_cancelled(self):
        runner = lambda *_args, **_kwargs: SimpleNamespace(returncode=0, stdout="", stderr="")
        self.assertEqual(choose_open_file_path("psd", runner=runner, platform="nt"), "")

    def test_rejects_unknown_kind_and_unsupported_platform(self):
        with self.assertRaises(NativeFilePickerError) as unknown:
            choose_open_file_path("video", runner=lambda *_a, **_k: None, platform="nt")
        self.assertEqual(unknown.exception.status_code, 400)

        with self.assertRaises(NativeFilePickerError) as unsupported:
            choose_open_file_path("image", runner=lambda *_a, **_k: None, platform="posix")
        self.assertEqual(unsupported.exception.status_code, 501)

    def test_rejects_missing_files_and_disallowed_extensions(self):
        with self.assertRaises(NativeFilePickerError) as missing:
            validate_selected_file("missing.png", "image")
        self.assertEqual(missing.exception.status_code, 404)

        with tempfile.TemporaryDirectory() as folder:
            selected = self._file(folder, "payload.exe")
            with self.assertRaises(NativeFilePickerError) as invalid:
                validate_selected_file(selected, "image")
            self.assertEqual(invalid.exception.status_code, 400)

    def test_enforces_image_and_psd_size_limits(self):
        for kind, name in (("image", "oversized.png"), ("psd", "oversized.psd")):
            with self.subTest(kind=kind), tempfile.TemporaryDirectory() as folder:
                selected = os.path.join(folder, name)
                with open(selected, "wb") as handle:
                    handle.seek(MAX_BYTES[kind])
                    handle.write(b"\0")
                with self.assertRaises(NativeFilePickerError) as oversized:
                    validate_selected_file(selected, kind)
                self.assertEqual(oversized.exception.status_code, 413)

    def test_surfaces_helper_failure_and_timeout(self):
        failed = lambda *_args, **_kwargs: SimpleNamespace(
            returncode=3, stdout="", stderr="dialog failed"
        )
        with self.assertRaises(NativeFilePickerError) as helper_error:
            choose_open_file_path("image", runner=failed, platform="nt")
        self.assertEqual(helper_error.exception.status_code, 500)
        self.assertIn("dialog failed", helper_error.exception.detail)

        def timed_out(command, **_kwargs):
            raise subprocess.TimeoutExpired(command, 300)

        with self.assertRaises(NativeFilePickerError) as timeout:
            choose_open_file_path("image", runner=timed_out, platform="nt")
        self.assertEqual(timeout.exception.status_code, 504)


class NativeOpenFileEndpointTests(unittest.TestCase):
    @staticmethod
    def _request(client="127.0.0.1", origin="http://127.0.0.1:3000"):
        return Request({
            "type":"http",
            "method":"POST",
            "path":"/api/native/open-local-file",
            "scheme":"http",
            "query_string":b"",
            "server":("127.0.0.1", 3000),
            "client":(client, 50000),
            "headers":[
                (b"host", b"127.0.0.1:3000"),
                (b"origin", origin.encode("ascii")),
            ],
        })

    def test_streams_only_safe_file_metadata_for_a_local_same_origin_request(self):
        import main

        with tempfile.TemporaryDirectory() as folder:
            selected = os.path.join(folder, "测试图片.png")
            with open(selected, "wb") as handle:
                handle.write(b"\x89PNG\r\n\x1a\n")
            with patch.object(main, "choose_open_file_path", return_value=selected):
                response = main.open_native_local_file(
                    main.NativeOpenFileRequest(kind="image"),
                    self._request(),
                )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["x-hstar-filename"], "%E6%B5%8B%E8%AF%95%E5%9B%BE%E7%89%87.png")
        self.assertEqual(response.headers["x-hstar-file-size"], "8")
        self.assertEqual(response.headers["content-type"], "image/png")
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertNotIn(folder, str(response.headers))

    def test_returns_no_content_when_the_native_dialog_is_cancelled(self):
        import main

        with patch.object(main, "choose_open_file_path", return_value=""):
            response = main.open_native_local_file(
                main.NativeOpenFileRequest(kind="psd"),
                self._request(),
            )

        self.assertEqual(response.status_code, 204)
        self.assertEqual(response.headers["cache-control"], "no-store")

    def test_rejects_remote_and_cross_origin_requests_before_opening_a_dialog(self):
        import main

        with patch.object(main, "choose_open_file_path") as picker:
            with self.assertRaises(HTTPException) as remote:
                main.open_native_local_file(
                    main.NativeOpenFileRequest(kind="image"),
                    self._request(client="192.168.1.50"),
                )
            self.assertEqual(remote.exception.status_code, 403)

            with self.assertRaises(HTTPException) as cross_origin:
                main.open_native_local_file(
                    main.NativeOpenFileRequest(kind="image"),
                    self._request(origin="http://example.test"),
                )
            self.assertEqual(cross_origin.exception.status_code, 403)
            picker.assert_not_called()


if __name__ == "__main__":
    unittest.main()
