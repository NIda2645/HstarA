# OpenShop 原位生成式编辑 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 HstarA 的 OpenShop 全屏编辑器中交付两个始终可点击的原位功能“生成式填充”和“局部重绘”，支持多参考、多结果自动建层、部分成功补生成，以及关闭页面后仍持续运行的项目级独立会话。

**Architecture:** 后端继续复用 HstarA 全局 API 配置与 `generate_ai_image()`，但把生成任务扩展为按 `projectId` 隔离的父任务/子任务，并把所有输入冻结成内容寻址的 OpenShop 资源。OpenShop iframe 内新增引用管理、生成任务客户端和底部操作栏三个独立模块；外层宿主从单 iframe 改为项目键控的多 iframe 会话池，关闭只隐藏当前会话，结果到达后由隐藏 iframe 自动创建透明图层并触发保存。项目 JSON 只持久化公开 ID、有限任务记录、资源引用和图层来源元数据，不保存密钥、Data URL、Blob URL 或 `seed` 字段。

**Tech Stack:** Python 3、FastAPI、Pydantic、Pillow、原生 JavaScript、Fabric.js、Vitest/JSDOM、Node 测试脚本、Playwright、OpenShop 确定性静态镜像构建。

---

## 文件边界

**后端契约与执行**

- `openshop_ai.py`：公开能力目录、生成请求快照、参考资源、父/子任务记录和任务注册表的纯契约。
- `openshop_image_ops.py`：把上游完整图或裁剪图规范化为文档尺寸的透明局部 PNG，不接触网络和项目状态。
- `openshop_projects.py`：有限持久化、资源引用收集、克隆/删除语义和敏感字段拒绝。
- `main.py`：请求模型、素材库导入、父/子任务路由、并发执行、取消和补生成。

**OpenShop iframe**

- `integrations/openshop/host/openshop-reference-manager.js`：主参考、额外参考、固定别名、素材库/本地/图层入口和任务快照。
- `integrations/openshop/host/openshop-generative-client.js`：父任务创建、轮询、取消、恢复、部分成功和补生成。
- `integrations/openshop/host/openshop-generative-tools.js`：两个入口、选区状态机、底部操作栏、进度与多图层插入。
- `integrations/openshop/host/openshop-generative-tools.css`：桌面、移动端和 4K 的操作栏、缩略图、`@` 选择器样式。
- `integrations/openshop/host/openshop-project-adapter.js`：生成偏好、参考记录、任务记录、待插入结果和生成图层元数据的序列化/恢复。
- `integrations/openshop/index.html`：选区事件、脚本初始化和依赖注入；不承载生成业务实现。
- `integrations/openshop/locales/zh-CN.js`：新增界面文案，术语保持 Photoshop 简体中文风格。

**HstarA 外层宿主与画布**

- `static/js/openshop-host.js`：按项目作用域管理多个持续存活的 iframe 会话。
- `static/css/openshop-host.css`：只显示当前 iframe，隐藏会话继续布局外运行。
- `static/js/canvas-openshop.js`、`static/js/smart-canvas-openshop.js`：节点进度、层数、保存状态和任务汇总。
- `static/js/canvas.js`、`static/js/smart-canvas.js`：删除节点时显式释放对应项目会话；普通删除流程之外不终止任务。
- `integrations/openshop/scripts/build-hstar.mjs`、`static/openshop/**`：确定性生成镜像，禁止手改镜像文件。

## 统一数据契约

后续任务必须沿用这些名称，避免父子任务、持久化和界面之间出现同义字段：

```text
toolId: "generative-fill" | "local-redraw"
parent terminal status: "succeeded" | "partial" | "failed" | "cancelled"
child terminal status: "succeeded" | "failed" | "cancelled"
referenceMode: "selection" | "full"
project fields: aiToolPreferences, aiReferenceRecords, aiTaskRecords, aiPendingResults
layer metadata: hstarAiGeneration
node summary: aiStatus, aiTargetCount, aiCompletedCount, aiFailedCount
```

生成任务请求固定使用以下形状；任何实现不得新增 `seed`：

```json
{
  "owner": {"canvasType":"classic","canvasId":"canvas-1","nodeId":"node-1"},
  "tool_id": "local-redraw",
  "source_asset_id": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  "mask_asset_id": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  "primary_reference_asset_id": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
  "reference_assets": [
    {"assetId":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","alias":"参考图1","sourceType":"primary","order":0},
    {"assetId":"dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd","alias":"参考图2","sourceType":"layer","order":1}
  ],
  "provider_id": "provider-id",
  "model_id": "model-id",
  "prompt": "将 @参考图1 的材质用于选区",
  "size": "auto",
  "quality": "auto",
  "target_count": 4,
  "reference_mode": "full",
  "source_layer_id": "layer_source_1",
  "source_layer_index": 2,
  "document": {
    "width": 1920,
    "height": 1080,
    "layerVersion": 17,
    "visibleCompositeVersion": 23
  },
  "selection": {"x":120,"y":80,"width":640,"height":420,"feather":0},
  "options": {}
}
```

### Task 1: 扩展能力目录和纯任务契约

**Files:**
- Modify: `openshop_ai.py:17-608`
- Modify: `tools/tests/openshop-ai-contract.test.mjs`

- [ ] **Step 1: 写能力、参考和父子任务的失败测试**

在现有 Python harness 中加入下列断言，覆盖动态上限、固定别名、父任务汇总、部分成功和敏感字段拒绝：

```python
from openshop_ai import (
    OpenShopAiTaskRegistry,
    OpenShopAiValidationError,
    build_capability_catalog,
    normalize_generation_snapshot,
    normalize_reference_record,
)

catalog = build_capability_catalog([{
    "id": "image-api", "name": "Image API", "enabled": True, "has_key": True,
    "image_models": ["image-model"],
    "image_model_capabilities": {
        "image-model": {
            "supportsMask": True, "supportsMultiReference": True,
            "maxReferenceImages": 12, "maxOutputs": 6,
            "supportsBatchOutput": False,
            "sizes": ["auto", "1024x1024"], "qualities": ["auto", "high"],
        }
    },
}])
for tool_id in ("generative-fill", "local-redraw"):
    model = catalog["tools"][tool_id]["providers"][0]["models"][0]
    assert model["capabilities"]["maxReferenceImages"] == 12
    assert model["capabilities"]["maxOutputs"] == 6

selection = normalize_reference_record({
    "assetId": "a" * 64, "alias": "选区1", "sourceType": "selection", "order": 0,
})
image = normalize_reference_record({
    "assetId": "b" * 64, "alias": "参考图2", "sourceType": "library", "order": 1,
})
assert selection["mention"] == "@选区1"
assert image["mention"] == "@参考图2"

primary = normalize_reference_record({
    "assetId": "c" * 64, "alias": "参考图1", "sourceType": "primary", "order": 0,
})

snapshot = normalize_generation_snapshot({
    "toolId": "local-redraw", "sourceAssetId": "c" * 64,
    "maskAssetId": "d" * 64, "primaryReferenceAssetId": "c" * 64,
    "references": [primary, image], "prompt": "重绘 @参考图2", "size": "auto",
    "quality": "high", "targetCount": 3, "referenceMode": "full",
    "sourceLayerId": "layer-source", "sourceLayerIndex": 2,
    "document": {"width": 1920, "height": 1080, "layerVersion": 17, "visibleCompositeVersion": 23},
    "selection": {"x": 10, "y": 20, "width": 30, "height": 40, "feather": 0},
})
assert snapshot["targetCount"] == 3
assert "seed" not in json.dumps(snapshot).lower()

registry = OpenShopAiTaskRegistry()
parent = registry.create_parent("project-a", owner_a, snapshot, "image-api", "image-model")
children = [registry.create_child(parent["taskId"], index) for index in range(3)]
registry.succeed_child(parent["taskId"], children[0]["childTaskId"], {"assetId": "e" * 64})
registry.succeed_child(parent["taskId"], children[1]["childTaskId"], {"assetId": "f" * 64})
registry.fail_child(parent["taskId"], children[2]["childTaskId"], "upstream failed")
partial = registry.get(parent["taskId"], "project-a", owner_a)
assert partial["status"] == "partial"
assert (partial["targetCount"], partial["completedCount"], partial["failedCount"]) == (3, 2, 1)

try:
    normalize_generation_snapshot({**snapshot, "seed": 42})
    raise AssertionError("seed must be rejected")
except OpenShopAiValidationError:
    pass
```

- [ ] **Step 2: 运行测试并确认失败位置正确**

Run: `node tools/tests/openshop-ai-contract.test.mjs`

Expected: FAIL，提示 `normalize_generation_snapshot`、`normalize_reference_record` 或 `create_parent` 尚未定义，且不是 Python 环境或编码错误。

- [ ] **Step 3: 实现统一能力和请求快照规范化**

在 `openshop_ai.py` 增加下列常量与入口；模型没有声明上限时使用 8，不把默认值写死到界面：

```python
OPENSHOP_GENERATIVE_TOOL_IDS = ("generative-fill", "local-redraw")
OPENSHOP_AI_TOOL_IDS = ("text-extract", "text-remove", *OPENSHOP_GENERATIVE_TOOL_IDS)
OPENSHOP_AI_TASK_STATES = (
    "queued", "running", "partial", "succeeded", "failed", "cancelled",
)
OPENSHOP_AI_TERMINAL_STATES = {"partial", "succeeded", "failed", "cancelled"}
OPENSHOP_REFERENCE_SOURCE_TYPES = {"primary", "selection", "layer", "library", "local"}
OPENSHOP_DEFAULT_MAX_REFERENCES = 8
OPENSHOP_DEFAULT_MAX_OUTPUTS = 8
OPENSHOP_HARD_MAX_OUTPUTS = 64

def normalize_reference_record(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OpenShop reference must be an object")
    source_type = _clean_text(value.get("sourceType"), 32).lower()
    if source_type not in OPENSHOP_REFERENCE_SOURCE_TYPES:
        raise OpenShopAiValidationError("Invalid OpenShop reference sourceType")
    alias = _clean_text(value.get("alias"), 40)
    prefix = "选区" if source_type == "selection" else "参考图"
    if not re.fullmatch(rf"{prefix}[1-9][0-9]*", alias):
        raise OpenShopAiValidationError("Invalid OpenShop reference alias")
    return {
        "assetId": _task_asset_id(value.get("assetId"), "reference assetId"),
        "alias": alias,
        "mention": f"@{alias}",
        "sourceType": source_type,
        "order": max(0, int(value.get("order") or 0)),
        "width": max(0, int(value.get("width") or 0)),
        "height": max(0, int(value.get("height") or 0)),
    }

def normalize_generation_snapshot(value: Any) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise OpenShopAiValidationError("OpenShop generation snapshot must be an object")
    if any(str(key).strip().lower() == "seed" for key in value):
        raise OpenShopAiValidationError("OpenShop generation does not support seed")
    tool_id = _clean_text(value.get("toolId"), 40)
    if tool_id not in OPENSHOP_GENERATIVE_TOOL_IDS:
        raise OpenShopAiValidationError("Invalid OpenShop generative toolId")
    prompt = _clean_text(value.get("prompt"), 8000)
    if tool_id == "local-redraw" and not prompt:
        raise OpenShopAiValidationError("局部重绘需要填写修改要求")
    selection = value.get("selection") if isinstance(value.get("selection"), dict) else {}
    target_count = min(OPENSHOP_HARD_MAX_OUTPUTS, max(1, int(value.get("targetCount") or 1)))
    original_target_count = min(
        OPENSHOP_HARD_MAX_OUTPUTS,
        max(target_count, int(value.get("originalTargetCount") or target_count)),
    )
    requested_indexes = value.get("requestedIndexes")
    if not isinstance(requested_indexes, list):
        requested_indexes = list(range(target_count))
    requested_indexes = [int(index) for index in requested_indexes]
    if (
        len(requested_indexes) != target_count
        or len(set(requested_indexes)) != target_count
        or any(index < 0 or index >= original_target_count for index in requested_indexes)
    ):
        raise OpenShopAiValidationError("Invalid OpenShop requested output indexes")
    normalized = {
        "toolId": tool_id,
        "sourceAssetId": _task_asset_id(value.get("sourceAssetId"), "sourceAssetId"),
        "maskAssetId": _task_asset_id(value.get("maskAssetId"), "maskAssetId"),
        "primaryReferenceAssetId": _task_asset_id(
            value.get("primaryReferenceAssetId"), "primaryReferenceAssetId"
        ),
        "references": [normalize_reference_record(item) for item in value.get("references", [])],
        "prompt": prompt,
        "size": _clean_text(value.get("size"), 40, "auto"),
        "quality": _clean_text(value.get("quality"), 40, "auto"),
        "targetCount": target_count,
        "originalTargetCount": original_target_count,
        "requestedIndexes": requested_indexes,
        "referenceMode": (
            "full" if tool_id == "generative-fill"
            else "selection" if value.get("referenceMode") == "selection" else "full"
        ),
        "sourceLayerId": _clean_text(value.get("sourceLayerId"), 160),
        "sourceLayerIndex": max(0, int(value.get("sourceLayerIndex") or 0)),
        "document": {
            "width": _positive_dimension((value.get("document") or {}).get("width"), "document width"),
            "height": _positive_dimension((value.get("document") or {}).get("height"), "document height"),
            "layerVersion": max(0, int((value.get("document") or {}).get("layerVersion") or 0)),
            "visibleCompositeVersion": max(
                0, int((value.get("document") or {}).get("visibleCompositeVersion") or 0)
            ),
        },
        "selection": {
            "x": max(0, int(selection.get("x") or 0)),
            "y": max(0, int(selection.get("y") or 0)),
            "width": _positive_dimension(selection.get("width"), "selection width"),
            "height": _positive_dimension(selection.get("height"), "selection height"),
            "feather": max(0, int(selection.get("feather") or 0)),
        },
    }
    if tool_id == "generative-fill" and len(normalized["references"]) > 1:
        raise OpenShopAiValidationError("生成式填充不接受额外参考图")
    if tool_id == "local-redraw":
        if not normalized["references"]:
            raise OpenShopAiValidationError("局部重绘需要主参考图")
        if normalized["references"][0]["assetId"] != normalized["primaryReferenceAssetId"]:
            raise OpenShopAiValidationError("局部重绘主参考图与引用顺序不一致")
    return normalized
```

