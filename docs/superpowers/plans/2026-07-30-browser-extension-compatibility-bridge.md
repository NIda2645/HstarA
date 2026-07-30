# Hstar 浏览器插件兼容桥 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不修改 Chrome 商店插件 `ajfhnbklbmpfaaookhfakohabnpmlcic` 的前提下，让 HstarA 稳定支持插件协议，并对未来保持同一协议族的增量字段自动兼容。

**Architecture:** 用独立的 `browser_extension_bridge.py` 持有插件身份、路由、Schema、限额、批量响应和存储适配；用 `hstar_runtime/remote_media.py` 提供从 OpenShop 安全下载器抽出的通用流式远程媒体下载。 `main.py` 只负责应用挂载、桌面壳会话边界和把现有 Hstar 素材/分类能力注入桥接服务。工程版和发行版共享代码，分别使用 `127.0.0.1:3000` 与 `127.0.0.1:5000`，不做代理。

**Tech Stack:** Python 3.11 packaged runtime、FastAPI/Starlette、Pydantic-compatible request handling、`unittest`/pytest、Node `node:test`、PowerShell stage validation、Windows 11 isolated package smoke。

---

## File Map

| File | Responsibility |
|---|---|
| `browser_extension_bridge.py` | 固定插件 ID/Origin、路由策略、请求解析、资源限制、批量导入编排、稳定响应与桥接 CORS 辅助。 |
| `hstar_runtime/remote_media.py` | 无代理、DNS 固定、重定向复验、流式写入、字节/超时限制和临时文件清理。 |
| `main.py` | 挂载桥接路由和中间件；注入 `public_api_providers`、当前素材根、文件元数据和分类能力；由现有 `storage_mutation_barrier` 中间件独占写入租约；删除重复的桥接路由实现。 |
| `tests/test_browser_extension_bridge.py` | 桥接 Origin、Host、环回、方法、CORS、Schema、批量/存储语义的 Python 契约。保留并扩展现有未提交测试，不覆盖其他用户修改。 |
| `tests/test_browser_extension_bridge_contract.py` | 独立模块的固定身份、前向兼容 Schema、集中限额和响应语义单元契约。 |
| `tests/test_browser_extension_import_pipeline.py` | 临时数据根上的逐项原子提交、部分成功、分类隔离、并发和清理契约。 |
| `tests/test_browser_extension_security.py` | SSRF、路径、磁盘、日志、队列、单租约及桥接错误状态安全契约。 |
| `tests/test_remote_media.py` | 远程下载器的 URL、DNS、重定向、流式上限、临时文件清理和错误分类测试。 |
| `tools/tests/browser-extension-bridge-contract.test.mjs` | 新增 HstarA 后端与发布边界契约；不依赖或覆盖本地 `1.0.2` 开发插件测试。 |
| `tools/tests/windows11-stage-contract.test.mjs` | 断言发行版验证脚本包含插件身份、两个桥接路由和隔离导入验证。 |
| `tools/validate-windows11-package.ps1` | 在隔离端口和隔离数据根中执行带固定 Origin 的 providers/import POST。 |
| `build/scripts/Test-HstarWindows11Stage.ps1` | 断言桥接模块及其运行时依赖进入 Windows 11 stage。 |
| `docs/validation/2026-07-30-browser-extension-compatibility-validation.md` | 记录实际工程版、隔离发行版、保护稳定版和测试结果。 |
| `tools/chrome-local-asset-importer/*` | 仅按任务 7 的差异审查退役旧 `1.0.2` 连接逻辑；不作为新实现的运行时依赖。 |

现有 `main.py`、桌面壳和静态页面有大量未提交改动。每个任务开始前执行 `git status --short`；只暂存本任务列出的文件，不使用 `git reset`、`git checkout` 或覆盖式复制。

对于任务开始前已经修改且混有其他功能的文件，禁止直接执行整文件 `git add`。先保存该文件的基线 diff，任务完成后仅把本任务可明确归属的 hunks 写入 index 并用 `git diff --cached --check`、`git diff --cached --name-only` 复核；若新旧 hunks 无法安全分离，则保持该混合文件 unstaged，并在任务记录中说明，而不是把用户原改动吸收到本任务提交。下面每个 `git add` 命令都受此规则约束。

## Task 1: 建立桥接策略与请求契约红灯

**Files:**
- Modify: `tests/test_browser_extension_bridge.py`
- Create: `tests/test_browser_extension_bridge_contract.py`
- Create: `browser_extension_bridge.py`

- [ ] **Step 1: 记录当前工作区边界**

Run:

~~~powershell
git status --short
git diff -- main.py tests/test_browser_extension_bridge.py
~~~

Expected: 只确认现有工作区状态；不修改或暂存 `main.py` 以外的用户改动。

- [ ] **Step 2: 写固定身份和路由的红灯测试**

在 `tests/test_browser_extension_bridge_contract.py` 写入以下最小契约：

~~~python
import unittest
from starlette.requests import Request

from browser_extension_bridge import (
    EXTENSION_ORIGIN,
    bridge_request_allowed,
    parse_import_request,
)


def make_request(path, method="GET", origin=EXTENSION_ORIGIN, client="127.0.0.1"):
    return Request({
        "type": "http",
        "method": method,
        "path": path,
        "scheme": "http",
        "query_string": b"",
        "server": ("127.0.0.1", 3000),
        "client": (client, 51000),
        "headers": [
            (b"host", b"127.0.0.1:3000"),
            (b"origin", origin.encode("ascii")),
        ],
    })


class BridgeContractTests(unittest.TestCase):
    def test_only_fixed_extension_identity_and_two_routes_are_allowed(self):
        self.assertTrue(bridge_request_allowed(make_request("/api/providers")))
        self.assertTrue(bridge_request_allowed(
            make_request("/api/local-assets/import-urls", method="POST")
        ))
        self.assertFalse(bridge_request_allowed(make_request("/api/software-settings")))
        self.assertFalse(bridge_request_allowed(
            make_request("/api/providers", origin="chrome-extension://other-id")
        ))
        self.assertFalse(bridge_request_allowed(
            make_request("/api/providers", client="192.168.1.20")
        ))
        wrong_host = make_request("/api/providers")
        wrong_host.scope["headers"] = [
            (b"host", b"192.168.1.10:3000"),
            (b"origin", EXTENSION_ORIGIN.encode("ascii")),
        ]
        self.assertFalse(bridge_request_allowed(wrong_host))

    def test_additive_fields_are_ignored_but_source_semantics_are_required(self):
        payload = parse_import_request({
            "folder": "网页采集",
            "items": [{"url": "https://example.com/a.png", "future": {"v": 1}}],
            "future_option": True,
        })
        self.assertEqual(payload.items[0].url, "https://example.com/a.png")
        with self.assertRaises(ValueError):
            parse_import_request({"items": [{}]})


if __name__ == "__main__":
    unittest.main()
~~~

- [ ] **Step 3: Run红灯测试**

Run:

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_browser_extension_bridge_contract -v
~~~

Expected: FAIL because `browser_extension_bridge.py` and its policy/parser functions do not yet exist.

- [ ] **Step 4: 定义最小公开常量和纯函数接口**

在 `browser_extension_bridge.py` 先实现无 I/O 的接口，保持以下名称和签名，供后续任务复用：

~~~python
from dataclasses import dataclass
from ipaddress import ip_address
from typing import Sequence
from urllib.parse import urlsplit

EXTENSION_ID = "ajfhnbklbmpfaaookhfakohabnpmlcic"
EXTENSION_ORIGIN = f"chrome-extension://{EXTENSION_ID}"
BRIDGE_ROUTES = frozenset({
    ("GET", "/api/providers"),
    ("POST", "/api/local-assets/import-urls"),
})


