# OpenShop 画布节点与项目融合 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在普通画布和智能画布中加入数据完全隔离的“图文分层”节点，打通 HstarA 内部全屏 OpenShop、项目/素材持久化、多图片按连线顺序转图层、自动保存、来源更新与断线、复制/删除生命周期以及发送合成图片回来源画布。

**Architecture:** HstarA 服务端新增内容寻址的 OpenShop 项目仓库，项目清单只保存结构化数据和资源 ID，图片二进制通过同源上传/读取端点管理。顶层 Studio Shell 新增单实例全屏 OpenShop Host，使用现有版本化信封协议与编辑器通信，并把项目元数据和输出结果转发回来源画布 iframe；普通画布和智能画布各自使用薄适配器，共享节点字段、项目 ID、来源绑定和生命周期语义。

**Tech Stack:** FastAPI、Pydantic、Python 原子文件写入、原生 JavaScript、Fabric.js 5.3.1、Vitest 4、JSDOM、Playwright、HstarA 画布 JSON、Node.js 源码与集成测试。

---

## Scope gate

本计划只实施总体设计中的“阶段 3：画布与项目融合”。包含：

- 普通画布与智能画布的 `openshop-layered` 节点；
- HstarA 内部全屏编辑器、保存状态、返回来源画布；
- 每节点独立 `projectId`，同画布多节点、不同画布和复制节点隔离；
- 项目清单、图层素材、预览和输出的服务端持久化；
- 多图片按持久化连线顺序转为图层；
- 新来源、来源版本更新、断线保留和用户明确解决更新；
- 防抖自动保存、手动保存、异常重开恢复；
- 节点复制、节点删除、画布永久删除与共享素材引用清理；
- “发送到画布”创建普通图片节点并连接回来源节点。

本计划不包含：

- HstarA 全局 API/模型选择器；
- 文字提取、去除文字、生成式填充、局部重绘、AI 生成图层；
- 字体库和缺失字体处理；
- 新 PSD 可编辑文字写入器；
- 左侧独立 OpenShop 入口；
- Android 适配或 Windows 安装包重打包。

退出条件：普通和智能画布均通过创建、打开、保存、返回、重开、复制、删除、来源更新/断线、发送输出和同画布多节点隔离测试；项目 JSON、Host Bridge 和画布 JSON 中不长期保存大型 Base64。

## File structure

- Create: `openshop_projects.py`：项目所有权、原子清单、内容寻址素材、克隆和垃圾回收。
- Modify: `main.py`：运行路径、请求模型、OpenShop API 路由、画布节点删除与画布清理联动。
- Modify: `integrations/openshop/host/openshop-protocol.js`：阶段 3 消息类型。
- Modify: `integrations/openshop/host/openshop-project-adapter.js`：图层 ID、素材外置、来源对账、更新解决和输出合成。
- Modify: `integrations/openshop/host/openshop-host-runtime.js`：会话重置、保存队列、自动保存、发送输出和迟到消息拒绝。
- Modify: `integrations/openshop/index.html`：项目脏事件与同源素材读写器注入。
- Modify: `integrations/openshop/scripts/build-hstar.mjs`：继续确定性复制更新后的 host 运行时。
- Create: `static/js/openshop-host.js`：顶层全屏宿主、后端协调、来源导入、保存确认、导航和更新面板。
- Create: `static/css/openshop-host.css`：全屏宿主和来源更新面板样式。
- Create: `static/js/canvas-openshop.js`：普通画布节点适配器。
- Create: `static/js/smart-canvas-openshop.js`：智能画布节点适配器。
- Modify: `static/index.html`：加载顶层宿主和样式。
- Modify: `static/canvas.html`、`static/js/canvas.js`、`static/css/canvas.css`、`static/js/i18n/canvas.js`：普通画布入口、渲染、连线、复制和输出。
- Modify: `static/smart-canvas.html`、`static/js/smart-canvas.js`、`static/css/smart-canvas.css`、`static/js/i18n/smart-canvas.js`：智能画布入口、渲染、连线、复制和输出。
- Modify: `integrations/openshop/tests/hstar-protocol.test.js`、`hstar-project-adapter.test.js`、`hstar-host-runtime.test.js`：编辑器侧单元回归。
- Create: `tools/tests/openshop-project-storage.test.mjs`：Python 仓库与 API 生命周期测试。
- Create: `tools/tests/openshop-host-session-flow.test.mjs`：顶层 Host VM 测试。
- Create: `tools/tests/openshop-classic-node-session-flow.test.mjs`：普通画布适配器测试。
- Create: `tools/tests/openshop-smart-node-session-flow.test.mjs`：智能画布适配器测试。
- Create: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`：真实服务和两类画布端到端测试。
- Modify: `integrations/openshop/package.json`：阶段 3 Playwright 命令。
- Create: `docs/validation/2026-07-14-openshop-canvas-project-validation.md`：阶段验证报告。

## Task 1: 建立项目仓库、素材仓库与原子版本契约

**Files:**
- Create: `openshop_projects.py`
- Create: `tools/tests/openshop-project-storage.test.mjs`

- [ ] **Step 1: 写 Python 仓库失败测试**

在 Node 测试中优先使用 `python/python.exe`，设置 `PYTHONUTF8=1`，启动内联 Python harness。harness 使用 `tempfile.TemporaryDirectory()` 创建 `OpenShopProjectStore`，并断言：

```python
owner_a = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-a"}
owner_b = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-b"}

