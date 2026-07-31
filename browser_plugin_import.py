from __future__ import annotations

import asyncio
import base64
import ipaddress
import mimetypes
import os
import re
import socket
import urllib.parse
import uuid
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Awaitable, Callable

from fastapi import HTTPException
from starlette.requests import Request
from starlette.responses import Response


CONNECTOR_API_PREFIX = "/api/"
BROWSER_IMPORT_PATH = "/api/local-assets/import-urls"

MAX_PLUGIN_REQUEST_BYTES = 180 * 1024 * 1024
MAX_IMPORT_ITEMS = 500
MAX_INLINE_ITEM_BYTES = 64 * 1024 * 1024
MAX_INLINE_TOTAL_BYTES = 128 * 1024 * 1024
MAX_REMOTE_MEDIA_BYTES = 200 * 1024 * 1024
MAX_REMOTE_REDIRECTS = 3
_CHROME_EXTENSION_ORIGIN = re.compile(r"^chrome-extension://[a-p]{32}$")


def _requested_method(request: Request) -> str:
    if request.method.upper() == "OPTIONS":
        return str(request.headers.get("access-control-request-method") or "").upper()
    return request.method.upper()


def _extension_origin(request: Request) -> str:
    origin = str(request.headers.get("origin") or "").strip().lower()
    return origin if _CHROME_EXTENSION_ORIGIN.fullmatch(origin) else ""


def _is_loopback_hostname(value: str) -> bool:
    hostname = str(value or "").strip().strip("[]").lower()
    if hostname == "localhost":
        return True
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        return False
    mapped = getattr(address, "ipv4_mapped", None)
    return address.is_loopback or bool(mapped and mapped.is_loopback)


def _request_is_loopback(request: Request) -> bool:
    client_host = str(request.client.host if request.client else "")
    host_header = str(request.headers.get("host") or "").strip()
    try:
        request_hostname = urllib.parse.urlsplit(f"//{host_header}").hostname or ""
    except ValueError:
        return False
    return _is_loopback_hostname(client_host) and _is_loopback_hostname(request_hostname)


def _is_legacy_extension_fetch(request: Request) -> bool:
    if str(request.headers.get("origin") or "").strip():
        return False
    return (
        str(request.headers.get("sec-fetch-mode") or "").strip().lower() == "cors"
        and str(request.headers.get("sec-fetch-site") or "").strip().lower() == "none"
    )


def _is_connector_route(request: Request) -> bool:
    return request.url.path.startswith(CONNECTOR_API_PREFIX)


def reject_untrusted_plugin_route_origin(request: Request) -> bool:
    if not _is_connector_route(request):
        return False
    origin = str(request.headers.get("origin") or "").strip().lower()
    if not origin:
        return False
    if origin.startswith("chrome-extension://"):
        return not is_browser_plugin_request(request)
    try:
        parsed_origin = urllib.parse.urlsplit(origin)
        parsed_host = urllib.parse.urlsplit(f"//{request.headers.get('host') or ''}")
        origin_port = parsed_origin.port or (443 if parsed_origin.scheme == "https" else 80)
        host_port = parsed_host.port or (443 if request.url.scheme == "https" else 80)
    except ValueError:
        return True
    return not (
        parsed_origin.scheme in {"http", "https"}
        and _is_loopback_hostname(parsed_origin.hostname or "")
        and _request_is_loopback(request)
        and origin_port == host_port
    )


def is_browser_plugin_request(request: Request) -> bool:
    if not _request_is_loopback(request) or not _is_connector_route(request):
        return False
    if not (_extension_origin(request) or _is_legacy_extension_fetch(request)):
        return False
    return True


def is_photoshop_plugin_request(request: Request) -> bool:
    return (
        not str(request.headers.get("origin") or "").strip()
        and _request_is_loopback(request)
        and _is_connector_route(request)
    )


def is_local_connector_request(request: Request) -> bool:
    return is_browser_plugin_request(request) or is_photoshop_plugin_request(request)


def add_browser_plugin_cors(response: Response, request: Request) -> Response:
    origin = _extension_origin(request)
    if not origin or not is_browser_plugin_request(request):
        return response
    response.headers["Access-Control-Allow-Origin"] = origin
    response.headers["Access-Control-Allow-Methods"] = (
        "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS"
    )
    response.headers["Access-Control-Allow-Headers"] = (
        str(request.headers.get("access-control-request-headers") or "content-type")
    )
    vary = [part.strip() for part in str(response.headers.get("Vary") or "").split(",") if part.strip()]
    if not any(part.lower() == "origin" for part in vary):
        vary.append("Origin")
    response.headers["Vary"] = ", ".join(vary)
    return response


async def enforce_browser_plugin_request_size(request: Request) -> None:
    if (
        request.url.path != BROWSER_IMPORT_PATH
        or request.method.upper() != "POST"
        or not is_browser_plugin_request(request)
    ):
        return
    content_length = str(request.headers.get("content-length") or "").strip()
    if content_length:
        try:
            if int(content_length) > MAX_PLUGIN_REQUEST_BYTES:
                raise HTTPException(status_code=413, detail="插件导入请求过大")
        except ValueError as error:
            raise HTTPException(status_code=400, detail="插件导入请求长度无效") from error
    body = await request.body()
    if len(body) > MAX_PLUGIN_REQUEST_BYTES:
        raise HTTPException(status_code=413, detail="插件导入请求过大")