@dataclass(frozen=True)
class BridgeImportItem:
    url: str = ""
    name: str = ""
    data: str = ""
    content_type: str = ""


@dataclass(frozen=True)
class BridgeImportRequest:
    folder: str
    classify: bool
    provider: str
    model: str
    prompt: str
    items: Sequence[BridgeImportItem]


def _loopback_host(value: str) -> bool:
    if value.lower() == "localhost":
        return True
    try:
        return ip_address(value).is_loopback
    except ValueError:
        return False


def bridge_request_allowed(request) -> bool:
    client_host = str(getattr(request.client, "host", "") or "")
    parsed_host = urlsplit(f"//{request.headers.get('host', '')}").hostname or ""
    method = request.method.upper()
    if method == "OPTIONS":
        method = request.headers.get("access-control-request-method", "").upper()
    return (
        _loopback_host(client_host)
        and _loopback_host(parsed_host)
        and request.headers.get("origin", "") == EXTENSION_ORIGIN
        and (method, request.url.path) in BRIDGE_ROUTES
    )


def _text(raw: dict, key: str, default: str) -> str:
    value = raw.get(key, default)
    if not isinstance(value, str):
        raise ValueError(f"{key} must be a string")
    return value


def parse_import_request(raw: dict) -> BridgeImportRequest:
    if not isinstance(raw, dict) or not isinstance(raw.get("items"), list):
        raise ValueError("items must be an array")
    classify = raw.get("classify", False)
    if not isinstance(classify, bool):
        raise ValueError("classify must be a boolean")
    items = tuple(
        BridgeImportItem(
            url=_text(item, "url", ""),
            name=_text(item, "name", ""),
            data=_text(item, "data", ""),
            content_type=_text(item, "content_type", ""),
        )
        for item in raw["items"]
        if isinstance(item, dict)
    )
    if len(items) != len(raw["items"]) or any(not (item.data or item.url) for item in items):
        raise ValueError("every item must contain data or url")
    return BridgeImportRequest(
        folder=_text(raw, "folder", "网页采集"),
        classify=classify,
        provider=_text(raw, "provider", "comfly"),
        model=_text(raw, "model", ""),
        prompt=_text(raw, "prompt", ""),
        items=items,
    )
~~~

`bridge_request_allowed` 必须验证 IPv4/IPv6 环回客户端、环回 Host、固定 Origin、HTTP 方法和路径；OPTIONS 使用 `access-control-request-method`。解析器不能把 dict/list/number 静默变成字符串。Host 只允许 `localhost`、`127.0.0.1`、`[::1]` 及其当前端口形式。

- [ ] **Step 5: 运行并提交策略契约**

Run:

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_browser_extension_bridge_contract tests.test_browser_extension_bridge -v
git diff --check
git add tests/test_browser_extension_bridge.py tests/test_browser_extension_bridge_contract.py browser_extension_bridge.py
git commit -m "test: define browser extension bridge contract"
~~~

Expected: policy/parser tests pass；现有 shell-session 测试不变；commit 只包含上列文件。

## Task 2: 抽取安全远程媒体下载器

**Files:**
- Create: `tests/test_remote_media.py`
- Create: `hstar_runtime/remote_media.py`
- Modify: `main.py`（仅在兼容测试通过后替换现有 OpenShop 远程下载重复实现）

- [ ] **Step 1: 写下载器红灯测试**

测试必须覆盖以下函数契约和结果结构：

~~~python
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from hstar_runtime.remote_media import (
    RemoteMediaLimits,
    RemoteMediaError,
    download_remote_media,
)


class RemoteMediaTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self._temp = TemporaryDirectory()
        self.temp_dir = self._temp.name

    async def asyncTearDown(self):
        self._temp.cleanup()

    async def test_private_dns_result_is_rejected_before_connect(self):
        with self.assertRaises(RemoteMediaError) as context:
            await download_remote_media(
                "https://media.example/a.png",
                Path(self.temp_dir),
                RemoteMediaLimits(max_bytes=1024),
                resolve_host=lambda *_: ["127.0.0.1"],
            )
        self.assertEqual(context.exception.code, "unsafe_address")

    async def test_redirect_to_private_address_is_revalidated(self):
        with self.assertRaises(RemoteMediaError) as context:
            await download_remote_media(
                "https://media.example/a.png",
                Path(self.temp_dir),
                RemoteMediaLimits(max_bytes=1024),
                fake_responses=[(302, {"location": "http://127.0.0.1/private"}, b"")],
            )
        self.assertEqual(context.exception.code, "unsafe_address")

    async def test_streaming_limit_removes_request_temp_file(self):
        with self.assertRaises(RemoteMediaError) as context:
            await download_remote_media(
                "https://media.example/a.png",
                Path(self.temp_dir),
                RemoteMediaLimits(max_bytes=4),
                fake_responses=[(200, {"content-type": "image/png"}, b"12345")],
            )
        self.assertEqual(context.exception.code, "too_large")
        self.assertEqual(list(Path(self.temp_dir).iterdir()), [])
~~~

测试夹具必须替换 DNS、socket/HTTP 响应，不访问公网，不使用稳定安装版路径。

- [ ] **Step 2: Run红灯测试**

Run:

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_remote_media -v
~~~

Expected: FAIL because `hstar_runtime.remote_media` is absent。

- [ ] **Step 3: 实现下载器公开类型和错误代码**

在 `hstar_runtime/remote_media.py` 写入并保持以下接口：

~~~python
from dataclasses import dataclass
from pathlib import Path


@dataclass(frozen=True)
class RemoteMediaLimits:
    max_bytes: int
    max_redirects: int = 3
    max_address_attempts: int = 2
    dns_timeout_seconds: float = 3.0
    connect_timeout_seconds: float = 20.0
    idle_timeout_seconds: float = 30.0
    total_timeout_seconds: float = 600.0


class RemoteMediaError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
        self.message = message


@dataclass(frozen=True)
class DownloadedMedia:
    path: Path
    content_type: str
    byte_count: int
    source_name: str


async def download_remote_media(
    url: str,
    temp_root: Path,
    limits: RemoteMediaLimits,
    *,
    content_limit=None,
    consume_bytes=None,
    resolve_host=None,
    fake_responses=None,
) -> DownloadedMedia:
    """Validate every hop, stream to a request-owned temp file, and return only on a bounded download."""
~~~

生产路径不得使用 `fake_responses`；该参数只供确定性测试注入。实现从当前 `_validate_openshop_art_font_remote_url`、`_open_openshop_art_font_pinned_connection` 和 `_fetch_openshop_art_font_pinned_hop` 提取并参数化，拒绝 userinfo、非 HTTP(S)、非全局地址、错误端口和超过 3 次重定向；每次 DNS 结果重新 pin；单主机最多尝试两个已验证地址；HTTPS 连接到 pinned IP 但仍使用原 hostname 完成 SNI/证书校验并发送原 Host。读取响应头后调用 `content_limit(content_type, source_name)` 得到该素材的 64 MiB 图片或 2 GiB 视频上限，与 `limits.max_bytes` 取较小值；未知类型按 64 MiB 限制并在落盘后交给魔数/容器头验证。每次 64 KiB 分块在写入前调用 `consume_bytes(len(chunk))`，无回调时跳过；`Content-Length` 和实际流量都使用同一有效上限。总时限由单一 monotonic deadline 覆盖 DNS、连接、重定向和读取，失败在 `finally` 中只删除本请求 temp path。测试记录每一跳、地址尝试次数和回调累计值，证明没有应用级重试或重复写入。

- [ ] **Step 4: 保持 OpenShop 行为并接入通用实现**