created = store.initialize("project-a", owner_a, {"width": 1920, "height": 1080})
assert created["projectId"] == "project-a"
assert created["owner"] == owner_a
assert created["autosaveVersion"] == 1

saved = store.save("project-a", owner_a, {
    **created,
    "layers": [{"layerId": "layer-a", "name": "标题"}],
}, base_version=1)
assert saved["autosaveVersion"] == 2

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
```

同一 harness 再写入两次相同 PNG 字节，断言素材 ID 相同；克隆到 `project-b/node-b` 后修改克隆图层名，断言原项目不变；删除原项目时共享素材仍存在，删除克隆后素材被回收。

- [ ] **Step 2: 运行测试并确认正确失败**

Run:

```powershell
node tools/tests/openshop-project-storage.test.mjs
```

Expected: FAIL，因为 `openshop_projects.py` 和 `OpenShopProjectStore` 尚不存在。

- [ ] **Step 3: 实现项目仓库**

`openshop_projects.py` 暴露以下稳定接口：

```python
class OpenShopStoreError(Exception): ...
class OpenShopNotFound(OpenShopStoreError): ...
class OpenShopOwnershipError(OpenShopStoreError): ...
class OpenShopVersionConflict(OpenShopStoreError): ...
class OpenShopValidationError(OpenShopStoreError): ...

class OpenShopProjectStore:
    SCHEMA_VERSION = 1
    MAX_IMAGE_BYTES = 64 * 1024 * 1024
    ALLOWED_IMAGE_MIME = {"image/png", "image/jpeg", "image/webp"}

    def __init__(self, data_dir: str): ...
    def initialize(self, project_id: str, owner: dict, document: dict) -> dict: ...
    def load(self, project_id: str, owner: dict) -> dict: ...
    def save(self, project_id: str, owner: dict, project: dict, base_version: int) -> dict: ...
    def clone(self, source_project_id: str, target_project_id: str, target_owner: dict) -> dict: ...
    def delete(self, project_id: str, owner: dict | None = None) -> bool: ...
    def delete_canvas_projects(self, canvas_type: str, canvas_id: str) -> list[str]: ...
    def store_image(self, project_id: str, owner: dict, data: bytes, mime: str, name: str, role: str) -> dict: ...
    def asset_path(self, asset_id: str) -> tuple[str, dict]: ...
    def collect_garbage(self) -> list[str]: ...
```

约束：

- ID 必须匹配 `^[A-Za-z0-9_-]{1,96}$`；
- `canvasType` 只能为 `classic` 或 `smart`；
- 清单写入同目录临时文件，`flush + os.fsync + os.replace` 后才更新成功；
- `base_version` 必须等于当前 `autosaveVersion`；
- 项目只保存资源 ID，不保存 `data:image/`、`blob:` 或 API 密钥字段；
- 素材 ID 为 `sha256`，扩展名由 MIME 决定，Pillow `verify()` 并限制尺寸不超过 `16384 x 16384`；
- 克隆深复制清单、生成新的项目/owner/时间/version，但复用内容寻址素材；
- 垃圾回收扫描全部项目的 `assetRefs` 与 `previewAssetId`，只删除零引用素材。

- [ ] **Step 4: 运行仓库测试**

Run:

```powershell
node tools/tests/openshop-project-storage.test.mjs
```

Expected: PASS，输出项目隔离、原子版本、克隆和共享素材清理均通过。

- [ ] **Step 5: Commit**

```powershell
git add openshop_projects.py tools/tests/openshop-project-storage.test.mjs
git commit -m "feat: add OpenShop project storage"
```

## Task 2: 暴露项目 API 并联动画布删除生命周期

**Files:**
- Modify: `main.py`
- Modify: `tools/tests/openshop-project-storage.test.mjs`

- [ ] **Step 1: 扩展失败测试到真实 ASGI 路由**

在 Python harness 中设置临时 `HSTAR_DATA_DIR` 后导入 `main`，通过 `httpx.AsyncClient(ASGITransport(app=main.app))` 断言：

```python
init = await client.post("/api/openshop/projects/project-a/initialize", json={
    "owner": owner_a,
    "document": {"width": 1920, "height": 1080},
})
assert init.status_code == 200

upload = await client.post(
    "/api/openshop/projects/project-a/assets",
    data={"canvas_type": "classic", "canvas_id": "canvas-a", "node_id": "node-a", "role": "source"},
    files={"file": ("source.png", png_bytes, "image/png")},
)
assert upload.status_code == 200
asset = upload.json()["asset"]
assert asset["url"] == f"/api/openshop/assets/{asset['assetId']}"

