# HstarA 全局语音助手设计

## 1. 目标

在 HstarA 中增加一个模块化、可选安装、完全本地运行的全局语音助手。语音助手使用 `FunAudioLLM/Fun-ASR-Nano-2512` 将麦克风语音实时转换为文字，并把结果准确写入当前获得焦点的自然语言文本框。

该能力必须覆盖普通画布、智能画布、GPT 对话、素材库、OpenShop、3D 导演台以及后续新增页面中的合格文本目标，同时满足以下约束：

- 模型权重、ModelScope 缓存、FunASR、Torch 和可选 CUDA 运行环境不进入 HstarA 安装包。
- 未安装或关闭语音助手时，不启动外部语音进程，不申请麦克风权限，不增加画布持续运行负担。
- 语音模型、运行时和下载缓存与 HstarA 主 Python 环境隔离。
- CUDA 可用时自动使用 NVIDIA GPU；CUDA 不可用或初始化失败时回退 CPU。
- 识别过程中实时显示临时文字，停顿后提交稳定文字。
- 连续 10 秒未检测到有效语音时，自动提交已有结果、关闭录音并释放麦克风。
- 默认快捷键为 `Shift+Q`，用户可在软件设置中修改或关闭。
- 不读取、不迁移、不修改 5000 端口稳定软件的数据和缓存。

## 2. 非目标

首版不包含以下能力：

- 唤醒词和长期后台监听。
- 云端 ASR 自动回退。
- 说话人分离、说话人识别和时间戳编辑。
- 语音命令控制画布或自动创建 `@` 引用。
- 将原始录音保存为素材或训练数据。
- 在安装包中预装模型权重或完整语音推理环境。

这些边界与 Fun-ASR-Nano-2512 当前公开能力保持一致，避免把模型尚未提供的时间戳或说话人能力伪装为已支持功能。

## 3. 用户交互

### 3.1 启动听写

用户点击任意合格文本框后，文本框边缘显示紧凑的麦克风按钮。用户可以通过以下方式开始或停止听写：

- 点击麦克风按钮。
- 按下默认快捷键 `Shift+Q`。

快捷键在输入法组合期间不响应。由于 `Shift+Q` 会占用大写 `Q` 的直接输入，设置页必须明确显示该取舍，并允许用户修改或关闭快捷键。

文本目标当前仍有焦点时，`Shift+Q` 直接绑定该目标。焦点位于画布等非编辑区域时，快捷键可以使用最后一个仍连接且合格的文本目标；不存在有效目标时只提示“请先选择文本输入位置”，不能自行猜测目标。

### 3.2 连续听写

- 开始听写时锁定当前文本目标和光标位置。
- 临时识别结果直接显示在文本框中，但始终替换同一个组合文本区间，不重复追加。
- 模型确认一个语句后，将其转换为最终文字并形成一个可撤销操作。
- 短暂停顿用于确认当前语句，但会话继续保持。
- 从最后一次 VAD 有效语音开始，连续 10 秒无新语音时结束会话。
- 从启动开始 10 秒始终没有检测到语音时结束会话，并提示“未检测到语音”。
- 手动停止时立即处理剩余音频、提交可确认结果并释放麦克风。

环境底噪、静音和非语音事件不能重置 10 秒计时器。计时依据服务端 VAD 结果，不依据浏览器输入音量的简单阈值。

### 3.3 目标切换

一个会话只绑定一个文本目标。用户切换到另一个文本框时，系统先完成当前稳定语句并停止旧会话，不允许同一段语音跨两个目标写入。目标节点被删除、页面关闭、iframe 卸载或应用退出时，立即取消未确认文字并结束会话。

## 4. 总体架构

采用“主壳协调 + 独立语音服务 + 页面目标适配器”的结构：

```text
HstarA 主壳 VoiceCoordinator
  ├─ 当前目标、录音、快捷键和 UI 状态
  ├─ 下载与模型状态
  ├─ 同源 iframe / 嵌套 iframe 消息路由
  └─ HstarA FastAPI VoiceAssistantManager
       ├─ 设置与模型注册表
       ├─ 下载任务管理
       ├─ 独立进程 supervisor
       └─ 本机认证 IPC
            └─ FunASR 语音服务进程
                 ├─ VAD
                 ├─ Fun-ASR-Nano-2512
                 └─ CUDA / CPU 推理

各页面 VoiceTargetAdapter
  ├─ input / textarea
  ├─ contenteditable
  └─ HstarA 自定义编辑器适配器
```

