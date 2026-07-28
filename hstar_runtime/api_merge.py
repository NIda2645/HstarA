from __future__ import annotations

import json
from copy import deepcopy
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Iterable, Mapping

from hstar_runtime.atomic import atomic_write_bytes


USER_CHOICE_FIELDS = ("enabled", "primary", "use_system_proxy")
CREDENTIAL_FIELDS = frozenset(
    {
        "api_key",
        "wallet_api_key",
        "runninghub_wallet_api_key",
        "volcengine_access_key_id",
        "volcengine_secret_access_key",
        "access_token",
        "secret_key",
    }
)


@dataclass(frozen=True)
class ApiConfigUpdateResult:
    provider_count: int
    official_provider_count: int
    backup_path: Path | None


def _provider_id(provider: Mapping[str, object]) -> str:
    return str(provider.get("id") or "").strip().lower()


def _sanitize_provider(provider: Mapping[str, object]) -> dict:
    sanitized = {
        key: deepcopy(value)
        for key, value in provider.items()
        if key not in CREDENTIAL_FIELDS
    }
    provider_id = _provider_id(sanitized)
    if not provider_id:
        raise ValueError("provider id must not be empty")
    sanitized["id"] = provider_id
    return sanitized


def _validated_providers(
    providers: Iterable[Mapping[str, object]],
) -> list[dict]:
    if not isinstance(providers, list):
        raise ValueError("provider configuration must be a list")
    result: list[dict] = []
    seen: set[str] = set()
    for provider in providers:
        if not isinstance(provider, Mapping):
            raise ValueError("provider entries must be objects")
        sanitized = _sanitize_provider(provider)
        provider_id = sanitized["id"]
        if provider_id in seen:
            raise ValueError(f"duplicate provider id: {provider_id}")
        seen.add(provider_id)
        result.append(sanitized)
    return result


def merge_api_defaults(current: list[dict], defaults: list[dict]) -> list[dict]:
    current_providers = _validated_providers(current)
    default_providers = _validated_providers(defaults)
    current_by_id = {
        provider["id"]: provider
        for provider in current_providers
    }
    result: list[dict] = []
    for default in default_providers:
        existing = current_by_id.pop(default["id"], {})
        merged = {**existing, **default}
        for key in USER_CHOICE_FIELDS:
            if key in existing:
                merged[key] = existing[key]
        result.append(_sanitize_provider(merged))
    result.extend(current_by_id.values())
    return result


def _read_provider_file(path: Path, *, missing_default: list[dict] | None = None) -> list[dict]:
    if not path.exists() and missing_default is not None:
        return deepcopy(missing_default)
    document = json.loads(path.read_text(encoding="utf-8-sig"))
    if not isinstance(document, list):
        raise ValueError("provider configuration must be a JSON array")
    return document


def _json_payload(providers: list[dict]) -> bytes:
    return (json.dumps(providers, ensure_ascii=False, indent=2) + "\n").encode("utf-8")


def _backup_path(backup_dir: Path, stamp: str) -> Path:
    directory = backup_dir / "api"
    candidate = directory / f"api-providers-{stamp}.json"
    suffix = 1
    while candidate.exists():
        candidate = directory / f"api-providers-{stamp}-{suffix}.json"
        suffix += 1
    return candidate


def update_api_config(
    current_file: Path,
    defaults_file: Path,
    backup_dir: Path,
    *,
    clock=lambda: datetime.now(timezone.utc),
) -> ApiConfigUpdateResult:
    current_file = Path(current_file)
    defaults_file = Path(defaults_file)
    backup_dir = Path(backup_dir)
    original_payload = current_file.read_bytes() if current_file.exists() else None
    current = _read_provider_file(current_file, missing_default=[])
    defaults = _read_provider_file(defaults_file)
    sanitized_current = _validated_providers(current)
    merged = merge_api_defaults(sanitized_current, defaults)
    stamp = clock().astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")
    backup_path: Path | None = None

    try:
        if original_payload is not None:
            backup_path = _backup_path(backup_dir, stamp)
            atomic_write_bytes(backup_path, _json_payload(sanitized_current))
        atomic_write_bytes(current_file, _json_payload(merged))
        verified = _read_provider_file(current_file)
        if verified != merged:
            raise RuntimeError("written API provider configuration failed verification")
    except Exception:
        if original_payload is None:
            current_file.unlink(missing_ok=True)
        else:
            atomic_write_bytes(current_file, original_payload)
        raise

    return ApiConfigUpdateResult(
        provider_count=len(merged),
        official_provider_count=len(defaults),
        backup_path=backup_path,
    )