content = await client.get(asset["url"])
assert content.status_code == 200
assert content.content == png_bytes
```

再通过 `/api/canvases/{id}` 保存前后节点列表，断言移除 `openshop-layered` 节点会删除对应项目；软删除画布保留项目，`/purge` 永久删除项目。

- [ ] **Step 2: 运行测试并确认路由缺失失败**

Run:

```powershell
node tools/tests/openshop-project-storage.test.mjs
```

Expected: FAIL，首个 `/api/openshop/projects/...` 返回 `404`。

- [ ] **Step 3: 增加运行路径和请求模型**

在 `runtime_paths_for_storage_root()` 增加：

```python
"openshop_data_dir": os.path.join(data_dir, "openshop"),
```

并初始化单例：

```python
from openshop_projects import (
    OpenShopNotFound,
    OpenShopOwnershipError,
    OpenShopProjectStore,
    OpenShopValidationError,
    OpenShopVersionConflict,
)

OPENSHOP_DATA_DIR = RUNTIME_PATHS["openshop_data_dir"]
OPENSHOP_STORE = OpenShopProjectStore(OPENSHOP_DATA_DIR)
```

新增 Pydantic 模型：

```python
class OpenShopProjectInitializeRequest(BaseModel):
    owner: Dict[str, Any]
    document: Dict[str, Any] = Field(default_factory=dict)

class OpenShopProjectSaveRequest(BaseModel):
    owner: Dict[str, Any]
    project: Dict[str, Any]
    base_version: int = 0

class OpenShopProjectCloneRequest(BaseModel):
    source_project_id: str
    owner: Dict[str, Any]
```

- [ ] **Step 4: 实现路由和错误映射**

实现：

```text
POST   /api/openshop/projects/{project_id}/initialize
GET    /api/openshop/projects/{project_id}
PUT    /api/openshop/projects/{project_id}
POST   /api/openshop/projects/{project_id}/clone
DELETE /api/openshop/projects/{project_id}
POST   /api/openshop/projects/{project_id}/assets
GET    /api/openshop/assets/{asset_id}
```

GET/DELETE 使用 `canvas_type`、`canvas_id`、`node_id` 查询参数构造 owner。映射：NotFound=`404`、Ownership=`403`、VersionConflict=`409`、Validation=`400`。素材上传逐块读取并在超过 64 MiB 时中止，不将整个未知大小文件无界读入内存。

- [ ] **Step 5: 联动画布节点和画布永久删除**

增加纯函数：

```python
def openshop_project_owners(nodes):
    return {
        str(node.get("projectId")): str(node.get("id"))
        for node in (nodes or [])
        if isinstance(node, dict)
        and node.get("type") == "openshop-layered"
        and node.get("projectId")
        and node.get("id")
    }
