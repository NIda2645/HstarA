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


def mask_bytes(size=(96, 64), bounds=(10, 8, 40, 24)):
    image = Image.new("L", size, 0)
    x, y, width, height = bounds
    for py in range(y, y + height):
        for px in range(x, x + width):
            image.putpixel((px, py), 255)
    output = io.BytesIO()
    image.save(output, format="PNG")
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
        if task["status"] in {"succeeded", "partial", "failed", "cancelled"}:
            return task
        await asyncio.sleep(0.01)
    raise AssertionError(f"OpenShop AI task did not finish: {task_id}")


async def run():
    import main
    from openshop_ai import OpenShopAiTaskRegistry

    asyncio.get_running_loop().set_debug(True)
    threaded_registry = OpenShopAiTaskRegistry()
    threaded_owner = {
        "canvasType":"classic",
        "canvasId":"canvas-threaded-cancel",
        "nodeId":"node-threaded-cancel",
    }
    threaded_record = threaded_registry.create(
        "project-threaded-cancel",
        threaded_owner,
        "text-remove",
        "vision",
        "test-model",
        "c" * 64,
    )
    threaded_future = asyncio.get_running_loop().create_future()
    threaded_future.add_done_callback(lambda _future: None)
    threaded_registry.bind(threaded_record["taskId"], threaded_future)
    await asyncio.to_thread(
        threaded_registry.cancel_project,
        "project-threaded-cancel",
        threaded_owner,
    )
    await asyncio.sleep(0)
    assert threaded_future.cancelled()
    assert threaded_registry.get(
        threaded_record["taskId"], "project-threaded-cancel", threaded_owner
    )["status"] == "cancelled"

    provider = {
        "id": "vision",
        "name": "Vision API",
        "enabled": True,
        "primary": True,
        "has_key": True,
        "protocol": "openai",
        "chat_models": ["gemini-3.1-pro-high"],
        "image_models": ["gemini-3-pro-image", "no-image-input-model"],
        "image_model_capabilities": {
            "gemini-3-pro-image": {
                "supportsMask": True,
                "supportsMultiReference": True,
                "maxReferenceImages": 12,
                "maxOutputs": 6,
                "sizes": ["auto", "96x64"],
                "qualities": ["auto", "high"],
            },
            "no-image-input-model": {
                "supportsImageInput": False,
                "supportsMask": False,
                "supportsMultiReference": False,
                "maxReferenceImages": 1,
                "maxOutputs": 1,
                "sizes": ["auto"],
                "qualities": ["auto", "high"],
            },
        },
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
        canvas = main.new_canvas("OpenShop AI API test", "layers", "classic")
        owner = {"canvasType":"classic", "canvasId":canvas["id"], "nodeId":"node-a"}
        init = await client.post(
            "/api/openshop/projects/project-ai/initialize",
            json={"owner":owner, "document":{"width":96, "height":64}},
        )
        assert init.status_code == 200, init.text
        owner_b = {**owner, "nodeId":"node-b"}
        init_b = await client.post(
            "/api/openshop/projects/project-ai/initialize",
            json={"owner":owner_b, "document":{"width":96, "height":64}},
        )
        assert init_b.status_code == 200, init_b.text
        retry_owner = {**owner, "nodeId":"node-delete-retry"}
        retry_init = await client.post(
            "/api/openshop/projects/project-delete-retry/initialize",
            json={"owner":retry_owner, "document":{"width":96, "height":64}},
        )
        assert retry_init.status_code == 200, retry_init.text
        orphan_task = main.OPENSHOP_AI_TASKS.create(
            "project-delete-retry",
            retry_owner,
            "text-remove",
            "vision",
            "test-model",
            "d" * 64,
        )
        assert main.OPENSHOP_STORE.delete("project-delete-retry", retry_owner) is True
        retried_delete = await client.delete(
            "/api/openshop/projects/project-delete-retry",
            params={
                "canvas_type":retry_owner["canvasType"],
                "canvas_id":retry_owner["canvasId"],
                "node_id":retry_owner["nodeId"],
            },
        )
        assert retried_delete.status_code == 200, retried_delete.text
        assert retried_delete.json()["deleted"] is False
        assert main.OPENSHOP_AI_TASKS.get(
            orphan_task["taskId"], "project-delete-retry", retry_owner
        )["status"] == "cancelled"
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
        asset_head = await client.head(f"/api/openshop/assets/{source_asset_id}")
        assert asset_head.status_code == 200, asset_head.text
        assert asset_head.content == b""

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
            params={"canvas_type":"classic", "canvas_id":owner["canvasId"], "node_id":"node-b"},
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

        # Art-font materialization validates encoded data before and after
        # decode, preserves local model files, and applies bounded SSRF-safe
        # redirect/stream handling without writing temporary output files.
        assert "creates no temporary files" in (
            main.materialize_openshop_ai_image.__doc__ or ""
        )
        def materializer_files():
            roots = (Path(main.OUTPUT_DIR), Path(main.OPENSHOP_STORE.root))
            return {
                (str(path.resolve()), path.stat().st_size)
                for root in roots
                for path in root.rglob("*")
                if path.is_file()
            }

        temp_factory_calls = []
        original_temp_factories = {
            name:getattr(main.tempfile, name)
            for name in ("mkstemp", "mkdtemp", "NamedTemporaryFile")
        }

        def forbidden_temp_factory(*_args, **_kwargs):
            temp_factory_calls.append(True)
            raise AssertionError("art-font materialization must remain fully in-memory")

        for name in original_temp_factories:
            setattr(main.tempfile, name, forbidden_temp_factory)

        async def materialize_without_temp(image_data):
            files_before = materializer_files()
            calls_before = len(temp_factory_calls)
            try:
                return await main.materialize_openshop_ai_image(image_data)
            finally:
                assert materializer_files() == files_before
                assert len(temp_factory_calls) == calls_before

        assert await materialize_without_temp({
            "type":"b64",
            "value":base64.b64encode(generated_bytes).decode("ascii"),
            "mime_type":"image/png",
        }) == generated_bytes
        assert await materialize_without_temp({
            "type":"url",
            "value":"data:image/png;base64," + base64.b64encode(generated_bytes).decode("ascii"),
        }) == generated_bytes
        try:
            await materialize_without_temp({"type":"b64", "value":"not base64!"})
            raise AssertionError("invalid base64 should fail")
        except HTTPException as exc:
            assert exc.status_code in {400, 413, 502}

        original_materialize_limit = main.OPENSHOP_ART_FONT_MAX_BYTES
        original_fullmatch = main.re.fullmatch
        data_url_fullmatch_calls = 0
        try:
            main.OPENSHOP_ART_FONT_MAX_BYTES = 8
            try:
                await materialize_without_temp({
                    "type":"b64", "value":base64.b64encode(b"123456789").decode("ascii"),
                })
                raise AssertionError("oversized base64 should fail")
            except HTTPException as exc:
                assert exc.status_code == 413

            def counting_fullmatch(*args, **kwargs):
                nonlocal data_url_fullmatch_calls
                if len(args) > 1 and "," in str(args[1]):
                    data_url_fullmatch_calls += 1
                return original_fullmatch(*args, **kwargs)

            main.re.fullmatch = counting_fullmatch
            try:
                await materialize_without_temp({
                    "type":"url",
                    "value":"data:image/png;base64," + base64.b64encode(b"123456789").decode("ascii"),
                })
                raise AssertionError("oversized data URL should fail")
            except HTTPException as exc:
                assert exc.status_code == 413
            assert data_url_fullmatch_calls == 0, "oversized data URL must be bounded before regex parsing"
        finally:
            main.re.fullmatch = original_fullmatch
            main.OPENSHOP_ART_FONT_MAX_BYTES = original_materialize_limit

        local_fixture = Path(main.OUTPUT_OUTPUT_DIR) / "art-font-local-fixture.png"
        local_fixture.write_bytes(generated_bytes)
        try:
            local_url = main.output_url_for(local_fixture.name)
            assert await materialize_without_temp({
                "type":"url", "value":local_url,
            }) == generated_bytes
            assert local_fixture.is_file(), "materialization must not delete provider-owned local output"
            original_materialize_limit = main.OPENSHOP_ART_FONT_MAX_BYTES
            try:
                main.OPENSHOP_ART_FONT_MAX_BYTES = 8
                local_fixture.write_bytes(b"123456789")
                try:
                    await materialize_without_temp({"type":"url", "value":local_url})
                    raise AssertionError("oversized local output should fail")
                except HTTPException as exc:
                    assert exc.status_code == 413
                assert local_fixture.read_bytes() == b"123456789"
            finally:
                main.OPENSHOP_ART_FONT_MAX_BYTES = original_materialize_limit
        finally:
            local_fixture.unlink(missing_ok=True)

        try:
            await materialize_without_temp({
                "type":"url", "value":"http://127.0.0.1/private.png",
            })
            raise AssertionError("private remote destination should fail")
        except HTTPException as exc:
            assert exc.status_code in {400, 403, 502}

        class FakeSocket:
            def close(self):
                pass

        socket_targets = []
        tls_names = []
        original_create_connection = main.socket.create_connection
        original_ssl_context = main.ssl.create_default_context
        main.socket.create_connection = lambda target, **_kwargs: (
            socket_targets.append(target) or FakeSocket()
        )

        class FakeTlsContext:
            def wrap_socket(self, sock, server_hostname=None):
                tls_names.append(server_hostname)
                return sock

        main.ssl.create_default_context = lambda: FakeTlsContext()
        try:
            pinned_connection, pinned_target, pinned_host = (
                main._open_openshop_art_font_pinned_connection(
                    "https://public.example:8443/path/image.png?x=1",
                    "93.184.216.34",
                )
            )
            assert socket_targets == [("93.184.216.34", 8443)]
            assert tls_names == ["public.example"]
            assert pinned_target == "/path/image.png?x=1"
            assert pinned_host == "public.example:8443"
            pinned_connection.close()
        finally:
            main.socket.create_connection = original_create_connection
            main.ssl.create_default_context = original_ssl_context

        class FakePinnedResponse:
            def __init__(self, status=200, headers=None, chunks=()):
                self.status = status
                self._headers = list((headers or {}).items())
                self._chunks = list(chunks)

            def getheaders(self):
                return self._headers

            def read(self, amount=-1):
                if not self._chunks:
                    return b""
                chunk = self._chunks.pop(0)
                if amount >= 0 and len(chunk) > amount:
                    self._chunks.insert(0, chunk[amount:])
                    return chunk[:amount]
                return chunk

        class FakePinnedConnection:
            def __init__(self, response):
                self.response = response
                self.request_record = None

            def request(self, method, target, headers=None):
                self.request_record = (method, target, dict(headers or {}))

            def getresponse(self):
                return self.response

            def close(self):
                pass

        pinned_responses = []
        pinned_targets = []
        pinned_requests = []

        def fake_pinned_open(url, target_ip):
            pinned_targets.append(target_ip)
            parsed = main.urllib.parse.urlsplit(url)
            target = parsed.path or "/"
            if parsed.query:
                target += "?" + parsed.query
            default_port = 443 if parsed.scheme == "https" else 80
            host = parsed.hostname
            if parsed.port not in {None, default_port}:
                host += f":{parsed.port}"
            connection = FakePinnedConnection(pinned_responses.pop(0))
            original_request = connection.request

            def record_request(method, request_target, headers=None):
                original_request(method, request_target, headers)
                pinned_requests.append(connection.request_record)

            connection.request = record_request
            return connection, target, host

        original_pinned_open = main._open_openshop_art_font_pinned_connection
        original_getaddrinfo = main.socket.getaddrinfo
        original_materialize_limit = main.OPENSHOP_ART_FONT_MAX_BYTES
        try:
            main._open_openshop_art_font_pinned_connection = fake_pinned_open
            resolution_calls = 0

            def rebinding_resolver(*_args, **_kwargs):
                nonlocal resolution_calls
                resolution_calls += 1
                address = "93.184.216.34" if resolution_calls == 1 else "127.0.0.1"
                return [(main.socket.AF_INET, main.socket.SOCK_STREAM, 6, "", (address, 443))]

            main.socket.getaddrinfo = rebinding_resolver
            pinned_responses[:] = [
                FakePinnedResponse(200, {"content-length":"6"}, (b"abc", b"def")),
            ]
            assert await materialize_without_temp({
                "type":"url", "value":"https://public.example/rebinding.png",
            }) == b"abcdef"
            assert resolution_calls == 1
            assert pinned_targets == ["93.184.216.34"]
            assert pinned_requests[-1] == (
                "GET", "/rebinding.png", {
                    "Host":"public.example", "Accept":"image/*", "Connection":"close",
                },
            )

            main.socket.getaddrinfo = lambda *_args, **_kwargs: [
                (main.socket.AF_INET, main.socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443)),
            ]
            pinned_responses[:] = [
                FakePinnedResponse(302, {"location":"https://public.example/final.png"}),
                FakePinnedResponse(200, {"content-length":"6"}, (b"abc", b"def")),
            ]
            assert await materialize_without_temp({
                "type":"url", "value":"https://public.example/start.png",
            }) == b"abcdef"
            assert pinned_targets[-2:] == ["93.184.216.34", "93.184.216.34"]

            main.OPENSHOP_ART_FONT_MAX_BYTES = 5
            pinned_responses[:] = [
                FakePinnedResponse(200, {"content-length":"6"}, (b"abcdef",)),
            ]
            try:
                await materialize_without_temp({
                    "type":"url", "value":"https://public.example/large.png",
                })
                raise AssertionError("oversized Content-Length should fail")
            except HTTPException as exc:
                assert exc.status_code == 413

            pinned_responses[:] = [
                FakePinnedResponse(200, {}, (b"abc", b"def")),
            ]
            try:
                await materialize_without_temp({
                    "type":"url", "value":"https://public.example/stream.png",
                })
                raise AssertionError("oversized streamed body should fail")
            except HTTPException as exc:
                assert exc.status_code == 413

            main.OPENSHOP_ART_FONT_MAX_BYTES = original_materialize_limit
            pinned_responses[:] = [
                FakePinnedResponse(302, {"location":"http://127.0.0.1/private.png"}),
            ]
            try:
                await materialize_without_temp({
                    "type":"url", "value":"https://public.example/redirect.png",
                })
                raise AssertionError("redirect to private destination should fail")
            except HTTPException as exc:
                assert exc.status_code in {400, 403, 502}
        finally:
            main.OPENSHOP_ART_FONT_MAX_BYTES = original_materialize_limit
            main._open_openshop_art_font_pinned_connection = original_pinned_open
            main.socket.getaddrinfo = original_getaddrinfo
            for name, factory in original_temp_factories.items():
                setattr(main.tempfile, name, factory)

        owner_b_source_upload = await client.post(
            "/api/openshop/projects/project-ai/assets",
            data={
                "canvas_type":owner_b["canvasType"],
                "canvas_id":owner_b["canvasId"],
                "node_id":owner_b["nodeId"],
                "role":"ai-source",
            },
            files={"file":("other-source.png", png_bytes((15, 35, 55, 255)), "image/png")},
        )
        assert owner_b_source_upload.status_code == 200, owner_b_source_upload.text
        owner_b_source_id = owner_b_source_upload.json()["asset"]["assetId"]

        current_art_text = "  夏日新品\n第二行  "
        art_snapshot = {
            "textLayerId":"hstar_text_layer_1",
            "ocrBlockId":"ocr-title",
            "originalText":"夏季限定",
            "currentText":current_art_text,
            "requestGeneration":3,
            "document":{"width":96,"height":64},
            "quad":[
                {"x":0.25,"y":0.25}, {"x":0.75,"y":0.25},
                {"x":0.75,"y":0.5}, {"x":0.25,"y":0.5},
            ],
            "visualProfile":{
                "script":"mixed",
                "dominantScript":"zh-hans",
                "fill":"#7b3f12",
                "alignment":"center",
                "rotation":8,
                "familyCandidates":["Poster Sans"],
                "size":24,
                "weight":760,
                "style":"italic",
                "artistic":True,
                "styleDescription":"inflated hand-painted lettering",
                "letterSpacing":20,
                "lineHeight":1.1,
                "strokeColor":"#ffffff",
                "strokeWidth":2,
                "shadow":{"color":"#00000080","blur":4,"offsetX":2,"offsetY":3},
            },
        }
        art_request = {
            "owner":owner,
            "tool_id":"art-font-restore",
            "source_asset_id":source_asset_id,
            "provider_id":"vision",
            "model_id":"gemini-3-pro-image",
            "source_layer_id":"source-layer-1",
            "options":{"artFont":art_snapshot},
        }

        no_image_model = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={**art_request, "model_id":"no-image-input-model"},
        )
        assert no_image_model.status_code == 400, no_image_model.text
        assert "图" in no_image_model.text or "image" in no_image_model.text.lower()

        cross_project = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={**art_request, "source_asset_id":owner_b_source_id},
        )
        assert cross_project.status_code in {403, 404}, cross_project.text

        art_model_output = Image.new("RGBA", (8, 6), (0, 0, 0, 0))
        for y in range(2, 4):
            for x in range(3, 5):
                art_model_output.putpixel((x, y), (30 + x, 80 + y, 190, 255))
        art_buffer = io.BytesIO()
        art_model_output.save(art_buffer, format="PNG")
        art_model_bytes = art_buffer.getvalue()
        art_generation_calls = 0

        async def successful_art_generate(prompt, size, quality, model, reference_images=None, provider_id=""):
            nonlocal art_generation_calls
            art_generation_calls += 1
            assert provider_id == "vision" and model == "gemini-3-pro-image"
            assert size == "auto" and quality == "high"
            exact_quote = json.dumps(current_art_text, ensure_ascii=False)
            assert prompt.count(exact_quote) == 1
            assert "夏季限定" not in prompt
            for phrase in (
                "exactly", "once", "transparent", "size", "weight", "color",
                "angle", "stroke", "shadow", "artistic structure", "natural proportions",
            ):
                assert phrase in prompt, phrase
            assert len(reference_images) == 1
            reference = reference_images[0]
            assert reference["role"] == "style-reference"
            assert reference["mime"] == "image/png"
            encoded_reference = reference["url"].split(",", 1)[1]
            style_crop = Image.open(io.BytesIO(base64.b64decode(encoded_reference)))
            assert style_crop.size == (64, 32)
            return {
                "type":"b64",
                "value":base64.b64encode(art_model_bytes).decode("ascii"),
                "mime_type":"image/png",
            }, {"id":"art-font-request"}

        main.generate_ai_image = successful_art_generate
        art_created = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks", json=art_request,
        )
        assert art_created.status_code == 200, art_created.text
        art_task = await wait_for_terminal(
            client, "project-ai", art_created.json()["task_id"], owner,
        )
        assert art_task["status"] == "succeeded", art_task
        assert art_generation_calls == 1
        assert art_task["sourceLayerId"] == "source-layer-1"
        assert art_task["snapshot"]["currentText"] == current_art_text
        assert art_task["result"]["mime"] == "image/png"
        assert art_task["result"]["width"] == 6
        assert art_task["result"]["height"] == 2
        assert art_task["result"]["contentBox"] == {"x":2,"y":0,"width":2,"height":2}
        art_result_response = await client.get(art_task["result"]["url"])
        assert art_result_response.status_code == 200
        art_result_image = Image.open(io.BytesIO(art_result_response.content)).convert("RGBA")
        assert art_result_image.size == (6, 2)
        assert art_result_image.getpixel((0, 0))[3] == 0

        unsafe_output = Image.new("RGB", (8, 6), (255, 255, 255))
        for x in range(8):
            unsafe_output.putpixel((x, 0), (255, 0, 0) if x % 2 else (0, 0, 255))
            unsafe_output.putpixel((x, 5), (0, 255, 0) if x % 2 else (255, 255, 0))
        for y in range(1, 5):
            unsafe_output.putpixel((0, y), (255, 0, 255))
            unsafe_output.putpixel((7, y), (0, 255, 255))
        unsafe_buffer = io.BytesIO()
        unsafe_output.save(unsafe_buffer, format="PNG")
        unsafe_bytes = unsafe_buffer.getvalue()
        unsafe_calls = 0

        async def unsafe_art_generate(*_args, **_kwargs):
            nonlocal unsafe_calls
            unsafe_calls += 1
            return {
                "type":"b64",
                "value":base64.b64encode(unsafe_bytes).decode("ascii"),
                "mime_type":"image/png",
            }, {"id":"unsafe-art-font-request"}

        assets_before_unsafe = {path.name for path in Path(main.OPENSHOP_STORE.assets_dir).iterdir()}
        project_before_unsafe = main.OPENSHOP_STORE.load("project-ai", owner)
        main.generate_ai_image = unsafe_art_generate
        unsafe_created = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks", json=art_request,
        )
        assert unsafe_created.status_code == 200, unsafe_created.text
        unsafe_task = await wait_for_terminal(
            client, "project-ai", unsafe_created.json()["task_id"], owner,
        )
        assert unsafe_task["status"] == "failed", unsafe_task
        assert not unsafe_task.get("result")
        assert unsafe_calls == 1
        assert {path.name for path in Path(main.OPENSHOP_STORE.assets_dir).iterdir()} == assets_before_unsafe
        project_after_unsafe = main.OPENSHOP_STORE.load("project-ai", owner)
        assert project_after_unsafe["assetRefs"] == project_before_unsafe["assetRefs"]
        assert project_after_unsafe["pendingAssetRefs"] == project_before_unsafe["pendingAssetRefs"]

        # Cancellation after generation but before storage must trip the final
        # can-complete check and never call the storage function.
        pre_store_release = asyncio.Event()
        pre_store_calls = 0
        original_art_store = main.store_openshop_ai_png

        async def cancellation_resistant_art_generate(*_args, **_kwargs):
            try:
                await pre_store_release.wait()
            except asyncio.CancelledError:
                await pre_store_release.wait()
            return {
                "type":"b64",
                "value":base64.b64encode(art_model_bytes).decode("ascii"),
                "mime_type":"image/png",
            }, {}

        async def counting_art_store(*args, **kwargs):
            nonlocal pre_store_calls
            pre_store_calls += 1
            return await original_art_store(*args, **kwargs)

        main.generate_ai_image = cancellation_resistant_art_generate
        main.store_openshop_ai_png = counting_art_store
        pre_store_created = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks", json=art_request,
        )
        pre_store_id = pre_store_created.json()["task_id"]
        await asyncio.sleep(0.02)
        pre_store_cancel = await client.delete(
            f"/api/openshop/projects/project-ai/ai-tasks/{pre_store_id}",
            params={
                "canvas_type":owner["canvasType"], "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
            },
        )
        assert pre_store_cancel.status_code == 200
        pre_store_release.set()
        await asyncio.sleep(0.05)
        main.store_openshop_ai_png = original_art_store
        assert pre_store_calls == 0
        assert main.OPENSHOP_AI_TASKS.get(pre_store_id, "project-ai", owner)["status"] == "cancelled"

        # If cancellation wins after storage, the provisional project ref and
        # just-created asset must be removed conservatively.
        stored_during_race = asyncio.Event()
        release_stored_race = asyncio.Event()
        race_asset_id = ""

        distinct_race_output = art_model_output.copy()
        distinct_race_output.putpixel((3, 2), (220, 15, 45, 255))
        distinct_race_buffer = io.BytesIO()
        distinct_race_output.save(distinct_race_buffer, format="PNG")
        distinct_race_bytes = distinct_race_buffer.getvalue()

        async def immediate_art_generate(*_args, **_kwargs):
            return {
                "type":"b64",
                "value":base64.b64encode(distinct_race_bytes).decode("ascii"),
                "mime_type":"image/png",
            }, {}

        async def held_art_store(*args, **kwargs):
            nonlocal race_asset_id
            asset = await original_art_store(*args, **kwargs)
            race_asset_id = asset["assetId"]
            stored_during_race.set()
            try:
                await release_stored_race.wait()
            except asyncio.CancelledError:
                await release_stored_race.wait()
            return asset

        main.generate_ai_image = immediate_art_generate
        main.store_openshop_ai_png = held_art_store
        race_created = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks", json=art_request,
        )
        race_id = race_created.json()["task_id"]
        await asyncio.wait_for(stored_during_race.wait(), timeout=1.0)
        race_cancel = await client.delete(
            f"/api/openshop/projects/project-ai/ai-tasks/{race_id}",
            params={
                "canvas_type":owner["canvasType"], "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
            },
        )
        assert race_cancel.status_code == 200
        release_stored_race.set()
        await asyncio.sleep(0.1)
        main.store_openshop_ai_png = original_art_store
        assert main.OPENSHOP_AI_TASKS.get(race_id, "project-ai", owner)["status"] == "cancelled"
        race_project = main.OPENSHOP_STORE.load("project-ai", owner)
        assert race_asset_id not in race_project["assetRefs"]
        assert race_asset_id not in {item["assetId"] for item in race_project["pendingAssetRefs"]}
        assert not any(
            path.name.startswith(race_asset_id)
            for path in Path(main.OPENSHOP_STORE.assets_dir).iterdir()
        )

        # A canceled task may hash to an already referenced successful output.
        # It must not release or collect that shared pre-existing asset.
        stored_during_race = asyncio.Event()
        release_stored_race = asyncio.Event()
        race_asset_id = ""

        async def duplicate_art_generate(*_args, **_kwargs):
            return {
                "type":"b64",
                "value":base64.b64encode(art_model_bytes).decode("ascii"),
                "mime_type":"image/png",
            }, {}

        main.generate_ai_image = duplicate_art_generate
        main.store_openshop_ai_png = held_art_store
        duplicate_created = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks", json=art_request,
        )
        duplicate_id = duplicate_created.json()["task_id"]
        await asyncio.wait_for(stored_during_race.wait(), timeout=1.0)
        assert race_asset_id == art_task["result"]["assetId"]
        duplicate_cancel = await client.delete(
            f"/api/openshop/projects/project-ai/ai-tasks/{duplicate_id}",
            params={
                "canvas_type":owner["canvasType"], "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
            },
        )
        assert duplicate_cancel.status_code == 200
        release_stored_race.set()
        await asyncio.sleep(0.1)
        main.store_openshop_ai_png = original_art_store
        preserved_result = await client.get(art_task["result"]["url"])
        assert preserved_result.status_code == 200
        duplicate_project = main.OPENSHOP_STORE.load("project-ai", owner)
        assert art_task["result"]["assetId"] in {
            item["assetId"] for item in duplicate_project["pendingAssetRefs"]
        }

        mask_upload = await client.post(
            "/api/openshop/projects/project-ai/assets",
            data={
                "canvas_type":owner["canvasType"],
                "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
                "role":"ai-mask",
            },
            files={"file":("mask.png", mask_bytes(), "image/png")},
        )
        assert mask_upload.status_code == 200, mask_upload.text
        mask_asset_id = mask_upload.json()["asset"]["assetId"]
        reference_upload = await client.post(
            "/api/openshop/projects/project-ai/assets",
            data={
                "canvas_type":owner["canvasType"],
                "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
                "role":"ai-reference",
            },
            files={"file":("reference.png", png_bytes((180, 80, 30, 255)), "image/png")},
        )
        assert reference_upload.status_code == 200, reference_upload.text
        reference_asset_id = reference_upload.json()["asset"]["assetId"]

        generation_calls = 0

        async def partial_generate(prompt, size, quality, model, reference_images=None, provider_id=""):
            nonlocal generation_calls
            generation_calls += 1
            assert provider_id == "vision" and model == "gemini-3-pro-image"
            assert size == "96x64" and quality == "high"
            assert "@参考图2" in prompt
            roles = [item["role"] for item in reference_images]
            assert roles[:2] == ["visible-composite", "mask"]
            assert "library" in roles
            if generation_calls == 3:
                raise HTTPException(status_code=502, detail="third child failed")
            color = (210, 40 + generation_calls, 80, 255)
            return {
                "type":"b64",
                "value":base64.b64encode(png_bytes(color)).decode("ascii"),
                "mime_type":"image/png",
            }, {"id":f"generation-{generation_calls}"}

        main.generate_ai_image = partial_generate
        generation_request = {
            "owner":owner,
            "tool_id":"local-redraw",
            "source_asset_id":source_asset_id,
            "mask_asset_id":mask_asset_id,
            "primary_reference_asset_id":source_asset_id,
            "reference_assets":[{
                "assetId":source_asset_id,
                "alias":"参考图1",
                "sourceType":"primary",
                "order":0,
                "width":96,
                "height":64,
            }, {
                "assetId":reference_asset_id,
                "alias":"参考图2",
                "sourceType":"library",
                "order":1,
                "width":96,
                "height":64,
            }],
            "provider_id":"vision",
            "model_id":"gemini-3-pro-image",
            "prompt":"将 @参考图2 的颜色用于选区",
            "size":"96x64",
            "quality":"high",
            "target_count":3,
            "reference_mode":"full",
            "source_layer_id":"source-layer",
            "source_layer_index":1,
            "document":{
                "width":96,
                "height":64,
                "layerVersion":4,
                "visibleCompositeVersion":9,
            },
            "selection":{"x":10,"y":8,"width":40,"height":24,"feather":0},
        }
        generated = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json=generation_request,
        )
        assert generated.status_code == 200, generated.text
        parent = await wait_for_terminal(
            client, "project-ai", generated.json()["task_id"], owner
        )
        assert parent["kind"] == "parent"
        assert parent["status"] == "partial", parent
        assert (parent["targetCount"], parent["completedCount"], parent["failedCount"]) == (3, 2, 1)
        successful_children = [
            child for child in parent["children"] if child["status"] == "succeeded"
        ]
        failed_indexes = [
            child["index"] for child in parent["children"] if child["status"] == "failed"
        ]
        assert len(successful_children) == 2
        assert len(failed_indexes) == 1
        for child in successful_children:
            assert child["outputAssetId"]
            result_response = await client.get(child["result"]["url"])
            assert result_response.status_code == 200
            result_image = Image.open(io.BytesIO(result_response.content)).convert("RGBA")
            assert result_image.size == (96, 64)
            assert result_image.getpixel((0, 0))[3] == 0
            assert result_image.getpixel((12, 10))[3] == 255
        assert "seed" not in json.dumps(parent).lower()

        generation_calls = 10

        async def retry_generate(*args, **kwargs):
            return {
                "type":"b64",
                "value":base64.b64encode(png_bytes((30, 90, 230, 255))).decode("ascii"),
                "mime_type":"image/png",
            }, {"id":"retry-generation"}

        main.generate_ai_image = retry_generate
        retry = await client.post(
            f"/api/openshop/projects/project-ai/ai-tasks/{parent['taskId']}/retry-missing",
            json={"owner":owner},
        )
        assert retry.status_code == 200, retry.text
        retry_parent = await wait_for_terminal(
            client, "project-ai", retry.json()["task_id"], owner
        )
        assert retry_parent["status"] == "succeeded", retry_parent
        assert retry_parent["targetCount"] == 1
        assert retry_parent["retryOfTaskId"] == parent["taskId"]
        assert retry_parent["children"][0]["index"] == failed_indexes[0]

        too_many = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={**generation_request, "target_count":7},
        )
        assert too_many.status_code == 400
        assert "最多" in too_many.text or "maxOutputs" in too_many.text

        library_path = Path(main.ASSET_LIBRARY_DIR) / "openshop-library-reference.png"
        library_path.parent.mkdir(parents=True, exist_ok=True)
        library_bytes = png_bytes((90, 40, 210, 255))
        library_path.write_bytes(library_bytes)
        library_url = "/assets/" + library_path.relative_to(Path(main.ASSETS_DIR)).as_posix()
        main.save_asset_library({
            "active_library_id":"openshop-test-library",
            "libraries":[{
                "id":"openshop-test-library",
                "name":"OpenShop 测试素材库",
                "type":"asset",
                "categories":[{
                    "id":"reference-images",
                    "name":"参考图",
                    "type":"image",
                    "items":[{
                        "id":"reference-item-1",
                        "name":"紫色参考图.png",
                        "type":"image",
                        "url":library_url,
                    }],
                }],
            }],
        })
        imported_reference = await client.post(
            "/api/openshop/projects/project-ai/asset-imports",
            json={
                "owner":owner,
                "library_id":"openshop-test-library",
                "category_id":"reference-images",
                "item_id":"reference-item-1",
            },
        )
        assert imported_reference.status_code == 200, imported_reference.text
        imported_asset = imported_reference.json()["asset"]
        assert len(imported_asset["assetId"]) == 64
        assert imported_asset["role"] == "ai-reference"
        imported_content = await client.get(imported_asset["url"])
        assert imported_content.status_code == 200
        assert imported_content.content == library_bytes

        wrong_import_owner = await client.post(
            "/api/openshop/projects/project-ai/asset-imports",
            json={
                "owner":{**owner_b, "canvasType":"smart"},
                "library_id":"openshop-test-library",
                "category_id":"reference-images",
                "item_id":"reference-item-1",
            },
        )
        assert wrong_import_owner.status_code == 403

        missing_library_item = await client.post(
            "/api/openshop/projects/project-ai/asset-imports",
            json={
                "owner":owner,
                "library_id":"openshop-test-library",
                "category_id":"reference-images",
                "item_id":"missing-item",
            },
        )
        assert missing_library_item.status_code == 404

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
        upload_b = await client.post(
            "/api/openshop/projects/project-ai/assets",
            data={
                "canvas_type":owner_b["canvasType"],
                "canvas_id":owner_b["canvasId"],
                "node_id":owner_b["nodeId"],
                "role":"ai-source",
            },
            files={"file":("source-b.png", png_bytes((80, 120, 200, 255)), "image/png")},
        )
        assert upload_b.status_code == 200, upload_b.text
        source_asset_id_b = upload_b.json()["asset"]["assetId"]

        original_ensure_owner = main.ensure_openshop_project_owner
        ownership_checked = asyncio.Event()
        resume_creation = asyncio.Event()
        barrier_used = False

        async def barrier_ensure_owner(project_id, checked_owner):
            nonlocal barrier_used
            project = await original_ensure_owner(project_id, checked_owner)
            if project_id == "project-ai" and checked_owner == owner and not barrier_used:
                barrier_used = True
                ownership_checked.set()
                await resume_creation.wait()
            return project

        main.ensure_openshop_project_owner = barrier_ensure_owner
        task_ids_before_race = set(main.OPENSHOP_AI_TASKS._records)
        raced_creation_call = asyncio.create_task(client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-remove",
                "source_asset_id":source_asset_id_b,
                "provider_id":"vision",
                "model_id":"gemini-3-pro-image",
                "mode":"layer",
            },
        ))
        await asyncio.wait_for(ownership_checked.wait(), timeout=1.0)
        raced_delete = await client.delete(
            "/api/openshop/projects/project-ai",
            params={
                "canvas_type":owner["canvasType"],
                "canvas_id":owner["canvasId"],
                "node_id":owner["nodeId"],
            },
        )
        assert raced_delete.status_code == 200 and raced_delete.json()["deleted"] is True
        resume_creation.set()
        try:
            raced_creation = await raced_creation_call
        finally:
            main.ensure_openshop_project_owner = original_ensure_owner
        raced_task_ids = set(main.OPENSHOP_AI_TASKS._records) - task_ids_before_race
        assert raced_creation.status_code == 404, raced_creation.text
        assert raced_task_ids == set()

        reinitialized = await client.post(
            "/api/openshop/projects/project-ai/initialize",
            json={"owner":owner, "document":{"width":96, "height":64}},
        )
        assert reinitialized.status_code == 200, reinitialized.text
        recreated = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner,
                "tool_id":"text-remove",
                "source_asset_id":source_asset_id_b,
                "provider_id":"vision",
                "model_id":"gemini-3-pro-image",
                "mode":"layer",
            },
        )
        assert recreated.status_code == 200, recreated.text

        deleting = recreated
        surviving = await client.post(
            "/api/openshop/projects/project-ai/ai-tasks",
            json={
                "owner":owner_b,
                "tool_id":"text-remove",
                "source_asset_id":source_asset_id_b,
                "provider_id":"vision",
                "model_id":"gemini-3-pro-image",
                "mode":"layer",
            },
        )
        assert surviving.status_code == 200
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
        deleting_task = main.OPENSHOP_AI_TASKS.get(
            deleting.json()["task_id"], "project-ai", owner
        )
        surviving_task = main.OPENSHOP_AI_TASKS.get(
            surviving.json()["task_id"], "project-ai", owner_b
        )
        assert deleting_task["status"] == "cancelled"
        assert surviving_task["status"] not in {"succeeded", "failed", "cancelled"}
        assert main.OPENSHOP_AI_TASKS.active_for_project("project-ai") == 1
        delete_release.set()
        completed_survivor = await wait_for_terminal(
            client, "project-ai", surviving.json()["task_id"], owner_b
        )
        assert completed_survivor["status"] == "succeeded"

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
