from __future__ import annotations

import json
import os
from dataclasses import dataclass, replace
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable

from .atomic import atomic_write_json


@dataclass(frozen=True)
class BootstrapConfig:
    schema_version: int
    edition: str
    data_root: str
    last_started_version: str = ""
    migration_id: str = ""
    migration_status: str = ""
    previous_data_root: str = ""

    def resolved_data_root(self) -> Path:
        return Path(self.data_root).expanduser().resolve()


class BootstrapStore:
    def __init__(
        self,
        appdata_root: Path,
        edition: str,
        program_root: Path,
        *,
        clock: Callable[[], datetime] | None = None,
    ):
        normalized_edition = edition.strip().lower()
        if not normalized_edition:
            raise ValueError("Hstar 版本不能为空")
        self.path = appdata_root.expanduser().resolve() / "Hstar" / normalized_edition / "bootstrap.json"
        self.edition = normalized_edition
        self.program_root = program_root.expanduser().resolve()
        self._clock = clock or (lambda: datetime.now(timezone.utc))

    def load(self) -> BootstrapConfig | None:
        if not self.path.is_file():
            return None
        try:
            document = json.loads(self.path.read_text(encoding="utf-8"))
            config = self._parse(document)
            self._validate(config)
            return config
        except (OSError, UnicodeError, json.JSONDecodeError, TypeError, ValueError):
            self._quarantine_corrupt_file()
            return None

    def require(self) -> BootstrapConfig:
        config = self.load()
        if config is None:
            raise RuntimeError("尚未配置 Hstar 数据目录")
        return config

    def save(self, config: BootstrapConfig) -> None:
        self._validate(config)
        target = config.resolved_data_root()
        previous_root = ""
        if config.previous_data_root:
            previous_root = str(Path(config.previous_data_root).expanduser().resolve())
        normalized = replace(
            config,
            edition=self.edition,
            data_root=str(target),
            previous_data_root=previous_root,
        )
        document = {
            "schemaVersion": normalized.schema_version,
            "edition": normalized.edition,
            "dataRoot": normalized.data_root,
            "lastStartedVersion": normalized.last_started_version,
            "migration": {
                "id": normalized.migration_id,
                "status": normalized.migration_status,
                "previousDataRoot": normalized.previous_data_root,
            },
        }
        atomic_write_json(self.path, document)

    def _parse(self, document: object) -> BootstrapConfig:
        if not isinstance(document, dict):
            raise ValueError("启动索引必须是 JSON 对象")
        migration = document.get("migration") or {}
        if not isinstance(migration, dict):
            raise ValueError("迁移状态格式无效")
        return BootstrapConfig(
            schema_version=document.get("schemaVersion"),
            edition=document.get("edition"),
            data_root=document.get("dataRoot"),
            last_started_version=document.get("lastStartedVersion") or "",
            migration_id=migration.get("id") or "",
            migration_status=migration.get("status") or "",
            previous_data_root=migration.get("previousDataRoot") or "",
        )

    def _validate(self, config: BootstrapConfig) -> None:
        if config.schema_version != 1:
            raise ValueError("不支持的启动索引版本")
        if not isinstance(config.edition, str) or config.edition.strip().lower() != self.edition:
            raise ValueError("Hstar 版本不匹配")
        if not isinstance(config.data_root, str) or not config.data_root.strip():
            raise ValueError("Hstar 数据目录不能为空")
        target = Path(os.path.expandvars(config.data_root)).expanduser()
        if not target.is_absolute():
            raise ValueError("Hstar 数据目录必须是绝对路径")
        target = target.resolve()
        if target == self.program_root or self.program_root in target.parents:
            raise ValueError("数据目录不能位于 Hstar 程序目录内")
        string_fields = (
            config.last_started_version,
            config.migration_id,
            config.migration_status,
            config.previous_data_root,
        )
        if any(not isinstance(value, str) for value in string_fields):
            raise ValueError("启动索引字段格式无效")

    def _quarantine_corrupt_file(self) -> None:
        if not self.path.exists():
            return
        timestamp = self._clock().astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")
        destination = self.path.with_name(f"{self.path.name}.corrupt-{timestamp}")
        suffix = 1
        while destination.exists():
            destination = self.path.with_name(f"{self.path.name}.corrupt-{timestamp}-{suffix}")
            suffix += 1
        os.replace(self.path, destination)
