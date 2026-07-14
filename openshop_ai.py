from __future__ import annotations

import json
import math
import re
import threading
import time
import uuid
from copy import deepcopy
from typing import Any


class OpenShopAiValidationError(ValueError):
    pass


OPENSHOP_AI_TOOL_IDS = ("text-extract", "text-remove")
OPENSHOP_AI_TASK_STATES = (
    "queued",
    "running",
    "succeeded",
    "failed",
    "cancelled",
)
OPENSHOP_AI_TERMINAL_STATES = {"succeeded", "failed", "cancelled"}

_CLI_PROTOCOLS = {"codex", "gemini-cli"}
_ASSET_ID_PATTERN = re.compile(r"^[a-f0-9]{64}$")
_SAFE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,160}$")
_HEX_COLOR_PATTERN = re.compile(r"^#[0-9a-fA-F]{3,8}$")
_NON_VISUAL_MODEL_MARKERS = (
    "embedding",
    "rerank",
    "whisper",
    "speech",
    "audio",
    "tts",
)
_VISUAL_MODEL_MARKERS = (
    "gemini",
    "gpt-4o",
    "gpt-4.1",
    "gpt-5",
    "claude-3",
    "claude-4",
    "vision",
    "qwen-vl",
    "qwen2-vl",
    "qwen2.5-vl",
    "qwen3-vl",
    "internvl",
    "minicpm-v",
    "glm-4v",
    "doubao-vision",
    "qvq",
    "vl-",
    "-vl-",
)


def _clean_text(value: Any, limit: int, fallback: str = "") -> str:
    text = re.sub(r"[\x00-\x1f\x7f]", "", str(value or "")).strip()
    return text[:limit] or fallback


def _unique_texts(values: Any, limit: int = 120, max_items: int = 64) -> list[str]:
    if not isinstance(values, list):
        return []
    result: list[str] = []
    seen: set[str] = set()
    for raw in values:
        value = _clean_text(raw, limit)
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
        if len(result) >= max_items:
            break
    return result


def _provider_is_available(provider: dict[str, Any]) -> bool:
    if provider.get("enabled", True) is False:
        return False
    protocol = str(provider.get("protocol") or "openai").strip().lower()
    return protocol in _CLI_PROTOCOLS or bool(
        provider.get("has_key")
        or provider.get("has_wallet_key")
        or provider.get("has_volcengine_access_key")
    )


def _looks_like_visual_chat_model(model: str) -> bool:
    value = model.strip().lower()
    if not value or any(marker in value for marker in _NON_VISUAL_MODEL_MARKERS):
        return False
    return any(marker in value for marker in _VISUAL_MODEL_MARKERS)


def _catalog_provider(provider: dict[str, Any], models: list[str]) -> dict[str, Any]:
    return {
        "id": _clean_text(provider.get("id"), 96),
        "name": _clean_text(provider.get("name"), 120, _clean_text(provider.get("id"), 96)),
        "protocol": _clean_text(provider.get("protocol"), 40, "openai").lower(),
        "primary": bool(provider.get("primary")),
        "available": True,
        "models": [{"id": value, "name": value, "available": True} for value in models],
    }


def build_capability_catalog(
    providers: Any,
    primary_provider_id: str = "",
) -> dict[str, Any]:
    extract_providers: list[dict[str, Any]] = []
    remove_providers: list[dict[str, Any]] = []
    for raw in providers if isinstance(providers, list) else []:
        if not isinstance(raw, dict) or not _provider_is_available(raw):
            continue
        provider_id = _clean_text(raw.get("id"), 96)
        if not provider_id:
            continue
        chat_models = [
            model
            for model in _unique_texts(raw.get("chat_models"), max_items=256)
            if _looks_like_visual_chat_model(model)
        ]
        image_models = _unique_texts(raw.get("image_models"), max_items=256)
        if chat_models:
            extract_providers.append(_catalog_provider(raw, chat_models))
        if image_models:
            remove_providers.append(_catalog_provider(raw, image_models))

    requested_primary = _clean_text(primary_provider_id, 96)
    all_provider_ids = {
        item["id"] for item in [*extract_providers, *remove_providers]
    }
    selected_primary = requested_primary if requested_primary in all_provider_ids else ""
    if not selected_primary:
        selected_primary = next(
            (
                item["id"]
                for item in [*extract_providers, *remove_providers]
                if item.get("primary")
            ),
            "",
        )
    if not selected_primary:
        selected_primary = next(iter(all_provider_ids), "")

    return {
        "schemaVersion": 1,
        "primaryProviderId": selected_primary,
        "tools": {
            "text-extract": {
                "id": "text-extract",
                "label": "文字提取",
                "capability": "structured-ocr-layout",
                "providers": extract_providers,
            },
            "text-remove": {
                "id": "text-remove",
                "label": "去除文字",
                "capability": "image-edit",
                "providers": remove_providers,
            },
        },
    }


