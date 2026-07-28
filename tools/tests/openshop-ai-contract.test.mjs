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

import openshop_ai as openshop_ai_module
from openshop_ai import (
    OPENSHOP_AI_TOOL_IDS,
    OPENSHOP_GENERATIVE_TOOL_IDS,
    OpenShopAiTaskRegistry,
    OpenShopAiValidationError,
    build_capability_catalog,
    build_ocr_prompt,
    normalize_ai_task_record,
    normalize_art_font_result,
    normalize_art_font_snapshot,
    normalize_generation_snapshot,
    is_standard_generation_size,
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
assert "art-font-restore" in OPENSHOP_AI_TOOL_IDS
assert "art-font-restore" not in OPENSHOP_GENERATIVE_TOOL_IDS
art_tool = catalog["tools"]["art-font-restore"]
assert art_tool["capability"] == "masked-local-redraw"
assert art_tool["providers"] == remove_providers
assert art_tool["providers"] is not remove_providers
assert art_tool["providers"][0] is not remove_providers[0]
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

for size in ("1024x1024", "3840x2160", "1648x3840"):
    assert is_standard_generation_size(size) is True
for size in ("auto", "63x64", "5000x5000", "3840*2160"):
    assert is_standard_generation_size(size) is False

prompt = build_ocr_prompt(1920, 1080)
assert "1920" in prompt and "1080" in prompt
assert "quad" in prompt and "confidence" in prompt
assert "中文" in prompt and "English" in prompt
for field in (
    "script", "dominantScript", "artistic", "familyCandidates", "size", "weight",
    "style", "styleDescription", "letterSpacing", "lineHeight", "fill", "color",
    "align", "rotation", "strokeColor", "strokeWidth", "shadow", "blur",
    "offsetX", "offsetY",
):
    assert field in prompt, f"OCR prompt must request {field}"
assert "thousandths of an em" in prompt
assert "lineHeight" in prompt and "ratio" in prompt
assert "source-image pixels" in prompt

def ocr_run(text, script="en", style=None):
    return {
        "start": 0,
        "end": len(list(text)),
        "script": script,
        **(style or {}),
    }

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
            "script": "mixed",
            "dominantScript": "zh-hant",
            "confidence": 0.62,
            "runs": [ocr_run("中文 English", "mixed", {
                "artistic": True,
                "familyCandidates": ["Microsoft YaHei UI", "Arial"],
                "size": 48,
                "weight": 760,
                "style": "italic",
                "styleDescription": "hand-painted condensed display lettering",
                "letterSpacing": 125,
                "lineHeight": 1.4,
                "strokeColor": "#ABCDEF88",
                "strokeWidth": 3.5,
                "shadow": {
                    "color": "#11223344",
                    "blur": 6,
                    "offsetX": 2,
                    "offsetY": -3,
                },
            })],
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
            "runs": [ocr_run("Second line")],
        },
        {
            "text": "Independent defaults",
            "bbox": {"x": 100, "y": 800, "width": 600, "height": 100},
            "script": "en",
            "confidence": 0.9,
            "runs": [ocr_run("Independent defaults", "en", {
                "familyCandidates": ["Arial"],
                "size": "bad",
                "weight": 760,
                "style": "italic",
                "letterSpacing": "bad",
                "lineHeight": "bad",
                "strokeColor": "#123456",
                "strokeWidth": "bad",
                "shadow": {
                    "color": "#abcdef88",
                    "blur": "bad",
                    "offsetX": 5,
                    "offsetY": "bad",
                },
            })],
            "color": "rgb(1, 2, 3)",
        },
        {
            "text": "Independent colors",
            "bbox": {"x": 800, "y": 800, "width": 600, "height": 100},
            "script": "invalid-script",
            "confidence": 0.9,
            "runs": [ocr_run("Independent colors", "en", {
                "strokeColor": "#fff",
                "strokeWidth": 4,
                "shadow": {"color": "red", "blur": 8, "offsetX": -2, "offsetY": 3},
            })],
            "color": "#A1B2C3D4",
        },
    ]
}, ensure_ascii=False)
layout = normalize_ocr_layout(valid, width=1920, height=1080)
assert layout["schemaVersion"] == 5
assert layout["width"] == 1920 and layout["height"] == 1080
assert layout["blocks"][0]["text"] == "中文 English"
assert layout["blocks"][0]["quad"][2] == {"x": 0.4, "y": 0.2}
assert layout["blocks"][0]["lowConfidence"] is True
assert layout["blocks"][0]["script"] == "mixed"
assert layout["blocks"][0]["dominantScript"] == "zh-hant"
assert [
    (run["start"], run["end"], run["script"])
    for run in layout["blocks"][0]["runs"]
] == [(0, 3, "zh-hans"), (3, 10, "en")]
expected_first_run_style = {
    "artistic": True,
    "familyCandidates": ["Microsoft YaHei UI", "Arial"],
    "size": 48.0,
    "weight": 800,
    "style": "italic",
    "styleDescription": "hand-painted condensed display lettering",
    "color": "#ffffff",
    "letterSpacing": 125.0,
    "lineHeight": 1.4,
    "strokeColor": "#abcdef88",
    "strokeWidth": 3.5,
    "shadow": {"color": "#11223344", "blur": 6.0, "offsetX": 2.0, "offsetY": -3.0},
}
for run in layout["blocks"][0]["runs"]:
    assert {
        key: value for key, value in run.items()
        if key not in {"start", "end", "script"}
    } == expected_first_run_style
