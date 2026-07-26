from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Callable


@dataclass(frozen=True)
class RuntimePaths:
    program_root: Path
    data_root: Path
    edition: str
    static_dir: Path
    builtin_workflow_dir: Path
    api_defaults_dir: Path
    config_dir: Path
    secrets_dir: Path
    project_dir: Path
    canvas_dir: Path
    openshop_dir: Path
    director_dir: Path
    asset_dir: Path
    output_dir: Path
    history_dir: Path
    model_dir: Path
    cache_dir: Path
    log_dir: Path
    backup_dir: Path
    temp_dir: Path
    user_workflow_dir: Path

    def writable_paths(self) -> tuple[Path, ...]:
        program_owned = {
            "program_root",
            "static_dir",
            "builtin_workflow_dir",
            "api_defaults_dir",
        }
        return tuple(
            value
            for name, value in vars(self).items()
            if name not in program_owned and isinstance(value, Path)
        )


def default_data_root(
    *,
    drive_exists: Callable[[str], bool] = os.path.exists,
    documents: Path | None = None,
) -> Path:
    if drive_exists("E:\\"):
        return Path("E:/Hstar缓存")
    return (documents or Path.home() / "Documents") / "Hstar缓存"


def build_runtime_paths(
    program_root: Path,
    data_root: Path,
    edition: str,
) -> RuntimePaths:
    resolved_program = program_root.expanduser().resolve()
    resolved_data = data_root.expanduser().resolve()
    normalized_edition = edition.strip().lower()
    if not normalized_edition:
        raise ValueError("Hstar edition must not be empty")

    config_dir = resolved_data / "config"
    project_dir = resolved_data / "projects"
    return RuntimePaths(
        program_root=resolved_program,
        data_root=resolved_data,
        edition=normalized_edition,
        static_dir=resolved_program / "static",
        builtin_workflow_dir=resolved_program / "workflows",
        api_defaults_dir=resolved_program / "API" / "defaults",
        config_dir=config_dir,
        secrets_dir=resolved_data / "secrets",
        project_dir=project_dir,
        canvas_dir=project_dir / "canvases",
        openshop_dir=project_dir / "openshop",
        director_dir=project_dir / "director",
        asset_dir=resolved_data / "assets",
        output_dir=resolved_data / "outputs",
        history_dir=resolved_data / "history",
        model_dir=resolved_data / "models",
        cache_dir=resolved_data / "cache",
        log_dir=resolved_data / "logs",
        backup_dir=resolved_data / "backups",
        temp_dir=resolved_data / "temp",
        user_workflow_dir=config_dir / "workflows",
    )