def build_ocr_prompt(width: int, height: int) -> str:
    width = _positive_dimension(width, "width")
    height = _positive_dimension(height, "height")
    return (
        f"Read every visible Chinese, English, and mixed-language text block in this {width}x{height} image. "
        "Return JSON only with a top-level blocks array. Every block must contain text, quad, language, "
        "confidence, font, color, align, rotation, paragraphId, and lineIndex. quad must contain four "
        "clockwise points with normalized x and y values from 0 to 1. Preserve punctuation, whitespace, "
        "line order, and the original 中文/English spelling. font must contain familyCandidates, size, "
        "weight, and style. Do not return markdown or image descriptions. If reliable text positions "
        "cannot be determined, return {\"blocks\":[]}."
    )


def _positive_dimension(value: Any, label: str) -> int:
    if isinstance(value, bool):
        raise OpenShopAiValidationError(f"Invalid OCR {label}")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise OpenShopAiValidationError(f"Invalid OCR {label}") from exc
    if number < 1 or number > 16384:
        raise OpenShopAiValidationError(f"Invalid OCR {label}")
    return number


def _json_from_text(raw_text: Any) -> dict[str, Any]:
    text = str(raw_text or "").strip()
    text = re.sub(r"^```(?:json)?\s*|\s*```$", "", text, flags=re.I | re.S).strip()
    if not text:
        raise OpenShopAiValidationError("OCR response is empty")
    try:
        value = json.loads(text)
    except json.JSONDecodeError:
        start = text.find("{")
        end = text.rfind("}")
        if start < 0 or end <= start:
            raise OpenShopAiValidationError("OCR response does not contain structured JSON")
        try:
            value = json.loads(text[start : end + 1])
        except json.JSONDecodeError as exc:
            raise OpenShopAiValidationError("OCR response is not valid JSON") from exc
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OCR response must be an object")
    return value


def _finite_number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise OpenShopAiValidationError(f"Invalid OCR {label}")
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise OpenShopAiValidationError(f"Invalid OCR {label}") from exc
    if not math.isfinite(number):
        raise OpenShopAiValidationError(f"Invalid OCR {label}")
    return number


def _normalize_points(points: Any, width: int, height: int) -> list[dict[str, float]]:
    if not isinstance(points, list) or len(points) != 4:
        raise OpenShopAiValidationError("OCR block must contain four quad points")
    raw: list[tuple[float, float]] = []
    for point in points:
        if isinstance(point, dict):
            x = _finite_number(point.get("x"), "quad x")
            y = _finite_number(point.get("y"), "quad y")
        elif isinstance(point, (list, tuple)) and len(point) >= 2:
            x = _finite_number(point[0], "quad x")
            y = _finite_number(point[1], "quad y")
        else:
            raise OpenShopAiValidationError("OCR quad point is invalid")
        raw.append((x, y))
    normalized = all(x <= 1 and y <= 1 for x, y in raw)
    result = [
        {"x": x if normalized else x / width, "y": y if normalized else y / height}
        for x, y in raw
    ]
    if any(point[axis] < 0 or point[axis] > 1 for point in result for axis in ("x", "y")):
        raise OpenShopAiValidationError("OCR quad is outside the image")
    xs = [point["x"] for point in result]
    ys = [point["y"] for point in result]
    if max(xs) - min(xs) <= 0 or max(ys) - min(ys) <= 0:
        raise OpenShopAiValidationError("OCR quad has no area")
    return [{"x": round(point["x"], 6), "y": round(point["y"], 6)} for point in result]


