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
import multiprocessing
import os
import sys
import tempfile
import threading
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


def create_canvas_worker(canvas_id, title, start_barrier, result_queue):
    import main

    start_barrier.wait()
    try:
        canvas = main.new_canvas(
            title=title,
            icon="layers",
            kind="classic",
            canvas_id=canvas_id,
        )
    except main.HTTPException as exc:
        result_queue.put({"status": exc.status_code, "detail": exc.detail})
    else:
        result_queue.put({"status": 200, "canvas": canvas})


def assert_atomic_explicit_canvas_create(main):
    process_context = multiprocessing.get_context("spawn")
    for attempt in range(10):
        canvas_id = f"codex-e2e-openshop-cross-process-{attempt}"
        start_barrier = process_context.Barrier(2)
        result_queue = process_context.Queue()
        workers = [
            process_context.Process(
                target=create_canvas_worker,
                args=(
                    canvas_id,
                    f"Cross-process canvas {worker_index}",
                    start_barrier,
                    result_queue,
                ),
            )
            for worker_index in range(2)
        ]
        try:
            for worker in workers:
                worker.start()
            for worker in workers:
                worker.join(timeout=20)
            assert all(not worker.is_alive() for worker in workers), "canvas create worker timed out"
            assert [worker.exitcode for worker in workers] == [0, 0]
            results = [result_queue.get() for _ in workers]
        finally:
            for worker in workers:
                if worker.is_alive():
                    worker.terminate()
                worker.join(timeout=5)
            result_queue.close()

        assert sorted(result["status"] for result in results) == [200, 409], results
        winner = next(result["canvas"] for result in results if result["status"] == 200)
        saved_canvas = json.loads(
            Path(main.canvas_path(canvas_id)).read_text(encoding="utf-8")
        )
        assert saved_canvas == winner



with tempfile.TemporaryDirectory(prefix="hstara-openshop-provisional-") as data_dir:
    canvas_dir = Path(data_dir) / "canvases"
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)
    clock = {"now": 1_700_000_000_000}
    store._now = lambda: clock["now"]
    owner = {
        "canvasType": "classic",
        "canvasId": "canvas-provisional",
        "nodeId": "node-provisional",
    }
    prepared_before_upload = store.initialize(
        "project-provisional", owner, {"width": 8, "height": 6}
    )
    uploaded_source_data = png_bytes((61, 137, 203, 255))
    uploaded_source = store.store_image(
        "project-provisional", owner, uploaded_source_data,
        "image/png", "uploaded-source.png", "source",
    )
    uploaded_project = store.load("project-provisional", owner)
    assert uploaded_project["assetRefs"] == []
    expected_pending = [{
        "assetId": uploaded_source["assetId"],
        "expiresAt": clock["now"] + store.PENDING_ASSET_REF_TTL_MS,
    }]
    assert uploaded_project["pendingAssetRefs"] == expected_pending
    assert uploaded_project["autosaveVersion"] == prepared_before_upload["autosaveVersion"] == 1
    assert store.collect_garbage() == []
    uploaded_source_path, _ = store.asset_path(uploaded_source["assetId"])
    assert Path(uploaded_source_path).read_bytes() == uploaded_source_data

    stale_saved = store.save(
        "project-provisional", owner, prepared_before_upload, base_version=1
    )
    assert stale_saved["assetRefs"] == []
    assert stale_saved["pendingAssetRefs"] == expected_pending
    assert stale_saved["autosaveVersion"] == 2
    assert store.collect_garbage() == []
    store.asset_path(uploaded_source["assetId"])

    commit_candidate = copy.deepcopy(stale_saved)
    commit_candidate["layers"] = [{
        "layerId": "uploaded-layer",
        "name": "Uploaded layer",
        "assetRef": uploaded_source["assetId"],
    }]
    commit_candidate["assetRefs"] = [uploaded_source["assetId"]]
    commit_candidate["pendingAssetRefs"] = [{
        "assetId": "0" * 64,
        "expiresAt": clock["now"] + store.PENDING_ASSET_REF_TTL_MS,
    }]
    committed = store.save(
        "project-provisional", owner, commit_candidate, base_version=2
    )
    assert committed["assetRefs"] == [uploaded_source["assetId"]]
    assert committed["pendingAssetRefs"] == []

    injection_candidate = copy.deepcopy(committed)
    injection_candidate["pendingAssetRefs"] = [{
        "assetId": "f" * 64,
        "expiresAt": clock["now"] + store.PENDING_ASSET_REF_TTL_MS,
    }]
    injection_saved = store.save(
        "project-provisional", owner, injection_candidate, base_version=3
    )
    assert injection_saved["pendingAssetRefs"] == []

    output_data = png_bytes((190, 72, 44, 255))
    output_asset = store.store_image(
        "project-provisional", owner, output_data,
        "image/png", "output.png", "output",
    )
    output_project = store.load("project-provisional", owner)
    assert output_project["autosaveVersion"] == injection_saved["autosaveVersion"] == 4
    assert output_asset["assetId"] in output_project["assetRefs"]
    assert output_project["pendingAssetRefs"] == []
    assert output_project["exportRecords"][-1]["assetId"] == output_asset["assetId"]

    abandoned_owner = {**owner, "nodeId": "node-abandoned"}
    store.initialize("project-abandoned", abandoned_owner, {"width": 8, "height": 6})
    abandoned_asset = store.store_image(
        "project-abandoned", abandoned_owner, png_bytes((17, 29, 43, 255)),
        "image/png", "abandoned.png", "source",
    )
    abandoned_project = store.load("project-abandoned", abandoned_owner)
    abandoned_expiry = abandoned_project["pendingAssetRefs"][0]["expiresAt"]
    clone_owner = {**owner, "nodeId": "node-abandoned-clone"}
    abandoned_clone = store.clone(
        "project-abandoned", abandoned_owner,
        "project-abandoned-clone", clone_owner,
    )
    assert abandoned_clone["pendingAssetRefs"] == []
    assert store.collect_garbage() == []

    clock["now"] = abandoned_expiry
    assert store.collect_garbage() == [abandoned_asset["assetId"]]
    assert store.load("project-abandoned", abandoned_owner)["pendingAssetRefs"] == []
    try:
        store.asset_path(abandoned_asset["assetId"])
        raise AssertionError("expired provisional asset should be removed")
    except OpenShopNotFound:
        pass


