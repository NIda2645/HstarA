from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import re
import tempfile
import threading
import time
import warnings
from pathlib import Path
from typing import Any

from PIL import Image

from openshop_ai import (
    OPENSHOP_AI_TOOL_IDS,
    OpenShopAiValidationError,
    normalize_ai_task_record,
)


class OpenShopStoreError(Exception):
    pass


class OpenShopNotFound(OpenShopStoreError):
    pass


class OpenShopOwnershipError(OpenShopStoreError):
    pass


class OpenShopVersionConflict(OpenShopStoreError):
    pass


class OpenShopValidationError(OpenShopStoreError):
    pass


class OpenShopProjectStore:
    SCHEMA_VERSION = 1
    MAX_IMAGE_BYTES = 64 * 1024 * 1024
    MAX_IMAGE_DIMENSION = 16384
    ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp"}

    _ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,96}$")
    _ASSET_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
    _SECRET_KEY_PATTERN = re.compile(
        r"^(?:api[_-]?key|authorization|access[_-]?token|secret|password)$",
        re.IGNORECASE,
    )
    _MIME_DETAILS = {
        "image/png": ("png", "PNG"),
        "image/jpeg": ("jpg", "JPEG"),
        "image/webp": ("webp", "WEBP"),
    }

    def __init__(self, data_dir: str):
        root = Path(data_dir).expanduser().resolve()
        self.root = root
        self.projects_dir = root / "projects"
        self.assets_dir = root / "assets"
        self.projects_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def initialize(self, project_id: str, owner: dict, document: dict) -> dict:
        project_id = self._validate_id(project_id, "projectId")
        normalized_owner = self._normalize_owner(owner)
        normalized_document = self._normalize_document(document)

        with self._lock:
            path = self._project_path(project_id)
            if path.exists():
                return self.load(project_id, normalized_owner)

            timestamp = self._now()
            project = {
                "schemaVersion": self.SCHEMA_VERSION,
                "projectId": project_id,
                "owner": normalized_owner,
                "document": normalized_document,
                "editor": {"objects": []},
                "layers": [],
                "sourceBindings": [],
                "fontRefs": [],
                "aiToolPreferences": {},
                "aiTaskRecords": [],
                "assetRefs": [],
                "previewAssetId": "",
                "autosaveVersion": 1,
                "exportRecords": [],
                "createdAt": timestamp,
                "updatedAt": timestamp,
            }
            self._atomic_write_json(path, project)
            return copy.deepcopy(project)

    def load(self, project_id: str, owner: dict) -> dict:
        project_id = self._validate_id(project_id, "projectId")
        normalized_owner = self._normalize_owner(owner)

        with self._lock:
            project = self._read_project(project_id)
            self._assert_owner(project, normalized_owner)
            return copy.deepcopy(project)

    def save(
        self,
        project_id: str,
        owner: dict,
        project: dict,
        base_version: int,
    ) -> dict:
        project_id = self._validate_id(project_id, "projectId")
        normalized_owner = self._normalize_owner(owner)

        with self._lock:
            current = self._read_project(project_id)
            self._assert_owner(current, normalized_owner)
            if isinstance(base_version, bool) or not isinstance(base_version, int):
                raise OpenShopValidationError("base_version must be an integer")
            if base_version != current.get("autosaveVersion"):
                raise OpenShopVersionConflict(
                    f"OpenShop project version changed: expected {base_version}, "
                    f"found {current.get('autosaveVersion')}"
                )

            candidate = self._normalize_project_for_save(
                project_id,
                normalized_owner,
                project,
                current,
            )
            candidate["autosaveVersion"] = base_version + 1
            candidate["updatedAt"] = self._now()
            self._atomic_write_json(self._project_path(project_id), candidate)
            return copy.deepcopy(candidate)

    def clone(
        self,
        source_project_id: str,
        target_project_id: str,
        target_owner: dict,
    ) -> dict:
        source_project_id = self._validate_id(source_project_id, "sourceProjectId")
        target_project_id = self._validate_id(target_project_id, "targetProjectId")
        normalized_owner = self._normalize_owner(target_owner)

        with self._lock:
            target_path = self._project_path(target_project_id)
            if target_path.exists():
                existing = self._read_project(target_project_id)
                self._assert_owner(existing, normalized_owner)
                return copy.deepcopy(existing)

            source = self._read_project(source_project_id)
            clone = copy.deepcopy(source)
            timestamp = self._now()
            clone["projectId"] = target_project_id
            clone["owner"] = normalized_owner
            clone["autosaveVersion"] = 1
            clone["createdAt"] = timestamp
            clone["updatedAt"] = timestamp
            clone["aiTaskRecords"] = []
            self._atomic_write_json(target_path, clone)
            return copy.deepcopy(clone)

    def delete(self, project_id: str, owner: dict | None = None) -> bool:
        project_id = self._validate_id(project_id, "projectId")
        normalized_owner = self._normalize_owner(owner) if owner is not None else None

        with self._lock:
            path = self._project_path(project_id)
            if not path.exists():
                return False
            project = self._read_project(project_id)
            if normalized_owner is not None:
                self._assert_owner(project, normalized_owner)
            path.unlink()
            return True

    def delete_canvas_projects(self, canvas_type: str, canvas_id: str) -> list[str]:
        normalized_canvas_type = str(canvas_type or "").strip()
        if normalized_canvas_type not in {"classic", "smart"}:
            raise OpenShopValidationError("canvasType must be classic or smart")
        normalized_canvas_id = self._validate_id(canvas_id, "canvasId")

        with self._lock:
            removed = []
            for path in sorted(self.projects_dir.glob("*.json")):
                project = self._read_json(path, "project")
                owner = project.get("owner") if isinstance(project, dict) else None
                if not isinstance(owner, dict):
                    raise OpenShopValidationError(f"Invalid OpenShop project owner: {path.name}")
                if (
                    owner.get("canvasType") == normalized_canvas_type
                    and owner.get("canvasId") == normalized_canvas_id
                ):
                    path.unlink()
                    removed.append(str(project.get("projectId") or path.stem))
            return removed

    def store_image(
        self,
        project_id: str,
        owner: dict,
        data: bytes,
        mime: str,
        name: str,
        role: str,
    ) -> dict:
        project_id = self._validate_id(project_id, "projectId")
        normalized_owner = self._normalize_owner(owner)
        normalized_mime = str(mime or "").strip().lower()
        if normalized_mime not in self.ALLOWED_IMAGE_MIME:
            raise OpenShopValidationError("Unsupported OpenShop image MIME type")
        if not isinstance(data, bytes) or not data:
            raise OpenShopValidationError("OpenShop image data is empty")
        if len(data) > self.MAX_IMAGE_BYTES:
            raise OpenShopValidationError("OpenShop image exceeds the 64 MiB limit")

        width, height = self._verify_image(data, normalized_mime)
        asset_id = hashlib.sha256(data).hexdigest()
        extension, _ = self._MIME_DETAILS[normalized_mime]
        asset_path = self.assets_dir / f"{asset_id}.{extension}"
        metadata_path = self.assets_dir / f"{asset_id}.json"

        with self._lock:
            project = self._read_project(project_id)
            self._assert_owner(project, normalized_owner)
            if not asset_path.exists():
                self._atomic_write_bytes(asset_path, data)

            if metadata_path.exists():
                metadata = self._read_json(metadata_path, "asset metadata")
                if metadata.get("assetId") != asset_id or metadata.get("mime") != normalized_mime:
                    raise OpenShopValidationError(f"Invalid OpenShop asset metadata: {asset_id}")
            else:
                metadata = {
                    "assetId": asset_id,
                    "mime": normalized_mime,
                    "extension": extension,
                    "size": len(data),
                    "width": width,
                    "height": height,
                    "createdAt": self._now(),
                }
                self._atomic_write_json(metadata_path, metadata)

            result = copy.deepcopy(metadata)
            result["name"] = self._safe_label(name, "OpenShop image")
            result["role"] = self._safe_label(role, "asset")
            return result

    def asset_path(self, asset_id: str) -> tuple[str, dict]:
        normalized_asset_id = self._validate_asset_id(asset_id)
        with self._lock:
            metadata_path = self.assets_dir / f"{normalized_asset_id}.json"
            if not metadata_path.is_file():
                raise OpenShopNotFound(f"OpenShop asset not found: {normalized_asset_id}")
            metadata = self._read_json(metadata_path, "asset metadata")
            if metadata.get("assetId") != normalized_asset_id:
                raise OpenShopValidationError(
                    f"Invalid OpenShop asset metadata: {normalized_asset_id}"
                )
            extension = metadata.get("extension")
            if extension not in {details[0] for details in self._MIME_DETAILS.values()}:
                raise OpenShopValidationError(
                    f"Invalid OpenShop asset extension: {normalized_asset_id}"
                )
            path = self.assets_dir / f"{normalized_asset_id}.{extension}"
            if not path.is_file():
                raise OpenShopNotFound(f"OpenShop asset file not found: {normalized_asset_id}")
            return str(path), copy.deepcopy(metadata)

    def collect_garbage(self) -> list[str]:
        with self._lock:
            referenced = set()
            for path in sorted(self.projects_dir.glob("*.json")):
                project = self._read_json(path, "project")
                asset_refs = project.get("assetRefs", [])
                if not isinstance(asset_refs, list):
                    raise OpenShopValidationError(f"Invalid assetRefs in {path.name}")
                for asset_id in asset_refs:
                    referenced.add(self._validate_asset_id(asset_id))
                preview_asset_id = project.get("previewAssetId")
                if preview_asset_id:
                    referenced.add(self._validate_asset_id(preview_asset_id))

            stored = set()
            for path in self.assets_dir.iterdir():
                if path.is_file() and self._ASSET_ID_PATTERN.fullmatch(path.stem):
                    stored.add(path.stem)

            removed = []
            for asset_id in sorted(stored - referenced):
                for path in self.assets_dir.glob(f"{asset_id}.*"):
                    if path.is_file():
                        path.unlink()
                removed.append(asset_id)
            return removed

    def _normalize_project_for_save(
        self,
        project_id: str,
        owner: dict,
        project: dict,
        current: dict,
    ) -> dict:
        if not isinstance(project, dict):
            raise OpenShopValidationError("OpenShop project must be an object")
        try:
            candidate = json.loads(json.dumps(project, ensure_ascii=False, allow_nan=False))
        except (TypeError, ValueError) as exc:
            raise OpenShopValidationError("OpenShop project must be valid JSON") from exc

        supplied_project_id = str(candidate.get("projectId") or "").strip()
        if supplied_project_id and supplied_project_id != project_id:
            raise OpenShopValidationError("OpenShop projectId cannot be changed")
        supplied_owner = candidate.get("owner")
        if supplied_owner is not None and self._normalize_owner(supplied_owner) != owner:
            raise OpenShopOwnershipError("OpenShop project owner cannot be changed")

        self._reject_embedded_data(candidate)
        font_refs = self._normalize_font_refs(candidate.get("fontRefs", []))
        ai_tool_preferences = self._normalize_ai_tool_preferences(
            candidate.get("aiToolPreferences", {})
        )
        ai_task_records = self._normalize_ai_task_records(
            candidate.get("aiTaskRecords", [])
        )
        asset_refs = candidate.get("assetRefs", [])
        if not isinstance(asset_refs, list):
            raise OpenShopValidationError("assetRefs must be an array")
        task_asset_refs = {
            str(record.get(key) or "").strip()
            for record in ai_task_records
            for key in ("sourceAssetId", "maskAssetId", "outputAssetId")
            if record.get(key)
        }
        normalized_asset_refs = sorted(
            {self._validate_asset_id(value) for value in [*asset_refs, *task_asset_refs]}
        )
        preview_asset_id = candidate.get("previewAssetId") or ""
        if preview_asset_id:
            preview_asset_id = self._validate_asset_id(preview_asset_id)

        for asset_id in {*normalized_asset_refs, *([preview_asset_id] if preview_asset_id else [])}:
            self.asset_path(asset_id)

        candidate["schemaVersion"] = self.SCHEMA_VERSION
        candidate["projectId"] = project_id
        candidate["owner"] = owner
        candidate["document"] = self._normalize_document(
            candidate.get("document") or current.get("document")
        )
        candidate["assetRefs"] = normalized_asset_refs
        candidate["previewAssetId"] = preview_asset_id
        candidate["fontRefs"] = font_refs
        candidate["aiToolPreferences"] = ai_tool_preferences
        candidate["aiTaskRecords"] = ai_task_records
        candidate["createdAt"] = current.get("createdAt")
        candidate.setdefault("editor", {"objects": []})
        candidate.setdefault("layers", [])
        candidate.setdefault("sourceBindings", [])
        candidate.setdefault("fontRefs", [])
        candidate.setdefault("aiToolPreferences", {})
        candidate.setdefault("aiTaskRecords", [])
        candidate.setdefault("exportRecords", [])
        return candidate

    def _normalize_font_refs(self, value: Any) -> list[dict]:
        if not isinstance(value, list):
            raise OpenShopValidationError("fontRefs must be an array")
        if len(value) > 128:
            raise OpenShopValidationError("fontRefs exceeds the 128 item limit")
        normalized = []
        seen = set()
        for item in value:
            if not isinstance(item, dict):
                raise OpenShopValidationError("fontRefs entries must be objects")
            raw_family = str(item.get("family") or "").strip()
            family = self._safe_label(raw_family, "")
            if not family or family != raw_family or len(raw_family) > 120:
                raise OpenShopValidationError("OpenShop font family is invalid")
            if family.casefold() in seen:
                continue
            seen.add(family.casefold())
            status = str(item.get("status") or "available").strip().lower()
            if status not in {"available", "missing", "substituted"}:
                raise OpenShopValidationError("OpenShop font status is invalid")
            result = {"family": family, "status": status}
            replacement = str(item.get("replacementFamily") or "").strip()
            if replacement:
                normalized_replacement = self._safe_label(replacement, "")
                if normalized_replacement != replacement or len(replacement) > 120:
                    raise OpenShopValidationError("OpenShop replacement font is invalid")
                result["replacementFamily"] = normalized_replacement
            normalized.append(result)
        return normalized

    def _normalize_ai_tool_preferences(self, value: Any) -> dict:
        if not isinstance(value, dict):
            raise OpenShopValidationError("aiToolPreferences must be an object")
        normalized = {}
        for tool_id, item in value.items():
            if tool_id not in OPENSHOP_AI_TOOL_IDS or not isinstance(item, dict):
                raise OpenShopValidationError("OpenShop AI tool preference is invalid")
            supplied_tool_id = str(item.get("toolId") or tool_id).strip()
            if supplied_tool_id != tool_id:
                raise OpenShopValidationError("OpenShop AI tool preference does not match its key")
            mode = str(item.get("mode") or "global").strip().lower()
            if mode not in {"global", "project"}:
                raise OpenShopValidationError("OpenShop AI preference mode is invalid")
            api_config_id = self._metadata_text(item.get("apiConfigId"), 96, "apiConfigId")
            model_id = self._metadata_text(item.get("modelId"), 240, "modelId")
            if mode == "project" and (not api_config_id or not model_id):
                raise OpenShopValidationError("Project-specific OpenShop AI preferences require an API and model")
            normalized[tool_id] = {
                "toolId": tool_id,
                "mode": mode,
                "apiConfigId": api_config_id,
                "modelId": model_id,
            }
        return normalized

    def _normalize_ai_task_records(self, value: Any) -> list[dict]:
        if not isinstance(value, list):
            raise OpenShopValidationError("aiTaskRecords must be an array")
        if len(value) > 100:
            raise OpenShopValidationError("aiTaskRecords exceeds the 100 item limit")
        normalized = []
        for item in value:
            try:
                normalized.append(normalize_ai_task_record(item))
            except OpenShopAiValidationError as exc:
                raise OpenShopValidationError(str(exc)) from exc
        return normalized

    @staticmethod
    def _metadata_text(value: Any, limit: int, label: str) -> str:
        text = str(value or "").strip()
        if len(text) > limit or any(ord(char) < 32 or ord(char) == 127 for char in text):
            raise OpenShopValidationError(f"OpenShop {label} is invalid")
        return text

    def _verify_image(self, data: bytes, mime: str) -> tuple[int, int]:
        _, expected_format = self._MIME_DETAILS[mime]
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", Image.DecompressionBombWarning)
                with Image.open(io.BytesIO(data)) as image:
                    actual_format = image.format
                    width, height = image.size
                    image.verify()
        except (Image.DecompressionBombWarning, Image.DecompressionBombError) as exc:
            raise OpenShopValidationError("OpenShop image dimensions are unsafe") from exc
        except Exception as exc:
            raise OpenShopValidationError("OpenShop image could not be decoded") from exc

        if actual_format != expected_format:
            raise OpenShopValidationError("OpenShop image MIME type does not match its content")
        if (
            width < 1
            or height < 1
            or width > self.MAX_IMAGE_DIMENSION
            or height > self.MAX_IMAGE_DIMENSION
        ):
            raise OpenShopValidationError("OpenShop image dimensions exceed 16384 x 16384")
        return width, height

    def _normalize_owner(self, owner: dict) -> dict:
        if not isinstance(owner, dict):
            raise OpenShopValidationError("OpenShop owner must be an object")
        canvas_type = str(owner.get("canvasType") or "").strip()
        if canvas_type not in {"classic", "smart"}:
            raise OpenShopValidationError("canvasType must be classic or smart")
        return {
            "canvasType": canvas_type,
            "canvasId": self._validate_id(owner.get("canvasId"), "canvasId"),
            "nodeId": self._validate_id(owner.get("nodeId"), "nodeId"),
        }

    def _normalize_document(self, document: dict) -> dict:
        if not isinstance(document, dict):
            raise OpenShopValidationError("OpenShop document must be an object")
        width = self._positive_dimension(document.get("width"), "document width")
        height = self._positive_dimension(document.get("height"), "document height")
        resolution = document.get("resolution", 72)
        try:
            resolution = int(resolution)
        except (TypeError, ValueError) as exc:
            raise OpenShopValidationError("OpenShop document resolution is invalid") from exc
        if resolution < 1 or resolution > 9600:
            raise OpenShopValidationError("OpenShop document resolution is invalid")
        color_space = str(document.get("colorSpace") or "srgb").strip().lower()
        if color_space not in {"srgb", "display-p3"}:
            raise OpenShopValidationError("OpenShop document color space is invalid")
        normalized = {
            "width": width,
            "height": height,
            "resolution": resolution,
            "colorSpace": color_space,
        }
        if "background" in document:
            background = document.get("background")
            if not isinstance(background, (str, dict, list, type(None))):
                raise OpenShopValidationError("OpenShop document background is invalid")
            normalized["background"] = copy.deepcopy(background)
        return normalized

    def _positive_dimension(self, value: Any, label: str) -> int:
        if isinstance(value, bool):
            raise OpenShopValidationError(f"{label} is invalid")
        try:
            number = int(value)
        except (TypeError, ValueError) as exc:
            raise OpenShopValidationError(f"{label} is invalid") from exc
        if number < 1 or number > self.MAX_IMAGE_DIMENSION:
            raise OpenShopValidationError(f"{label} is invalid")
        return number

    def _assert_owner(self, project: dict, owner: dict) -> None:
        if project.get("owner") != owner:
            raise OpenShopOwnershipError("OpenShop project belongs to another canvas node")

    def _read_project(self, project_id: str) -> dict:
        path = self._project_path(project_id)
        if not path.is_file():
            raise OpenShopNotFound(f"OpenShop project not found: {project_id}")
        project = self._read_json(path, "project")
        if (
            project.get("schemaVersion") != self.SCHEMA_VERSION
            or project.get("projectId") != project_id
        ):
            raise OpenShopValidationError(f"Invalid OpenShop project manifest: {project_id}")
        return project

    def _project_path(self, project_id: str) -> Path:
        return self.projects_dir / f"{project_id}.json"

    def _validate_id(self, value: Any, label: str) -> str:
        normalized = str(value or "").strip()
        if not self._ID_PATTERN.fullmatch(normalized):
            raise OpenShopValidationError(f"Invalid OpenShop {label}")
        return normalized

    def _validate_asset_id(self, value: Any) -> str:
        normalized = str(value or "").strip().lower()
        if not self._ASSET_ID_PATTERN.fullmatch(normalized):
            raise OpenShopValidationError("Invalid OpenShop assetId")
        return normalized

    def _reject_embedded_data(self, value: Any, key: str = "") -> None:
        if isinstance(value, dict):
            for child_key, child in value.items():
                if (
                    self._SECRET_KEY_PATTERN.fullmatch(str(child_key))
                    and child is not None
                    and child != ""
                ):
                    raise OpenShopValidationError("OpenShop project cannot store API credentials")
                self._reject_embedded_data(child, str(child_key))
            return
        if isinstance(value, list):
            for child in value:
                self._reject_embedded_data(child, key)
            return
        if isinstance(value, str):
            normalized = value.strip().lower()
            if normalized.startswith("data:image/") or normalized.startswith("blob:"):
                raise OpenShopValidationError("OpenShop project cannot store inline image data")

    def _read_json(self, path: Path, label: str) -> dict:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise OpenShopValidationError(f"Could not read OpenShop {label}: {path.name}") from exc
        if not isinstance(value, dict):
            raise OpenShopValidationError(f"Invalid OpenShop {label}: {path.name}")
        return value

    def _atomic_write_json(self, path: Path, value: dict) -> None:
        try:
            payload = json.dumps(
                value,
                ensure_ascii=False,
                allow_nan=False,
                separators=(",", ":"),
            ).encode("utf-8")
        except (TypeError, ValueError) as exc:
            raise OpenShopValidationError("OpenShop data is not valid JSON") from exc
        self._atomic_write_bytes(path, payload)

    def _atomic_write_bytes(self, path: Path, payload: bytes) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        descriptor, temporary_name = tempfile.mkstemp(
            prefix=f".{path.name}.",
            suffix=".tmp",
            dir=path.parent,
        )
        temporary_path = Path(temporary_name)
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(payload)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary_path, path)
        except Exception:
            try:
                os.close(descriptor)
            except OSError:
                pass
            raise
        finally:
            if temporary_path.exists():
                temporary_path.unlink()

    @staticmethod
    def _safe_label(value: Any, fallback: str) -> str:
        normalized = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "").strip())[:120]
        return normalized or fallback

    @staticmethod
    def _now() -> int:
        return int(time.time() * 1000)