将现有 `main.py` 中 OpenShop 艺术字体下载函数的安全策略迁移到 `remote_media.py`，保留 OpenShop 的错误文本和专用上限映射。OpenShop 测试必须继续通过：

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_openshop_art_font_patch tests.test_qzz_art_font_reference -v
~~~

只有上述测试通过后，删除重复实现；不要在同一提交中改动 OpenShop 业务逻辑。

- [ ] **Step 5: 运行下载器与相邻测试并提交**

Run:

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_remote_media tests.test_openshop_art_font_patch tests.test_qzz_art_font_reference -v
git diff --check
git add hstar_runtime/remote_media.py tests/test_remote_media.py main.py
git commit -m "refactor: add bounded remote media downloader"
~~~

Expected: all listed tests pass；只提交通用下载器、其测试和经过测试的 OpenShop 提取。

## Task 3: 完成宽进严出的插件解析和资源限额

**Files:**
- Modify: `browser_extension_bridge.py`
- Modify: `tests/test_browser_extension_bridge_contract.py`

- [ ] **Step 1: 写解析、限额和响应红灯测试**

覆盖：默认值、顶层/单项未知字段、`data` 优先、200 项上限、256 MiB 请求体、64 MiB 单项内联、192 MiB 整批内联、8 GiB 远程批次预算、空批次、缺失来源、非字符串字段、`result.ok` 的部分成功/全部失败语义。

~~~python
def test_limits_are_centralized(self):
    limits = bridge_limits()
    self.assertEqual(limits.max_items, 200)
    self.assertEqual(limits.max_request_bytes, 256 * 1024 * 1024)
    self.assertEqual(limits.max_inline_item_bytes, 64 * 1024 * 1024)


def test_partial_success_is_ok_but_all_item_failure_is_not(self):
    self.assertTrue(build_import_response([{"ok": True}, {"ok": False}])["ok"])
    self.assertFalse(build_import_response([{"ok": False}])["ok"])
~~~

- [ ] **Step 2: 实现固定限额和解析结果类型**

在 `browser_extension_bridge.py` 增加：

~~~python
ERROR_STATUS = {
    "extension_forbidden": 403,
    "extension_route_forbidden": 403,
    "invalid_import_request": 400,
    "import_limit_exceeded": 413,
    "storage_switch_in_progress": 409,
    "bridge_busy": 429,
    "storage_unavailable": 503,
}

ITEM_ERROR_CODES = frozenset({
    "unsafe_url", "dns_failed", "remote_timeout",
    "remote_http_error", "unsupported_media", "item_too_large",
    "invalid_base64", "insufficient_storage", "commit_failed",
})


class BridgeRequestError(Exception):
    def __init__(self, code: str, public_message: str, status_code: int | None = None):
        super().__init__(public_message)
        self.code = code
        self.public_message = public_message
        self.status_code = status_code or ERROR_STATUS[code]


class BridgeItemError(Exception):
    def __init__(self, code: str, public_message: str):
        if code not in ITEM_ERROR_CODES:
            raise ValueError(f"unknown bridge item error: {code}")
        super().__init__(public_message)
        self.code = code
        self.public_message = public_message


@dataclass(frozen=True)
class BridgeLimits:
    max_items: int = 200
    max_request_bytes: int = 256 * 1024 * 1024
    max_inline_item_bytes: int = 64 * 1024 * 1024
    max_inline_batch_bytes: int = 192 * 1024 * 1024
    max_remote_image_bytes: int = 64 * 1024 * 1024
    max_remote_video_bytes: int = 2 * 1024 * 1024 * 1024
    max_remote_batch_bytes: int = 8 * 1024 * 1024 * 1024
    batch_workers: int = 2
    batch_queue_capacity: int = 8
    download_workers: int = 4
    download_queue_capacity: int = 400
    classify_workers: int = 2
    classify_queue_capacity: int = 400


def bridge_limits() -> BridgeLimits:
    return BridgeLimits()


def build_import_response(results: list[dict]) -> dict:
    succeeded = [item for item in results if item.get("ok")]
    return {
        "ok": bool(succeeded),
        "count": len(succeeded),
        "files": [item["file"] for item in succeeded if item.get("file")],
        "items": results,
    }
~~~

解析器对已知字段执行显式类型检查，未知字段忽略；默认 `folder="网页采集"`、`classify=False`、`provider="comfly"`，并限制 folder/name 的长度和路径字符。Task 1 的临时 `ValueError` 在本任务统一转换为 `BridgeRequestError`。空批次、缺失来源、请求/项目数/内联字节超限在任何写入前抛出 `invalid_import_request` 或 `import_limit_exceeded`。内联 Base64 先根据编码长度计算解码上界，再采用有上限的解码；不得为了判断 64/192 MiB 上限先完整复制一份超大字节串。

- [ ] **Step 3: 运行并提交解析契约**

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_browser_extension_bridge_contract -v
git diff --check
git add browser_extension_bridge.py tests/test_browser_extension_bridge_contract.py
git commit -m "feat: add version-tolerant bridge request limits"
~~~

## Task 4: 将桥接路由接入 FastAPI、桌面会话和精确 CORS

**Files:**
- Modify: `browser_extension_bridge.py`
- Modify: `main.py`
- Modify: `tests/test_browser_extension_bridge.py`
- Modify: `tests/test_shell_session.py` only if an existing assertion needs the new route owner

- [ ] **Step 1: 写 ASGI 端到端红灯测试**

使用 `httpx.ASGITransport(app=main.app, client=("127.0.0.1", port))`，不启动真实服务。测试：

~~~python
async def test_extension_preflight_returns_exact_origin(self):
    response = await client.options(
        "/api/local-assets/import-urls",
        headers={
            "Origin": main.EXTENSION_ORIGIN,
            "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "content-type",
        },
    )
    assert response.status_code == 200
    assert response.headers["access-control-allow-origin"] == main.EXTENSION_ORIGIN
    assert response.headers["vary"] == "Origin"


async def test_wrong_extension_origin_does_not_receive_bridge_cors(self):
    response = await client.get(
        "/api/providers",
        headers={"Origin": "chrome-extension://not-the-store-id"},
    )
    assert response.status_code in {401, 403}
    assert "access-control-allow-origin" not in response.headers
~~~

另测 `SHELL_TOKEN` 存在时，固定插件 Origin 可以访问两个桥接路由，但 `/api/software-settings` 返回 `403 extension_route_forbidden`；正常 Hstar 同源带 shell 令牌访问不受影响。

补充错误分层：伪造插件 ID 请求 providers 返回 `403 extension_forbidden` 且无 CORS；固定插件 ID 请求 `/api/software-settings` 或以错误方法请求导入路由返回 `403 extension_route_forbidden`；不带插件 Origin、持有效 shell 会话的 Hstar 页面请求 `/api/providers` 和 `/api/local-assets/import-urls` 仍得到原有响应，证明没有把内部页面误判为插件。

再加入请求体前置限流测试：伪造 `Content-Length > 256 MiB` 时不得调用 `request.json()`；无 `Content-Length` 或分块请求必须通过 `receive()` 逐块累计，达到 256 MiB 后立即返回 `413 import_limit_exceeded`，不得把超限 JSON 全部缓存在内存。

`GET /api/providers` 的 ASGI 测试注入一个含 `api_key`、`base_url` 和公开模型字段的内部 provider，断言响应保留插件需要的公开字段但不含 API Key、桌面壳令牌、存储根或其他秘密。POST 的 `Content-Type` 不是 `application/json` 时在读取正文前返回 `415 invalid_import_request`。

- [ ] **Step 2: 定义服务注入和路由挂载接口**

在 `browser_extension_bridge.py` 定义：

