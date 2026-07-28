# Hstar 内嵌式启动动画设计

**日期：** 2026-07-28
**目标工程：** HstarA
**目标版本：** 2026.07.28.2 Windows 11 x64

## 1. 目标

将 Hstar 启动动画从安装目录中的 `Assets/startup/*.html|css|js|mjs` 外部文件，转换为编译进 `Hstar.exe` 的 .NET 程序资源。启动动画仍由现有 `StartupWebView` 渲染，保留 Lightfall 动画、鼠标互动、灰金属色粗体文字、三颗星标志和居中布局。

安装完成后，启动动画不得以独立 HTML、CSS、JavaScript 或 ESM 文件出现在安装目录、用户数据目录或临时目录中。

## 2. 不在范围

- 不将 Hstar 主功能页从 WebView2 迁移到 WPF。
- 不用 WPF 或 DirectX 重写 Lightfall 着色器。
- 不改动后端启动、数据目录、API 配置或画布读写逻辑。
- 不将启动资源解压到磁盘后再加载。

## 3. 程序资源

`desktop/Hstar.Desktop/Assets/startup` 继续作为可维护的源码目录，包含：

- `index.html`
- `startup.css`
- `startup.js`
- `ogl.mjs`
- `ogl.LICENSE.txt`

项目文件将这些文件标记为 `EmbeddedResource`，并禁止复制到构建和发布目录。发布后的 `Hstar.exe` 必须包含五项资源，其中 OGL 许可证必须保留在程序集中。

## 4. 加载架构

### 4.1 虚拟来源

启动 WebView 继续使用：

```text
https://hstar-startup.local/index.html
```

保留 HTTPS 形式的独立来源，以便继续校验 `WebMessageReceived.Source`，并避免 `file://` 权限和路径行为。

### 4.2 请求拦截

`MainWindow` 在 `StartupWebView.CoreWebView2` 完成初始化后：

1. 为 `https://hstar-startup.local/*` 注册 `WebResourceRequested` 过滤器。
2. 解析请求 URI，仅允许固定的资源路径。
3. 从 `Hstar.exe` 的 manifest resource stream 读取内容。
4. 通过 `CoreWebView2Environment.CreateWebResourceResponse` 直接返回内存流。
5. 不写入安装目录、`AppData`、`Hstar缓存` 或 `%TEMP%`。

### 4.3 MIME 映射

| 资源 | Content-Type |
| --- | --- |
| `.html` | `text/html; charset=utf-8` |
| `.css` | `text/css; charset=utf-8` |
| `.js` | `text/javascript; charset=utf-8` |
| `.mjs` | `text/javascript; charset=utf-8` |
| `.txt` | `text/plain; charset=utf-8` |

所有成功响应返回 `200 OK` 与 `Cache-Control: no-store`，避免启动动画版本被 WebView2 缓存固化。

## 5. 安全边界

- 仅接受 host 为 `hstar-startup.local` 的 HTTPS 请求。
- 资源路径使用大小写敏感的显式映射表，不把 URI 直接拼接为程序集资源名。
- 包含 `..`、反斜杠、编码分隔符、查询伪装或未知路径的请求返回 `404 Not Found`。
- 启动 WebView 仍使用现有受限设置，不开放外部导航或弹窗。
- `WebMessageReceived` 继续校验消息来源，只处理已有的重试和退出命令。

## 6. 生命周期与异常处理

- WebView2 环境和两个 WebView 仍并行初始化，不延迟后端启动。
- 启动资源流缺失时立即报告明确的程序资源错误，不回退到磁盘 HTML。
- 主页交互就绪后，继续使用现有 220 ms 淡出逻辑销毁 `StartupWebView`。
- 启动失败、重试、退出、关闭确认和自动重启行为保持不变。
- 窗口关闭时解除 `WebResourceRequested` 和 `WebMessageReceived` 事件，释放对资源流的引用。

## 7. 构建与安装包

- `Hstar.Desktop.csproj` 不再使用 `Content` 复制启动文件，而使用 `EmbeddedResource`。
- Windows 11 阶段构建和安装器不再需要 `Assets/startup` 目录。
- 阶段验证必须拒绝任何 `Assets/startup/*.html|css|js|mjs` 外部载荷。
- 阶段验证必须通过反射或桌面端测试确认嵌入资源存在。
- 安装器仍包含固定 WebView2 运行时，不依赖目标电脑的系统 WebView2。

## 8. 测试与验收

### 8.1 桌面单元测试

- 每个批准的 URL 映射到正确的程序集资源和 MIME 类型。
- 未知路径、错误 host、非 HTTPS 和路径穿越均被拒绝。
- 程序集包含五项启动资源。
- 资源内容仍包含 Lightfall、三颗星、灰金属文字、居中布局、重试和退出消息协议。

### 8.2 发布阶段测试

- `Hstar.exe` 使用 Windows GUI 子系统，不弹出 CMD 窗口。
- 发布阶段不存在 `Assets/startup` 外部目录。
- 打包 Python、WebView2、OpenShop、3D 导演台和语音助手契约仍全部通过。
- 源码门禁、Windows 11 阶段验证、安装器契约和安装包 SHA-256 验证全部通过。

### 8.3 人工验收

1. 双击 Hstar 后立即看到 Lightfall 启动动画。
2. 动画布局、颜色、文字、星标志和鼠标互动与当前设计一致。
3. 主功能页可操作后，启动层平滑淡出。
4. 安装目录不包含启动动画 HTML、CSS、JS 或 MJS 文件。
5. 启动失败时的重试和退出操作仍正常。

## 9. 成功标准

启动动画作为 `Hstar.exe` 内部发布资源运行，不依赖任何磁盘网页文件；当前视觉和互动不降级；主 Hstar 功能、关闭确认、数据目录向导和自动重启逻辑不变。
