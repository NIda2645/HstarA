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


OPENSHOP_GENERATIVE_TOOL_IDS = ("generative-fill", "local-redraw")
OPENSHOP_AI_TOOL_IDS = ("text-extract", "text-remove", *OPENSHOP_GENERATIVE_TOOL_IDS)
OPENSHOP_AI_TASK_STATES = (
    "queued",
    "running",
    "partial",
    "succeeded",
    "failed",
    "cancelled",
)
OPENSHOP_AI_TERMINAL_STATES = {"partial", "succeeded", "failed", "cancelled"}
OPENSHOP_AI_CHILD_STATES = {"queued", "running", "succeeded", "failed", "cancelled"}
OPENSHOP_REFERENCE_SOURCE_TYPES = {"primary", "selection", "layer", "library", "local"}
OPENSHOP_DEFAULT_MAX_REFERENCES = 8
OPENSHOP_DEFAULT_MAX_OUTPUTS = 8
OPENSHOP_HARD_MAX_OUTPUTS = 64

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


def _bounded_integer(value: Any, fallback: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = fallback
    return max(minimum, min(maximum, number))


def _image_model_capabilities(provider: dict[str, Any], model: str) -> dict[str, Any]:
    configured = provider.get("image_model_capabilities")
    raw = configured.get(model, {}) if isinstance(configured, dict) else {}
    if not isinstance(raw, dict):
        raw = {}
    return {
        "supportsImageInput": raw.get("supportsImageInput", True) is not False,
        "supportsMask": raw.get("supportsMask", True) is not False,
        "supportsMultiReference": raw.get("supportsMultiReference", True) is not False,
        "maxReferenceImages": _bounded_integer(
            raw.get("maxReferenceImages"), OPENSHOP_DEFAULT_MAX_REFERENCES, 1, 64
        ),
        "maxOutputs": _bounded_integer(
            raw.get("maxOutputs"), OPENSHOP_DEFAULT_MAX_OUTPUTS, 1, OPENSHOP_HARD_MAX_OUTPUTS
        ),
        "supportsBatchOutput": bool(raw.get("supportsBatchOutput", False)),
        "sizes": _unique_texts(raw.get("sizes"), limit=40, max_items=32) or ["auto"],
        "qualities": _unique_texts(raw.get("qualities"), limit=40, max_items=16)
        or ["auto", "low", "medium", "high"],
    }


def _catalog_provider(
    provider: dict[str, Any],
    models: list[str],
    include_image_capabilities: bool = False,
) -> dict[str, Any]:
    catalog_models = []
    for value in models:
        model = {"id": value, "name": value, "available": True}
        if include_image_capabilities:
            model["capabilities"] = _image_model_capabilities(provider, value)
        catalog_models.append(model)
    return {
        "id": _clean_text(provider.get("id"), 96),
        "name": _clean_text(provider.get("name"), 120, _clean_text(provider.get("id"), 96)),
        "protocol": _clean_text(provider.get("protocol"), 40, "openai").lower(),
        "primary": bool(provider.get("primary")),
        "available": True,
        "models": catalog_models,
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
            remove_providers.append(
                _catalog_provider(raw, image_models, include_image_capabilities=True)
            )

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
            "generative-fill": {
                "id": "generative-fill",
                "label": "生成式填充",
                "capability": "masked-image-generation",
                "providers": deepcopy(remove_providers),
            },
            "local-redraw": {
                "id": "local-redraw",
                "label": "局部重绘",
                "capability": "multi-reference-masked-image-generation",
                "providers": deepcopy(remove_providers),
            },
        },
    }


