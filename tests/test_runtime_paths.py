import tempfile
import unittest
from pathlib import Path

from hstar_runtime.paths import (
    build_runtime_paths,
    build_storage_path_map,
    default_data_root,
    uses_existing_legacy_storage_layout,
)


class RuntimePathTests(unittest.TestCase):
    def test_prefers_e_drive_and_creates_hstar_cache_name(self):
        root = default_data_root(
            drive_exists=lambda drive: drive == "E:\\",
            documents=Path("C:/Users/Test/Documents"),
        )

        self.assertEqual(root, Path("E:/Hstar缓存"))

    def test_falls_back_to_documents_without_e_drive(self):
        root = default_data_root(
            drive_exists=lambda _drive: False,
            documents=Path("C:/Users/Test/Documents"),
        )

        self.assertEqual(root, Path("C:/Users/Test/Documents/Hstar缓存"))

    def test_every_writable_path_stays_under_data_root(self):
        with tempfile.TemporaryDirectory() as program, tempfile.TemporaryDirectory() as data:
            paths = build_runtime_paths(Path(program), Path(data), "windows11")

            for path in paths.writable_paths():
                self.assertTrue(path.is_relative_to(Path(data).resolve()), path)
            self.assertEqual(paths.static_dir, Path(program).resolve() / "static")

    def test_existing_legacy_layout_is_mapped_in_place_without_creating_modern_paths(self):
        with tempfile.TemporaryDirectory() as program, tempfile.TemporaryDirectory() as data:
            data_root = Path(data)
            legacy_data = data_root / "data"
            legacy_canvases = legacy_data / "canvases"
            legacy_canvases.mkdir(parents=True)
            (legacy_canvases / "canvas-1.json").write_text("{}", encoding="utf-8")
            (legacy_data / "software_settings.json").write_text("{}", encoding="utf-8")
            paths = build_runtime_paths(Path(program), data_root, "development")

            self.assertTrue(uses_existing_legacy_storage_layout(paths))
            storage = build_storage_path_map(paths, prefer_existing_legacy=True)

            self.assertEqual(storage["data_dir"], legacy_data)
            self.assertEqual(storage["canvas_dir"], legacy_canvases)
            self.assertEqual(storage["openshop_data_dir"], legacy_data / "openshop")
            self.assertEqual(storage["software_settings_file"], legacy_data / "software_settings.json")
            self.assertEqual(storage["history_file"], data_root / "history.json")
            self.assertEqual(storage["output_dir"], data_root / "output")
            self.assertEqual(storage["output_output_dir"], data_root / "assets" / "output")
            self.assertFalse((data_root / "config").exists())
            self.assertFalse((data_root / "projects").exists())

    def test_legacy_layout_remains_available_after_modern_canvases_are_created(self):
        with tempfile.TemporaryDirectory() as program, tempfile.TemporaryDirectory() as data:
            data_root = Path(data)
            legacy_canvases = data_root / "data" / "canvases"
            modern_canvases = data_root / "projects" / "canvases"
            legacy_canvases.mkdir(parents=True)
            modern_canvases.mkdir(parents=True)
            (legacy_canvases / "legacy.json").write_text("{}", encoding="utf-8")
            (modern_canvases / "modern.json").write_text("{}", encoding="utf-8")
            paths = build_runtime_paths(Path(program), data_root, "development")

            self.assertTrue(uses_existing_legacy_storage_layout(paths))
            storage = build_storage_path_map(paths)
            legacy_storage = build_storage_path_map(paths, prefer_existing_legacy=True)

            self.assertEqual(storage["canvas_dir"], modern_canvases)
            self.assertEqual(storage["data_dir"], data_root / "config")
            self.assertEqual(legacy_storage["canvas_dir"], legacy_canvases)
            self.assertEqual(legacy_storage["data_dir"], data_root / "data")
            self.assertEqual(
                paths.user_workflow_dir,
                Path(data).resolve() / "config" / "workflows",
            )

    def test_legacy_singletons_and_conversations_enable_compatibility_without_canvases(self):
        with tempfile.TemporaryDirectory() as program, tempfile.TemporaryDirectory() as data:
            data_root = Path(data)
            conversation_dir = data_root / "data" / "conversations" / "legacy-user"
            conversation_dir.mkdir(parents=True)
            (conversation_dir / "conversation.json").write_text("{}", encoding="utf-8")
            (data_root / "history.json").write_text("[]", encoding="utf-8")
            paths = build_runtime_paths(Path(program), data_root, "development")

            self.assertTrue(uses_existing_legacy_storage_layout(paths))
            legacy_storage = build_storage_path_map(
                paths,
                prefer_existing_legacy=True,
            )
            self.assertEqual(
                legacy_storage["conversation_dir"],
                data_root / "data" / "conversations",
            )
            self.assertEqual(legacy_storage["history_file"], data_root / "history.json")


if __name__ == "__main__":
    unittest.main()
