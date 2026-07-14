# OpenShop Multilingual Text Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每个独立的“图文分层”项目增加复用 HstarA 全局 API 配置的中英文/混排文字提取、独立去除文字、字体缺失提示和可恢复 AI 任务流程。

**Architecture:** HstarA 后端继续作为唯一 API 执行端，提供无密钥能力目录和项目所有权约束的异步任务端点；OpenShop iframe 只保存 `apiConfigId + modelId + toolId`、字体引用和任务记录。OpenShop 新增三个独立宿主模块：API 客户端、字体目录、文字工具控制器；它们通过现有项目适配器、资源上传接口和 `openshop:project-dirty` 事件工作，不把敏感配置或内联图片写入项目。

**Tech Stack:** FastAPI、Pydantic、Python/Pillow、Fabric.js 5.3.1、原生 JavaScript、Vitest/jsdom、Playwright、Node.js test runner。

---

## File Map

- Create `openshop_ai.py`: 结构化 OCR 解析、能力目录分类和有界任务状态机的纯逻辑。
- Modify `main.py`: OpenShop AI 请求模型、能力目录端点、项目级异步任务端点以及真实视觉/图片编辑执行。
- Modify `openshop_projects.py`: 对 `fontRefs`、`aiToolPreferences`、`aiTaskRecords` 做有界规范化，并在删除项目时保持资源清理正确。
- Modify `integrations/openshop/host/openshop-project-adapter.js`: 序列化和恢复字体、工具偏好、任务记录及其资源引用。
- Create `integrations/openshop/host/openshop-ai-client.js`: 读取真实能力目录、监听 `studio-api`、实时发现模型、创建/轮询/取消项目任务。
- Create `integrations/openshop/host/openshop-font-catalog.js`: 字体可用性检测、项目字体引用和缺失字体状态。
- Create `integrations/openshop/host/openshop-text-tools.js`: 两个独立工具面板、源图/蒙版捕获、OCR 校对、文字图层和无字像素图层创建。
- Modify `integrations/openshop/host/openshop-host-runtime.js`: 广播会话/项目生命周期事件，并在切换项目时终止旧会话前端任务。
- Modify `integrations/openshop/host/openshop-protocol.js` and `static/js/openshop-host.js`: 增加“管理 API 配置”宿主命令和安全路由。
- Modify `integrations/openshop/index.html`: 装载新模块并启动文字工具，不在主单文件继续堆积实现逻辑。
- Modify `integrations/openshop/scripts/build-hstar.mjs`: 将三个新宿主模块纳入确定性静态构建。
- Modify `integrations/openshop/locales/zh-CN.js`: 新增 Photoshop 风格简体中文界面词条。
- Create/update tests under `tools/tests` and `integrations/openshop/tests`: 覆盖契约、隔离、取消、迟到响应、字体、图层、构建和 E2E。

### Task 1: Structured OCR And Capability Contracts

**Files:**
- Create: `openshop_ai.py`
- Create: `tools/tests/openshop-ai-contract.test.mjs`

- [ ] **Step 1: Write failing contract tests**

测试必须通过真实 Python 导入验证以下接口：

```python
from openshop_ai import build_capability_catalog, normalize_ocr_layout

catalog = build_capability_catalog(providers, primary_provider_id="vision")
assert catalog["tools"]["text-extract"]["providers"][0]["models"][0]["id"] == "gemini-3.1-pro-high"
assert catalog["tools"]["text-remove"]["providers"][0]["models"][0]["id"] == "gemini-3-pro-image"

layout = normalize_ocr_layout(raw_json, width=1920, height=1080)
assert layout["blocks"][0]["text"] == "中文 English"
assert layout["blocks"][0]["quad"][2] == {"x": 0.4, "y": 0.2}
```

同时断言纯文本响应、越界坐标、空文字块和没有四点/边界框的响应抛出 `OpenShopAiValidationError`，未知或禁用配置不会进入可用能力列表。