`VoiceAssistantManager` 是主服务中的轻量协调对象，不加载 Torch 或模型。外部语音进程只在首次使用、显式启动或开启“启动后预热”时创建。

独立进程提供以下隔离：

- FunASR、ModelScope、Torch 与主工程依赖分离。
- 模型崩溃或显存不足不终止 HstarA 主服务。
- 模型可以单独更新、修复、迁移和卸载。
- 子进程环境不包含 HstarA API 密钥和供应商配置。

## 5. 存储设计

### 5.1 设置结构

`software_settings.json` 增加：

```json
{
  "voice_assistant": {
    "enabled": true,
    "storage_mode": "inherit",
    "storage_root": "",
    "model_path": "",
    "model_id": "FunAudioLLM/Fun-ASR-Nano-2512",
    "model_revision": "",
    "language": "auto",
    "input_device_id": "default",
    "shortcut": "Shift+Q",
    "prewarm_on_startup": false,
    "warm_idle_seconds": 600,
    "silence_stop_seconds": 10
  }
}
```

`model_path` 和 `model_revision` 由后端检测器维护，前端不能直接伪造“模型可用”状态。`silence_stop_seconds` 首版固定为 10，写入设置用于协议版本和后续迁移，不在普通界面开放任意值。

### 5.2 有效目录

有效语音数据根目录按以下优先级解析：

1. `storage_mode=custom` 且自定义目录有效时，使用 `voice_assistant.storage_root`。
2. `storage_mode=inherit` 且用户配置过普通 `storage_root` 时，在该软件数据目录下使用 `voice-assistant` 子目录。
3. 普通软件数据未自定义时，使用 `%APPDATA%\Hstar\voice-assistant`，不写入安装程序目录。

目录结构：

```text
<voice-root>/
  .hstar-voice/
    runtime/          # 独立 Python 环境与固定版本依赖
    downloads/        # 可续传的临时下载
    cache/            # 运行缓存
    state/            # manifest、任务和安装状态
    logs/             # 不含音频和识别全文的诊断日志
  FunAudioLLM/
    Fun-ASR-Nano-2512/
      ...模型文件...
```

### 5.3 路径变更

- 自定义语音目录不随普通软件数据目录变化。
- 继承模式随普通软件数据目录变化，但不静默复制数 GB 数据。
- 目录变化后，如果新位置没有模型，设置页提供“使用旧目录”“迁移到新目录”“重新下载”三种显式操作。
- 迁移使用复制、校验、原子切换、最后清理源目录的顺序；失败时继续使用旧目录。
- 外部手动模型默认只注册引用，卸载时不删除，除非用户在确认窗口中明确勾选该目录。

## 6. 模型下载、发现与校验

### 6.1 首次使用

首次点击语音入口时依次检查：

1. 语音运行环境是否完整。
2. 模型目录是否存在并通过校验。
3. CUDA 是否可用，否则准备 CPU 模式。
4. 麦克风权限是否可用。

模型不存在时弹出首次使用窗口。窗口显示模型 ID、预计空间、有效目录和硬件模式，并提供：

- 使用默认位置。
- 选择其他文件夹。
- 检测已有模型。
- 开始下载。
- 取消并暂不启用。

下载完成后必须恢复首次触发时的文本目标；目标仍存在时自动开始听写，不要求用户再次点击。

### 6.2 官方下载

下载使用 ModelScope 官方 SDK 或 CLI 的等价调用，模型 ID 固定为：

```powershell
modelscope download `
  --model FunAudioLLM/Fun-ASR-Nano-2512 `
  --local_dir "<voice-root>\FunAudioLLM\Fun-ASR-Nano-2512"
```

不能通过拼接未经校验的 shell 字符串执行用户路径。实现应优先使用 Python API 或参数数组启动子进程。

下载状态阶段：

```text
checking-runtime
installing-runtime
resolving-manifest
downloading-model
verifying-files
loading-smoke-test
ready
```