@dataclass(frozen=True)
class BrowserPluginImportServices:
    upload_root: Callable[[], Path]
    safe_folder: Callable[[str], tuple[str, str]]
    safe_file_stem: Callable[[str], str]
    kind_and_extension: Callable[[str, str], tuple[str | None, str]]
    build_item: Callable[[str], dict[str, Any]]
    classify_image: Callable[[str, str, str, str, str], Awaitable[dict[str, Any] | None]]
    write_classification: Callable[[str, dict[str, Any]], None]
    output_file_from_url: Callable[[str], str | None]
    fetch_remote_media_bytes: Callable[[str], tuple[bytes, str] | None]


def _item_text(item: Any, key: str) -> str:
    if isinstance(item, dict):
        return str(item.get(key) or "").strip()
    return str(getattr(item, key, "") or "").strip()


def _decode_inline_media(data: str, content_type: str) -> tuple[bytes, str]:
    raw = str(data or "").strip()
    if raw.startswith("data:"):
        header, separator, raw = raw.partition(",")
        if not separator:
            raise HTTPException(status_code=400, detail="素材 data URL 无效")
        if not content_type:
            content_type = header[5:].split(";", 1)[0].strip().lower()
    compact = re.sub(r"\s+", "", raw)
    estimated_size = max(0, (len(compact) * 3) // 4 - compact[-2:].count("="))
    if estimated_size > MAX_INLINE_ITEM_BYTES:
        raise HTTPException(status_code=413, detail="单个内嵌素材过大")
    try:
        content = base64.b64decode(compact, validate=True)
    except Exception as error:
        raise HTTPException(status_code=400, detail="素材数据无法解码") from error
    if not content:
        raise HTTPException(status_code=400, detail="素材内容为空")
    if len(content) > MAX_INLINE_ITEM_BYTES:
        raise HTTPException(status_code=413, detail="单个内嵌素材过大")
    return content, content_type


def _loopback_host(hostname: str) -> bool:
    return _is_loopback_hostname(hostname)


def validate_public_remote_url(value: str) -> str:
    text = str(value or "").strip()
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError as error:
        raise HTTPException(status_code=400, detail="远程素材地址无效") from error
    if (
        parsed.scheme.lower() not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise HTTPException(status_code=400, detail="远程素材地址无效")

    hostname = parsed.hostname.rstrip(".").lower()
    addresses: list[ipaddress.IPv4Address | ipaddress.IPv6Address] = []
    try:
        addresses.append(ipaddress.ip_address(hostname.split("%", 1)[0]))
    except ValueError:
        try:
            resolved = socket.getaddrinfo(
                hostname,
                parsed.port or (443 if parsed.scheme.lower() == "https" else 80),
                type=socket.SOCK_STREAM,
            )
        except OSError as error:
            raise HTTPException(status_code=400, detail="远程素材域名无法解析") from error
        for info in resolved:
            try:
                addresses.append(ipaddress.ip_address(info[4][0].split("%", 1)[0]))
            except (ValueError, IndexError):
                continue
    if not addresses or any(not address.is_global for address in addresses):
        raise HTTPException(status_code=400, detail="远程素材地址不能指向本机或内网")
    return urllib.parse.urlunsplit(parsed)


def _inline_payload_size(item: Any) -> int:
    raw = _item_text(item, "data")
    if not raw:
        return 0
    if raw.startswith("data:"):
        _, separator, raw = raw.partition(",")
        if not separator:
            raise HTTPException(status_code=400, detail="素材 data URL 无效")
    compact = re.sub(r"\s+", "", raw)
    return max(0, (len(compact) * 3) // 4 - compact[-2:].count("="))


def _validate_import_limits(entries: list[Any]) -> None:
    if len(entries) > MAX_IMPORT_ITEMS:
        raise HTTPException(status_code=422, detail=f"一次最多导入 {MAX_IMPORT_ITEMS} 个素材")
    inline_total = 0
    for entry in entries:
        size = _inline_payload_size(entry)
        if size > MAX_INLINE_ITEM_BYTES:
            raise HTTPException(status_code=413, detail="单个内嵌素材过大")
        inline_total += size
        if inline_total > MAX_INLINE_TOTAL_BYTES:
            raise HTTPException(status_code=413, detail="内嵌素材总大小过大")


def resolve_hstar_local_media_path(value: str, output_file_from_url: Callable[[str], str | None]) -> str | None:
    text = str(value or "").strip()
    if not text:
        return None
    direct = output_file_from_url(text)
    if direct:
        return direct
    try:
        parsed = urllib.parse.urlsplit(text)
    except ValueError:
        return None
    if parsed.scheme and not _loopback_host(parsed.hostname or ""):
        return None
    if parsed.path not in {"/api/media-preview", "/api/image-jpeg"}:
        return None
    nested = urllib.parse.parse_qs(parsed.query).get("url", [""])[0]
    return resolve_hstar_local_media_path(nested, output_file_from_url)


async def _media_from_source(item: Any, services: BrowserPluginImportServices) -> tuple[bytes, str, str, str]:
    source_url = _item_text(item, "url")
    source_name = _item_text(item, "name")
    content_type = _item_text(item, "content_type") or _item_text(item, "contentType")
    inline_data = _item_text(item, "data")

    if inline_data:
        content, content_type = _decode_inline_media(inline_data, content_type)
        return content, content_type, source_name or "web-image", source_url

    if not source_url:
        raise HTTPException(status_code=400, detail="素材缺少来源")

    local_path = resolve_hstar_local_media_path(source_url, services.output_file_from_url)
    if local_path:
        path = Path(local_path)
        try:
            if path.stat().st_size > MAX_REMOTE_MEDIA_BYTES:
                raise HTTPException(status_code=413, detail="素材文件过大")
            content = await asyncio.to_thread(path.read_bytes)
        except OSError as error:
            raise HTTPException(status_code=400, detail="本地 Hstar 素材不可读") from error
        content_type = content_type or mimetypes.guess_type(path.name)[0] or ""
        if not os.path.splitext(source_name)[1]:
            source_name = path.name
        return content, content_type, source_name or path.name, source_url

    if not source_url.startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="仅支持 http(s)、data 或 Hstar 本地素材地址")
    remote = await asyncio.to_thread(services.fetch_remote_media_bytes, source_url)
    if not remote:
        raise HTTPException(status_code=400, detail="远程素材下载失败")
    content, content_type = remote
    parsed_name = os.path.basename(urllib.parse.unquote(urllib.parse.urlsplit(source_url).path))
    return content, content_type, source_name or parsed_name or "web-image", source_url


def _sniff_image_ext(content: bytes) -> str | None:
    head = content[:32]
    if head.startswith(b"\x89PNG\r\n\x1a\n"):
        return ".png"
    if head.startswith(b"\xff\xd8\xff"):
        return ".jpg"
    if head[:4] == b"RIFF" and head[8:12] == b"WEBP":
        return ".webp"
    if head[:6] in (b"GIF87a", b"GIF89a"):
        return ".gif"
    if len(head) >= 12 and head[4:8] == b"ftyp" and b"avif" in head[8:32]:
        return ".avif"
    return None


async def import_browser_plugin_assets(payload: Any, services: BrowserPluginImportServices) -> dict[str, Any]:
    uploaded: list[dict[str, Any]] = []
    results: list[dict[str, Any]] = []
    entries = list(getattr(payload, "items", []) or [])
    _validate_import_limits(entries)
    folder_rel, folder_abs = services.safe_folder(str(getattr(payload, "folder", "") or "网页采集"))
    await asyncio.to_thread(os.makedirs, folder_abs, exist_ok=True)

    for entry in entries:
        source_url = _item_text(entry, "url")
        result = {"url": source_url, "ok": False, "file": "", "error": ""}
        path = ""
        try:
            content, content_type, source_name, _ = await _media_from_source(entry, services)
            kind, ext = services.kind_and_extension(source_name, content_type)
            if kind == "image":
                real_ext = _sniff_image_ext(content)
                if real_ext and not (real_ext == ".jpg" and ext == ".jpeg"):
                    ext = real_ext
            if kind not in {"image", "video"}:
                raise HTTPException(status_code=400, detail=f"不是图片或视频资源：{content_type or source_url}")
            if not content:
                raise HTTPException(status_code=400, detail="素材内容为空")

            stem = services.safe_file_stem(os.path.splitext(source_name or "")[0] or ("web-video" if kind == "video" else "web-image"))
            if ext and stem.lower().endswith(ext.lower()):
                stem = stem[:-len(ext)].rstrip(".") or ("web-video" if kind == "video" else "web-image")
            filename = f"up_{uuid.uuid4().hex[:12]}_{stem}{ext}"
            rel_name = f"{folder_rel}/{filename}".lstrip("/")
            path = os.path.join(folder_abs, filename)
            await asyncio.to_thread(Path(path).write_bytes, content)

            if bool(getattr(payload, "classify", False)) and kind == "image":
                classification = await services.classify_image(
                    path,
                    str(getattr(payload, "provider", "") or "comfly"),
                    str(getattr(payload, "model", "") or ""),
                    str(getattr(payload, "ms_model", "") or ""),
                    str(getattr(payload, "prompt", "") or ""),
                )
                if classification:
                    services.write_classification(rel_name, classification)
            item = services.build_item(rel_name)
            uploaded.append(item)
            result.update({"ok": True, "file": rel_name, "item": item})
        except HTTPException as error:
            result["error"] = str(error.detail or "导入失败")
        except Exception as error:
            result["error"] = str(error) or "导入失败"
        if not result["ok"] and path:
            try:
                await asyncio.to_thread(os.remove, path)
            except OSError:
                pass
        results.append(result)

    return {
        "ok": bool(uploaded),
        "count": len(uploaded),
        "failed_count": len(results) - len(uploaded),
        "total_count": len(results),
        "files": uploaded,
        "items": results,
    }