assert layout["blocks"][1]["quad"][0] == {"x": 0.5, "y": 0.5}
assert layout["blocks"][1]["quad"][2] == {"x": 0.75, "y": 0.6}
assert layout["blocks"][1]["confidence"] == 1.0
assert layout["blocks"][1]["script"] == "en"
assert "dominantScript" not in layout["blocks"][1]
assert layout["blocks"][2]["runs"][0] == {
    "start": 0,
    "end": len("Independent defaults"),
    "script": "en",
    "artistic": False,
    "familyCandidates": ["Arial"],
    "size": 0.0,
    "weight": 800,
    "style": "italic",
    "styleDescription": "",
    "color": "#ffffff",
    "letterSpacing": 0.0,
    "lineHeight": 1.16,
    "strokeColor": "#123456",
    "strokeWidth": 0.0,
    "shadow": {"color": "#abcdef88", "blur": 0.0, "offsetX": 5.0, "offsetY": 0.0},
}
assert layout["blocks"][2]["color"] == "#ffffff"
assert layout["blocks"][3]["script"] == "mixed"
assert layout["blocks"][3]["color"] == "#a1b2c3d4"
assert layout["blocks"][3]["runs"][0]["strokeColor"] == "#00000000"
assert layout["blocks"][3]["runs"][0]["strokeWidth"] == 4.0
assert layout["blocks"][3]["runs"][0]["shadow"] == {
    "color": "#00000000", "blur": 8.0, "offsetX": -2.0, "offsetY": 3.0,
}

mixed = json.dumps({
    "blocks": [
        {"text": "Keep this block", "bbox": {"x": 10, "y": 10, "width": 200, "height": 40},
         "runs": [ocr_run("Keep this block")]},
        {
            "text": "FULL OCR TEXT MUST NOT APPEAR IN WARNINGS",
            "quad": [{"x": -1, "y": 0}] * 4,
        },
        {
            "text": "\u0000\u0001",
            "bbox": {"x": 10, "y": 60, "width": 200, "height": 40},
            "confidence": 0.8,
        },
        {
            "text": "Bad confidence must be skipped",
            "bbox": {"x": 10, "y": 110, "width": 200, "height": 40},
            "confidence": "not-a-number",
        },
        {"text": "Keep this block too", "bbox": {"x": 10, "y": 160, "width": 200, "height": 40},
         "runs": [ocr_run("Keep this block too")]},
    ],
}, ensure_ascii=False)
mixed_layout = normalize_ocr_layout(mixed, width=800, height=600)
assert [block["text"] for block in mixed_layout["blocks"]] == [
    "Keep this block", "Keep this block too",
]
assert [warning["blockIndex"] for warning in mixed_layout["warnings"]] == [1, 2, 3]
assert [warning["code"] for warning in mixed_layout["warnings"]] == [
    "invalid_geometry", "invalid_text", "invalid_confidence",
]
assert len(mixed_layout["warnings"]) <= 50
assert "FULL OCR TEXT MUST NOT APPEAR IN WARNINGS" not in json.dumps(
    mixed_layout["warnings"], ensure_ascii=False,
)

warning_bound = normalize_ocr_layout(json.dumps({
    "blocks": [
        {"text": "Keep one", "bbox": {"x": 10, "y": 10, "width": 20, "height": 20},
         "runs": [ocr_run("Keep one")]},
        *[
            {
                "text": f"secret invalid block {index}",
                "bbox": {"x": 10, "y": 40, "width": 20, "height": 20},
                "confidence": "invalid",
            }
            for index in range(60)
        ],
    ]
}), width=800, height=600)
assert len(warning_bound["blocks"]) == 1
assert len(warning_bound["warnings"]) == 50
assert warning_bound["warnings"][-1] == {
    "code": "additional_invalid_blocks",
    "count": 11,
}
assert "secret invalid block" not in json.dumps(warning_bound["warnings"])