def _quad_from_bbox(bbox: Any, width: int, height: int) -> list[dict[str, float]]:
    if not isinstance(bbox, dict):
        raise OpenShopAiValidationError("OCR block has no reliable position")
    x = _finite_number(bbox.get("x", bbox.get("left")), "bbox x")
    y = _finite_number(bbox.get("y", bbox.get("top")), "bbox y")
    w = _finite_number(bbox.get("width", bbox.get("w")), "bbox width")
    h = _finite_number(bbox.get("height", bbox.get("h")), "bbox height")
    if w <= 0 or h <= 0:
        raise OpenShopAiValidationError("OCR bbox has no area")
    return _normalize_points(
        [
            {"x": x, "y": y},
            {"x": x + w, "y": y},
            {"x": x + w, "y": y + h},
            {"x": x, "y": y + h},
        ],
        width,
        height,
    )


def _normalize_font(value: Any) -> dict[str, Any]:
    font = value if isinstance(value, dict) else {}
    candidates = _unique_texts(
        font.get("familyCandidates") or font.get("families") or [],
        max_items=8,
    )
    size = _finite_number(font.get("size", 0), "font size")
    weight = int(round(_finite_number(font.get("weight", 400), "font weight") / 100) * 100)
    return {
        "familyCandidates": candidates,
        "size": max(0.0, min(2000.0, round(size, 2))),
        "weight": max(100, min(900, weight)),
        "style": "italic" if str(font.get("style") or "").lower() == "italic" else "normal",
    }


def _normalize_block(value: Any, index: int, width: int, height: int) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OCR block must be an object")
    text = _clean_text(value.get("text"), 4000)
    if not text:
        raise OpenShopAiValidationError("OCR block text is empty")
    quad = _normalize_points(value.get("quad"), width, height) if value.get("quad") is not None else _quad_from_bbox(value.get("bbox"), width, height)
    confidence = max(0.0, min(1.0, _finite_number(value.get("confidence", 0), "confidence")))
    language = str(value.get("language") or "unknown").strip().lower()
    if language not in {"zh", "en", "mixed", "unknown"}:
        language = "unknown"
    align = str(value.get("align") or "left").strip().lower()
    if align not in {"left", "center", "right", "justify"}:
        align = "left"
    color = str(value.get("color") or "#ffffff").strip()
    if not _HEX_COLOR_PATTERN.fullmatch(color):
        color = "#ffffff"
    rotation = _finite_number(value.get("rotation", 0), "rotation")
    line_index = value.get("lineIndex", index)
    try:
        line_index = max(0, int(line_index))
    except (TypeError, ValueError):
        line_index = index
    return {
        "id": _clean_text(value.get("id"), 96, f"ocr-{index + 1}"),
        "text": text,
        "quad": quad,
        "language": language,
        "confidence": round(confidence, 4),
        "lowConfidence": confidence < 0.7,
        "font": _normalize_font(value.get("font")),
        "color": color.lower(),
        "align": align,
        "rotation": max(-360.0, min(360.0, round(rotation, 3))),
        "paragraphId": _clean_text(value.get("paragraphId"), 96, f"paragraph-{index + 1}"),
        "lineIndex": line_index,
    }


def normalize_ocr_layout(raw_text: Any, width: int, height: int) -> dict[str, Any]:
    width = _positive_dimension(width, "width")
    height = _positive_dimension(height, "height")
    payload = _json_from_text(raw_text)
    values = payload.get("blocks")
    if not isinstance(values, list) or not values:
        raise OpenShopAiValidationError("OCR model did not return reliable text positions")
    blocks = [_normalize_block(value, index, width, height) for index, value in enumerate(values[:500])]
    return {
        "schemaVersion": 1,
        "width": width,
        "height": height,
        "blocks": blocks,
    }


def _task_asset_id(value: Any, label: str) -> str:
    normalized = str(value or "").strip().lower()
    if normalized and not _ASSET_ID_PATTERN.fullmatch(normalized):
        raise OpenShopAiValidationError(f"Invalid OpenShop AI {label}")
    return normalized