```

`update_canvas()` 在通过版本冲突检查后，对比旧/新项目 ID；画布保存成功后删除缺失项目。`purge_canvas()` 和回收站过期清理调用 `delete_canvas_projects(normalize_canvas_kind(...), canvas_id)`；软删除与恢复不删项目。

- [ ] **Step 6: 运行 API 与根级测试**

Run:

```powershell
node tools/tests/openshop-project-storage.test.mjs
node --test tools/tests/*.test.mjs
```

Expected: OpenShop API 生命周期通过；HstarA 根级套件零失败。

- [ ] **Step 7: Commit**

```powershell
git add main.py tools/tests/openshop-project-storage.test.mjs
git commit -m "feat: expose OpenShop project APIs"
```

## Task 3: 扩展编辑器项目适配器到真实来源和素材生命周期

**Files:**
- Modify: `integrations/openshop/host/openshop-project-adapter.js`
- Modify: `integrations/openshop/tests/hstar-project-adapter.test.js`

- [ ] **Step 1: 写来源对账和素材外置失败测试**

新增测试覆盖：

```js
await adapter.persistEditorAssets({
  editor,
  assetWriter: async ({dataUrl, role}) => ({
    assetId: 'asset-local',
    url: '/api/openshop/assets/asset-local',
    role,
  }),
});
expect(editor.canvas.getObjects()[0].hstarAssetId).toBe('asset-local');

const result = await adapter.reconcileSources({
  editor,
  sources: [sourceV2, newSource],
  imageLoader,
});
expect(result.pendingUpdates).toHaveLength(1);
expect(result.added).toHaveLength(1);
expect(existingLayer.sourceBinding.state).toBe('update-available');

await adapter.resolveSourceUpdate({editor, edgeId:'edge-1', mode:'add', imageLoader});
expect(editor.layers.at(-1).sourceBinding.assetVersion).toBe('v2');
expect(existingLayer.sourceBinding.state).toBe('detached');
```

再断言来源从 current list 消失时只标记 `detached`，对象和像素仍保留；`serializeProject()` 不含 `data:image/` 或 `blob:`。

- [ ] **Step 2: 运行定向测试并确认失败**

Run:

```powershell
npm.cmd test -- tests/hstar-project-adapter.test.js
```

Expected: FAIL，因为三个新方法和 `layerId` 尚不存在。

- [ ] **Step 3: 增加稳定图层 ID 与项目字段**

所有图层首次进入适配器时分配 `layerId`。项目清单增加：

```js
{
  previewAssetId: clean(editor.__hstarPreviewAssetId),
  autosaveVersion: Number(editor.__hstarAutosaveVersion || 0),
  sourceBindings,
  assetRefs: [...assetRefs].sort(),
}
```

`sourceBindings` 保存 `layerId`、`edgeId`、`sourceNodeId`、`assetId`、`assetVersion`、`sequence`、`state`、`pendingAssetId`、`pendingAssetVersion`。恢复时按 `layerId` 映射元数据，不以用户可变的图层名称作为主键。

- [ ] **Step 4: 实现素材外置**

`persistEditorAssets({editor, assetWriter})` 顺序扫描 Fabric 对象；对已有 `hstarAssetId` 的对象跳过，对 `data:image/`、`blob:` 或可读取 URL 调用 `assetWriter`，再写入：

```js
object.set?.({
  hstarAssetId: asset.assetId,
  hstarAssetRole: asset.role || 'layer',
});
object.hstarAssetId = asset.assetId;
```

对象序列化时继续删除 `src`，仅保留 `assetRef`。无法外置的图片必须让保存失败并显示明确错误，不能退回把 Base64 写进项目。

- [ ] **Step 5: 实现来源对账和三种解决方式**

`reconcileSources()` 使用 `edgeId` 对账，按 `sequence` 排序：

- 新边：创建新图层；首次空项目使用 `initial-source-order`，已有项目使用 `top`；
- 同边同版本：保持不变并清除已过期提示；
- 同边新版本：旧图层保持不变，写入 pending 字段；
- 已断开的边：设置 `state='detached'`，保留对象。

`resolveSourceUpdate({mode})` 只接受 `replace | add | ignore`：replace 在原图层位置替换像素并保留变换，add 把旧绑定设为 detached 并在顶部添加新层，ignore 记录 `ignoredAssetVersion` 并清除 pending。

- [ ] **Step 6: 运行适配器与全部单元测试**

Run:

```powershell
npm.cmd test -- tests/hstar-project-adapter.test.js
npm.cmd test
```

Expected: 定向测试和全部 OpenShop 单元测试通过。

- [ ] **Step 7: Commit**

```powershell
git add integrations/openshop/host/openshop-project-adapter.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: reconcile OpenShop project sources"
```

## Task 4: 完成协议、自动保存与发送输出运行时

**Files:**
- Modify: `integrations/openshop/host/openshop-protocol.js`
- Modify: `integrations/openshop/host/openshop-host-runtime.js`
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/tests/hstar-protocol.test.js`
- Modify: `integrations/openshop/tests/hstar-host-runtime.test.js`

- [ ] **Step 1: 写协议和保存队列失败测试**

新增协议类型断言：

```js
expect(protocol.TYPES).toMatchObject({
  SYNC_SOURCES: 'hstar:openshop:sync-sources',
  RESOLVE_SOURCE_UPDATE: 'hstar:openshop:resolve-source-update',
  REQUEST_SAVE: 'hstar:openshop:request-save',
  SAVE_CONFIRMED: 'hstar:openshop:save-confirmed',
  REQUEST_SEND_TO_CANVAS: 'hstar:openshop:request-send-to-canvas',
  SEND_TO_CANVAS: 'hstar:openshop:send-to-canvas',
});
```

运行时测试使用 fake timers 连续派发三次 `openshop:project-dirty`，断言只发送一次 SAVE_PROJECT；保存进行中再次变脏时，在确认后再发送一次；旧 session 的 SAVE_CONFIRMED 不改变当前项目。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
npm.cmd test -- tests/hstar-protocol.test.js tests/hstar-host-runtime.test.js
```

Expected: FAIL，缺少消息类型和异步保存 API。

- [ ] **Step 3: 实现异步保存队列**

`HstarOpenShopRuntime` 状态新增：

```js
saving: false,
saveAgain: false,
dirty: false,
saveTimer: null,
assetWriter: null,
previewWriter: null,
```

`requestSave({reason='manual', closeAfter=false})`：

1. 等待 `persistEditorAssets()`；
2. 生成最大边 512 像素的 PNG 预览并用 `previewWriter` 外置；
3. `serializeProject()`；
4. 发送 SAVE_PROJECT，payload 包含 reason、closeAfter、project；
5. 等待当前 requestId 的 SAVE_CONFIRMED；
6. 若保存期间再次变脏，立即启动下一次保存。

1.2 秒 debounce 只响应 active session 的 `openshop:project-dirty`。LOAD_PROJECT、SYNC_SOURCES 和历史恢复期间设置 `applying=true`，不触发递归自动保存。

- [ ] **Step 4: 实现输出与来源解决消息**

REQUEST_SEND_TO_CANVAS 先强制保存，再生成当前可见图层合成 PNG，通过 `outputWriter` 上传，最后发送：

```js
post(types.SEND_TO_CANVAS, {
  payload: {
    assetId: output.assetId,
    url: output.url,
    name: output.name,
    width: state.editor.canvasW,
    height: state.editor.canvasH,
  },
});
```

RESOLVE_SOURCE_UPDATE 调用项目适配器后标记 dirty。OPEN_SESSION 必须重置编辑器到 payload.document 或 `1920 x 1080`，清除上一节点撤销历史、临时选区和 session 状态。

- [ ] **Step 5: 从 OpenShop 核心派发项目脏事件**

在 `saveHistory(action)` 末尾增加：

```js
window.dispatchEvent(new CustomEvent('openshop:project-dirty', {
  detail: { action: String(action || '') },
}));
```

iframe 启动 runtime 时注入同源实现：

```js
assetResolver: assetId => `/api/openshop/assets/${encodeURIComponent(assetId)}`,
assetWriter: payload => window.HstarOpenShopAssetApi.upload(payload),
previewWriter: payload => window.HstarOpenShopAssetApi.upload({...payload, role:'preview'}),
outputWriter: payload => window.HstarOpenShopAssetApi.upload({...payload, role:'output'}),
```

上传器把 data URL 或 blob 转成 `Blob + FormData`，直接请求项目素材 API；大型数据不得放入 postMessage。

- [ ] **Step 6: 运行协议、运行时、汉化审计和单元测试**

Run:

```powershell
npm.cmd test -- tests/hstar-protocol.test.js tests/hstar-host-runtime.test.js
npm.cmd run audit:i18n
npm.cmd test
```

Expected: 全部通过，新增错误和状态文本进入中文语言包且审计仍为零缺失。

- [ ] **Step 7: Commit**

```powershell
git add integrations/openshop/host integrations/openshop/index.html integrations/openshop/locales/zh-CN.js integrations/openshop/tests
git commit -m "feat: add OpenShop autosave runtime"
```

## Task 5: 构建 HstarA 顶层全屏 OpenShop Host

**Files:**
- Create: `static/js/openshop-host.js`
- Create: `static/css/openshop-host.css`
- Modify: `static/index.html`
- Create: `tools/tests/openshop-host-session-flow.test.mjs`

- [ ] **Step 1: 写顶层 Host VM 失败测试**

VM 提供 `frame-openshop`、来源 canvas iframe、fetch fake 和 message listeners，断言：

```js
host.openNodeSession({
  canvasType:'classic', canvasId:'canvas-1', nodeId:'layered-1',
  projectId:'project-1', frameId:'frame-canvas',
}, [source1, source2]);

expect(overlay.classList.contains('is-open')).toBe(true);
expect(frame.src).toContain('/static/openshop/index.html');

// READY 后顺序必须为 OPEN_SESSION -> LOAD_PROJECT -> SYNC_SOURCES
expect(editorMessages.map(item => item.type)).toEqual([
  protocol.TYPES.OPEN_SESSION,
  protocol.TYPES.LOAD_PROJECT,
  protocol.TYPES.SYNC_SOURCES,
]);
```

模拟 SAVE_PROJECT 后断言 PUT 使用当前 `autosaveVersion`，SAVE_CONFIRMED 回发编辑器，并向来源 canvas iframe发送 `hstar-openshop-node-meta`。模拟 SEND_TO_CANVAS，断言只转发资源 URL/ID，不转发 Base64。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node tools/tests/openshop-host-session-flow.test.mjs
```

Expected: FAIL，`static/js/openshop-host.js` 不存在。

- [ ] **Step 3: 创建全屏宿主 UI**

脚本初始化时插入：

```html
<section id="openshop-host" class="openshop-host" aria-hidden="true">
  <header class="openshop-host-bar">
    <button data-openshop-back><i data-lucide="arrow-left"></i><span>返回画布</span></button>
    <strong data-openshop-title>图文分层</strong>
    <span data-openshop-state>未保存</span>
    <button data-openshop-sources disabled>来源更新</button>
    <button data-openshop-save><i data-lucide="save"></i><span>保存</span></button>
    <button data-openshop-send><i data-lucide="send"></i><span>发送到画布</span></button>
  </header>
  <iframe id="frame-openshop" title="图文分层编辑器" data-src="/static/openshop/index.html"></iframe>
  <aside data-openshop-source-panel aria-hidden="true"></aside>
</section>
```

overlay 固定占满 Studio 内容区，iframe 直接铺满工具栏下方，不放在卡片中。工具栏在窄视口横向滚动且按钮尺寸固定，不能遮挡 iframe。

- [ ] **Step 4: 实现 Host 会话协调**

`window.HstarOpenShopHost` 暴露：

```js
Object.freeze({
  openNodeSession,
  requestSave,
  requestSendToCanvas,
  refreshSources,
  close,
  getState,
});
```

规则：

- 只接受同源且 `event.source === frame.contentWindow` 的信封；
- 每次 open 生成新 sessionId，清空 request 去重集；
- GET 项目，404 时 initialize；有 `cloneSourceProjectId` 时先 clone；
- 比较项目 sourceBindings，只上传新来源或新版本；上传完成后按 sequence 发送 SYNC_SOURCES；
- SAVE_PROJECT 使用版本冲突保护，409 时保持 overlay 和错误状态，不静默覆盖；
- close/back 先保存，确认成功后才关闭；保存失败留在编辑器；
- 项目元数据只发送到记录的来源 iframe；旧 session 的保存、输出和错误全部拒绝。

- [ ] **Step 5: 实现来源更新面板**

从 PROJECT_CHANGED/SAVE_PROJECT 的 sourceBindings 渲染 pending 项，每项有“替换图层”“作为新图层加入”“忽略”三个命令按钮。点击后发送 RESOLVE_SOURCE_UPDATE，面板显示处理中状态；不能直接修改项目 JSON。

- [ ] **Step 6: 在 Studio Shell 加载 Host**

`static/index.html` 在 `director-host.css` 后加载 `openshop-host.css`，在主脚本末尾按顺序加载：

```html
<script src="/static/openshop/host/openshop-protocol.js"></script>
<script src="/static/js/openshop-host.js"></script>
```

- [ ] **Step 7: 运行 VM 与 Shell 健康测试**

Run:

```powershell
node tools/tests/openshop-host-session-flow.test.mjs
node tools/tests/shell-branding-i18n.test.mjs
node tools/tests/static-cache-integrity.test.mjs
```

Expected: Host 流程通过；Shell 加载顺序和缓存键检查通过。

- [ ] **Step 8: Commit**

```powershell
git add static/index.html static/js/openshop-host.js static/css/openshop-host.css tools/tests/openshop-host-session-flow.test.mjs
git commit -m "feat: add full-screen OpenShop host"
```

## Task 6: 接入普通画布“图文分层”节点

**Files:**
- Create: `static/js/canvas-openshop.js`
- Modify: `static/canvas.html`
- Modify: `static/js/canvas.js`
- Modify: `static/css/canvas.css`
- Modify: `static/js/i18n/canvas.js`
- Create: `tools/tests/openshop-classic-node-session-flow.test.mjs`

- [ ] **Step 1: 写普通画布适配器失败测试**

VM/源码测试断言：

```js
const node = adapter.createNode({x:100, y:120});
assert.equal(node.type, 'openshop-layered');
assert.match(node.projectId, /^osp_/);
assert.equal(node.saveState, 'new');

assert.equal(adapter.canConnect(imageNode, node), true);
assert.equal(adapter.canConnect(promptNode, node), false);
assert.equal(adapter.canConnect(node, imageNode), true);

const sources = adapter.sourcesForNode(node);
assert.deepEqual(sources.map(item => item.sequence), [0, 1]);
assert.deepEqual(sources.map(item => item.edgeId), ['edge-first', 'edge-second']);
```

模拟 open 按钮，断言 Host 收到 `classic/canvasId/nodeId/projectId/frameId/sources`。模拟 node-meta 更新只更新对应节点；模拟 output 创建新 image 节点和 `from=openshop-node,to=image-node` 连线。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node tools/tests/openshop-classic-node-session-flow.test.mjs
```

Expected: FAIL，适配器文件和节点类型不存在。

- [ ] **Step 3: 实现普通画布节点字段和卡片**

`createNode()` 生成：

```js
{
  id: uid('openshop'),
  type: 'openshop-layered',
  projectId: `osp_${crypto.randomUUID().replaceAll('-', '_')}`,
  projectName: '图文分层项目',
  x, y, w: 340, h: 260,
  previewUrl: '',
  documentWidth: 1920,
  documentHeight: 1080,
  layerCount: 0,
  sourceUpdateCount: 0,
  saveState: 'new',
  created_at: Date.now(),
}
```

卡片显示预览、尺寸、图层数、保存状态、来源更新徽章和带 `panel-top-open` 图标的“打开编辑器”按钮。无预览时显示分层图像占位，不加载 Fabric.js。

- [ ] **Step 4: 接入创建入口、渲染、端口和连线规则**

在顶部工具栏和右键创建菜单加入“图文分层”；`renderNode()` 对该类型调用适配器；输入端允许所有可提供图片的节点且允许多条边，输出端只允许普通图片/组/输出兼容目标。`canConnect()` 在通用生成器规则前委托适配器。

来源顺序使用 `connections` 数组索引并以 edge ID 兜底；每项包含 `edgeId/sourceNodeId/assetVersion/name/url/sequence`。URL 使用现有 `canvasDisplayMediaUrl()` 变成同源可读取地址。

- [ ] **Step 5: 接入复制、删除和 Host 消息**

`cloneNode()` 对该类型调用：

```js
window.HstarClassicOpenShopAdapter.prepareClone(source, copy);
```

它分配新 projectId，设置 `cloneSourceProjectId`，清除 save/error 状态。删除仍由画布保存后的服务端差集清理负责，适配器不在本地删除素材。

处理 `hstar-openshop-node-meta` 和 `hstar-openshop-output` 时同时校验 `canvasType/canvasId/nodeId/projectId`。输出放在来源节点右侧，重复发送每次创建新 image 节点。

- [ ] **Step 6: 添加样式和 i18n**

新增 `canvas.openshopLayered`、`canvas.openshopOpen`、`canvas.openshopSaved`、`canvas.openshopSaving`、`canvas.openshopSourceUpdates` 等中英文键。卡片尺寸稳定，预览 `aspect-ratio:16/9`，保存徽章不改变布局。

- [ ] **Step 7: 运行普通画布和全量根测试**

Run:

```powershell
node tools/tests/openshop-classic-node-session-flow.test.mjs
node --test tools/tests/*.test.mjs
```

Expected: 普通画布适配器通过，根级测试零失败。

- [ ] **Step 8: Commit**

```powershell
git add static/canvas.html static/js/canvas.js static/js/canvas-openshop.js static/css/canvas.css static/js/i18n/canvas.js tools/tests/openshop-classic-node-session-flow.test.mjs
git commit -m "feat: add classic layered graphics node"
```

## Task 7: 接入智能画布“图文分层”节点

**Files:**
- Create: `static/js/smart-canvas-openshop.js`
- Modify: `static/smart-canvas.html`
- Modify: `static/js/smart-canvas.js`
- Modify: `static/css/smart-canvas.css`
- Modify: `static/js/i18n/smart-canvas.js`
- Create: `tools/tests/openshop-smart-node-session-flow.test.mjs`

- [ ] **Step 1: 写智能画布适配器失败测试**

测试与普通画布使用相同节点字段和 owner 语义，但 sources 从 `canvas.connections` 的 `kind='input'` 与 `inputImagesFor(node)` 生成。断言允许多个图片输入、不允许 prompt 输入、输出创建 `smart-image` 节点，且同画布普通/智能 project scope 不相等。

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
node tools/tests/openshop-smart-node-session-flow.test.mjs
```

Expected: FAIL，智能适配器文件和节点类型不存在。

- [ ] **Step 3: 实现智能节点与 hooks**

创建 `createOpenShopLayeredNode(x,y)`，字段与普通画布一致，`canvasType='smart'`。`window.HstarSmartCanvasOpenShopHooks` 提供：

```js
{
  getNode,
  getCanvasId: () => canvasId,
  getConnections: () => canvas?.connections || [],
  inputImagesForNode,
  createImageOutput,
  saveCanvas,
  render,
  toast,
}
```

适配器只通过 hooks 访问智能画布状态，避免复制生成流程内部实现。

- [ ] **Step 4: 接入菜单、渲染、连线与复制**

创建菜单加入“图文分层”；render 分类不能把该节点误判为 empty image/group。节点使用专用卡片 HTML，始终显示输入/输出端口。`addConnection()` 和 `connectInputNode()` 在 director 分支之前委托 OpenShop 适配器，多条输入不替换已有 `inputNodeIds`。

文件内两个 `cloneSmartNode()` 定义都调用 `prepareClone()`，防止后续代码移动导致其中一个路径重新共享 projectId。

- [ ] **Step 5: 接入输出和元数据消息**

Host 输出创建单图 `smart-image` 节点，写入：

```js
{
  images: [{url, name, kind:'image', openshopAssetId:assetId}],
  sourceType:'openshop-layered',
  openshopSourceNodeId:source.id,
}
```

然后追加 flow 连接并立即 `await saveCanvas()`。节点不存在、项目 ID 不匹配或 requestId 已应用时拒绝。

- [ ] **Step 6: 添加样式、i18n 并运行测试**

Run:

```powershell
node tools/tests/openshop-smart-node-session-flow.test.mjs
node --test tools/tests/*.test.mjs
```

Expected: 智能适配器和根级测试全部通过。

- [ ] **Step 7: Commit**

```powershell
git add static/smart-canvas.html static/js/smart-canvas.js static/js/smart-canvas-openshop.js static/css/smart-canvas.css static/js/i18n/smart-canvas.js tools/tests/openshop-smart-node-session-flow.test.mjs
git commit -m "feat: add smart layered graphics node"
```

## Task 8: 建立真实两类画布端到端隔离门禁

**Files:**
- Create: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`
- Modify: `integrations/openshop/package.json`

- [ ] **Step 1: 添加阶段 3 Playwright 命令**

```json
"test:hstar:canvas-integration": "playwright test tests/hstar-canvas-integration.e2e.spec.js"
```

- [ ] **Step 2: 写同画布多节点隔离测试**

通过 API 创建普通画布，在画布中创建两个图文分层节点 A/B，分别打开并添加不同文字对象和图层名；等待保存确认，关闭后重开，断言 A/B 内容、projectId、autosaveVersion 和预览互不相同。刷新 HstarA 后再次打开，内容仍恢复。

- [ ] **Step 3: 写多图、更新和断线测试**

创建三个图片节点，以明确连接数组顺序接入节点 A。打开 OpenShop 后断言第一张在底部、第三张在顶部；手动重排后保存。更新第二个图片 URL/version，再打开时断言只出现 update-available，不覆盖图层；选择“作为新图层加入”后新层位于顶部。断开第一条边并重开，断言原层存在且 state 为 detached。

- [ ] **Step 4: 写复制、删除和迟到响应测试**

复制 A 得到 C，断言 C 有新 projectId 且初始内容相同；修改 C 后 A 不变。删除 C 并保存画布，GET C 项目返回 404，A/B 仍为 200。构造旧 session SAVE_PROJECT 消息，断言当前节点状态和项目版本不变。

- [ ] **Step 5: 写发送回画布测试**

在普通画布和智能画布各执行两次“发送到画布”，断言每次新建独立图片节点、URL 为 `/api/openshop/assets/...`、输出边指向新节点、项目仍存在。画布 JSON 和项目 JSON 均不得匹配 `/data:image\//`。

- [ ] **Step 6: 运行真实服务门禁**

Run with HstarA served at `3010`:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3010'
npm.cmd run test:hstar:canvas-integration
```

Expected: 普通、智能、多节点、多图、更新、断线、复制、删除、恢复和发送输出全部通过，page errors 为 `[]`。

- [ ] **Step 7: Commit**

```powershell
git add integrations/openshop/package.json integrations/openshop/package-lock.json integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js
git commit -m "test: cover OpenShop canvas project isolation"
```

## Task 9: 构建镜像、视觉检查与 4K 回归

**Files:**
- Modify: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `tools/tests/openshop-localization-build.test.mjs`
- Modify: `tools/tests/openshop-foundation-build.test.mjs`

- [ ] **Step 1: 扩展构建镜像测试**

断言更新后的 `openshop-protocol.js`、`openshop-project-adapter.js`、`openshop-host-runtime.js` 与 integration 源摘要一致；Shell、两类画布 HTML 均加载对应 host/adapter；禁止复制测试、node_modules、缓存、Base64 项目和运行数据到 `static/openshop`。

- [ ] **Step 2: 运行确定性构建**

Run:

```powershell
npm.cmd run build:hstar
node tools/tests/openshop-foundation-build.test.mjs
node tools/tests/openshop-localization-build.test.mjs
```

Expected: 构建只包含批准文件，重复构建树指纹一致。

- [ ] **Step 3: 执行视觉检查**

在 `1440 x 1000`、`1920 x 1080` 和 `430 x 932` 检查：

- 普通与智能“图文分层”卡片；
- 全屏 Host 工具栏；
- OpenShop 工作区；
- 保存中/已保存/失败；
- 来源更新面板；
- 发送到画布后的输出节点。

确认无重叠、裁切、按钮文字溢出和 iframe 空白；窄视口工具栏内部滚动但返回/保存/发送仍可访问。

- [ ] **Step 4: 运行 4K 十图层与完整回归**

Run:

```powershell
npm.cmd run audit:i18n
npm.cmd test
npm.cmd run test:e2e
npm.cmd run test:hstar:localization
npm.cmd run test:hstar:e2e
npm.cmd run test:hstar:canvas-integration
node --test tools/tests/*.test.mjs
node tools/tests/text-encoding-health.test.mjs
node tools/tests/hstarc-health-check.mjs
git diff --check
```

Expected: 全部退出 `0`；4K 十图层仍无浏览器崩溃；项目保存、关闭和重开后临时对象 URL 得到释放。

- [ ] **Step 5: Commit**

```powershell
git add integrations/openshop/scripts/build-hstar.mjs static/openshop tools/tests/openshop-foundation-build.test.mjs tools/tests/openshop-localization-build.test.mjs
git commit -m "build: ship OpenShop canvas integration"
```

## Task 10: 阶段验证报告与退出门槛

**Files:**
- Create: `docs/validation/2026-07-14-openshop-canvas-project-validation.md`

- [ ] **Step 1: 写入只含实测值的报告**

报告包含：

```markdown
# OpenShop Canvas Project Integration Validation

## Storage
- Project root, schema, atomic save/version conflict, asset limit, checksum and GC results.

## Classic canvas
- Create/open/save/reopen/clone/delete/output results.

## Smart canvas
- Create/open/save/reopen/clone/delete/output results.

## Source lifecycle
- Stable order, update choice, disconnect retention and late-response rejection.

## Isolation
- Same-canvas nodes, cross-canvas nodes, copied nodes and restart recovery.

## Visual and performance
- Viewports, screenshots and 4K measurements.

## Regression
- Unit, Playwright, HstarA root, encoding and health counts.

## Decision
- CONTINUE only when all phase-3 gates pass.
```

- [ ] **Step 2: 确认没有越界进入后续阶段**

Run:

```powershell
git diff --name-only HEAD~1
rg -n "文字提取|去除文字|生成式填充|局部重绘|AI 生成图层" static/js/openshop-host.js static/js/canvas-openshop.js static/js/smart-canvas-openshop.js
```

Expected: 新增节点和宿主中没有阶段 4/5 的功能按钮或 API 选择器。

- [ ] **Step 3: Commit report**

```powershell
git add docs/validation/2026-07-14-openshop-canvas-project-validation.md
git commit -m "docs: validate OpenShop canvas projects"
```

- [ ] **Step 4: 确认阶段完成状态**

Run:

```powershell
git status --short
git log --oneline -14
```

Expected: 工作树干净，验证报告 Decision 为 `CONTINUE`。只有完成本门槛后，才开始阶段 4 的字体、文字提取和独立去除文字功能。
