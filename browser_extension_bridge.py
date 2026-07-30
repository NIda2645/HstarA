from __future__ import annotations

import base64
import binascii
import ipaddress
import json
import os
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable, Sequence
from urllib.parse import urlsplit

from fastapi import APIRouter
from fastapi.responses import JSONResponse
from starlette.requests import Request


EXTENSION_ID = "ajfhnbklbmpfaaookhfakohabnpmlcic"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
BRIDGE_ROUTES = frozenset(
    {
        ("GET", "/api/providers"),
        ("POST", "/api/local-assets/import-urls"),
    }
)
BRIDGE_PATHS = frozenset(path for _, path in BRIDGE_ROUTES)

ERROR_STATUS = {
    "extension_forbidden": 403,
    "extension_route_forbidden": 403,
    "invalid_import_request": 400,
    "import_limit_exceeded": 413,
    "storage_switch_in_progress": 409,
    "bridge_busy": 429,
    "storage_unavailable": 503,
}

ITEM_ERROR_CODES = frozenset(
    {
        "unsafe_url",
        "dns_failed",
        "remote_timeout",
        "remote_http_error",
        "unsupported_media",
        "item_too_large",
        "invalid_base64",
        "insufficient_storage",
        "commit_failed",
    }
)


class BridgeRequestError(Exception):
    def __init__(self, code: str, public_message: str, status_code: int | None = None):
        if code not in ERROR_STATUS:
            raise ValueError(f"unknown bridge request error: {code}")
        super().__init__(public_message)
        self.code = code
        self.public_message = public_message
        self.status_code = status_code or ERROR_STATUS[code]


class BridgeItemError(Exception):
    def __init__(self, code: str, public_message: str):
        if code not in ITEM_ERROR_CODES:
            raise ValueError(f"unknown bridge item error: {code}")
        super().__init__(public_message)
        self.code = code
        self.public_message = public_message


@dataclass(frozen=True)
class BridgeLimits:
    max_items: int = 200
    max_request_bytes: int = 256 * 1024 * 1024
    max_inline_item_bytes: int = 64 * 1024 * 1024
    max_inline_batch_bytes: int = 192 * 1024 * 1024
    max_remote_image_bytes: int = 64 * 1024 * 1024
    max_remote_video_bytes: int = 2 * 1024 * 1024 * 1024
    max_remote_batch_bytes: int = 8 * 1024 * 1024 * 1024
    batch_workers: int = 2
    batch_queue_capacity: int = 8
    download_workers: int = 4
    download_queue_capacity: int = 400
    classify_workers: int = 2
    classify_queue_capacity: int = 400
    dns_timeout_seconds: float = 3.0
    connect_timeout_seconds: float = 20.0
    idle_timeout_seconds: float = 30.0
    total_timeout_seconds: float = 600.0
    max_redirects: int = 3
    max_address_attempts: int = 2


def bridge_limits() -> BridgeLimits:
    return BridgeLimits()


@dataclass(frozen=True)
class BridgeImportItem:
    url: str = ""
    name: str = ""
    data: str = ""
    content_type: str = ""


@dataclass(frozen=True)
class BridgeImportRequest:
    folder: str
    classify: bool
    provider: str
    model: str
    prompt: str
    items: Sequence[BridgeImportItem]


def _loopback_host(value: str) -> bool:
    value = str(value or "").strip().strip("[]")
    if value.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(value).is_loopback
    except ValueError:
        return False


def _request_host(request: Request) -> str:
    host = str(request.headers.get("host") or "")
    try:
        return urlsplit(f"//{host}").hostname or ""
    except ValueError:
        return ""


def bridge_request_error_code(request: Request) -> str:
    client_host = str(request.client.host if request.client else "")
    if not _loopback_host(client_host):
        return "extension_forbidden"
    if not _loopback_host(_request_host(request)):
        return "extension_forbidden"
    if request.headers.get("origin", "") != EXTENSION_ORIGIN:
        return "extension_forbidden"

    method = request.method.upper()
    if method == "OPTIONS":
        method = request.headers.get("access-control-request-method", "").upper()
    if (method, request.url.path) not in BRIDGE_ROUTES:
        return "extension_route_forbidden"
    return ""


def bridge_request_allowed(request: Request) -> bool:
    return not bridge_request_error_code(request)