扩展 `_catalog_provider()`，让每个模型公开 `supportsImageInput`、`supportsMask`、`supportsMultiReference`、`maxReferenceImages`、`maxOutputs`、`supportsBatchOutput`、`sizes` 和 `qualities`；`build_capability_catalog()` 为两个新工具返回独立目录项。同步扩展 `normalize_ai_task_record()`：`kind="parent"` 时规范化冻结 snapshot 和 children，`kind="single"` 时保持 Stage 4 文字任务现状。

- [ ] **Step 4: 实现父子任务注册表**

保留现有文字任务方法，并增加 `create_parent()`、`create_child()`、`bind_child()`、`mark_child_running()`、`succeed_child()` 和 `fail_child()`。父状态只由注册表汇总：全部成功为 `succeeded`，成功与失败并存为 `partial`，全部失败为 `failed`，主动取消永远保持 `cancelled`。迟到响应调用 `succeed_child()` 必须返回 `False`。

```python
def _summarize_parent(record: dict[str, Any]) -> None:
    children = record.get("children", [])
    completed = sum(child["status"] == "succeeded" for child in children)
    failed = sum(child["status"] == "failed" for child in children)
    cancelled = sum(child["status"] == "cancelled" for child in children)
    record["completedCount"] = completed
    record["failedCount"] = failed
    if record.get("status") == "cancelled":
        return
    terminal = completed + failed + cancelled
    if terminal < record["targetCount"]:
        record["status"] = "running" if any(c["status"] == "running" for c in children) else "queued"
    elif completed == record["targetCount"]:
        record["status"] = "succeeded"
    elif completed:
        record["status"] = "partial"
    else:
        record["status"] = "failed"
```

- [ ] **Step 5: 运行契约测试**

Run: `node tools/tests/openshop-ai-contract.test.mjs`

Expected: PASS，并输出 `OpenShop AI contract tests passed`。

- [ ] **Step 6: 提交契约改动**

```bash
git add openshop_ai.py tools/tests/openshop-ai-contract.test.mjs
git commit -m "feat: define OpenShop generative task contracts"
```

### Task 2: 扩展项目持久化和资源生命周期

**Files:**
- Modify: `openshop_projects.py:45-590`
- Modify: `tools/tests/openshop-project-storage.test.mjs`

- [ ] **Step 1: 写持久化、克隆和清理失败测试**

在存储 harness 中保存包含生成偏好、参考、父子任务和待插入结果的项目，加入以下断言：

```python
project = store.initialize("project-generation", owner_a, {"width": 1920, "height": 1080})
source = store.store_image(
    "project-generation", owner_a, png_bytes((10, 20, 30, 255)),
    "image/png", "source.png", "ai-source",
)
result = store.store_image(
    "project-generation", owner_a, png_bytes((200, 30, 50, 120)),
    "image/png", "result.png", "ai-output",
)
project["aiToolPreferences"] = {
    "local-redraw": {
        "toolId": "local-redraw", "mode": "project", "apiConfigId": "image-api",
        "modelId": "image-model", "size": "auto", "quality": "high",
        "count": 4, "referenceMode": "full", "lastSelectionTool": "lasso",
    }
}
project["aiReferenceRecords"] = [{
    "assetId": source["assetId"], "alias": "参考图1", "mention": "@参考图1",
    "sourceType": "layer", "order": 1, "width": 8, "height": 6,
}]
project["aiTaskRecords"] = [{
    "taskId": "openshop_ai_parent", "kind": "parent", "toolId": "local-redraw",
    "status": "partial", "targetCount": 2, "completedCount": 1, "failedCount": 1,
    "sourceAssetId": source["assetId"], "maskAssetId": source["assetId"],
    "primaryReferenceAssetId": source["assetId"], "references": project["aiReferenceRecords"],
    "children": [{
        "childTaskId": "openshop_ai_child_0", "index": 0, "status": "succeeded",
        "outputAssetId": result["assetId"], "error": "",
    }],
}]
project["aiPendingResults"] = [{
    "taskId": "openshop_ai_parent", "childTaskId": "openshop_ai_child_0",
    "assetId": result["assetId"], "sourceLayerId": "deleted-layer", "index": 0,
}]
saved = store.save("project-generation", owner_a, project, base_version=1)
assert saved["aiReferenceRecords"][0]["mention"] == "@参考图1"
assert saved["aiPendingResults"][0]["assetId"] == result["assetId"]
assert source["assetId"] in saved["assetRefs"]
assert result["assetId"] in saved["assetRefs"]

clone = store.clone("project-generation", "project-generation-clone", owner_b)
assert clone["aiTaskRecords"] == []
assert clone["aiPendingResults"] == []
assert clone["aiReferenceRecords"] == []

invalid = copy.deepcopy(saved)
invalid["aiToolPreferences"]["local-redraw"]["seed"] = 123
try:
    store.save("project-generation", owner_a, invalid, base_version=2)
    raise AssertionError("seed fields must be rejected")
except OpenShopValidationError:
    pass
```

- [ ] **Step 2: 运行存储测试并确认失败**

Run: `node tools/tests/openshop-project-storage.test.mjs`

Expected: FAIL，首次失败应指出新字段未持久化、生成任务记录无效或 `seed` 未被拒绝。

- [ ] **Step 3: 实现有限字段规范化**

初始化项目时加入空数组；保存时分别限制参考 64 条、任务 100 条、待插入结果 64 条，并从所有生成记录中收集资源 ID：

```python
project = {
    # existing fields stay unchanged
    "aiToolPreferences": {},
    "aiReferenceRecords": [],
    "aiTaskRecords": [],
    "aiPendingResults": [],
    "assetRefs": [],
}

def _bounded_list(value: Any, label: str, maximum: int) -> list[Any]:
    if not isinstance(value, list):
        raise OpenShopValidationError(f"{label} must be an array")
    if len(value) > maximum:
        raise OpenShopValidationError(f"{label} exceeds the {maximum} item limit")
    return value
```

递归检查字典键时精确拒绝 `seed`，并继续拒绝 API Key、Authorization、Data URL 和 Blob URL。提示词文本中出现英文单词 `seed` 不应触发，因为只检查键名。

- [ ] **Step 4: 固化克隆和删除语义**

`clone()` 保留已生成图层及其稳定 `assetRef`，但清空 `aiReferenceRecords`、`aiTaskRecords` 和 `aiPendingResults`。`delete()` 与 `delete_canvas_projects()` 维持内容寻址垃圾回收：只有所有项目都不再引用时才删除二进制资源。

```python
clone["aiReferenceRecords"] = []
clone["aiTaskRecords"] = []
clone["aiPendingResults"] = []

def delete_and_collect_project(store, project_id, owner):
    deleted = store.delete(project_id, owner)
    return {"deleted": deleted, "removedAssets": store.collect_garbage() if deleted else []}
```

- [ ] **Step 5: 运行存储测试**

Run: `node tools/tests/openshop-project-storage.test.mjs`

Expected: PASS，并输出 `OpenShop project storage tests passed` 或现有等价成功信息。

- [ ] **Step 6: 提交存储改动**

```bash
git add openshop_projects.py tools/tests/openshop-project-storage.test.mjs
git commit -m "feat: persist OpenShop generative project state"
```

### Task 3: 实现透明局部结果规范化

**Files:**
- Create: `openshop_image_ops.py`
- Create: `tools/tests/openshop-ai-image-normalization.test.mjs`

- [ ] **Step 1: 写完整图、裁剪图、空蒙版和错位结果测试**

测试 harness 用 Pillow 创建 `8x6` 源图、`8x6` 二值蒙版、`8x6` 完整结果和选区大小裁剪结果：

```python
from io import BytesIO
from PIL import Image
from openshop_image_ops import OpenShopImageNormalizationError, normalize_local_generation

def png(image):
    output = BytesIO()
    image.save(output, format="PNG")
    return output.getvalue()

source = Image.new("RGBA", (8, 6), (20, 30, 40, 255))
mask = Image.new("L", (8, 6), 0)
for y in range(2, 5):
    for x in range(1, 6):
        mask.putpixel((x, y), 255)

full = Image.new("RGBA", (8, 6), (220, 20, 40, 255))
normalized = Image.open(BytesIO(normalize_local_generation(
    png(source), png(mask), png(full), {"x": 1, "y": 2, "width": 5, "height": 3},
))).convert("RGBA")
assert normalized.size == (8, 6)
assert normalized.getpixel((0, 0))[3] == 0
assert normalized.getpixel((2, 3)) == (220, 20, 40, 255)

crop = Image.new("RGB", (5, 3), (10, 200, 70))
cropped = Image.open(BytesIO(normalize_local_generation(
    png(source), png(mask), png(crop), {"x": 1, "y": 2, "width": 5, "height": 3},
))).convert("RGBA")
assert cropped.getpixel((1, 2)) == (10, 200, 70, 255)
assert cropped.getpixel((7, 5))[3] == 0

try:
    normalize_local_generation(png(source), png(Image.new("L", (8, 6), 0)), png(full),
                               {"x": 1, "y": 2, "width": 5, "height": 3})
    raise AssertionError("empty masks must fail")
except OpenShopImageNormalizationError:
    pass

try:
    normalize_local_generation(
        png(source), png(mask), png(Image.new("RGB", (2, 5), (1, 2, 3))),
        {"x": 1, "y": 2, "width": 5, "height": 3},
    )
    raise AssertionError("misaligned crop ratios must fail")
except OpenShopImageNormalizationError:
    pass
```

- [ ] **Step 2: 运行规范化测试并确认失败**

Run: `node tools/tests/openshop-ai-image-normalization.test.mjs`

Expected: FAIL，提示 `openshop_image_ops` 不存在。

- [ ] **Step 3: 实现纯 Pillow 规范化函数**

```python
import io
from PIL import Image, ImageChops

class OpenShopImageNormalizationError(ValueError):
    pass

def normalize_local_generation(
    source_bytes: bytes,
    mask_bytes: bytes,
    generated_bytes: bytes,
    bounds: dict[str, int],
) -> bytes:
    source = Image.open(io.BytesIO(source_bytes)).convert("RGBA")
    mask = Image.open(io.BytesIO(mask_bytes)).convert("L")
    generated = Image.open(io.BytesIO(generated_bytes)).convert("RGBA")
    if mask.size != source.size or not mask.getbbox():
        raise OpenShopImageNormalizationError("OpenShop selection mask is empty or misaligned")
    x, y = int(bounds["x"]), int(bounds["y"])
    width, height = int(bounds["width"]), int(bounds["height"])
    if x < 0 or y < 0 or width < 1 or height < 1 or x + width > source.width or y + height > source.height:
        raise OpenShopImageNormalizationError("OpenShop selection bounds are outside the document")
    if generated.size == source.size:
        full = generated
    else:
        generated_ratio = generated.width / generated.height
        bounds_ratio = width / height
        if abs(generated_ratio - bounds_ratio) / bounds_ratio > 0.10:
            raise OpenShopImageNormalizationError("OpenShop generated crop aspect ratio is misaligned")
        crop = generated.resize((width, height), Image.Resampling.LANCZOS)
        full = Image.new("RGBA", source.size, (0, 0, 0, 0))
        full.alpha_composite(crop, (x, y))
    alpha = ImageChops.multiply(full.getchannel("A"), mask)
    full.putalpha(alpha)
    if not alpha.getbbox():
        raise OpenShopImageNormalizationError("OpenShop generated result has no selected pixels")
    output = io.BytesIO()
    full.save(output, format="PNG", optimize=True)
    return output.getvalue()
```

