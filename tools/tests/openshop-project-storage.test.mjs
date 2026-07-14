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
import io
import json
import os
import sys
import tempfile
from pathlib import Path

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

    assert not list(Path(data_dir).rglob("*.tmp"))

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
