from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any
from uuid import uuid4


def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _json_payload(document: Any) -> bytes:
    payload = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    return payload


def atomic_write_json(path: Path, document: Any) -> None:
    payload = _json_payload(document)
    atomic_write_bytes(path, payload)


def atomic_create_json(path: Path, document: Any) -> None:
    """Publish a complete JSON file without replacing an existing record."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("xb") as stream:
            stream.write(_json_payload(document))
            stream.flush()
            os.fsync(stream.fileno())
        if os.name == "nt":
            # Windows rename is atomic on one volume and refuses an existing target.
            os.rename(temporary, path)
        else:
            os.link(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)