with tempfile.TemporaryDirectory(prefix="hstara-openshop-ocr-source-ref-") as data_dir:
    store = OpenShopProjectStore(data_dir, canvas_dir=Path(data_dir) / "canvases")
    owner = {
        "canvasType": "classic",
        "canvasId": "canvas-ocr-source-ref",
        "nodeId": "node-ocr-source-ref",
    }
    project = store.initialize("project-ocr-source-ref", owner, {"width": 8, "height": 6})
    source = store.store_image(
        "project-ocr-source-ref", owner, png_bytes((44, 88, 132, 255)),
        "image/png", "ocr-source.png", "ai-source",
    )
    project["editor"] = {"objects": [{
        "type": "i-text",
        "text": "OCR provenance only",
        "hstarOcrSourceAssetId": source["assetId"],
    }]}
    project["assetRefs"] = []
    saved = store.save("project-ocr-source-ref", owner, project, base_version=1)
    assert saved["assetRefs"] == [source["assetId"]]
    assert saved["pendingAssetRefs"] == []


with tempfile.TemporaryDirectory(prefix="hstara-openshop-preview-promotion-") as data_dir:
    store = OpenShopProjectStore(data_dir, canvas_dir=Path(data_dir) / "canvases")
    store.MAX_PENDING_ASSET_REFS = 1
    store._now = lambda: 1_700_000_000_000
    owner = {
        "canvasType": "classic",
        "canvasId": "canvas-preview-promotion",
        "nodeId": "node-preview-promotion",
    }
    project = store.initialize(
        "project-preview-promotion", owner, {"width": 8, "height": 6}
    )
    preview_asset = store.store_image(
        "project-preview-promotion", owner, png_bytes((8, 18, 28, 255)),
        "image/png", "pending-preview.png", "source",
    )
    assert store.load("project-preview-promotion", owner)["pendingAssetRefs"][0][
        "assetId"
    ] == preview_asset["assetId"]

    project["previewAssetId"] = preview_asset["assetId"]
    saved_preview = store.save(
        "project-preview-promotion", owner, project, base_version=1
    )
    assert saved_preview["assetRefs"] == []
    assert saved_preview["previewAssetId"] == preview_asset["assetId"]
    assert saved_preview["pendingAssetRefs"] == []

    next_asset = store.store_image(
        "project-preview-promotion", owner, png_bytes((38, 48, 58, 255)),
        "image/png", "next-source.png", "source",
    )
    next_project = store.load("project-preview-promotion", owner)
    assert next_project["pendingAssetRefs"][0]["assetId"] == next_asset["assetId"]


