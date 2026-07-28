from __future__ import annotations

import argparse
import sys
from pathlib import Path

from hstar_runtime.api_merge import update_api_config
from hstar_runtime.paths import build_runtime_paths


class MaintenanceArgumentError(ValueError):
    pass


class MaintenanceArgumentParser(argparse.ArgumentParser):
    def error(self, message: str) -> None:
        raise MaintenanceArgumentError(message)


def _build_parser() -> argparse.ArgumentParser:
    parser = MaintenanceArgumentParser(prog="hstar-runtime-maintenance")
    commands = parser.add_subparsers(dest="command", required=True)
    update = commands.add_parser("update-api-config")
    update.add_argument("--program-root", required=True)
    update.add_argument("--data-root", required=True)
    update.add_argument("--edition", required=True)
    return parser


def _is_within(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def _validated_paths(arguments: argparse.Namespace):
    edition = str(arguments.edition or "").strip().lower()
    if edition != "windows11":
        raise MaintenanceArgumentError("unsupported edition")
    program_root = Path(arguments.program_root).expanduser().resolve()
    data_root = Path(arguments.data_root).expanduser().resolve()
    if not program_root.is_dir() or not data_root.is_dir():
        raise MaintenanceArgumentError("runtime root is missing")
    if _is_within(data_root, program_root) or _is_within(program_root, data_root):
        raise MaintenanceArgumentError("program and data roots overlap")
    paths = build_runtime_paths(program_root, data_root, edition)
    defaults_file = paths.api_defaults_dir / "api-providers.json"
    if not defaults_file.is_file():
        raise MaintenanceArgumentError("API defaults are missing")
    return paths, defaults_file


def main(argv: list[str] | None = None) -> int:
    try:
        arguments = _build_parser().parse_args(argv)
        paths, defaults_file = _validated_paths(arguments)
    except (MaintenanceArgumentError, OSError, ValueError):
        print("维护命令参数无效。")
        return 2

    try:
        result = update_api_config(
            paths.config_dir / "api-providers.user.json",
            defaults_file,
            paths.backup_dir,
        )
    except Exception:
        print("API 配置更新失败，已保留原配置。")
        return 3

    print(
        "API 配置更新完成，"
        f"已更新 {result.official_provider_count} 个官方平台，"
        f"共保留 {result.provider_count} 个平台。"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
