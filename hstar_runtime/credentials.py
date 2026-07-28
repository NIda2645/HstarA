from __future__ import annotations

import ctypes
import json
import os
from ctypes import wintypes
from datetime import datetime, timezone
from pathlib import Path
from typing import Mapping, Protocol
from uuid import uuid4

from hstar_runtime.atomic import atomic_write_bytes


DPAPI_ENTROPY = b"Hstar.credentials.v1"
CRYPTPROTECT_UI_FORBIDDEN = 0x01


class SecretProtector(Protocol):
    def protect(self, payload: bytes) -> bytes: ...

    def unprotect(self, payload: bytes) -> bytes: ...


class CredentialBackend(Protocol):
    path: Path

    def save(self, values: Mapping[str, str]) -> None: ...

    def load(self) -> dict[str, str]: ...

    def update(self, updates: Mapping[str, str]) -> dict[str, str]: ...


class _DataBlob(ctypes.Structure):
    _fields_ = [
        ("cbData", wintypes.DWORD),
        ("pbData", ctypes.POINTER(ctypes.c_ubyte)),
    ]


def _input_blob(payload: bytes) -> tuple[_DataBlob, ctypes.Array[ctypes.c_char]]:
    buffer = ctypes.create_string_buffer(payload, len(payload))
    blob = _DataBlob(
        len(payload),
        ctypes.cast(buffer, ctypes.POINTER(ctypes.c_ubyte)),
    )
    return blob, buffer


class DpapiSecretProtector:
    """Protect secrets with Windows DPAPI in the current-user scope."""

    def __init__(self, entropy: bytes = DPAPI_ENTROPY):
        if os.name != "nt":
            raise RuntimeError("Windows DPAPI is unavailable on this platform")
        self.entropy = bytes(entropy)
        self._crypt32 = ctypes.WinDLL("crypt32", use_last_error=True)
        self._kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        blob_pointer = ctypes.POINTER(_DataBlob)
        self._crypt32.CryptProtectData.argtypes = [
            blob_pointer,
            wintypes.LPCWSTR,
            blob_pointer,
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            blob_pointer,
        ]
        self._crypt32.CryptProtectData.restype = wintypes.BOOL
        self._crypt32.CryptUnprotectData.argtypes = [
            blob_pointer,
            ctypes.POINTER(wintypes.LPWSTR),
            blob_pointer,
            ctypes.c_void_p,
            ctypes.c_void_p,
            wintypes.DWORD,
            blob_pointer,
        ]
        self._crypt32.CryptUnprotectData.restype = wintypes.BOOL
        self._kernel32.LocalFree.argtypes = [ctypes.c_void_p]
        self._kernel32.LocalFree.restype = ctypes.c_void_p

    def protect(self, payload: bytes) -> bytes:
        return self._transform("CryptProtectData", payload)

    def unprotect(self, payload: bytes) -> bytes:
        return self._transform("CryptUnprotectData", payload)

    def _transform(self, function_name: str, payload: bytes) -> bytes:
        if not payload:
            raise ValueError("DPAPI payload must not be empty")
        input_blob, input_buffer = _input_blob(payload)
        entropy_blob, entropy_buffer = _input_blob(self.entropy)
        output_blob = _DataBlob()
        function = getattr(self._crypt32, function_name)
        result = function(
            ctypes.byref(input_blob),
            None,
            ctypes.byref(entropy_blob),
            None,
            None,
            CRYPTPROTECT_UI_FORBIDDEN,
            ctypes.byref(output_blob),
        )
        # Keep input buffers alive until the native call has returned.
        _ = input_buffer, entropy_buffer
        if not result:
            raise ctypes.WinError(ctypes.get_last_error())
        try:
            return ctypes.string_at(output_blob.pbData, output_blob.cbData)
        finally:
            self._kernel32.LocalFree(output_blob.pbData)


def _normalize_values(values: Mapping[str, str]) -> dict[str, str]:
    normalized: dict[str, str] = {}
    for key, value in values.items():
        if not isinstance(key, str) or not isinstance(value, str):
            raise ValueError("Credential keys and values must be strings")
        normalized[key] = value
    return normalized


