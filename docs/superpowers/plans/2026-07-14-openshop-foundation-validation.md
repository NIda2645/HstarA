# OpenShop 技术验证与融合底座 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 固定并托管 OpenShop 0.19.1，在不接入正式画布节点和 AI 功能前，完成协议、分层项目适配、同源静态构建、PSD 可编辑文字和 4K 基线验证。

**Architecture:** 将上游源码固定在 `integrations/openshop/`，通过小型 Host Runtime 向现有单文件 `OS` 编辑器提供版本化桥接，不在本阶段重写 Fabric.js 核心。HstarA 只构建同源静态副本和协议测试；正式项目后端、两类画布节点、汉化、API 同步和 AI 工具分别在后续阶段实施。

**Tech Stack:** OpenShop 0.19.1、Fabric.js 5.3.1、ag-psd 22.0.2、原生 JavaScript、Vitest 4、Playwright、HstarA Node 源码测试、FastAPI 静态服务。

---

## Scope Gate

本计划只实施设计文档中的“阶段 1：技术验证”。它必须产出可运行的同源 OpenShop 静态构建、稳定协议和项目适配器，以及 PSD/4K 的实测结论。

本计划明确不实施：

- 普通画布或智能画布的正式“图文分层”节点。
- 全部简体中文汉化。
- HstarA 项目/素材后端。
- HstarA 全局 API 选择器。
- 文字提取、去除文字、生成式填充、局部重绘和 AI 生成图层。
- 最终 PSD 导出器和发布安装包。

后续实施顺序固定为：

1. OpenShop 汉化与离线运行时。
2. 两类画布节点、独立项目和素材存储。
3. 多语言字体、文字提取与去除文字。
4. 生成式填充、局部重绘和 AI 生成图层。
5. PSD 增强导出、性能、安全与安装包强化。

每个后续阶段在前一阶段通过退出门槛后单独生成实施计划，避免忽略本阶段发现的 PSD、序列化或性能限制。

## File Structure

- Create: `integrations/openshop/`: 固定在上游提交 `60c93382868849b1f4f9b073f9519ae61136a05b` 的源码副本，不包含上游 `.git`、`node_modules` 和测试输出。
- Create: `integrations/openshop/UPSTREAM.md`: 上游地址、提交、版本、许可证和 HstarA 基线测试结果。
- Modify: `integrations/openshop/package.json`: 增加 HstarA 静态构建、协议、PSD 探针和性能脚本。
- Modify: `integrations/openshop/package-lock.json`: 固定 Node 依赖。
- Modify: `integrations/openshop/index.html`: 在编辑器初始化后加载 Host Runtime；不在本阶段汉化或拆分核心 `OS` 对象。
- Create: `integrations/openshop/host/openshop-protocol.js`: 编辑器侧消息常量、信封和上下文校验。
- Create: `integrations/openshop/host/openshop-project-adapter.js`: 节点项目快照、来源绑定和稳定图片图层插入。
- Create: `integrations/openshop/host/openshop-host-runtime.js`: 编辑器侧同源消息监听、会话和请求去重。
- Create: `integrations/openshop/scripts/build-hstar.mjs`: 将运行文件确定性复制到 `static/openshop/`。
- Create: `integrations/openshop/scripts/psd-text-probe.mjs`: 生成中英文可编辑文字层 PSD 探针并进行结构往返检查。
- Create: `integrations/openshop/tests/hstar-protocol.test.js`: 编辑器侧协议单元测试。
- Create: `integrations/openshop/tests/hstar-project-adapter.test.js`: 项目和多图片图层顺序测试。
- Create: `integrations/openshop/tests/hstar-host-runtime.test.js`: 会话隔离、来源校验和去重测试。
- Create: `integrations/openshop/tests/hstar-psd-probe.test.js`: PSD 中英文文字层结构测试。
- Create: `integrations/openshop/tests/hstar-foundation.e2e.spec.js`: iframe 桥、静态构建和 4K 稳定性测试。
- Create: `integrations/openshop/tests/golden/openshop-text-layer-probe.psd`: 可在 Photoshop 中打开的探针文件。
- Create: `static/js/openshop-protocol.js`: HstarA 宿主侧协议镜像。
- Create: `static/openshop/`: 由构建脚本生成并提交的同源运行文件。
- Create: `tools/tests/openshop-protocol.test.mjs`: HstarA 宿主协议测试。
- Create: `tools/tests/openshop-foundation-build.test.mjs`: 构建产物、许可证和运行文件完整性测试。
- Create: `docs/validation/2026-07-14-openshop-foundation-validation.md`: 第一阶段实际证据和继续/停止结论。

