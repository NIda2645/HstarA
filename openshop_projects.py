from __future__ import annotations

import copy
import hashlib
import io
import json
import os
import re
import shutil
import tempfile
import threading
import time
import warnings
from pathlib import Path
from typing import Any

from PIL import Image

from openshop_ai import (
    OPENSHOP_AI_TOOL_IDS,
    OPENSHOP_GENERATIVE_TOOL_IDS,
    OpenShopAiValidationError,
    normalize_ai_task_record,
    normalize_reference_record,
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
    MAX_PENDING_ASSET_REFS = 256
    PENDING_ASSET_REF_TTL_MS = 24 * 60 * 60 * 1000
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

    def __init__(self, data_dir: str, canvas_dir: str | None = None):
        root = Path(data_dir).expanduser().resolve()
        self.root = root
        self.legacy_projects_dir = root / "projects"
        self.assets_dir = root / "assets"
        self.canvas_dir = Path(canvas_dir or (root / "canvases")).expanduser().resolve()
        self.legacy_projects_dir.mkdir(parents=True, exist_ok=True)
        self.assets_dir.mkdir(parents=True, exist_ok=True)
        self.canvas_dir.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()

    def initialize(self, project_id: str, owner: dict, document: dict) -> dict:
        project_id = self._validate_id(project_id, "projectId")
        normalized_owner = self._normalize_owner(owner)
        normalized_document = self._normalize_document(document)

        with self._lock:
            path = self._project_path(normalized_owner)
            if path.exists() or self._legacy_project_path(project_id).exists():
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
                "aiReferenceRecords": [],
                "aiTaskRecords": [],
                "aiPendingResults": [],
                "assetRefs": [],
                "pendingAssetRefs": [],
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
            return copy.deepcopy(self._read_project(project_id, normalized_owner))

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
            current = self._read_project(project_id, normalized_owner)
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
            self._atomic_write_json(self._project_path(normalized_owner), candidate)
            return copy.deepcopy(candidate)

    def clone(
        self,
        source_project_id: str,
        source_owner: dict,
        target_project_id: str,
        target_owner: dict,
    ) -> dict:
        source_project_id = self._validate_id(source_project_id, "sourceProjectId")
        target_project_id = self._validate_id(target_project_id, "targetProjectId")
        normalized_source_owner = self._normalize_owner(source_owner)
        normalized_target_owner = self._normalize_owner(target_owner)

        with self._lock:
            source = self._read_project(source_project_id, normalized_source_owner)
            target_path = self._project_path(normalized_target_owner)
            if (
                target_path.exists()
                or self._legacy_project_path(target_project_id).exists()
            ):
                existing = self._read_project(target_project_id, normalized_target_owner)
                return copy.deepcopy(existing)

            clone = copy.deepcopy(source)
            timestamp = self._now()
            clone["projectId"] = target_project_id
            clone["owner"] = normalized_target_owner
            clone["autosaveVersion"] = 1
            clone["createdAt"] = timestamp
            clone["updatedAt"] = timestamp
            clone["aiTaskRecords"] = []
            clone["aiReferenceRecords"] = []
            clone["aiPendingResults"] = []
            clone["pendingAssetRefs"] = []
            self._atomic_write_json(target_path, clone)
            return copy.deepcopy(clone)

    def delete(self, project_id: str, owner: dict | None = None) -> bool:
        project_id = self._validate_id(project_id, "projectId")
        if owner is None:
            raise OpenShopValidationError("OpenShop owner is required for deletion")
        normalized_owner = self._normalize_owner(owner)

        with self._lock:
            path = self._project_path(normalized_owner)
            if not path.exists():
                legacy_path = self._legacy_project_path(project_id)
                if not legacy_path.exists():
                    return False
                project = self._read_json(legacy_path, "legacy project")
                self._validate_project_manifest(project, project_id, normalized_owner)
                legacy_path.unlink()
                return True

            project = self._read_json(path, "project")
            self._validate_project_manifest(project, project_id, normalized_owner)
            legacy_path = self._legacy_project_path(project_id)
            if legacy_path.exists():
                legacy = self._read_json(legacy_path, "legacy project")
                self._validate_project_manifest(legacy, project_id, normalized_owner)
                legacy_path.unlink()
            project_directory = self._project_directory(normalized_owner)
            shutil.rmtree(project_directory)
            canvas_sidecar = project_directory.parent
            if canvas_sidecar.is_dir() and not any(canvas_sidecar.iterdir()):
                canvas_sidecar.rmdir()
            return True

    def delete_canvas_projects(self, canvas_type: str, canvas_id: str) -> list[str]:
        normalized_canvas_type = str(canvas_type or "").strip()
        if normalized_canvas_type not in {"classic", "smart"}:
            raise OpenShopValidationError("canvasType must be classic or smart")
        normalized_canvas_id = self._validate_id(canvas_id, "canvasId")
        canvas_sidecar = self.canvas_dir / f"{normalized_canvas_id}.openshop"

        with self._lock:
            sidecar_projects = []
            if canvas_sidecar.is_dir():
                for path in sorted(canvas_sidecar.glob("*/project.json")):
                    node_id = self._validate_id(path.parent.name, "nodeId")
                    owner = {
                        "canvasType": normalized_canvas_type,
                        "canvasId": normalized_canvas_id,
                        "nodeId": node_id,
                    }
                    project = self._read_json(path, "project")
                    project_id = self._validate_id(project.get("projectId"), "projectId")
                    self._validate_project_manifest(project, project_id, owner)
                    sidecar_projects.append(project_id)

            legacy_projects = []
            for path in sorted(self.legacy_projects_dir.glob("*.json")):
                project = self._read_json(path, "legacy project")
                project_id = self._validate_id(project.get("projectId"), "projectId")
                owner = self._normalize_owner(project.get("owner"))
                self._validate_project_manifest(project, project_id, owner)
                if path != self._legacy_project_path(project_id):
                    raise OpenShopValidationError(
                        f"Invalid OpenShop legacy project path: {path.name}"
                    )
                if (
                    owner["canvasType"] == normalized_canvas_type
                    and owner["canvasId"] == normalized_canvas_id
                ):
                    legacy_projects.append((path, project_id))

            if canvas_sidecar.is_dir():
                shutil.rmtree(canvas_sidecar)
            for path, _ in legacy_projects:
                path.unlink()
            return sorted({*sidecar_projects, *(item[1] for item in legacy_projects)})

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
        result_name = self._safe_label(name, "OpenShop image")
        result_role = self._safe_label(role, "asset")

        with self._lock:
            project = self._read_project(project_id, normalized_owner)
            pending_asset_refs = self._unexpired_pending_asset_refs(
                project.get("pendingAssetRefs", []),
                self._now(),
            )
            pending_asset_ids = {item["assetId"] for item in pending_asset_refs}
            asset_refs = project.get("assetRefs", [])
            if not isinstance(asset_refs, list):
                raise OpenShopValidationError("assetRefs must be an array")
            permanent_asset_refs = {
                self._validate_asset_id(value) for value in asset_refs
            }
            preview_asset_id = project.get("previewAssetId") or ""
            if preview_asset_id:
                preview_asset_id = self._validate_asset_id(preview_asset_id)
            needs_provisional_ref = (
                result_role != "output"
                and asset_id not in permanent_asset_refs
                and asset_id != preview_asset_id
            )
            if (
                needs_provisional_ref
                and asset_id not in pending_asset_ids
                and len(pending_asset_refs) >= self.MAX_PENDING_ASSET_REFS
            ):
                raise OpenShopValidationError("OpenShop pendingAssetRefs limit reached")

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

            if result_role == "output":
                project["assetRefs"] = sorted({
                    *permanent_asset_refs,
                    asset_id,
                })
                project["pendingAssetRefs"] = [
                    item for item in pending_asset_refs
                    if item["assetId"] != asset_id
                ]
                export_records = project.get("exportRecords", [])
                if not isinstance(export_records, list):
                    raise OpenShopValidationError("exportRecords must be an array")
                export_record = {
                    "assetId": asset_id,
                    "name": result_name,
                    "width": width,
                    "height": height,
                    "createdAt": self._now(),
                }
                project["exportRecords"] = [
                    *(
                        item for item in export_records
                        if isinstance(item, dict) and item.get("assetId") != asset_id
                    ),
                    export_record,
                ][-256:]
                project["updatedAt"] = export_record["createdAt"]
            elif needs_provisional_ref:
                project["pendingAssetRefs"] = [
                    *(
                        item for item in pending_asset_refs
                        if item["assetId"] != asset_id
                    ),
                    {
                        "assetId": asset_id,
                        "expiresAt": self._now() + self.PENDING_ASSET_REF_TTL_MS,
                    },
                ]
            else:
                project["pendingAssetRefs"] = [
                    item for item in pending_asset_refs
                    if item["assetId"] != asset_id
                ]
            self._atomic_write_json(self._project_path(normalized_owner), project)

            result = copy.deepcopy(metadata)
            result["name"] = result_name
            result["role"] = result_role
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

    def collect_garbage(self, additional_asset_refs=None) -> list[str]:
        with self._lock:
            referenced = set()
            now = self._now()
            for path in self._iter_project_paths():
                project = self._read_json(path, "project")
                raw_pending_asset_refs = project.get("pendingAssetRefs", [])
                project_id = self._validate_id(project.get("projectId"), "projectId")
                if path.parent == self.legacy_projects_dir:
                    owner = self._normalize_owner(project.get("owner"))
                    if path != self._legacy_project_path(project_id):
                        raise OpenShopValidationError(
                            f"Invalid OpenShop legacy project path: {path.name}"
                        )
                else:
                    canvas_sidecar_name = path.parent.parent.name
                    if not canvas_sidecar_name.endswith(".openshop"):
                        raise OpenShopValidationError(
                            f"Invalid OpenShop project path: {path}"
                        )
                    owner = {
                        "canvasType": self._normalize_owner(project.get("owner"))["canvasType"],
                        "canvasId": self._validate_id(
                            canvas_sidecar_name.removesuffix(".openshop"),
                            "canvasId",
                        ),
                        "nodeId": self._validate_id(path.parent.name, "nodeId"),
                    }
                    if path != self._project_path(owner):
                        raise OpenShopValidationError(
                            f"Invalid OpenShop project path: {path}"
                        )
                self._validate_project_manifest(project, project_id, owner)
                asset_refs = project.get("assetRefs", [])
                if not isinstance(asset_refs, list):
                    raise OpenShopValidationError(f"Invalid assetRefs in {path.name}")
                for asset_id in asset_refs:
                    referenced.add(self._validate_asset_id(asset_id))
                preview_asset_id = project.get("previewAssetId")
                if preview_asset_id:
                    referenced.add(self._validate_asset_id(preview_asset_id))
                pending_asset_refs = self._unexpired_pending_asset_refs(
                    project.get("pendingAssetRefs", []),
                    now,
                )
                if pending_asset_refs != raw_pending_asset_refs:
                    project["pendingAssetRefs"] = pending_asset_refs
                    self._atomic_write_json(path, project)
                for item in pending_asset_refs:
                    referenced.add(item["assetId"])
            for asset_id in additional_asset_refs or []:
                referenced.add(self._validate_asset_id(asset_id))

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

        candidate.pop("pendingAssetRefs", None)
        self._reject_embedded_data(candidate)
        font_refs = self._normalize_font_refs(candidate.get("fontRefs", []))
        ai_tool_preferences = self._normalize_ai_tool_preferences(
            candidate.get("aiToolPreferences", {})
        )
        ai_reference_records = self._normalize_ai_reference_records(
            candidate.get("aiReferenceRecords", [])
        )
        ai_task_records = self._normalize_ai_task_records(
            candidate.get("aiTaskRecords", [])
        )
        ai_pending_results = self._normalize_ai_pending_results(
            candidate.get("aiPendingResults", [])
        )
        current_export_records = self._normalize_export_records(
            current.get("exportRecords", [])
        )
        supplied_export_records = self._normalize_export_records(
            candidate.get("exportRecords", [])
        )
        merged_export_records = {}
        for item in [*current_export_records, *supplied_export_records]:
            merged_export_records.pop(item["assetId"], None)
            merged_export_records[item["assetId"]] = item
        export_records = list(merged_export_records.values())[-256:]
        asset_refs = candidate.get("assetRefs", [])
        if not isinstance(asset_refs, list):
            raise OpenShopValidationError("assetRefs must be an array")
        discovered_asset_refs: set[str] = set()
        for value in (
            candidate.get("editor"),
            candidate.get("layers"),
            candidate.get("sourceBindings"),
            ai_reference_records,
            ai_task_records,
            ai_pending_results,
            export_records,
        ):
            self._collect_asset_refs(value, discovered_asset_refs)
        normalized_asset_refs = sorted(
            {
                self._validate_asset_id(value)
                for value in [*asset_refs, *discovered_asset_refs]
            }
        )
        preview_asset_id = candidate.get("previewAssetId") or ""
        if preview_asset_id:
            preview_asset_id = self._validate_asset_id(preview_asset_id)
        committed_asset_refs = set(normalized_asset_refs)
        if preview_asset_id:
            committed_asset_refs.add(preview_asset_id)
        pending_asset_refs = [
            item
            for item in self._unexpired_pending_asset_refs(
                current.get("pendingAssetRefs", []),
                self._now(),
            )
            if item["assetId"] not in committed_asset_refs
        ]

        for asset_id in {*normalized_asset_refs, *([preview_asset_id] if preview_asset_id else [])}:
            self.asset_path(asset_id)

        candidate["schemaVersion"] = self.SCHEMA_VERSION
        candidate["projectId"] = project_id
        candidate["owner"] = owner
        candidate["document"] = self._normalize_document(
            candidate.get("document") or current.get("document")
        )
        candidate["assetRefs"] = normalized_asset_refs
        candidate["pendingAssetRefs"] = pending_asset_refs
        candidate["previewAssetId"] = preview_asset_id
        candidate["fontRefs"] = font_refs
        candidate["aiToolPreferences"] = ai_tool_preferences
        candidate["aiReferenceRecords"] = ai_reference_records
        candidate["aiTaskRecords"] = ai_task_records
        candidate["aiPendingResults"] = ai_pending_results
        candidate["exportRecords"] = export_records
        candidate["createdAt"] = current.get("createdAt")
        candidate.setdefault("editor", {"objects": []})
        candidate.setdefault("layers", [])
        candidate.setdefault("sourceBindings", [])
        candidate.setdefault("fontRefs", [])
        candidate.setdefault("aiToolPreferences", {})
        candidate.setdefault("aiReferenceRecords", [])
        candidate.setdefault("aiTaskRecords", [])
        candidate.setdefault("aiPendingResults", [])
        return candidate

    def _normalize_pending_asset_refs(self, value: Any) -> list[dict]:
        if not isinstance(value, list):
            raise OpenShopValidationError("pendingAssetRefs must be an array")
        normalized = {}
        for item in value:
            if not isinstance(item, dict):
                raise OpenShopValidationError("pendingAssetRefs entries must be objects")
            asset_id = self._validate_asset_id(item.get("assetId"))
            expires_at = item.get("expiresAt")
            if type(expires_at) is not int or expires_at < 0:
                raise OpenShopValidationError("pendingAssetRefs expiresAt is invalid")
            normalized.pop(asset_id, None)
            normalized[asset_id] = {
                "assetId": asset_id,
                "expiresAt": expires_at,
            }
        normalized_records = list(normalized.values())
        if len(normalized_records) > self.MAX_PENDING_ASSET_REFS:
            raise OpenShopValidationError("OpenShop pendingAssetRefs limit exceeded")
        return normalized_records

    def _unexpired_pending_asset_refs(self, value: Any, now: int) -> list[dict]:
        return [
            item for item in self._normalize_pending_asset_refs(value)
            if item["expiresAt"] > now
        ]

    def _normalize_export_records(self, value: Any) -> list[dict]:
        if not isinstance(value, list):
            raise OpenShopValidationError("exportRecords must be an array")
        if len(value) > 256:
            raise OpenShopValidationError("exportRecords exceeds the 256 item limit")
        normalized = []
        seen = set()
        for item in reversed(value):
            if not isinstance(item, dict):
                raise OpenShopValidationError("exportRecords entries must be objects")
            asset_id = self._validate_asset_id(item.get("assetId"))
            if asset_id in seen:
                continue
            seen.add(asset_id)
            name = self._safe_label(item.get("name"), "OpenShop output.png")
            width = self._positive_dimension(item.get("width"), "export width")
            height = self._positive_dimension(item.get("height"), "export height")
            try:
                created_at = int(item.get("createdAt") or 0)
            except (TypeError, ValueError) as exc:
                raise OpenShopValidationError("OpenShop export createdAt is invalid") from exc
            if created_at < 0:
                raise OpenShopValidationError("OpenShop export createdAt is invalid")
            normalized.append({
                "assetId": asset_id,
                "name": name,
                "width": width,
                "height": height,
                "createdAt": created_at,
            })
        normalized.reverse()
        return normalized

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
            if tool_id in OPENSHOP_GENERATIVE_TOOL_IDS:
                try:
                    count = int(item.get("count") or 1)
                except (TypeError, ValueError) as exc:
                    raise OpenShopValidationError("OpenShop generation count is invalid") from exc
                if count < 1 or count > 64:
                    raise OpenShopValidationError("OpenShop generation count is invalid")
                reference_mode = (
                    "full"
                    if tool_id == "generative-fill"
                    else "selection" if item.get("referenceMode") == "selection" else "full"
                )
                selection_tool = self._metadata_text(
                    item.get("lastSelectionTool") or "marquee-rect",
                    40,
                    "lastSelectionTool",
                )
                if selection_tool not in {
                    "marquee-rect",
                    "marquee-ellipse",
                    "lasso",
                    "magic-wand",
                    "wand",
                    "ai-segment",
                }:
                    raise OpenShopValidationError("OpenShop selection tool is invalid")
                normalized[tool_id].update({
                    "size": self._metadata_text(item.get("size") or "auto", 40, "size"),
                    "quality": self._metadata_text(
                        item.get("quality") or "auto", 40, "quality"
                    ),
                    "count": count,
                    "referenceMode": reference_mode,
                    "lastSelectionTool": selection_tool,
                })
        return normalized

    def _normalize_ai_reference_records(self, value: Any) -> list[dict]:
        if not isinstance(value, list):
            raise OpenShopValidationError("aiReferenceRecords must be an array")
        if len(value) > 64:
            raise OpenShopValidationError("aiReferenceRecords exceeds the 64 item limit")
        normalized = []
        aliases = set()
        for item in value:
            try:
                reference = normalize_reference_record(item)
            except (OpenShopAiValidationError, TypeError, ValueError) as exc:
                raise OpenShopValidationError(str(exc)) from exc
            if reference["alias"] in aliases:
                raise OpenShopValidationError("OpenShop reference aliases must be unique")
            aliases.add(reference["alias"])
            normalized.append(reference)
        normalized.sort(key=lambda item: item["order"])
        if [item["order"] for item in normalized] != list(range(len(normalized))):
            raise OpenShopValidationError("OpenShop reference order must be contiguous")
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

    def _normalize_ai_pending_results(self, value: Any) -> list[dict]:
        if not isinstance(value, list):
            raise OpenShopValidationError("aiPendingResults must be an array")
        if len(value) > 64:
            raise OpenShopValidationError("aiPendingResults exceeds the 64 item limit")
        normalized = []
        seen = set()
        for item in value:
            if not isinstance(item, dict):
                raise OpenShopValidationError("aiPendingResults entries must be objects")
            task_id = self._metadata_text(item.get("taskId"), 160, "pending taskId")
            child_task_id = self._metadata_text(
                item.get("childTaskId"), 160, "pending childTaskId"
            )
            source_layer_id = self._metadata_text(
                item.get("sourceLayerId"), 160, "pending sourceLayerId"
            )
            if not task_id or not child_task_id or not source_layer_id:
                raise OpenShopValidationError("OpenShop pending result is incomplete")
            key = (task_id, child_task_id)
            if key in seen:
                continue
            seen.add(key)
            normalized.append({
                "taskId": task_id,
                "childTaskId": child_task_id,
                "assetId": self._validate_asset_id(item.get("assetId")),
                "sourceLayerId": source_layer_id,
                "index": max(0, int(item.get("index") or 0)),
            })
        return normalized

    def _collect_asset_refs(self, value: Any, output: set[str]) -> None:
        asset_keys = {
            "assetId",
            "assetRef",
            "sourceAssetId",
            "maskAssetId",
            "outputAssetId",
            "primaryReferenceAssetId",
        }
        if isinstance(value, dict):
            for key, child in value.items():
                if key in asset_keys and child:
                    output.add(self._validate_asset_id(child))
                else:
                    self._collect_asset_refs(child, output)
        elif isinstance(value, list):
            for child in value:
                self._collect_asset_refs(child, output)

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

    def _project_directory(self, owner: dict) -> Path:
        normalized_owner = self._normalize_owner(owner)
        return (
            self.canvas_dir
            / f"{normalized_owner['canvasId']}.openshop"
            / normalized_owner["nodeId"]
        )

    def _project_path(self, owner: dict) -> Path:
        return self._project_directory(owner) / "project.json"

    def _legacy_project_path(self, project_id: str) -> Path:
        return self.legacy_projects_dir / f"{self._validate_id(project_id, 'projectId')}.json"

    def _validate_project_manifest(
        self,
        project: dict,
        project_id: str,
        owner: dict,
    ) -> dict:
        if (
            type(project.get("schemaVersion")) is not int
            or project.get("schemaVersion") != self.SCHEMA_VERSION
            or project.get("projectId") != project_id
        ):
            raise OpenShopValidationError(f"Invalid OpenShop project manifest: {project_id}")
        self._assert_owner(project, owner)
        project.setdefault("aiReferenceRecords", [])
        project.setdefault("aiPendingResults", [])
        project["pendingAssetRefs"] = self._normalize_pending_asset_refs(
            project.get("pendingAssetRefs", [])
        )
        return project

    def _migrate_legacy_project(self, project_id: str, owner: dict) -> Path:
        legacy_path = self._legacy_project_path(project_id)
        target_path = self._project_path(owner)
        if target_path.is_file() or not legacy_path.is_file():
            return target_path
        legacy = self._read_json(legacy_path, "legacy project")
        self._validate_project_manifest(legacy, project_id, owner)
        self._atomic_write_json(target_path, legacy)
        migrated = self._read_json(target_path, "project")
        self._validate_project_manifest(migrated, project_id, owner)
        legacy_path.unlink()
        return target_path

    def _read_project(self, project_id: str, owner: dict) -> dict:
        normalized_project_id = self._validate_id(project_id, "projectId")
        normalized_owner = self._normalize_owner(owner)
        path = self._migrate_legacy_project(normalized_project_id, normalized_owner)
        if not path.is_file():
            raise OpenShopNotFound(
                f"OpenShop project not found: {normalized_project_id}"
            )
        project = self._read_json(path, "project")
        return self._validate_project_manifest(
            project,
            normalized_project_id,
            normalized_owner,
        )

    def _iter_project_paths(self):
        yield from sorted(self.canvas_dir.glob("*.openshop/*/project.json"))
        yield from sorted(self.legacy_projects_dir.glob("*.json"))

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
                if str(child_key).strip().lower() == "seed":
                    raise OpenShopValidationError("OpenShop project cannot store seed fields")
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
