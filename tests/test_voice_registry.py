import hashlib
import io
import json
import tempfile
import unittest
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from voice_assistant.registry import (
    REQUIRED_PATHS,
    ManifestFile,
    ModelRegistry,
    fetch_official_manifest,
    load_cached_manifest,
    save_cached_manifest,
    verify_against_manifest,
)


REQUIRED = {
    "configuration.json": b"{}",
    "config.yaml": b"model: FunASRNano\n",
    "model.pt": b"weights",
    "multilingual.tiktoken": b"tokens",
    "Qwen3-0.6B/config.json": b"{}",
    "Qwen3-0.6B/generation_config.json": b"{}",
    "Qwen3-0.6B/merges.txt": b"",
    "Qwen3-0.6B/tokenizer.json": b"{}",
    "Qwen3-0.6B/tokenizer_config.json": b"{}",
    "Qwen3-0.6B/vocab.json": b"{}",
}


def make_model(root: Path) -> None:
    for relative, content in REQUIRED.items():
        target = root / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content)


class JsonResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc_value, traceback):
        self.close()


class VoiceRegistryTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)

    def tearDown(self):
        self.temporary.cleanup()

    def test_accepts_direct_model_directory(self):
        make_model(self.root)

        result = ModelRegistry().detect(self.root)

        self.assertTrue(result.ready)
        self.assertEqual(result.model_path, str(self.root.resolve()))
        self.assertGreater(result.size_bytes, 0)

    def test_accepts_modelscope_parent_layout(self):
        model = self.root / "FunAudioLLM" / "Fun-ASR-Nano-2512"
        make_model(model)

        result = ModelRegistry().detect(self.root)

        self.assertTrue(result.ready)
        self.assertEqual(result.model_path, str(model.resolve()))

    def test_rejects_missing_weights_without_recursive_disk_scan(self):
        make_model(self.root)
        (self.root / "model.pt").unlink()
        unrelated = self.root / "unbounded" / "nested" / "model.pt"
        unrelated.parent.mkdir(parents=True)
        unrelated.write_bytes(b"wrong")

        result = ModelRegistry().detect(self.root)

        self.assertFalse(result.ready)
        self.assertIn("model.pt", result.missing)

    def test_current_required_paths_do_not_invent_model_py(self):
        self.assertNotIn("model.py", REQUIRED_PATHS)

    def test_fetches_repository_manifest_recursively(self):
        responses = {
            "": [
                {"Type": "blob", "Path": "model.pt", "Size": 7, "Sha256": "abc"},
                {"Type": "tree", "Path": "Qwen3-0.6B", "Size": 0, "Sha256": ""},
            ],
            "Qwen3-0.6B": [
                {
                    "Type": "blob",
                    "Path": "Qwen3-0.6B/config.json",
                    "Size": 2,
                    "Sha256": "def",
                }
            ],
        }
        requested_roots = []

        def opener(request, timeout):
            self.assertEqual(timeout, 20)
            root = parse_qs(urlparse(request.full_url).query).get("Root", [""])[0]
            requested_roots.append(root)
            payload = {"Code": 200, "Data": {"Files": responses[root]}}
            return JsonResponse(json.dumps(payload).encode("utf-8"))

        manifest = fetch_official_manifest("master", opener=opener)

        self.assertEqual(requested_roots, ["", "Qwen3-0.6B"])
        self.assertEqual(
            [item.path for item in manifest],
            ["Qwen3-0.6B/config.json", "model.pt"],
        )

    def test_verifies_manifest_size_and_sha256(self):
        content = b"verified"
        target = self.root / "model.pt"
        target.write_bytes(content)
        manifest = (
            ManifestFile(
                path="model.pt",
                size=len(content),
                sha256=hashlib.sha256(content).hexdigest(),
            ),
        )

        self.assertEqual(verify_against_manifest(self.root, manifest), ())

        target.write_bytes(b"corrupt")
        self.assertEqual(verify_against_manifest(self.root, manifest), ("model.pt",))

    def test_cached_manifest_round_trips_revision_and_files(self):
        cache = self.root / "state" / "model-manifest.json"
        files = (ManifestFile("model.pt", 7, "abc"),)

        save_cached_manifest(cache, revision="commit-1", files=files)
        revision, loaded = load_cached_manifest(cache)

        self.assertEqual(revision, "commit-1")
        self.assertEqual(loaded, files)


if __name__ == "__main__":
    unittest.main()