## Task 1: 固定上游源码与许可证

**Files:**
- Create: `integrations/openshop/`
- Create: `integrations/openshop/UPSTREAM.md`
- Verify: `integrations/openshop/LICENSE`

- [ ] **Step 1: 确认工作区和当前设计提交**

Run:

```powershell
git status --short
git log -1 --oneline
```

Expected: 工作区无未提交修改，HEAD 包含 `f7fd96b docs: design OpenShop layered graphics integration` 或其后继提交。

- [ ] **Step 2: 在临时目录检出唯一允许的上游提交**

Run:

```powershell
$ref = Join-Path $env:TEMP 'hstara-openshop-60c9338'
if (Test-Path $ref) { Remove-Item -LiteralPath $ref -Recurse -Force }
git clone --filter=blob:none https://github.com/SysAdminDoc/Openshop.git $ref
git -C $ref checkout --detach 60c93382868849b1f4f9b073f9519ae61136a05b
git -C $ref rev-parse HEAD
```

Expected: 最后一行严格为 `60c93382868849b1f4f9b073f9519ae61136a05b`。

- [ ] **Step 3: 复制上游文件但排除仓库和运行缓存**

Run:

```powershell
$ref = Join-Path $env:TEMP 'hstara-openshop-60c9338'
robocopy $ref 'integrations\openshop' /E /XD .git node_modules test-results playwright-report coverage /XF *.log
if ($LASTEXITCODE -le 7) { exit 0 } else { exit $LASTEXITCODE }
```

Expected: `integrations/openshop/index.html`、`LICENSE`、`package.json` 和 `tests/` 存在；`.git` 和 `node_modules` 不存在。

- [ ] **Step 4: 写入上游记录**

Create `integrations/openshop/UPSTREAM.md`:

```markdown
# OpenShop Upstream Baseline

- Repository: https://github.com/SysAdminDoc/Openshop.git
- Commit: 60c93382868849b1f4f9b073f9519ae61136a05b
- Version: 0.19.1
- License: MIT, Copyright (c) 2026 Matthew Parker
- Imported: 2026-07-14

Baseline verification on Windows:

- `npm.cmd test`: 20 passed
- `npm.cmd run test:e2e`: 6 passed

HstarA modifications are maintained in this directory. Upstream updates must be applied from an explicit commit and rerun the complete OpenShop and HstarA integration suites.
```

- [ ] **Step 5: 验证许可证和排除项**

Run:

```powershell
Select-String -Path 'integrations\openshop\LICENSE' -Pattern 'MIT License','Copyright \(c\) 2026 Matthew Parker'
Test-Path 'integrations\openshop\.git'
Test-Path 'integrations\openshop\node_modules'
```

Expected: 两个许可证模式均匹配；两个 `Test-Path` 结果均为 `False`。

- [ ] **Step 6: 提交上游基线**

Run:

```powershell
git add integrations/openshop
git commit -m "chore: vendor OpenShop 0.19.1"
```

## Task 2: 固定上游测试基线

**Files:**
- Modify: `integrations/openshop/package-lock.json` only if `npm ci` proves the committed lock is not reproducible
- Test: `integrations/openshop/tests/os-unit.test.js`
- Test: `integrations/openshop/tests/openshop.e2e.spec.js`

- [ ] **Step 1: 安装锁定依赖**

Run from `integrations/openshop/`:

```powershell
npm.cmd ci
```

Expected: 安装成功，`npm audit` 输出 `found 0 vulnerabilities`。不要使用会绕过锁文件的 `npm install --force`。

- [ ] **Step 2: 运行上游单元测试**

Run:

```powershell
npm.cmd test
```

Expected: `1 passed` test file、`20 passed` tests。

- [ ] **Step 3: 运行上游浏览器测试**

Run:

```powershell
npm.cmd run test:e2e
```

Expected: `6 passed`，没有 page error 和截图回归失败。

- [ ] **Step 4: 检查测试没有改写受版本控制文件**

Run from HstarA root:

```powershell
git status --short
```

Expected: 不出现 `node_modules`、`test-results`、`playwright-report`、截图或日志文件。若上游测试修改了跟踪文件，先查明原因，不提交自动更新的快照。

## Task 3: 建立版本化 Host Bridge 协议

**Files:**
- Create: `integrations/openshop/host/openshop-protocol.js`
- Create: `integrations/openshop/tests/hstar-protocol.test.js`
- Create: `static/js/openshop-protocol.js`
- Create: `tools/tests/openshop-protocol.test.mjs`

