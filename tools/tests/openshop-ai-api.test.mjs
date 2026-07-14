import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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
  : [{command:'python3', args:[]}, {command:'python', args:[]}];

const python = candidates.find(candidate => {
  const probe = spawnSync(candidate.command, [...candidate.args, '-X', 'utf8', '-c', 'import fastapi, httpx, PIL'], {
    cwd:repoRoot,
    encoding:'utf8',
    env:{...process.env, PYTHONIOENCODING:'utf-8', PYTHONUTF8:'1'},
  });
  return !probe.error && probe.status === 0;
});
assert.ok(python, 'A Python interpreter with HstarA dependencies is required');

const harness = String.raw`
import asyncio
import base64
import io
import json
import os
import sys
from pathlib import Path

import httpx
from fastapi import HTTPException
from PIL import Image

sys.path.insert(0, os.getcwd())


def png_bytes(color=(60, 100, 180, 255), size=(96, 64)):
    output = io.BytesIO()
    Image.new("RGBA", size, color).save(output, format="PNG")
    return output.getvalue()


async def wait_for_terminal(client, project_id, task_id, owner, timeout=3.0):
    deadline = asyncio.get_running_loop().time() + timeout
    params = {
        "canvas_type": owner["canvasType"],
        "canvas_id": owner["canvasId"],
        "node_id": owner["nodeId"],
    }
    while asyncio.get_running_loop().time() < deadline:
        response = await client.get(
            f"/api/openshop/projects/{project_id}/ai-tasks/{task_id}",
            params=params,
        )
        assert response.status_code == 200, response.text
        task = response.json()["task"]
        if task["status"] in {"succeeded", "failed", "cancelled"}:
            return task
        await asyncio.sleep(0.01)
    raise AssertionError(f"OpenShop AI task did not finish: {task_id}")


async def run():
    import main

    provider = {
        "id": "vision",
        "name": "Vision API",
        "enabled": True,
        "primary": True,
        "has_key": True,
        "protocol": "openai",
        "chat_models": ["gemini-3.1-pro-high"],
        "image_models": ["gemini-3-pro-image"],
    }
    main.public_api_providers = lambda: [dict(provider)]
    main.get_primary_provider_id = lambda providers=None: "vision"

    def exact_provider(provider_id):
        if provider_id != "vision":
            raise HTTPException(status_code=400, detail="未找到 API 平台")
        return dict(provider)

    main.get_api_provider_exact = exact_provider
    main.get_api_provider = exact_provider

    transport = httpx.ASGITransport(app=main.app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        owner = {"canvasType":"classic", "canvasId":"canvas-ai", "nodeId":"node-a"}
        init = await client.post(
            "/api/openshop/projects/project-ai/initialize",
            json={"owner":owner, "document":{"width":96, "height":64}},
        )
        assert init.status_code == 200, init.text
        upload = await client.post(
            "/api/openshop/projects/project-ai/assets",
            data={
                "canvas_type":owner["canvasType"],
                "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
                "role":"ai-source",
            },
            files={"file":("source.png", png_bytes(), "image/png")},
        )
        assert upload.status_code == 200, upload.text
        source_asset_id = upload.json()["asset"]["assetId"]

        catalog_response = await client.get("/api/openshop/ai/catalog")
        assert catalog_response.status_code == 200, catalog_response.text
        catalog = catalog_response.json()
        catalog_text = json.dumps(catalog, ensure_ascii=False).lower()
        assert "api_key" not in catalog_text and "key_preview" not in catalog_text
        assert catalog["primaryProviderId"] == "vision"
        assert catalog["tools"]["text-extract"]["providers"][0]["models"][0]["id"] == "gemini-3.1-pro-high"

        invalid_model = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-extract",
                "source_asset_id":source_asset_id,
                "provider_id":"vision",
                "model_id":"floating-label-only",
                "mode":"layer",
            },
        )
        assert invalid_model.status_code == 400
        assert "配置不可用" in invalid_model.text

        ocr_payload = {
            "blocks":[{
                "text":"中文 English",
                "quad":[
                    {"x":0.1,"y":0.1}, {"x":0.7,"y":0.1},
                    {"x":0.7,"y":0.3}, {"x":0.1,"y":0.3},
                ],
                "language":"mixed",
                "confidence":0.66,
                "font":{"familyCandidates":["Microsoft YaHei UI"],"size":18,"weight":500},
                "color":"#112233",
                "align":"left",
                "rotation":0,
                "paragraphId":"p1",
                "lineIndex":0,
            }]
        }

        async def fake_canvas_llm(payload):
            assert payload.provider == "vision"
            assert payload.model == "gemini-3.1-pro-high"
            assert payload.images and payload.images[0].startswith("data:image/")
            return {"text":json.dumps(ocr_payload, ensure_ascii=False), "model":payload.model}

        main.canvas_llm = fake_canvas_llm
        created = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-extract",
                "source_asset_id":source_asset_id,
                "provider_id":"vision",
                "model_id":"gemini-3.1-pro-high",
                "mode":"layer",
            },
        )
        assert created.status_code == 200, created.text
        extract_task = await wait_for_terminal(client, "project-ai", created.json()["task_id"], owner)
        assert extract_task["status"] == "succeeded", extract_task
        assert extract_task["result"]["blocks"][0]["text"] == "中文 English"
        assert extract_task["result"]["blocks"][0]["lowConfidence"] is True

        wrong_owner = await client.get(
            f"/api/openshop/projects/project-ai/ai-tasks/{created.json()['task_id']}",
            params={"canvas_type":"classic", "canvas_id":"canvas-ai", "node_id":"node-b"},
        )
        assert wrong_owner.status_code == 403

        async def plain_text_llm(payload):
            return {"text":"Only text, no coordinates", "model":payload.model}

        main.canvas_llm = plain_text_llm
        plain = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-extract",
                "source_asset_id":source_asset_id,
                "provider_id":"vision",
                "model_id":"gemini-3.1-pro-high",
                "mode":"layer",
            },
        )
        plain_task = await wait_for_terminal(client, "project-ai", plain.json()["task_id"], owner)
        assert plain_task["status"] == "failed"
        assert "可靠文字位置" in plain_task["error"] or "structured" in plain_task["error"]

        generated_bytes = png_bytes((20, 170, 90, 255))

        async def fake_generate(prompt, size, quality, model, reference_images=None, provider_id=""):
            assert provider_id == "vision" and model == "gemini-3-pro-image"
            assert size == "96x64"
            assert reference_images and reference_images[0]["role"] == "source"
            return {
                "type":"b64",
                "value":base64.b64encode(generated_bytes).decode("ascii"),
                "mime_type":"image/png",
            }, {"id":"fake-image-request"}

        main.generate_ai_image = fake_generate
        removed = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-remove",
                "source_asset_id":source_asset_id,
                "provider_id":"vision",
                "model_id":"gemini-3-pro-image",
                "mode":"layer",
                "options":{"quality":"high", "prompt":"Preserve poster texture."},
            },
        )
        assert removed.status_code == 200, removed.text
        remove_task = await wait_for_terminal(client, "project-ai", removed.json()["task_id"], owner)
        assert remove_task["status"] == "succeeded", remove_task
        assert remove_task["result"]["assetId"]
        output = await client.get(remove_task["result"]["url"])
        assert output.status_code == 200 and output.content == generated_bytes

        release = asyncio.Event()

        async def stubborn_generate(*args, **kwargs):
            try:
                await release.wait()
            except asyncio.CancelledError:
                await release.wait()
            return {
                "type":"b64",
                "value":base64.b64encode(png_bytes((240, 30, 30, 255))).decode("ascii"),
                "mime_type":"image/png",
            }, {}

        main.generate_ai_image = stubborn_generate
        pending = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-remove",
                "source_asset_id":source_asset_id,
                "provider_id":"vision",
                "model_id":"gemini-3-pro-image",
                "mode":"layer",
            },
        )
        pending_id = pending.json()["task_id"]
        await asyncio.sleep(0.02)
        cancelled = await client.delete(
            f"/api/openshop/projects/project-ai/ai-tasks/{pending_id}",
            params={
                "canvas_type":owner["canvasType"],
                "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
            },
        )
        assert cancelled.status_code == 200, cancelled.text
        assert cancelled.json()["task"]["status"] == "cancelled"
        release.set()
        await asyncio.sleep(0.05)
        cancelled_task = await wait_for_terminal(client, "project-ai", pending_id, owner)
        assert cancelled_task["status"] == "cancelled"
        assert not cancelled_task.get("result")

        delete_release = asyncio.Event()

        async def delete_waiting_generate(*args, **kwargs):
            await delete_release.wait()
            return {
                "type":"b64",
                "value":base64.b64encode(generated_bytes).decode("ascii"),
                "mime_type":"image/png",
            }, {}

        main.generate_ai_image = delete_waiting_generate
        deleting = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-remove",
                "source_asset_id":source_asset_id,
                "provider_id":"vision",
                "model_id":"gemini-3-pro-image",
                "mode":"layer",
            },
        )
        assert deleting.status_code == 200
        deleted = await client.delete(
            "/api/openshop/projects/project-ai",
            params={
                "canvas_type":owner["canvasType"],
                "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
            },
        )
        assert deleted.status_code == 200 and deleted.json()["deleted"] is True
        await asyncio.sleep(0.02)
        assert main.OPENSHOP_AI_TASKS.active_for_project("project-ai") == 0

    print("OpenShop AI API tests passed")


asyncio.run(run())
`;

const root = mkdtempSync(join(tmpdir(), 'hstara-openshop-ai-api-'));
const script = join(root, 'openshop_ai_api_harness.py');
writeFileSync(script, harness, 'utf8');
const result = spawnSync(python.command, [...python.args, '-X', 'utf8', script], {
  cwd:repoRoot,
  encoding:'utf8',
  env:{
    ...process.env,
    HSTAR_DATA_DIR:root,
    PYTHONIOENCODING:'utf-8',
    PYTHONUTF8:'1',
  },
  timeout:60_000,
});
rmSync(root, {recursive:true, force:true});

assert.equal(result.status, 0, result.stderr || result.stdout || 'OpenShop AI API harness failed');
console.log(result.stdout.trim());
