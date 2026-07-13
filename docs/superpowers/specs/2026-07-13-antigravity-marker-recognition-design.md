# Antigravity 标记识别与后台进程设计

## 目标

- 让普通画布和智能画布的标记识别真正通过 Antigravity CLI 处理图片。
- 使用画布中选定的精确模型，不回退到界面占位文字或 HTTP API 通道。
- 消除画布后台调用 Antigravity 时短暂出现的黑色命令窗。
- 保留“启动”按钮的交互终端行为，用户主动启动时仍显示独立 PowerShell 窗口。

## 数据流

`/api/image-marker/identify` 先读取平台配置。HTTP API 平台继续走现有 `resolve_chat_provider` 流程；Antigravity 平台走独立 CLI 分支：

1. 校验局部标记截图或完整原图至少存在一个。
2. 将 data URL、本地输出 URL 或远程图片转换为 CLI 可读取的临时本地路径。
3. 组合标记编号、归一化坐标和“识别完整物体”的约束提示。
4. 通过现有 `gemini_cli_chat_text` 调用 `agy --model <精确模型>`。
5. 沿用当前中文短标签清洗逻辑并返回 `object_name`、原始文本和实际模型。
6. 无论成功或失败均清理临时图片。

普通画布和智能画布已经调用同一个后端端点，因此不新增前端分叉。

## Windows 进程可见性

增加统一的 Antigravity 后台子进程参数函数。Windows 后台命令使用 `CREATE_NO_WINDOW`，覆盖画布请求、模型发现、状态检测和帮助命令；非 Windows 不传 Windows 专用参数。

`/api/gemini-cli/launch` 继续单独使用 `CREATE_NEW_CONSOLE`，不复用后台隐藏参数。

## 错误处理

- 图片缺失继续返回 400。
- CLI 未安装、超时或执行失败沿用现有 Antigravity 错误格式。
- 空识别结果返回空标签，由前端进入“识别失败”状态。
- HTTP API 平台行为保持不变。

## 验证

- 先增加失败测试，证明当前标记端点错误进入 `resolve_chat_provider`。
- 验证 CLI 分支收到局部图、完整图、精确模型和坐标提示。
- 验证临时文件在成功与异常路径均被清理。
- 验证所有后台 `agy` 调用在 Windows 使用 `CREATE_NO_WINDOW`。
- 验证主动启动终端仍使用 `CREATE_NEW_CONSOLE`。
- 运行全部根目录测试并执行一次真实 Antigravity 图片标记识别。
