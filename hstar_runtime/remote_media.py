from __future__ import annotations

import http.client
import ipaddress
import socket
import ssl
import time
import uuid
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit


@dataclass(frozen=True)
class RemoteMediaLimits:
    max_bytes: int
    max_redirects: int = 3
    max_address_attempts: int = 2
    dns_timeout_seconds: float = 3.0
    connect_timeout_seconds: float = 20.0
    idle_timeout_seconds: float = 30.0
    total_timeout_seconds: float = 600.0


class RemoteMediaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DownloadedMedia:
    path: Path
    content_type: str
    byte_count: int
    source_name: str


def _deadline_remaining(deadline: float) -> float:
    remaining = deadline - time.monotonic()
    if remaining <= 0:
        raise RemoteMediaError("remote_timeout", "远程素材下载超时")
    return remaining


def _source_name(url: str) -> str:
    parsed = urlsplit(url)
    name = unquote(Path(parsed.path or "").name).strip()
    return name[:180] or "remote-media"


def _validate_url(
    url: str,
    limits: RemoteMediaLimits,
    *,
    resolve_host=None,
    fake_mode: bool = False,
) -> tuple[str, list[str]]:
    try:
        parsed = urlsplit(str(url or "").strip())
        port = parsed.port
    except ValueError as error:
        raise RemoteMediaError("unsafe_url", "远程素材 URL 无效") from error
    scheme = parsed.scheme.lower()
    if (
        scheme not in {"http", "https"}
        or not parsed.netloc
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
    ):
        raise RemoteMediaError("unsafe_url", "远程素材 URL 无效")
    if port is not None and (port < 1 or port > 65535):
        raise RemoteMediaError("unsafe_url", "远程素材端口无效")

    hostname = parsed.hostname.rstrip(".")
    addresses = []
    try:
        addresses.append(ipaddress.ip_address(hostname.split("%", 1)[0]))
    except ValueError:
        if fake_mode and resolve_host is None:
            addresses.append(ipaddress.ip_address("93.184.216.34"))
        else:
            resolver = resolve_host or _resolve_host
            try:
                for value in resolver(hostname, port or (443 if scheme == "https" else 80)):
                    addresses.append(ipaddress.ip_address(str(value).split("%", 1)[0]))
            except (OSError, ValueError) as error:
                raise RemoteMediaError("dns_failed", "远程素材域名无法解析") from error

    if not addresses or any(not address.is_global for address in addresses):
        raise RemoteMediaError("unsafe_address", "远程素材地址不安全")
    unique = list(dict.fromkeys(str(address) for address in addresses))
    return urlunsplit(parsed), unique[: limits.max_address_attempts]


def _resolve_host(hostname: str, port: int) -> list[str]:
    infos = socket.getaddrinfo(hostname, port, 0, socket.SOCK_STREAM, 0, 0)
    return [info[4][0] for info in infos]


def _open_pinned_connection(
    url: str,
    target_ip: str,
    limits: RemoteMediaLimits,
    deadline: float,
) -> tuple[http.client.HTTPConnection, str, str]:
    parsed = urlsplit(url)
    hostname = parsed.hostname
    if not hostname:
        raise RemoteMediaError("unsafe_url", "远程素材 URL 无效")
    scheme = parsed.scheme.lower()
    default_port = 443 if scheme == "https" else 80
    port = parsed.port or default_port
    timeout = min(limits.connect_timeout_seconds, _deadline_remaining(deadline))
    try:
        raw_socket = socket.create_connection((target_ip, port), timeout=timeout)
        if scheme == "https":
            raw_socket = ssl.create_default_context().wrap_socket(
                raw_socket,
                server_hostname=hostname,
            )
        raw_socket.settimeout(min(limits.idle_timeout_seconds, _deadline_remaining(deadline)))
        connection = http.client.HTTPConnection(hostname, port, timeout=timeout)
        connection.sock = raw_socket
    except (OSError, ssl.SSLError) as error:
        raise RemoteMediaError("remote_http_error", "远程素材连接失败") from error

    target = parsed.path or "/"
    if parsed.query:
        target = f"{target}?{parsed.query}"
    host_name = f"[{hostname}]" if ":" in hostname else hostname
    host_header = host_name if port == default_port else f"{host_name}:{port}"
    return connection, target, host_header