~~~python
@dataclass(frozen=True)
class BridgeRouterServices:
    list_providers: Callable[[], list[dict]]
    import_assets: Callable[[BridgeImportRequest], Awaitable[dict]]


def create_browser_extension_router(services: BridgeRouterServices) -> APIRouter:
    router = APIRouter()

    @router.get("/api/providers")
    async def providers(request: Request):
        providers = services.list_providers()
        if is_browser_extension_attempt(request):
            require_browser_extension_request(request)
            providers = redact_bridge_providers(providers)
        return {"providers": providers}

    @router.post("/api/local-assets/import-urls")
    async def import_urls(request: Request):
        if is_browser_extension_attempt(request):
            require_browser_extension_request(request)
        require_json_content_type(request)
        payload = await read_bounded_json(request, bridge_limits().max_request_bytes)
        return await services.import_assets(parse_import_request(payload))

    return router
~~~

同一任务完整实现 `is_browser_extension_attempt`、`bridge_request_error_code`、`require_browser_extension_request`、`require_json_content_type`、`redact_bridge_providers`、`read_bounded_json`。`is_browser_extension_attempt` 仅在 Origin 以 `chrome-extension://` 开头时为真，因此不会把 Hstar 同源页面误判为插件；`bridge_request_error_code` 先检查环回 client、Host 和固定 Origin，失败返回 `extension_forbidden`，身份正确但路径/方法不在白名单时返回 `extension_route_forbidden`，全部通过返回空字符串。`bridge_request_allowed` 仅包装为 `not bridge_request_error_code(request)`。`require_browser_extension_request` 不依赖浏览器 CORS，根据该结果抛对应 `BridgeRequestError`。`redact_bridge_providers` 只复制插件实际读取的 `id`、`name`、`enabled`、`chat_models`，不透传 `api_key`、`base_url`、`key_preview`、`key_env` 或平台私密扩展字段。`read_bounded_json` 先校验 `Content-Length`，再逐个 ASGI body chunk 累加到 `bytearray`，超过 256 MiB 立即抛 `import_limit_exceeded`，最后用 `json.loads(bytes(body))` 解析；禁止调用 `request.json()` 或在上限检查前额外复制正文。

在 `main.py` 注册唯一异常投影；`require_json_content_type` 用相同 `invalid_import_request` 代码但显式状态 `415`：

~~~python
@app.exception_handler(BridgeRequestError)
async def browser_extension_error_handler(_request, error):
    return JSONResponse(
        status_code=error.status_code,
        content={"ok": False, "error_code": error.code, "error": error.public_message},
    )


def require_json_content_type(request: Request):
    media_type = request.headers.get("content-type", "").split(";", 1)[0].strip().lower()
    if media_type != "application/json":
        raise BridgeRequestError(
            "invalid_import_request",
            "请求必须使用 application/json",
            status_code=415,
        )
~~~

实际实现可使用当前 FastAPI 依赖注入方式，但必须保持两个桥接路由唯一注册。POST 路由不能声明 `payload: dict` 让 FastAPI 自动无限制解析。删除 `main.py` 当前的 `GET /api/providers` 和 `POST /api/local-assets/import-urls` 两个重复 handler 后 include 该 router；`PUT /api/providers` 和其他 provider API 保持原路由。两个新 handler 都保留 Hstar 同源调用：只有检测到浏览器扩展 Origin 时才施加插件身份和 provider 脱敏投影，其余请求继续依赖现有 shell 会话并维持当前响应语义。

- [ ] **Step 3: 加入桥接 CORS 中间件并保留桌面壳鉴权**

将当前 `is_browser_extension_bridge_request` 收敛为模块的 `bridge_request_allowed`；`main.py` 的 `packaged_shell_session` 调用它，仅对精确插件请求跳过 shell cookie，随后正式路由仍会再次执行 `require_browser_extension_request`。在 `CORSMiddleware` 外层增加专用 ASGI/HTTP 中间件，命中两个桥接路径且带任意 `chrome-extension://` Origin 时接管 CORS 和预检：

~~~python
async def browser_extension_boundary(request: Request, call_next):
    origin = request.headers.get("origin", "")
    extension_attempt = is_browser_extension_attempt(request)
    if not extension_attempt:
        return await call_next(request)

    error_code = bridge_request_error_code(request)
    if error_code:
        return JSONResponse(
            status_code=ERROR_STATUS[error_code],
            content={"ok": False, "error_code": error_code, "error": "浏览器插件请求无效"},
        )
    if request.method == "OPTIONS":
        response = Response(status_code=204)
    else:
        response = await call_next(request)
    response.headers["Access-Control-Allow-Origin"] = EXTENSION_ORIGIN
    response.headers["Access-Control-Allow-Methods"] = bridge_allow_methods(request.url.path)
    response.headers["Access-Control-Allow-Headers"] = "content-type"
    response.headers["Vary"] = merge_vary(response.headers.get("Vary"), "Origin")
    return response
~~~

`bridge_allow_methods` 对 providers 返回 `GET, OPTIONS`，对 import 返回 `POST, OPTIONS`。中间件必须在最终响应上覆盖当前全局 `*`，错误插件 Origin 的响应不得含 `Access-Control-Allow-Origin`；不带插件 Origin 的 Hstar 同源页面仍通过原 shell 会话和全局 CORS，不改变现有 `/api/providers`、智能画布素材导入和 Photoshop 工具行为。测试必须在 `SHELL_TOKEN` 为空和非空两种配置下运行，证明桥接身份校验不依赖 shell 配置。

在 `main.py` 中于现有 `storage_mutation_barrier` 注册之后注册 `browser_extension_boundary`，使其成为最外层边界：合法 `OPTIONS` 预检无需获取存储租约，伪造插件 Origin 在进入全局 `CORSMiddleware`、shell 会话和业务路由前即被拒绝；合法 POST 才调用内层存储屏障并获得一次写入租约。

- [ ] **Step 4: 运行集成测试并提交**

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_browser_extension_bridge tests.test_shell_session -v
git diff --check
git add browser_extension_bridge.py main.py tests/test_browser_extension_bridge.py tests/test_shell_session.py
git commit -m "feat: mount authenticated browser extension bridge"
~~~

## Task 5: 实现本地素材批量导入、原子提交和分类隔离

**Files:**
- Modify: `browser_extension_bridge.py`
- Modify: `main.py`
- Modify: `tests/test_browser_extension_bridge.py`
- Create: `tests/test_browser_extension_import_pipeline.py`

- [ ] **Step 1: 写临时数据根上的导入红灯测试**

通过临时目录和假的 `BridgeAssetServices` 注入测试，不读取任何真实用户数据。必须验证：

~~~python
async def test_partial_batch_keeps_success_and_reports_failure(self):
    result = await importer.import_batch(request_with_url_and_bad_url)
    self.assertTrue(result["ok"])
    self.assertEqual(result["count"], 1)
    self.assertEqual(len(result["items"]), 2)
    self.assertTrue((self.upload_root / "网页采集").exists())


async def test_invalid_target_folder_writes_nothing(self):
    with self.assertRaises(BridgeRequestError):
        await importer.import_batch(request_with_traversal_folder)
    self.assertEqual(list(self.upload_root.rglob("*")), [])


async def test_classification_failure_keeps_committed_asset(self):
    result = await importer.import_batch(valid_image_request)
    self.assertTrue(result["items"][0]["ok"])
    self.assertEqual(result["items"][0]["warning_code"], "classification_failed")
    self.assertEqual(len(list(self.upload_root.rglob("*.png"))), 1)


async def test_one_item_is_downloaded_and_classified_at_most_once(self):
    result = await importer.import_batch(valid_remote_image_request)
    self.assertTrue(result["items"][0]["ok"])
    self.assertEqual(self.download_calls, 1)
    self.assertEqual(self.classify_calls, 1)