函数还要拒绝超过 `16384x16384` 的输入、解码失败、文档比例错位和输出空透明通道；不把源图、蒙版或结果写入临时目录。

- [ ] **Step 4: 运行规范化测试**

Run: `node tools/tests/openshop-ai-image-normalization.test.mjs`

Expected: PASS，并输出 `OpenShop AI image normalization tests passed`。

- [ ] **Step 5: 提交图像处理改动**

```bash
git add openshop_image_ops.py tools/tests/openshop-ai-image-normalization.test.mjs
git commit -m "feat: normalize OpenShop local generation outputs"
```

### Task 4: 实现父子生成任务 API、部分成功和补生成

**Files:**
- Modify: `main.py:2781-2790`
- Modify: `main.py:16389-16751`
- Modify: `tools/tests/openshop-ai-api.test.mjs`

- [ ] **Step 1: 写多结果、部分成功、取消和补生成 API 失败测试**

扩展现有 ASGI harness，模拟三次 `generate_ai_image()`：前两次返回图片，第三次抛错。提交 `target_count=3` 后轮询父任务：

```python
create = await client.post(
    "/api/openshop/projects/project-ai/ai-tasks",
    json={
        "owner": owner, "tool_id": "local-redraw",
        "source_asset_id": source_asset_id, "mask_asset_id": mask_asset_id,
        "primary_reference_asset_id": source_asset_id,
        "reference_assets": [{
            "assetId": source_asset_id, "alias": "参考图1",
            "sourceType": "primary", "order": 0,
        }, {
            "assetId": reference_asset_id, "alias": "参考图2",
            "sourceType": "library", "order": 1,
        }],
        "provider_id": "vision", "model_id": "gemini-3-pro-image",
        "prompt": "将 @参考图2 的材质用于选区", "size": "auto", "quality": "high",
        "target_count": 3, "reference_mode": "full",
        "source_layer_id": "source-layer", "source_layer_index": 1,
        "document": {
            "width": 8, "height": 6,
            "layerVersion": 4, "visibleCompositeVersion": 9,
        },
        "selection": {"x": 1, "y": 1, "width": 4, "height": 3, "feather": 0},
    },
)
assert create.status_code == 200, create.text
parent = await wait_for_terminal(client, "project-ai", create.json()["task_id"], owner)
assert parent["status"] == "partial"
assert (parent["targetCount"], parent["completedCount"], parent["failedCount"]) == (3, 2, 1)
assert len([child for child in parent["children"] if child["outputAssetId"]]) == 2

retry = await client.post(
    f"/api/openshop/projects/project-ai/ai-tasks/{parent['taskId']}/retry-missing",
    json={"owner": owner},
)
assert retry.status_code == 200, retry.text
retry_parent = await wait_for_terminal(client, "project-ai", retry.json()["task_id"], owner)
assert retry_parent["targetCount"] == 1
assert retry_parent["retryOfTaskId"] == parent["taskId"]
assert retry_parent["status"] == "succeeded"
assert retry_parent["children"][0]["index"] == 2
```

再增加断言：

```python
assert all(child["outputAssetId"] for child in parent["children"] if child["status"] == "succeeded")
assert all(child["outputAssetId"] == "" for child in parent["children"] if child["status"] == "failed")
assert "seed" not in json.dumps(parent).lower()
```

- [ ] **Step 2: 运行 API 测试并确认失败**

Run: `node tools/tests/openshop-ai-api.test.mjs`

Expected: FAIL，Pydantic 尚未接收生成字段，或返回“OpenShop AI 功能不存在”。

- [ ] **Step 3: 扩展请求模型和能力校验**

```python
class OpenShopAiTaskRequest(BaseModel):
    owner: Dict[str, Any]
    tool_id: str
    source_asset_id: str
    mask_asset_id: str = ""
    primary_reference_asset_id: str = ""
    reference_assets: List[Dict[str, Any]] = Field(default_factory=list)
    provider_id: str
    model_id: str
    mode: str = "layer"
    prompt: str = ""
    size: str = "auto"
    quality: str = "auto"
    target_count: int = 1
    reference_mode: str = "full"
    source_layer_id: str = ""
    source_layer_index: int = 0
    document: Dict[str, Any] = Field(default_factory=dict)
    selection: Dict[str, Any] = Field(default_factory=dict)
    options: Dict[str, Any] = Field(default_factory=dict)

class OpenShopAiRetryRequest(BaseModel):
    owner: Dict[str, Any]
```

`openshop_ai_provider()` 必须从能力目录读取所选模型，分别验证图生图、蒙版、多参考、尺寸、质量、参考数和输出数。两个生成工具都要求有效蒙版和完整可见合成图；`generative-fill` 强制 `reference_mode="full"`、主参考等于完整合成图且拒绝额外参考，`local-redraw` 才接受两种参考模式和额外参考。提交按钮虽然在前端可见，但后端仍是最终校验边界。

- [ ] **Step 4: 实现父任务和受控子任务执行**

把文字任务原路径保留为单任务；生成工具走父任务路径。使用进程内信号量限制并发，不依赖 iframe 可见性：

```python
from copy import deepcopy
from openshop_image_ops import normalize_local_generation

OPENSHOP_GENERATION_CONCURRENCY = max(1, int(os.getenv("OPENSHOP_GENERATION_CONCURRENCY", "3")))
OPENSHOP_GENERATION_SEMAPHORE = asyncio.Semaphore(OPENSHOP_GENERATION_CONCURRENCY)

async def openshop_generation_references(snapshot: Dict[str, Any]) -> List[Dict[str, Any]]:
    source_aliases = [
        f"@{item['alias']}" for item in snapshot["references"]
        if item["assetId"] == snapshot["sourceAssetId"]
    ]
    ordered = [
        (
            snapshot["sourceAssetId"], "visible-composite",
            "全图上下文" + (f"（{'、'.join(source_aliases)}）" if source_aliases else ""),
        ),
        (snapshot["maskAssetId"], "mask", "选区蒙版"),
    ]
    ordered.extend(
        (item["assetId"], item["sourceType"], item["alias"])
        for item in snapshot["references"]
        if item["assetId"] != snapshot["sourceAssetId"]
    )
    references = []
    for asset_id, role, name in ordered:
        path, metadata, url = await asyncio.to_thread(openshop_ai_asset, asset_id, 0)
        references.append({
            "url": url, "name": name or os.path.basename(path), "role": role,
            "kind": "image", "mime": metadata["mime"],
        })
    return references

def openshop_generation_prompt(snapshot: Dict[str, Any]) -> str:
    scope = (
        "Fill only the selected region using the full visible image as context."
        if snapshot["toolId"] == "generative-fill"
        else "Redraw only the selected region and preserve every pixel outside the mask."
    )
    aliases = ", ".join(
        f"@{item['alias']} is reference image {index + 1}"
        for index, item in enumerate(snapshot["references"])
    )
    prompt = snapshot["prompt"] or "Complete the selected region naturally."
    return f"{scope}\nUser request: {prompt}\nReference mapping: {aliases}".strip()

async def generated_image_bytes(image_data: Dict[str, Any]) -> bytes:
    output_url = await save_ai_image_to_output(image_data, prefix="openshop_generation_")
    output_path = output_file_from_url(output_url)
    if not output_path or not os.path.isfile(output_path):
        raise HTTPException(status_code=502, detail="OpenShop 生图模型没有返回可读取的图片")
    temporary = os.path.basename(output_path).startswith("openshop_generation_")
    try:
        with open(output_path, "rb") as handle:
            return handle.read(OPENSHOP_STORE.MAX_IMAGE_BYTES + 1)
    finally:
        if temporary:
            try:
                os.remove(output_path)
            except OSError:
                pass

async def normalize_openshop_generation_result(snapshot: Dict[str, Any], image_data: Dict[str, Any]) -> bytes:
    source_path, _source_metadata = await asyncio.to_thread(
        OPENSHOP_STORE.asset_path, snapshot["sourceAssetId"]
    )
    mask_path, _mask_metadata = await asyncio.to_thread(
        OPENSHOP_STORE.asset_path, snapshot["maskAssetId"]
    )
    with open(source_path, "rb") as source_handle, open(mask_path, "rb") as mask_handle:
        source_bytes = source_handle.read()
        mask_bytes = mask_handle.read()
    generated_bytes = await generated_image_bytes(image_data)
    if len(generated_bytes) > OPENSHOP_STORE.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="OpenShop 生图结果超过 64 MiB 限制")
    return await asyncio.to_thread(
        normalize_local_generation,
        source_bytes, mask_bytes, generated_bytes, snapshot["selection"],
    )

async def store_openshop_generation_output(
    project_id: str, owner: Dict[str, Any], content: bytes, child_id: str,
) -> Dict[str, Any]:
    asset = await asyncio.to_thread(
        OPENSHOP_STORE.store_image, project_id, owner, content, "image/png",
        f"{child_id}.png", "ai-output",
    )
    asset["url"] = f"/api/openshop/assets/{asset['assetId']}"
    return asset

def public_openshop_asset(asset: Dict[str, Any]) -> Dict[str, Any]:
    return {key: asset[key] for key in (
        "assetId", "url", "name", "width", "height", "mime"
    )}

async def run_openshop_generation_child(
    parent_id: str, child_id: str, project_id: str, owner: Dict[str, Any],
    snapshot: Dict[str, Any], provider_id: str, model_id: str,
):
    if not OPENSHOP_AI_TASKS.mark_child_running(parent_id, child_id):
        return
    try:
        async with OPENSHOP_GENERATION_SEMAPHORE:
            references = await openshop_generation_references(snapshot)
            image_data, _raw = await generate_ai_image(
                openshop_generation_prompt(snapshot), snapshot["size"], snapshot["quality"],
                model_id, references, provider_id,
            )
        if not OPENSHOP_AI_TASKS.can_complete_child(parent_id, child_id):
            return
        normalized_png = await normalize_openshop_generation_result(snapshot, image_data)
        asset = await store_openshop_generation_output(project_id, owner, normalized_png, child_id)
        if not OPENSHOP_AI_TASKS.succeed_child(parent_id, child_id, public_openshop_asset(asset)):
            await asyncio.to_thread(OPENSHOP_STORE.collect_garbage)
    except asyncio.CancelledError:
        return
    except Exception as exc:
        OPENSHOP_AI_TASKS.fail_child(parent_id, child_id, getattr(exc, "detail", None) or str(exc))

def create_and_schedule_openshop_generation(
    project_id: str, owner: Dict[str, Any], snapshot: Dict[str, Any],
    provider_id: str, model_id: str, retry_of_task_id: str = "",
) -> Dict[str, Any]:
    parent = OPENSHOP_AI_TASKS.create_parent(
        project_id, owner, snapshot, provider_id, model_id,
        retry_of_task_id=retry_of_task_id,
    )
    for index in snapshot["requestedIndexes"]:
        child = OPENSHOP_AI_TASKS.create_child(parent["taskId"], index)
        future = asyncio.create_task(run_openshop_generation_child(
            parent["taskId"], child["childTaskId"], project_id, owner,
            deepcopy(snapshot), provider_id, model_id,
        ))
        OPENSHOP_AI_TASKS.bind_child(parent["taskId"], child["childTaskId"], future)
    return OPENSHOP_AI_TASKS.get(parent["taskId"], project_id, owner)
```

创建路由先把 Pydantic payload 转成 Task 1 的 camelCase snapshot，再调用 `create_and_schedule_openshop_generation()`。每个子任务只生成一个输出；即使上游支持批量也先保持统一的独立状态和取消语义。`generate_ai_image()` 返回后调用 Task 3 的透明规范化，再以 `ai-output` 角色存储 PNG。