- [ ] **Step 2: Run the test and verify RED**

Run: `node tools/tests/openshop-ai-contract.test.mjs`

Expected: FAIL because `openshop_ai.py` does not exist.

- [ ] **Step 3: Implement minimal pure contracts**

实现并导出以下公开契约，工具 ID 和任务状态必须使用固定常量：

```python
OPENSHOP_AI_TOOL_IDS = ("text-extract", "text-remove")
OPENSHOP_AI_TASK_STATES = (
    "queued", "running", "succeeded", "failed", "cancelled"
)
```

公开函数为 `build_capability_catalog(providers, primary_provider_id="")`、`build_ocr_prompt(width, height)`、`normalize_ocr_layout(raw_text, width, height)` 和 `normalize_ai_task_record(value)`；无效输入统一抛出 `OpenShopAiValidationError`。

OCR 坐标统一为 `0..1` 四点坐标；只接受具有可靠位置的 `blocks`，不把纯文本降级伪装成布局结果。能力目录只输出公开字段，绝不接受或返回 API Key。

- [ ] **Step 4: Run GREEN and commit**

Run: `node tools/tests/openshop-ai-contract.test.mjs`

Expected: PASS.

Commit: `git commit -am "feat: define OpenShop text AI contracts"`

### Task 2: Project Metadata Persistence

**Files:**
- Modify: `openshop_projects.py`
- Modify: `integrations/openshop/host/openshop-project-adapter.js`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js`
- Modify: `tools/tests/openshop-project-storage.test.mjs`

- [ ] **Step 1: Add failing persistence and security tests**

增加断言：

```js
expect(restoredEditor.__hstarFontRefs).toEqual([{family:'Microsoft YaHei UI', status:'available'}]);
expect(restoredEditor.__hstarAiToolPreferences['text-extract']).toMatchObject({apiConfigId:'vision', modelId:'gemini-3.1-pro-high'});
expect(restoredEditor.__hstarAiTaskRecords[0].toolId).toBe('text-remove');
expect(saved.assetRefs).toContain(outputAssetId);
```

后端测试还必须拒绝 `apiKey`、`authorization`、`data:image/`、超长字体名、超过 100 条任务记录和非法任务状态。

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- hstar-project-adapter.test.js` in `integrations/openshop`, then `node tools/tests/openshop-project-storage.test.mjs`.

Expected: metadata is currently dropped or not bounded.

- [ ] **Step 3: Persist bounded project metadata**

`serializeProject()` 返回：

```js
fontRefs: clone(editor.__hstarFontRefs || []),
aiToolPreferences: clone(editor.__hstarAiToolPreferences || {}),
aiTaskRecords: clone(editor.__hstarAiTaskRecords || []).slice(-100),
```

`restoreProject()` 恢复同名字段；序列化时把任务记录中的 `sourceAssetId`、`maskAssetId`、`outputAssetId` 加入 `assetRefs`。Python 存储层对字段做类型、长度、状态和数量规范化，并继续递归拒绝凭据与内联图片。

- [ ] **Step 4: Verify GREEN and commit**

Run both focused suites. Expected: PASS.

Commit: `git commit -am "feat: persist OpenShop text tool metadata"`

### Task 3: HstarA Catalog And Project AI Tasks

**Files:**
- Modify: `main.py`
- Create: `tools/tests/openshop-ai-api.test.mjs`

- [ ] **Step 1: Write failing API/service tests**

使用临时 `HSTAR_DATA_DIR` 和替身执行器，验证：

```python
catalog = await main.openshop_ai_catalog()
assert "api_key" not in json.dumps(catalog).lower()

created = await main.create_openshop_ai_task(project_id, request)
task = await main.get_openshop_ai_task(
    project_id,
    created["task_id"],
    canvas_type=owner["canvasType"],
    canvas_id=owner["canvasId"],
    node_id=owner["nodeId"],
)
assert task["status"] in {"queued", "running", "succeeded"}
```