with tempfile.TemporaryDirectory(prefix="hstara-openshop-provisional-limit-") as data_dir:
    store = OpenShopProjectStore(data_dir, canvas_dir=Path(data_dir) / "canvases")
    store.MAX_PENDING_ASSET_REFS = 2
    clock = {"now": 1_700_000_000_000}
    store._now = lambda: clock["now"]
    owner = {
        "canvasType": "classic",
        "canvasId": "canvas-provisional-limit",
        "nodeId": "node-provisional-limit",
    }
    project = store.initialize(
        "project-provisional-limit", owner, {"width": 8, "height": 6}
    )
    preview_owner = {**owner, "nodeId": "node-preview-source"}
    store.initialize("project-preview-source", preview_owner, {"width": 8, "height": 6})
    preview_data = png_bytes((5, 15, 25, 255))
    preview_asset = store.store_image(
        "project-preview-source", preview_owner, preview_data,
        "image/png", "preview.png", "output",
    )
    project["previewAssetId"] = preview_asset["assetId"]
    project = store.save("project-provisional-limit", owner, project, base_version=1)

    first_data = png_bytes((11, 22, 33, 255))
    second_data = png_bytes((44, 55, 66, 255))
    retained_assets = [
        store.store_image(
            "project-provisional-limit", owner, data,
            "image/png", name, "source",
        )
        for data, name in [
            (first_data, "first.png"),
            (second_data, "second.png"),
        ]
    ]
    clock["now"] += 1_000
    refreshed_asset = store.store_image(
        "project-provisional-limit", owner, first_data,
        "image/png", "first-refreshed.png", "source",
    )
    assert refreshed_asset["assetId"] == retained_assets[0]["assetId"]
    refreshed_project = store.load("project-provisional-limit", owner)
    assert [item["assetId"] for item in refreshed_project["pendingAssetRefs"]] == [
        retained_assets[1]["assetId"],
        retained_assets[0]["assetId"],
    ]
    assert refreshed_project["pendingAssetRefs"][-1]["expiresAt"] == (
        clock["now"] + store.PENDING_ASSET_REF_TTL_MS
    )

    store.store_image(
        "project-provisional-limit", owner, preview_data,
        "image/png", "preview-again.png", "source",
    )
    preview_reused = store.load("project-provisional-limit", owner)
    assert preview_reused["pendingAssetRefs"] == refreshed_project["pendingAssetRefs"]
    assert preview_asset["assetId"] not in preview_reused["assetRefs"]

    permanent_data = png_bytes((31, 41, 51, 255))
    permanent_asset = store.store_image(
        "project-provisional-limit", owner, permanent_data,
        "image/png", "permanent.png", "output",
    )
    store.store_image(
        "project-provisional-limit", owner, permanent_data,
        "image/png", "permanent-again.png", "source",
    )
    permanent_reused = store.load("project-provisional-limit", owner)
    assert permanent_asset["assetId"] in permanent_reused["assetRefs"]
    assert permanent_reused["pendingAssetRefs"] == refreshed_project["pendingAssetRefs"]

    overflow_data = png_bytes((77, 88, 99, 255))
    try:
        store.store_image(
            "project-provisional-limit", owner, overflow_data,
            "image/png", "overflow.png", "source",
        )
        raise AssertionError("a distinct provisional upload beyond the limit should be rejected")
    except OpenShopValidationError as exc:
        assert "pendingAssetRefs limit" in str(exc)

    promoted_asset = store.store_image(
        "project-provisional-limit", owner, second_data,
        "image/png", "second-output.png", "output",
    )
    promoted_project = store.load("project-provisional-limit", owner)
    assert promoted_asset["assetId"] in promoted_project["assetRefs"]
    assert promoted_project["exportRecords"][-1]["assetId"] == promoted_asset["assetId"]
    assert [item["assetId"] for item in promoted_project["pendingAssetRefs"]] == [
        retained_assets[0]["assetId"]
    ]

    clock["now"] += 500
    filler_asset = store.store_image(
        "project-provisional-limit", owner, png_bytes((101, 111, 121, 255)),
        "image/png", "filler.png", "source",
    )
    first_expiry = next(
        item["expiresAt"]
        for item in store.load("project-provisional-limit", owner)["pendingAssetRefs"]
        if item["assetId"] == retained_assets[0]["assetId"]
    )
    clock["now"] = first_expiry
    reused_slot_asset = store.store_image(
        "project-provisional-limit", owner, overflow_data,
        "image/png", "reused-slot.png", "source",
    )
    reused_slot_project = store.load("project-provisional-limit", owner)
    assert [item["assetId"] for item in reused_slot_project["pendingAssetRefs"]] == [
        filler_asset["assetId"],
        reused_slot_asset["assetId"],
    ]

    ordering_owner = {**owner, "nodeId": "node-save-before-upload"}
    ordering_project = store.initialize(
        "project-save-before-upload", ordering_owner, {"width": 8, "height": 6}
    )
    ordering_project["editor"] = {"objects": [{"type": "text", "text": "latest"}]}
    ordering_saved = store.save(
        "project-save-before-upload", ordering_owner, ordering_project, base_version=1
    )
    ordering_asset = store.store_image(
        "project-save-before-upload", ordering_owner, png_bytes((131, 141, 151, 255)),
        "image/png", "after-save.png", "source",
    )
    ordered_project = store.load("project-save-before-upload", ordering_owner)
    assert ordered_project["autosaveVersion"] == ordering_saved["autosaveVersion"] == 2
    assert ordered_project["editor"] == ordering_saved["editor"]
    assert ordered_project["assetRefs"] == []
    assert ordered_project["pendingAssetRefs"][0]["assetId"] == ordering_asset["assetId"]


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
    provisional_client_request_id = "art-font-request.project-metadata.node-a.text-layer-1.1"
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
    }, {
        "taskId": f"provisional:{provisional_client_request_id}",
        "clientRequestId": provisional_client_request_id,
        "creationState": "provisional",
        "toolId": "art-font-restore",
        "apiConfigId": "vision",
        "modelId": "gemini-3-pro-image",
        "status": "queued",
        "mode": "layer",
        "sourceLayerId": "source-layer-1",
        "sourceAssetId": source_asset_id,
        "outputAssetId": "",
        "context": {**owner_a, "projectId": "project-metadata"},
        "owner": owner_a,
        "reconcileState": "pending",
        "reconcileReason": "",
        "generatedLayerId": "",
        "snapshot": {
            "textLayerId": "text-layer-1",
            "ocrBlockId": "ocr-title",
            "originalText": "Original",
            "currentText": "Edited",
            "requestGeneration": 1,
            "document": {"width": 640, "height": 480},
            "quad": [
                {"x": 0.1, "y": 0.2}, {"x": 0.4, "y": 0.2},
                {"x": 0.4, "y": 0.3}, {"x": 0.1, "y": 0.3},
            ],
            "visualProfile": {
                "script": "en", "dominantScript": "en", "fill": "#112233",
                "alignment": "left", "rotation": 0, "artistic": False,
                "familyCandidates": ["Arial"], "size": 40, "weight": 700,
                "style": "normal", "styleDescription": "painted",
                "letterSpacing": 0, "lineHeight": 1.2,
                "strokeColor": "#00000000", "strokeWidth": 0,
                "shadow": {"color": "#00000000", "blur": 0, "offsetX": 0, "offsetY": 0},
            },
        },
        "createdAt": 3000,
        "updatedAt": 3000,
        "completedAt": 0,
        "appliedAt": 0,
        "staleAt": 0,
        "discardedAt": 0,
    }]
    metadata_project["assetRefs"] = [source_asset_id]
    saved_metadata = store.save("project-metadata", owner_a, metadata_project, base_version=1)
    assert saved_metadata["fontRefs"] == metadata_project["fontRefs"]
    assert saved_metadata["aiToolPreferences"] == metadata_project["aiToolPreferences"]
    assert saved_metadata["aiTaskRecords"][0]["outputAssetId"] == source_asset_id
    assert saved_metadata["aiTaskRecords"][1]["taskId"].startswith("provisional:")
    assert saved_metadata["aiTaskRecords"][1]["clientRequestId"] == provisional_client_request_id
    assert saved_metadata["aiTaskRecords"][1]["creationState"] == "provisional"

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


with tempfile.TemporaryDirectory(prefix="hstara-openshop-clone-retry-") as data_dir:
    canvas_dir = Path(data_dir) / "canvases"
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)
    source_owner = {
        "canvasType": "classic",
        "canvasId": "canvas-clone-retry",
        "nodeId": "node-clone-source",
    }
    target_owner = {**source_owner, "nodeId": "node-clone-target"}
    store.initialize(
        "project-clone-source", source_owner, {"width": 640, "height": 480}
    )

    first_clone = store.clone(
        "project-clone-source",
        source_owner,
        "project-clone-target",
        target_owner,
    )
    source_path = (
        canvas_dir
        / "canvas-clone-retry.openshop"
        / "node-clone-source"
        / "project.json"
    )
    target_path = (
        canvas_dir
        / "canvas-clone-retry.openshop"
        / "node-clone-target"
        / "project.json"
    )
    assert store.delete("project-clone-source", source_owner) is True
    assert not source_path.exists()
    assert target_path.is_file()

    retried_clone = store.clone(
        "project-clone-source",
        source_owner,
        "project-clone-target",
        target_owner,
    )
    assert retried_clone == first_clone
    retried_clone["document"]["width"] = 1
    assert store.load("project-clone-target", target_owner) == first_clone


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
    assert migrated["pendingAssetRefs"] == []
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


