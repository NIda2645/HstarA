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
    canvas_dir = Path(data_dir) / "canvases"
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)
    owner_a = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-a"}
    owner_b = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-b"}
    wrong_owner_a = {**owner_a, "canvasType": "smart"}

    created = store.initialize("project-a", owner_a, {"width": 1920, "height": 1080})
    assert created["schemaVersion"] == 1
    assert created["projectId"] == "project-a"
    assert created["owner"] == owner_a
    assert created["document"]["width"] == 1920
    assert created["autosaveVersion"] == 1
    assert created["aiReferenceRecords"] == []
    assert created["aiPendingResults"] == []

    upload_owner = {
        **owner_a,
        "canvasId": "canvas-upload-reference",
        "nodeId": "node-upload-reference",
    }
    upload_project = store.initialize(
        "project-upload-reference", upload_owner, {"width": 8, "height": 6}
    )
    uploaded_source_data = png_bytes((61, 137, 203, 255))
    uploaded_source = store.store_image(
        "project-upload-reference", upload_owner, uploaded_source_data,
        "image/png", "uploaded-source.png", "source",
    )
    uploaded_project = store.load("project-upload-reference", upload_owner)
    assert uploaded_project["autosaveVersion"] == upload_project["autosaveVersion"] == 1
    assert store.collect_garbage() == []
    assert uploaded_project["assetRefs"] == [uploaded_source["assetId"]]
    uploaded_source_path, _ = store.asset_path(uploaded_source["assetId"])
    assert Path(uploaded_source_path).read_bytes() == uploaded_source_data

    saved_without_upload = store.save(
        "project-upload-reference", upload_owner, upload_project, base_version=1
    )
    assert saved_without_upload["assetRefs"] == []
    assert saved_without_upload["autosaveVersion"] == 2
    assert store.collect_garbage() == [uploaded_source["assetId"]]
    try:
        store.asset_path(uploaded_source["assetId"])
        raise AssertionError("asset omitted by a later project save should be removed")
    except OpenShopNotFound:
        pass

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
        store.load("project-a", wrong_owner_a)
        raise AssertionError("cross-node access should fail")
    except OpenShopOwnershipError:
        pass

    try:
        store.save("project-a", owner_a, saved, base_version=1)
        raise AssertionError("stale save should fail")
    except OpenShopVersionConflict:
        pass

    clone = store.clone("project-a", owner_a, "project-b", owner_b)
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

    project_a_path = canvas_dir / "canvas-a.openshop" / "node-a" / "project.json"
    project_b_path = canvas_dir / "canvas-a.openshop" / "node-b" / "project.json"
    assert project_a_path.is_file()
    assert project_b_path.is_file()
    assert not (Path(data_dir) / "projects" / "project-a.json").exists()
    assert not (Path(data_dir) / "projects" / "project-b.json").exists()
    assert json.loads(project_a_path.read_text(encoding="utf-8"))["layers"][0]["name"] == "\u6807\u9898"
    assert json.loads(project_b_path.read_text(encoding="utf-8"))["layers"][0]["name"] == "\u526f\u672c\u6807\u9898"

    assert store.delete("project-a", owner_a) is True
    assert not project_a_path.exists()
    assert project_b_path.is_file()
    assert store.load("project-b", owner_b)["layers"][0]["name"] == "\u526f\u672c\u6807\u9898"
    asset_path, asset_meta = store.asset_path(first_asset["assetId"])
    assert Path(asset_path).is_file()
    assert asset_meta["mime"] == "image/png"
    assert store.collect_garbage() == []

    assert store.delete("project-b", owner_b) is True
    assert not project_b_path.exists()
    assert not (canvas_dir / "canvas-a.openshop").exists()
    assert store.collect_garbage([first_asset["assetId"]]) == []
    asset_path, _ = store.asset_path(first_asset["assetId"])
    assert Path(asset_path).is_file()
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
    assert store.delete("project-invalid", owner_a) is True

    secret_project = store.initialize("project-secret", owner_a, {"width": 640, "height": 480})
    secret_project["aiToolPreferences"] = {"apiKey": {"unexpected": "nested-secret"}}
    try:
        store.save("project-secret", owner_a, secret_project, base_version=1)
        raise AssertionError("structured API credentials should be rejected")
    except OpenShopValidationError:
        pass
    assert store.delete("project-secret", owner_a) is True

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

    generation_owner = {"canvasType": "smart", "canvasId": "canvas-generation", "nodeId": "node-generation"}
    generation_clone_owner = {**generation_owner, "nodeId": "node-generation-clone"}
    generation = store.initialize(
        "project-generation", generation_owner, {"width": 8, "height": 6}
    )
    generation_source = store.store_image(
        "project-generation", generation_owner, png_bytes((10, 20, 30, 255)),
        "image/png", "generation-source.png", "ai-source",
    )
    generation_mask = store.store_image(
        "project-generation", generation_owner, png_bytes((255, 255, 255, 255)),
        "image/png", "generation-mask.png", "ai-mask",
    )
    generation_result = store.store_image(
        "project-generation", generation_owner, png_bytes((200, 30, 50, 120)),
        "image/png", "generation-result.png", "ai-output",
    )
    primary_reference = {
        "assetId": generation_source["assetId"],
        "alias": "参考图1",
        "mention": "@参考图1",
        "sourceType": "primary",
        "order": 0,
        "width": 8,
        "height": 6,
    }
    snapshot = {
        "toolId": "local-redraw",
        "sourceAssetId": generation_source["assetId"],
        "maskAssetId": generation_mask["assetId"],
        "primaryReferenceAssetId": generation_source["assetId"],
        "references": [primary_reference],
        "prompt": "修改选区",
        "size": "auto",
        "quality": "high",
        "targetCount": 2,
        "originalTargetCount": 2,
        "requestedIndexes": [0, 1],
        "referenceMode": "full",
        "sourceLayerId": "source-layer",
        "sourceLayerIndex": 0,
        "document": {"width": 8, "height": 6, "layerVersion": 4, "visibleCompositeVersion": 9},
        "selection": {"x": 1, "y": 1, "width": 4, "height": 3, "feather": 0},
    }
    generation["layers"] = [{
        "layerId": "generated-layer",
        "name": "局部重绘 1/2",
        "assetRef": generation_result["assetId"],
        "hstarAiGeneration": {
            "taskId": "openshop_ai_parent",
            "childTaskId": "openshop_ai_child_0",
            "toolId": "local-redraw",
            "sourceLayerId": "source-layer",
            "references": [primary_reference],
        },
    }]
    generation["aiToolPreferences"] = {
        "local-redraw": {
            "toolId": "local-redraw",
            "mode": "project",
            "apiConfigId": "vision",
            "modelId": "gemini-3-pro-image",
            "size": "auto",
            "quality": "high",
            "count": 4,
            "referenceMode": "full",
            "lastSelectionTool": "lasso",
        }
    }
    generation["aiReferenceRecords"] = [primary_reference]
    generation["aiTaskRecords"] = [{
        "taskId": "openshop_ai_parent",
        "kind": "parent",
        "toolId": "local-redraw",
        "apiConfigId": "vision",
        "modelId": "gemini-3-pro-image",
        "status": "partial",
        "targetCount": 2,
        "completedCount": 1,
        "failedCount": 1,
        "retryOfTaskId": "",
        "snapshot": snapshot,
        "children": [{
            "childTaskId": "openshop_ai_child_0",
            "index": 0,
            "status": "succeeded",
            "outputAssetId": generation_result["assetId"],
            "result": {
                "assetId": generation_result["assetId"],
                "url": f"/api/openshop/assets/{generation_result['assetId']}",
                "name": "generation-result.png",
                "width": 8,
                "height": 6,
                "mime": "image/png",
            },
            "error": "",
        }, {
            "childTaskId": "openshop_ai_child_1",
            "index": 1,
            "status": "failed",
            "outputAssetId": "",
            "error": "upstream failed",
        }],
        "createdAt": 1,
        "updatedAt": 2,
        "completedAt": 2,
        "error": "",
    }]
    generation["aiPendingResults"] = [{
        "taskId": "openshop_ai_parent",
        "childTaskId": "openshop_ai_child_0",
        "assetId": generation_result["assetId"],
        "sourceLayerId": "deleted-layer",
        "index": 0,
    }]
    generation["assetRefs"] = []
    saved_generation = store.save(
        "project-generation", generation_owner, generation, base_version=1
    )
    assert saved_generation["aiToolPreferences"]["local-redraw"]["count"] == 4
    assert saved_generation["aiToolPreferences"]["local-redraw"]["lastSelectionTool"] == "lasso"
    assert saved_generation["aiReferenceRecords"][0]["mention"] == "@参考图1"
    assert saved_generation["aiTaskRecords"][0]["kind"] == "parent"
    assert saved_generation["aiPendingResults"][0]["assetId"] == generation_result["assetId"]
    assert set(saved_generation["assetRefs"]) == {
        generation_source["assetId"], generation_mask["assetId"], generation_result["assetId"],
    }

    generation_clone = store.clone(
        "project-generation", generation_owner,
        "project-generation-clone", generation_clone_owner,
    )
    assert generation_clone["layers"][0]["name"] == "局部重绘 1/2"
    assert generation_clone["aiReferenceRecords"] == []
    assert generation_clone["aiTaskRecords"] == []
    assert generation_clone["aiPendingResults"] == []

    invalid_seed = copy.deepcopy(saved_generation)
    invalid_seed["aiToolPreferences"]["local-redraw"]["seed"] = 123
    try:
        store.save("project-generation", generation_owner, invalid_seed, base_version=2)
        raise AssertionError("seed fields should be rejected")
    except OpenShopValidationError:
        pass

    assert not list(Path(data_dir).rglob("*.tmp"))


