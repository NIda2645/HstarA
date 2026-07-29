# Hstar 桌面启动默认进入无限画布设计

## 目标

每次启动 Hstar Windows 桌面软件时，无论上次关闭前停留在哪个功能页面，启动动画结束后都默认显示“无限画布”的画布列表页。

本次变更只控制一次桌面进程启动后的首次主页加载。用户进入软件后仍可自由切换页面；浏览器直接访问 Hstar、页面刷新、画布数据和其他本地偏好不受影响。

## 当前行为

桌面壳导航到服务根页后，`static/index.html` 从 `localStorage.studio_active_page` 恢复上次页面。默认值为 `zimage`，因此桌面软件启动结果取决于上次停留页面，而不是固定进入无限画布。

“无限画布”导航项的页面标识为 `canvas`，对应内嵌页面 `/static/canvas-list.html`。

## 设计

### 桌面启动提示

`MainWindow` 在首次主页导航前，通过现有的 `CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync` 启动脚本注入只属于当前桌面启动会话的全局值：

```text
window.__HSTAR_START_PAGE__ = "canvas"
```

该值与现有导航会话标识一起在文档创建前就绪，不新增后端配置、用户设置或持久化字段。

### 主页初始页面选择

`static/index.html` 的首屏导航高亮和 `restoreActivePage()` 使用同一选择顺序：

1. 若 `window.__HSTAR_START_PAGE__` 是合法页面标识，则使用该值。
2. 否则恢复 `localStorage.studio_active_page`。
3. 若存储值无效，则使用主页原有默认页。

桌面启动提示只参与初始选择。调用 `switchUI(..., { skipRemember: true })`，避免启动过程无意义覆盖用户原有页面偏好。用户随后主动切换页面时，现有记忆逻辑继续正常工作。

### 作用域

- Windows 桌面软件每次新进程启动：默认进入无限画布列表。
- 软件内切换页面：保持当前页面，不被强制跳回。
- 普通浏览器访问：没有桌面启动提示，继续恢复上次页面。
- 首屏显示：在移除 `studio-route-booting` 前完成页面与侧栏选择，避免先闪现其他页面。
- 不直接打开任何已有画布，不修改画布内容、排序、最近访问记录或存储位置。

## 错误处理

主页只接受 `PAGE_IDS` 中的启动页面标识。缺失、空值或未知值均回退到现有本地恢复和默认页逻辑，不阻断软件启动。

## 验证

1. 桌面契约测试确认启动脚本注入 `canvas`。
2. 主页契约测试确认桌面启动提示优先于 `localStorage`，且无提示时仍恢复原值。
3. 桌面测试、相关 Node 契约、编码审计和 `git diff --check` 全部通过。
4. 使用隔离 AppData、数据根目录和非 `5000` 端口实际启动桌面程序，确认就绪后激活 `frame-canvas`，其 URL 为 `/static/canvas-list.html`。
5. 本次不打包安装包；只有收到新的明确打包指令后才执行发布流程。