limited = normalize_ocr_layout(json.dumps({
    "blocks": [
        {"text": f"line {index}", "bbox": {"x": 10, "y": 10, "width": 20, "height": 20},
         "runs": [ocr_run(f"line {index}")]}
        for index in range(501)
    ]
}), width=800, height=600)
assert len(limited["blocks"]) == 500
assert limited["warnings"] == []

for invalid in (
    "just plain text without coordinates",
    json.dumps({"blocks": []}),
    json.dumps({"blocks": [{"text": "No location"}]}),
    json.dumps({"blocks": [{"text": "Out", "quad": [{"x": -1, "y": 0}] * 4}]}),
    json.dumps({"blocks": [{"text": "", "bbox": {"x": 1, "y": 1, "width": 10, "height": 10}}]}),
):
    try:
        normalize_ocr_layout(invalid, width=1920, height=1080)
        raise AssertionError("invalid OCR layout should fail")
    except OpenShopAiValidationError:
        pass

original_normalize_block = openshop_ai_module._normalize_block
openshop_ai_module._normalize_block = lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("system failure"))
try:
    try:
        normalize_ocr_layout(json.dumps({
            "blocks": [{"text": "System error", "bbox": {"x": 10, "y": 10, "width": 20, "height": 20}}]
        }), width=800, height=600)
        raise AssertionError("system exceptions must not be swallowed")
    except RuntimeError:
        pass
finally:
    openshop_ai_module._normalize_block = original_normalize_block

ocr_record = normalize_ai_task_record({
    "taskId": "task-ocr-v2",
    "toolId": "text-extract",
    "status": "succeeded",
    "sourceAssetId": "f" * 64,
    "result": layout,
})
assert ocr_record["result"] == layout

mixed_ocr_record = normalize_ai_task_record({
    "taskId": "task-ocr-mixed",
    "toolId": "text-extract",
    "status": "succeeded",
    "sourceAssetId": "d" * 64,
    "result": mixed_layout,
})
assert mixed_ocr_record["result"] == mixed_layout

legacy_record = normalize_ai_task_record({
    "taskId": "task-ocr-v1",
    "toolId": "text-extract",
    "status": "succeeded",
    "sourceAssetId": "e" * 64,
    "result": {
        "schemaVersion": 1,
        "width": 800,
        "height": 600,
        "blocks": [{
            "id": "legacy-title",
            "text": "繁體標題",
            "bbox": {"x": 80, "y": 60, "width": 320, "height": 72},
            "language": "zh",
            "confidence": 0.88,
            "font": {
                "familyCandidates": ["Legacy Serif"],
                "size": 36,
                "weight": 400,
                "style": "normal",
            },
            "color": "#ABCDEF",
            "align": "right",
            "rotation": 12,
            "paragraphId": "legacy-p1",
            "lineIndex": 0,
        }],
    },
})
assert legacy_record["result"]["schemaVersion"] == 5
legacy_block = legacy_record["result"]["blocks"][0]
assert legacy_block["script"] == "zh-hant"
assert "dominantScript" not in legacy_block
assert legacy_block["color"] == "#abcdef"
assert legacy_block["align"] == "right"
assert legacy_block["rotation"] == 12
assert legacy_block["runs"] == [{
    "start": 0,
    "end": len("繁體標題"),
    "script": "zh-hant",
    "artistic": False,
    "familyCandidates": ["Legacy Serif"],
    "size": 36.0,
    "weight": 400,
    "style": "normal",
    "styleDescription": "",
    "color": "#abcdef",
    "letterSpacing": 0.0,
    "lineHeight": 1.16,
    "strokeColor": "#00000000",
    "strokeWidth": 0.0,
    "shadow": {"color": "#00000000", "blur": 0.0, "offsetX": 0.0, "offsetY": 0.0},
}]

weight_boundaries = normalize_ocr_layout(json.dumps({
    "blocks": [
        {
            "text": "Below minimum",
            "bbox": {"x": 10, "y": 10, "width": 200, "height": 40},
            "confidence": 1,
            "runs": [ocr_run("Below minimum", "en", {"weight": -50})],
        },
        {
            "text": "Above maximum",
            "bbox": {"x": 10, "y": 60, "width": 200, "height": 40},
            "confidence": 1,
            "runs": [ocr_run("Above maximum", "en", {"weight": 1200})],
        },
    ],
}), width=800, height=600)
assert [block["runs"][0]["weight"] for block in weight_boundaries["blocks"]] == [100, 900]

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

