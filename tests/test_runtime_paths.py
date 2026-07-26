import tempfile
import unittest
from pathlib import Path

from hstar_runtime.paths import build_runtime_paths, default_data_root


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
            self.assertEqual(
                paths.user_workflow_dir,
                Path(data).resolve() / "config" / "workflows",
            )


if __name__ == "__main__":
    unittest.main()
