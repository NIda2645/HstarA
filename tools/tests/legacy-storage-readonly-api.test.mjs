import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const pythonEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};
const candidates = process.platform === 'win32'
  ? [
      ...[join(repoRoot, 'python', 'python.exe')]
        .filter(existsSync)
        .map((command) => ({ command, args: [] })),
      { command: 'py', args: ['-3'] },
      { command: 'python', args: [] },
    ]
  : [
      ...[join(repoRoot, 'python', 'bin', 'python3'), join(repoRoot, 'python', 'bin', 'python')]
        .filter(existsSync)
        .map((command) => ({ command, args: [] })),
      { command: 'python3', args: [] },
      { command: 'python', args: [] },
    ];

let python;
for (const candidate of candidates) {
  const probe = spawnSync(
    candidate.command,
    [...candidate.args, '-X', 'utf8', '-c', 'import httpx'],
    { cwd: repoRoot, encoding: 'utf8', env: pythonEnv, timeout: 20_000 },
  );
  if (!probe.error && probe.status === 0) {
    python = candidate;
    break;
  }
}
assert.ok(python, 'a Python interpreter with httpx is required');

const harness = String.raw`
import asyncio
import base64
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

import httpx

sys.path.insert(0, os.getcwd())


def snapshot(root):
    result = {}
    for path in sorted(root.rglob("*"), key=lambda item: str(item).lower()):
        relative = path.relative_to(root).as_posix()
        if path.is_dir():
            result[relative] = {"type": "directory"}
        elif path.is_file():
            content = path.read_bytes()
            result[relative] = {
                "type": "file",
                "size": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            }
    return result


async def run():
    with tempfile.TemporaryDirectory(prefix="hstara-legacy-readonly-") as app_root:
        root = Path(app_root)
        data_dir = root / "data"
        canvas_dir = data_dir / "canvases"
        canvas_dir.mkdir(parents=True)
        (data_dir / "openshop").mkdir()
        legacy_openshop_projects = data_dir / "openshop" / "projects"
        legacy_openshop_projects.mkdir()
        legacy_conversation_dir = data_dir / "conversations" / "legacy-user"
        legacy_conversation_dir.mkdir(parents=True)
        (root / "assets" / "input").mkdir(parents=True)
        (root / "assets" / "output").mkdir()
        (root / "assets" / "library").mkdir()
        (root / "assets" / "uploads").mkdir()
        (root / "output").mkdir()

        canvas = {
            "id": "legacy-canvas-1",
            "title": "Existing legacy canvas",
            "icon": "layers",
            "kind": "classic",
            "project": "legacy-project",
            "created_at": 100,
            "updated_at": 200,
            "nodes": [{
                "id": "openshop-node-1",
                "type": "openshop-layered",
                "projectId": "legacy-openshop-project",
            }],
            "connections": [],
        }
        canvas_file = canvas_dir / "legacy-canvas-1.json"
        canvas_file.write_text(json.dumps(canvas, ensure_ascii=False), encoding="utf-8")
        legacy_conversation_file = legacy_conversation_dir / "legacy-conversation.json"
        legacy_conversation_file.write_text(json.dumps({
            "id": "legacy-conversation",
            "title": "Legacy conversation",
            "created_at": 100,
            "updated_at": 200,
            "messages": [],
        }), encoding="utf-8")
        legacy_openshop_file = legacy_openshop_projects / "legacy-openshop-project.json"
        legacy_openshop_file.write_text(json.dumps({
            "schemaVersion": 1,
            "projectId": "legacy-openshop-project",
            "owner": {
                "canvasType": "classic",
                "canvasId": "legacy-canvas-1",
                "nodeId": "openshop-node-1",
            },
            "document": {"width": 1200, "height": 1600, "background": "#ffffff"},
            "editor": {"objects": []},
            "layers": [],
            "sourceBindings": [],
            "fontRefs": [],
            "aiToolPreferences": {},
            "aiReferenceRecords": [],
            "aiTaskRecords": [],
            "aiPendingResults": [],
            "assetRefs": [],
            "pendingAssetRefs": [],
            "previewAssetId": "",
            "autosaveVersion": 1,
            "exportRecords": [],
            "createdAt": 100,
            "updatedAt": 200,
        }), encoding="utf-8")
        legacy_history_file = root / "history.json"
        legacy_history_file.write_text(json.dumps([{
            "id": "legacy-history",
            "type": "zimage",
            "timestamp": 100,
            "images": ["/output/legacy-output.txt"],
        }]), encoding="utf-8")
        legacy_output_file = root / "output" / "legacy-output.txt"
        legacy_output_file.write_text("legacy output", encoding="utf-8")
        legacy_png_file = root / "output" / "legacy-image.png"
        legacy_png_file.write_bytes(base64.b64decode(
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
        ))
        legacy_preview_dir = data_dir / "media_previews"
        legacy_preview_dir.mkdir()
        legacy_png_stat = legacy_png_file.stat()
        legacy_preview_key = hashlib.sha1(
            f"{os.path.abspath(legacy_png_file)}|{legacy_png_stat.st_mtime_ns}|{legacy_png_stat.st_size}|480".encode(
                "utf-8", "ignore"
            )
        ).hexdigest()
        legacy_preview_file = legacy_preview_dir / f"{legacy_preview_key}.webp"
        legacy_preview_file.write_bytes(b"legacy preview")
        legacy_global_config_file = root / "global_config.json"
        legacy_global_config_file.write_text(
            json.dumps({"modelscope_token": "legacy-token"}),
            encoding="utf-8",
        )
        legacy_shared_folders_file = data_dir / "shared_folders.json"
        legacy_shared_folders_file.write_text(
            json.dumps({"folders": [{"id": "legacy-folder", "name": "Legacy folder"}]}),
            encoding="utf-8",
        )
        legacy_runninghub_file = data_dir / "runninghub_workflows.json"
        legacy_runninghub_file.write_text(
            json.dumps({"legacy-workflow": {"title": "Legacy workflow"}}),
            encoding="utf-8",
        )
        legacy_api_providers_file = data_dir / "api_providers.json"
        legacy_api_providers_file.write_text(json.dumps([{
            "id": "legacy-provider",
            "name": "Legacy provider",
            "base_url": "https://legacy.invalid",
            "protocol": "openai",
            "enabled": True,
        }]), encoding="utf-8")
        legacy_asset_library_file = data_dir / "asset_library.json"
        legacy_asset_categories = [
            {"id": "characters", "name": "Legacy characters", "type": "image", "items": []},
            {"id": "scenes", "name": "Legacy scenes", "type": "image", "items": []},
            {"id": "workflows", "name": "Legacy workflows", "type": "workflow", "items": []},
        ]
        legacy_asset_library_file.write_text(json.dumps({
            "active_library_id": "default",
            "libraries": [{
                "id": "default",
                "name": "Legacy asset library",
                "type": "asset",
                "categories": legacy_asset_categories,
            }],
            "categories": legacy_asset_categories,
            "updated_at": 100,
        }), encoding="utf-8")
        legacy_prompt_library_file = data_dir / "prompt_libraries.json"
        legacy_prompt_library_file.write_text(json.dumps({
            "active_library_id": "legacy-prompts",
            "libraries": [{
                "id": "legacy-prompts",
                "name": "Legacy prompt library",
                "type": "prompt",
                "items": [],
                "categories": [],
            }],
            "updated_at": 100,
        }), encoding="utf-8")
        legacy_settings_file = data_dir / "software_settings.json"
        legacy_settings_file.write_text(
            json.dumps({"storage_root": app_root, "legacy_marker": "legacy"}),
            encoding="utf-8",
        )
        (data_dir / "projects.json").write_text(
            json.dumps({"projects": [
                {"id": "default", "name": "Default", "order": 0},
                {"id": "legacy-project", "name": "Legacy project", "order": 1},
            ]}),
            encoding="utf-8",
        )
        external_appdata = root / "external-appdata"
        external_settings = external_appdata / "Hstar" / "data" / "software_settings.json"
        external_settings.parent.mkdir(parents=True)
        external_settings.write_text(
            json.dumps({"storage_root": "must-not-be-copied"}),
            encoding="utf-8",
        )

        before = snapshot(root)
        os.environ.update({
            "HSTAR_DATA_DIR": app_root,
            "HSTAR_EDITION": "development",
            "HSTAR_PROGRAM_DIR": os.getcwd(),
            "HSTAR_SHELL_TOKEN": "T" * 64,
            "HSTAR_VOICE_TEST_MODE": "1",
            "APPDATA": str(external_appdata),
        })

        import main

        assert main.PRESERVE_EXISTING_DATA_ON_STARTUP is True
        assert Path(main.CANVAS_DIR) == root / "projects" / "canvases"
        assert Path(main.SOFTWARE_SETTINGS_FILE) == root / "config" / "software-settings.json"
        assert not Path(main.SOFTWARE_SETTINGS_FILE).exists()

        with patch.object(main, "sync_static_html_versions", lambda: None):
            await main.startup_event()

        transport = httpx.ASGITransport(app=main.app, client=("127.0.0.1", 51100))
        headers = {main.SHELL_TOKEN_HEADER: main.SHELL_TOKEN}
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
            headers=headers,
        ) as client:
            settings_response = await client.get("/api/software-settings")
            canvases_response = await client.get("/api/canvases")
            projects_response = await client.get("/api/projects")
            conversations_response = await client.get(
                "/api/conversations",
                headers={**headers, "x-user-id": "legacy-user"},
            )
            history_response = await client.get("/api/history")
            output_response = await client.get("/output/legacy-output.txt")
            preview_response = await client.get(
                "/api/media-preview",
                params={"url": "/output/legacy-image.png", "w": 480},
            )
            missing_asset_response = await client.get("/assets/missing.png")
            token_response = await client.get("/api/config/token")

            legacy_openshop_before = legacy_openshop_file.read_bytes()
            legacy_openshop = main.OPENSHOP_STORE.load(
                "legacy-openshop-project",
                {
                    "canvasType": "classic",
                    "canvasId": "legacy-canvas-1",
                    "nodeId": "openshop-node-1",
                },
            )
            assert legacy_openshop["projectId"] == "legacy-openshop-project"
            assert legacy_openshop_file.read_bytes() == legacy_openshop_before
            assert not (
                canvas_dir / "legacy-canvas-1.openshop" / "openshop-node-1" / "project.json"
            ).exists()
            assert main.collect_openshop_garbage() == []
            assert not (root / "projects" / "openshop" / "assets").exists()

        assert settings_response.status_code == 200, settings_response.text
        settings = settings_response.json()["settings"]
        assert Path(settings["active_storage_root"]) == root
        assert Path(settings["active_data_dir"]) == root / "config"
        assert settings.get("legacy_marker") == "legacy"
        assert settings.get("storage_root") != "must-not-be-copied"

        assert canvases_response.status_code == 200, canvases_response.text
        canvases = canvases_response.json()["canvases"]
        assert [item["id"] for item in canvases] == ["legacy-canvas-1"]
        assert canvases[0]["node_count"] == 1

        assert projects_response.status_code == 200, projects_response.text
        assert {item["id"] for item in projects_response.json()["projects"]} == {
            "default", "legacy-project",
        }
        assert conversations_response.status_code == 200, conversations_response.text
        assert [
            item["id"] for item in conversations_response.json()["conversations"]
        ] == ["legacy-conversation"]
        assert history_response.status_code == 200, history_response.text
        assert [item["id"] for item in history_response.json()] == ["legacy-history"]
        assert output_response.status_code == 200, output_response.text
        assert output_response.text == "legacy output"
        assert preview_response.status_code == 200, preview_response.text
        assert preview_response.content == b"legacy preview"
        assert missing_asset_response.status_code == 404
        assert token_response.status_code == 200, token_response.text
        assert token_response.json()["token"] == "legacy-token"
        assert main.shared_folders_load()["folders"][0]["id"] == "legacy-folder"
        assert "legacy-workflow" in main.load_runninghub_workflow_store()
        assert any(
            item.get("id") == "legacy-provider" for item in main.load_api_providers()
        )
        assert main.load_asset_library()["libraries"][0]["name"] == "Legacy asset library"
        assert any(
            item.get("id") == "legacy-prompts"
            for item in main.load_prompt_libraries()["libraries"]
        )
        after = snapshot(root)
        assert after == before, json.dumps({
            "added": sorted(set(after) - set(before)),
            "removed": sorted(set(before) - set(after)),
            "changed": sorted(
                path for path in set(before) & set(after)
                if before[path] != after[path]
            ),
        }, ensure_ascii=False, indent=2)
        assert not (root / "config").exists()
        assert not (root / "projects").exists()

        legacy_settings_before = legacy_settings_file.read_bytes()
        legacy_history_before = legacy_history_file.read_bytes()
        legacy_shared_folders_before = legacy_shared_folders_file.read_bytes()
        legacy_runninghub_before = legacy_runninghub_file.read_bytes()
        legacy_api_providers_before = legacy_api_providers_file.read_bytes()
        legacy_asset_library_before = legacy_asset_library_file.read_bytes()
        legacy_prompt_library_before = legacy_prompt_library_file.read_bytes()
        async with httpx.AsyncClient(
            transport=transport,
            base_url="http://127.0.0.1",
            headers=headers,
        ) as write_client:
            updated_legacy = await write_client.put(
                "/api/canvases/legacy-canvas-1",
                json={
                    "title": "Updated legacy canvas",
                    "icon": "layers",
                    "nodes": [{
                        "id": "openshop-node-1",
                        "type": "openshop-layered",
                        "projectId": "legacy-openshop-project",
                    }],
                    "connections": [],
                    "viewport": {},
                    "logs": [],
                    "settings": {},
                },
            )
            assert updated_legacy.status_code == 200, updated_legacy.text
            assert json.loads(canvas_file.read_text(encoding="utf-8"))["title"] == "Updated legacy canvas"
            assert not (root / "projects" / "canvases" / "legacy-canvas-1.json").exists()

            created_canvas_response = await write_client.post(
                "/api/canvases",
                json={"title": "New protocol canvas", "icon": "layers", "kind": "smart"},
            )
            assert created_canvas_response.status_code == 200, created_canvas_response.text
            created_canvas = created_canvas_response.json()["canvas"]
            modern_canvas_file = root / "projects" / "canvases" / f"{created_canvas['id']}.json"
            assert modern_canvas_file.is_file()
            assert not (canvas_dir / f"{created_canvas['id']}.json").exists()

            legacy_conversation = main.load_conversation(
                "legacy-user", "legacy-conversation"
            )
            legacy_conversation["title"] = "Updated legacy conversation"
            main.save_conversation("legacy-user", legacy_conversation)
            assert json.loads(
                legacy_conversation_file.read_text(encoding="utf-8")
            )["title"] == "Updated legacy conversation"
            assert not (
                root / "history" / "conversations" / "legacy-user" / "legacy-conversation.json"
            ).exists()

            created_conversation_response = await write_client.post(
                "/api/conversations",
                json={"title": "New protocol conversation"},
                headers={**headers, "x-user-id": "legacy-user"},
            )
            assert created_conversation_response.status_code == 200, created_conversation_response.text
            created_conversation = created_conversation_response.json()["conversation"]
            modern_conversation_file = (
                root / "history" / "conversations" / "legacy-user"
                / f"{created_conversation['id']}.json"
            )
            assert modern_conversation_file.is_file()
            assert not (legacy_conversation_dir / f"{created_conversation['id']}.json").exists()

            created_project_response = await write_client.post(
                "/api/projects",
                json={"name": "New protocol project"},
            )
            assert created_project_response.status_code == 200, created_project_response.text
            assert (root / "config" / "projects.json").is_file()

            canvas_asset_index = main.canvas_assets_index()
            assert {item["id"] for item in canvas_asset_index["canvases"]} == {
                "legacy-canvas-1", created_canvas["id"],
            }

            delete_legacy_project_response = await write_client.delete(
                "/api/projects/legacy-project"
            )
            assert delete_legacy_project_response.status_code == 200, delete_legacy_project_response.text
            assert delete_legacy_project_response.json()["moved"] == 1
            assert json.loads(canvas_file.read_text(encoding="utf-8"))["project"] == "default"
            assert not (
                root / "projects" / "canvases" / "legacy-canvas-1.json"
            ).exists()

            merged_canvases_response = await write_client.get("/api/canvases")
            assert merged_canvases_response.status_code == 200, merged_canvases_response.text
            assert {item["id"] for item in merged_canvases_response.json()["canvases"]} == {
                "legacy-canvas-1", created_canvas["id"],
            }

            modern_openshop = main.OPENSHOP_STORE.initialize(
                "modern-openshop-project",
                {
                    "canvasType": "smart",
                    "canvasId": created_canvas["id"],
                    "nodeId": "openshop-node-2",
                },
                {"width": 1600, "height": 900, "background": "#ffffff"},
            )
            assert modern_openshop["projectId"] == "modern-openshop-project"
            assert (
                root / "projects" / "canvases"
                / f"{created_canvas['id']}.openshop" / "openshop-node-2" / "project.json"
            ).is_file()
            assert not (
                canvas_dir / f"{created_canvas['id']}.openshop"
            ).exists()

            converted_legacy_url = main.convert_output_to_jpg(
                "/output/legacy-image.png"
            )
            assert converted_legacy_url.startswith("/output/generated/")
            assert main.output_file_from_url(converted_legacy_url)
            assert not (root / "output" / "legacy-image.jpg").exists()

            png_bytes = base64.b64decode(
                "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="
            )
            legacy_asset = main.OPENSHOP_STORE.store_image(
                "legacy-openshop-project",
                {
                    "canvasType": "classic",
                    "canvasId": "legacy-canvas-1",
                    "nodeId": "openshop-node-1",
                },
                png_bytes,
                "image/png",
                "legacy.png",
                "asset",
            )
            legacy_project_with_asset = main.OPENSHOP_STORE.load(
                "legacy-openshop-project",
                {
                    "canvasType": "classic",
                    "canvasId": "legacy-canvas-1",
                    "nodeId": "openshop-node-1",
                },
            )
            legacy_project_with_asset["assetRefs"] = [legacy_asset["assetId"]]
            main.OPENSHOP_STORE.save(
                "legacy-openshop-project",
                legacy_project_with_asset["owner"],
                legacy_project_with_asset,
                legacy_project_with_asset["autosaveVersion"],
            )
            cloned_project = main.OPENSHOP_STORE.clone(
                "legacy-openshop-project",
                legacy_project_with_asset["owner"],
                "modern-cloned-project",
                {
                    "canvasType": "smart",
                    "canvasId": created_canvas["id"],
                    "nodeId": "openshop-node-3",
                },
            )
            assert cloned_project["assetRefs"] == [legacy_asset["assetId"]]
            cloned_asset_path, _ = main.PRIMARY_OPENSHOP_STORE.asset_path(
                legacy_asset["assetId"]
            )
            assert Path(cloned_asset_path).is_relative_to(
                root / "projects" / "openshop" / "assets"
            )

        legacy_openshop = main.OPENSHOP_STORE.load(
            "legacy-openshop-project",
            {
                "canvasType": "classic",
                "canvasId": "legacy-canvas-1",
                "nodeId": "openshop-node-1",
            },
        )
        legacy_openshop["document"]["width"] = 1400
        updated_legacy_openshop = main.OPENSHOP_STORE.save(
            "legacy-openshop-project",
            legacy_openshop["owner"],
            legacy_openshop,
            legacy_openshop["autosaveVersion"],
        )
        assert updated_legacy_openshop["document"]["width"] == 1400
        assert json.loads(legacy_openshop_file.read_text(encoding="utf-8"))[
            "document"
        ]["width"] == 1400
        assert not (
            canvas_dir / "legacy-canvas-1.openshop" / "openshop-node-1" / "project.json"
        ).exists()

        main.save_software_settings({"storage_root": app_root, "modern_marker": "modern"})
        modern_settings_file = root / "config" / "software-settings.json"
        assert json.loads(modern_settings_file.read_text(encoding="utf-8"))["modern_marker"] == "modern"
        assert legacy_settings_file.read_bytes() == legacy_settings_before

        main.save_to_history({
            "id": "modern-history",
            "type": "zimage",
            "images": ["/output/generated/modern.png"],
        })
        modern_history_file = root / "history" / "generations.json"
        assert [
            item["id"] for item in json.loads(modern_history_file.read_text(encoding="utf-8"))
        ] == ["modern-history", "legacy-history"]
        assert legacy_history_file.read_bytes() == legacy_history_before

        corrupt_history_bytes = b'{"truncated":'
        modern_history_file.write_bytes(corrupt_history_bytes)
        main.save_to_history({
            "id": "history-after-corruption",
            "type": "zimage",
            "images": ["/output/generated/recovered.png"],
        })
        corrupt_backups = list(
            (modern_history_file.parent / "corrupt").glob("generations.json.*.corrupt")
        )
        assert len(corrupt_backups) == 1
        assert corrupt_backups[0].read_bytes() == corrupt_history_bytes
        assert [
            item["id"] for item in json.loads(modern_history_file.read_text(encoding="utf-8"))
        ] == ["history-after-corruption"]
        assert legacy_history_file.read_bytes() == legacy_history_before

        main.shared_folders_save({"folders": [{"id": "modern-folder"}]})
        assert json.loads(
            (root / "config" / "shared-folders.json").read_text(encoding="utf-8")
        )["folders"][0]["id"] == "modern-folder"
        assert legacy_shared_folders_file.read_bytes() == legacy_shared_folders_before

        main.save_runninghub_workflow_store({"modern-workflow": {"title": "Modern workflow"}})
        assert "modern-workflow" in json.loads(
            (root / "config" / "runninghub-workflows.json").read_text(encoding="utf-8")
        )
        assert legacy_runninghub_file.read_bytes() == legacy_runninghub_before

        main.save_api_providers(main.load_api_providers())
        assert (root / "config" / "api-providers.user.json").is_file()
        assert legacy_api_providers_file.read_bytes() == legacy_api_providers_before

        main.save_asset_library(main.load_asset_library())
        assert (root / "config" / "asset-library.json").is_file()
        assert legacy_asset_library_file.read_bytes() == legacy_asset_library_before

        main.save_prompt_libraries(main.load_prompt_libraries())
        assert (root / "config" / "prompt-libraries.json").is_file()
        assert legacy_prompt_library_file.read_bytes() == legacy_prompt_library_before

        restart_code = f'''\
import os
from pathlib import Path

import main

assert main.PRESERVE_EXISTING_DATA_ON_STARTUP is True
assert Path(main.CANVAS_DIR) == Path({str(root / "projects" / "canvases")!r})
assert Path(main.LEGACY_CANVAS_DIR) == Path({str(canvas_dir)!r})
assert {{item["id"] for item in main.list_canvases()}} == {{
    "legacy-canvas-1", {created_canvas["id"]!r},
}}
assert main.OPENSHOP_STORE.load(
    "legacy-openshop-project",
    {{
        "canvasType": "classic",
        "canvasId": "legacy-canvas-1",
        "nodeId": "openshop-node-1",
    }},
)["projectId"] == "legacy-openshop-project"
assert main.OPENSHOP_STORE.load(
    "modern-openshop-project",
    {{
        "canvasType": "smart",
        "canvasId": {created_canvas["id"]!r},
        "nodeId": "openshop-node-2",
    }},
)["projectId"] == "modern-openshop-project"
'''
        restarted = subprocess.run(
            [sys.executable, "-B", "-X", "utf8", "-c", restart_code],
            cwd=os.getcwd(),
            env=os.environ.copy(),
            capture_output=True,
            text=True,
            timeout=60,
        )
        assert restarted.returncode == 0, restarted.stderr or restarted.stdout

asyncio.run(run())
print("legacy storage read-only API tests passed")
`;

const harnessDir = mkdtempSync(join(tmpdir(), 'hstara-legacy-storage-test-'));
const harnessPath = join(harnessDir, 'harness.py');
let result;
try {
  writeFileSync(harnessPath, harness, 'utf8');
  result = spawnSync(python.command, [...python.args, '-X', 'utf8', harnessPath], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: pythonEnv,
    timeout: 60_000,
  });
} finally {
  rmSync(harnessDir, { recursive: true, force: true });
}

assert.ok(!result.error, `Python harness failed to launch: ${result.error?.message}`);
assert.equal(result.status, 0, result.stderr || result.stdout);
console.log(result.stdout.trim());