覆盖：项目所有权、配置删除/禁用、模型不在对应全局清单、OCR 纯文本失败、去字成功写入新的 OpenShop 资源、取消不产生输出、删除项目取消全部任务、完成响应晚于取消时保持 `cancelled`。

- [ ] **Step 2: Verify RED**

Run: `node tools/tests/openshop-ai-api.test.mjs`

Expected: endpoints and task registry are absent.

- [ ] **Step 3: Implement catalog and task routes**

新增路由：

```text
GET    /api/openshop/ai/catalog
POST   /api/openshop/projects/{project_id}/ai-tasks
GET    /api/openshop/projects/{project_id}/ai-tasks/{task_id}
DELETE /api/openshop/projects/{project_id}/ai-tasks/{task_id}
```

任务请求只接受 `owner/tool_id/source_asset_id/mask_asset_id/provider_id/model_id/mode/options`。文字提取复用 `canvas_llm()` 的 HTTP、Codex CLI 和 Antigravity CLI 多模态通道；去字复用 `generate_ai_image()`，并把成功图片写入当前 OpenShop 项目的内容寻址资源。任务表有锁、项目作用域、取消句柄、终态保护和过期清理。

- [ ] **Step 4: Integrate project deletion cleanup**

在 OpenShop 项目删除和画布永久清理路径调用：

```python
OPENSHOP_AI_TASKS.cancel_project(project_id)
```

取消只影响同一项目，不能波及同画布其他节点。

- [ ] **Step 5: Verify GREEN and commit**

Run: focused API test plus `node tools/tests/openshop-project-storage.test.mjs`.

Expected: PASS.

Commit: `git commit -am "feat: run project-scoped OpenShop text AI tasks"`

### Task 4: OpenShop API Client And Global Sync

**Files:**
- Create: `integrations/openshop/host/openshop-ai-client.js`
- Create: `integrations/openshop/tests/hstar-ai-client.test.js`
- Modify: `integrations/openshop/host/openshop-host-runtime.js`

- [ ] **Step 1: Write failing client tests**

验证：目录初次加载、`studio-api/providers-changed` 后刷新、项目级偏好解析、删除模型显示“配置不可用”且不静默回退、真实发现调用 `/api/providers/{id}/fetch-models`、任务轮询、取消、会话切换和迟到响应隔离。

```js
expect(client.resolvePreference('text-extract', stalePreference).available).toBe(false);
expect(fetch).toHaveBeenCalledWith('/api/providers/vision/fetch-models', expect.anything());
```

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- hstar-ai-client.test.js`.

- [ ] **Step 3: Implement the client**

导出 `createClient({fetchImpl, BroadcastChannelImpl})`，提供 `loadCatalog`、`subscribe`、`resolvePreference`、`discoverModels`、`createTask`、`pollTask`、`cancelTask` 和 `stopSession`。客户端不接收密钥，不写第二套 Base URL，并使用 `AbortController` 终止旧会话轮询。

- [ ] **Step 4: Emit runtime lifecycle events**

宿主运行时在打开会话、项目恢复和会话停止时发送：

```js
root.dispatchEvent(new CustomEvent('openshop:session-opened', {detail:{session}}));
root.dispatchEvent(new CustomEvent('openshop:project-loaded', {detail:{project}}));
root.dispatchEvent(new CustomEvent('openshop:session-stopped'));
```

- [ ] **Step 5: Verify GREEN and commit**

Commit: `git commit -am "feat: sync OpenShop tools with global API catalog"`

### Task 5: Font Catalog And Missing-Font State

**Files:**
- Create: `integrations/openshop/host/openshop-font-catalog.js`
- Create: `integrations/openshop/tests/hstar-font-catalog.test.js`
- Modify: `integrations/openshop/index.html`

- [ ] **Step 1: Write failing font tests**

覆盖中英文字体检测、通用字体、缺失字体、Fabric 文字对象扫描、重复去除和项目引用恢复：

```js
expect(catalog.scanEditor(editor)).toEqual([
  {family:'Microsoft YaHei UI', status:'available'},
  {family:'Missing Poster Font', status:'missing'},
]);
```

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- hstar-font-catalog.test.js`.