with tempfile.TemporaryDirectory(prefix="hstara-openshop-canvas-delete-records-") as data_dir:
    canvas_dir = Path(data_dir) / "canvases"
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)
    owner_z = {
        "canvasType": "classic",
        "canvasId": "canvas-delete-records",
        "nodeId": "node-z",
    }
    owner_a = {**owner_z, "nodeId": "node-a"}
    store.initialize("project-shared", owner_z, {"width": 320, "height": 240})
    store.initialize("project-shared", owner_a, {"width": 320, "height": 240})

    removed_records = store.delete_canvas_projects("classic", "canvas-delete-records")
    assert removed_records == [{
        "projectId": "project-shared",
        "owner": owner_a,
    }, {
        "projectId": "project-shared",
        "owner": owner_z,
    }]


with tempfile.TemporaryDirectory(prefix="hstara-openshop-canvas-reconcile-") as data_dir:
    root = Path(data_dir)
    canvas_dir = root / "canvases"
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)
    owner_active = {
        "canvasType": "classic",
        "canvasId": "canvas-reconcile",
        "nodeId": "node-z-active",
    }
    owner_stale = {**owner_active, "nodeId": "node-a-stale"}
    owner_legacy = {**owner_active, "nodeId": "node-m-legacy"}
    store.initialize("project-shared", owner_active, {"width": 320, "height": 240})
    store.initialize("project-shared", owner_stale, {"width": 320, "height": 240})
    legacy_project = store.initialize(
        "project-legacy",
        owner_legacy,
        {"width": 320, "height": 240},
    )
    legacy_sidecar = (
        canvas_dir / "canvas-reconcile.openshop" / "node-m-legacy" / "project.json"
    )
    legacy_sidecar.unlink()
    legacy_sidecar.parent.rmdir()
    legacy_path = root / "projects" / "project-legacy.json"
    legacy_path.write_text(json.dumps(legacy_project, ensure_ascii=False), encoding="utf-8")

    reconciled_records = store.reconcile_canvas_projects(
        "classic",
        "canvas-reconcile",
        {("node-z-active", "project-shared")},
    )
    assert reconciled_records == [{
        "projectId": "project-shared",
        "owner": owner_stale,
    }, {
        "projectId": "project-legacy",
        "owner": owner_legacy,
    }]
    assert store.load("project-shared", owner_active)["owner"] == owner_active
    assert not (
        canvas_dir / "canvas-reconcile.openshop" / "node-a-stale" / "project.json"
    ).exists()
    assert not legacy_path.exists()