- [ ] **Step 5: 实现补生成和取消**

`retry-missing` 只接受 `partial` 或 `failed` 父任务，复制冻结的提示词、资源 ID、选区和模型参数，目标数等于原任务缺失数量，并写入新的 `retryOfTaskId`。删除父任务时取消所有未终止 child future；迟到输出不落库、不改变 `cancelled`。

```python
@app.post("/api/openshop/projects/{project_id}/ai-tasks/{task_id}/retry-missing")
async def retry_openshop_ai_task(project_id: str, task_id: str, payload: OpenShopAiRetryRequest):
    await ensure_openshop_project_owner(project_id, payload.owner)
    previous = OPENSHOP_AI_TASKS.get(task_id, project_id, payload.owner)
    missing = int(previous["targetCount"]) - int(previous["completedCount"])
    if previous["status"] not in {"partial", "failed"} or missing < 1:
        raise HTTPException(status_code=409, detail="OpenShop 任务没有可补生成的结果")
    missing_indexes = [
        int(child["index"])
        for child in previous["children"]
        if child["status"] in {"failed", "cancelled"}
    ]
    snapshot = {
        **previous["snapshot"],
        "targetCount": missing,
        "originalTargetCount": int(
            previous["snapshot"].get("originalTargetCount") or previous["targetCount"]
        ),
        "requestedIndexes": missing_indexes,
    }
    parent = create_and_schedule_openshop_generation(
        project_id, payload.owner, snapshot,
        previous["apiConfigId"], previous["modelId"], retry_of_task_id=task_id,
    )
    return {"task_id": parent["taskId"], "status": parent["status"], "task": parent}
```

- [ ] **Step 6: 运行 API 测试**

Run: `node tools/tests/openshop-ai-api.test.mjs`

Expected: PASS，并输出 `OpenShop AI API tests passed`。

- [ ] **Step 7: 提交后端任务改动**

```bash
git add main.py tools/tests/openshop-ai-api.test.mjs
git commit -m "feat: run OpenShop multi-output generation tasks"
```

### Task 5: 打通 HstarA 素材库引用导入

**Files:**
- Modify: `main.py:2768-2795`
- Modify: `main.py:16656-16687`
- Modify: `tools/tests/openshop-ai-api.test.mjs`

- [ ] **Step 1: 写素材库导入的失败测试**

在临时 HstarA 数据目录创建一个素材库图片条目，然后通过项目所有权和素材库 ID 导入：

```python
imported = await client.post(
    "/api/openshop/projects/project-ai/asset-imports",
    json={
        "owner": owner,
        "library_id": library_id,
        "category_id": category_id,
        "item_id": item_id,
    },
)
assert imported.status_code == 200, imported.text
asset = imported.json()["asset"]
assert len(asset["assetId"]) == 64
assert asset["url"] == f"/api/openshop/assets/{asset['assetId']}"
assert asset["role"] == "ai-reference"

wrong_owner = await client.post(
    "/api/openshop/projects/project-ai/asset-imports",
    json={
        "owner": {**owner, "nodeId": "other-node"},
        "library_id": library_id, "category_id": category_id, "item_id": item_id,
    },
)
assert wrong_owner.status_code == 403
```

- [ ] **Step 2: 运行 API 测试并确认 404**

Run: `node tools/tests/openshop-ai-api.test.mjs`

Expected: FAIL，`/asset-imports` 返回 404。

- [ ] **Step 3: 实现按 ID 查找和同机文件复制**

新增请求模型：

```python
class OpenShopAssetImportRequest(BaseModel):
    owner: Dict[str, Any]
    library_id: str
    category_id: str = ""
    item_id: str
```

路由先调用 `ensure_openshop_project_owner()`，再遍历 `load_asset_library()` 的指定库和分组。只接受素材库真实存在且类型为图片的条目；用现有 `output_file_from_url()` 解析 `/assets/` 或 `/output/`，检查文件大小和 MIME 后调用 `OPENSHOP_STORE.store_image(..., role="ai-reference")`。不得接受客户端传入任意磁盘路径或任意远程 URL。

```python
def find_asset_library_item(
    library: Dict[str, Any], library_id: str, category_id: str, item_id: str,
) -> Dict[str, Any]:
    selected_library = next(
        (item for item in library.get("libraries", []) if item.get("id") == library_id),
        None,
    )
    if not selected_library:
        raise HTTPException(status_code=404, detail="素材库不存在")
    categories = selected_library.get("categories", [])
    selected_category = next(
        (item for item in categories if item.get("id") == category_id),
        None,
    ) if category_id else None
    items = selected_category.get("items", []) if selected_category else selected_library.get("items", [])
    result = next((item for item in items if item.get("id") == item_id), None)
    if not result or str(result.get("type") or "image").lower() not in {"image", "photo"}:
        raise HTTPException(status_code=404, detail="素材库图片不存在")
    return result

@app.post("/api/openshop/projects/{project_id}/asset-imports")
async def import_openshop_library_asset(project_id: str, payload: OpenShopAssetImportRequest):
    await ensure_openshop_project_owner(project_id, payload.owner)
    item = find_asset_library_item(
        load_asset_library(), payload.library_id, payload.category_id, payload.item_id
    )
    path = output_file_from_url(str(item.get("url") or ""))
    if not path or not os.path.isfile(path):
        raise HTTPException(status_code=404, detail="素材库图片不存在")
    with open(path, "rb") as handle:
        content = handle.read(OPENSHOP_STORE.MAX_IMAGE_BYTES + 1)
    if len(content) > OPENSHOP_STORE.MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="素材库图片超过 OpenShop 限制")
    asset = await asyncio.to_thread(
        OPENSHOP_STORE.store_image, project_id, payload.owner, content,
        content_type_for_path(path), item.get("name") or os.path.basename(path), "ai-reference",
    )
    asset["url"] = f"/api/openshop/assets/{asset['assetId']}"
    return {"asset": asset}
```

- [ ] **Step 4: 运行 API 测试**

Run: `node tools/tests/openshop-ai-api.test.mjs`

Expected: PASS。

- [ ] **Step 5: 提交素材库桥接改动**

```bash
git add main.py tools/tests/openshop-ai-api.test.mjs
git commit -m "feat: import asset library images into OpenShop projects"
```

### Task 6: 实现参考资源管理器和固定 @ 别名

**Files:**
- Create: `integrations/openshop/host/openshop-reference-manager.js`
- Create: `integrations/openshop/tests/hstar-reference-manager.test.js`

- [ ] **Step 1: 写别名、全部发送、缩略图刷新和资源失效测试**

```javascript
const manager = window.HstarOpenShopReferenceManager.createManager({
  editor,
  runtime,
  assetApi,
  fetchImpl,
  captureVisibleComposite: async () => ({dataUrl:fullDataUrl, width:1920, height:1080}),
  captureSelection: async () => ({dataUrl:selectionDataUrl, width:640, height:420}),
});

await manager.setPrimaryMode('full');
await manager.addCurrentSelection();
await manager.addLayer(projectImageLayer);
await manager.addLibraryItem({libraryId:'lib-1', categoryId:'cat-1', itemId:'item-1'});
await manager.addLocalFile(localPngFile);

const references = manager.list();
expect(references.map(item => item.mention)).toEqual([
  '@参考图1', '@选区1', '@参考图2', '@参考图3', '@参考图4',
]);
const snapshot = await manager.snapshotForTask({mode:'full', maxReferences:8});
expect(snapshot.references).toHaveLength(5);
expect(snapshot.references.every(item => item.assetId)).toBe(true);
expect(snapshot.mentionMap['@参考图3']).toBe(snapshot.references[3].assetId);
expect(JSON.stringify(snapshot)).not.toMatch(/data:image\/|blob:|seed/i);

editor.layers[0].visible = false;
window.dispatchEvent(new CustomEvent('openshop:project-dirty'));
await Promise.resolve();
expect(manager.getPrimary().thumbnailVersion).toBeGreaterThan(1);

assetApi.exists.mockResolvedValueOnce(false);
await manager.validate();
expect(manager.getInvalidReferences()).toEqual(['@参考图2']);
```

- [ ] **Step 2: 运行单元测试并确认脚本不存在**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-reference-manager.test.js`

Expected: FAIL，`HstarOpenShopReferenceManager` 未定义。

- [ ] **Step 3: 实现引用管理器**

引用管理器只在内存中保留实时预览 Data URL；一旦任务冻结，先上传并只返回资源 ID：

```javascript
function aliasFor(sourceType, records){
  const selection = sourceType === 'selection';
  const prefix = selection ? '选区' : '参考图';
  const count = records.filter(item => (item.sourceType === 'selection') === selection).length + 1;
  return `${prefix}${count}`;
}

async function snapshotForTask({
  mode = state.primaryMode, maxReferences = 8, fullCompositeAsset = null,
} = {}){
  if(mode === 'full' && fullCompositeAsset?.assetId){
    state.primary = {
      ...state.primary,
      assetId:fullCompositeAsset.assetId,
      alias:'参考图1', mention:'@参考图1', sourceType:'primary',
      width:Number(fullCompositeAsset.width || editor.canvasW),
      height:Number(fullCompositeAsset.height || editor.canvasH),
    };
  } else {
    await refreshPrimary();
  }
  await validate();
  const invalid = getInvalidReferences();
  if(invalid.length) throw new Error(`参考资源不可用：${invalid.join('、')}`);
  const all = [state.primary, ...state.references];
  if(all.length > Number(maxReferences || 8)){
    throw new Error(`当前模型最多支持 ${Number(maxReferences || 8)} 张参考图`);
  }
  const frozen = [];
  for(const item of all){
    const asset = item.assetId ? item : await freezeReference(item);
    frozen.push({
      assetId:asset.assetId, alias:asset.alias, mention:`@${asset.alias}`,
      sourceType:asset.sourceType, order:frozen.length,
      width:Number(asset.width || 0), height:Number(asset.height || 0),
    });
  }
  return {
    primaryReferenceAssetId:frozen[0].assetId,
    references:frozen,
    mentionMap:Object.fromEntries(frozen.map(item => [item.mention, item.assetId])),
  };
}

function captureVisibleComposite(){
  const width = Math.max(1, Math.round(Number(editor.canvasW || 1)));
  const height = Math.max(1, Math.round(Number(editor.canvasH || 1)));
  const dataUrl = editor.canvas.toDataURL({
    format:'png', quality:1, left:0, top:0, width, height, multiplier:1,
  });
  return {dataUrl, width, height};
}