art_snapshot_input = {
    "textLayerId": "hstar_text_layer_1",
    "ocrBlockId": "ocr-title",
    "originalText": "夏季限定",
    "currentText": "  夏日新品\n第二行  ",
    "requestGeneration": 3,
    "document": {"width": 1920, "height": 1080},
    "quad": [
        {"x": 0.1, "y": 0.2}, {"x": 0.4, "y": 0.2},
        {"x": 0.4, "y": 0.3}, {"x": 0.1, "y": 0.3},
    ],
    "visualProfile": {
        "script": "mixed",
        "dominantScript": "zh-hant",
        "fill": "#7B3F12cc",
        "alignment": "center",
        "rotation": 12.25,
        "familyCandidates": ["Poster Sans"],
        "size": 72,
        "weight": 760,
        "style": "italic",
        "artistic": True,
        "styleDescription": "inflated hand-painted lettering",
        "letterSpacing": 20,
        "lineHeight": 1.0,
        "strokeColor": "#FFFFFF",
        "strokeWidth": 4,
        "shadow": {"color": "#00000080", "blur": 8, "offsetX": 3, "offsetY": 5},
    },
}
art_snapshot = normalize_art_font_snapshot(art_snapshot_input)
assert art_snapshot["currentText"] == "  夏日新品\n第二行  "
assert art_snapshot["originalText"] == "夏季限定"
assert art_snapshot["requestGeneration"] == 3
assert art_snapshot["quad"] == art_snapshot_input["quad"]
assert art_snapshot["visualProfile"] == {
    "script": "mixed",
    "dominantScript": "zh-hant",
    "writingMode": "horizontal",
    "fill": "#7b3f12cc",
    "alignment": "center",
    "rotation": 12.25,
    "artistic": True,
    "familyCandidates": ["Poster Sans"],
    "size": 72.0,
    "weight": 800,
    "style": "italic",
    "styleDescription": "inflated hand-painted lettering",
    "letterSpacing": 20.0,
    "lineHeight": 1.0,
    "strokeColor": "#ffffff",
    "strokeWidth": 4.0,
    "shadow": {"color": "#00000080", "blur": 8.0, "offsetX": 3.0, "offsetY": 5.0},
}
assert normalize_art_font_snapshot({
    **art_snapshot_input,
    "visualProfile": {**art_snapshot_input["visualProfile"], "artistic": False},
})["visualProfile"]["artistic"] is False