def normalize_ai_task_record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OpenShop AI task record must be an object")
    task_id = _clean_text(value.get("taskId"), 160)
    if not _SAFE_ID_PATTERN.fullmatch(task_id):
        raise OpenShopAiValidationError("Invalid OpenShop AI taskId")
    tool_id = str(value.get("toolId") or "").strip()
    if tool_id not in OPENSHOP_AI_TOOL_IDS:
        raise OpenShopAiValidationError("Invalid OpenShop AI toolId")
    status = str(value.get("status") or "").strip().lower()
    if status not in OPENSHOP_AI_TASK_STATES:
        raise OpenShopAiValidationError("Invalid OpenShop AI task status")
    record: dict[str, Any] = {
        "taskId": task_id,
        "toolId": tool_id,
        "apiConfigId": _clean_text(value.get("apiConfigId"), 96),
        "modelId": _clean_text(value.get("modelId"), 240),
        "status": status,
        "mode": "selection" if str(value.get("mode") or "").lower() == "selection" else "layer",
        "sourceAssetId": _task_asset_id(value.get("sourceAssetId"), "sourceAssetId"),
        "maskAssetId": _task_asset_id(value.get("maskAssetId"), "maskAssetId"),
        "outputAssetId": _task_asset_id(value.get("outputAssetId"), "outputAssetId"),
        "createdAt": max(0, int(value.get("createdAt") or 0)),
        "updatedAt": max(0, int(value.get("updatedAt") or 0)),
        "completedAt": max(0, int(value.get("completedAt") or 0)),
        "appliedAt": max(0, int(value.get("appliedAt") or 0)),
        "error": _clean_text(value.get("error"), 500),
    }
    result = value.get("result")
    if isinstance(result, dict) and isinstance(result.get("blocks"), list):
        width = _positive_dimension(result.get("width"), "result width")
        height = _positive_dimension(result.get("height"), "result height")
        record["result"] = normalize_ocr_layout(json.dumps(result), width, height)
    return record


class OpenShopAiTaskNotFound(KeyError):
    pass


class OpenShopAiTaskOwnershipError(PermissionError):
    pass


