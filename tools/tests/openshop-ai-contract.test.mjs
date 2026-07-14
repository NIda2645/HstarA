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
    OpenShopAiValidationError,
    build_capability_catalog,
    build_ocr_prompt,
    normalize_ai_task_record,
    normalize_ocr_layout,
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