for invalid_art_snapshot in (
    {**art_snapshot_input, "textLayerId": ""},
    {**art_snapshot_input, "ocrBlockId": "bad id"},
    {**art_snapshot_input, "originalText": None},
    {**art_snapshot_input, "currentText": " \n\t "},
    {**art_snapshot_input, "requestGeneration": True},
    {**art_snapshot_input, "requestGeneration": 1.5},
    {**art_snapshot_input, "requestGeneration": "3"},
    {**art_snapshot_input, "requestGeneration": 0},
    {**art_snapshot_input, "document": {"width": 0, "height": 1080}},
    {**art_snapshot_input, "quad": [
        {"x": 0.1, "y": 0.2}, {"x": float("nan"), "y": 0.2},
        {"x": 0.4, "y": 0.3}, {"x": 0.1, "y": 0.3},
    ]},
    {**art_snapshot_input, "quad": [
        {"x": 10, "y": 20}, {"x": 40, "y": 20},
        {"x": 40, "y": 30}, {"x": 10, "y": 30},
    ]},
    {**art_snapshot_input, "quad": [
        {"x": 0.1, "y": 0.2}, {"x": 0.4, "y": 0.3},
        {"x": 0.4, "y": 0.2}, {"x": 0.1, "y": 0.3},
    ]},
    {**art_snapshot_input, "quad": [
        {"x": 0.1, "y": 0.2}, {"x": 0.1, "y": 0.2},
        {"x": 0.4, "y": 0.3}, {"x": 0.1, "y": 0.3},
    ]},
    {**art_snapshot_input, "quad": [
        {"x": 0.1, "y": 0.2}, {"x": 0.25, "y": 0.2},
        {"x": 0.4, "y": 0.2}, {"x": 0.1, "y": 0.3},
    ]},
    {**art_snapshot_input, "quad": [
        {"x": 0.1, "y": 0.2}, {"x": 0.4, "y": 0.2},
        {"x": 0.2, "y": 0.25}, {"x": 0.1, "y": 0.3},
    ]},
):
    try:
        normalize_art_font_snapshot(invalid_art_snapshot)
        raise AssertionError("invalid art font snapshot should fail")
    except OpenShopAiValidationError:
        pass

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
art_client_request_id = "art-font-request.project-a.node-a.text-layer-1.3"
art_task, art_task_created = registry.create_or_get(
    "project-a", owner_a, "art-font-restore", "vision", "gemini-3-pro-image",
    "d" * 64, source_layer_id="source-layer-1", snapshot=art_snapshot_input,
    client_request_id=art_client_request_id,
)
duplicate_art_task, duplicate_art_task_created = registry.create_or_get(
    "project-a", owner_a, "art-font-restore", "vision", "gemini-3-pro-image",
    "d" * 64, source_layer_id="source-layer-1", snapshot=art_snapshot_input,
    client_request_id=art_client_request_id,
)
assert art_task_created is True
assert duplicate_art_task_created is False
assert duplicate_art_task["taskId"] == art_task["taskId"]
assert duplicate_art_task["clientRequestId"] == art_client_request_id
art_snapshot_input["currentText"] = "mutated after create"
art_snapshot_input["visualProfile"]["weight"] = 100
stored_art_task = registry.get(art_task["taskId"], "project-a", owner_a)
assert stored_art_task["sourceLayerId"] == "source-layer-1"
assert stored_art_task["snapshot"] == art_snapshot
assert registry.mark_running(art_task["taskId"]) is True
assert registry.succeed(art_task["taskId"], {
    "assetId": "9" * 64,
    "url": "/api/openshop/assets/" + "9" * 64,
    "name": "art-font.png",
    "mime": "image/png",
    "width": 360,
    "height": 120,
    "placementBox": {"x": 10, "y": 5, "width": 360, "height": 120},
}) is True
normalized_art_task = normalize_ai_task_record(
    registry.get(art_task["taskId"], "project-a", owner_a)
)
assert normalized_art_task["snapshot"] == art_snapshot
assert normalized_art_task["sourceLayerId"] == "source-layer-1"
assert normalized_art_task["clientRequestId"] == art_client_request_id
assert normalized_art_task["creationState"] == "created"
assert normalized_art_task["outputAssetId"] == "9" * 64
assert normalized_art_task["result"] == {
    "assetId": "9" * 64,
    "url": "/api/openshop/assets/" + "9" * 64,
    "name": "art-font.png",
    "mime": "image/png",
    "width": 360,
    "height": 120,
    "placementBox": {"x": 10, "y": 5, "width": 360, "height": 120},
}
reconciled_art_task = normalize_ai_task_record({
    **normalized_art_task,
    "context": {**owner_a, "projectId": "project-a"},
    "owner": owner_a,
    "reconcileState": "applied",
    "reconcileReason": "",
    "generatedLayerId": "generated-layer-1",
    "appliedAt": 1234,
    "staleAt": 0,
    "discardedAt": 0,
})
assert reconciled_art_task["context"] == {**owner_a, "projectId": "project-a"}
assert reconciled_art_task["owner"] == owner_a
assert reconciled_art_task["reconcileState"] == "applied"
assert reconciled_art_task["reconcileReason"] == ""
assert reconciled_art_task["generatedLayerId"] == "generated-layer-1"
assert reconciled_art_task["appliedAt"] == 1234
assert reconciled_art_task["staleAt"] == 0
assert reconciled_art_task["discardedAt"] == 0

strict_art_result = normalized_art_task["result"]
for dimension in ("width", "height"):
    for invalid_number in (True, str(strict_art_result[dimension]), float(strict_art_result[dimension])):
        try:
            normalize_art_font_result({**strict_art_result, dimension: invalid_number})
            raise AssertionError(f"art result {dimension} must require a true integer")
        except OpenShopAiValidationError:
            pass
for box_field in ("x", "y", "width", "height"):
    for invalid_number in (
        True,
        str(strict_art_result["placementBox"][box_field]),
        float(strict_art_result["placementBox"][box_field]),
    ):
        try:
            normalize_art_font_result({
                **strict_art_result,
                "placementBox": {
                    **strict_art_result["placementBox"],
                    box_field: invalid_number,
                },
            })
            raise AssertionError(f"art result placementBox {box_field} must require a true integer")
        except OpenShopAiValidationError:
            pass

# Existing single-task records retain their original public shape.
legacy_single = registry.create(
    "project-a", owner_a, "text-remove", "vision", "gemini-3-pro-image", "c" * 64,
)
assert "snapshot" not in legacy_single and "sourceLayerId" not in legacy_single
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