界面分别显示运行时和模型进度，包括已下载字节、总字节、速度和预计剩余时间。总大小无法从远端清单可靠取得时，必须显示“不确定总量”的真实状态，不能伪造百分比。

### 6.3 下载可靠性

- 文件先写入任务临时目录，完整校验后原子激活。
- 支持取消、断点续传和 HstarA 重启后恢复任务。
- 页面和画布切换不终止后台下载。
- 下载失败保留可续传数据，但不标记为可用模型。
- 记录远端实际 revision/commit 和本地 manifest。
- 模型更新先安装到候选目录；加载测试通过后切换，失败则回滚旧版本。
- 校验失败只重新获取损坏或缺失文件。
- 磁盘不足、网络错误、代理错误、权限错误和远端清单错误使用不同中文错误码。

### 6.4 手动模型发现

设置页允许用户选择：

- 模型目录本身。
- 包含 `FunAudioLLM/Fun-ASR-Nano-2512` 的父目录。
- ModelScope 标准缓存根目录。

检测器只检查明确目录和有限的标准子路径，不无界递归扫描整个磁盘。检测内容包括模型配置、权重、词表、`model.py`、revision 信息和权重可读性。文件检测通过后，在独立进程执行一次加载冒烟测试。

官方模型 ID 的已知版本可以默认信任。未知来源的手动目录必须显示远程代码风险提示，并始终在收敛权限的子进程中加载。

## 7. 独立运行时与硬件选择

### 7.1 可选运行时

运行时安装在 `<voice-root>/.hstar-voice/runtime`，使用固定依赖清单，不修改 HstarA 主 Python 的 `requirements.txt` 运行环境。运行时至少包含经实际验证的 FunASR、ModelScope、Torch、音频解码和 VAD 依赖。

安装前执行轻量硬件探测：

- NVIDIA 驱动和兼容 CUDA 可用时选择对应 Torch 运行包。
- 无 NVIDIA GPU 时选择 CPU 运行包。
- CUDA 包初始化失败时，同一环境仍允许 CPU 推理；必要时提供“修复为 CPU 运行时”。

### 7.2 模型生命周期

- 默认不在 HstarA 启动时加载模型。
- 首次点击麦克风后异步创建服务并加载模型，主 UI 不得阻塞。
- 模型加载完成后在多个听写会话之间复用。
- 最后一次会话结束后保温 600 秒。
- 保温超时且没有任务时卸载模型并释放显存或主要模型内存。
- 开启“启动后预热”时，在 HstarA 主页面可用后后台加载，不阻塞启动画面。
- 检测到显存或系统内存压力时允许提前卸载，并广播明确原因。

### 7.3 性能约束

- CUDA 使用模型实际兼容的 FP16 或 BF16 和 `inference_mode`，不能假定所有设备支持同一种精度。
- CPU 模式限制线程并使用较低进程优先级，避免占满处理器。
- VAD 和 ASR 只维护一份实例。
- 音频与推理队列有容量上限和背压。
- 过期临时推理可以合并或丢弃，最终句子任务不能丢弃。
- 使用滚动音频窗口、序列号和稳定前缀复用，不能每次从整段录音重新推理。
- 缓存模型清单、分词器配置和设备探测结果。
- 不默认启用会显著增加冷启动时间的动态编译；只有实测净收益时才启用。
- 已保温模型从点击入口到可接收音频的目标时间不超过 500ms。
- 冷加载期间画布交互、页面导航和其他 API 必须保持可用。

实际 CUDA 和 CPU 冷启动时间、实时系数、内存及显存占用必须在目标 Windows 11 设备上测量后记录，不能在未测试时承诺固定秒数。

## 8. 实时识别协议

### 8.1 音频链路

浏览器使用 `getUserMedia` 和 AudioWorklet 采集音频，转换为 16kHz 单声道 PCM，通过同源 WebSocket 发送：

```text
浏览器麦克风
  -> /ws/voice-assistant/transcribe
  -> VoiceAssistantManager
  -> 本机认证 IPC
  -> 独立 FunASR 服务
```

完整录音不落盘。短时音频只存在于有界内存环形缓冲区，并在会话结束后清除。

### 8.2 浏览器到服务消息

控制消息使用 JSON，音频帧使用 WebSocket 二进制消息。关键消息：