~~~

- [ ] **Step 2: 实现服务回调和文件提交边界**

定义独立的素材领域服务，避免路由服务类型被重新定义，也避免桥接模块直接导入 `main`：

~~~python
@dataclass(frozen=True)
class BridgeAssetServices:
    active_upload_root: Callable[[], Path]
    safe_folder: Callable[[str], tuple[str, Path]]
    safe_file_stem: Callable[[str], str]
    kind_and_extension: Callable[[str, str], tuple[str | None, str]]
    build_item: Callable[[str], dict]
    classify_image: Callable[[str, str, str, str, str], Awaitable[dict | None]]
    write_classification: Callable[[str, dict], None]


class BoundedAsyncWorkerPool:
    def __init__(self, workers: int, queue_capacity: int):
        self._queue = asyncio.Queue(maxsize=queue_capacity)
        self._worker_count = workers
        self._workers = []

    def _ensure_started(self):
        if not self._workers:
            self._workers = [asyncio.create_task(self._worker()) for _ in range(self._worker_count)]

    async def submit(self, operation):
        self._ensure_started()
        future = asyncio.get_running_loop().create_future()
        try:
            self._queue.put_nowait((future, operation))
        except asyncio.QueueFull as error:
            raise BridgeRequestError("bridge_busy", "插件导入服务繁忙") from error
        try:
            return await future
        except asyncio.CancelledError:
            future.cancel()
            raise

    async def _worker(self):
        while True:
            future, operation = await self._queue.get()
            try:
                if not future.cancelled():
                    future.set_result(await operation())
            except asyncio.CancelledError:
                if not future.done():
                    future.cancel()
                raise
            except Exception as error:
                if not future.done():
                    future.set_exception(error)
            finally:
                self._queue.task_done()

    async def close(self):
        workers, self._workers = self._workers, []
        for worker in workers:
            worker.cancel()
        await asyncio.gather(*workers, return_exceptions=True)


class BridgeWorkScheduler:
    def __init__(self, limits: BridgeLimits):
        self._batches = BoundedAsyncWorkerPool(limits.batch_workers, limits.batch_queue_capacity)
        self._downloads = BoundedAsyncWorkerPool(limits.download_workers, limits.download_queue_capacity)
        self._classifications = BoundedAsyncWorkerPool(
            limits.classify_workers, limits.classify_queue_capacity
        )

    async def run_batch(self, operation):
        return await self._batches.submit(operation)

    async def run_download(self, operation):
        return await self._downloads.submit(operation)

    async def run_classification(self, operation):
        return await self._classifications.submit(operation)

    async def close(self):
        await asyncio.gather(
            self._batches.close(),
            self._downloads.close(),
            self._classifications.close(),
        )


class BridgeAssetImporter:
    def __init__(
        self,
        services: BridgeAssetServices,
        limits: BridgeLimits,
        scheduler: BridgeWorkScheduler,
    ):
        self._services = services
        self._limits = limits
        self._scheduler = scheduler

    async def import_batch(self, request: BridgeImportRequest) -> dict:
        upload_root = self._services.active_upload_root().resolve(strict=True)
        folder_rel, folder_abs = self._services.safe_folder(request.folder)
        folder_abs = folder_abs.resolve(strict=False)
        if os.path.commonpath((str(upload_root), str(folder_abs))) != str(upload_root):
            raise BridgeRequestError("invalid_import_request", "目标文件夹无效")

        remote_budget = BridgeByteBudget(self._limits.max_remote_batch_bytes)
        results = await asyncio.gather(*(
            self._import_one_result(
                index, source, request, upload_root, folder_rel, folder_abs, remote_budget
            )
            for index, source in enumerate(request.items)
        ))
        return build_import_response(results)

    async def _import_one_result(
        self, index, source, request, upload_root, folder_rel, folder_abs, remote_budget
    ):
        try:
            return await self._import_one(
                index, source, request, upload_root, folder_rel, folder_abs, remote_budget
            )
        except BridgeItemError as error:
            return {"ok": False, "index": index, "error_code": error.code, "error": error.public_message}

    async def _import_one(
        self, index, source, request, upload_root, folder_rel, folder_abs, remote_budget
    ):
        prepared = await self._scheduler.run_download(
            lambda: materialize_bridge_item(source, upload_root, self._limits, remote_budget)
        )
        try:
            kind, extension = verified_media_kind_and_extension(
                prepared.path,
                source.name,
                prepared.content_type,
                self._services.kind_and_extension,
            )
            stem = self._services.safe_file_stem(source.name or prepared.source_name or "asset")
            filename = f"up_{uuid.uuid4().hex[:12]}_{stem}{extension}"
            relative_name = f"{folder_rel}/{filename}".lstrip("/")
            destination = (folder_abs / filename).resolve(strict=False)
            if os.path.commonpath((str(upload_root), str(destination))) != str(upload_root):
                raise BridgeItemError("commit_failed", "素材目标路径无效")
            ensure_bridge_disk_reserve(upload_root, prepared.byte_count)
            folder_abs.mkdir(parents=True, exist_ok=True)
            os.replace(prepared.path, destination)
            prepared = prepared.with_committed_path(destination)
            item = self._services.build_item(relative_name)
            result = {"ok": True, "index": index, "file": relative_name, "item": item}
            if request.classify and kind == "image":
                try:
                    classification = await self._scheduler.run_classification(
                        lambda: self._services.classify_image(
                            str(destination), request.provider, request.model, "", request.prompt
                        )
                    )
                    if classification:
                        self._services.write_classification(relative_name, classification)
                except Exception:
                    result["warning_code"] = "classification_failed"
            return result
        finally:
            prepared.cleanup_if_uncommitted()
~~~

同一任务按以下状态模型定义 `BridgeByteBudget` 和 `PreparedBridgeMedia`；前者由远程下载器在每个 64 KiB chunk 写入前调用，多个并发项共享同一把锁，因此整批累计内容绝不会越过 8 GiB 后继续落盘：

~~~python
class BridgeByteBudget:
    def __init__(self, maximum: int):
        self._maximum = maximum
        self._consumed = 0
        self._lock = threading.Lock()

    def consume(self, amount: int):
        with self._lock:
            if self._consumed + amount > self._maximum:
                raise BridgeItemError("item_too_large", "批量远程素材超过大小限制")
            self._consumed += amount


@dataclass
class PreparedBridgeMedia:
    path: Path
    content_type: str
    byte_count: int
    source_name: str
    committed: bool = False

    def with_committed_path(self, path: Path):
        self.path = path
        self.committed = True
        return self

    def cleanup_if_uncommitted(self):
        if not self.committed:
            self.path.unlink(missing_ok=True)
~~~

同时定义上段引用的 `materialize_bridge_item`、`verified_media_kind_and_extension`、`ensure_bridge_disk_reserve`。`materialize_bridge_item` 对非空 `data` 做有上限的 Base64 解码，否则调用 `download_remote_media(source.url, upload_root, remote_limits, content_limit=bridge_content_limit, consume_bytes=remote_budget.consume)`；两条路径都把唯一临时文件创建在当前 `upload_root` 内，并返回 `PreparedBridgeMedia`，清理集合只包含本请求创建的路径。内联路径在解码前用 Base64 编码长度计算上界，单项超过 64 MiB 或整批超过 192 MiB 时不创建 temp；远程响应依据响应 MIME 和源文件名在读取首个 chunk 前选择 64 MiB 图片上限或 2 GiB 视频上限。`verified_media_kind_and_extension` 用图片魔数纠正 MIME/扩展名，用容器头验证视频，其他类型抛 `unsupported_media`。`ensure_bridge_disk_reserve` 在本任务实现 Task 6 指定的固定阈值。禁止在导入器内部获取存储写租约；请求中间件是唯一租约所有者。

