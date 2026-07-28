# OpenShop 防崩溃本地文件导入设计

## 目标

修复 HstarA 图文分层编辑器中“打开图像”和“打开 PSD”触发 Windows 文件窗口后导致 Codex/HstarA 宿主进程退出的问题，同时保留现有图片与 PSD 的尺寸、格式、结构和图层校验。

## 根因证据

Windows Application Error 事件记录显示，故障进程是 Codex 包内的 `ChatGPT.exe`，异常码为 `0xc06d007f`；HstarA Python 服务没有对应异常。OpenShop 当前有两条宿主文件窗口路径：

- “打开图像”优先调用 `window.showOpenFilePicker()`。
- “打开 PSD”点击嵌套 OpenShop iframe 内的隐藏 `<input type="file">`。

两条路径最终都要求 Codex 宿主进程创建 Windows 原生文件对话框。使用 Playwright 的 `setInputFiles()` 绕过系统窗口后，现有解析链路可以正常完成：PNG 成功创建图像对象，测试 PSD 成功创建 1024×512 文档与两个图层。因此崩溃点是宿主文件窗口，而不是图片或 PSD 解码。

## 方案

Windows 下由 HstarA 后端启动独立 PowerShell STA 进程显示 `System.Windows.Forms.OpenFileDialog`。文件窗口不再运行于 `ChatGPT.exe`；即使系统文件窗口或 shell 扩展异常，故障也被隔离在临时 PowerShell 进程中。

用户选中文件后，后端通过同源本地 HTTP 响应流式返回文件内容、文件名和 MIME 类型。OpenShop 将响应构造成浏览器 `File`，再交给现有 `_handleFileLoad()` 或 `_loadPSDFile()`，不改变后续导入语义。

## 后端协议

新增 `POST /api/native/open-local-file`。

请求体：

```json
{"kind":"image"}
```

或：

```json
{"kind":"psd"}
```

### 成功响应

- 状态码 `200`。
- 响应体为文件二进制流。
- `Content-Type` 为检测后的媒体类型；PSD 使用 `image/vnd.adobe.photoshop`。
- `X-Hstar-Filename` 保存 URL 编码后的基础文件名，不包含本地目录。
- `X-Hstar-File-Size` 保存字节数。
- `Cache-Control: no-store`，禁止浏览器或代理缓存本地文件。

### 取消响应

用户关闭文件窗口或点击取消时返回 `204`，OpenShop 保持当前文档不变，不显示错误。

### 错误响应

- 非 Windows 平台返回 `501`，前端可以回退到浏览器文件输入。
- 非本机请求或非同源请求返回 `403`，不得触发服务器电脑上的文件窗口。
- 文件窗口进程异常、超时或无法启动时返回明确的 `5xx` 错误；Windows 前端只显示错误，不回退到可能再次导致 Codex 崩溃的浏览器文件窗口。
- 文件扩展名、文件类型或大小不符合要求时返回 `400` 或 `413`。

## 文件窗口

新增通用 `choose_open_file_path(kind)`，复用现有 HstarA PowerShell 文件夹、应用程序和保存窗口的独立进程模式：

- 使用 `powershell -NoProfile -STA`。
- 创建不可见但位于前台的 HstarA owner 窗口，确保文件对话框不会被主窗口遮挡。
- 图片过滤器仅允许 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif` 和 `.bmp`。
- PSD 过滤器仅允许 `.psd`。
- 禁止多选，并要求文件必须存在。
- 使用进程级互斥锁，避免同一时间弹出多个本地文件窗口。
- 最长等待 300 秒，超时后终止辅助进程并返回错误。

后端再次验证 PowerShell 返回的路径，只接受存在的普通文件、允许的扩展名和对应大小限制。任何响应头都不得包含完整本地路径。

## 前端流程

新增 `_requestNativeLocalFile(kind)`：

1. 向 `/api/native/open-local-file` 发送同源 POST 请求。
2. `204` 返回 `null`。
3. `200` 时读取 Blob、解码 `X-Hstar-Filename`，构造具有正确名称和 MIME 类型的 `File`。
4. `501` 返回“平台不支持”标记，调用原隐藏文件输入。
5. 其他失败抛出可读错误并显示 toast，不触发浏览器文件窗口。

`openFile()` 和 `openPSD()` 改为异步调用该入口。Windows 路径不再调用 `showOpenFilePicker()`，也不直接点击 iframe 内的隐藏文件输入。

## 兼容性

- 后续图片导入继续经过 `_validateImageFile()` 与 `_validateDecodedImage()`。
- PSD 继续经过文件大小、头部、尺寸、颜色模式、位深、像素数、图层数和单层像素检查。
- 拖放、粘贴、打开项目、导入色板等不属于本次崩溃入口，保持现状。
- 非 Windows 平台保留原浏览器文件输入，避免减少原有能力。
- 打开文件不会写入系统相册、素材库或任意外部目录。

## 安全边界

- 后端接口必须同时通过本机来源和同源检查。
- 浏览器只能接收用户在独立窗口中明确选择的文件。
- 请求不能携带任意路径，接口也不能根据浏览器提供的路径读取文件。
- 文件响应不缓存，不返回完整路径，不记录文件内容。
- 文件选择互斥锁只保护窗口生命周期，不阻塞其他 HstarA API。

## 测试策略

### 后端单元测试

- 模拟 PowerShell 成功选择图片或 PSD，验证过滤器、路径规范化和扩展名限制。
- 模拟取消、辅助进程失败和超时。
- 验证非本机请求被拒绝。
- 验证成功响应仅暴露基础文件名、类型和大小。

### OpenShop 单元测试

- 模拟二进制图片响应，验证 `openFile()` 调用 `_handleFileLoad()` 且不点击隐藏输入。
- 模拟 PSD 响应，验证 `openPSD()` 调用 `_loadPSDFile()`。
- 验证取消不改变文档。
- 验证 Windows 后端错误只显示错误，不回退浏览器窗口。
- 验证 `501` 才允许跨平台回退。

### 浏览器集成测试

- 拦截本地文件接口并返回真实 PNG fixture，验证菜单入口创建正确尺寸图像文档。
- 返回真实 PSD fixture，验证菜单入口创建正确文档和图层。
- 断言测试过程中不调用 `showOpenFilePicker()`，也不点击 iframe 文件输入。

## 验收标准

1. Windows/Codex 环境点击“打开图像”或“打开 PSD”时，文件窗口由独立 PowerShell 进程承载。
2. 选择有效 PNG/JPEG/WebP/GIF/BMP 后可以正常进入 OpenShop 文档。
3. 选择有效 PSD 后可以正常保留文档尺寸和可解析图层。
4. 取消文件窗口不会修改当前项目。
5. 文件窗口异常不会关闭 Codex、HstarA 或当前 OpenShop 会话。
6. Windows 下任何后端错误都不会回退到导致崩溃的宿主文件窗口。
7. 非 Windows 平台仍可使用原浏览器文件输入。
8. 本地路径不会出现在浏览器响应、项目数据或日志中。
