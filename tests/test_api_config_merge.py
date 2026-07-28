import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout
from copy import deepcopy
from datetime import datetime, timezone
from pathlib import Path

from hstar_runtime.api_merge import merge_api_defaults, update_api_config
from hstar_runtime.maintenance import main as maintenance_main


def canonical_json(value):
    return json.dumps(
        value,
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )


class ApiConfigMergeTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.current_file = self.root / "data" / "config" / "api-providers.user.json"
        self.defaults_file = self.root / "program" / "API" / "defaults" / "api-providers.json"
        self.backup_dir = self.root / "data" / "backups"
        self.current_file.parent.mkdir(parents=True)
        self.defaults_file.parent.mkdir(parents=True)

    def tearDown(self):
        self.temporary.cleanup()

    def current_providers(self):
        return [
            {
                "id": "volcengine",
                "name": "用户改过的火山名称",
                "base_url": "https://old.example/v1",
                "protocol": "openai",
                "icon": "old-icon.png",
                "image_models": ["old-image-model"],
                "enabled": False,
                "primary": True,
                "use_system_proxy": False,
                "user_note": "keep this note",
                "api_key": "legacy-provider-secret",
            },
            {
                "id": "my-lab",
                "name": "My Lab",
                "base_url": "https://lab.example/v1",
                "protocol": "openai",
                "image_models": ["lab-image"],
                "enabled": True,
                "primary": False,
                "use_system_proxy": True,
                "custom_metadata": {"owner": "user", "priority": 7},
            },
        ]

    def default_providers(self):
        return [
            {
                "id": "volcengine",
                "name": "火山引擎",
                "base_url": "https://ark.cn-beijing.volces.com/api/v3",
                "protocol": "volcengine",
                "icon": "volcengine.png",
                "image_models": ["doubao-seedream-4-5"],
                "enabled": True,
                "primary": False,
                "use_system_proxy": True,
                "volcengine_secret_access_key": "must-never-be-saved",
            },
            {
                "id": "modelscope",
                "name": "ModelScope",
                "base_url": "https://api-inference.modelscope.cn/v1",
                "protocol": "openai",
                "icon": "modelscope.png",
                "image_models": ["Tongyi-MAI/Z-Image-Turbo"],
                "enabled": True,
                "primary": False,
                "use_system_proxy": True,
            },
        ]

    def test_merge_updates_official_fields_and_preserves_user_choices(self):
        current = self.current_providers()
        defaults = self.default_providers()
        custom_before = canonical_json(current[1])

        merged = merge_api_defaults(current, defaults)

        volcengine = merged[0]
        self.assertEqual(volcengine["name"], "火山引擎")
        self.assertEqual(volcengine["protocol"], "volcengine")
        self.assertEqual(volcengine["icon"], "volcengine.png")
        self.assertEqual(volcengine["image_models"], ["doubao-seedream-4-5"])
        self.assertFalse(volcengine["enabled"])
        self.assertTrue(volcengine["primary"])
        self.assertFalse(volcengine["use_system_proxy"])
        self.assertEqual(volcengine["user_note"], "keep this note")
        self.assertNotIn("api_key", volcengine)
        self.assertNotIn("volcengine_secret_access_key", volcengine)
        self.assertEqual(merged[1]["id"], "modelscope")
        self.assertEqual(canonical_json(merged[2]), custom_before)

    def test_merge_does_not_mutate_inputs(self):
        current = self.current_providers()
        defaults = self.default_providers()
        current_before = deepcopy(current)
        defaults_before = deepcopy(defaults)

        merge_api_defaults(current, defaults)

        self.assertEqual(current, current_before)
        self.assertEqual(defaults, defaults_before)

    def test_duplicate_provider_ids_are_rejected(self):
        defaults = self.default_providers()
        defaults.append(deepcopy(defaults[0]))

        with self.assertRaisesRegex(ValueError, "duplicate provider id"):
            merge_api_defaults(self.current_providers(), defaults)

    def test_repository_defaults_are_complete_and_secret_free(self):
        defaults_path = (
            Path(__file__).resolve().parents[1]
            / "API"
            / "defaults"
            / "api-providers.json"
        )

        defaults = json.loads(defaults_path.read_text(encoding="utf-8"))

        self.assertEqual(
            [provider["id"] for provider in defaults],
            ["modelscope", "runninghub", "volcengine"],
        )
        self.assertEqual(merge_api_defaults([], defaults), defaults)
        serialized = canonical_json(defaults).lower()
        for field in (
            "api_key",
            "wallet_api_key",
            "volcengine_access_key_id",
            "volcengine_secret_access_key",
        ):
            self.assertNotIn(field, serialized)

    def test_update_backs_up_original_and_atomically_writes_verified_merge(self):
        current_payload = (
            json.dumps(self.current_providers(), ensure_ascii=False, indent=2) + "\n"
        ).encode("utf-8")
        self.current_file.write_bytes(current_payload)
        self.defaults_file.write_text(
            json.dumps(self.default_providers(), ensure_ascii=False),
            encoding="utf-8",
        )

        result = update_api_config(
            self.current_file,
            self.defaults_file,
            self.backup_dir,
            clock=lambda: datetime(2026, 7, 26, 20, 15, tzinfo=timezone.utc),
        )

        self.assertEqual(result.provider_count, 3)
        self.assertEqual(result.official_provider_count, 2)
        self.assertEqual(
            result.backup_path,
            self.backup_dir / "api" / "api-providers-20260726-201500.json",
        )
        backup = json.loads(result.backup_path.read_text(encoding="utf-8"))
        self.assertEqual(backup[0]["user_note"], "keep this note")
        self.assertEqual(backup[1], self.current_providers()[1])
        self.assertNotIn("api_key", backup[0])
        self.assertNotIn("legacy-provider-secret", result.backup_path.read_text(encoding="utf-8"))
        written = json.loads(self.current_file.read_text(encoding="utf-8"))
        self.assertEqual(written, merge_api_defaults(self.current_providers(), self.default_providers()))
        self.assertNotIn("legacy-provider-secret", self.current_file.read_text(encoding="utf-8"))
        self.assertEqual(list(self.current_file.parent.glob("*.tmp")), [])

    def test_invalid_current_json_is_left_untouched(self):
        original = b'[{"id":"volcengine"},'
        self.current_file.write_bytes(original)
        self.defaults_file.write_text(
            json.dumps(self.default_providers(), ensure_ascii=False),
            encoding="utf-8",
        )

        with self.assertRaises(json.JSONDecodeError):
            update_api_config(
                self.current_file,
                self.defaults_file,
                self.backup_dir,
            )

        self.assertEqual(self.current_file.read_bytes(), original)
        self.assertFalse((self.backup_dir / "api").exists())


class MaintenanceCommandTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.program_root = self.root / "program"
        self.data_root = self.root / "data"
        self.defaults_file = self.program_root / "API" / "defaults" / "api-providers.json"
        self.current_file = self.data_root / "config" / "api-providers.user.json"
        self.defaults_file.parent.mkdir(parents=True)
        self.current_file.parent.mkdir(parents=True)
        self.defaults_file.write_text(
            json.dumps([{"id": "official", "protocol": "openai"}]),
            encoding="utf-8",
        )
        self.current_file.write_text(
            json.dumps([{"id": "official", "api_key": "do-not-print"}]),
            encoding="utf-8",
        )

    def tearDown(self):
        self.temporary.cleanup()

    def run_command(self, arguments):
        output = io.StringIO()
        with redirect_stdout(output):
            code = maintenance_main(arguments)
        return code, output.getvalue()

    def valid_arguments(self):
        return [
            "update-api-config",
            "--program-root",
            str(self.program_root),
            "--data-root",
            str(self.data_root),
            "--edition",
            "windows11",
        ]

    def test_update_api_config_returns_zero_with_localized_secret_free_summary(self):
        code, output = self.run_command(self.valid_arguments())

        self.assertEqual(code, 0)
        self.assertIn("API 配置更新完成", output)
        self.assertNotIn("do-not-print", output)
        self.assertNotIn(str(self.program_root), output)
        self.assertNotIn(str(self.data_root), output)

    def test_invalid_arguments_return_two_without_argparse_noise(self):
        code, output = self.run_command(["update-api-config"])

        self.assertEqual(code, 2)
        self.assertEqual(output.strip(), "维护命令参数无效。")

    def test_overlapping_program_and_data_roots_return_two(self):
        data_root = self.root / "overlap-data"
        program_root = data_root / "program"
        defaults_file = program_root / "API" / "defaults" / "api-providers.json"
        defaults_file.parent.mkdir(parents=True)
        defaults_file.write_text(
            json.dumps([{"id": "official", "protocol": "openai"}]),
            encoding="utf-8",
        )

        code, output = self.run_command(
            [
                "update-api-config",
                "--program-root",
                str(program_root),
                "--data-root",
                str(data_root),
                "--edition",
                "windows11",
            ]
        )

        self.assertEqual(code, 2)
        self.assertEqual(output.strip(), "维护命令参数无效。")

    def test_merge_failure_returns_three_without_exception_or_secret(self):
        self.current_file.write_text('[{"id":"official"},', encoding="utf-8")

        code, output = self.run_command(self.valid_arguments())

        self.assertEqual(code, 3)
        self.assertEqual(output.strip(), "API 配置更新失败，已保留原配置。")
        self.assertNotIn("Traceback", output)
        self.assertNotIn("do-not-print", output)


if __name__ == "__main__":
    unittest.main()