def build_ocr_prompt(width: int, height: int) -> str:
    width = _positive_dimension(width, "width")
    height = _positive_dimension(height, "height")
    return (
        f"Read every visible Chinese, English, and mixed-language text block in this {width}x{height} image. "
        "Return JSON only with a top-level blocks array, in natural reading order. Return one block per "
        "visually distinct text line or independently styled text run; never merge unrelated labels, titles, "
        "or paragraphs. Every block must contain text, quad, language, confidence, font, color, align, "
        "rotation, paragraphId, and lineIndex. quad must contain four clockwise points around the tight visible "
        "glyph bounds, with normalized x and y values from 0 to 1. Preserve punctuation, whitespace, line "
        "order, and the original 中文/English spelling. font must contain ordered familyCandidates, font.size "
        "in source-image pixels, weight, and style. Return the dominant glyph fill as a #RRGGBB color and "
        "preserve alignment and rotation. Do not return markdown or image descriptions. If reliable text "
        "positions cannot be determined, return {\"blocks\":[]}."
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


def _task_safe_id(value: Any, label: str, required: bool = True) -> str:
    normalized = _clean_text(value, 160)
    if (required and not normalized) or (normalized and not _SAFE_ID_PATTERN.fullmatch(normalized)):
        raise OpenShopAiValidationError(f"Invalid OpenShop AI {label}")
    return normalized


def _positive_int(value: Any, label: str, maximum: int = 16384) -> int:
    if isinstance(value, bool):
        raise OpenShopAiValidationError(f"Invalid OpenShop AI {label}")
    try:
        number = int(value)
    except (TypeError, ValueError) as exc:
        raise OpenShopAiValidationError(f"Invalid OpenShop AI {label}") from exc
    if number < 1 or number > maximum:
        raise OpenShopAiValidationError(f"Invalid OpenShop AI {label}")
    return number


def _reject_seed_keys(value: Any) -> None:
    if isinstance(value, dict):
        for key, child in value.items():
            if str(key).strip().lower() == "seed":
                raise OpenShopAiValidationError("OpenShop generation does not support seed")
            _reject_seed_keys(child)
    elif isinstance(value, list):
        for child in value:
            _reject_seed_keys(child)


def normalize_reference_record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OpenShop reference must be an object")
    source_type = _clean_text(value.get("sourceType"), 32).lower()
    if source_type not in OPENSHOP_REFERENCE_SOURCE_TYPES:
        raise OpenShopAiValidationError("Invalid OpenShop reference sourceType")
    alias = _clean_text(value.get("alias"), 40)
    prefix = "选区" if source_type == "selection" else "参考图"
    if not re.fullmatch(rf"{prefix}[1-9][0-9]*", alias):
        raise OpenShopAiValidationError("Invalid OpenShop reference alias")
    return {
        "assetId": _task_asset_id(value.get("assetId"), "reference assetId"),
        "alias": alias,
        "mention": f"@{alias}",
        "sourceType": source_type,
        "order": max(0, int(value.get("order") or 0)),
        "width": max(0, int(value.get("width") or 0)),
        "height": max(0, int(value.get("height") or 0)),
    }


def normalize_generation_snapshot(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OpenShop generation snapshot must be an object")
    _reject_seed_keys(value)
    tool_id = _clean_text(value.get("toolId"), 40)
    if tool_id not in OPENSHOP_GENERATIVE_TOOL_IDS:
        raise OpenShopAiValidationError("Invalid OpenShop generative toolId")
    prompt = _clean_text(value.get("prompt"), 8000)
    if tool_id == "local-redraw" and not prompt:
        raise OpenShopAiValidationError("局部重绘需要填写修改要求")

    source_asset_id = _task_asset_id(value.get("sourceAssetId"), "sourceAssetId")
    mask_asset_id = _task_asset_id(value.get("maskAssetId"), "maskAssetId")
    primary_asset_id = _task_asset_id(
        value.get("primaryReferenceAssetId"), "primaryReferenceAssetId"
    )
    if not source_asset_id or not mask_asset_id or not primary_asset_id:
        raise OpenShopAiValidationError("OpenShop generation assets are incomplete")

    references_value = value.get("references")
    if not isinstance(references_value, list):
        raise OpenShopAiValidationError("OpenShop generation references must be an array")
    references = sorted(
        (normalize_reference_record(item) for item in references_value),
        key=lambda item: item["order"],
    )
    if len(references) > 64:
        raise OpenShopAiValidationError("OpenShop generation references exceed the 64 item limit")
    if len({item["alias"] for item in references}) != len(references):
        raise OpenShopAiValidationError("OpenShop reference aliases must be unique")
    if [item["order"] for item in references] != list(range(len(references))):
        raise OpenShopAiValidationError("OpenShop reference order must be contiguous")

    target_count = _bounded_integer(
        value.get("targetCount"), 1, 1, OPENSHOP_HARD_MAX_OUTPUTS
    )
    original_target_count = _bounded_integer(
        value.get("originalTargetCount"), target_count, target_count, OPENSHOP_HARD_MAX_OUTPUTS
    )
    requested_indexes = value.get("requestedIndexes")
    if not isinstance(requested_indexes, list):
        requested_indexes = list(range(target_count))
    try:
        requested_indexes = [int(index) for index in requested_indexes]
    except (TypeError, ValueError) as exc:
        raise OpenShopAiValidationError("Invalid OpenShop requested output indexes") from exc
    if (
        len(requested_indexes) != target_count
        or len(set(requested_indexes)) != target_count
        or any(index < 0 or index >= original_target_count for index in requested_indexes)
    ):
        raise OpenShopAiValidationError("Invalid OpenShop requested output indexes")

    document_value = value.get("document")
    selection_value = value.get("selection")
    if not isinstance(document_value, dict) or not isinstance(selection_value, dict):
        raise OpenShopAiValidationError("OpenShop generation geometry is incomplete")
    document = {
        "width": _positive_int(document_value.get("width"), "document width"),
        "height": _positive_int(document_value.get("height"), "document height"),
        "layerVersion": max(0, int(document_value.get("layerVersion") or 0)),
        "visibleCompositeVersion": max(
            0, int(document_value.get("visibleCompositeVersion") or 0)
        ),
    }
    selection = {
        "x": max(0, int(selection_value.get("x") or 0)),
        "y": max(0, int(selection_value.get("y") or 0)),
        "width": _positive_int(selection_value.get("width"), "selection width"),
        "height": _positive_int(selection_value.get("height"), "selection height"),
        "feather": max(0, int(selection_value.get("feather") or 0)),
    }
    if (
        selection["x"] + selection["width"] > document["width"]
        or selection["y"] + selection["height"] > document["height"]
    ):
        raise OpenShopAiValidationError("OpenShop selection is outside the document")

    reference_mode = (
        "full"
        if tool_id == "generative-fill"
        else "selection" if value.get("referenceMode") == "selection" else "full"
    )
    if tool_id == "generative-fill" and len(references) > 1:
        raise OpenShopAiValidationError("生成式填充不接受额外参考图")
    if tool_id == "local-redraw":
        if not references:
            raise OpenShopAiValidationError("局部重绘需要主参考图")
        if references[0]["assetId"] != primary_asset_id:
            raise OpenShopAiValidationError("局部重绘主参考图与引用顺序不一致")

    return {
        "toolId": tool_id,
        "sourceAssetId": source_asset_id,
        "maskAssetId": mask_asset_id,
        "primaryReferenceAssetId": primary_asset_id,
        "references": references,
        "prompt": prompt,
        "size": _clean_text(value.get("size"), 40, "auto"),
        "quality": _clean_text(value.get("quality"), 40, "auto"),
        "targetCount": target_count,
        "originalTargetCount": original_target_count,
        "requestedIndexes": requested_indexes,
        "referenceMode": reference_mode,
        "sourceLayerId": _task_safe_id(value.get("sourceLayerId"), "sourceLayerId"),
        "sourceLayerIndex": max(0, int(value.get("sourceLayerIndex") or 0)),
        "document": document,
        "selection": selection,
    }


def _normalize_child_record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OpenShop AI child task must be an object")
    status = _clean_text(value.get("status"), 20).lower()
    if status not in OPENSHOP_AI_CHILD_STATES:
        raise OpenShopAiValidationError("Invalid OpenShop AI child task status")
    result = value.get("result") if isinstance(value.get("result"), dict) else None
    output_asset_id = _task_asset_id(
        value.get("outputAssetId") or (result or {}).get("assetId"),
        "child outputAssetId",
    )
    child = {
        "childTaskId": _task_safe_id(value.get("childTaskId"), "childTaskId"),
        "index": max(0, int(value.get("index") or 0)),
        "status": status,
        "outputAssetId": output_asset_id,
        "error": _clean_text(value.get("error"), 500),
        "createdAt": max(0, int(value.get("createdAt") or 0)),
        "updatedAt": max(0, int(value.get("updatedAt") or 0)),
        "completedAt": max(0, int(value.get("completedAt") or 0)),
    }
    if result:
        child["result"] = deepcopy(result)
    return child


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
    kind = "parent" if value.get("kind") == "parent" else "single"
    if kind == "parent":
        if tool_id not in OPENSHOP_GENERATIVE_TOOL_IDS:
            raise OpenShopAiValidationError("OpenShop parent task must use a generative tool")
        snapshot = normalize_generation_snapshot(value.get("snapshot"))
        children_value = value.get("children")
        if not isinstance(children_value, list) or len(children_value) > OPENSHOP_HARD_MAX_OUTPUTS:
            raise OpenShopAiValidationError("OpenShop parent task children are invalid")
        children = [_normalize_child_record(item) for item in children_value]
        if len({item["childTaskId"] for item in children}) != len(children):
            raise OpenShopAiValidationError("OpenShop child task IDs must be unique")
        completed_count = sum(item["status"] == "succeeded" for item in children)
        failed_count = sum(item["status"] == "failed" for item in children)
        return {
            "taskId": task_id,
            "kind": "parent",
            "toolId": tool_id,
            "apiConfigId": _clean_text(value.get("apiConfigId"), 96),
            "modelId": _clean_text(value.get("modelId"), 240),
            "status": status,
            "targetCount": snapshot["targetCount"],
            "originalTargetCount": snapshot["originalTargetCount"],
            "completedCount": completed_count,
            "failedCount": failed_count,
            "retryOfTaskId": _task_safe_id(
                value.get("retryOfTaskId"), "retryOfTaskId", required=False
            ),
            "snapshot": snapshot,
            "children": children,
            "createdAt": max(0, int(value.get("createdAt") or 0)),
            "updatedAt": max(0, int(value.get("updatedAt") or 0)),
            "completedAt": max(0, int(value.get("completedAt") or 0)),
            "error": _clean_text(value.get("error"), 500),
        }
    if status == "partial":
        raise OpenShopAiValidationError("OpenShop single task cannot be partial")
    record: dict[str, Any] = {
        "taskId": task_id,
        "kind": "single",
        "toolId": tool_id,
        "apiConfigId": _clean_text(value.get("apiConfigId"), 96),
        "modelId": _clean_text(value.get("modelId"), 240),
        "status": status,
        "mode": "selection" if str(value.get("mode") or "").lower() == "selection" else "layer",
        "sourceLayerId": _clean_text(value.get("sourceLayerId"), 160),
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

    @staticmethod
    def _summarize_parent(record: dict[str, Any]) -> None:
        children = record.get("children", [])
        completed = sum(child["status"] == "succeeded" for child in children)
        failed = sum(child["status"] == "failed" for child in children)
        cancelled = sum(child["status"] == "cancelled" for child in children)
        record["completedCount"] = completed
        record["failedCount"] = failed
        if record.get("status") == "cancelled":
            return
        terminal_count = completed + failed + cancelled
        if len(children) < record["targetCount"] or terminal_count < record["targetCount"]:
            record["status"] = (
                "running"
                if terminal_count or any(child["status"] == "running" for child in children)
                else "queued"
            )
            record["completedAt"] = 0
        elif completed == record["targetCount"]:
            record["status"] = "succeeded"
        elif completed:
            record["status"] = "partial"
        else:
            record["status"] = "failed"
        if record["status"] in OPENSHOP_AI_TERMINAL_STATES:
            record["completedAt"] = int(time.time() * 1000)

    @staticmethod
    def _child(record: dict[str, Any], child_task_id: str) -> dict[str, Any] | None:
        normalized = str(child_task_id or "").strip()
        return next(
            (child for child in record.get("children", []) if child["childTaskId"] == normalized),
            None,
        )

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

    def create_parent(
        self,
        project_id: str,
        owner: dict[str, Any],
        snapshot: dict[str, Any],
        provider_id: str,
        model_id: str,
        retry_of_task_id: str = "",
    ) -> dict[str, Any]:
        self.cleanup()
        normalized_project_id = _clean_text(project_id, 96)
        if not normalized_project_id:
            raise OpenShopAiValidationError("OpenShop AI projectId is invalid")
        normalized_snapshot = normalize_generation_snapshot(snapshot)
        timestamp = int(time.time() * 1000)
        task_id = f"openshop_ai_{uuid.uuid4().hex}"
        record = {
            "taskId": task_id,
            "kind": "parent",
            "projectId": normalized_project_id,
            "owner": self._owner(owner),
            "toolId": normalized_snapshot["toolId"],
            "apiConfigId": _clean_text(provider_id, 96),
            "modelId": _clean_text(model_id, 240),
            "status": "queued",
            "targetCount": normalized_snapshot["targetCount"],
            "originalTargetCount": normalized_snapshot["originalTargetCount"],
            "completedCount": 0,
            "failedCount": 0,
            "retryOfTaskId": _task_safe_id(
                retry_of_task_id, "retryOfTaskId", required=False
            ),
            "snapshot": normalized_snapshot,
            "children": [],
            "error": "",
            "createdAt": timestamp,
            "updatedAt": timestamp,
            "completedAt": 0,
        }
        with self._lock:
            self._records[task_id] = record
        return self._public(record)

    def create_child(self, task_id: str, index: int) -> dict[str, Any]:
        with self._lock:
            record = self._records.get(task_id)
            if not record:
                raise OpenShopAiTaskNotFound(task_id)
            if record.get("kind") != "parent" or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                raise OpenShopAiValidationError("OpenShop parent task cannot accept children")
            normalized_index = int(index)
            if normalized_index not in record["snapshot"]["requestedIndexes"]:
                raise OpenShopAiValidationError("OpenShop child output index was not requested")
            if any(child["index"] == normalized_index for child in record["children"]):
                raise OpenShopAiValidationError("OpenShop child output index already exists")
            timestamp = int(time.time() * 1000)
            child = {
                "childTaskId": f"openshop_ai_child_{uuid.uuid4().hex}",
                "index": normalized_index,
                "status": "queued",
                "outputAssetId": "",
                "result": None,
                "error": "",
                "createdAt": timestamp,
                "updatedAt": timestamp,
                "completedAt": 0,
            }
            record["children"].append(child)
            record["children"].sort(key=lambda item: item["index"])
            record["updatedAt"] = timestamp
            self._summarize_parent(record)
            return self._public(child)

    def bind_child(self, task_id: str, child_task_id: str, future: Any) -> None:
        with self._lock:
            record = self._records.get(task_id)
            if not record:
                raise OpenShopAiTaskNotFound(task_id)
            child = self._child(record, child_task_id)
            if not child:
                raise OpenShopAiTaskNotFound(child_task_id)
            if record["status"] == "cancelled" or child["status"] == "cancelled":
                future.cancel()
                return
            if child["status"] in {"succeeded", "failed"}:
                return
            self._futures[child_task_id] = future

    def mark_child_running(self, task_id: str, child_task_id: str) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            if not record or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                return False
            child = self._child(record, child_task_id)
            if not child or child["status"] != "queued":
                return False
            timestamp = int(time.time() * 1000)
            child["status"] = "running"
            child["updatedAt"] = timestamp
            record["updatedAt"] = timestamp
            self._summarize_parent(record)
            return True

    def can_complete_child(self, task_id: str, child_task_id: str) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            if not record or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                return False
            child = self._child(record, child_task_id)
            return bool(child and child["status"] in {"queued", "running"})

    def succeed_child(
        self,
        task_id: str,
        child_task_id: str,
        result: dict[str, Any],
    ) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            if not record or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                return False
            child = self._child(record, child_task_id)
            if not child or child["status"] in {"succeeded", "failed", "cancelled"}:
                return False
            timestamp = int(time.time() * 1000)
            child["status"] = "succeeded"
            child["result"] = deepcopy(result)
            child["outputAssetId"] = _task_asset_id(
                result.get("assetId") if isinstance(result, dict) else "",
                "child outputAssetId",
            )
            child["error"] = ""
            child["updatedAt"] = timestamp
            child["completedAt"] = timestamp
            record["updatedAt"] = timestamp
            self._futures.pop(child_task_id, None)
            self._summarize_parent(record)
            return True

    def fail_child(self, task_id: str, child_task_id: str, error: Any) -> bool:
        with self._lock:
            record = self._records.get(task_id)
            if not record or record["status"] in OPENSHOP_AI_TERMINAL_STATES:
                return False
            child = self._child(record, child_task_id)
            if not child or child["status"] in {"succeeded", "failed", "cancelled"}:
                return False
            timestamp = int(time.time() * 1000)
            child["status"] = "failed"
            child["result"] = None
            child["outputAssetId"] = ""
            child["error"] = _clean_text(error, 500, "OpenShop AI child task failed")
            child["updatedAt"] = timestamp
            child["completedAt"] = timestamp
            record["updatedAt"] = timestamp
            self._futures.pop(child_task_id, None)
            self._summarize_parent(record)
            return True

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

    @staticmethod
    def _cancel_future_if_pending(future: Any) -> None:
        if not future.done():
            future.cancel()

    @classmethod
    def _cancel_future(cls, future: Any) -> None:
        if future.done():
            return
        get_loop = getattr(future, "get_loop", None)
        if callable(get_loop):
            try:
                loop = get_loop()
                loop.call_soon_threadsafe(cls._cancel_future_if_pending, future)
                return
            except (AttributeError, RuntimeError):
                pass
        future.cancel()

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
        futures: list[Any] = []
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
                for child in record.get("children", []):
                    if child["status"] not in {"succeeded", "failed", "cancelled"}:
                        child["status"] = "cancelled"
                        child["result"] = None
                        child["outputAssetId"] = ""
                        child["error"] = ""
                        child["updatedAt"] = timestamp
                        child["completedAt"] = timestamp
            future = self._futures.pop(task_id, None)
            if future:
                futures.append(future)
            for child in record.get("children", []):
                future = self._futures.pop(child["childTaskId"], None)
                if future:
                    futures.append(future)
            public = self._public(record)
        for future in futures:
            self._cancel_future(future)
        return public

    def cancel_project(
        self,
        project_id: str,
        owner: dict[str, Any],
    ) -> list[str]:
        normalized = _clean_text(project_id, 96)
        if not normalized:
            raise OpenShopAiValidationError("OpenShop AI projectId is invalid")
        normalized_owner = self._owner(owner)
        with self._lock:
            task_ids = [
                task_id
                for task_id, record in self._records.items()
                if record.get("projectId") == normalized
                and record.get("owner") == normalized_owner
                and record.get("status") not in OPENSHOP_AI_TERMINAL_STATES
            ]
        for task_id in task_ids:
            self.cancel(task_id, normalized, normalized_owner)
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
                record = self._records.pop(task_id, None)
                self._futures.pop(task_id, None)
                for child in (record or {}).get("children", []):
                    self._futures.pop(child["childTaskId"], None)
        return expired