```json
{ "type": "start", "session_id": "...", "language": "auto", "sample_rate": 16000 }
{ "type": "stop", "session_id": "...", "reason": "user" }
{ "type": "cancel", "session_id": "...", "reason": "target-removed" }
```

服务事件：

```json
{ "type": "ready", "session_id": "...", "device": "cuda", "sequence": 0 }
{ "type": "speech-state", "active": true, "silence_remaining_ms": 10000 }
{ "type": "partial", "text": "...", "sequence": 4 }
{ "type": "final", "text": "...", "sequence": 5 }
{ "type": "stopped", "reason": "silence-timeout", "sequence": 6 }
{ "type": "error", "code": "VOICE_MODEL_OOM", "recoverable": true }
```

客户端只接受单调递增的 `sequence`，丢弃迟到的临时结果，防止网络抖动把旧文字覆盖到新文字上。

### 8.3 识别行为

- VAD 负责分段和 10 秒静默计时。
- 模型输出通过滚动上下文生成临时结果。
- 临时结果只替换当前组合区间。
- 语句稳定后发送 `final`，客户端提交一个撤销单元。
- 默认启用 ITN 和模型原生标点能力。
- 语言提供 `auto`、`zh`、`en`、`ja`。如果实际 FunASR 接口不能可靠自动检测，服务先执行短音频语言检测再锁定支持语言，不伪造自动模式。
- CUDA 推理落后时合并临时任务；CPU 推理落后时降低临时刷新频率，优先保证最终结果和队列有界。

## 9. 全局文本目标适配

### 9.1 自动目标

共享 `VoiceTargetAdapter` 通过事件委托识别动态创建的：

- `textarea`
- 允许自然语言的 `input[type=text|search]`
- `contenteditable` 元素

页面可以通过 `data-voice-input="off"` 明确排除控件，通过 `data-voice-input="on"` 显式启用其他输入类型，或通过注册接口覆盖默认行为。API 设置、路径和机器配置页面必须显式标记敏感字段，不能只依赖字段名称猜测。

### 9.2 自定义编辑器协议

画布节点、OpenShop 富文本和其他非标准编辑器实现：

```text
getSelection()
beginComposition()
updateComposition(text)
commitComposition(text)
cancelComposition()
isTargetAvailable()
getTargetLabel()
```

适配器必须保证：

- 识别结果写入当前光标位置。
- 已有文本选区被语音结果替换。
- 临时结果不进入撤销栈。
- 每个最终语句是一个可撤销事务。
- 触发现有 `beforeinput`、`input`、自动保存和节点脏状态链路。
- 保留原有换行、前后文本、富文本和 `@` 胶囊 DOM 结构。
- 普通语音文字中的 `@` 不自动创建引用胶囊。
- 用户键盘输入或外部代码改写目标时先结束组合状态，不能覆盖用户的新内容。

### 9.3 iframe 路由

主壳只管理一个录音会话。每个同源 iframe 注册自己的活动目标，嵌套 OpenShop 通过父页面逐级转发。iframe 卸载时必须注销目标。页面独立打开时可以创建本页轻量协调器，但处于 HstarA 主壳时不能创建第二个麦克风会话。

### 9.4 覆盖与排除

必须覆盖：

- 普通画布和智能画布中的 Prompt、LLM、API 生成和节点文本框。
- GPT 对话输入框。
- 素材库搜索、名称、描述和标签。
- OpenShop 生成式填充、局部重绘、文字编辑和自然语言字段。
- 3D 导演台的自然语言输入字段。
- 动态节点、弹窗和后续新增页面中的标准合格文本框。

必须排除：

- 密码和 API 密钥。
- 文件路径和文件选择器。
- 数字、颜色、范围和日期参数。
- 快捷键录入框。
- 禁用、只读和隐藏字段。
- 页面显式标记为非自然语言的机器配置字段。

## 10. 前端 UI

### 10.1 软件设置

“软件设置”新增独立“语音助手”卡片，显示：

- 功能状态：未安装、下载中、可用、加载中、运行中、需要修复。
- 储存模式、当前有效目录和实际模型目录。
- 模型 ID、revision、占用空间和完整性。
- 运行时版本和模型版本。
- 当前设备和 CUDA/CPU 模式。
- 麦克风设备选择。
- 识别语言。
- 快捷键 `Shift+Q`。
- 启动后预热开关。
- 下载、检测、修复、更新、迁移和卸载操作。