处理顺序固定为：预检 -> 每项下载/解码到 temp -> 魔数和媒体类型检查 -> 磁盘预留检查 -> 同卷 `os.replace` -> `_local_upload_item` -> best-effort 分类。文件路径经过 `resolve/commonpath` 后才能提交；目标文件夹延迟到第一个可提交项。分类旁车继续通过现有 `_write_local_upload_classification` 的 `atomic_write_json` 原子写入。

- [ ] **Step 3: 接入现有 Hstar 素材和分类函数**

在 `main.py` 创建 `BridgeAssetServices` 时只传入现有函数：活动 `LOCAL_UPLOAD_DIR` 解析、`_local_upload_safe_folder`、`_local_upload_safe_file_stem`、`_local_upload_kind_ext`、`_local_upload_item`、`classify_asset_image_best_effort` 和 `_write_local_upload_classification`。不得注入 `STORAGE_WRITE_BARRIER.mutation`。按以下单例关系创建调度器、导入器和路由服务，避免每个请求各建一组 worker：

~~~python
def bridge_safe_folder(value: str) -> tuple[str, Path]:
    relative, absolute = _local_upload_safe_folder(value)
    return relative, Path(absolute)


bridge_asset_services = BridgeAssetServices(
    active_upload_root=lambda: Path(LOCAL_UPLOAD_DIR),
    safe_folder=bridge_safe_folder,
    safe_file_stem=_local_upload_safe_file_stem,
    kind_and_extension=_local_upload_kind_ext,
    build_item=_local_upload_item,
    classify_image=classify_asset_image_best_effort,
    write_classification=_write_local_upload_classification,
)
bridge_limits_value = bridge_limits()
bridge_scheduler = BridgeWorkScheduler(bridge_limits_value)
bridge_importer = BridgeAssetImporter(bridge_asset_services, bridge_limits_value, bridge_scheduler)


async def import_browser_assets(request: BridgeImportRequest) -> dict:
    return await bridge_scheduler.run_batch(lambda: bridge_importer.import_batch(request))


bridge_router_services = BridgeRouterServices(
    list_providers=public_api_providers,
    import_assets=import_browser_assets,
)
app.include_router(create_browser_extension_router(bridge_router_services))
~~~

把 `await bridge_scheduler.close()` 接到应用现有 shutdown/lifespan 清理路径。分类异常被转换为 `warning_code="classification_failed"`，不得删除已经替换成功的素材。

保留当前素材文件名格式 `up_<uuid>_<safe-name>.<ext>`，保留图片魔数纠正和视频扩展名推断；文本模式不在该路由中新增导入行为。

- [ ] **Step 4: 运行管线测试并提交**

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_browser_extension_import_pipeline tests.test_browser_extension_bridge -v
git diff --check
git add browser_extension_bridge.py main.py tests/test_browser_extension_bridge.py tests/test_browser_extension_import_pipeline.py
git commit -m "feat: import browser media atomically into local assets"
~~~

## Task 6: 接入存储屏障、日志隐私和错误映射

**Files:**
- Modify: `browser_extension_bridge.py`
- Modify: `main.py`
- Modify: `tests/test_browser_extension_import_pipeline.py`
- Create: `tests/test_browser_extension_security.py`

- [ ] **Step 1: 写安全、单租约与屏障红灯测试**

素材单元测试覆盖以下输入不会创建最终文件：`file://`、`data:` URL 作为远程 URL、`127.0.0.1`、`10.0.0.0/8`、IPv6 link-local、DNS 同时返回公网和私网、重定向到私网、目录穿越 folder/name、符号链接逃逸、超限 Base64、伪造 MIME/魔数。另用 mock `shutil.disk_usage` 覆盖剩余空间不足 1 GiB 或卷容量 5% 的两种拒绝条件。

在 `tests/test_browser_extension_security.py` 通过 ASGI 请求证明存储租约只有中间件获取一次：

~~~python
class CountingMutation:
    def __init__(self):
        self.entries = 0

    @contextmanager
    def mutation(self):
        self.entries += 1
        yield


async def test_bridge_post_acquires_exactly_one_storage_mutation_lease(self):
    barrier = CountingMutation()
    with patch.object(main, "STORAGE_WRITE_BARRIER", barrier):
        response = await bridge_client.post(
            "/api/local-assets/import-urls",
            headers={"Origin": main.EXTENSION_ORIGIN},
            json=valid_inline_request,
        )
    self.assertEqual(response.status_code, 200)
    self.assertEqual(barrier.entries, 1)


async def test_storage_switch_uses_bridge_409_but_preserves_regular_api_503(self):
    barrier = Mock()
    barrier.mutation.side_effect = StorageMutationBlocked("switching")
    with patch.object(main, "STORAGE_WRITE_BARRIER", barrier):
        bridge = await bridge_client.post(
            "/api/local-assets/import-urls",
            headers={"Origin": main.EXTENSION_ORIGIN},
            json=valid_inline_request,
        )
        regular = await shell_client.post(
            "/api/local-assets/folders", json={"parent": "", "name": "blocked"}
        )
    self.assertEqual(bridge.status_code, 409)
    self.assertEqual(bridge.json()["error_code"], "storage_switch_in_progress")
    self.assertEqual(regular.status_code, 503)
    self.assertEqual(regular.json()["detail"]["code"], "STORAGE_SWITCHING")
~~~

再用容量为零的测试调度器或填满 `batch_queue_capacity`，断言新批次在任何写入前返回 `429 bridge_busy`。捕获桥接日志并断言不包含完整 URL、`data:`、Base64、API Key、完整本地路径和分类提示词。

- [ ] **Step 2: 实现屏障与错误归一化**

沿用 Task 3 唯一定义的 `ERROR_STATUS`、`ITEM_ERROR_CODES`、`BridgeRequestError` 和 `BridgeItemError`，不得在本任务重新声明同名类型或改写代码语义。为每个请求级代码增加 ASGI 状态断言，并为每个单项代码增加 HTTP `200`、原请求顺序和 `items[index]` 断言。

现有 `storage_mutation_barrier` 中间件是唯一存储租约所有者。只对 `POST /api/local-assets/import-urls` 的 `StorageMutationBlocked` 改写为桥接错误，其他写 API 保持当前 `503` 行为：

~~~python
except StorageMutationBlocked as error:
    if request.method == "POST" and request.url.path == "/api/local-assets/import-urls":
        return JSONResponse(
            status_code=409,
            headers={"Retry-After": "1"},
            content={
                "ok": False,
                "error_code": "storage_switch_in_progress",
                "error": "存储位置正在切换，请稍后重试",
            },
        )
    code = "STORAGE_SWITCHING" if error.reason == "switching" else "STORAGE_RESTART_REQUIRED"
    return JSONResponse(
        status_code=503,
        headers={"Retry-After": "1"},
        content={"detail": {"code": code, "message": str(error)}},
    )
~~~

导入器不得调用 `STORAGE_WRITE_BARRIER`，也不得接受 mutation callback。Task 5 的 `BridgeWorkScheduler` 固定两个批次 worker、8 个等待批次、4 个全局下载 worker、2 个全局分类 worker；两个活动批次最多产生 `2 * 200 = 400` 个下载或分类操作，因此操作队列容量固定为 400，不会对已经接纳的合法批次产生二次 `bridge_busy`。批次队列满时在有界正文和 Schema 解析完成后、任何文件创建前返回 `429`，不使用无限任务列表或隐藏重试。