- [ ] **Step 1: 编写编辑器侧失败测试**

Create `integrations/openshop/tests/hstar-protocol.test.js`:

```js
import { beforeEach, describe, expect, it } from 'vitest';

describe('Hstar OpenShop protocol', () => {
  beforeEach(async () => {
    delete window.HstarOpenShopProtocol;
    await import(`../host/openshop-protocol.js?test=${Date.now()}`);
  });

  it('creates node-isolated project scopes', () => {
    const protocol = window.HstarOpenShopProtocol;
    expect(protocol.PROTOCOL_VERSION).toBe(1);
    expect(protocol.createProjectScope({
      canvasType: 'classic', canvasId: 'canvas-1', nodeId: 'node-1', projectId: 'project-1'
    })).toBe('openshop:classic:canvas-1:node-1:project-1');
  });

  it('rejects incomplete or foreign envelopes', () => {
    const protocol = window.HstarOpenShopProtocol;
    const envelope = protocol.createEnvelope({
      type: protocol.TYPES.LOAD_PROJECT,
      sessionId: 'session-1',
      requestId: 'request-1',
      context: { canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1' },
      payload: { project: {} }
    });
    expect(protocol.validateEnvelope(envelope)).toEqual({ ok:true });
    expect(protocol.validateEnvelope({ ...envelope, protocolVersion: 2 }).ok).toBe(false);
    expect(protocol.validateEnvelope({ ...envelope, context: { ...envelope.context, projectId:'' } }).ok).toBe(false);
    expect(protocol.validateEnvelope({ ...envelope, type:'unrelated-message' }).ok).toBe(false);
  });
});
```

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
npm.cmd test -- tests/hstar-protocol.test.js
```

Expected: FAIL，因为 `host/openshop-protocol.js` 尚不存在。

- [ ] **Step 3: 实现最小编辑器侧协议**

Create `integrations/openshop/host/openshop-protocol.js`:

```js
(function bootstrapOpenShopProtocol(root){
  const PROTOCOL_VERSION = 1;
  const PREFIX = 'hstar:openshop:';
  const TYPES = Object.freeze({
    READY: `${PREFIX}ready`,
    OPEN_SESSION: `${PREFIX}open-session`,
    LOAD_PROJECT: `${PREFIX}load-project`,
    ADD_IMAGE_LAYER: `${PREFIX}add-image-layer`,
    SAVE_PROJECT: `${PREFIX}save-project`,
    PROJECT_CHANGED: `${PREFIX}project-changed`,
    CLOSE: `${PREFIX}close`,
    ERROR: `${PREFIX}error`,
  });

  const clean = value => String(value || '').trim();
  function normalizeContext(value = {}) {
    return {
      canvasType: clean(value.canvasType),
      canvasId: clean(value.canvasId),
      nodeId: clean(value.nodeId),
      projectId: clean(value.projectId),
    };
  }
  function createProjectScope(context) {
    const value = normalizeContext(context);
    if(Object.values(value).some(part => !part)) throw new Error('OpenShop context is incomplete');
    return `openshop:${value.canvasType}:${value.canvasId}:${value.nodeId}:${value.projectId}`;
  }
  function createEnvelope({ type, sessionId, requestId, context, payload = {} }) {
    return { type, protocolVersion:PROTOCOL_VERSION, sessionId:clean(sessionId), requestId:clean(requestId), context:normalizeContext(context), payload };
  }
  function validateEnvelope(value) {
    if(!value || typeof value !== 'object') return { ok:false, reason:'not-object' };
    if(value.protocolVersion !== PROTOCOL_VERSION) return { ok:false, reason:'version' };
    if(typeof value.type !== 'string' || !value.type.startsWith(PREFIX)) return { ok:false, reason:'type' };
    if(!clean(value.sessionId)) return { ok:false, reason:'session' };
    if(!clean(value.requestId)) return { ok:false, reason:'request' };
    const context = normalizeContext(value.context);
    if(Object.values(context).some(part => !part)) return { ok:false, reason:'context' };
    return { ok:true };
  }
  root.HstarOpenShopProtocol = Object.freeze({ PROTOCOL_VERSION, PREFIX, TYPES, normalizeContext, createProjectScope, createEnvelope, validateEnvelope });
})(window);
```

- [ ] **Step 4: 运行编辑器侧协议测试**

Run:

```powershell
npm.cmd test -- tests/hstar-protocol.test.js
```

Expected: PASS，2 tests passed。

- [ ] **Step 5: 创建宿主侧协议镜像和测试**

Copy the same browser-safe protocol implementation to `static/js/openshop-protocol.js`.

Create `tools/tests/openshop-protocol.test.mjs` using `vm.runInContext` in the same style as `tools/tests/director-protocol.test.mjs`. Assert:

```js
assert.equal(protocol.PROTOCOL_VERSION, 1);
assert.equal(
  protocol.createProjectScope({canvasType:'smart', canvasId:'c1', nodeId:'n1', projectId:'p1'}),
  'openshop:smart:c1:n1:p1',
);
assert.equal(protocol.validateEnvelope(validEnvelope).ok, true);
assert.equal(protocol.validateEnvelope({...validEnvelope, sessionId:''}).ok, false);
assert.equal(protocol.validateEnvelope({...validEnvelope, context:{...validEnvelope.context, nodeId:''}}).ok, false);
```

- [ ] **Step 6: 运行宿主协议测试**

Run from HstarA root:

```powershell
node tools/tests/openshop-protocol.test.mjs
```

Expected: PASS，无输出错误。

- [ ] **Step 7: 提交协议**

Run:

```powershell
git add integrations/openshop/host/openshop-protocol.js integrations/openshop/tests/hstar-protocol.test.js static/js/openshop-protocol.js tools/tests/openshop-protocol.test.mjs
git commit -m "feat: add OpenShop host protocol"
```

## Task 4: 建立项目快照与稳定图片图层适配器

**Files:**
- Create: `integrations/openshop/host/openshop-project-adapter.js`
- Create: `integrations/openshop/tests/hstar-project-adapter.test.js`

- [ ] **Step 1: 编写失败测试**

Create `integrations/openshop/tests/hstar-project-adapter.test.js` with a fake editor and image loader. The test must assert these exact behaviors:

```js
expect(project.schemaVersion).toBe(1);
expect(project.projectId).toBe('project-1');
expect(project.owner).toEqual({canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1'});
expect(project.layers.map(layer => layer.name)).toEqual(['第一张.png', '第二张.png']);
expect(project.sourceBindings.map(binding => binding.sequence)).toEqual([0, 1]);
expect(editor.layers[0].objects[0].hstarAssetId).toBe('asset-1');
expect(editor.layers[1].objects[0].hstarAssetId).toBe('asset-2');
```

Use two deferred image promises and resolve the second promise first. The resulting layer order must still be `第一张.png`, then `第二张.png`.

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
npm.cmd test -- tests/hstar-project-adapter.test.js
```

Expected: FAIL because `HstarOpenShopProjectAdapter` is undefined.

- [ ] **Step 3: 实现适配器的公共契约**

Create `integrations/openshop/host/openshop-project-adapter.js` exposing:

```js
window.HstarOpenShopProjectAdapter = Object.freeze({
  createEmptyProject,
  serializeProject,
  restoreProject,
  queueSourceImageLayer,
});
```

The project shape must be:

```js
{
  schemaVersion: 1,
  projectId,
  owner: { canvasType, canvasId, nodeId },
  document: { width, height, resolution: 72, colorSpace: 'srgb' },
  editor: fabricJson,
  layers: [],
  sourceBindings: [],
  assetRefs: [],
  createdAt,
  updatedAt,
}
```

`queueSourceImageLayer()` must place requests in a sequence-sorted promise chain. It must call `fabric.Image.fromURL` through an injected `imageLoader`, append one OpenShop layer, set the layer name and `sourceBinding`, and mark the Fabric object with `hstarAssetId`, `hstarEdgeId`, and `hstarSourceNodeId`.

- [ ] **Step 4: 禁止项目清单持久化 Base64**

`serializeProject()` must call:

```js
editor.canvas.toJSON([
  'name',
  'excludeFromExport',
  'globalCompositeOperation',
  'hstarAssetId',
  'hstarEdgeId',
  'hstarSourceNodeId',
]);
```

For Fabric image objects with an `hstarAssetId`, replace their serialized `src` with:

```js
{ assetRef: object.hstarAssetId }
```

Do not retain `data:image/...;base64,...` in the returned project object.

- [ ] **Step 5: 运行适配器定向测试**

Run:

```powershell
npm.cmd test -- tests/hstar-project-adapter.test.js
```

Expected: PASS, including out-of-order image resolution and Base64 removal assertions.

- [ ] **Step 6: 运行全部上游单元测试**

Run:

```powershell
npm.cmd test
```

Expected: original 20 tests plus the new Hstar tests all pass.

- [ ] **Step 7: 提交项目适配器**

Run:

```powershell
git add integrations/openshop/host/openshop-project-adapter.js integrations/openshop/tests/hstar-project-adapter.test.js
git commit -m "feat: add OpenShop project adapter"
```

## Task 5: 建立编辑器侧会话运行时

**Files:**
- Create: `integrations/openshop/host/openshop-host-runtime.js`
- Create: `integrations/openshop/tests/hstar-host-runtime.test.js`
- Modify: `integrations/openshop/index.html`

- [ ] **Step 1: 编写失败测试**

Create `integrations/openshop/tests/hstar-host-runtime.test.js`. Use a fake parent window and fake editor. Assert:

- `OPEN_SESSION` establishes exactly one active `sessionId` and project context.
- A message with another origin is ignored.
- A message whose `event.source` is not the registered parent is ignored.
- Duplicate `requestId` is applied once.
- `LOAD_PROJECT` calls `restoreProject()` only for the active project.
- `ADD_IMAGE_LAYER` calls `queueSourceImageLayer()` only for the active project.
- Starting a new session clears request deduplication without sharing prior project state.

- [ ] **Step 2: 运行测试并确认失败**

Run:

```powershell
npm.cmd test -- tests/hstar-host-runtime.test.js
```

Expected: FAIL because `host/openshop-host-runtime.js` does not exist.

- [ ] **Step 3: 实现运行时**

Create an IIFE exposing `window.HstarOpenShopRuntime` with:

```js
start({ editor, protocol, projectAdapter, parentWindow = window.parent, origin = window.location.origin })
stop()
getState()
```

The internal state must contain:

```js
{
  activeSession: null,
  processedRequestIds: new Set(),
  started: false,
}
```

`start()` registers one `message` listener and posts `READY`. `stop()` removes the listener and clears all session state. Message handlers catch errors and post an `ERROR` envelope containing a stable error code and safe message, never an API key or file path.

- [ ] **Step 4: 在 OpenShop 核心之后加载宿主文件**

Add these tags immediately before `</body>` in `integrations/openshop/index.html`:

```html
<script src="./host/openshop-protocol.js"></script>
<script src="./host/openshop-project-adapter.js"></script>
<script src="./host/openshop-host-runtime.js"></script>
<script>
window.addEventListener('DOMContentLoaded', () => {
  if (window.parent === window) return;
  window.HstarOpenShopRuntime.start({
    editor: OS,
    protocol: window.HstarOpenShopProtocol,
    projectAdapter: window.HstarOpenShopProjectAdapter,
  });
});
</script>
```

Directly opening OpenShop must keep its current standalone behavior because the runtime does not start when `window.parent === window`.

- [ ] **Step 5: 运行运行时与上游测试**

Run:

```powershell
npm.cmd test -- tests/hstar-host-runtime.test.js
npm.cmd test
npm.cmd run test:e2e
```

Expected: all new tests pass; upstream remains at 20 original unit tests and 6 original browser scenarios with no regressions.

- [ ] **Step 6: 提交编辑器侧运行时**

Run:

```powershell
git add integrations/openshop/host/openshop-host-runtime.js integrations/openshop/tests/hstar-host-runtime.test.js integrations/openshop/index.html
git commit -m "feat: add OpenShop editor host runtime"
```

## Task 6: 构建 HstarA 同源静态副本

**Files:**
- Create: `integrations/openshop/scripts/build-hstar.mjs`
- Modify: `integrations/openshop/package.json`
- Modify: `integrations/openshop/package-lock.json`
- Create: `static/openshop/`
- Create: `tools/tests/openshop-foundation-build.test.mjs`

- [ ] **Step 1: 编写失败的构建产物测试**

Create `tools/tests/openshop-foundation-build.test.mjs`. Assert:

```js
assert.ok(existsSync('static/openshop/index.html'));
assert.ok(existsSync('static/openshop/LICENSE'));
assert.ok(existsSync('static/openshop/host/openshop-protocol.js'));
assert.ok(existsSync('static/openshop/host/openshop-project-adapter.js'));
assert.ok(existsSync('static/openshop/host/openshop-host-runtime.js'));
assert.equal(existsSync('static/openshop/node_modules'), false);
assert.equal(existsSync('static/openshop/.git'), false);
```

Read `static/openshop/index.html` and assert all three `./host/...` scripts are present and occur before `</body>`.

- [ ] **Step 2: 运行测试并确认失败**

Run from HstarA root:

```powershell
node tools/tests/openshop-foundation-build.test.mjs
```

Expected: FAIL because `static/openshop/` does not exist.

- [ ] **Step 3: 实现确定性构建脚本**

Create `integrations/openshop/scripts/build-hstar.mjs` using only `node:fs` and `node:path`. It must:

1. Delete only the resolved `static/openshop/` destination after asserting it is inside the HstarA repository.
2. Recreate the destination.
3. Copy `index.html`, `icon.png`, `LICENSE`, `host/openshop-protocol.js`, `host/openshop-project-adapter.js`, and `host/openshop-host-runtime.js`.
4. Never copy `.git`, `node_modules`, tests, reports, logs or Markdown research files into the static runtime.
5. Print the copied relative paths in sorted order.

The destination guard must be equivalent to:

```js
const destination = resolve(projectRoot, 'static', 'openshop');
if(dirname(destination) !== resolve(projectRoot, 'static')) {
  throw new Error(`Unsafe OpenShop build destination: ${destination}`);
}
```

- [ ] **Step 4: 增加静态构建命令**

Add to `integrations/openshop/package.json`:

```json
"build:hstar": "node scripts/build-hstar.mjs"
```

Run `npm.cmd install --package-lock-only` so the lockfile stays synchronized without changing versions.

- [ ] **Step 5: 构建并验证静态产物**

Run from `integrations/openshop/`:

```powershell
npm.cmd run build:hstar
```

Then from HstarA root:

```powershell
node tools/tests/openshop-foundation-build.test.mjs
```

Expected: build lists only approved runtime files; test passes.

- [ ] **Step 6: 验证 HstarA 能够提供静态产物**

With the engineering server running on port 3000:

```powershell
$response = Invoke-WebRequest 'http://127.0.0.1:3000/static/openshop/index.html' -UseBasicParsing
$response.StatusCode
$response.Content -match 'openshop-host-runtime.js'
```

Expected: `200` and `True`.

- [ ] **Step 7: 提交源码与确定性构建产物**

Run:

```powershell
git add integrations/openshop/package.json integrations/openshop/package-lock.json integrations/openshop/scripts/build-hstar.mjs static/openshop tools/tests/openshop-foundation-build.test.mjs
git commit -m "build: add OpenShop static runtime"
```

## Task 7: 验证中英文可编辑文字 PSD 路径

**Files:**
- Modify: `integrations/openshop/package.json`
- Modify: `integrations/openshop/package-lock.json`
- Create: `integrations/openshop/scripts/psd-text-probe.mjs`
- Create: `integrations/openshop/tests/hstar-psd-probe.test.js`
- Create: `integrations/openshop/tests/golden/openshop-text-layer-probe.psd`

- [ ] **Step 1: 增加固定版本的 PSD Node 依赖**

Run from `integrations/openshop/`:

```powershell
npm.cmd install --save-exact ag-psd@22.0.2
```

Expected: `package.json` and lockfile contain exactly `22.0.2`.

- [ ] **Step 2: 编写失败的 PSD 结构测试**

Create `integrations/openshop/tests/hstar-psd-probe.test.js` importing `createTextProbePsd` from the script module. Assert the document contains two text layers:

```js
expect(psd.width).toBe(1024);
expect(psd.height).toBe(512);
expect(psd.children[0].text.text).toBe('经典奶茶');
expect(psd.children[0].text.style.font.name).toBe('MicrosoftYaHei');
expect(psd.children[1].text.text).toBe('Classic Milk Tea');
expect(psd.children[1].text.style.font.name).toBe('ArialMT');
```

- [ ] **Step 3: 运行结构测试并确认失败**

Run:

```powershell
npm.cmd test -- tests/hstar-psd-probe.test.js
```

Expected: FAIL because `scripts/psd-text-probe.mjs` does not exist.

- [ ] **Step 4: 实现 PSD 探针生成器**

Create `integrations/openshop/scripts/psd-text-probe.mjs` exporting:

```js
export function createTextProbePsd() {
  return {
    width: 1024,
    height: 512,
    children: [
      {
        name: '中文文字 - 经典奶茶',
        text: {
          text: '经典奶茶',
          transform: [1, 0, 0, 1, 120, 180],
          style: {
            font: { name: 'MicrosoftYaHei' },
            fontSize: 72,
            fillColor: { r: 31, g: 41, b: 55 },
          },
          paragraphStyle: { justification: 'left' },
        },
      },
      {
        name: 'English Text - Classic Milk Tea',
        text: {
          text: 'Classic Milk Tea',
          transform: [1, 0, 0, 1, 120, 330],
          style: {
            font: { name: 'ArialMT' },
            fontSize: 58,
            fillColor: { r: 37, g: 99, b: 235 },
          },
          paragraphStyle: { justification: 'left' },
        },
      },
    ],
  };
}
```

When executed directly, the script must:

1. Call `writePsdBuffer(createTextProbePsd(), { invalidateTextLayers:true, noBackground:true })`.
2. Write `tests/golden/openshop-text-layer-probe.psd`.
3. Read it back with `readPsd(buffer, { skipLayerImageData:true, skipCompositeImageData:true, skipThumbnail:true })`.
4. Assert the two text strings, fonts and transforms survive the structural round trip.
5. Print the file path, byte size and `PSD_STRUCTURE_PASS`.

- [ ] **Step 5: 运行单元测试并生成 PSD**

Run:

```powershell
npm.cmd test -- tests/hstar-psd-probe.test.js
node scripts/psd-text-probe.mjs
```

Expected: unit test passes; script prints `PSD_STRUCTURE_PASS`; PSD file exists and is non-empty.

- [ ] **Step 6: 执行 Photoshop 实机门槛验证**

Open `integrations/openshop/tests/golden/openshop-text-layer-probe.psd` in the installed Adobe Photoshop and verify:

- Both layers appear as text layers, not pixel layers.
- `经典奶茶` can be edited to `快乐一天`.
- `Classic Milk Tea` can be edited without corruption.
- Layer positions and colors are correct.
- Record whether Photoshop displays a text-layer update warning.

Write the observed outcome to the validation report. Each field must contain the actual result from Photoshop:

```markdown
### PSD editable-text gate

- Structural round trip: PASS
- Photoshop opens file: PASS
- Chinese text remains editable: PASS
- English text remains editable: PASS
- Photoshop warning: record `PRESENT` only when Photoshop displays a warning; otherwise record `ABSENT`
- Decision: record `CONTINUE_WITH_AG_PSD` only when both text layers remain editable; otherwise record `REJECT_AG_PSD_TEXT_WRITER`
```

Do not mark the gate passed if Chinese text is rasterized, corrupted, misplaced or uneditable. A warning must be recorded and carried into the final PSD compatibility design even if editing succeeds.

- [ ] **Step 7: 提交可复现的 PSD 探针**

Run:

```powershell
git add integrations/openshop/package.json integrations/openshop/package-lock.json integrations/openshop/scripts/psd-text-probe.mjs integrations/openshop/tests/hstar-psd-probe.test.js integrations/openshop/tests/golden/openshop-text-layer-probe.psd
git commit -m "test: validate OpenShop editable text PSD path"
```

## Task 8: 建立同源 iframe 与 4K 技术基线

**Files:**
- Create: `integrations/openshop/tests/hstar-foundation.e2e.spec.js`
- Modify: `integrations/openshop/package.json`
- Modify: `integrations/openshop/package-lock.json`

- [ ] **Step 1: 增加定向 Playwright 命令**

Add scripts:

```json
"test:hstar:e2e": "playwright test tests/hstar-foundation.e2e.spec.js",
"test:hstar:4k": "playwright test tests/hstar-foundation.e2e.spec.js --grep 4K"
```

- [ ] **Step 2: 编写同源 iframe 桥接测试**

The first test must navigate the parent page to `http://127.0.0.1:3000/`, replace its body with an iframe pointing to `/static/openshop/index.html`, wait for `READY`, send `OPEN_SESSION`, and then send two `ADD_IMAGE_LAYER` messages whose image promises resolve in reverse order.

Assert through the iframe:

```js
expect(result.projectScope).toBe('openshop:classic:canvas-1:node-1:project-1');
expect(result.layerNames).toEqual(['第一张.png', '第二张.png']);
expect(result.sourceSequences).toEqual([0, 1]);
expect(result.pageErrors).toEqual([]);
```

Use the page's real `window.location.origin` and the actual iframe `contentWindow`; do not use `file://`, wildcard origins, or weakened source checks for the test.

- [ ] **Step 3: 编写 4K 稳定性测试**

The test named `4K ten-layer foundation baseline` must:

1. Create a 4096 x 4096 document.
2. Add ten generated raster image layers one at a time.
3. Serialize the project through `HstarOpenShopProjectAdapter`.
4. Render a composite preview.
5. Remove all ten layers and release generated object URLs.

Collect and print:

```js
{
  createMs,
  serializeMs,
  previewMs,
  layerCount,
  serializedBytes,
}
```

Assert `layerCount === 10`, every duration is finite, serialization completes within 30 seconds, and the browser page does not crash. Run this test alone; it is not part of the quick unit suite.

- [ ] **Step 4: 运行 iframe 与 4K 测试**

First verify the engineering server is available, then run:

```powershell
Invoke-WebRequest 'http://127.0.0.1:3000/' -UseBasicParsing | Select-Object StatusCode
npm.cmd run test:hstar:e2e
npm.cmd run test:hstar:4k
```

Expected: server status is `200`; both commands pass and print the measured 4K metrics. Record actual values in the validation report; do not invent tighter product thresholds from this first measurement.

- [ ] **Step 5: 重新运行原始浏览器套件**

Run:

```powershell
npm.cmd run test:e2e
```

Expected: original 6 tests remain green.

- [ ] **Step 6: 提交浏览器验证工具**

Run:

```powershell
git add integrations/openshop/package.json integrations/openshop/package-lock.json integrations/openshop/tests/hstar-foundation.e2e.spec.js
git commit -m "test: add OpenShop host and 4k baselines"
```

## Task 9: 第一阶段证据、全量回归与退出决策

**Files:**
- Create: `docs/validation/2026-07-14-openshop-foundation-validation.md`
- Verify: all files from Tasks 1-8

- [ ] **Step 1: 根据实际输出编写验证报告**

The report must include the following sections and only observed values:

```markdown
# OpenShop Foundation Validation

## Baseline
- Upstream commit: 60c93382868849b1f4f9b073f9519ae61136a05b
- OpenShop version: 0.19.1
- Original unit suite: 20 passed
- Original Playwright suite: 6 passed

## Host foundation
- Record the exact command, exit code and pass/fail result for protocol tests.
- Record the exact command, exit code and pass/fail result for project adapter tests.
- Record the exact command, exit code and pass/fail result for runtime tests.
- Record the served URL and HTTP status for the same-origin static build.

## PSD gate
- Record the structural round-trip command and result.
- Record the Photoshop version and open result.
- Record Chinese and English editability separately.
- Record warning behavior and the resulting writer decision.

## 4K gate
- Record exact create, serialize and preview durations.
- Record the serialized byte count.
- Record browser crash and page-error observations.

## Decision
- Record `CONTINUE` only when protocol, isolation, build and project adapter pass and PSD has an explicit supported or rejected writer decision.
- Record `STOP` when node isolation cannot be enforced, 4K crashes consistently, or no acceptable PSD compatibility path exists.
```

Do not leave empty sections, alternative choices, or unresolved markers in the committed report.

- [ ] **Step 2: 运行全部 OpenShop 单元测试**

Run from `integrations/openshop/`:

```powershell
npm.cmd test
```

Expected: all original and Hstar-specific unit tests pass.

- [ ] **Step 3: 运行全部 OpenShop 浏览器测试**

Run:

```powershell
npm.cmd run test:e2e
npm.cmd run test:hstar:e2e
```

Expected: original 6 browser tests and all Hstar foundation browser tests pass.

- [ ] **Step 4: 运行 HstarA 定向与全量源码检查**

Run from HstarA root:

```powershell
node tools/tests/openshop-protocol.test.mjs
node tools/tests/openshop-foundation-build.test.mjs
node tools/tests/text-encoding-health.test.mjs
node tools/tests/hstarc-health-check.mjs
git diff --check
```

Expected: every command exits `0`; no mojibake, invalid JSON, unsafe static path or whitespace error is reported.

- [ ] **Step 5: 验证工程服务中的 OpenShop 资源**

Run:

```powershell
$response = Invoke-WebRequest 'http://127.0.0.1:3000/static/openshop/index.html' -UseBasicParsing
if ($response.StatusCode -ne 200) { throw "OpenShop static runtime unavailable" }
if ($response.Content -notmatch 'openshop-host-runtime.js') { throw "OpenShop host runtime missing" }
```

Expected: no exception.

- [ ] **Step 6: 提交阶段门槛报告**

Run:

```powershell
git add docs/validation/2026-07-14-openshop-foundation-validation.md
git commit -m "docs: record OpenShop foundation validation"
```

- [ ] **Step 7: 确认阶段完成状态**

Run:

```powershell
git status --short
git log --oneline -10
```

Expected: clean worktree. The validation report decision is `CONTINUE` before writing the phase 2 implementation plan. If it is `STOP`, preserve all evidence and revise the design instead of continuing silently.