class OpenShopAiTaskRegistry:
    def __init__(self, retention_seconds: float = 3600.0):
        self.retention_seconds = max(60.0, float(retention_seconds))
        self._records: dict[str, dict[str, Any]] = {}
        self._futures: dict[str, Any] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _owner(value: Any) -> dict[str, str]:
        if not isinstance(value, dict):
            raise OpenShopAiValidationError("OpenShop AI task owner is invalid")
        owner = {
            "canvasType": _clean_text(value.get("canvasType"), 32),
            "canvasId": _clean_text(value.get("canvasId"), 96),
            "nodeId": _clean_text(value.get("nodeId"), 96),
        }
        if not all(owner.values()):
            raise OpenShopAiValidationError("OpenShop AI task owner is incomplete")
        return owner

    @staticmethod
    def _public(record: dict[str, Any]) -> dict[str, Any]:
        return deepcopy(record)

    def create(
        self,
        project_id: str,
        owner: dict[str, Any],
        tool_id: str,
        provider_id: str,
        model_id: str,
        source_asset_id: str,
        mask_asset_id: str = "",
        mode: str = "layer",
    ) -> dict[str, Any]:
        self.cleanup()
        normalized_project_id = _clean_text(project_id, 96)
        if not normalized_project_id:
            raise OpenShopAiValidationError("OpenShop AI projectId is invalid")
        normalized_owner = self._owner(owner)
        if tool_id not in OPENSHOP_AI_TOOL_IDS:
            raise OpenShopAiValidationError("OpenShop AI toolId is invalid")
        timestamp = int(time.time() * 1000)
        task_id = f"openshop_ai_{uuid.uuid4().hex}"
        record = {
            "taskId": task_id,
            "projectId": normalized_project_id,
            "owner": normalized_owner,
            "toolId": tool_id,
            "apiConfigId": _clean_text(provider_id, 96),
            "modelId": _clean_text(model_id, 240),
            "status": "queued",
            "mode": "selection" if mode == "selection" else "layer",
            "sourceAssetId": _task_asset_id(source_asset_id, "sourceAssetId"),
            "maskAssetId": _task_asset_id(mask_asset_id, "maskAssetId"),
            "outputAssetId": "",
            "result": None,
            "error": "",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "completedAt": 0,
        }
        with self._lock:
            self._records[task_id] = record
        return self._public(record)

    def bind(self, task_id: str, future: Any) -> None:
        with self._lock:
            record = self._records.get(task_id)
            if not record:
                raise OpenShopAiTaskNotFound(task_id)
            if record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                if record["status"] == "cancelled":
                    future.cancel()
                return
            self._futures[task_id] = future

    def _assert_scope(
        self,
        record: dict[str, Any],
        project_id: str,
        owner: dict[str, Any],
    ) -> None:
        if record.get("projectId") != str(project_id or "").strip():
            raise OpenShopAiTaskNotFound(record.get("taskId") or "")
        if record.get("owner") != self._owner(owner):
            raise OpenShopAiTaskOwnershipError(record.get("taskId") or "")

    def get(
        self,
        task_id: str,
        project_id: str,
        owner: dict[str, Any],
    ) -> dict[str, Any]:
        self.cleanup()
        with self._lock:
            record = self._records.get(task_id)
            if not record:
                raise OpenShopAiTaskNotFound(task_id)
            self._assert_scope(record, project_id, owner)
            return self._public(record)

    def mark_running(self, task_id: str) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            if not record or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                return False
            record["status"] = "running"
            record["updatedAt"] = int(time.time() * 1000)
            return True

    def can_complete(self, task_id: str) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            return bool(record and record["status"] not in OPENSHOP_AI_TERMINAL_STATES)

    def succeed(self, task_id: str, result: dict[str, Any]) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            if not record or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                return False
            timestamp = int(time.time() * 1000)
            record["status"] = "succeeded"
            record["result"] = deepcopy(result)
            record["outputAssetId"] = _task_asset_id(
                result.get("assetId") if isinstance(result, dict) else "",
                "outputAssetId",
            )
            record["error"] = ""
            record["updatedAt"] = timestamp
            record["completedAt"] = timestamp
            self._futures.pop(task_id, None)
            return True

    def fail(self, task_id: str, error: Any) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            if not record or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                return False
            timestamp = int(time.time() * 1000)
            record["status"] = "failed"
            record["result"] = None
            record["error"] = _clean_text(error, 500, "OpenShop AI task failed")
            record["updatedAt"] = timestamp
            record["completedAt"] = timestamp
            self._futures.pop(task_id, None)
            return True

    def cancel(
        self,
        task_id: str,
        project_id: str | None = None,
        owner: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        future = None
        with self._lock:
            record = self._records.get(task_id)
            if not record:
                raise OpenShopAiTaskNotFound(task_id)
            if project_id is not None and owner is not None:
                self._assert_scope(record, project_id, owner)
            if record["status"] not in OPENSHOP_AI_TERMINAL_STATES:
                timestamp = int(time.time() * 1000)
                record["status"] = "cancelled"
                record["result"] = None
                record["error"] = ""
                record["updatedAt"] = timestamp
                record["completedAt"] = timestamp
            future = self._futures.pop(task_id, None)
            public = self._public(record)
        if future and not future.done():
            future.cancel()
        return public

    def cancel_project(self, project_id: str) -> list[str]:
        normalized = str(project_id or "").strip()
        with self._lock:
            task_ids = [
                task_id
                for task_id, record in self._records.items()
                if record.get("projectId") == normalized
                and record.get("status") not in OPENSHOP_AI_TERMINAL_STATES
            ]
        for task_id in task_ids:
            self.cancel(task_id)
        return task_ids

    def active_for_project(self, project_id: str) -> int:
        normalized = str(project_id or "").strip()
        with self._lock:
            return sum(
                1
                for record in self._records.values()
                if record.get("projectId") == normalized
                and record.get("status") not in OPENSHOP_AI_TERMINAL_STATES
            )

    def cleanup(self) -> list[str]:
        cutoff = int((time.time() - self.retention_seconds) * 1000)
        with self._lock:
            expired = [
                task_id
                for task_id, record in self._records.items()
                if record.get("status") in OPENSHOP_AI_TERMINAL_STATES
                and int(record.get("updatedAt") or 0) < cutoff
            ]
            for task_id in expired:
                self._records.pop(task_id, None)
                self._futures.pop(task_id, None)
        return expired
