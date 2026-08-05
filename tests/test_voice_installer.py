import json
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from voice_assistant.installer import (
    InstallCancelled,
    InstallCommandError,
    RUNTIME_MARKER_SCHEMA,
    VoiceInstaller,
    activate_directory,
    build_pip_install_command,
    build_runtime_probe_command,
    migrate_voice_root,
    uninstall_voice_data,
)
from voice_assistant.settings import normalize_voice_settings, voice_paths


class BlockingRunner:
    def __init__(self):
        self.started = threading.Event()
        self.commands = []

    def __call__(self, command, *, env, cancel_event, on_tick):
        self.commands.append(command)
        self.started.set()
        while not cancel_event.wait(0.01):
            on_tick()
        raise InstallCancelled()


class RecordingRunner:
    def __init__(self, *, fail_probe=False):
        self.commands = []
        self.fail_probe = fail_probe

    def __call__(self, command, *, env, cancel_event, on_tick):
        self.commands.append(command)
        if self.fail_probe and len(self.commands) == 2:
            raise InstallCommandError(1, "numpy import failed")


class VoiceInstallerTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        settings = normalize_voice_settings(
            {
                "voice_assistant": {
                    "storage_mode": "custom",
                    "storage_root": self.temporary.name,
                }
            },
            app_data_root=self.temporary.name,
        )
        self.paths = voice_paths(settings)
        self.runner = BlockingRunner()
        self.installer = VoiceInstaller(
            self.paths,
            runner=self.runner,
            python_executable=sys.executable,
            hardware_probe=lambda: "cpu",
        )

    def tearDown(self):
        active = self.installer.active_task()
        if active and active.status not in {"completed", "cancelled", "failed"}:
            self.installer.cancel(active.task_id)
            self.installer.wait(active.task_id, timeout=2)
        self.temporary.cleanup()

    def test_pip_target_never_modifies_main_python(self):
        command = build_pip_install_command(
            python_executable="C:/Hstar/python/python.exe",
            runtime_site=Path("E:/Speech/.hstar-voice/runtime/site-packages"),
            packages=["funasr==1.3.29"],
            index_url="https://download.pytorch.org/whl/cpu",
            extra_index_url="https://pypi.org/simple",
        )

        self.assertIn("--target", command)
        self.assertEqual(
            command[command.index("--index-url") + 1],
            "https://download.pytorch.org/whl/cpu",
        )
        self.assertNotIn("--user", command)
        self.assertNotIn("venv", " ".join(command))

    def test_runtime_probe_uses_isolated_python_and_target_site(self):
        runtime_site = Path("E:/Speech/.hstar-voice/runtime/site-packages")

        command = build_runtime_probe_command(
            python_executable="C:/Hstar/python/python.exe",
            runtime_site=runtime_site,
        )

        self.assertEqual(command[:4], [
            "C:/Hstar/python/python.exe",
            "-I",
            "-X",
            "utf8",
        ])
        probe = command[-1]
        self.assertIn(str(runtime_site.resolve()), probe)
        for package in ("numpy", "torch", "torchaudio", "modelscope", "funasr"):
            self.assertIn(package, probe)

    def test_runtime_probe_supports_a_target_path_with_an_apostrophe(self):
        runtime_site = Path("E:/Creator's Speech/runtime/site-packages")

        command = build_runtime_probe_command(
            python_executable="C:/Hstar/python/python.exe",
            runtime_site=runtime_site,
        )

        compile(command[-1], "<voice-runtime-probe>", "exec")
        self.assertIn(str(runtime_site.resolve()), command[-1])

    def test_repeated_install_returns_same_active_task(self):
        first = self.installer.start_install(profile="cpu")
        self.assertTrue(self.runner.started.wait(1))

        second = self.installer.start_install(profile="cpu")

        self.assertEqual(first.task_id, second.task_id)

    def test_auto_profile_uses_lightweight_hardware_probe(self):
        installer = VoiceInstaller(
            self.paths,
            runner=self.runner,
            python_executable=sys.executable,
            hardware_probe=lambda: "cuda",
        )

        task = installer.start_install(profile="auto")

        self.assertEqual(task.profile, "cuda")
        installer.cancel(task.task_id)
        installer.wait(task.task_id, timeout=2)

    def test_runtime_status_requires_matching_marker_and_site_packages(self):
        self.assertEqual(
            self.installer.runtime_status(),
            {"ready": False, "profile": ""},
        )
        self.paths["runtime_site"].mkdir(parents=True)
        self.paths["state"].mkdir(parents=True, exist_ok=True)
        manifest = self.installer._load_runtime_manifest()
        marker = self.paths["state"] / "runtime-install.json"
        marker.write_text(
            json.dumps({"profile": "cpu", "packages": manifest["packages"]}),
            encoding="utf-8",
        )

        self.assertEqual(
            self.installer.runtime_status(),
            {"ready": False, "profile": ""},
        )

        marker.write_text(
            json.dumps({
                "schema_version": RUNTIME_MARKER_SCHEMA,
                "python": manifest["python"],
                "profile": "cpu",
                "packages": manifest["packages"],
            }),
            encoding="utf-8",
        )
        self.assertEqual(
            self.installer.runtime_status(),
            {"ready": True, "profile": "cpu"},
        )

        marker.write_text(
            json.dumps({"profile": "cpu", "packages": ["wrong==1"]}),
            encoding="utf-8",
        )
        self.assertEqual(
            self.installer.runtime_status(),
            {"ready": False, "profile": ""},
        )

    def test_runtime_manifest_pins_numpy_for_reproducible_repairs(self):
        manifest = self.installer._load_runtime_manifest()

        self.assertIn("numpy==1.26.4", manifest["packages"])

    def test_runtime_install_probes_dependencies_before_marking_ready(self):
        runner = RecordingRunner()
        installer = VoiceInstaller(
            self.paths,
            runner=runner,
            python_executable=sys.executable,
            hardware_probe=lambda: "cpu",
        )
        installer._resolve_model_manifest = lambda: ("master", ())

        with patch(
            "voice_assistant.installer.ModelRegistry.detect",
            return_value=SimpleNamespace(ready=True),
        ):
            task = installer.start_install(profile="cpu")
            state = installer.wait(task.task_id, timeout=2)

        self.assertEqual(state.status, "completed")
        self.assertEqual(len(runner.commands), 2)
        self.assertIn("pip", runner.commands[0])
        self.assertIn("-I", runner.commands[1])
        marker = json.loads(
            (self.paths["state"] / "runtime-install.json").read_text(encoding="utf-8")
        )
        self.assertEqual(marker["schema_version"], RUNTIME_MARKER_SCHEMA)
        self.assertEqual(installer.runtime_status(), {"ready": True, "profile": "cpu"})

    def test_failed_runtime_probe_does_not_activate_or_mark_runtime(self):
        runner = RecordingRunner(fail_probe=True)
        installer = VoiceInstaller(
            self.paths,
            runner=runner,
            python_executable=sys.executable,
            hardware_probe=lambda: "cpu",
        )

        task = installer.start_install(profile="cpu")
        state = installer.wait(task.task_id, timeout=2)

        self.assertEqual(state.status, "failed")
        self.assertIn("numpy import failed", state.error_message)
        self.assertFalse(self.paths["runtime_site"].exists())
        self.assertFalse((self.paths["state"] / "runtime-install.json").exists())

    def test_cancelled_partial_download_is_resumable_not_ready(self):
        task = self.installer.start_install(profile="cpu")
        self.assertTrue(self.runner.started.wait(1))

        self.installer.cancel(task.task_id)
        state = self.installer.wait(task.task_id, timeout=2)

        self.assertEqual(state.status, "cancelled")
        self.assertFalse(state.model_ready)
        self.assertTrue(state.resume_available)
        persisted = json.loads(
            (self.paths["state"] / f"install-{task.task_id}.json").read_text(
                encoding="utf-8"
            )
        )
        self.assertEqual(persisted["status"], "cancelled")

    def test_runtime_retry_reuses_stable_partial_target(self):
        first = self.installer.start_install(profile="cpu")
        self.assertTrue(self.runner.started.wait(1))
        self.installer.cancel(first.task_id)
        self.installer.wait(first.task_id, timeout=2)
        first_target = self.runner.commands[0][self.runner.commands[0].index("--target") + 1]

        self.runner.started.clear()
        second = self.installer.start_install(profile="cpu")
        self.assertTrue(self.runner.started.wait(1))
        second_target = self.runner.commands[1][self.runner.commands[1].index("--target") + 1]

        self.assertEqual(second_target, first_target)
        self.installer.cancel(second.task_id)
        self.installer.wait(second.task_id, timeout=2)

    def test_activation_replaces_target_and_removes_backup(self):
        staging = self.paths["downloads"] / "candidate"
        target = self.paths["model"]
        staging.mkdir(parents=True)
        target.mkdir(parents=True)
        (staging / "version.txt").write_text("new", encoding="utf-8")
        (target / "version.txt").write_text("old", encoding="utf-8")

        activate_directory(staging, target)

        self.assertEqual((target / "version.txt").read_text(encoding="utf-8"), "new")
        self.assertFalse(staging.exists())
        self.assertFalse(target.with_name(f"{target.name}.backup").exists())

    def test_uninstall_keeps_external_model_without_confirmation(self):
        self.paths["managed"].mkdir(parents=True)
        self.paths["model"].mkdir(parents=True)
        (self.paths["model"] / "external.txt").write_text("keep", encoding="utf-8")

        deleted = uninstall_voice_data(self.paths)

        self.assertFalse(self.paths["managed"].exists())
        self.assertTrue(self.paths["model"].is_dir())
        self.assertNotIn(str(self.paths["model"]), deleted)

    def test_uninstall_removes_hstar_managed_model(self):
        self.paths["managed"].mkdir(parents=True)
        self.paths["model"].mkdir(parents=True)
        (self.paths["model"] / ".hstar-model.json").write_text(
            json.dumps({"managed_by": "HstarA"}),
            encoding="utf-8",
        )

        deleted = uninstall_voice_data(self.paths)

        self.assertFalse(self.paths["model"].exists())
        self.assertIn(str(self.paths["model"]), deleted)

    def test_failed_migration_keeps_source_and_target_unchanged(self):
        source = Path(self.temporary.name) / "source"
        target = Path(self.temporary.name) / "target"
        source.mkdir()
        target.mkdir()
        (source / "model.pt").write_text("source", encoding="utf-8")
        (target / "existing.txt").write_text("target", encoding="utf-8")

        with self.assertRaisesRegex(RuntimeError, "validation"):
            migrate_voice_root(source, target, validator=lambda _: False)

        self.assertEqual((source / "model.pt").read_text(encoding="utf-8"), "source")
        self.assertEqual((target / "existing.txt").read_text(encoding="utf-8"), "target")


if __name__ == "__main__":
    unittest.main()