with tempfile.TemporaryDirectory(prefix="hstara-openshop-migration-") as data_dir:
    root = Path(data_dir)
    canvas_dir = root / "canvases"
    legacy_dir = root / "projects"
    legacy_dir.mkdir(parents=True)
    owner = {"canvasType": "classic", "canvasId": "canvas-migrate", "nodeId": "node-old"}
    wrong_owner = {**owner, "canvasType": "smart"}
    legacy_project = {
        "schemaVersion": 1,
        "projectId": "project-old",
        "owner": owner,
        "document": {"width": 640, "height": 480, "resolution": 72, "colorSpace": "srgb"},
        "editor": {"objects": [{"type": "i-text", "text": "legacy marker"}]},
        "layers": [{"layerId": "legacy-layer", "name": "Legacy Layer"}],
        "sourceBindings": [],
        "fontRefs": [],
        "aiToolPreferences": {},
        "aiReferenceRecords": [],
        "aiTaskRecords": [],
        "aiPendingResults": [],
        "assetRefs": [],
        "previewAssetId": "",
        "autosaveVersion": 7,
        "exportRecords": [],
        "createdAt": 1000,
        "updatedAt": 2000,
    }
    legacy_path = legacy_dir / "project-old.json"
    legacy_path.write_text(json.dumps(legacy_project, ensure_ascii=False), encoding="utf-8")
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)

    try:
        store.load("project-old", wrong_owner)
        raise AssertionError("legacy migration must reject a mismatched owner")
    except OpenShopOwnershipError:
        pass
    sidecar = canvas_dir / "canvas-migrate.openshop" / "node-old" / "project.json"
    assert legacy_path.is_file()
    assert not sidecar.exists()

    migrated = store.initialize("project-old", owner, {"width": 1, "height": 1})
    assert migrated["autosaveVersion"] == 7
    assert migrated["editor"]["objects"][0]["text"] == "legacy marker"
    assert migrated["layers"][0]["name"] == "Legacy Layer"
    assert sidecar.is_file()
    assert not legacy_path.exists()
    assert store.load("project-old", owner)["layers"][0]["name"] == "Legacy Layer"

    stale_legacy = copy.deepcopy(legacy_project)
    stale_legacy["layers"][0]["name"] = "Stale Legacy Layer"
    legacy_path.write_text(json.dumps(stale_legacy, ensure_ascii=False), encoding="utf-8")
    assert store.load("project-old", owner)["layers"][0]["name"] == "Legacy Layer"
    assert legacy_path.is_file()

    legacy_target_owner = {**owner, "nodeId": "node-legacy-target"}
    legacy_target = copy.deepcopy(legacy_project)
    legacy_target["projectId"] = "project-legacy-target"
    legacy_target["owner"] = legacy_target_owner
    legacy_target["layers"][0]["name"] = "Existing Legacy Target"
    legacy_target["autosaveVersion"] = 9
    legacy_target_path = legacy_dir / "project-legacy-target.json"
    legacy_target_path.write_text(
        json.dumps(legacy_target, ensure_ascii=False),
        encoding="utf-8",
    )
    existing_target = store.clone(
        "project-old",
        owner,
        "project-legacy-target",
        legacy_target_owner,
    )
    legacy_target_sidecar = (
        canvas_dir
        / "canvas-migrate.openshop"
        / "node-legacy-target"
        / "project.json"
    )
    assert existing_target["layers"][0]["name"] == "Existing Legacy Target"
    assert existing_target["autosaveVersion"] == 9
    assert legacy_target_sidecar.is_file()
    assert not legacy_target_path.exists()

    collision_owner = {**owner, "nodeId": "node-legacy-collision"}
    wrong_collision_owner = {**collision_owner, "canvasType": "smart"}
    legacy_collision = copy.deepcopy(legacy_project)
    legacy_collision["projectId"] = "project-legacy-collision"
    legacy_collision["owner"] = collision_owner
    legacy_collision_path = legacy_dir / "project-legacy-collision.json"
    legacy_collision_path.write_text(
        json.dumps(legacy_collision, ensure_ascii=False),
        encoding="utf-8",
    )
    try:
        store.clone(
            "project-old",
            owner,
            "project-legacy-collision",
            wrong_collision_owner,
        )
        raise AssertionError("clone must reject a legacy target owned by another owner")
    except OpenShopOwnershipError:
        pass
    collision_sidecar = (
        canvas_dir
        / "canvas-migrate.openshop"
        / "node-legacy-collision"
        / "project.json"
    )
    assert legacy_collision_path.is_file()
    assert not collision_sidecar.exists()

    clone_owner = {**owner, "nodeId": "node-clone"}
    cloned = store.clone("project-old", owner, "project-clone", clone_owner)
    assert cloned["owner"] == clone_owner
    assert cloned["layers"][0]["name"] == "Legacy Layer"

    forbidden_owner = {**owner, "nodeId": "node-forbidden"}
    try:
        store.clone("project-old", wrong_owner, "project-forbidden", forbidden_owner)
        raise AssertionError("clone must validate the source owner")
    except OpenShopOwnershipError:
        pass
    assert not (canvas_dir / "canvas-migrate.openshop" / "node-forbidden").exists()

    delete_owner = {**owner, "nodeId": "node-delete-coexist"}
    delete_project = store.initialize(
        "project-delete-coexist",
        delete_owner,
        {"width": 320, "height": 240},
    )
    delete_sidecar = (
        canvas_dir
        / "canvas-migrate.openshop"
        / "node-delete-coexist"
        / "project.json"
    )
    delete_legacy_path = legacy_dir / "project-delete-coexist.json"
    delete_legacy_path.write_text(
        json.dumps(delete_project, ensure_ascii=False),
        encoding="utf-8",
    )
    assert store.delete("project-delete-coexist", delete_owner) is True
    assert not delete_sidecar.exists()
    assert not delete_legacy_path.exists()
    try:
        store.load("project-delete-coexist", delete_owner)
        raise AssertionError("deleted coexistence state must not resurrect from legacy")
    except OpenShopNotFound:
        pass

    wrong_delete_owner = {**owner, "nodeId": "node-delete-wrong-owner"}
    wrong_delete_project = store.initialize(
        "project-delete-wrong-owner",
        wrong_delete_owner,
        {"width": 320, "height": 240},
    )
    wrong_delete_sidecar = (
        canvas_dir
        / "canvas-migrate.openshop"
        / "node-delete-wrong-owner"
        / "project.json"
    )
    wrong_delete_legacy = copy.deepcopy(wrong_delete_project)
    wrong_delete_legacy["owner"] = {**wrong_delete_owner, "canvasType": "smart"}
    wrong_delete_legacy_path = legacy_dir / "project-delete-wrong-owner.json"
    wrong_delete_legacy_path.write_text(
        json.dumps(wrong_delete_legacy, ensure_ascii=False),
        encoding="utf-8",
    )
    try:
        store.delete("project-delete-wrong-owner", wrong_delete_owner)
        raise AssertionError("delete must reject a coexisting legacy owner mismatch")
    except OpenShopOwnershipError:
        pass
    assert wrong_delete_sidecar.is_file()
    assert wrong_delete_legacy_path.is_file()

    invalid_delete_owner = {**owner, "nodeId": "node-delete-invalid"}
    invalid_delete_project = store.initialize(
        "project-delete-invalid",
        invalid_delete_owner,
        {"width": 320, "height": 240},
    )
    invalid_delete_sidecar = (
        canvas_dir
        / "canvas-migrate.openshop"
        / "node-delete-invalid"
        / "project.json"
    )
    invalid_delete_legacy = copy.deepcopy(invalid_delete_project)
    invalid_delete_legacy["schemaVersion"] = 999
    invalid_delete_legacy_path = legacy_dir / "project-delete-invalid.json"
    invalid_delete_legacy_path.write_text(
        json.dumps(invalid_delete_legacy, ensure_ascii=False),
        encoding="utf-8",
    )
    try:
        store.delete("project-delete-invalid", invalid_delete_owner)
        raise AssertionError("delete must reject an invalid coexisting legacy manifest")
    except OpenShopValidationError:
        pass
    assert invalid_delete_sidecar.is_file()
    assert invalid_delete_legacy_path.is_file()

    assert not list(root.rglob("*.tmp"))


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
        output_data = png_bytes((190, 72, 44, 255))
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
            api_project_path = (
                Path(main.CANVAS_DIR) / f"{canvas['id']}.openshop" / "node-api" / "project.json"
            )
            assert api_project_path.is_file()
            assert not (Path(main.OPENSHOP_DATA_DIR) / "projects" / "project-api.json").exists()

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

            output_upload = await client.post(
                "/api/openshop/projects/project-api/assets",
                data={
                    "canvas_type": "classic",
                    "canvas_id": canvas["id"],
                    "node_id": "node-api",
                    "role": "output",
                },
                files={"file": ("output.png", output_data, "image/png")},
            )
            assert output_upload.status_code == 200, output_upload.text
            output_asset = output_upload.json()["asset"]
            registered_output = await client.get(
                "/api/openshop/projects/project-api",
                params={"canvas_type": "classic", "canvas_id": canvas["id"], "node_id": "node-api"},
            )
            assert registered_output.status_code == 200
            registered_project = registered_output.json()["project"]
            assert output_asset["assetId"] in registered_project["assetRefs"]
            assert registered_project["exportRecords"][-1]["assetId"] == output_asset["assetId"]

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

            clone_owner = {**owner, "nodeId": "node-api-clone"}
            rejected_clone_owner = {**owner, "nodeId": "node-api-rejected"}
            rejected_clone_path = (
                Path(main.CANVAS_DIR)
                / f"{canvas['id']}.openshop"
                / "node-api-rejected"
                / "project.json"
            )
            rejected_clone = await client.post(
                "/api/openshop/projects/project-api-rejected/clone",
                json={
                    "source_project_id": "project-api",
                    "source_owner": {**owner, "canvasType": "smart"},
                    "owner": rejected_clone_owner,
                },
            )
            assert rejected_clone.status_code == 403, rejected_clone.text
            assert not rejected_clone_path.exists()

            cloned = await client.post(
                "/api/openshop/projects/project-api-clone/clone",
                json={
                    "source_project_id": "project-api",
                    "source_owner": owner,
                    "owner": clone_owner,
                },
            )
            assert cloned.status_code == 200, cloned.text
            cloned_project = cloned.json()["project"]
            assert cloned_project["projectId"] == "project-api-clone"
            assert cloned_project["owner"] == clone_owner
            assert cloned_project["previewAssetId"] == asset["assetId"]
            clone_project_path = (
                Path(main.CANVAS_DIR)
                / f"{canvas['id']}.openshop"
                / "node-api-clone"
                / "project.json"
            )
            assert clone_project_path.is_file()

            canvas_payload = {
                "title": canvas["title"],
                "icon": canvas["icon"],
                "nodes": [{
                    "id": "node-api",
                    "type": "openshop-layered",
                    "projectId": "project-api",
                }, {
                    "id": "node-api-clone",
                    "type": "openshop-layered",
                    "projectId": "project-api-clone",
                }, {
                    "id": "output-api",
                    "type": "image",
                    "url": output_asset["url"],
                    "openshopAssetId": output_asset["assetId"],
                    "openshopSourceNodeId": "node-api",
                }],
                "connections": [],
                "viewport": {},
                "logs": [],
                "settings": {},
                "base_updated_at": canvas["updated_at"],
            }
            attached = await client.put(f"/api/canvases/{canvas['id']}", json=canvas_payload)
            assert attached.status_code == 200, attached.text
            assert api_project_path.is_file()
            assert clone_project_path.is_file()
            canvas_payload["nodes"] = [
                node for node in canvas_payload["nodes"] if node["id"] == "output-api"
            ]
            canvas_payload["base_updated_at"] = attached.json()["canvas"]["updated_at"]
            detached = await client.put(f"/api/canvases/{canvas['id']}", json=canvas_payload)
            assert detached.status_code == 200, detached.text

            missing_project = await client.get(
                "/api/openshop/projects/project-api",
                params={"canvas_type": "classic", "canvas_id": canvas["id"], "node_id": "node-api"},
            )
            assert missing_project.status_code == 404
            missing_clone = await client.get(
                "/api/openshop/projects/project-api-clone",
                params={
                    "canvas_type": "classic",
                    "canvas_id": canvas["id"],
                    "node_id": "node-api-clone",
                },
            )
            assert missing_clone.status_code == 404
            assert not api_project_path.exists()
            assert not clone_project_path.exists()
            surviving_canvas = await client.get(f"/api/canvases/{canvas['id']}")
            assert surviving_canvas.status_code == 200
            assert surviving_canvas.json()["canvas"]["nodes"] == canvas_payload["nodes"]
            assert (await client.get(asset["url"])).status_code == 404
            assert (await client.get(output_asset["url"])).status_code == 200

            canvas_payload["nodes"] = []
            canvas_payload["base_updated_at"] = detached.json()["canvas"]["updated_at"]
            removed_output = await client.put(f"/api/canvases/{canvas['id']}", json=canvas_payload)
            assert removed_output.status_code == 200, removed_output.text
            assert (await client.get(output_asset["url"])).status_code == 404

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
            soft_sidecar = (
                Path(main.CANVAS_DIR)
                / f"{smart_canvas['id']}.openshop"
                / "node-soft"
                / "project.json"
            )
            assert soft_sidecar.is_file()

            soft_deleted = await client.delete(f"/api/canvases/{smart_canvas['id']}")
            assert soft_deleted.status_code == 200
            assert soft_sidecar.is_file()
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
            assert not soft_sidecar.exists()
            assert not soft_sidecar.parent.parent.exists()
            assert not list(Path(app_root).rglob("*.tmp"))


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