- [ ] **Step 3: Implement font management**

使用 canvas 字宽对比检测本地字体；维护常用中文、英文字体清单；在文字工具选项旁增加“字体管理”按钮。字体窗口显示“可用/缺失”，缺失字体不可静默替换，用户明确选择替代字体后才更新文字对象并记录项目引用。

- [ ] **Step 4: Verify GREEN and commit**

Commit: `git commit -am "feat: add OpenShop font availability management"`

### Task 6: Independent Text Extraction Workflow

**Files:**
- Create: `integrations/openshop/host/openshop-text-tools.js`
- Create: `integrations/openshop/tests/hstar-text-tools.test.js`
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/locales/zh-CN.js`

- [ ] **Step 1: Write failing extraction tests**

测试明确按钮、API/模型选择、当前图层捕获、任务记录、OCR 校对、低置信度标记、取消和确认创建文字图层组：

```js
await tools.applyOcrBlocks(blocks);
expect(editor.layers.at(-1).name).toBe('提取文字');
expect(editor.layers.at(-1).objects[0].type).toBe('i-text');
expect(editor.layers.at(-1).objects[0].text).toBe('中文 English');
```

纯文本/无坐标结果必须显示能力不足，不能在 `(0, 0)` 创建文字。

- [ ] **Step 2: Verify RED**

Run: `npm.cmd test -- hstar-text-tools.test.js`.

- [ ] **Step 3: Add visible extraction controls**

左侧工具栏注入带图标和提示的“文字提取”按钮；右侧面板始终提供“选择 API / 模型”、跟随全局/项目指定、执行、取消、重试和状态。无像素图层或配置不可用时按钮可见但禁用并显示原因。

- [ ] **Step 4: Implement non-destructive OCR review**

捕获当前像素图层为临时项目资源，创建 `text-extract` 任务。校对区显示源图、四点框、文字编辑框、语言和置信度；`confidence < 0.7` 明确标记。确认后按文档坐标创建 Fabric `IText` 对象，并放入新的“提取文字”图层组，保留原图层。

- [ ] **Step 5: Verify GREEN and commit**

Commit: `git commit -am "feat: extract multilingual text into editable layers"`

### Task 7: Independent Whole-Layer And Selection Text Removal

**Files:**
- Modify: `integrations/openshop/host/openshop-text-tools.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.test.js`

- [ ] **Step 1: Write failing removal tests**

覆盖整层、选区蒙版、独立 API 偏好、失败、取消和成功新建像素图层：

```js
expect(request.toolId).toBe('text-remove');
expect(request.maskAssetId).toBe(selectionMaskAssetId);
expect(sourceLayer.objects).toContain(originalImage);
expect(editor.layers.at(-1).name).toBe('去除文字');
```

断言该流程不会调用 OCR，不会删除/替换原图层，失败或取消时图层数量不变。

- [ ] **Step 2: Verify RED**

Run focused Vitest suite and observe expected assertions fail.

- [ ] **Step 3: Implement independent removal**

左侧单独注入“去除文字”按钮。面板提供整层/选区分段控制、独立 API/模型选择、质量、补充提示词、执行、取消和重试。选区模式把矩形或像素选区转换为与文档同尺寸的 PNG 蒙版；成功结果作为带 `hstarAssetId` 的新 Fabric 图片图层叠在原图层上方。

- [ ] **Step 4: Verify GREEN and commit**

Commit: `git commit -am "feat: remove text into a separate OpenShop pixel layer"`

### Task 8: Host Routing, Build And Localization

**Files:**
- Modify: `integrations/openshop/host/openshop-protocol.js`
- Modify: `static/js/openshop-host.js`
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `integrations/openshop/tests/hstar-protocol.test.js`
- Modify: `integrations/openshop/tests/hstar-i18n.test.js`
- Modify: `tools/tests/openshop-host-session-flow.test.mjs`
- Modify: `tools/tests/openshop-foundation-build.test.mjs`
- Modify: `tools/tests/openshop-localization-build.test.mjs`

- [ ] **Step 1: Add failing host/build/i18n tests**

验证 `OPEN_API_SETTINGS` 只能来自当前同源 OpenShop 会话，宿主隐藏编辑器后调用 `switchUI(document.querySelector('[onclick*="api-settings"]'), 'api-settings')`；构建必须包含三个新模块且排除测试、缓存和任务数据；全部新可见词条有简体中文。

- [ ] **Step 2: Verify RED**

Run protocol, build and localization focused suites.

- [ ] **Step 3: Implement host command and deterministic build**

新增协议类型并在外层宿主处理。把三个新文件加入 `runtimeFiles`，运行 `npm.cmd run build:hstar` 生成 `static/openshop`，保持源文件与构建镜像逐字节一致。

- [ ] **Step 4: Verify GREEN and commit**

Commit: `git commit -am "build: ship OpenShop multilingual text tools"`

### Task 9: End-To-End, Visual, 4K And Regression Gates

**Files:**
- Create: `integrations/openshop/tests/hstar-text-tools.e2e.spec.js`
- Create: `docs/validation/2026-07-14-openshop-multilingual-text-tools-validation.md`

- [ ] **Step 1: Add failing E2E scenarios**

覆盖普通/智能画布同画布两个图文分层节点：A 节点中文、英文和混排 OCR 校对及文字图层；B 节点整层去字和选区去字；两节点偏好、字体、任务和输出互不干扰。模拟删除 API 配置、取消、迟到响应、项目删除和服务重启后的任务丢失。

- [ ] **Step 2: Run E2E and fix only observed failures with TDD**

Run: `npm.cmd run test:hstar:text-tools` after adding the package script.

Expected final: all scenarios pass with no page errors.

- [ ] **Step 3: Perform visual and 4K checks**

在 `1440x1000`、`1920x1080`、`430x932` 检查两个工具按钮、参数面板、API 选择器、OCR 框、低置信度、缺失字体和错误状态，无重叠/溢出。用 `4096x4096`、至少 20 个 OCR 块和像素选区验证截图非空、任务 UI 不阻塞、图层位置正确。

- [ ] **Step 4: Run complete verification**

```powershell
cd integrations/openshop
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:hstar:localization
npm.cmd run test:hstar:e2e
npm.cmd run test:hstar:canvas-integration
npm.cmd run test:hstar:text-tools
npm.cmd run build:hstar
cd ../..
node --test tools/tests/*.test.mjs
node tools/tests/text-encoding-health.test.mjs
node tools/tests/hstarc-health-check.mjs
git diff --check
```

Expected: every suite passes, no encoding failures, no secret/data URL in project manifests, no runtime cache/log changes committed.

- [ ] **Step 5: Write validation report and commit**

记录测试数量、浏览器尺寸、4K 数据、功能独立性、API 配置失效行为和剩余阶段 5 范围。

Commit: `git commit -am "docs: validate OpenShop multilingual text tools"`

### Task 10: Integrate And Restart Engineering HstarA

**Files:**
- No product source changes unless final verification exposes a regression.

- [ ] **Step 1: Rebase or merge the isolated branch into `main` without losing unrelated changes**

Run `git status`, compare `main`, then use a non-interactive merge from the main worktree.

- [ ] **Step 2: Re-run the final root regression from `main`**

Run the static cache synchronization exactly as startup does, execute all 66+ root tests, then remove only generated cache-version stamp changes.

- [ ] **Step 3: Restart the engineering server**

Stop only the Python process serving this repository on port `3000`, start `main.py` hidden from `E:\Claude专业组\HstarA`, and verify `http://127.0.0.1:3000/` plus the OpenShop static runtime respond successfully.
