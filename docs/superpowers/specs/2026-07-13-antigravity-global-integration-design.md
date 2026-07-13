# Antigravity 全局接入与后台窗口设计

## 目标

- 所有允许选择 Antigravity CLI 的 HstarA 功能都进入真实 CLI 通道。
- 标记识别、文字 OCR、修改文字、消除文字均传递原图和精确模型。
- 所有后台 Antigravity 调用不显示控制台窗口。
- 用户主动点击“启动”时仍显示独立交互终端。

## 接入边界

现有聊天、画布 LLM、标记识别、素材描述和生图入口继续复用 `gemini_cli_chat_text`、`generate_gemini_cli_provider_image` 与 `generate_ai_image`。文字 OCR 端点在调用 `resolve_chat_provider` 前增加 Antigravity 分支，把完整原图交给 `gemini_cli_chat_text`，并沿用现有 JSON/逐行解析和返回格式。

修改文字和消除文字继续走 `/api/canvas-image-tasks` 的普通生图任务。两种模式都必须携带当前原图引用、用户选定的 Antigravity 图像模型和尺寸/质量/数量参数，并在原节点下游创建输出节点。此次不新增第二套生成协议，只补充端到端契约测试。

## Windows 后台进程

`gemini_cli_background_subprocess_kwargs` 在 Windows 同时返回：

- `CREATE_NO_WINDOW`
- `STARTUPINFO.dwFlags |= STARTF_USESHOWWINDOW`
- `STARTUPINFO.wShowWindow = SW_HIDE`

请求执行、模型发现、状态检测和帮助命令统一使用该参数。显式终端启动继续单独使用 `CREATE_NEW_CONSOLE`，不复用隐藏参数。

## 错误与兼容性

- 非 Windows 不传 Windows 专用参数。
- CLI 未安装、超时、返回空结果等错误沿用现有格式。
- HTTP API、Codex CLI、ModelScope 和其他协议行为保持不变。
- OCR 取消仍由前端 AbortController 负责忽略已取消请求的结果，不改变现有状态机。

## 验证

- 测试 Windows 后台参数同时包含无窗口标志和隐藏 `STARTUPINFO`。
- 测试显式启动仍使用 `CREATE_NEW_CONSOLE`。
- 测试 OCR 的 Antigravity 分支收到原图和精确模型，且不调用 HTTP 解析器。
- 测试修改文字与消除文字都将原图引用和精确模型送入统一生图任务。
- 运行全部测试，并执行一次真实 OCR HTTP 请求和一次真实图片标记请求。
