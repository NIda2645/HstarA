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
const probeFailures = [];
for (const candidate of candidates) {
  const probe = spawnSync(
    candidate.command,
    [...candidate.args, '-X', 'utf8', '-c', 'import os, sys; sys.path.insert(0, os.getcwd()); import PIL'],
    { cwd: repoRoot, encoding: 'utf8', env: pythonEnv, timeout: 20_000 },
  );
  if (!probe.error && probe.status === 0) {
    python = candidate;
    break;
  }
  probeFailures.push(
    `${candidate.command}: ${probe.error?.message || probe.stderr || `exit ${probe.status}`}`.trim(),
  );
}

assert.ok(
  python,
  `No usable Python interpreter with Pillow was found:\n${probeFailures.join('\n')}`,
);

const harness = String.raw`
import copy
import asyncio
import io
import json
import os
import sys
import tempfile
from pathlib import Path

import httpx
from PIL import Image

sys.path.insert(0, os.getcwd())

from openshop_projects import (
    OpenShopNotFound,
    OpenShopOwnershipError,
    OpenShopProjectStore,
    OpenShopValidationError,
    OpenShopVersionConflict,
)


def png_bytes(color):
    output = io.BytesIO()
    Image.new("RGBA", (8, 6), color).save(output, format="PNG")
    return output.getvalue()


with tempfile.TemporaryDirectory(prefix="hstara-openshop-store-") as data_dir:
    store = OpenShopProjectStore(data_dir)
    owner_a = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-a"}
    owner_b = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-b"}

    created = store.initialize("project-a", owner_a, {"width": 1920, "height": 1080})
    assert created["schemaVersion"] == 1
    assert created["projectId"] == "project-a"
    assert created["owner"] == owner_a
    assert created["document"]["width"] == 1920
    assert created["autosaveVersion"] == 1

    first_asset = store.store_image(
        "project-a", owner_a, png_bytes((22, 91, 180, 255)), "image/png", "source.png", "source"
    )
    duplicate_asset = store.store_image(
        "project-a", owner_a, png_bytes((22, 91, 180, 255)), "image/png", "copy.png", "preview"
    )
    assert first_asset["assetId"] == duplicate_asset["assetId"]
    assert first_asset["size"] == duplicate_asset["size"]
    assert first_asset["width"] == 8
    assert first_asset["height"] == 6

    updated = copy.deepcopy(created)
    updated["layers"] = [{"layerId": "layer-a", "name": "标题", "assetRef": first_asset["assetId"]}]
    updated["assetRefs"] = [first_asset["assetId"]]
    updated["previewAssetId"] = first_asset["assetId"]
    updated["fontRefs"] = [{"family": "Microsoft YaHei UI", "status": "available"}]
    updated["aiToolPreferences"] = {
        "text-extract": {
            "toolId": "text-extract", "mode": "project",
            "apiConfigId": "vision", "modelId": "gemini-3.1-pro-high",
        }
    }
    updated["aiTaskRecords"] = [{
        "taskId": "task-source-running", "toolId": "text-extract",
        "apiConfigId": "vision", "modelId": "gemini-3.1-pro-high",
        "status": "running", "mode": "layer",
        "sourceAssetId": first_asset["assetId"], "maskAssetId": "", "outputAssetId": "",
        "createdAt": 1, "updatedAt": 1, "completedAt": 0, "appliedAt": 0, "error": "",
    }]
    saved = store.save("project-a", owner_a, updated, base_version=1)
    assert saved["autosaveVersion"] == 2
    assert saved["layers"][0]["name"] == "标题"

    try:
        store.load("project-a", owner_b)
        raise AssertionError("cross-node access should fail")
    except OpenShopOwnershipError:
        pass

    try:
        store.save("project-a", owner_a, saved, base_version=1)
        raise AssertionError("stale save should fail")
    except OpenShopVersionConflict:
        pass

    clone = store.clone("project-a", "project-b", owner_b)
    assert clone["projectId"] == "project-b"
    assert clone["owner"] == owner_b
    assert clone["autosaveVersion"] == 1
    assert clone["layers"][0]["name"] == "标题"
    assert clone["assetRefs"] == [first_asset["assetId"]]
    assert clone["fontRefs"] == saved["fontRefs"]
    assert clone["aiToolPreferences"] == saved["aiToolPreferences"]
    assert clone["aiTaskRecords"] == []

    clone_update = copy.deepcopy(clone)
    clone_update["layers"][0]["name"] = "副本标题"
    store.save("project-b", owner_b, clone_update, base_version=1)
    assert store.load("project-a", owner_a)["layers"][0]["name"] == "标题"
    assert store.load("project-b", owner_b)["layers"][0]["name"] == "副本标题"

    assert store.delete("project-a", owner_a) is True
    asset_path, asset_meta = store.asset_path(first_asset["assetId"])
    assert Path(asset_path).is_file()
    assert asset_meta["mime"] == "image/png"
    assert store.collect_garbage() == []

    assert store.delete("project-b", owner_b) is True
    removed = store.collect_garbage()
    assert removed == [first_asset["assetId"]]
    try:
        store.asset_path(first_asset["assetId"])
        raise AssertionError("unreferenced asset should be removed")
    except OpenShopNotFound:
        pass

    invalid = store.initialize("project-invalid", owner_a, {"width": 640, "height": 480})
    invalid["editor"] = {"objects": [{"src": "data:image/png;base64,AAAA"}]}
    try:
        store.save("project-invalid", owner_a, invalid, base_version=1)
        raise AssertionError("inline image data should be rejected")
    except OpenShopValidationError:
        pass

    secret_project = store.initialize("project-secret", owner_a, {"width": 640, "height": 480})
    secret_project["aiToolPreferences"] = {"apiKey": {"unexpected": "nested-secret"}}
    try:
        store.save("project-secret", owner_a, secret_project, base_version=1)
        raise AssertionError("structured API credentials should be rejected")
    except OpenShopValidationError:
        pass

    metadata_project = store.initialize("project-metadata", owner_a, {"width": 640, "height": 480})
    metadata_asset = store.store_image(
        "project-metadata", owner_a, png_bytes((120, 40, 210, 255)), "image/png", "ai-output.png", "ai-output"
    )
    source_asset_id = metadata_asset["assetId"]
    metadata_project["fontRefs"] = [
        {"family": "Microsoft YaHei UI", "status": "available"},
        {"family": "Missing Poster Font", "status": "missing"},
    ]
    metadata_project["aiToolPreferences"] = {
        "text-extract": {
            "toolId": "text-extract",
            "mode": "project",
            "apiConfigId": "vision",
            "modelId": "gemini-3.1-pro-high",
        },
        "text-remove": {
            "toolId": "text-remove",
            "mode": "global",
            "apiConfigId": "",
            "modelId": "",
        },
    }
    metadata_project["aiTaskRecords"] = [{
        "taskId": "task-1",
        "toolId": "text-remove",
        "apiConfigId": "vision",
        "modelId": "gemini-3-pro-image",
        "status": "succeeded",
        "mode": "layer",
        "sourceAssetId": source_asset_id,
        "outputAssetId": source_asset_id,
        "createdAt": 1000,
        "updatedAt": 2000,
    }]
    metadata_project["assetRefs"] = [source_asset_id]
    saved_metadata = store.save("project-metadata", owner_a, metadata_project, base_version=1)
    assert saved_metadata["fontRefs"] == metadata_project["fontRefs"]
    assert saved_metadata["aiToolPreferences"] == metadata_project["aiToolPreferences"]
    assert saved_metadata["aiTaskRecords"][0]["outputAssetId"] == source_asset_id

    too_many_tasks = copy.deepcopy(saved_metadata)
    too_many_tasks["aiTaskRecords"] = [
        {
            "taskId": f"task-{index}",
            "toolId": "text-extract",
            "status": "cancelled",
        }
        for index in range(101)
    ]
    try:
        store.save("project-metadata", owner_a, too_many_tasks, base_version=2)
        raise AssertionError("more than 100 AI task records should be rejected")
    except OpenShopValidationError:
        pass

    invalid_font = copy.deepcopy(saved_metadata)
    invalid_font["fontRefs"] = [{"family": "x" * 121, "status": "missing"}]
    try:
        store.save("project-metadata", owner_a, invalid_font, base_version=2)
        raise AssertionError("overlong font names should be rejected")
    except OpenShopValidationError:
        pass

    invalid_task = copy.deepcopy(saved_metadata)
    invalid_task["aiTaskRecords"][0]["status"] = "ghost"
    try:
        store.save("project-metadata", owner_a, invalid_task, base_version=2)
        raise AssertionError("invalid AI task states should be rejected")
    except OpenShopValidationError:
        pass

    assert not list(Path(data_dir).rglob("*.tmp"))


async def api_lifecycle():
    with tempfile.TemporaryDirectory(prefix="hstara-openshop-api-") as app_root:
        settings_dir = Path(app_root) / "data"
        settings_dir.mkdir(parents=True, exist_ok=True)
        (settings_dir / "software_settings.json").write_text(
            json.dumps({"storage_root": app_root}),
            encoding="utf-8",
        )
        os.environ["HSTAR_DATA_DIR"] = app_root

        import main

        image_data = png_bytes((75, 161, 88, 255))
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            canvas_response = await client.post(
                "/api/canvases",
                json={"title": "OpenShop API canvas", "icon": "layers", "kind": "classic"},
            )
            assert canvas_response.status_code == 200
            canvas = canvas_response.json()["canvas"]
            owner = {"canvasType": "classic", "canvasId": canvas["id"], "nodeId": "node-api"}

            init = await client.post(
                "/api/openshop/projects/project-api/initialize",
                json={"owner": owner, "document": {"width": 1920, "height": 1080}},
            )
            assert init.status_code == 200, init.text
            project = init.json()["project"]
            assert project["autosaveVersion"] == 1

            fetched = await client.get(
                "/api/openshop/projects/project-api",
                params={"canvas_type": "classic", "canvas_id": canvas["id"], "node_id": "node-api"},
            )
            assert fetched.status_code == 200
            assert fetched.json()["project"]["projectId"] == "project-api"

            upload = await client.post(
                "/api/openshop/projects/project-api/assets",
                data={
                    "canvas_type": "classic",
                    "canvas_id": canvas["id"],
                    "node_id": "node-api",
                    "role": "source",
                },
                files={"file": ("source.png", image_data, "image/png")},
            )
            assert upload.status_code == 200, upload.text
            asset = upload.json()["asset"]
            assert asset["url"] == f"/api/openshop/assets/{asset['assetId']}"

            content = await client.get(asset["url"])
            assert content.status_code == 200
            assert content.content == image_data
            assert content.headers["content-type"].startswith("image/png")

            project["assetRefs"] = [asset["assetId"]]
            project["previewAssetId"] = asset["assetId"]
            saved = await client.put(
                "/api/openshop/projects/project-api",
                json={"owner": owner, "project": project, "base_version": 1},
            )
            assert saved.status_code == 200, saved.text
            assert saved.json()["project"]["autosaveVersion"] == 2

            conflict = await client.put(
                "/api/openshop/projects/project-api",
                json={"owner": owner, "project": project, "base_version": 1},
            )
            assert conflict.status_code == 409

            clone_owner = {**owner, "nodeId": "node-clone"}
            cloned = await client.post(
                "/api/openshop/projects/project-clone/clone",
                json={"source_project_id": "project-api", "owner": clone_owner},
            )
            assert cloned.status_code == 200, cloned.text
            assert cloned.json()["project"]["owner"] == clone_owner
            assert cloned.json()["project"]["assetRefs"] == [asset["assetId"]]

            deleted_clone = await client.delete(
                "/api/openshop/projects/project-clone",
                params={"canvas_type": "classic", "canvas_id": canvas["id"], "node_id": "node-clone"},
            )
            assert deleted_clone.status_code == 200
            assert (await client.get(asset["url"])).status_code == 200

            canvas_payload = {
                "title": canvas["title"],
                "icon": canvas["icon"],
                "nodes": [{
                    "id": "node-api",
                    "type": "openshop-layered",
                    "projectId": "project-api",
                }],
                "connections": [],
                "viewport": {},
                "logs": [],
                "settings": {},
                "base_updated_at": canvas["updated_at"],
            }
            attached = await client.put(f"/api/canvases/{canvas['id']}", json=canvas_payload)
            assert attached.status_code == 200, attached.text
            canvas_payload["nodes"] = []
            canvas_payload["base_updated_at"] = attached.json()["canvas"]["updated_at"]
            detached = await client.put(f"/api/canvases/{canvas['id']}", json=canvas_payload)
            assert detached.status_code == 200, detached.text

            missing_project = await client.get(
                "/api/openshop/projects/project-api",
                params={"canvas_type": "classic", "canvas_id": canvas["id"], "node_id": "node-api"},
            )
            assert missing_project.status_code == 404
            assert (await client.get(asset["url"])).status_code == 404

            smart_response = await client.post(
                "/api/canvases",
                json={"title": "Soft delete canvas", "icon": "sparkles", "kind": "smart"},
            )
            smart_canvas = smart_response.json()["canvas"]
            soft_owner = {
                "canvasType": "smart",
                "canvasId": smart_canvas["id"],
                "nodeId": "node-soft",
            }
            soft_init = await client.post(
                "/api/openshop/projects/project-soft/initialize",
                json={"owner": soft_owner, "document": {"width": 1280, "height": 720}},
            )
            assert soft_init.status_code == 200

            soft_deleted = await client.delete(f"/api/canvases/{smart_canvas['id']}")
            assert soft_deleted.status_code == 200
            soft_project = await client.get(
                "/api/openshop/projects/project-soft",
                params={"canvas_type": "smart", "canvas_id": smart_canvas["id"], "node_id": "node-soft"},
            )
            assert soft_project.status_code == 200

            purged = await client.delete(f"/api/canvases/{smart_canvas['id']}/purge")
            assert purged.status_code == 200
            purged_project = await client.get(
                "/api/openshop/projects/project-soft",
                params={"canvas_type": "smart", "canvas_id": smart_canvas["id"], "node_id": "node-soft"},
            )
            assert purged_project.status_code == 404


asyncio.run(api_lifecycle())
print(json.dumps({"ok": True, "assetId": first_asset["assetId"]}, ensure_ascii=False))
`;

const harnessDir = mkdtempSync(join(tmpdir(), 'hstara-openshop-storage-test-'));
const harnessPath = join(harnessDir, 'storage_harness.py');
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
assert.match(result.stdout, /"ok": true/);
console.log('OpenShop project storage tests passed');