def is_browser_extension_attempt(request: Request) -> bool:
    return str(request.headers.get("origin") or "").lower().startswith("chrome-extension://")


def is_bridge_path(path: str) -> bool:
    return path in BRIDGE_PATHS


def require_browser_extension_request(request: Request) -> None:
    code = bridge_request_error_code(request)
    if code:
        message = "浏览器插件身份无效" if code == "extension_forbidden" else "浏览器插件路由不受支持"
        raise BridgeRequestError(code, message)


def require_json_content_type(request: Request) -> None:
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise BridgeRequestError(
            "invalid_import_request",
            "请求必须使用 application/json",
            status_code=415,
        )


def _text(raw: dict[str, Any], key: str, default: str, maximum: int) -> str:
    value = raw.get(key, default)
    if not isinstance(value, str):
        raise BridgeRequestError("invalid_import_request", f"{key} 必须是文本")
    value = value.strip() if key != "prompt" else value
    if len(value) > maximum:
        raise BridgeRequestError("import_limit_exceeded", f"{key} 超过长度限制")
    if any(ord(char) < 32 and char not in "\t\n" for char in value):
        raise BridgeRequestError("invalid_import_request", f"{key} 包含非法字符")
    return value


def _inline_payload_size(value: str) -> int:
    raw = value
    if raw.startswith("data:"):
        header, separator, raw = raw.partition(",")
        if not separator or len(header) > 128 or ";base64" not in header.lower():
            raise BridgeRequestError("invalid_import_request", "内联素材必须是 Base64 数据")
    raw = re.sub(r"\s+", "", raw)
    if not raw:
        return 0
    return ((len(raw) + 3) // 4) * 3


def parse_import_request(raw: dict[str, Any]) -> BridgeImportRequest:
    if not isinstance(raw, dict):
        raise BridgeRequestError("invalid_import_request", "请求必须是 JSON 对象")
    items_raw = raw.get("items")
    if not isinstance(items_raw, list) or not items_raw:
        raise BridgeRequestError("invalid_import_request", "items 必须是非空数组")
    limits = bridge_limits()
    if len(items_raw) > limits.max_items:
        raise BridgeRequestError("import_limit_exceeded", "素材项数量超过限制")

    classify = raw.get("classify", False)
    if not isinstance(classify, bool):
        raise BridgeRequestError("invalid_import_request", "classify 必须是布尔值")
    folder = _text(raw, "folder", "网页采集", 240)
    if any(part in {"", ".", ".."} for part in folder.replace("\\", "/").split("/")):
        raise BridgeRequestError("invalid_import_request", "目标文件夹无效")
    if folder.startswith("/") or re.match(r"^[A-Za-z]:", folder):
        raise BridgeRequestError("invalid_import_request", "目标文件夹无效")

    parsed_items: list[BridgeImportItem] = []
    inline_total = 0
    for raw_item in items_raw:
        if not isinstance(raw_item, dict):
            raise BridgeRequestError("invalid_import_request", "素材项必须是对象")
        item = BridgeImportItem(
            url=_text(raw_item, "url", "", 8192),
            name=_text(raw_item, "name", "", 240),
            data=_text(raw_item, "data", "", limits.max_request_bytes),
            content_type=_text(raw_item, "content_type", "", 128),
        )
        if not item.data and not item.url:
            raise BridgeRequestError("invalid_import_request", "每个素材项都必须包含 data 或 url")
        if item.data:
            estimated = _inline_payload_size(item.data)
            if estimated > limits.max_inline_item_bytes:
                raise BridgeRequestError("import_limit_exceeded", "单项内联素材超过限制")
            inline_total += estimated
            if inline_total > limits.max_inline_batch_bytes:
                raise BridgeRequestError("import_limit_exceeded", "批量内联素材超过限制")
        parsed_items.append(item)

    return BridgeImportRequest(
        folder=folder,
        classify=classify,
        provider=_text(raw, "provider", "comfly", 120),
        model=_text(raw, "model", "", 240),
        prompt=_text(raw, "prompt", "", 2000),
        items=tuple(parsed_items),
    )


def decode_inline_base64(value: str, destination: Path, limits: BridgeLimits) -> tuple[str, int]:
    content_type = ""
    encoded = value
    if value.startswith("data:"):
        header, separator, encoded = value.partition(",")
        if not separator or ";base64" not in header.lower():
            raise BridgeItemError("invalid_base64", "内联素材格式无效")
        content_type = header[5:].split(";", 1)[0].strip().lower()
    encoded = re.sub(r"\s+", "", encoded)
    upper_bound = ((len(encoded) + 3) // 4) * 3
    if upper_bound > limits.max_inline_item_bytes:
        raise BridgeItemError("item_too_large", "内联素材超过大小限制")
    try:
        content = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError) as error:
        raise BridgeItemError("invalid_base64", "内联素材无法解码") from error
    if not content or len(content) > limits.max_inline_item_bytes:
        raise BridgeItemError("invalid_base64", "内联素材为空或无效")
    destination.write_bytes(content)
    return content_type, len(content)


async def read_bounded_json(request: Request, max_bytes: int) -> dict[str, Any]:
    content_length = request.headers.get("content-length")
    if content_length:
        try:
            declared = int(content_length)
        except ValueError as error:
            raise BridgeRequestError("invalid_import_request", "Content-Length 无效") from error
        if declared < 0 or declared > max_bytes:
            raise BridgeRequestError("import_limit_exceeded", "请求体超过大小限制")

    body = bytearray()
    while True:
        message = await request.receive()
        if message.get("type") == "http.disconnect":
            raise BridgeRequestError("invalid_import_request", "请求在读取时断开")
        chunk = message.get("body") or b""
        if len(body) + len(chunk) > max_bytes:
            raise BridgeRequestError("import_limit_exceeded", "请求体超过大小限制")
        body.extend(chunk)
        if not message.get("more_body", False):
            break
    try:
        value = json.loads(bytes(body).decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise BridgeRequestError("invalid_import_request", "请求 JSON 无效") from error
    if not isinstance(value, dict):
        raise BridgeRequestError("invalid_import_request", "请求必须是 JSON 对象")
    return value


def redact_bridge_providers(providers: Sequence[dict[str, Any]]) -> list[dict[str, Any]]:
    result = []
    for provider in providers:
        if not isinstance(provider, dict):
            continue
        result.append(
            {
                "id": provider.get("id", ""),
                "name": provider.get("name", provider.get("id", "")),
                "enabled": bool(provider.get("enabled", True)),
                "chat_models": [
                    str(model)
                    for model in provider.get("chat_models", [])
                    if isinstance(model, (str, int, float))
                ],
            }
        )
    return result


def build_import_response(results: Sequence[dict[str, Any]]) -> dict[str, Any]:
    successful = [item for item in results if item.get("ok")]
    return {
        "ok": bool(successful),
        "count": len(successful),
        "files": [item["file"] for item in successful if item.get("file")],
        "items": list(results),
    }


def bridge_content_limit(content_type: str, source_name: str, limits: BridgeLimits | None = None) -> int:
    limits = limits or bridge_limits()
    content_type = str(content_type or "").split(";", 1)[0].strip().lower()
    name = str(source_name or "").lower()
    if content_type.startswith("video/") or name.endswith((".mp4", ".webm", ".mov", ".m4v", ".flv")):
        return limits.max_remote_video_bytes
    return limits.max_remote_image_bytes


@dataclass(frozen=True)
class BridgeRouterServices:
    list_providers: Callable[[], list[dict[str, Any]]]
    import_assets: Callable[[BridgeImportRequest], Awaitable[dict[str, Any]]]


def create_browser_extension_router(services: BridgeRouterServices) -> APIRouter:
    router = APIRouter()

    @router.get("/api/providers")
    async def providers(request: Request):
        values = services.list_providers()
        if is_browser_extension_attempt(request):
            require_browser_extension_request(request)
            values = redact_bridge_providers(values)
        return {"providers": values}

    @router.post("/api/local-assets/import-urls")
    async def import_urls(request: Request):
        if is_browser_extension_attempt(request):
            require_browser_extension_request(request)
        require_json_content_type(request)
        payload = await read_bounded_json(request, bridge_limits().max_request_bytes)
        return await services.import_assets(parse_import_request(payload))

    return router


def bridge_error_response(error: BridgeRequestError) -> JSONResponse:
    return JSONResponse(
        status_code=error.status_code,
        content={"ok": False, "error_code": error.code, "error": error.public_message},
    )