with tempfile.TemporaryDirectory(prefix="hstara-openshop-reconcile-parent-cleanup-") as data_dir:
    root = Path(data_dir)
    canvas_dir = root / "canvases"
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)
    owner = {
        "canvasType": "classic",
        "canvasId": "canvas-parent-cleanup",
        "nodeId": "node-parent-cleanup",
    }
    store.initialize(
        "project-parent-cleanup",
        owner,
        {"width": 320, "height": 240},
    )
    canvas_sidecar = canvas_dir / "canvas-parent-cleanup.openshop"
    original_path_rmdir = Path.rmdir

    def fail_canvas_sidecar_cleanup(path):
        if path == canvas_sidecar:
            raise OSError("injected empty parent cleanup failure")
        return original_path_rmdir(path)

    Path.rmdir = fail_canvas_sidecar_cleanup
    try:
        cleanup_records = store.reconcile_canvas_projects(
            "classic",
            "canvas-parent-cleanup",
            set(),
        )
    finally:
        Path.rmdir = original_path_rmdir

    assert cleanup_records == [{
        "projectId": "project-parent-cleanup",
        "owner": owner,
    }]
    assert not (
        canvas_sidecar / owner["nodeId"] / "project.json"
    ).exists()


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
        assert_atomic_explicit_canvas_create(main)

        image_data = png_bytes((75, 161, 88, 255))
        output_data = png_bytes((190, 72, 44, 255))
        transport = httpx.ASGITransport(app=main.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
            random_canvas_response = await client.post(
                "/api/canvases",
                json={"title": "Random ID canvas", "icon": "layers", "kind": "classic"},
            )
            assert random_canvas_response.status_code == 200, random_canvas_response.text
            random_canvas_id = random_canvas_response.json()["canvas"]["id"]
            assert len(random_canvas_id) == 32
            assert all(character in "0123456789abcdef" for character in random_canvas_id)

            rejected_custom_id = await client.post(
                "/api/canvases",
                json={
                    "id": "caller-selected-canvas-id",
                    "title": "Rejected custom ID",
                    "icon": "layers",
                    "kind": "classic",
                },
            )
            assert rejected_custom_id.status_code == 400, rejected_custom_id.text

            engineering_canvas_id = "codex-e2e-openshop-project-storage"
            canvas_response = await client.post(
                "/api/canvases",
                json={
                    "id": engineering_canvas_id,
                    "title": "OpenShop API canvas",
                    "icon": "layers",
                    "kind": "classic",
                },
            )
            assert canvas_response.status_code == 200
            canvas = canvas_response.json()["canvas"]
            assert canvas["id"] == engineering_canvas_id
            duplicate_canvas_response = await client.post(
                "/api/canvases",
                json={
                    "id": engineering_canvas_id,
                    "title": "Duplicate engineering canvas",
                    "icon": "layers",
                    "kind": "classic",
                },
            )
            assert duplicate_canvas_response.status_code == 409, duplicate_canvas_response.text
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
            touched_attached = await client.post(f"/api/canvases/{canvas['id']}/touch")
            assert touched_attached.status_code == 200, touched_attached.text
            assert touched_attached.json()["full_canvas"]["nodes"] == canvas_payload["nodes"]
            canvas_payload["nodes"] = [
                node for node in canvas_payload["nodes"] if node["id"] == "output-api"
            ]
            canvas_payload["base_updated_at"] = touched_attached.json()["full_canvas"]["updated_at"]
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

            shared_project_id = "project-api-shared"
            shared_owner_a = {
                "canvasType": "classic",
                "canvasId": canvas["id"],
                "nodeId": "node-shared-a",
            }
            shared_owner_b = {**shared_owner_a, "nodeId": "node-shared-b"}
            shared_owner_c = {**shared_owner_a, "nodeId": "node-shared-c"}
            for shared_owner in (shared_owner_a, shared_owner_b, shared_owner_c):
                shared_init = await client.post(
                    f"/api/openshop/projects/{shared_project_id}/initialize",
                    json={"owner": shared_owner, "document": {"width": 640, "height": 480}},
                )
                assert shared_init.status_code == 200, shared_init.text

            stale_asset = main.OPENSHOP_STORE.store_image(
                shared_project_id,
                shared_owner_a,
                png_bytes((21, 32, 43, 255)),
                "image/png",
                "stale.png",
                "source",
            )
            upstream_asset = main.OPENSHOP_STORE.store_image(
                shared_project_id,
                shared_owner_a,
                png_bytes((54, 65, 76, 255)),
                "image/png",
                "upstream.png",
                "output",
            )
            survivor_asset = main.OPENSHOP_STORE.store_image(
                shared_project_id,
                shared_owner_b,
                png_bytes((87, 98, 109, 255)),
                "image/png",
                "survivor.png",
                "source",
            )
            failed_asset = main.OPENSHOP_STORE.store_image(
                shared_project_id,
                shared_owner_c,
                png_bytes((110, 121, 132, 255)),
                "image/png",
                "failed-later.png",
                "source",
            )
            stale_task = main.OPENSHOP_AI_TASKS.create(
                shared_project_id,
                shared_owner_a,
                "text-remove",
                "vision",
                "test-model",
                stale_asset["assetId"],
            )
            survivor_task = main.OPENSHOP_AI_TASKS.create(
                shared_project_id,
                shared_owner_b,
                "text-remove",
                "vision",
                "test-model",
                survivor_asset["assetId"],
            )
            failed_task = main.OPENSHOP_AI_TASKS.create(
                shared_project_id,
                shared_owner_c,
                "text-remove",
                "vision",
                "test-model",
                failed_asset["assetId"],
            )

            shared_payload = {
                **canvas_payload,
                "nodes": [{
                    "id": shared_owner_a["nodeId"],
                    "type": "openshop-layered",
                    "projectId": shared_project_id,
                }, {
                    "id": shared_owner_b["nodeId"],
                    "type": "openshop-layered",
                    "projectId": shared_project_id,
                }, {
                    "id": shared_owner_c["nodeId"],
                    "type": "openshop-layered",
                    "projectId": shared_project_id,
                }, {
                    "id": "node-shared-upstream",
                    "type": "image",
                    "url": f"/api/openshop/assets/{upstream_asset['assetId']}",
                    "openshopAssetId": upstream_asset["assetId"],
                }],
                "base_updated_at": removed_output.json()["canvas"]["updated_at"],
            }
            shared_attached = await client.put(
                f"/api/canvases/{canvas['id']}", json=shared_payload
            )
            assert shared_attached.status_code == 200, shared_attached.text

            shared_sidecar_a = (
                Path(main.CANVAS_DIR)
                / f"{canvas['id']}.openshop"
                / shared_owner_a["nodeId"]
                / "project.json"
            )
            shared_sidecar_b = (
                Path(main.CANVAS_DIR)
                / f"{canvas['id']}.openshop"
                / shared_owner_b["nodeId"]
                / "project.json"
            )
            shared_sidecar_c = (
                Path(main.CANVAS_DIR)
                / f"{canvas['id']}.openshop"
                / shared_owner_c["nodeId"]
                / "project.json"
            )
            shared_payload["nodes"] = [
                node
                for node in shared_payload["nodes"]
                if node["id"] in {shared_owner_b["nodeId"], "node-shared-upstream"}
            ]
            shared_payload["base_updated_at"] = shared_attached.json()["canvas"]["updated_at"]
            original_delete = main.OPENSHOP_STORE.delete
            delete_failure = {"remaining": 1}
            delete_attempts = []
            retry_broadcasts = []
            original_broadcast = main.manager.broadcast_canvas_updated

            async def record_retry_broadcast(*args, **kwargs):
                retry_broadcasts.append((args, kwargs))

            def fail_later_exact_delete(project_id, delete_owner):
                if project_id == shared_project_id and delete_owner in (
                    shared_owner_a,
                    shared_owner_c,
                ):
                    delete_attempts.append(delete_owner["nodeId"])
                if (
                    delete_failure["remaining"]
                    and project_id == shared_project_id
                    and delete_owner == shared_owner_c
                ):
                    delete_failure["remaining"] -= 1
                    raise OSError("injected later exact OpenShop delete failure")
                return original_delete(project_id, delete_owner)

            main.OPENSHOP_STORE.delete = fail_later_exact_delete
            main.manager.broadcast_canvas_updated = record_retry_broadcast
            try:
                try:
                    await client.put(f"/api/canvases/{canvas['id']}", json=shared_payload)
                    raise AssertionError("the later exact sidecar delete must fail after canvas save")
                except OSError as exc:
                    assert "injected later exact OpenShop delete failure" in str(exc)

                saved_after_failure = main.load_canvas(canvas["id"])
                assert saved_after_failure["nodes"] == shared_payload["nodes"]
                assert delete_attempts == [shared_owner_a["nodeId"], shared_owner_c["nodeId"]]
                assert not shared_sidecar_a.exists()
                assert shared_sidecar_b.is_file()
                assert shared_sidecar_c.is_file()
                assert main.OPENSHOP_AI_TASKS.get(
                    stale_task["taskId"], shared_project_id, shared_owner_a
                )["status"] == "cancelled"
                assert main.OPENSHOP_AI_TASKS.get(
                    failed_task["taskId"], shared_project_id, shared_owner_c
                )["status"] == "queued"
                assert (
                    await client.get(f"/api/openshop/assets/{stale_asset['assetId']}")
                ).status_code == 404
                assert (
                    await client.get(f"/api/openshop/assets/{failed_asset['assetId']}")
                ).status_code == 200

                shared_removed = await client.put(
                    f"/api/canvases/{canvas['id']}", json=shared_payload
                )
                assert shared_removed.status_code == 200, shared_removed.text
                divergent_retry = await client.put(
                    f"/api/canvases/{canvas['id']}",
                    json={
                        **shared_payload,
                        "nodes": [
                            *shared_payload["nodes"],
                            {"id": "stale-divergent-node", "type": "image"},
                        ],
                    },
                )
                assert divergent_retry.status_code == 409, divergent_retry.text
                assert len(retry_broadcasts) == 1
            finally:
                main.OPENSHOP_STORE.delete = original_delete
                main.manager.broadcast_canvas_updated = original_broadcast

            assert not shared_sidecar_a.exists()
            assert shared_sidecar_b.is_file()
            assert not shared_sidecar_c.exists()
            removed_shared_project = await client.get(
                f"/api/openshop/projects/{shared_project_id}",
                params={
                    "canvas_type": shared_owner_a["canvasType"],
                    "canvas_id": shared_owner_a["canvasId"],
                    "node_id": shared_owner_a["nodeId"],
                },
            )
            surviving_shared_project = await client.get(
                f"/api/openshop/projects/{shared_project_id}",
                params={
                    "canvas_type": shared_owner_b["canvasType"],
                    "canvas_id": shared_owner_b["canvasId"],
                    "node_id": shared_owner_b["nodeId"],
                },
            )
            assert removed_shared_project.status_code == 404
            assert surviving_shared_project.status_code == 200
            assert main.OPENSHOP_AI_TASKS.get(
                stale_task["taskId"], shared_project_id, shared_owner_a
            )["status"] == "cancelled"
            assert main.OPENSHOP_AI_TASKS.get(
                survivor_task["taskId"], shared_project_id, shared_owner_b
            )["status"] == "queued"
            assert main.OPENSHOP_AI_TASKS.get(
                failed_task["taskId"], shared_project_id, shared_owner_c
            )["status"] == "cancelled"
            assert (
                await client.get(f"/api/openshop/assets/{stale_asset['assetId']}")
            ).status_code == 404
            assert (
                await client.get(f"/api/openshop/assets/{upstream_asset['assetId']}")
            ).status_code == 200
            assert (
                await client.get(f"/api/openshop/assets/{survivor_asset['assetId']}")
            ).status_code == 200
            assert (
                await client.get(f"/api/openshop/assets/{failed_asset['assetId']}")
            ).status_code == 404

            concurrent_response = await client.post(
                "/api/canvases",
                json={"title": "Concurrent reconciliation", "icon": "layers", "kind": "classic"},
            )
            concurrent_canvas = concurrent_response.json()["canvas"]
            concurrent_owner = {
                "canvasType": "classic",
                "canvasId": concurrent_canvas["id"],
                "nodeId": "node-concurrent-openshop",
            }
            concurrent_project_id = "project-concurrent-openshop"
            concurrent_init = await client.post(
                f"/api/openshop/projects/{concurrent_project_id}/initialize",
                json={"owner": concurrent_owner, "document": {"width": 640, "height": 480}},
            )
            assert concurrent_init.status_code == 200, concurrent_init.text
            concurrent_payload = {
                "title": concurrent_canvas["title"],
                "icon": concurrent_canvas["icon"],
                "nodes": [{
                    "id": concurrent_owner["nodeId"],
                    "type": "openshop-layered",
                    "projectId": concurrent_project_id,
                }],
                "connections": [],
                "viewport": {},
                "logs": [],
                "settings": {},
                "base_updated_at": concurrent_canvas["updated_at"],
            }
            concurrent_attached = await client.put(
                f"/api/canvases/{concurrent_canvas['id']}",
                json=concurrent_payload,
            )
            assert concurrent_attached.status_code == 200, concurrent_attached.text
            concurrent_payload["base_updated_at"] = concurrent_attached.json()["canvas"]["updated_at"]
            concurrent_detach_payload = {**concurrent_payload, "nodes": []}
            concurrent_attach_payload = copy.deepcopy(concurrent_payload)
            save_rendezvous = threading.Barrier(2)
            detached_saved = threading.Event()
            attached_saved = threading.Event()
            original_save_canvas = main.save_canvas

            def interleaved_save_canvas(candidate):
                is_detach = not main.openshop_project_owners(candidate.get("nodes"))
                try:
                    save_rendezvous.wait(timeout=1)
                except threading.BrokenBarrierError:
                    return original_save_canvas(candidate)
                if is_detach:
                    original_save_canvas(candidate)
                    detached_saved.set()
                    assert attached_saved.wait(timeout=5)
                else:
                    assert detached_saved.wait(timeout=5)
                    original_save_canvas(candidate)
                    attached_saved.set()

            def run_concurrent_canvas_put(request_payload):
                async def request_once():
                    transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=True)
                    async with httpx.AsyncClient(transport=transport, base_url="http://test") as thread_client:
                        return await thread_client.put(
                            f"/api/canvases/{concurrent_canvas['id']}",
                            json=request_payload,
                        )
                return asyncio.run(request_once())

            main.save_canvas = interleaved_save_canvas
            try:
                concurrent_results = await asyncio.gather(
                    asyncio.to_thread(run_concurrent_canvas_put, concurrent_detach_payload),
                    asyncio.to_thread(run_concurrent_canvas_put, concurrent_attach_payload),
                )
            finally:
                main.save_canvas = original_save_canvas

            assert {result.status_code for result in concurrent_results} <= {200, 409}
            assert save_rendezvous.broken
            concurrent_saved = main.load_canvas(concurrent_canvas["id"])
            if main.openshop_project_owners(concurrent_saved.get("nodes")):
                assert main.OPENSHOP_STORE.load(
                    concurrent_project_id,
                    concurrent_owner,
                )["owner"] == concurrent_owner
            else:
                try:
                    main.OPENSHOP_STORE.load(concurrent_project_id, concurrent_owner)
                    raise AssertionError("detached concurrent project must be deleted")
                except OpenShopNotFound:
                    pass

            version_response = await client.post(
                "/api/canvases",
                json={"title": "Monotonic version", "icon": "clock", "kind": "classic"},
            )
            version_canvas = version_response.json()["canvas"]
            version_owner = {
                "canvasType": "classic",
                "canvasId": version_canvas["id"],
                "nodeId": "node-monotonic-version",
            }
            version_project_id = "project-monotonic-version"
            version_init = await client.post(
                f"/api/openshop/projects/{version_project_id}/initialize",
                json={"owner": version_owner, "document": {"width": 640, "height": 480}},
            )
            assert version_init.status_code == 200, version_init.text
            version_payload = {
                "title": version_canvas["title"],
                "icon": version_canvas["icon"],
                "nodes": [{
                    "id": version_owner["nodeId"],
                    "type": "openshop-layered",
                    "projectId": version_project_id,
                }],
                "connections": [],
                "viewport": {},
                "logs": [],
                "settings": {},
                "base_updated_at": version_canvas["updated_at"],
            }
            version_attached = await client.put(
                f"/api/canvases/{version_canvas['id']}",
                json=version_payload,
            )
            assert version_attached.status_code == 200, version_attached.text
            version_base = version_attached.json()["canvas"]["updated_at"]
            version_payload["base_updated_at"] = version_base
            original_now_ms = main.now_ms
            main.now_ms = lambda: version_base
            try:
                version_detached = await client.put(
                    f"/api/canvases/{version_canvas['id']}",
                    json={**version_payload, "nodes": []},
                )
                stale_version_attach = await client.put(
                    f"/api/canvases/{version_canvas['id']}",
                    json=version_payload,
                )
            finally:
                main.now_ms = original_now_ms
            assert version_detached.status_code == 200, version_detached.text
            assert stale_version_attach.status_code == 409, stale_version_attach.text
            assert main.load_canvas(version_canvas["id"])["nodes"] == []
            try:
                main.OPENSHOP_STORE.load(version_project_id, version_owner)
                raise AssertionError("stale same-millisecond save must not resurrect a project")
            except OpenShopNotFound:
                pass

            purge_response = await client.post(
                "/api/canvases",
                json={"title": "Purge race", "icon": "trash-2", "kind": "classic"},
            )
            purge_canvas = purge_response.json()["canvas"]
            purge_owner = {
                "canvasType": "classic",
                "canvasId": purge_canvas["id"],
                "nodeId": "node-purge-race",
            }
            purge_project_id = "project-purge-race"
            purge_init = await client.post(
                f"/api/openshop/projects/{purge_project_id}/initialize",
                json={"owner": purge_owner, "document": {"width": 640, "height": 480}},
            )
            assert purge_init.status_code == 200, purge_init.text
            purge_path = Path(main.canvas_path(purge_canvas["id"]))
            remove_entered = threading.Event()
            allow_remove = threading.Event()
            initialize_worker_started = threading.Event()
            original_os_remove = main.os.remove
            original_asyncio_to_thread = main.asyncio.to_thread

            def pause_canvas_remove(path):
                if Path(path) == purge_path:
                    remove_entered.set()
                    assert allow_remove.wait(timeout=5)
                return original_os_remove(path)

            def run_purge_request():
                async def request_once():
                    transport = httpx.ASGITransport(app=main.app, raise_app_exceptions=True)
                    async with httpx.AsyncClient(transport=transport, base_url="http://test") as thread_client:
                        return await thread_client.delete(
                            f"/api/canvases/{purge_canvas['id']}/purge"
                        )
                return asyncio.run(request_once())

            async def observe_initialize_worker(func, *args, **kwargs):
                if getattr(func, "__name__", "") == "initialize_project":
                    def run_observed_initialize():
                        initialize_worker_started.set()
                        return func(*args, **kwargs)
                    return await original_asyncio_to_thread(run_observed_initialize)
                return await original_asyncio_to_thread(func, *args, **kwargs)

            main.os.remove = pause_canvas_remove
            main.asyncio.to_thread = observe_initialize_worker
            purge_task = asyncio.create_task(asyncio.to_thread(run_purge_request))
            try:
                assert await asyncio.to_thread(remove_entered.wait, 5)
                raced_initialize = asyncio.create_task(client.post(
                    f"/api/openshop/projects/{purge_project_id}/initialize",
                    json={"owner": purge_owner, "document": {"width": 640, "height": 480}},
                ))
                assert await asyncio.to_thread(initialize_worker_started.wait, 5)
                allow_remove.set()
                purge_result, raced_initialize_result = await asyncio.gather(
                    purge_task,
                    raced_initialize,
                )
            finally:
                allow_remove.set()
                main.os.remove = original_os_remove
                main.asyncio.to_thread = original_asyncio_to_thread
            assert purge_result.status_code == 200, purge_result.text
            assert raced_initialize_result.status_code == 404, raced_initialize_result.text
            assert not purge_path.exists()
            try:
                main.OPENSHOP_STORE.load(purge_project_id, purge_owner)
                raise AssertionError("purged canvas must not retain a raced project")
            except OpenShopNotFound:
                pass

            startup_response = await client.post(
                "/api/canvases",
                json={"title": "Startup reconciliation", "icon": "refresh-cw", "kind": "classic"},
            )
            startup_canvas = startup_response.json()["canvas"]
            startup_active_owner = {
                "canvasType": "classic",
                "canvasId": startup_canvas["id"],
                "nodeId": "node-startup-active",
            }
            startup_stale_owner = {
                **startup_active_owner,
                "nodeId": "node-startup-stale",
            }
            for startup_project_id, startup_owner in (
                ("project-startup-active", startup_active_owner),
                ("project-startup-stale", startup_stale_owner),
            ):
                startup_init = await client.post(
                    f"/api/openshop/projects/{startup_project_id}/initialize",
                    json={"owner": startup_owner, "document": {"width": 640, "height": 480}},
                )
                assert startup_init.status_code == 200, startup_init.text
            startup_asset = main.OPENSHOP_STORE.store_image(
                "project-startup-stale",
                startup_stale_owner,
                png_bytes((120, 131, 142, 255)),
                "image/png",
                "startup-upstream.png",
                "output",
            )
            startup_task = main.OPENSHOP_AI_TASKS.create(
                "project-startup-stale",
                startup_stale_owner,
                "text-remove",
                "vision",
                "test-model",
                startup_asset["assetId"],
            )
            startup_canvas["nodes"] = [{
                "id": startup_active_owner["nodeId"],
                "type": "openshop-layered",
                "projectId": "project-startup-active",
            }, {
                "id": "node-startup-upstream",
                "type": "image",
                "projectId": "project-startup-stale",
                "url": f"/api/openshop/assets/{startup_asset['assetId']}",
                "openshopAssetId": startup_asset["assetId"],
            }]
            main.save_canvas(startup_canvas)

            trash_response = await client.post(
                "/api/canvases",
                json={"title": "Startup trash survivor", "icon": "trash-2", "kind": "smart"},
            )
            trash_canvas = trash_response.json()["canvas"]
            trash_owner = {
                "canvasType": "smart",
                "canvasId": trash_canvas["id"],
                "nodeId": "node-trash-active",
            }
            trash_init = await client.post(
                "/api/openshop/projects/project-trash-active/initialize",
                json={"owner": trash_owner, "document": {"width": 640, "height": 480}},
            )
            assert trash_init.status_code == 200, trash_init.text
            trash_canvas["nodes"] = [{
                "id": trash_owner["nodeId"],
                "type": "openshop-layered",
                "projectId": "project-trash-active",
            }]
            main.save_canvas(trash_canvas)
            trash_deleted = await client.delete(f"/api/canvases/{trash_canvas['id']}")
            assert trash_deleted.status_code == 200, trash_deleted.text

            malformed_canvas_path = Path(main.CANVAS_DIR) / "000-malformed.json"
            malformed_canvas_path.write_text("{not-json", encoding="utf-8")
            logged_startup_errors = []
            original_log_exception = main.logging.exception
            main.logging.exception = lambda message, *args, **kwargs: logged_startup_errors.append(
                (message, args)
            )
            try:
                startup_removed = await asyncio.to_thread(main.reconcile_saved_openshop_projects)
            finally:
                main.logging.exception = original_log_exception
                malformed_canvas_path.unlink()

            assert {
                "projectId": "project-startup-stale",
                "owner": startup_stale_owner,
            } in startup_removed
            assert logged_startup_errors
            startup_active_sidecar = (
                Path(main.CANVAS_DIR)
                / f"{startup_canvas['id']}.openshop"
                / startup_active_owner["nodeId"]
                / "project.json"
            )
            startup_stale_sidecar = (
                Path(main.CANVAS_DIR)
                / f"{startup_canvas['id']}.openshop"
                / startup_stale_owner["nodeId"]
                / "project.json"
            )
            trash_sidecar = (
                Path(main.CANVAS_DIR)
                / f"{trash_canvas['id']}.openshop"
                / trash_owner["nodeId"]
                / "project.json"
            )
            assert startup_active_sidecar.is_file()
            assert not startup_stale_sidecar.exists()
            assert trash_sidecar.is_file()
            assert main.load_canvas(startup_canvas["id"])["nodes"] == startup_canvas["nodes"]
            saved_trash_canvas = main.load_canvas_any(trash_canvas["id"])
            assert saved_trash_canvas["deleted_at"]
            assert saved_trash_canvas["nodes"] == trash_canvas["nodes"]
            assert main.OPENSHOP_AI_TASKS.get(
                startup_task["taskId"], "project-startup-stale", startup_stale_owner
            )["status"] == "cancelled"
            assert (
                await client.get(f"/api/openshop/assets/{startup_asset['assetId']}")
            ).status_code == 200

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
            purge_task = main.OPENSHOP_AI_TASKS.create(
                "project-soft",
                soft_owner,
                "text-remove",
                "vision",
                "test-model",
                "a" * 64,
            )
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

            expired_response = await client.post(
                "/api/canvases",
                json={"title": "Expired orphan canvas", "icon": "clock", "kind": "classic"},
            )
            expired_canvas = expired_response.json()["canvas"]
            expired_owner = {
                "canvasType": "classic",
                "canvasId": expired_canvas["id"],
                "nodeId": "node-expired-orphan",
            }
            expired_init = await client.post(
                "/api/openshop/projects/project-expired-orphan/initialize",
                json={"owner": expired_owner, "document": {"width": 640, "height": 480}},
            )
            assert expired_init.status_code == 200, expired_init.text
            expired_task = main.OPENSHOP_AI_TASKS.create(
                "project-expired-orphan",
                expired_owner,
                "text-remove",
                "vision",
                "test-model",
                "b" * 64,
            )
            expired_canvas["deleted_at"] = 1
            main.save_canvas(expired_canvas)
            await asyncio.to_thread(main.cleanup_expired_canvas_trash)
            assert not Path(main.canvas_path(expired_canvas["id"])).exists()

            purge_status = main.OPENSHOP_AI_TASKS.get(
                purge_task["taskId"], "project-soft", soft_owner
            )["status"]
            expired_status = main.OPENSHOP_AI_TASKS.get(
                expired_task["taskId"], "project-expired-orphan", expired_owner
            )["status"]
            assert (purge_status, expired_status) == ("cancelled", "cancelled")
            assert not list(Path(app_root).rglob("*.tmp"))


if __name__ == "__main__":
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
