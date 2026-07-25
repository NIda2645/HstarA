# 回收站删除全部 Implementation Plan

> **For agentic workers:** 本计划必须在当前会话内执行，不使用子代理。步骤使用复选框跟踪。

**Goal:** 为项目工作台回收站增加带二次确认的批量彻底删除能力，并完整清理画布关联数据。

**Architecture:** 前端在现有回收站面板中增加标题栏按钮和站内确认层，后端提供只遍历已软删除画布的批量接口。单项与批量接口复用同一彻底删除辅助函数，以保持 OpenShop 项目、AI 任务、画布文件和垃圾回收行为一致。

**Tech Stack:** FastAPI、原生 JavaScript、HTML/CSS、Node.js 静态回归测试、Python/httpx API 测试。

---

### Task 1: 回归测试

**Files:**
- Create: `tools/tests/canvas-trash-purge-all.test.mjs`

- [ ] 编写前端静态回归断言，验证 `#trashPurgeAll` 位于 `#trashClose` 前、确认层存在、空列表禁用、确认调用 `DELETE /api/canvases/trash/purge-all` 并刷新数据。
- [ ] 编写临时目录 API 测试，创建活动画布与回收站画布，为回收站画布初始化 OpenShop 项目和任务，然后断言批量接口只清理回收站数据。
- [ ] 运行 `node tools/tests/canvas-trash-purge-all.test.mjs`，确认因功能尚未实现而失败。

### Task 2: 后端批量清理

**Files:**
- Modify: `main.py`
- Test: `tools/tests/canvas-trash-purge-all.test.mjs`

- [ ] 从现有 `purge_canvas()` 提取同步辅助函数，统一负责锁、关联项目删除、任务取消、画布文件删除和垃圾回收。
- [ ] 新增 `DELETE /api/canvases/trash/purge-all`，在锁内收集 `deleted_at` 为真的画布 ID，并逐项使用公共清理函数。
- [ ] 返回 `{ok: true, purged: N}`，空回收站返回零。
- [ ] 运行针对性测试，确认 API 用例通过且活动画布保留。

### Task 3: 前端按钮与确认交互

**Files:**
- Modify: `static/canvas-list.html`
- Modify: `static/js/canvas-list.js`
- Modify: `static/css/canvas-list.css`
- Test: `tools/tests/canvas-trash-purge-all.test.mjs`

- [ ] 在关闭按钮左侧增加“删除全部”按钮，并增加可访问的站内确认对话框。
- [ ] 在 `renderTrash()` 中按 `deletedCanvases.length` 同步按钮禁用状态。
- [ ] 实现打开、取消、执行中锁定和确认删除；成功后调用现有 `loadAll()` 并重绘回收站，失败时显示中文状态提示。
- [ ] 为浅色、深色和窄屏补充紧凑样式，不改变现有回收站卡片布局。
- [ ] 更新 HTML 中 CSS/JS 缓存版本。
- [ ] 运行针对性测试并确认通过。

### Task 4: 完整验证

**Files:**
- Verify only

- [ ] 运行 `node --check static/js/canvas-list.js`。
- [ ] 运行 `node tools/tests/canvas-trash-purge-all.test.mjs`。
- [ ] 运行 `node tools/tests/static-cache-integrity.test.mjs`。
- [ ] 运行 `node tools/audit-text-encoding.mjs`。
- [ ] 运行 `git diff --check`。
- [ ] 在 3000 端口以隔离测试画布验证打开确认、取消、确认删除及空状态，不处理用户已有回收站数据。