class CredentialStore:
    def __init__(self, path: Path, protector: SecretProtector):
        self.path = Path(path)
        self.protector = protector

    def save(self, values: Mapping[str, str]) -> None:
        document = _normalize_values(values)
        payload = json.dumps(
            document,
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        ).encode("utf-8")
        encrypted = self.protector.protect(payload)
        atomic_write_bytes(self.path, encrypted)

    def load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        encrypted = self.path.read_bytes()
        if not encrypted:
            raise ValueError("Credential store is empty")
        payload = self.protector.unprotect(encrypted)
        document = json.loads(payload.decode("utf-8"))
        if not isinstance(document, dict):
            raise ValueError("Credential store must contain a JSON object")
        return _normalize_values(document)

    def update(self, updates: Mapping[str, str]) -> dict[str, str]:
        merged = self.load()
        merged.update(_normalize_values(updates))
        self.save(merged)
        return merged


def parse_env_bytes(payload: bytes) -> dict[str, str]:
    text = payload.decode("utf-8-sig")
    values: dict[str, str] = {}
    for raw_line in text.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        if not key:
            continue
        values[key] = value.strip().strip('"').strip("'")
    return values


def _env_quote(value: str) -> str:
    if not value or any(character.isspace() for character in value) or any(
        character in value for character in "#'\""
    ):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


class PlaintextEnvCredentialStore:
    """Explicit non-Windows development fallback; never use in packaged builds."""

    def __init__(self, path: Path):
        self.path = Path(path)

    def save(self, values: Mapping[str, str]) -> None:
        document = _normalize_values(values)
        payload = "".join(
            f"{key}={_env_quote(value)}\n"
            for key, value in sorted(document.items())
        ).encode("utf-8")
        atomic_write_bytes(self.path, payload)

    def load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        return parse_env_bytes(self.path.read_bytes())

    def update(self, updates: Mapping[str, str]) -> dict[str, str]:
        merged = self.load()
        merged.update(_normalize_values(updates))
        self.save(merged)
        return merged


def create_credential_store(
    path: Path,
    *,
    edition: str,
    platform_name: str = os.name,
    protector: SecretProtector | None = None,
    plaintext_path: Path | None = None,
) -> CredentialBackend:
    if platform_name == "nt":
        return CredentialStore(path, protector or DpapiSecretProtector())
    normalized_edition = edition.strip().lower()
    if (
        normalized_edition == "development"
        or normalized_edition.startswith("test")
    ) and plaintext_path is not None:
        return PlaintextEnvCredentialStore(plaintext_path)
    raise RuntimeError("Windows packaged editions require a DPAPI credential store")


def migrate_legacy_env(
    source: Path,
    store: CredentialBackend,
    backup_dir: Path,
    *,
    clock=lambda: datetime.now(timezone.utc),
) -> bool:
    return migrate_legacy_env_sources(
        [source],
        store,
        backup_dir,
        clock=clock,
    )


def migrate_legacy_env_sources(
    sources: list[Path] | tuple[Path, ...],
    store: CredentialBackend,
    backup_dir: Path,
    *,
    clock=lambda: datetime.now(timezone.utc),
) -> bool:
    existing_sources = [Path(source) for source in sources if Path(source).is_file()]
    if not existing_sources or store.load():
        return False

    source_payloads = {
        source: source.read_bytes()
        for source in existing_sources
    }
    values: dict[str, str] = {}
    for source in existing_sources:
        values.update(parse_env_bytes(source_payloads[source]))
    if not values:
        return False

    previous_store = store.path.read_bytes() if store.path.exists() else None
    stamp = clock().astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")
    try:
        store.save(values)
        if store.load() != values:
            raise RuntimeError("Credential store verification failed")
        for source, source_payload in source_payloads.items():
            backup_path = Path(backup_dir) / (
                f"api.env.legacy-{stamp}-{uuid4().hex[:8]}.bak"
            )
            atomic_write_bytes(backup_path, source_payload)
        for source, source_payload in source_payloads.items():
            if source.read_bytes() != source_payload:
                raise RuntimeError(f"Legacy credential source changed: {source.name}")
        for source in existing_sources:
            source.unlink()
    except Exception:
        for source, source_payload in source_payloads.items():
            if not source.exists():
                atomic_write_bytes(source, source_payload)
        if previous_store is None:
            store.path.unlink(missing_ok=True)
        else:
            atomic_write_bytes(store.path, previous_store)
        raise
    return True