路径选择复用 HstarA 现有 Windows 文件夹选择器和路径校验逻辑，但语音路径使用独立 purpose 和独立保存接口。

### 10.2 文本框入口

麦克风入口使用浮层定位，不改变文本框或节点原有尺寸。它通过滚动、缩放、节点移动、ResizeObserver 和 iframe 变化重新定位。

状态映射：

```text
未安装 -> 下载图标
可用   -> 麦克风图标
加载中 -> 环形进度
聆听中 -> 动态音量
识别中 -> 处理状态
静默中 -> 10 秒倒计时
错误   -> 警告图标
```

只显示一条当前状态，不重复弹出同义提示。按钮具有工具提示、键盘焦点和屏幕阅读器标签，并适配 HstarA 深色主题、浅色主题和 UI 缩放。

### 10.3 首次使用与下载

首次使用弹窗只要求用户确认目录或选择已有模型。下载进度在页面切换后持续存在，并可从主壳状态区域重新展开。下载结束后恢复原文本目标。

## 11. 后端 API

稳定接口：

```text
GET  /api/voice-assistant/status
GET  /api/voice-assistant/settings
POST /api/voice-assistant/settings
POST /api/voice-assistant/choose-folder
POST /api/voice-assistant/detect-model
POST /api/voice-assistant/install
POST /api/voice-assistant/install/cancel
POST /api/voice-assistant/repair
POST /api/voice-assistant/migrate
POST /api/voice-assistant/uninstall
POST /api/voice-assistant/service/start
POST /api/voice-assistant/service/stop
WS   /ws/voice-assistant/transcribe
```

下载、迁移、修复和卸载均使用任务 ID 和幂等键。重复点击不能创建重复任务。任务状态复用 HstarA 主壳消息广播机制，所有页面看到同一真实状态。

建议模块边界：

```text
voice_assistant/
  settings.py
  registry.py
  installer.py
  supervisor.py
  protocol.py
  audio.py
  service.py
```

每个模块只负责一个职责，主 `main.py` 只注册路由和组合服务，不承载模型实现。

## 12. 安全与隐私

- 推理服务只使用随机本机端口、Windows 受控管道或等价本机 IPC，不监听外部网卡。
- 每次 HstarA 启动生成内部随机令牌，子进程拒绝未认证请求。
- 子进程环境移除 API 密钥、供应商配置和无关环境变量。
- 子进程只需要语音目录和本次会话音频访问权限。
- 原始录音默认不落盘。
- 日志不记录原始音频和完整识别文本，只记录状态、设备、耗时和脱敏错误。
- 局域网客户端使用语音功能前明确说明音频将发送到运行 HstarA 的主机做本地识别。
- 不进行未经用户同意的云端上传。
- 手动模型目录中的远程代码始终在隔离进程执行，并显示来源风险。

## 13. 错误处理

使用稳定中文错误码和可恢复标志，至少覆盖：

- `VOICE_RUNTIME_MISSING`
- `VOICE_RUNTIME_INSTALL_FAILED`
- `VOICE_MODEL_MISSING`
- `VOICE_MODEL_INCOMPLETE`
- `VOICE_MODEL_LOAD_FAILED`
- `VOICE_MODEL_OOM`
- `VOICE_CUDA_UNAVAILABLE`
- `VOICE_MIC_PERMISSION_DENIED`
- `VOICE_MIC_BUSY`
- `VOICE_DOWNLOAD_NETWORK_ERROR`
- `VOICE_DOWNLOAD_DISK_FULL`
- `VOICE_STORAGE_NOT_WRITABLE`
- `VOICE_TARGET_LOST`
- `VOICE_SERVICE_DISCONNECTED`

恢复规则：

- CUDA 初始化失败时提示并自动回退 CPU。
- 显存不足时卸载模型、清理显存并允许 CPU 重试。
- WebSocket 中断时保留已提交文字，撤回未提交临时文字。
- 服务异常退出时最多自动重启一次；连续失败后停止重试。
- 模型被移动或删除后切换为“需要检测/修复”，不循环崩溃。
- 目录不可写时不覆盖当前有效配置。
- 卸载和迁移前展示具体目录与空间并二次确认。
- HstarA 退出时先结束会话，再停止子进程。