`ensure_bridge_disk_reserve` 使用 `shutil.disk_usage(upload_root)`，计算 `reserve = max(1024 ** 3, int(total * 0.05))`，并在 `free - incoming_bytes < reserve` 时抛 `BridgeItemError("insufficient_storage", "存储空间不足")`。每个素材提交前重新检查，整批累计远程落盘字节超过 8 GiB 时，尚未提交的项返回 `item_too_large`。取消请求或应用关闭时，调度器取消 worker，所有已取得的 request-owned temp path 仍走 `finally` 清理。

- [ ] **Step 3: 运行安全测试并提交**

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_browser_extension_security tests.test_storage_barrier tests.test_storage_migration_api -v
git diff --check
git add browser_extension_bridge.py main.py tests/test_browser_extension_import_pipeline.py tests/test_browser_extension_security.py
git commit -m "feat: harden browser bridge storage and error boundaries"
~~~

## Task 7: 隔离本地 `1.0.2` 开发工具而不覆盖用户改动

**Files:**
- Read-only audit: `tools/chrome-local-asset-importer/hstar-connection.js`, `tools/tests/browser-extension-connection.test.mjs`, `tools/chrome-local-asset-importer/README.md`, `tools/chrome-local-asset-importer/manifest.json`, `tools/chrome-local-asset-importer/popup.js`, `tools/chrome-local-asset-importer/popup.html`, `tools/chrome-local-asset-importer/sidepanel.html`
- Do not modify: `C:\\Users\\he927\\AppData\\Local\\Google\\Chrome\\User Data\\Default\\Extensions\\ajfhnbklbmpfaaookhfakohabnpmlcic\\1.7.0_0`

- [ ] **Step 1: 建立差异归属清单**

~~~powershell
git diff -- tools/chrome-local-asset-importer tools/tests/browser-extension-connection.test.mjs
git ls-files tools/chrome-local-asset-importer
~~~

已知归属：`hstar-connection.js`、HTML script 引用和 `popup.js` 的 `discoverHstarServer` 属于本地自动探测实验；`popup.js` 同时包含用户已要求的“批量下载多个独立原文件、不生成 ZIP”改动；README、manifest 和 UI 文案也混合了用户改动。由于该目录不会进入正式 stage，所有这些文件在本计划中保持原样，不删除、不回退、不暂存。

- [ ] **Step 2: 证明正式产品不依赖本地开发插件**

用 Task 8 新建的 `tools/tests/browser-extension-bridge-contract.test.mjs` 断言 `browser_extension_bridge.py`、`main.py`、桌面发布配置和 stage 脚本均不 import、复制或运行 `tools/chrome-local-asset-importer`；Windows stage 禁止列表排除整个目录。正式兼容路径只由固定商店插件 ID、两个后端路由和用户在插件中配置的当前端口组成，不读取本地插件版本或自动探测脚本。

- [ ] **Step 3: 记录只读审计结果**

~~~powershell
git status --short -- tools/chrome-local-asset-importer tools/tests/browser-extension-connection.test.mjs
git diff -- tools/chrome-local-asset-importer tools/tests/browser-extension-connection.test.mjs
~~~

Expected: 输出与任务开始时一致；本任务不产生提交。实际产品隔离断言随 Task 8 提交。

## Task 8: 建立 Node、stage 和发行版桥接契约

**Files:**
- Create: `tools/tests/browser-extension-bridge-contract.test.mjs`
- Modify: `tools/tests/windows11-stage-contract.test.mjs`
- Modify: `tools/tests/windows11-package-smoke-contract.test.mjs`
- Modify: `tools/validate-windows11-package.ps1`
- Modify: `build/scripts/Test-HstarWindows11Stage.ps1`

- [ ] **Step 1: 更新 Node 源码契约**

测试必须断言：固定 Store ID 出现在 `browser_extension_bridge.py`；允许路由只有 providers/import；工程默认端口为 3000、发行默认端口为 5000；旧 `1.0.2` 自动发现不在安装包入口中；没有 5000 到 3000 代理。

`tools/tests/browser-extension-bridge-contract.test.mjs` 使用以下完整断言结构：

~~~javascript
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const read = path => readFile(new URL(`../../${path}`, import.meta.url), 'utf8');
const [bridge, main, ports, stageBuilder] = await Promise.all([
  read('browser_extension_bridge.py'),
  read('main.py'),
  read('desktop/Hstar.Desktop/Runtime/PortAllocator.cs'),
  read('build/scripts/New-HstarWindows11Stage.ps1'),
]);

assert.match(bridge, /ajfhnbklbmpfaaookhfakohabnpmlcic/);
assert.match(bridge, /\("GET",\s*"\/api\/providers"\)/);
assert.match(bridge, /\("POST",\s*"\/api\/local-assets\/import-urls"\)/);
assert.doesNotMatch(bridge, /1\.7\.0|1\.8\.0/);
assert.match(main, /return\s+3000/);
assert.match(ports, /PreferredPort\s*=\s*5000/);
assert.doesNotMatch(main + stageBuilder, /chrome-local-asset-importer|hstar-connection\.js/);
assert.doesNotMatch(main + stageBuilder, /5000[^\r\n]{0,120}(?:proxy|forward|转发)[^\r\n]{0,120}3000/i);
~~~

Run:

~~~powershell
node --test tools/tests/browser-extension-bridge-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs
~~~

Expected: 在 stage 尚未重建时，新增断言可以先因模块或验证脚本未更新而失败。

- [ ] **Step 2: 增加 stage 文件和脚本契约**

`Test-HstarWindows11Stage.ps1` 的 `$requiredFiles` 增加 `app\\browser_extension_bridge.py` 与 `app\\hstar_runtime\\remote_media.py`；stage 禁止列表继续排除测试、用户数据、缓存和旧工具目录。Stage smoke 必须使用固定 Origin 发起：