function captureSelectionMask(){
  if(!editor._selectionMask && !editor._selectionBounds) throw new Error('当前没有可用选区');
  const width = Math.max(1, Math.round(Number(editor.canvasW || 1)));
  const height = Math.max(1, Math.round(Number(editor.canvasH || 1)));
  const canvas = documentRef.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  context.fillStyle = '#000';
  context.fillRect(0, 0, width, height);
  if(editor._selectionMask?.mask){
    const source = editor._selectionMask;
    const image = context.createImageData(width, height);
    for(let y = 0; y < height; y += 1){
      for(let x = 0; x < width; x += 1){
        const sourceX = Math.floor(x * source.w / width);
        const sourceY = Math.floor(y * source.h / height);
        const selected = Boolean(source.mask[sourceY * source.w + sourceX]);
        const offset = (y * width + x) * 4;
        image.data[offset] = image.data[offset + 1] = image.data[offset + 2] = selected ? 255 : 0;
        image.data[offset + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
  } else {
    const bounds = editor._selectionBounds;
    context.fillStyle = '#fff';
    context.fillRect(bounds.x, bounds.y, bounds.w, bounds.h);
  }
  return {dataUrl:canvas.toDataURL('image/png'), width, height};
}
```

控制器公开 `captureVisibleComposite`、`captureSelectionMask`、`snapshotForTask`、`list`、`getPrimary` 和四个添加入口。`＋` 数据源分别调用：当前选区截图、项目图片图层导出、Task 5 的素材库导入接口、本地文件 `assetApi.upload()`。所有已经添加的引用都进入 `references`；提示词中是否出现 `@` 不影响发送。

- [ ] **Step 4: 实现 @ 光标插入和选择器数据**

导出 `itemsForMentionPicker()` 和 `insertMention(text, start, end, mention)`；选择器项固定包含缩略图、别名和来源类型。过滤只影响显示，不改变引用集合。

```javascript
function insertMention(text, start, end, mention){
  const before = String(text || '').slice(0, Math.max(0, start));
  const after = String(text || '').slice(Math.max(start, end));
  const next = `${before}${mention} ${after}`;
  return {text:next, cursor:before.length + mention.length + 1};
}

function itemsForMentionPicker(query=''){
  const needle = clean(query).toLowerCase();
  return [state.primary, ...state.references]
    .filter(Boolean)
    .filter(item => !needle || item.alias.toLowerCase().includes(needle))
    .map(item => ({
      mention:`@${item.alias}`, alias:item.alias, sourceType:item.sourceType,
      thumbnailUrl:item.thumbnailUrl,
    }));
}
```

- [ ] **Step 5: 运行引用管理测试**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-reference-manager.test.js`

Expected: PASS。

- [ ] **Step 6: 提交引用管理器**

```bash
git add integrations/openshop/host/openshop-reference-manager.js integrations/openshop/tests/hstar-reference-manager.test.js
git commit -m "feat: manage OpenShop generative references"
```

### Task 7: 实现可恢复的生成任务客户端

**Files:**
- Create: `integrations/openshop/host/openshop-generative-client.js`
- Create: `integrations/openshop/tests/hstar-generative-client.test.js`
- Modify: `integrations/openshop/host/openshop-ai-client.js:44-273`
- Modify: `integrations/openshop/tests/hstar-ai-client.test.js`

- [ ] **Step 1: 写父任务、部分成功、补生成和隐藏持续轮询测试**

```javascript
const client = window.HstarOpenShopGenerativeClient.createClient({
  fetchImpl,
  pollIntervalMs:1,
});
client.startSession(context);
const created = await client.createTask(context, requestSnapshot);
const updates = [];
const task = await client.pollTask(context, created.task_id, {
  onUpdate:value => updates.push(value.status),
});
expect(task.status).toBe('partial');
expect(task.completedCount).toBe(2);
expect(task.failedCount).toBe(1);
expect(updates).toContain('running');

document.dispatchEvent(new Event('visibilitychange'));
expect(fetchImpl).toHaveBeenCalled();
expect(client.getState().activePolls).toBe(0);

const retry = await client.retryMissing(context, task.taskId);
expect(retry.task.retryOfTaskId).toBe(task.taskId);
```

另写取消测试：`cancelTask()` 后服务端迟到 `succeeded` 响应仍返回 `cancelled`，客户端不触发 `onResult`。

- [ ] **Step 2: 运行客户端测试并确认失败**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-generative-client.test.js tests/hstar-ai-client.test.js`

Expected: FAIL，生成客户端脚本不存在，且现有客户端还不把 `partial` 视为父任务终态。

- [ ] **Step 3: 实现项目级客户端**

```javascript
const PARENT_TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);

function requestBody(context, input){
  return {
    owner:{
      canvasType:context.canvasType, canvasId:context.canvasId, nodeId:context.nodeId,
    },
    tool_id:input.toolId,
    source_asset_id:input.sourceAssetId,
    mask_asset_id:input.maskAssetId,
    primary_reference_asset_id:input.primaryReferenceAssetId,
    reference_assets:input.references,
    provider_id:input.apiConfigId,
    model_id:input.modelId,
    prompt:input.prompt,
    size:input.size,
    quality:input.quality,
    target_count:input.targetCount,
    reference_mode:input.referenceMode,
    source_layer_id:input.sourceLayerId,
    source_layer_index:input.sourceLayerIndex,
    document:input.document,
    selection:input.selection,
    options:{},
  };
}

async function createTask(context, input){
  return request(projectTaskUrl(context), {
    method:'POST', headers:{'Content-Type':'application/json'},
    body:JSON.stringify(requestBody(safeContext(context), input)),
  });
}

async function pollTask(context, taskId, options = {}){
  const normalized = safeContext(context);
  const signal = options.signal;
  while(true){
    if(signal?.aborted) throw abortError();
    const value = await request(projectTaskUrl(normalized, taskId), {method:'GET', signal});
    const task = value.task || value;
    options.onUpdate?.(task);
    if(PARENT_TERMINAL.has(task.status)) return task;
    await wait(Number(options.intervalMs || pollIntervalMs), signal);
  }
}
```

客户端不监听 `document.visibilitychange`，不因外层关闭而 `abort()`。只有 `openshop:session-stopped`、用户主动取消、节点/画布删除或 HstarA 退出才停止。`restoreTasks(records)` 对 `queued/running` 记录继续轮询；GET 返回 404 时生成失败记录“后台服务已重启，任务状态不可恢复”，并保留冻结参数用于重试。

- [ ] **Step 4: 让共享 AI 客户端兼容 partial**

把现有 `pollTask()` 的终态数组扩展为 `['succeeded', 'partial', 'failed', 'cancelled']`，不改变文字工具行为。

```javascript
const task = value.task || value;
if(['succeeded', 'partial', 'failed', 'cancelled'].includes(task?.status)) return task;
```

- [ ] **Step 5: 运行客户端测试**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-generative-client.test.js tests/hstar-ai-client.test.js`

Expected: PASS。

- [ ] **Step 6: 提交客户端改动**

```bash
git add integrations/openshop/host/openshop-generative-client.js integrations/openshop/host/openshop-ai-client.js integrations/openshop/tests/hstar-generative-client.test.js integrations/openshop/tests/hstar-ai-client.test.js
git commit -m "feat: add resumable OpenShop generative client"
```

### Task 8: 实现始终可点击的入口、选区状态机和底部操作栏

**Files:**
- Create: `integrations/openshop/host/openshop-generative-tools.js`
- Create: `integrations/openshop/host/openshop-generative-tools.css`
- Create: `integrations/openshop/tests/hstar-generative-tools.test.js`
- Modify: `integrations/openshop/index.html:2419-2428`
- Modify: `integrations/openshop/index.html:2895-2903`
- Modify: `integrations/openshop/index.html:3161-3180`
- Modify: `integrations/openshop/index.html:4610-4628`

- [ ] **Step 1: 写无选区入口和状态转换失败测试**

```javascript
const controller = window.HstarOpenShopGenerativeTools.createController(dependencies);
await controller.start();
const fill = document.querySelector('[data-hstar-generative-tool="generative-fill"]');
const redraw = document.querySelector('[data-hstar-generative-tool="local-redraw"]');
expect(fill.disabled).toBe(false);
expect(redraw.disabled).toBe(false);

redraw.click();
expect(editor.setTool).toHaveBeenCalledWith('marquee-rect');
expect(controller.getState().status).toBe('selecting');
expect(document.querySelector('[data-generative-selection-hint]').textContent)
  .toContain('请先选择要修改的区域');
expect(assetApi.upload).not.toHaveBeenCalled();
expect(generativeClient.createTask).not.toHaveBeenCalled();

editor._selectionBounds = {x:10, y:20, w:300, h:200};
window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
expect(controller.getState().status).toBe('ready');
expect(document.querySelector('[data-generative-operation-bar]').hidden).toBe(false);

editor._selectionBounds = null;
window.dispatchEvent(new CustomEvent('openshop:selection-changed'));
expect(controller.getState().status).toBe('selecting');
expect(controller.getState().prompt).toBe('保留的未提交提示词');
```

- [ ] **Step 2: 运行工具测试并确认失败**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-generative-tools.test.js`

Expected: FAIL，控制器脚本不存在。

- [ ] **Step 3: 给 OpenShop 选区完成点发送统一事件**

在 `OS` 增加一个轻量入口，并在矩形/椭圆选框完成、套索双击、魔棒/AI 分割 `_recalcSelectionBounds()` 和 `clearSelection()` 后调用：

```javascript
_emitSelectionChanged(reason='updated') {
    window.dispatchEvent(new CustomEvent('openshop:selection-changed', {
        detail: {
            reason,
            tool:this.state.tool,
            hasSelection:Boolean(this._selectionMask || this._selectionBounds),
            bounds:this._selectionBounds ? {...this._selectionBounds} : null,
        },
    }));
},
```

不得通过定时器轮询选区，也不得修改 OpenShop 原有选区数据结构。

- [ ] **Step 4: 实现状态机和两个独立入口**

```javascript
const TOOLS = new Set(['generative-fill', 'local-redraw']);
const SELECTION_TOOLS = new Set(['marquee-rect', 'marquee-ellipse', 'lasso', 'magic-wand', 'ai-segment']);

function openTool(toolId){
  if(!TOOLS.has(toolId)) throw new Error('OpenShop 生成工具不存在');
  state.activeTool = toolId;
  if(!selectionAvailable()){
    const nextTool = SELECTION_TOOLS.has(state.lastSelectionTool)
      ? state.lastSelectionTool
      : 'marquee-rect';
    editor.setTool(nextTool);
    state.status = 'selecting';
  } else {
    state.status = 'ready';
  }
  render();
}
```

按钮放在现有选取参数区域旁边，按钮本身始终 enabled。只有提交按钮根据有效选区、提示词和模型能力禁用，并显示具体原因。

- [ ] **Step 5: 实现底部操作栏和局部重绘专属引用区**

公共控件：功能名、选区数量、提示词、API、模型、尺寸、质量、动态数量步进器、提交、取消、关闭、进度。只有 `local-redraw` 渲染：

```html
<div class="hstar-reference-mode" role="radiogroup" aria-label="参考范围">
  <button type="button" data-reference-mode="selection">参考选择区域</button>
  <button type="button" data-reference-mode="full" aria-pressed="true">参考全图</button>
</div>
<div class="hstar-reference-strip" data-reference-strip>
  <button type="button" class="hstar-reference-add" aria-label="添加参考图">＋</button>
</div>
```

主参考缩略图位于提示词上方左侧。输入 `@` 时在光标附近显示 `referenceManager.itemsForMentionPicker()`；点击后只插入 mention，不改变发送集合。`generative-fill` 不显示胶囊、缩略图、`＋` 和 `@` 窗口，且允许空提示词。

- [ ] **Step 6: 冻结并提交完整任务快照**

`submit()` 只有在有效选区和可用模型通过后才上传资源。全图合成、白色代表选中区域的同尺寸蒙版、主参考和额外参考都先写入 OpenShop 内容寻址存储；任务创建后立刻把父记录写入项目并开始持续轮询：

```javascript
function upsertTaskRecord(task){
  editor.__hstarAiTaskRecords = Array.isArray(editor.__hstarAiTaskRecords)
    ? editor.__hstarAiTaskRecords
    : [];
  const index = editor.__hstarAiTaskRecords.findIndex(item => item.taskId === task.taskId);
  const record = clone(task);
  if(index >= 0) editor.__hstarAiTaskRecords[index] = record;
  else editor.__hstarAiTaskRecords.push(record);
  editor.__hstarAiTaskRecords = editor.__hstarAiTaskRecords.slice(-100);
  markDirty('OpenShop generation task updated');
}

async function monitorTask(task){
  const context = currentContext();
  const completed = await generativeClient.pollTask(context, task.taskId, {
    onUpdate:update => {
      upsertTaskRecord(update);
      state.lastTask = clone(update);
      render();
    },
  });
  upsertTaskRecord(completed);
  state.lastTask = clone(completed);
  await applyTaskResults(completed);
  render();
  return completed;
}

async function submit(){
  if(!selectionAvailable()){
    state.status = 'selecting';
    render();
    return null;
  }
  const selected = resolvedModel();
  const limits = capabilityLimits(selected.model);
  validateSubmission(selected, limits);
  state.status = 'preparing';
  render();
  const context = currentContext();
  const sourceLayerIndex = Number(editor.activeLayerIdx || 0);
  const sourceLayer = editor.layers[sourceLayerIndex];
  const composite = await referenceManager.captureVisibleComposite();
  const mask = await referenceManager.captureSelectionMask();
  const sourceAsset = await assetApi.upload({
    dataUrl:composite.dataUrl, role:'ai-source', name:`${context.projectId}-composite.png`,
  });
  const maskAsset = await assetApi.upload({
    dataUrl:mask.dataUrl, role:'ai-mask', name:`${context.projectId}-mask.png`,
  });
  const referenceSnapshot = state.activeTool === 'local-redraw'
    ? await referenceManager.snapshotForTask({
        mode:state.referenceMode, maxReferences:limits.maxReferences,
        fullCompositeAsset:sourceAsset,
      })
    : {primaryReferenceAssetId:sourceAsset.assetId, references:[]};
  const bounds = selectionBounds();
  const request = {
    toolId:state.activeTool,
    sourceAssetId:sourceAsset.assetId,
    maskAssetId:maskAsset.assetId,
    primaryReferenceAssetId:referenceSnapshot.primaryReferenceAssetId,
    references:referenceSnapshot.references,
    apiConfigId:selected.apiConfigId,
    modelId:selected.modelId,
    prompt:state.prompt,
    size:state.size,
    quality:state.quality,
    targetCount:state.count,
    referenceMode:state.activeTool === 'generative-fill' ? 'full' : state.referenceMode,
    sourceLayerId:sourceLayer.layerId,
    sourceLayerIndex,
    document:{
      width:Number(editor.canvasW), height:Number(editor.canvasH),
      layerVersion:Number(editor.historyIdx || 0),
      visibleCompositeVersion:state.compositeVersion,
    },
    selection:{...bounds, feather:Number(state.feather || 0)},
  };
  const created = await generativeClient.createTask(context, request);
  upsertTaskRecord(created.task);
  state.status = 'running';
  return monitorTask(created.task);
}
```

`openshop:project-dirty` 每次触发时递增 `state.compositeVersion` 并刷新主参考缩略图；任务提交后使用冻结资源 ID，不受后续画布变化影响。

- [ ] **Step 7: 实现动态能力约束**

数量最大值取当前模型 `capabilities.maxOutputs`，缺失时为 8；参考图上限、尺寸和质量选项也从当前模型读取。配置被删除时保留用户原选择文字并显示“配置不可用”，不静默切换。

```javascript
function capabilityLimits(model){
  const capabilities = model?.capabilities || {};
  return {
    maxOutputs:Math.max(1, Number(capabilities.maxOutputs || 8)),
    maxReferences:Math.max(1, Number(capabilities.maxReferenceImages || 8)),
    sizes:Array.isArray(capabilities.sizes) && capabilities.sizes.length ? capabilities.sizes : ['auto'],
    qualities:Array.isArray(capabilities.qualities) && capabilities.qualities.length ? capabilities.qualities : ['auto'],
  };
}
```

- [ ] **Step 8: 实现响应式样式**

桌面操作栏固定在画布底部中央，不遮挡右侧图层面板；`max-width:min(920px, calc(100vw - 96px))`。`max-width:640px` 时变为位于 48px 底部工具栏上方的可滚动抽屉，提示词、缩略图、`@` 窗口和提交按钮保持可见。按钮半径不超过 6px，模式切换使用分段胶囊控件。

```css
.hstar-generative-bar {
  position:fixed;
  left:50%;
  bottom:56px;
  z-index:70;
  width:min(920px, calc(100vw - 96px));
  max-height:min(54vh, 520px);
  overflow:auto;
  transform:translateX(-50%);
}

@media (max-width:640px) {
  .hstar-generative-bar {
    left:0;
    right:0;
    bottom:48px;
    width:100%;
    max-height:58vh;
    transform:none;
  }
}
```

- [ ] **Step 9: 运行工具测试**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-generative-tools.test.js`

Expected: PASS。

- [ ] **Step 10: 提交工具 UI**

```bash
git add integrations/openshop/index.html integrations/openshop/host/openshop-generative-tools.js integrations/openshop/host/openshop-generative-tools.css integrations/openshop/tests/hstar-generative-tools.test.js
git commit -m "feat: add OpenShop inline generative controls"
```

### Task 9: 自动创建多个透明结果图层并保存

**Files:**
- Modify: `integrations/openshop/host/openshop-generative-tools.js`
- Modify: `integrations/openshop/tests/hstar-generative-tools.test.js`
- Modify: `integrations/openshop/host/openshop-project-adapter.js:300-520`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js`

- [ ] **Step 1: 写多图层、部分成功、源层删除和取消迟到响应测试**

```javascript
const task = {
  taskId:'parent-1', toolId:'local-redraw', status:'partial',
  targetCount:4, completedCount:3, failedCount:1,
  snapshot:{sourceLayerId:'source-layer', sourceLayerIndex:1, prompt:'修改天空'},
  children:[
    {childTaskId:'child-0', index:0, status:'succeeded', outputAssetId:'a'.repeat(64), result:{url:'/api/openshop/assets/a'}},
    {childTaskId:'child-1', index:1, status:'failed', outputAssetId:'', error:'timeout'},
    {childTaskId:'child-2', index:2, status:'succeeded', outputAssetId:'b'.repeat(64), result:{url:'/api/openshop/assets/b'}},
    {childTaskId:'child-3', index:3, status:'succeeded', outputAssetId:'c'.repeat(64), result:{url:'/api/openshop/assets/c'}},
  ],
};
await controller.applyTaskResults(task);
const generated = editor.layers.filter(layer => layer.hstarAiGeneration?.taskId === 'parent-1');
expect(generated).toHaveLength(3);
expect(generated.map(layer => layer.name)).toEqual([
  '局部重绘 1/4', '局部重绘 3/4', '局部重绘 4/4',
]);
expect(generated.every(layer => layer.visible)).toBe(true);
expect(generated.every(layer => layer.objects[0].left === 0 && layer.objects[0].top === 0)).toBe(true);
expect(runtime.requestSave).toHaveBeenCalledWith({reason:'ai-generation'});

editor.layers = editor.layers.filter(layer => layer.layerId !== 'source-layer');
await controller.applyTaskResults({...task, taskId:'parent-2'});
expect(editor.__hstarAiPendingResults).toHaveLength(3);
expect(editor.layers.some(layer => layer.hstarAiGeneration?.taskId === 'parent-2')).toBe(false);

editor.layers = [backgroundLayer, unrelatedLayer, sourceLayer];
await controller.applyTaskResults({...task, taskId:'parent-3'});
expect(editor.layers[2].hstarAiGeneration?.taskId).toBe('parent-3');
expect(editor.layers[3].hstarAiGeneration?.taskId).toBe('parent-3');
expect(editor.layers[4].hstarAiGeneration?.taskId).toBe('parent-3');
```

再模拟先取消后收到成功结果，断言不创建图层。

- [ ] **Step 2: 运行测试并确认失败**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-generative-tools.test.js tests/hstar-project-adapter.test.js`

Expected: FAIL，`applyTaskResults` 或新持久化字段尚未实现。

- [ ] **Step 3: 实现幂等多图层插入**

```javascript
async function createGenerationLayer(task, child){
  const result = child.result || {};
  const image = await imageLoader({
    ...result,
    url:result.url || `/api/openshop/assets/${encodeURIComponent(child.outputAssetId)}`,
  }, fabricRef);
  image.set?.({
    left:0, top:0, selectable:true, visible:true,
    name:task.toolId === 'generative-fill' ? '生成式填充' : '局部重绘',
  });
  image.assetRef = child.outputAssetId;
  image.hstarAssetId = child.outputAssetId;
  image.hstarAssetRole = 'ai-output';
  const denominator = Number(task.snapshot.originalTargetCount || task.targetCount || 1);
  const numerator = Number(child.index || 0) + 1;
  const title = task.toolId === 'generative-fill' ? '生成式填充' : '局部重绘';
  const generation = {
    taskId:task.taskId,
    childTaskId:child.childTaskId,
    retryOfTaskId:task.retryOfTaskId || '',
    toolId:task.toolId,
    prompt:task.snapshot.prompt,
    apiConfigId:task.apiConfigId,
    modelId:task.modelId,
    size:task.snapshot.size,
    quality:task.snapshot.quality,
    referenceMode:task.snapshot.referenceMode,
    references:clone(task.snapshot.references),
    sourceLayerId:task.snapshot.sourceLayerId,
    selection:clone(task.snapshot.selection),
  };
  const layerId = createId('hstar-generation-layer').replaceAll('-', '_');
  image.hstarLayerId = layerId;
  return {
    layerId,
    name:`${title} ${numerator}/${denominator}`,
    visible:true,
    opacity:100,
    blend:'source-over',
    objects:[image],
    hstarAiGeneration:generation,
  };
}

function syncGenerationObjectOrder(){
  if(typeof editor.canvas.moveTo !== 'function') return;
  editor.layers.flatMap(layer => layer.objects || []).forEach((object, index) => {
    editor.canvas.moveTo(object, index);
  });
}

async function applyTaskResults(task){
  if(task.status === 'cancelled') return [];
  const successful = task.children
    .filter(child => child.status === 'succeeded' && child.outputAssetId)
    .sort((left, right) => left.index - right.index);
  const applied = new Set(editor.layers.flatMap(layer =>
    layer.hstarAiGeneration?.childTaskId ? [layer.hstarAiGeneration.childTaskId] : []
  ));
  const sourceExists = editor.layers.some(layer => layer.layerId === task.snapshot.sourceLayerId);
  if(!sourceExists){
    queuePendingResults(task, successful.filter(child => !applied.has(child.childTaskId)));
    markDirty('OpenShop AI results pending insertion');
    await runtime.requestSave({reason:'ai-generation'});
    return [];
  }
  const frozenSourceIndex = Math.max(
    0,
    Math.min(editor.layers.length - 1, Number(task.snapshot.sourceLayerIndex || 0)),
  );
  const inserted = [];
  for(const child of successful){
    if(applied.has(child.childTaskId)) continue;
    const layer = await createGenerationLayer(task, child);
    editor.layers.splice(frozenSourceIndex + 1 + inserted.length, 0, layer);
    editor.canvas.add(layer.objects[0]);
    inserted.push(layer);
  }
  editor.activeLayerIdx = frozenSourceIndex + inserted.length;
  syncGenerationObjectOrder();
  editor.updateLayersPanel?.();
  editor.canvas.renderAll?.();
  markDirty('OpenShop AI layers inserted');
  await runtime.requestSave({reason:'ai-generation'});
  return inserted;
}
```

图层元数据 `hstarAiGeneration` 固定记录 `taskId`、`childTaskId`、`toolId`、`prompt`、`apiConfigId`、`modelId`、`size`、`quality`、`referenceMode`、`references`、`sourceLayerId` 和冻结选区；不记录 `seed`。

- [ ] **Step 4: 扩展项目适配器**

`serializeProject()` 和 `restoreProject()` 对称处理：

```javascript
editor.__hstarAiReferenceRecords = clone(project.aiReferenceRecords || []);
editor.__hstarAiTaskRecords = clone((project.aiTaskRecords || []).slice(-100));
editor.__hstarAiPendingResults = clone((project.aiPendingResults || []).slice(-64));

const layerMetadata = editor.layers.map(layer => ({
  layerId:layer.layerId,
  name:layer.name,
  visible:layer.visible !== false,
  opacity:Number(layer.opacity ?? 100),
  blend:clean(layer.blend) || 'source-over',
  sourceBinding:layer.sourceBinding ? clone(layer.sourceBinding) : null,
  hstarAiGeneration:layer.hstarAiGeneration ? clone(layer.hstarAiGeneration) : null,
}));
```

序列化时把 references、children output、pending results 和图层 `assetRef` 加入 `assetRefs`。恢复后对 `queued/running` 任务调用生成客户端恢复，对已经成功但尚未建层的 child 执行幂等补插入。

- [ ] **Step 5: 实现“补生成剩余数量”**

当父任务为 `partial` 或 `failed` 且缺失数大于 0，操作栏显示按钮，调用 `generativeClient.retryMissing()`；新任务结果继续按自己的 `taskId` 建层，名称分母沿用原任务目标数，并在元数据写 `retryOfTaskId`。

```javascript
async function retryMissing(){
  const task = state.lastTask;
  const missing = Number(task?.targetCount || 0) - Number(task?.completedCount || 0);
  if(!['partial', 'failed'].includes(task?.status) || missing < 1) return null;
  const created = await generativeClient.retryMissing(currentContext(), task.taskId);
  return monitorTask(created.task || created);
}
```

- [ ] **Step 6: 运行图层和适配器测试**

Run: `npm --prefix integrations/openshop run test:unit -- tests/hstar-generative-tools.test.js tests/hstar-project-adapter.test.js`

Expected: PASS。

- [ ] **Step 7: 提交自动建层改动**

```bash
git add integrations/openshop/host/openshop-generative-tools.js integrations/openshop/tests/hstar-generative-tools.test.js integrations/openshop/host/openshop-project-adapter.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: create OpenShop layers from generation results"
```

### Task 10: 接入运行时、汉化和确定性构建

**Files:**
- Modify: `integrations/openshop/index.html:8880-8974`
- Modify: `integrations/openshop/locales/zh-CN.js`
- Modify: `integrations/openshop/scripts/build-hstar.mjs:35-62`
- Modify: `integrations/openshop/package.json`
- Modify: `tools/tests/openshop-foundation-build.test.mjs`
- Modify: `tools/tests/openshop-localization-build.test.mjs`

- [ ] **Step 1: 写构建清单、加载顺序和无 seed 失败测试**

在 foundation build 测试把新文件加入 requiredFiles 和源/镜像哈希对比，并断言脚本顺序：

```javascript
const referenceIndex = index.indexOf('./host/openshop-reference-manager.js');
const generativeClientIndex = index.indexOf('./host/openshop-generative-client.js');
const generativeToolsIndex = index.indexOf('./host/openshop-generative-tools.js');
expect(referenceIndex).toBeGreaterThan(textToolsIndex);
expect(generativeClientIndex).toBeGreaterThan(referenceIndex);
expect(generativeToolsIndex).toBeGreaterThan(generativeClientIndex);
assert.match(index, /HstarOpenShopGenerativeTools\.createController/);
for(const path of [
  'host/openshop-reference-manager.js',
  'host/openshop-generative-client.js',
  'host/openshop-generative-tools.js',
]){
  assert.doesNotMatch(readFileSync(`${runtimeRoot}/${path}`, 'utf8'), /\bseed\b/i);
}
```

- [ ] **Step 2: 运行构建测试并确认失败**

Run: `node tools/tests/openshop-foundation-build.test.mjs`

Expected: FAIL，新文件尚未进入 `static/openshop`。

- [ ] **Step 3: 按固定顺序初始化模块**

在 `index.html` 中依次加载 protocol、project adapter、host runtime、AI client、font、text tools、reference manager、generative client、generative tools。DOMContentLoaded 初始化共享 `aiClient` 后创建：

```html
<link rel="stylesheet" href="./host/openshop-generative-tools.css">
```

```javascript
const referenceManager = window.HstarOpenShopReferenceManager.createManager({
  editor:OS, runtime:window.HstarOpenShopRuntime,
  assetApi:window.HstarOpenShopAssetApi,
});
const generativeClient = window.HstarOpenShopGenerativeClient.createClient();
window.HstarOpenShopGenerativeToolsController = window.HstarOpenShopGenerativeTools.createController({
  editor:OS,
  runtime:window.HstarOpenShopRuntime,
  aiClient,
  generativeClient,
  referenceManager,
  assetApi:window.HstarOpenShopAssetApi,
  fabricRef:window.fabric,
});
void window.HstarOpenShopGenerativeToolsController.start();
```

- [ ] **Step 4: 增加简体中文文案**

至少加入“生成式填充”“局部重绘”“参考选择区域”“参考全图”“添加参考图”“请先选择要修改的区域”“补生成剩余数量”“配置不可用”“参考资源不可用”“已完成 {completed}/{target}”。英文 key 作为源文案，中文值按 Photoshop 术语表风格，不把功能合并成一个名称。

```javascript
"Generative Fill": "生成式填充",
"Local Redraw": "局部重绘",
"Reference Selection": "参考选择区域",
"Reference Full Image": "参考全图",
"Add Reference Image": "添加参考图",
"Select an area to modify first": "请先选择要修改的区域",
"Generate Missing Results": "补生成剩余数量",
"Configuration unavailable": "配置不可用",
"Reference unavailable": "参考资源不可用",
"Completed {completed}/{target}": "已完成 {completed}/{target}",
```

- [ ] **Step 5: 更新构建白名单并生成镜像**

把三个 JS 和一个 CSS 加入 `runtimeFiles`；构建脚本仍先删除目标，再只复制白名单。增加脚本：

```javascript
'host/openshop-reference-manager.js',
'host/openshop-generative-client.js',
'host/openshop-generative-tools.js',
'host/openshop-generative-tools.css',
```

```json
"test:hstar:generative": "playwright test tests/hstar-generative-tools.e2e.spec.js"
```

Run: `npm --prefix integrations/openshop run build:hstar`

Expected: PASS，最后输出以 `OPENSHOP_BUILD_SHA256=` 开头并跟随 64 位十六进制摘要的行。

- [ ] **Step 6: 运行构建和汉化测试**

Run: `node tools/tests/openshop-foundation-build.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-localization-build.test.mjs`

Expected: PASS，连续两次构建哈希相同。

- [ ] **Step 7: 提交运行时镜像**

```bash
git add integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/scripts/build-hstar.mjs integrations/openshop/package.json integrations/openshop/host/openshop-reference-manager.js integrations/openshop/host/openshop-generative-client.js integrations/openshop/host/openshop-generative-tools.js integrations/openshop/host/openshop-generative-tools.css static/openshop tools/tests/openshop-foundation-build.test.mjs tools/tests/openshop-localization-build.test.mjs
git commit -m "build: ship OpenShop inline generative tools"
```

### Task 11: 把外层宿主改为项目级隐藏会话池

**Files:**
- Modify: `static/js/openshop-host.js:1-570`
- Modify: `static/css/openshop-host.css:1-126`
- Modify: `tools/tests/openshop-host-session-flow.test.mjs`

- [ ] **Step 1: 写两个项目、关闭隐藏和后台完成失败测试**

把 host test 的 DOM harness 改为允许多个 iframe，并验证：

```javascript
host.openNodeSession(contextA, sourcesA);
await flushAsync();
const sessionA = host.getState().activeSession;
const frameA = frameForProject('project-a');

host.close();
assert.equal(overlay.classList.contains('is-open'), false);
assert.equal(frameA.isConnected, true);
assert.equal(frameA.contentWindow.closed, false);
assert.equal(editorMessagesFor(frameA).some(item => item.type === protocol.TYPES.REQUEST_SAVE), false);
assert.equal(editorMessagesFor(frameA).some(item => item.type === protocol.TYPES.CLOSE), false);

host.openNodeSession(contextB, sourcesB);
await flushAsync();
const frameB = frameForProject('project-b');
assert.notEqual(frameA, frameB);
assert.equal(frameA.hidden, true);
assert.equal(frameB.hidden, false);

dispatchEditorMessage(frameA, projectChangedEnvelopeA);
dispatchEditorMessage(frameA, saveProjectEnvelopeA);
await flushAsync();
assert.ok(canvasMessages.some(message =>
  message.type === 'hstar-openshop-node-meta'
  && message.context.projectId === 'project-a'
  && message.meta.aiCompletedCount === 3
));

host.openNodeSession(contextA, sourcesA);
assert.equal(frameForProject('project-a'), frameA);
assert.equal(editorMessagesFor(frameA).filter(item => item.type === protocol.TYPES.OPEN_SESSION).length, 1);
```

- [ ] **Step 2: 运行 host 测试并确认单 iframe 假设失败**

Run: `node tools/tests/openshop-host-session-flow.test.mjs`

Expected: FAIL，当前 `close()` 发送保存并且第二项目复用同一个 iframe。

- [ ] **Step 3: 实现 project scope 键控会话**

```javascript
const state = {
  sessions:new Map(),
  activeScope:'',
  overlay:null,
  status:'idle',
  error:'',
};

function createSession(context, sources){
  const scope = Protocol.createProjectScope(context);
  const frame = document.createElement('iframe');
  frame.className = 'openshop-session-frame';
  frame.dataset.projectScope = scope;
  frame.title = `图文分层：${clean(context.projectName) || context.projectId}`;
  frame.src = '/static/openshop/index.html';
  frame.hidden = true;
  getOverlay().appendChild(frame);
  const session = {
    scope, frame, sessionId:uuid('openshop-session'), context:{...context},
    project:null, sources:[...sources], frameLoaded:false, editorReady:false,
    appliedRequests:new Set(), bootstrapping:false, status:'loading', error:'',
    activeTaskCount:0, savePending:false, idleSince:0,
  };
  state.sessions.set(scope, session);
  return session;
}
```

所有 `postToEditor()`、`persistProject()`、`bootstrapEditorSession()`、`validEditorEvent()` 都显式接收 session。消息通过 `event.source === session.frame.contentWindow` 和完整 context 双重定位，不再只验证 active session。隐藏 iframe 仍在 DOM，不能设置 `src='about:blank'`、不能移除、不能调用 `stopSession()`。收到任一会话的 `PROJECT_CHANGED`、`SAVE_PROJECT` 或 `SAVE_CONFIRMED` 后都从该项目最后一条生成父任务计算汇总并发回对应画布：

```javascript
function generationSummary(project){
  const tasks = Array.isArray(project?.aiTaskRecords) ? project.aiTaskRecords : [];
  const task = [...tasks].reverse().find(item => item?.kind === 'parent');
  return task ? {
    aiStatus:clean(task.status),
    aiTargetCount:Math.max(0, Number(task.targetCount || 0)),
    aiCompletedCount:Math.max(0, Number(task.completedCount || 0)),
    aiFailedCount:Math.max(0, Number(task.failedCount || 0)),
  } : {aiStatus:'', aiTargetCount:0, aiCompletedCount:0, aiFailedCount:0};
}
```

- [ ] **Step 4: 把关闭改成纯可见性操作**

```javascript
function close(){
  hideOverlay();
  return null;
}

function hideOverlay(){
  getOverlay().classList.remove('is-open');
  getOverlay().setAttribute('aria-hidden', 'true');
}
```

保存按钮仍显式调用 `requestSave()`；打开 API 设置只隐藏 overlay 并切换 HstarA 页面，不终止当前会话。再次打开同项目只切换 frame.hidden 并更新来源，不重新发送 `OPEN_SESSION` 或重新加载项目。

- [ ] **Step 5: 实现显式销毁和空闲回收**

导出 `disposeProject(projectId, context)`，先调用项目删除 API取消后端任务，再给 iframe 发送 `CLOSE`、移除 frame 和 Map 项。普通 `close()` 绝不调用它。定义 `HIDDEN_SESSION_IDLE_MS = 15 * 60 * 1000` 和 `MAX_IDLE_SESSIONS = 3`；空闲回收只允许 `activeTaskCount===0 && savePending===false && status==='saved'` 且隐藏超过 15 分钟的会话，任务运行或保存中不回收。

```javascript
async function disposeProject(projectId, context){
  const scope = Protocol.createProjectScope({...context, projectId});
  const session = state.sessions.get(scope);
  if(!session) return false;
  await fetch(projectUrl(projectId, context), {method:'DELETE'}).catch(() => null);
  postToEditor(session, Protocol.TYPES.CLOSE, {reason:'project-deleted'});
  session.frame.remove();
  state.sessions.delete(scope);
  if(state.activeScope === scope) state.activeScope = '';
  return true;
}
```

- [ ] **Step 6: 更新多 iframe 样式**

`.openshop-session-frame[hidden] { display:none; }`，当前 frame 占满 grid row 2。不要对隐藏 frame 使用 `visibility:hidden` 加持续布局占位；iframe JS 仍持续运行。

```css
.openshop-session-frame {
  grid-row:2;
  width:100%;
  height:100%;
  border:0;
  background:#0d1014;
}
.openshop-session-frame[hidden] { display:none; }
```

- [ ] **Step 7: 运行 host 测试**

Run: `node tools/tests/openshop-host-session-flow.test.mjs`

Expected: PASS，并输出 `OpenShop full-screen host session flow tests passed`。

- [ ] **Step 8: 提交多会话宿主**

```bash
git add static/js/openshop-host.js static/css/openshop-host.css tools/tests/openshop-host-session-flow.test.mjs
git commit -m "feat: keep hidden OpenShop sessions running"
```

### Task 12: 同步普通/智能画布节点进度并完成端到端验收

**Files:**
- Modify: `static/js/canvas-openshop.js:33-280`
- Modify: `static/js/smart-canvas-openshop.js:27-244`
- Modify: `static/js/canvas.js:15185-15224`
- Modify: `static/js/smart-canvas.js:12464-12513`
- Modify: `tools/tests/openshop-classic-node-session-flow.test.mjs`
- Modify: `tools/tests/openshop-smart-node-session-flow.test.mjs`
- Create: `integrations/openshop/tests/hstar-generative-tools.e2e.spec.js`

- [ ] **Step 1: 写节点任务汇总和显式删除测试**

普通与智能节点测试都发送：

```javascript
dispatchMessage({
  type:'hstar-openshop-node-meta',
  context:{canvasType, canvasId, nodeId:node.id, projectId:node.projectId},
  meta:{
    layerCount:7, saveState:'saving', aiStatus:'running',
    aiTargetCount:5, aiCompletedCount:2, aiFailedCount:0,
  },
});
assert.equal(node.aiStatus, 'running');
assert.equal(node.aiTargetCount, 5);
assert.equal(node.aiCompletedCount, 2);
assert.match(renderedCardHtml(node), /2\s*\/\s*5/);
```

删除节点后断言 `HstarOpenShopHost.disposeProject(node.projectId, context)` 只调用一次；关闭 OpenShop、切换节点或删除其他类型节点不调用。

- [ ] **Step 2: 运行节点测试并确认失败**

Run: `node tools/tests/openshop-classic-node-session-flow.test.mjs`

Expected: FAIL，新进度字段尚未保存或渲染。

Run: `node tools/tests/openshop-smart-node-session-flow.test.mjs`

Expected: FAIL，原因相同。

- [ ] **Step 3: 实现节点进度字段和安静的卡片状态**

`applyNodeMeta()` 只接受匹配的四元 context，写入：

```javascript
node.aiStatus = clean(meta.aiStatus);
node.aiTargetCount = Math.max(0, Number(meta.aiTargetCount || 0));
node.aiCompletedCount = Math.max(0, Number(meta.aiCompletedCount || 0));
node.aiFailedCount = Math.max(0, Number(meta.aiFailedCount || 0));
```

卡片在任务运行时显示紧凑进度“生成中 2/5”；部分成功显示“已完成 3/5”；完成后恢复层数与保存状态。不要引入大面积营销式卡片或改变节点稳定尺寸。

- [ ] **Step 4: 接入显式节点删除**

普通和智能画布删除函数在从 nodes 移除前保存节点对象：

```javascript
if(node?.type === 'openshop-layered'){
  window.parent?.HstarOpenShopHost?.disposeProject?.(node.projectId, {
    canvasType:'classic', canvasId:getCanvasId(), nodeId:node.id, projectId:node.projectId,
  });
}
```

智能画布使用 `canvasType:'smart'`。画布彻底 purge 继续由后端 `delete_canvas_projects()` 取消任务；软删除画布保持现有保留语义。

- [ ] **Step 5: 写 OpenShop E2E 工作流**

Playwright 用 mock API 完成以下真实 UI 流程：

1. 无选区点击“局部重绘”，自动进入矩形选框且不发请求。
2. 拖出选区后底栏展开；切换“参考选择区域/参考全图”时缩略图变化。
3. 通过 `＋` 添加选区和素材图，输入 `@`，选择 `@参考图1`。
4. 数量设为模型上限，提交后 mock 返回多 child；成功输出自动建立同数目的可见图层。
5. mock 一个 child 失败，出现“补生成剩余数量”，点击后补一层。
6. 任务运行时点击返回画布，操作其他节点，再打开另一个 OpenShop 节点；旧项目继续完成。
7. 回到旧节点时复用同一个 iframe，图层和进度已经更新。

关键断言示例：

```javascript
await expect(page.getByRole('button', {name:'生成式填充'})).toBeEnabled();
await expect(page.getByRole('button', {name:'局部重绘'})).toBeEnabled();
await expect(page.locator('[data-generative-operation-bar]')).toBeVisible();
await expect(page.locator('[data-layer-row][data-ai-generation]')).toHaveCount(5);
await expect(page.locator('[data-layer-row][data-ai-generation] [data-layer-visible="true"]')).toHaveCount(5);
await expect(page.locator('[data-generative-seed]')).toHaveCount(0);
```

- [ ] **Step 6: 加入桌面、移动和 4K 视觉门槛**

在 `1440x1000`、`1920x1080`、`430x932`、`4096x4096` 视口分别截图，并用 bounding boxes 断言底栏不与 OpenShop 底部工具栏、右侧图层面板、缩略图和 `@` 窗口重叠。移动端底栏可滚动，最长模型名不得溢出按钮。

```javascript
async function expectNoOverlap(leftLocator, rightLocator){
  const left = await leftLocator.boundingBox();
  const right = await rightLocator.boundingBox();
  expect(left).not.toBeNull();
  expect(right).not.toBeNull();
  const separated = left.x + left.width <= right.x
    || right.x + right.width <= left.x
    || left.y + left.height <= right.y
    || right.y + right.height <= left.y;
  expect(separated).toBe(true);
}
```

- [ ] **Step 7: 运行节点、单元和 E2E 测试**

Run: `node tools/tests/openshop-classic-node-session-flow.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-smart-node-session-flow.test.mjs`

Expected: PASS。

Run: `npm --prefix integrations/openshop run test:unit`

Expected: PASS，所有 Vitest 测试通过。

Run: `npm --prefix integrations/openshop run test:hstar:generative`

Expected: PASS，桌面、移动和 4K 用例全部通过。

- [ ] **Step 8: 提交画布同步和 E2E**

```bash
git add static/js/canvas-openshop.js static/js/smart-canvas-openshop.js static/js/canvas.js static/js/smart-canvas.js tools/tests/openshop-classic-node-session-flow.test.mjs tools/tests/openshop-smart-node-session-flow.test.mjs integrations/openshop/tests/hstar-generative-tools.e2e.spec.js
git commit -m "feat: sync OpenShop generation progress to canvases"
```

### Task 13: 全量回归、编码检查和工程版重启

**Files:**
- Modify only if a verification command reveals a Stage 5A regression; keep fixes in the owning file and add a reproducing test before each fix.

- [ ] **Step 1: 检查生成链路没有种子控件，并由契约测试验证持久化数据**

Run:

```powershell
rg -n -i 'data-generative-seed|name=["'']seed["'']|id=["''][^"'']*seed' integrations/openshop/index.html integrations/openshop/host/openshop-generative-tools.js integrations/openshop/host/openshop-generative-tools.css static/openshop/index.html static/openshop/host/openshop-generative-tools.js static/openshop/host/openshop-generative-tools.css
```

Expected: 无输出。`openshop-ai-contract` 和 `openshop-project-storage` 测试负责断言请求快照、项目 JSON 和图层元数据不含 `seed`、密钥、Data URL 或 Blob URL；生产代码允许出现用于拒绝非法字段的校验字符串。

- [ ] **Step 2: 运行 Python 编译和后端测试**

Run: `python -X utf8 -m py_compile openshop_ai.py openshop_image_ops.py openshop_projects.py main.py`

Expected: exit 0，无输出。

Run: `node tools/tests/openshop-ai-contract.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-ai-image-normalization.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-project-storage.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-ai-api.test.mjs`

Expected: PASS。

- [ ] **Step 3: 运行 OpenShop 全部单元和构建回归**

Run: `npm --prefix integrations/openshop run test:unit`

Expected: PASS。

Run: `npm --prefix integrations/openshop run audit:i18n`

Expected: PASS，无缺失的新增中文文案。

Run: `npm --prefix integrations/openshop run build:hstar`

Expected: PASS，并输出确定性 SHA256。

Run: `node tools/tests/openshop-foundation-build.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-localization-build.test.mjs`

Expected: PASS。

- [ ] **Step 4: 运行宿主、普通画布和智能画布回归**

Run: `node tools/tests/openshop-protocol.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-host-session-flow.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-classic-node-session-flow.test.mjs`

Expected: PASS。

Run: `node tools/tests/openshop-smart-node-session-flow.test.mjs`

Expected: PASS。

- [ ] **Step 5: 运行 Playwright 全链路**

Run: `npm --prefix integrations/openshop run test:hstar:e2e`

Expected: PASS。

Run: `npm --prefix integrations/openshop run test:hstar:canvas-integration`

Expected: PASS。

Run: `npm --prefix integrations/openshop run test:hstar:text-tools`

Expected: PASS，Stage 4 文字提取和去除文字没有回归。

Run: `npm --prefix integrations/openshop run test:hstar:generative`

Expected: PASS。

Run: `npm --prefix integrations/openshop run test:hstar:4k`

Expected: PASS。

- [ ] **Step 6: 检查编码、差异和镜像一致性**

Run: `git diff --check`

Expected: exit 0，无空白错误。

Run:

```powershell
$bad = @(
  ([string][char]0x951F + [char]0x65A4 + [char]0x62F7),
  [string][char]0x9983,
  [string][char]0x9215,
  [string][char]0x95C1,
  [string][char]0x00C3,
  [string][char]0x00C2
)
$files = @('openshop_ai.py','openshop_projects.py','openshop_image_ops.py','main.py') +
  (Get-ChildItem integrations/openshop/host,integrations/openshop/locales,static/js -File -Recurse | Select-Object -ExpandProperty FullName)
$hits = Select-String -Path $files -SimpleMatch -Pattern $bad
if($hits){ $hits; exit 1 }
```

Expected: 无新增乱码匹配。

Run: `git status --short`

Expected: 只有本阶段有意修改的源文件、测试和由构建产生的 `static/openshop` 镜像。

- [ ] **Step 7: 提交验证中产生的最小修正**

仅当 Step 1-6 暴露问题时执行；每个修正必须带复现测试：

```bash
git add openshop_ai.py openshop_image_ops.py openshop_projects.py main.py integrations/openshop/host integrations/openshop/tests static/js/openshop-host.js static/js/canvas-openshop.js static/js/smart-canvas-openshop.js static/js/canvas.js static/js/smart-canvas.js static/openshop tools/tests
git commit -m "fix: close OpenShop generative regression gaps"
```

若没有修正，跳过本提交。

- [ ] **Step 8: 重启 HstarA 工程版并做浏览器烟雾测试**

停止当前占用 `3000` 端口且工作目录属于本仓库的工程服务器，然后在仓库根目录执行以下命令，以隐藏窗口重新启动工程版：

```powershell
Start-Process -FilePath '.\python\python.exe' -ArgumentList '-X','utf8','main.py' -WorkingDirectory (Get-Location) -WindowStyle Hidden
```

Expected: `http://127.0.0.1:3000/` 在 30 秒内返回 200。随后在 HstarA 工程版依次打开普通画布和智能画布，各创建两个“图文分层”节点，确认：

- 两个入口无选区时可点击并进入选区工具。
- 底部操作栏、参考缩略图和 `@` 选择器可用。
- 生成任务运行时返回画布不会停止。
- 不同节点数据和会话互不影响。
- 多结果自动建立同数目的可见图层。
- 删除节点会取消该项目任务，其他项目继续运行。

- [ ] **Step 9: 最终提交**

```bash
git status --short
git log --oneline -13
```

Expected: 工作树干净；提交历史包含本计划各独立提交。

---

## 规格覆盖自检

- 两个独立按钮、无选区自动进入上次工具、首次矩形选框：Task 8。
- 原位底部操作栏、移动抽屉、无独立页面：Task 8、Task 12。
- 生成式填充允许空提示词并固定全图加蒙版：Task 1、Task 4、Task 8。
- 局部重绘双参考模式、实时主缩略图、`＋` 四来源：Task 5、Task 6、Task 8。
- `@选区N/@参考图N` 固定别名，所有添加引用始终发送：Task 1、Task 6。
- 动态数量、非固定三张、模型缺省上限 8：Task 1、Task 8。
- N 个成功结果建立 N 个独立可见图层：Task 3、Task 9。
- 部分成功和补生成剩余数量：Task 1、Task 4、Task 7、Task 9。
- 输出透明边界、源层删除后的待插入：Task 3、Task 9。
- 关闭只隐藏，不停止 iframe、轮询、上传、建层、保存：Task 7、Task 11。
- 同画布多节点、普通/智能画布和项目隔离：Task 2、Task 11、Task 12。
- 节点/画布删除才取消，克隆清理运行态：Task 2、Task 4、Task 11、Task 12。
- 复用 HstarA 全局 API 和实时能力目录：Task 1、Task 4、Task 8。
- 不保存密钥、内联图片、Blob URL 或种子：Task 1、Task 2、Task 6、Task 10、Task 13。
- 汉化、构建镜像、1440/1920/430/4096 视觉和全回归：Task 10、Task 12、Task 13。

## 接口一致性自检

- 前后端统一使用 `targetCount/completedCount/failedCount`；HTTP 请求按现有 Pydantic 风格使用 snake_case。
- 前后端统一使用 `referenceMode: selection|full`；HTTP 请求使用 `reference_mode`。
- 冻结源层统一使用 `sourceLayerId/sourceLayerIndex/document.layerVersion/document.visibleCompositeVersion`；HTTP 顶层源层字段使用 snake_case，`document` 内部保持项目 JSON 的 camelCase。
- 引用统一使用 `assetId/alias/mention/sourceType/order`；HTTP `reference_assets` 内部对象保持 camelCase，进入纯契约后规范化。
- 父任务 ID 始终为 `taskId`，子任务 ID 始终为 `childTaskId`，补生成来源始终为 `retryOfTaskId`。
- 图层幂等键是 `childTaskId`，项目隔离键是 protocol 的完整 project scope，不单独使用 `nodeId` 或 `projectId`。
- 生产字段中不存在 `seed`；操作栏、请求、项目和图层元数据均不提供同义替代字段。
