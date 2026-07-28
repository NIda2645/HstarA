import atexit
import os
import sys
import tempfile
import unittest
from pathlib import Path
from threading import Lock
from types import SimpleNamespace
from unittest.mock import patch

import httpx

_MODULE_RUNTIME = tempfile.TemporaryDirectory(prefix="hstar-development-restart-runtime-")
atexit.register(_MODULE_RUNTIME.cleanup)
os.environ["HSTAR_DATA_DIR"] = str(Path(_MODULE_RUNTIME.name) / "data")
os.environ["HSTAR_EDITION"] = "test-development-restart"

import main
from hstar_runtime.bootstrap import BootstrapConfig, BootstrapStore
from hstar_runtime.storage_barrier import StorageMutationBarrier


class DevelopmentRestartApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.program = self.root / "program"
        self.source = self.root / "source"
        self.target = self.root / "target"
        self.program.mkdir()
        self.source.mkdir()
        self.target.mkdir()
        (self.source / "source-note.txt").write_text("source", encoding="utf-8")
        (self.target / "target-note.txt").write_text("target", encoding="utf-8")
        self.bootstrap = BootstrapStore(
            self.root / "appdata",
            "development",
            self.program,
        )
        self.bootstrap.save(BootstrapConfig(1, "development", str(self.source)))
        self.server = SimpleNamespace(should_exit=False)
        self.barrier = StorageMutationBarrier()
        self.patchers = [
            patch.object(main, "EDITION", "development"),
            patch.object(main, "PROGRAM_ROOT", self.program),
            patch.object(main, "STORAGE_ROOT", str(self.source)),
            patch.object(main, "BOOTSTRAP", self.bootstrap),
            patch.object(main, "ACTIVE_UVICORN_SERVER", self.server),
            patch.object(main, "STORAGE_WRITE_BARRIER", self.barrier),
            patch.object(main, "CLIENT_ID", "development-instance-old"),
            patch.object(main, "DEVELOPMENT_RESTART_TARGET", None, create=True),
            patch.object(main, "DEVELOPMENT_RESTART_LOCK", Lock(), create=True),
        ]
        for patcher in self.patchers:
            patcher.start()
        self.local = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app, client=("127.0.0.1", 42000)),
            base_url="http://127.0.0.1",
        )
        self.remote = httpx.AsyncClient(
            transport=httpx.ASGITransport(app=main.app, client=("10.20.30.40", 42000)),
            base_url="http://hstar.test",
        )

    async def asyncTearDown(self):
        await self.local.aclose()
        await self.remote.aclose()
        for patcher in reversed(self.patchers):
            patcher.stop()
        self.temporary.cleanup()

    async def test_health_identifies_runtime_and_active_storage(self):
        response = await self.local.get("/api/health")

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["instance_id"], "development-instance-old")
        self.assertEqual(response.json()["active_storage_root"], str(self.source))

    async def test_loopback_development_restart_requires_persisted_target(self):
        self.bootstrap.save(BootstrapConfig(1, "development", str(self.target)))
        source_before = (self.source / "source-note.txt").stat()
        target_before = (self.target / "target-note.txt").stat()

        response = await self.local.post(
            "/api/runtime/restart",
            json={"expected_storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertTrue(response.json()["scheduled"])
        self.assertEqual(response.json()["instance_id"], "development-instance-old")
        self.assertTrue(self.server.should_exit)
        self.assertEqual(main.DEVELOPMENT_RESTART_TARGET, self.target.resolve())
        self.assertEqual((self.source / "source-note.txt").read_text(encoding="utf-8"), "source")
        self.assertEqual((self.target / "target-note.txt").read_text(encoding="utf-8"), "target")
        self.assertEqual((self.source / "source-note.txt").stat().st_mtime_ns, source_before.st_mtime_ns)
        self.assertEqual((self.target / "target-note.txt").stat().st_mtime_ns, target_before.st_mtime_ns)

    async def test_restart_is_available_after_storage_barrier_becomes_read_only(self):
        self.bootstrap.save(BootstrapConfig(1, "development", str(self.target)))
        with self.barrier.switch_to_read_only():
            pass

        response = await self.local.post(
            "/api/runtime/restart",
            json={"expected_storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 202, response.text)
        self.assertTrue(self.server.should_exit)

    async def test_remote_and_non_development_restart_requests_are_rejected(self):
        self.bootstrap.save(BootstrapConfig(1, "development", str(self.target)))

        remote = await self.remote.post(
            "/api/runtime/restart",
            json={"expected_storage_root": str(self.target)},
        )
        with patch.object(main, "EDITION", "windows11"):
            packaged = await self.local.post(
                "/api/runtime/restart",
                json={"expected_storage_root": str(self.target)},
            )

        self.assertEqual(remote.status_code, 403, remote.text)
        self.assertEqual(packaged.status_code, 403, packaged.text)
        self.assertFalse(self.server.should_exit)

    async def test_restart_rejects_target_that_does_not_match_bootstrap(self):
        response = await self.local.post(
            "/api/runtime/restart",
            json={"expected_storage_root": str(self.target)},
        )

        self.assertEqual(response.status_code, 409, response.text)
        self.assertFalse(self.server.should_exit)
        self.assertIsNone(main.DEVELOPMENT_RESTART_TARGET)

    async def test_restart_requires_an_active_server(self):
        self.bootstrap.save(BootstrapConfig(1, "development", str(self.target)))
        with patch.object(main, "ACTIVE_UVICORN_SERVER", None):
            response = await self.local.post(
                "/api/runtime/restart",
                json={"expected_storage_root": str(self.target)},
            )

        self.assertEqual(response.status_code, 503, response.text)
        self.assertIsNone(main.DEVELOPMENT_RESTART_TARGET)

    async def test_repeated_restart_for_same_target_is_idempotent(self):
        self.bootstrap.save(BootstrapConfig(1, "development", str(self.target)))

        first = await self.local.post(
            "/api/runtime/restart",
            json={"expected_storage_root": str(self.target)},
        )
        second = await self.local.post(
            "/api/runtime/restart",
            json={"expected_storage_root": str(self.target)},
        )

        self.assertEqual(first.status_code, 202, first.text)
        self.assertEqual(second.status_code, 202, second.text)
        self.assertEqual(main.DEVELOPMENT_RESTART_TARGET, self.target.resolve())

    def test_reexec_uses_same_python_entry_and_selected_data_root(self):
        tracked = [
            "HSTAR_DATA_DIR",
            "HSTAR_PROGRAM_DIR",
            "HSTAR_EDITION",
            "HSTAR_HOST",
            "HSTAR_PORT",
        ]
        previous = {name: os.environ.get(name) for name in tracked}
        main.DEVELOPMENT_RESTART_TARGET = self.target.resolve()
        try:
            with (
                patch.object(main, "resolve_server_host", return_value="127.0.0.1"),
                patch.object(main, "resolve_server_port", return_value=43123),
                patch.object(main.os, "execv") as execv,
            ):
                restarted = main.exec_development_restart_if_scheduled()

            self.assertTrue(restarted)
            self.assertEqual(os.environ["HSTAR_DATA_DIR"], str(self.target.resolve()))
            self.assertEqual(os.environ["HSTAR_PROGRAM_DIR"], str(self.program.resolve()))
            self.assertEqual(os.environ["HSTAR_EDITION"], "development")
            self.assertEqual(os.environ["HSTAR_HOST"], "127.0.0.1")
            self.assertEqual(os.environ["HSTAR_PORT"], "43123")
            execv.assert_called_once_with(
                sys.executable,
                [sys.executable, "-B", "-X", "utf8", str(Path(main.__file__).resolve())],
            )
        finally:
            for name, value in previous.items():
                if value is None:
                    os.environ.pop(name, None)
                else:
                    os.environ[name] = value


if __name__ == "__main__":
    unittest.main()