~~~powershell
$extensionOrigin = 'chrome-extension://ajfhnbklbmpfaaookhfakohabnpmlcic'
$providers = Invoke-BridgeGet -Uri "$baseUrl/api/providers" -Origin $extensionOrigin
$import = Invoke-BridgePost -Uri "$baseUrl/api/local-assets/import-urls" -Origin $extensionOrigin -Data @{
    folder = 'bridge-smoke'
    classify = $false
    items = @(@{ data = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='; name = 'bridge-smoke.png'; content_type = 'image/png' })
}
if ($import.count -ne 1) { throw 'Browser bridge isolated import did not write one asset.' }
~~~

`Invoke-BridgeGet/Post` 必须在脚本内使用 `HttpRequestMessage`/`HttpClient` 设置 Origin，所有结果写到当前 `build\\generated\\windows11-package-smoke` 隔离根。

- [ ] **Step 3: 运行源码和脚本静态契约**

~~~powershell
node --test tools/tests/browser-extension-bridge-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs
~~~

Expected: Node contracts pass；PowerShell parser contract 确认 Windows PowerShell 5 可解析新增脚本。

- [ ] **Step 4: 提交发布契约**

~~~powershell
git diff --check
git add tools/tests/browser-extension-bridge-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs tools/validate-windows11-package.ps1 build/scripts/Test-HstarWindows11Stage.ps1
git commit -m "test: validate browser bridge in Windows package"
~~~

## Task 9: 运行工程版真实流程并形成验证报告

**Files:**
- Create: `docs/validation/2026-07-30-browser-extension-compatibility-validation.md`
- Do not modify stable install: `D:\\Hstar`

- [ ] **Step 1: 运行 Python 完整相关套件**

~~~powershell
.\python\python.exe -B -X utf8 -m unittest discover -s tests -p "test_*.py" -v
~~~

Expected: test process uses `-B` and does not create repository bytecode. Record exact pass/fail counts; a pre-existing unrelated failure must be identified by test name and not hidden.

- [ ] **Step 2: 运行 Node 相关套件**

~~~powershell
node --test tools/tests/browser-extension-bridge-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs tools/tests/legacy-storage-readonly-api.test.mjs
~~~

Expected: bridge, stage, package, and legacy storage contracts all pass；稳定版路径未被命令读取。

- [ ] **Step 3: 启动工程版并执行一次真实插件协议请求**

先用 `Get-NetTCPConnection -State Listen -LocalPort 3000` 检查占用。若现有进程是当前 HstarA 工程服务，则对该服务执行验证；若端口属于其他程序，记录阻塞，不停止未知进程。若端口空闲，使用隔离数据根启动本次拥有的工程进程：

~~~powershell
$root = (Resolve-Path '.').Path
$data = Join-Path $root 'tmp\browser-extension-engineering-smoke'
New-Item -ItemType Directory -Path $data -Force | Out-Null
$env:HSTAR_PROGRAM_DIR = $root
$env:HSTAR_DATA_DIR = $data
$env:HSTAR_EDITION = 'development'
$env:HSTAR_HOST = '127.0.0.1'
$env:HSTAR_PORT = '3000'
$server = Start-Process -FilePath '.\python\python.exe' `
  -ArgumentList @('-B', '-X', 'utf8', 'main.py') `
  -WorkingDirectory $root -WindowStyle Hidden -PassThru
~~~

用 .NET `HttpClient` 设置 `Origin: chrome-extension://ajfhnbklbmpfaaookhfakohabnpmlcic` 请求 `/api/providers`，再向 `/api/local-assets/import-urls` POST 一张有效的测试 PNG Data URL，`classify=false`。确认响应 `count=1`、文件位于 `$data\assets\uploads`、素材列表 API 可见、没有分类旁车和临时文件。测试完成后只停止 `$server.Id`，并在确认 `$data` 位于仓库 `tmp` 下后删除该隔离目录。

- [ ] **Step 4: 写验证报告并提交**

报告必须记录：命令、结果、工程端口、隔离数据根、桥接响应计数、临时文件清理、稳定版未触碰证据、未测试风险。

~~~powershell
git diff --check
git add docs/validation/2026-07-30-browser-extension-compatibility-validation.md
git commit -m "docs: record browser bridge engineering validation"
~~~

- [ ] **Step 5: 用已安装的 Chrome 商店 `1.7.0` 插件完成真实工作流**

确认 Chrome 扩展目录和版本只读：`ajfhnbklbmpfaaookhfakohabnpmlcic/1.7.0_0`。在本次工程服务运行期间，通过 Chrome UI 把插件服务地址设置为 `127.0.0.1:3000`，点击“连接”，确认平台列表来自 HstarA。然后在仓库 `tmp` 下创建只含一张内联 PNG 和一个短内联媒体样本的临时 HTML，并用本次拥有的隐藏本地 HTTP 进程提供页面；使用插件扫描、选择并执行“导入资产库”。

验收：插件显示连接成功；导入结果数量正确；素材出现在隔离 HstarA 数据根；插件悬浮工具菜单仍由商店插件自身提供；商店插件目录的文件哈希在测试前后不变。测试后只停止本次临时页面服务，删除已验证位于仓库 `tmp` 下的临时页面，并恢复插件原服务地址或把变更记录给用户。若 Chrome UI 无法自动操控，明确请求用户完成这一个交互步骤，不以伪造 Origin 的 HTTP 测试冒充真实插件验收。

## Task 10: 重建隔离 Windows 11 stage 并验证发布输入

**Files:**
- Generated and ignored: `build/installer/stage/windows11/**`
- Generated and ignored: `build/generated/windows11-package-smoke/**`
- Read-only validation: `build/scripts/Test-HstarWindows11Stage.ps1`

- [ ] **Step 1: 从当前源码重建 stage**

使用仓库实际存在的 `build/scripts/New-HstarWindows11Stage.ps1` 从当前源码清空并重建 stage，不手动复制单个 Python 文件到旧 stage。先确认脚本路径：

~~~powershell
Get-ChildItem build/scripts -File
powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/New-HstarWindows11Stage.ps1
~~~

若 `git status --short` 仍包含任务开始前已存在并被保护的用户改动，则本次仅用于隔离 smoke 的 stage 命令改为追加 `-AllowDirtyForTest`，并在验证报告中记录；不得为了满足 clean gate 暂存、提交、stash 或删除这些无关改动。正式安装包发布仍必须等待用户明确打包指令并通过 clean-worktree gate。

- [ ] **Step 2: 验证 stage 资源和运行时导入**

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/Test-HstarWindows11Stage.ps1
~~~

Expected: `app\\browser_extension_bridge.py`、`app\\hstar_runtime\\remote_media.py`、FastAPI、httpx 和现有桌面依赖均在 stage；不包含测试、缓存、用户资产或旧工具目录。

- [ ] **Step 3: 运行隔离 packaged smoke，不安装和不打包**

~~~powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/validate-windows11-package.ps1 -InstallRoot build/installer/stage/windows11 -Port 55531
~~~

Expected: 只在 `build/generated/windows11-package-smoke` 创建数据；`5000` 被明确拒绝；桥接 Origin 请求、素材导入、存储隔离和进程清理全部通过。

- [ ] **Step 3a: 验证发行版默认端口而不干扰稳定安装**

先执行：

~~~powershell
$listener = Get-NetTCPConnection -State Listen -LocalPort 5000 -ErrorAction SilentlyContinue
if ($listener) {
  Write-Host 'Port 5000 is owned; do not stop or inspect the stable Hstar process.'
} else {
  Write-Host 'Port 5000 is free for an isolated packaged bridge smoke.'
}
~~~

无论端口是否空闲，契约测试必须证明 Windows 11 桌面配置默认后端端口为 `5000`。只有端口空闲时，才用 stage、隔离数据根、`HSTAR_PORT=5000` 和本次拥有的隐藏进程重复固定 Origin providers/import smoke；完成后只停止该 PID。若端口被占用，则保留稳定版不动，在验证报告中把“真实 5000 运行验证”标为未执行，并以 `55531` package smoke 加默认配置契约作为现有证据。

- [ ] **Step 4: 运行最终静态门禁并确认没有安装包动作**

~~~powershell
node --test tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs
git status --short
~~~

Expected: generated stage/report 不进入 Git 暂存区；本计划不调用 Inno `ISCC.exe`，不生成安装包。只有收到新的明确打包指令后才执行发布。

## Task 11: 最终审计与收尾提交

**Files:**
- All files committed by Tasks 1-10 only

- [ ] **Step 1: 检查提交内容和工作区**

~~~powershell
git log --oneline -12
git diff --check HEAD~10..HEAD
git status --short
~~~

确认本次提交不包含 `D:\\Hstar`、用户数据、API Key、stage、缓存、安装包或 Chrome 商店插件目录。现有与本任务无关的工作区修改继续保留。

- [ ] **Step 2: 运行最终适用验证矩阵**

~~~powershell
.\python\python.exe -B -X utf8 -m unittest tests.test_browser_extension_bridge tests.test_browser_extension_bridge_contract tests.test_browser_extension_import_pipeline tests.test_browser_extension_security tests.test_remote_media tests.test_storage_barrier -v
node --test tools/tests/browser-extension-bridge-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs
~~~

报告必须区分“通过”“未执行”“受环境限制”，不能把源码导入通过写成完整发行版安装通过。

- [ ] **Step 3: 形成用户交付摘要**

最终回复包含：实现文件、契约与安全测试结果、工程端口与隔离发行端口验证、稳定版保护证据、是否打包（本计划阶段为否）以及剩余风险。不得声称未来插件的破坏性协议改动会自动兼容。