## 14. 打包与仓库边界

Git 和 Windows 安装包必须排除：

- `.hstar-voice/runtime/`
- `.hstar-voice/downloads/`
- `.hstar-voice/cache/`
- Fun-ASR 模型权重和 ModelScope 缓存。
- 临时音频、基准测试录音和本地诊断日志。

安装包只携带语音协调代码、下载器、协议、UI 和固定依赖清单。打包检查必须扫描大模型常见扩展名、语音运行时目录和超大文件，发现后阻止发布。

## 15. 实施阶段

### 阶段一：存储与协议

增加语音设置、路径继承、模型注册表、状态协议、错误码和功能开关。

### 阶段二：下载与模型管理

完成自定义目录、首次使用弹窗、ModelScope 下载、进度、续传、检测、修复、迁移和卸载。

### 阶段三：独立推理服务

完成 CUDA/CPU 选择、模型生命周期、VAD、10 秒静默关闭、临时和最终结果协议。

### 阶段四：全局目标适配

完成标准输入框、contenteditable、iframe、动态节点、组合文本和撤销协议。

### 阶段五：页面接入

覆盖普通画布、智能画布、GPT、素材库、OpenShop、3D 导演台和其他自然语言输入位置。

### 阶段六：真实模型与安装包验收

使用真实 Fun-ASR-Nano-2512 完成 CUDA/CPU、语言、下载、性能、故障和打包测试。

## 16. 测试策略

### 16.1 自动测试

- Python 单元测试使用假模型和临时目录，不在 CI 下载权重。
- 协议测试覆盖状态机、幂等任务、序列号、断线和错误码。
- 下载测试覆盖取消、续传、损坏文件、空间不足和原子激活。
- 路径测试覆盖继承、自定义、手动模型、迁移和外部目录保护。
- 前端单元测试覆盖目标识别、排除规则、组合文本、光标、选区和撤销。
- Playwright 使用虚拟麦克风音频验证临时结果、最终结果、快捷键和 10 秒静默关闭。
- iframe 测试覆盖主壳、普通画布、智能画布和 OpenShop 嵌套路由。
- 页面覆盖扫描防止新增自然语言文本框漏接共享适配器。
- 回归运行 HstarA 现有 Node、Python、OpenShop Vitest 和 Playwright 测试。

### 16.2 真实模型测试

真实测试只在用户语音目录安装模型，不写入仓库。至少验证：

- CUDA 正常推理。
- CPU 回退推理。
- 中文、英语、日语及中英混合输入。
- 标点、ITN、连续句子和 10 秒静默关闭。
- 多次会话复用模型，不重复加载。
- 冷启动、保温启动、实时系数、CPU、内存和显存。
- 模型损坏、移动、服务崩溃和显存不足恢复。

### 16.3 打包测试

- 扫描 Git 暂存区和安装包内容，禁止模型、运行环境、缓存和录音进入。
- 在没有模型的全新 Windows 11 环境启动 HstarA，其他功能必须正常。
- 首次下载后无需重装软件即可使用。
- 删除语音数据目录后，HstarA 仍可正常启动并进入“未安装”状态。

## 17. 验收标准

完成标准如下：

1. 任意合格自然语言文本框均可通过麦克风或 `Shift+Q` 启动实时听写。
2. 临时结果不重复，最终文字写入准确位置并可撤销。
3. 连续 10 秒无有效语音自动提交并关闭。
4. 页面切换、画布缩放、节点移动和 iframe 嵌套不导致入口错位或写错目标。
5. 模型未安装、功能关闭或服务故障时，HstarA 其余功能不受影响。
6. CUDA 可用时自动加速，不可用时 CPU 可以完成识别。
7. 官方下载、手动模型目录和目录迁移三条路径均可用。
8. 冷加载不阻塞主界面，保温模型在 500ms 内进入可接收音频状态。
9. 原始录音不落盘，不进行未经同意的云端传输。
10. 模型、可选运行时、缓存和本地日志不进入最终安装包。
11. 5000 端口稳定软件及其数据保持不变。