def _fake_body_chunks(body) -> list[bytes]:
    if isinstance(body, bytes):
        return [body]
    return [bytes(chunk) for chunk in body]


async def download_remote_media(
    url: str,
    temp_root: Path,
    limits: RemoteMediaLimits,
    *,
    content_limit=None,
    consume_bytes=None,
    resolve_host=None,
    fake_responses=None,
) -> DownloadedMedia:
    temp_root = Path(temp_root)
    temp_root.mkdir(parents=True, exist_ok=True)
    temp_path = temp_root / f".remote-{uuid.uuid4().hex}.tmp"
    current_url = str(url or "").strip()
    deadline = time.monotonic() + limits.total_timeout_seconds
    fake_queue = list(fake_responses or [])
    fake_mode = fake_responses is not None
    committed = False

    try:
        for redirect_count in range(limits.max_redirects + 1):
            current_url, addresses = _validate_url(
                current_url,
                limits,
                resolve_host=resolve_host,
                fake_mode=fake_mode,
            )
            if fake_mode:
                if not fake_queue:
                    raise RemoteMediaError("remote_http_error", "远程素材没有测试响应")
                status, headers, body = fake_queue.pop(0)
                headers = {str(key).lower(): str(value) for key, value in headers.items()}
                chunks = _fake_body_chunks(body)
            else:
                status = 0
                headers = {}
                chunks = []
                last_error = None
                for address in addresses:
                    connection = None
                    try:
                        connection, target, host_header = _open_pinned_connection(
                            current_url,
                            address,
                            limits,
                            deadline,
                        )
                        connection.request(
                            "GET",
                            target,
                            headers={
                                "Host": host_header,
                                "Accept": "image/*,video/*,*/*;q=0.8",
                                "Connection": "close",
                            },
                        )
                        response = connection.getresponse()
                        status = int(response.status)
                        headers = {key.lower(): value for key, value in response.getheaders()}
                        chunks = iter(lambda: response.read(64 * 1024), b"")
                        break
                    except RemoteMediaError:
                        raise
                    except (OSError, ssl.SSLError, http.client.HTTPException) as error:
                        last_error = error
                        if connection is not None:
                            connection.close()
                else:
                    raise RemoteMediaError("remote_http_error", "远程素材下载失败") from last_error

            if status in {301, 302, 303, 307, 308}:
                location = headers.get("location")
                if not location or redirect_count >= limits.max_redirects:
                    raise RemoteMediaError("remote_http_error", "远程素材重定向无效")
                current_url = urljoin(current_url, location)
                continue
            if status < 200 or status >= 300:
                raise RemoteMediaError("remote_http_error", f"远程素材 HTTP {status}")

            content_type = headers.get("content-type", "").split(";", 1)[0].strip().lower()
            source_name = _source_name(current_url)
            effective_limit = limits.max_bytes
            if content_limit is not None:
                effective_limit = min(effective_limit, int(content_limit(content_type, source_name)))
            content_length = headers.get("content-length")
            if content_length:
                try:
                    declared = int(content_length)
                except ValueError as error:
                    raise RemoteMediaError("remote_http_error", "远程素材 Content-Length 无效") from error
                if declared < 0 or declared > effective_limit:
                    raise RemoteMediaError("too_large", "远程素材超过大小限制")

            total = 0
            connection_to_close = locals().get("connection") if not fake_mode else None
            try:
                with temp_path.open("wb") as handle:
                    for chunk in chunks:
                        _deadline_remaining(deadline)
                        if not chunk:
                            continue
                        total += len(chunk)
                        if total > effective_limit:
                            raise RemoteMediaError("too_large", "远程素材超过大小限制")
                        if consume_bytes is not None:
                            consume_bytes(len(chunk))
                        handle.write(chunk)
            finally:
                if connection_to_close is not None:
                    connection_to_close.close()
            if total <= 0:
                raise RemoteMediaError("remote_http_error", "远程素材为空")
            committed = True
            return DownloadedMedia(
                path=temp_path,
                content_type=content_type,
                byte_count=total,
                source_name=source_name,
            )
        raise RemoteMediaError("remote_http_error", "远程素材重定向失败")
    except RemoteMediaError:
        raise
    except socket.timeout as error:
        raise RemoteMediaError("remote_timeout", "远程素材下载超时") from error
    finally:
        if not committed:
            try:
                temp_path.unlink()
            except FileNotFoundError:
                pass
