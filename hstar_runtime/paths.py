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


def _has_canvas_records(directory: Path) -> bool:
    try:
        return directory.is_dir() and any(directory.glob("*.json"))
    except OSError:
        return False


def _has_files(directory: Path, pattern: str = "*") -> bool:
    try:
        return directory.is_dir() and any(
            path.is_file() for path in directory.rglob(pattern)
        )
    except OSError:
        return False


def uses_existing_legacy_storage_layout(paths: RuntimePaths) -> bool:
    legacy_data_dir = paths.data_root / "data"
    legacy_canvas_dir = legacy_data_dir / "canvases"
    legacy_files = (
        legacy_data_dir / "software_settings.json",
        legacy_data_dir / "projects.json",
        legacy_data_dir / "asset_library.json",
        legacy_data_dir / "prompt_libraries.json",
        legacy_data_dir / "api_providers.json",
        legacy_data_dir / "runninghub_workflows.json",
        legacy_data_dir / "shared_folders.json",
        paths.data_root / "global_config.json",
        paths.data_root / "history.json",
    )
    return (
        _has_canvas_records(legacy_canvas_dir)
        or any(path.is_file() for path in legacy_files)
        or _has_files(legacy_data_dir / "conversations", "*.json")
        or _has_files(legacy_data_dir / "openshop")
        or _has_files(paths.data_root / "output")
    )


def has_existing_hstar_storage(paths: RuntimePaths) -> bool:
    if uses_existing_legacy_storage_layout(paths):
        return True
    modern_files = (
        paths.config_dir / "software-settings.json",
        paths.config_dir / "global-config.json",
        paths.config_dir / "api-providers.user.json",
        paths.history_dir / "generations.json",
    )
    modern_directories = (
        paths.canvas_dir,
        paths.openshop_dir,
        paths.director_dir,
        paths.asset_dir,
        paths.output_dir,
        paths.model_dir,
    )
    return any(path.is_file() for path in modern_files) or any(
        _has_files(path) for path in modern_directories
    )


def build_storage_path_map(
    paths: RuntimePaths,
    *,
    prefer_existing_legacy: bool = False,
) -> dict[str, Path]:
    root = paths.data_root
    assets_dir = root / "assets"
    if prefer_existing_legacy and uses_existing_legacy_storage_layout(paths):
        data_dir = root / "data"
        return {
            "storage_root": root,
            "data_dir": data_dir,
            "conversation_dir": data_dir / "conversations",
            "canvas_dir": data_dir / "canvases",
            "openshop_data_dir": data_dir / "openshop",
            "media_preview_dir": data_dir / "media_previews",
            "asset_library_path": data_dir / "asset_library.json",
            "prompt_library_path": data_dir / "prompt_libraries.json",
            "api_providers_file": data_dir / "api_providers.json",
            "runninghub_workflow_store_file": data_dir / "runninghub_workflows.json",
            "shared_folders_file": data_dir / "shared_folders.json",
            "software_settings_file": data_dir / "software_settings.json",
            "global_config_file": root / "global_config.json",
            "history_file": root / "history.json",
            "assets_dir": assets_dir,
            "output_dir": root / "output",
            "output_input_dir": assets_dir / "input",
            "output_output_dir": assets_dir / "output",
            "asset_library_dir": assets_dir / "library",
            "local_upload_dir": assets_dir / "uploads",
        }

    return {
        "storage_root": root,
        "data_dir": paths.config_dir,
        "conversation_dir": paths.history_dir / "conversations",
        "canvas_dir": paths.canvas_dir,
        "openshop_data_dir": paths.openshop_dir,
        "media_preview_dir": paths.cache_dir / "media-previews",
        "asset_library_path": paths.config_dir / "asset-library.json",
        "prompt_library_path": paths.config_dir / "prompt-libraries.json",
        "api_providers_file": paths.config_dir / "api-providers.user.json",
        "runninghub_workflow_store_file": paths.config_dir / "runninghub-workflows.json",
        "shared_folders_file": paths.config_dir / "shared-folders.json",
        "software_settings_file": paths.config_dir / "software-settings.json",
        "global_config_file": paths.config_dir / "global-config.json",
        "history_file": paths.history_dir / "generations.json",
        "assets_dir": assets_dir,
        "output_dir": paths.output_dir,
        "output_input_dir": assets_dir / "input",
        "output_output_dir": paths.output_dir / "generated",
        "asset_library_dir": assets_dir / "library",
        "local_upload_dir": assets_dir / "uploads",
    }


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
