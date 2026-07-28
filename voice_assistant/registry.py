import hashlib
import json
import os
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import Callable, Iterable
from urllib.parse import urlencode
from urllib.request import Request, urlopen

from .settings import MODEL_ID


REQUIRED_PATHS = (
    "configuration.json",
    "config.yaml",
    "model.pt",
    "multilingual.tiktoken",
    "Qwen3-0.6B/config.json",
    "Qwen3-0.6B/generation_config.json",
    "Qwen3-0.6B/merges.txt",
    "Qwen3-0.6B/tokenizer.json",
    "Qwen3-0.6B/tokenizer_config.json",
    "Qwen3-0.6B/vocab.json",
)
FILES_API = "https://www.modelscope.cn/api/v1/models/{model_id}/repo/files"


class ModelManifestError(RuntimeError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class ManifestFile:
    path: str
    size: int
    sha256: str


@dataclass(frozen=True)
class ModelDetection:
    ready: bool
    model_path: str
    revision: str
    missing: tuple[str, ...]
    size_bytes: int
    source: str


def candidate_model_dirs(selected: Path) -> tuple[Path, ...]:
    selected = selected.expanduser().resolve()
    candidates = (
        selected,
        selected / "FunAudioLLM" / "Fun-ASR-Nano-2512",
        selected / "hub" / "FunAudioLLM" / "Fun-ASR-Nano-2512",
        selected / "models" / "FunAudioLLM" / "Fun-ASR-Nano-2512",
    )
    return tuple(dict.fromkeys(candidates))


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _safe_manifest_path(value: object) -> str:
    path = PurePosixPath(str(value or "").replace("\\", "/"))
    if not path.parts or path.is_absolute() or ".." in path.parts:
        raise ModelManifestError(
            "VOICE_MANIFEST_INVALID",
            f"Invalid repository path: {value!r}",
        )
    return path.as_posix()


def fetch_official_manifest(
    revision: str = "master", *, opener: Callable = urlopen
) -> tuple[ManifestFile, ...]:
    pending = [""]
    visited = set()
    files: list[ManifestFile] = []
    while pending:
        root = pending.pop()
        if root in visited:
            continue
        visited.add(root)
        query = urlencode({"Revision": revision or "master", "Root": root})
        request = Request(
            f"{FILES_API.format(model_id=MODEL_ID)}?{query}",
            headers={
                "Accept": "application/json",
                "User-Agent": "HstarA-Voice/1",
            },
        )
        try:
            with opener(request, timeout=20) as response:
                payload = json.load(response)
        except ModelManifestError:
            raise
        except Exception as error:
            raise ModelManifestError(
                "VOICE_MANIFEST_UNAVAILABLE",
                str(error),
            ) from error

        if payload.get("Code") != 200:
            raise ModelManifestError(
                "VOICE_MANIFEST_UNAVAILABLE",
                str(payload.get("Message") or "ModelScope manifest request failed"),
            )
        for item in payload.get("Data", {}).get("Files", []):
            item_type = item.get("Type")
            path = _safe_manifest_path(item.get("Path"))
            if item_type == "tree":
                pending.append(path)
            elif item_type == "blob":
                files.append(
                    ManifestFile(
                        path=path,
                        size=max(0, int(item.get("Size") or 0)),
                        sha256=str(item.get("Sha256") or "").lower(),
                    )
                )
    return tuple(sorted(files, key=lambda item: item.path))


def verify_against_manifest(
    model_path: Path, manifest: Iterable[ManifestFile]
) -> tuple[str, ...]:
    root = model_path.expanduser().resolve()
    invalid = []
    for item in manifest:
        relative = _safe_manifest_path(item.path)
        local = root.joinpath(*PurePosixPath(relative).parts)
        if not local.is_file():
            invalid.append(relative)
            continue
        if item.size and local.stat().st_size != item.size:
            invalid.append(relative)
            continue
        if item.sha256 and sha256_file(local) != item.sha256.lower():
            invalid.append(relative)
    return tuple(invalid)


def save_cached_manifest(
    cache_path: Path,
    *,
    revision: str,
    files: Iterable[ManifestFile],
) -> None:
    path = cache_path.expanduser().resolve()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "model_id": MODEL_ID,
        "revision": revision,
        "fetched_at": datetime.now(timezone.utc).isoformat(),
        "files": [asdict(item) for item in files],
    }
    temporary = path.with_name(f"{path.name}.tmp-{os.getpid()}")
    temporary.write_text(
        json.dumps(payload, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    os.replace(temporary, path)


def load_cached_manifest(cache_path: Path) -> tuple[str, tuple[ManifestFile, ...]]:
    path = cache_path.expanduser().resolve()
    if not path.is_file():
        return "", ()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("model_id") != MODEL_ID:
            return "", ()
        files = tuple(
            ManifestFile(
                path=_safe_manifest_path(item.get("path")),
                size=max(0, int(item.get("size") or 0)),
                sha256=str(item.get("sha256") or "").lower(),
            )
            for item in payload.get("files", [])
            if isinstance(item, dict)
        )
        return str(payload.get("revision") or ""), files
    except (OSError, ValueError, TypeError, ModelManifestError):
        return "", ()


class ModelRegistry:
    def detect(self, selected: str | Path) -> ModelDetection:
        best: ModelDetection | None = None
        for candidate in candidate_model_dirs(Path(selected)):
            missing = tuple(
                name for name in REQUIRED_PATHS if not (candidate / name).is_file()
            )
            detection = ModelDetection(
                ready=not missing,
                model_path=str(candidate),
                revision=self._read_revision(candidate),
                missing=missing,
                size_bytes=self._size(candidate) if candidate.is_dir() else 0,
                source=(
                    "managed"
                    if (candidate / ".hstar-model.json").is_file()
                    else "external"
                ),
            )
            if detection.ready:
                return detection
            if best is None or len(detection.missing) < len(best.missing):
                best = detection
        return best or ModelDetection(
            False,
            "",
            "",
            REQUIRED_PATHS,
            0,
            "external",
        )

    @staticmethod
    def _read_revision(candidate: Path) -> str:
        metadata = candidate / ".hstar-model.json"
        if not metadata.is_file():
            return ""
        try:
            payload = json.loads(metadata.read_text(encoding="utf-8"))
            return str(payload.get("revision") or "")
        except (OSError, ValueError, TypeError):
            return ""

    @staticmethod
    def _size(candidate: Path) -> int:
        total = 0
        for root, directories, files in os.walk(candidate, followlinks=False):
            directories[:] = [
                name for name in directories if not (Path(root) / name).is_symlink()
            ]
            for name in files:
                path = Path(root) / name
                try:
                    if not path.is_symlink():
                        total += path.stat().st_size
                except OSError:
                    continue
        return total
