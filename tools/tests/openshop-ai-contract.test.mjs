import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const candidates = process.platform === 'win32'
  ? [
      ...[join(repoRoot, 'python', 'python.exe')]
        .filter(existsSync)
        .map(command => ({command, args:[]})),
      {command:'py', args:['-3']},
      {command:'python', args:[]},
    ]
  : [
      {command:'python3', args:[]},
      {command:'python', args:[]},
    ];

const python = candidates.find(candidate => {
  const probe = spawnSync(candidate.command, [...candidate.args, '-X', 'utf8', '-c', 'import sys'], {
    cwd:repoRoot,
    encoding:'utf8',
    env:{...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1'},
  });
  return !probe.error && probe.status === 0;
});
assert.ok(python, 'A Python interpreter is required for OpenShop AI contract tests');

const harness = String.raw`
import json
import os
import sys

sys.path.insert(0, os.getcwd())

from openshop_ai import (
    OpenShopAiTaskRegistry,
    OpenShopAiValidationError,
    build_capability_catalog,
    build_ocr_prompt,
    normalize_ai_task_record,
    normalize_generation_snapshot,
    normalize_ocr_layout,
    normalize_reference_record,
)

providers = [
    {
        "id": "vision",
        "name": "Vision API",
        "enabled": True,
        "primary": True,
        "has_key": True,
        "protocol": "openai",
        "api_key": "must-not-leak",
        "chat_models": ["gemini-3.1-pro-high", "text-embedding-3-large"],
        "image_models": ["gemini-3-pro-image"],
        "image_model_capabilities": {
            "gemini-3-pro-image": {
                "supportsMask": True,
                "supportsMultiReference": True,
                "maxReferenceImages": 12,
                "maxOutputs": 6,
                "supportsBatchOutput": False,
                "sizes": ["auto", "1024x1024"],
                "qualities": ["auto", "high"],
            }
        },
    },
    {
        "id": "antigravity",
        "name": "Antigravity CLI",
        "enabled": True,
        "has_key": False,
        "protocol": "gemini-cli",
        "chat_models": ["gemini-3.1-flash"],
        "image_models": ["gemini-3.1-flash-image"],
    },
    {
        "id": "disabled",
        "name": "Disabled",
        "enabled": False,
        "has_key": True,
        "protocol": "openai",
        "chat_models": ["gpt-5.5"],
        "image_models": ["gpt-image-2"],
    },
]

catalog = build_capability_catalog(providers, primary_provider_id="vision")
serialized = json.dumps(catalog, ensure_ascii=False).lower()
assert "must-not-leak" not in serialized
assert "api_key" not in serialized
assert catalog["primaryProviderId"] == "vision"
extract_providers = catalog["tools"]["text-extract"]["providers"]
remove_providers = catalog["tools"]["text-remove"]["providers"]
assert [item["id"] for item in extract_providers] == ["vision", "antigravity"]
assert [item["id"] for item in remove_providers] == ["vision", "antigravity"]
assert [item["id"] for item in extract_providers[0]["models"]] == ["gemini-3.1-pro-high"]
assert [item["id"] for item in remove_providers[0]["models"]] == ["gemini-3-pro-image"]
for tool_id in ("generative-fill", "local-redraw"):
    model = catalog["tools"][tool_id]["providers"][0]["models"][0]
    capabilities = model["capabilities"]
    assert capabilities["supportsImageInput"] is True
    assert capabilities["supportsMask"] is True
    assert capabilities["supportsMultiReference"] is True
    assert capabilities["maxReferenceImages"] == 12
    assert capabilities["maxOutputs"] == 6
    assert capabilities["sizes"] == ["auto", "1024x1024"]
    assert capabilities["qualities"] == ["auto", "high"]

prompt = build_ocr_prompt(1920, 1080)
assert "1920" in prompt and "1080" in prompt
assert "quad" in prompt and "confidence" in prompt
assert "中文" in prompt and "English" in prompt

valid = json.dumps({
    "blocks": [
        {
            "text": "中文 English",
            "quad": [
                {"x": 0.10, "y": 0.10},
                {"x": 0.40, "y": 0.10},
                {"x": 0.40, "y": 0.20},
                {"x": 0.10, "y": 0.20},
            ],
            "language": "mixed",
            "confidence": 0.62,
            "font": {"familyCandidates": ["Microsoft YaHei UI", "Arial"], "size": 48, "weight": 600},
            "color": "#ffffff",
            "align": "center",
            "rotation": 0,
            "paragraphId": "p1",
            "lineIndex": 0,
        },
        {
            "text": "Second line",
            "bbox": {"x": 960, "y": 540, "width": 480, "height": 108},
            "language": "en",
            "confidence": 1.2,
        },
    ]
}, ensure_ascii=False)
layout = normalize_ocr_layout(valid, width=1920, height=1080)
assert layout["width"] == 1920 and layout["height"] == 1080
assert layout["blocks"][0]["text"] == "中文 English"
assert layout["blocks"][0]["quad"][2] == {"x": 0.4, "y": 0.2}
assert layout["blocks"][0]["lowConfidence"] is True
assert layout["blocks"][0]["font"]["familyCandidates"] == ["Microsoft YaHei UI", "Arial"]
assert layout["blocks"][1]["quad"][0] == {"x": 0.5, "y": 0.5}
assert layout["blocks"][1]["quad"][2] == {"x": 0.75, "y": 0.6}
assert layout["blocks"][1]["confidence"] == 1.0

for invalid in (
    "just plain text without coordinates",
    json.dumps({"blocks": [{"text": "No location"}]}),
    json.dumps({"blocks": [{"text": "Out", "quad": [{"x": -1, "y": 0}] * 4}]}),
    json.dumps({"blocks": [{"text": "", "bbox": {"x": 1, "y": 1, "width": 10, "height": 10}}]}),
):
    try:
        normalize_ocr_layout(invalid, width=1920, height=1080)
        raise AssertionError("invalid OCR layout should fail")
    except OpenShopAiValidationError:
        pass

record = normalize_ai_task_record({
    "taskId": "task-1",
    "toolId": "text-remove",
    "apiConfigId": "vision",
    "modelId": "gemini-3-pro-image",
    "status": "succeeded",
    "sourceAssetId": "a" * 64,
    "outputAssetId": "b" * 64,
    "createdAt": 123,
    "updatedAt": 456,
})
assert record["toolId"] == "text-remove"
assert record["status"] == "succeeded"
assert "apiKey" not in record

try:
    normalize_ai_task_record({"taskId": "task-bad", "toolId": "unknown", "status": "running"})
    raise AssertionError("unknown tool should fail")
except OpenShopAiValidationError:
    pass

primary = normalize_reference_record({
    "assetId": "c" * 64,
    "alias": "参考图1",
    "sourceType": "primary",
    "order": 0,
    "width": 1920,
    "height": 1080,
})
selection_reference = normalize_reference_record({
    "assetId": "d" * 64,
    "alias": "选区1",
    "sourceType": "selection",
    "order": 1,
})
image_reference = normalize_reference_record({
    "assetId": "e" * 64,
    "alias": "参考图2",
    "sourceType": "library",
    "order": 2,
})
assert primary["mention"] == "@参考图1"
assert selection_reference["mention"] == "@选区1"
assert image_reference["mention"] == "@参考图2"

snapshot = normalize_generation_snapshot({
    "toolId": "local-redraw",
    "sourceAssetId": "c" * 64,
    "maskAssetId": "f" * 64,
    "primaryReferenceAssetId": "c" * 64,
    "references": [primary, selection_reference, image_reference],
    "prompt": "重绘 @选区1，并参考 @参考图2",
    "size": "auto",
    "quality": "high",
    "targetCount": 3,
    "referenceMode": "full",
    "sourceLayerId": "layer-source",
    "sourceLayerIndex": 2,
    "document": {
        "width": 1920,
        "height": 1080,
        "layerVersion": 17,
        "visibleCompositeVersion": 23,
    },
    "selection": {"x": 10, "y": 20, "width": 30, "height": 40, "feather": 0},
})
assert snapshot["targetCount"] == 3
assert snapshot["originalTargetCount"] == 3
assert snapshot["requestedIndexes"] == [0, 1, 2]
assert snapshot["references"][1]["mention"] == "@选区1"
assert "seed" not in json.dumps(snapshot).lower()

fill_snapshot = normalize_generation_snapshot({
    **snapshot,
    "toolId": "generative-fill",
    "prompt": "",
    "references": [primary],
    "referenceMode": "selection",
})
assert fill_snapshot["referenceMode"] == "full"

for invalid_snapshot in (
    {**snapshot, "seed": 42},
    {**snapshot, "prompt": ""},
    {**snapshot, "references": [image_reference, primary]},
    {**snapshot, "requestedIndexes": [0, 0, 2]},
):
    try:
        normalize_generation_snapshot(invalid_snapshot)
        raise AssertionError("invalid generation snapshot should fail")
    except OpenShopAiValidationError:
        pass

owner_a = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-a"}
registry = OpenShopAiTaskRegistry()
parent = registry.create_parent("project-a", owner_a, snapshot, "vision", "gemini-3-pro-image")
children = [registry.create_child(parent["taskId"], index) for index in snapshot["requestedIndexes"]]
assert registry.mark_child_running(parent["taskId"], children[0]["childTaskId"]) is True
assert registry.succeed_child(
    parent["taskId"], children[0]["childTaskId"], {"assetId": "1" * 64}
) is True
assert registry.succeed_child(
    parent["taskId"], children[1]["childTaskId"], {"assetId": "2" * 64}
) is True
assert registry.fail_child(parent["taskId"], children[2]["childTaskId"], "upstream failed") is True
partial = registry.get(parent["taskId"], "project-a", owner_a)
assert partial["status"] == "partial"
assert (partial["targetCount"], partial["completedCount"], partial["failedCount"]) == (3, 2, 1)
assert registry.succeed_child(
    parent["taskId"], children[2]["childTaskId"], {"assetId": "3" * 64}
) is False

normalized_parent = normalize_ai_task_record(partial)
assert normalized_parent["kind"] == "parent"
assert normalized_parent["children"][0]["outputAssetId"] == "1" * 64
assert normalized_parent["snapshot"]["sourceLayerId"] == "layer-source"
assert "owner" not in normalized_parent

cancel_parent = registry.create_parent(
    "project-a", owner_a, {**snapshot, "targetCount": 1, "requestedIndexes": [0]},
    "vision", "gemini-3-pro-image",
)
cancel_child = registry.create_child(cancel_parent["taskId"], 0)
registry.cancel(cancel_parent["taskId"], "project-a", owner_a)
assert registry.succeed_child(
    cancel_parent["taskId"], cancel_child["childTaskId"], {"assetId": "4" * 64}
) is False
assert registry.get(cancel_parent["taskId"], "project-a", owner_a)["status"] == "cancelled"

print("OpenShop AI contract tests passed")
`;

const result = spawnSync(python.command, [...python.args, '-X', 'utf8', '-c', harness], {
  cwd:repoRoot,
  encoding:'utf8',
  env:{...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1'},
  timeout:30_000,
});

assert.equal(result.status, 0, result.stderr || result.stdout || 'OpenShop AI contract harness failed');
console.log(result.stdout.trim());
