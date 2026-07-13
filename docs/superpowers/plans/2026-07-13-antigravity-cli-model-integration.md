# Antigravity CLI Model Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make HstarA discover Antigravity models from the live local `agy models` command, persist independent chat/image selections, pass the exact selected model to real CLI requests, and open an interactive Antigravity terminal from API settings.

**Architecture:** Keep Antigravity process ownership in `main.py`, adding one pure output parser plus bounded asynchronous discovery and a fixed-command Windows terminal launcher. Reuse the existing model picker, but activate an Antigravity-only dual-selection mode so the same discovered model can be selected independently for chat and image generation without changing other providers' one-category behavior. Preserve per-request model isolation through the existing `agy --model <name>` argument path and add executable regression tests around both backend behavior and frontend contracts.

**Tech Stack:** Python 3.10, FastAPI, `asyncio` subprocesses, Windows PowerShell, vanilla JavaScript, HTML/CSS, Node.js built-in test/assert modules.

---

## File Map

- Modify `main.py`: parse and discover `agy models`, expose dynamic provider payloads, launch a fixed interactive terminal, enforce loopback access, and log exact per-request model selection.
- Modify `static/api-settings.html`: add the **启动** action beside **帮助**.
- Modify `static/js/api-settings.js`: call the launch endpoint and support independent Antigravity chat/image selection in the existing picker.
- Create `tools/tests/antigravity-cli-integration.test.mjs`: executable backend unit harness plus frontend/runtime source contracts.
- Verify `tools/tests/api-settings-provider-fusion.test.mjs`: ensure the existing merged API-settings behavior remains intact.

### Task 1: Dynamic Antigravity Model Discovery

**Files:**
- Modify: `main.py:5070-5235`
- Create: `tools/tests/antigravity-cli-integration.test.mjs`

- [ ] **Step 1: Write the failing parser and discovery tests**

Create `tools/tests/antigravity-cli-integration.test.mjs`. Have it run a small Python harness against `main.py` with a mocked asynchronous process:

```javascript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const mainPy = readFileSync(join(repoRoot, 'main.py'), 'utf8');
const python = join(repoRoot, 'python', 'python.exe');

const backendHarness = String.raw`
import asyncio
import json
from unittest.mock import patch
import main

sample = "\x1b[32mGemini 3.5 Flash (High)\x1b[0m\r\n\r\nClaude Sonnet 4.6 (Thinking)\r\nClaude Sonnet 4.6 (Thinking)\r\n"
assert main.gemini_cli_parse_models_output(sample) == [
    "Gemini 3.5 Flash (High)",
    "Claude Sonnet 4.6 (Thinking)",
]

class FakeProcess:
    returncode = 0
    async def communicate(self):
        return sample.encode("utf-8"), b""

async def fake_exec(*args, **kwargs):
    assert args[1:] == ("models",)
    return FakeProcess()

async def run():
    with patch.object(main, "gemini_cli_executable", return_value="agy.exe"):
        with patch.object(main.asyncio, "create_subprocess_exec", side_effect=fake_exec):
            payload = await main.discover_gemini_cli_models()
    assert payload["all"] == ["Gemini 3.5 Flash (High)", "Claude Sonnet 4.6 (Thinking)"]
    assert payload["image_models"] == payload["all"]
    assert payload["chat_models"] == payload["all"]
    assert payload["total"] == 2

asyncio.run(run())
print(json.dumps({"ok": True}))
`;

const backend = spawnSync(python, ['-c', backendHarness], {
  cwd: repoRoot,
  encoding: 'utf8',
});
assert.equal(backend.status, 0, backend.stderr || backend.stdout);
assert.match(backend.stdout, /"ok": true/);
assert.match(mainPy, /async def discover_gemini_cli_models\(/);
assert.doesNotMatch(mainPy, /模型列表使用 auto 默认模型/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```powershell
node tools/tests/antigravity-cli-integration.test.mjs
```

Expected: FAIL because `gemini_cli_parse_models_output` and `discover_gemini_cli_models` do not exist and the static `auto` payload is still present.

- [ ] **Step 3: Implement the pure parser and bounded discovery**

Add the following focused functions near the existing Antigravity helpers in `main.py`:

```python
GEMINI_CLI_MODELS_TIMEOUT = 20
ANSI_ESCAPE_RE = re.compile(r"\x1b(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])")
GEMINI_CLI_MODEL_NOISE = {
    "available models",
    "available models:",
    "models",
    "models:",
}

def gemini_cli_parse_models_output(value):
    models = []
    seen = set()
    for raw_line in str(value or "").splitlines():
        line = ANSI_ESCAPE_RE.sub("", raw_line)
        line = re.sub(r"[\x00-\x08\x0b-\x1f\x7f]", "", line).strip()
        if not line or line.lower() in GEMINI_CLI_MODEL_NOISE or line in seen:
            continue
        seen.add(line)
        models.append(line)
    return models

def gemini_cli_models_payload(models, raw=None):
    discovered = model_list_from_values(models)
    return {
        "ok": True,
        "protocol": "gemini-cli",
        "status": 200,
        "message": f"Antigravity CLI 已实时拉取 {len(discovered)} 个模型。",
        "model_count": len(discovered),
        "total": len(discovered),
        "image_models": list(discovered),
        "chat_models": list(discovered),
        "video_models": [],
        "all": list(discovered),
        "raw": raw or {},
    }

async def discover_gemini_cli_models(timeout=GEMINI_CLI_MODELS_TIMEOUT):
    exe = gemini_cli_executable()
    if not exe or not is_antigravity_cli(exe):
        raise HTTPException(status_code=400, detail="未找到 Antigravity CLI，请先安装 agy 并完成登录。")
    proc = None
    try:
        proc = await asyncio.create_subprocess_exec(
            exe,
            "models",
            cwd=BASE_DIR,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        stdout, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except asyncio.TimeoutError as exc:
        if proc and proc.returncode is None:
            proc.kill()
            await proc.wait()
        raise HTTPException(status_code=504, detail="Antigravity CLI 拉取模型超时，已保留原有模型配置。") from exc
    except FileNotFoundError as exc:
        raise HTTPException(status_code=400, detail=f"未找到 Antigravity CLI：{exe}") from exc
    out_text, err_text = codex_decode_output(stdout, stderr)
    if proc.returncode != 0:
        message = (err_text or out_text or f"exit={proc.returncode}")[:1200]
        raise HTTPException(status_code=502, detail=f"Antigravity CLI 拉取模型失败：{message}")
    models = gemini_cli_parse_models_output(out_text)
    if not models:
        raise HTTPException(status_code=502, detail="Antigravity CLI 未返回可用模型，已保留原有模型配置。")
    return gemini_cli_models_payload(models, raw={"stdout": out_text, "stderr": err_text})
```

Replace the existing static `gemini_cli_models_payload(raw=None)` implementation rather than leaving two definitions.

- [ ] **Step 4: Extend the harness for failure semantics**

Add mocked non-zero, empty-output, and timeout processes. Assert status codes `502`, `502`, and `504`, and assert the timeout process receives `kill()` and `wait()`. Use arbitrary sample sizes rather than asserting the screenshot's current model count.

- [ ] **Step 5: Run the focused test**

Run:

```powershell
node tools/tests/antigravity-cli-integration.test.mjs
```

Expected: PASS with `{"ok": true}` from the Python harness.

- [ ] **Step 6: Commit dynamic discovery**

```powershell
git add main.py tools/tests/antigravity-cli-integration.test.mjs
git commit -m "feat: discover Antigravity CLI models"
```

### Task 2: Connect Provider Endpoints And Exact Runtime Models

**Files:**
- Modify: `main.py:5167-5215`
- Modify: `main.py:13963-13990`
- Modify: `main.py:14228-14242`
- Modify: `tools/tests/antigravity-cli-integration.test.mjs`

- [ ] **Step 1: Add failing endpoint and command-linkage contracts**

Append assertions that the two provider paths await live discovery and that the Antigravity runtime keeps the exact model argument:

```javascript
assert.match(
  mainPy,
  /if protocol == "gemini-cli":[\s\S]*return await discover_gemini_cli_models\(\)/,
  'fetch-models must await the live agy models command',
);
assert.match(
  mainPy,
  /if protocol == "gemini-cli":[\s\S]*payload_models = await discover_gemini_cli_models\(\)/,
  'connection testing must not return the old static auto payload',
);
const runStart = mainPy.indexOf('async def run_gemini_cli(');
const runEnd = mainPy.indexOf('def gemini_cli_parse_models_output', runStart);
const runBody = mainPy.slice(runStart, runEnd);
assert.match(runBody, /args\.extend\(\["--model", selected\]\)/);
assert.doesNotMatch(runBody, /shell\s*=\s*True/);
```

Extend the Python harness with a mocked `run_gemini_cli` process and assert that a name such as `Claude Opus 4.6 (Thinking)` appears as one intact argument immediately after `--model`.

Run two mocked calls concurrently with `asyncio.gather`, one using `Model Alpha (High)` and the other using `Model Beta (Low)`. Capture both argument tuples and assert that each tuple contains only its own model after `--model`; neither call may read or mutate a shared current-model value.

- [ ] **Step 2: Run the test to verify endpoint assertions fail**

Run `node tools/tests/antigravity-cli-integration.test.mjs`.

Expected: FAIL because both provider branches still call the static payload helper.

- [ ] **Step 3: Route both provider operations to live discovery**

In `test_provider_connection`, replace the Antigravity branch with:

```python
if protocol == "gemini-cli":
    payload_models = await discover_gemini_cli_models()
    payload_models["message"] = payload_models.get("message") or "Antigravity CLI 可用"
    return payload_models
```

In `fetch_models_from_upstream`, replace the Antigravity branch with:

```python
if protocol == "gemini-cli":
    return await discover_gemini_cli_models()
```

Keep `gemini_cli_status()` as the lightweight `agy --version` installation check used by **检测 CLI**.

- [ ] **Step 4: Add model observability without logging prompts**

Immediately before `asyncio.create_subprocess_exec` in `run_gemini_cli`, log only the selected model and tool mode:

```python
logging.info(
    "Antigravity CLI request model=%s tools=%s",
    selected if is_antigravity_cli(exe) else gemini_cli_model(model),
    bool(allow_tools),
)
```

Do not log prompts, images, API keys, or account output.

Add a small warning helper and call it from `generate_ai_image` and `canvas_llm` before Antigravity execution:

```python
def warn_unlisted_gemini_cli_model(provider, model, channel):
    key = "image_models" if channel == "image" else "chat_models"
    configured = model_list_from_values((provider or {}).get(key) or [])
    selected = str(model or "").strip()
    if selected and selected != "auto" and configured and selected not in configured:
        logging.warning(
            "Antigravity CLI using saved canvas model outside current %s list: %s",
            channel,
            selected,
        )
```

This warning must not reject or rewrite an older canvas model. Add source assertions for both call sites to the focused test.

- [ ] **Step 5: Run focused and existing provider tests**

Run:

```powershell
node tools/tests/antigravity-cli-integration.test.mjs
node tools/tests/api-settings-provider-fusion.test.mjs
```

Expected: both PASS.

- [ ] **Step 6: Commit endpoint linkage**

```powershell
git add main.py tools/tests/antigravity-cli-integration.test.mjs
git commit -m "fix: link Antigravity models to CLI requests"
```

### Task 3: Independent Chat And Image Selection

**Files:**
- Modify: `static/js/api-settings.js:3121-3320`
- Modify: `tools/tests/antigravity-cli-integration.test.mjs`

- [ ] **Step 1: Add failing frontend contracts**

Read `static/js/api-settings.js` in the test and assert that Antigravity mode uses per-category sets rather than the existing exclusive category map:

```javascript
const apiSettings = readFileSync(join(repoRoot, 'static', 'js', 'api-settings.js'), 'utf8');
assert.match(apiSettings, /function isAntigravityPickerMode\(/);
assert.match(apiSettings, /selectedByCategory:\s*\{\s*image:\s*new Set/);
assert.match(apiSettings, /selectedByCategory\.chat/);
assert.match(apiSettings, /selectedByCategory\.image/);
assert.match(apiSettings, /item\.image_models = .*selectedByCategory\.image/);
assert.match(apiSettings, /item\.chat_models = .*selectedByCategory\.chat/);
```

- [ ] **Step 2: Run the test to verify it fails**

Run `node tools/tests/antigravity-cli-integration.test.mjs`.

Expected: FAIL because the picker still assigns every model to exactly one category.

- [ ] **Step 3: Add Antigravity-only dual-selection state**

Keep the general provider picker unchanged and extend its state shape:

```javascript
let pickerState = {
    category: {},
    selected: {},
    independent: false,
    order: [],
    selectedByCategory: {image:new Set(), chat:new Set()},
};

function isAntigravityPickerMode(item=provider()){
    return String(item?.protocol || protocolInput?.value || '').toLowerCase() === 'gemini-cli';
}
```

In `openModelPicker()`, when Antigravity mode is active:

```javascript
const independent = isAntigravityPickerMode(item);
pickerState = {
    category: {},
    selected: {},
    independent,
    order: [...new Set([...lastFetchedAll, ...(item.image_models || []), ...(item.chat_models || [])])],
    selectedByCategory: {
        image: new Set(item.image_models || []),
        chat: new Set(item.chat_models || []),
    },
};
```

Use the fetched `lastFetchedAll` plus saved chat/image values as the displayed IDs. Hide the **全部** and **视频** tabs, show **生图** and **LLM**, and activate **生图** on open. When another provider opens the picker, restore all tab visibility and its existing default **全部** tab.

- [ ] **Step 4: Render and toggle the active independent category**

In `renderModelPicker()`, use every model ID when `pickerState.independent` is true and read checked state from the active category set:

```javascript
const ids = pickerState.independent
    ? pickerState.order
    : Object.keys(pickerState.category).sort();
const activeCategory = currentTab === 'chat' ? 'chat' : 'image';
const checked = pickerState.independent
    ? pickerState.selectedByCategory[activeCategory].has(id)
    : pickerState.selected[id];
```

In `togglePickerRow`, add or delete the ID from the active set. Calculate summary counts from the two sets independently, so one model selected in both categories contributes to both counts.

- [ ] **Step 5: Apply both lists independently**

At the start of `applyModelPicker()`, handle the Antigravity branch:

```javascript
if(pickerState.independent){
    item.image_models = pickerState.order.filter(id => pickerState.selectedByCategory.image.has(id));
    item.chat_models = pickerState.order.filter(id => pickerState.selectedByCategory.chat.has(id));
    item.video_models = [];
    renderModels('image');
    renderModels('chat');
    renderModels('video');
    renderMsLoras();
    setStatus(`已应用 · 生图 ${item.image_models.length} / LLM ${item.chat_models.length}，点保存生效`);
    closeModelPicker();
    return;
}
```

Add a frontend source assertion that independent rendering reads `pickerState.order` rather than sorting it.

- [ ] **Step 6: Run frontend and provider regressions**

Run:

```powershell
node tools/tests/antigravity-cli-integration.test.mjs
node tools/tests/api-settings-provider-fusion.test.mjs
node tools/tests/api-settings-protocol-override.test.mjs
```

Expected: all PASS.

- [ ] **Step 7: Commit independent selection**

```powershell
git add static/js/api-settings.js tools/tests/antigravity-cli-integration.test.mjs
git commit -m "feat: select Antigravity model channels independently"
```

### Task 4: Interactive Antigravity Terminal Launch

**Files:**
- Modify: `main.py:13405-13470`
- Modify: `static/api-settings.html:245-260`
- Modify: `static/js/api-settings.js:2829-2880`
- Modify: `tools/tests/antigravity-cli-integration.test.mjs`

- [ ] **Step 1: Add failing launch security and UI tests**

Append these contracts:

```javascript
const apiHtml = readFileSync(join(repoRoot, 'static', 'api-settings.html'), 'utf8');
assert.match(
  apiHtml,
  /openGeminiCliHelp\(\)[\s\S]*launchGeminiCli\(\)/,
  '启动 must appear immediately after 帮助',
);
assert.match(apiSettings, /async function launchGeminiCli\(\)/);
assert.match(apiSettings, /fetch\('\/api\/gemini-cli\/launch'/);
assert.match(mainPy, /@app\.post\("\/api\/gemini-cli\/launch"\)/);
assert.match(mainPy, /ensure_loopback_request\(request\)/);
assert.doesNotMatch(mainPy, /gemini-cli\/launch[\s\S]{0,500}payload\.command/);
```

Extend the Python harness with `unittest.mock.patch` around `subprocess.Popen`; assert the argument list contains only the resolved PowerShell executable, fixed flags, fixed command `& $env:HSTARA_ANTIGRAVITY_LAUNCH_EXE`, and an environment variable containing the resolved `agy.exe` path.

- [ ] **Step 2: Run the test to verify it fails**

Run `node tools/tests/antigravity-cli-integration.test.mjs`.

Expected: FAIL because the launch route, UI button, and frontend function do not exist.

- [ ] **Step 3: Implement the fixed-command Windows launcher**

Add helpers in `main.py`:

```python
def ensure_loopback_request(request):
    host = str(getattr(request.client, "host", "") or "").strip().lower()
    if host not in {"127.0.0.1", "::1", "localhost"}:
        raise HTTPException(status_code=403, detail="只允许从本机启动 Antigravity CLI。")

def launch_gemini_cli_terminal_process():
    if os.name != "nt":
        raise HTTPException(status_code=400, detail="当前环境不支持打开 Windows Antigravity CLI 命令窗口。")
    exe = gemini_cli_executable()
    if not exe or not is_antigravity_cli(exe):
        raise HTTPException(status_code=400, detail="未找到 Antigravity CLI，请先安装 agy。")
    powershell = shutil.which("powershell.exe") or shutil.which("powershell")
    if not powershell:
        raise HTTPException(status_code=500, detail="未找到 Windows PowerShell，无法打开 Antigravity CLI 命令窗口。")
    env = os.environ.copy()
    env["HSTARA_ANTIGRAVITY_LAUNCH_EXE"] = exe
    process = subprocess.Popen(
        [powershell, "-NoLogo", "-NoExit", "-Command", "& $env:HSTARA_ANTIGRAVITY_LAUNCH_EXE"],
        cwd=BASE_DIR,
        env=env,
        creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
    )
    return process

@app.post("/api/gemini-cli/launch")
async def launch_gemini_cli_terminal(request: Request):
    ensure_loopback_request(request)
    try:
        process = launch_gemini_cli_terminal_process()
    except HTTPException:
        raise
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Antigravity CLI 命令窗口启动失败：{exc}") from exc
    return {"ok": True, "pid": process.pid, "message": "Antigravity CLI 命令窗口已启动。"}
```

No request body or command argument is accepted by this endpoint.

- [ ] **Step 4: Add the button and frontend action**

Immediately after the existing **帮助** button in `static/api-settings.html`, add:

```html
<button class="action-btn" type="button" onclick="launchGeminiCli()" title="启动 Antigravity CLI">
    <i data-lucide="play" class="w-3.5 h-3.5"></i><span>启动</span>
</button>
```

Add the frontend function beside the existing help functions:

```javascript
async function launchGeminiCli(){
    try {
        const data = await fetch('/api/gemini-cli/launch', {method:'POST'})
            .then(r => readApiJsonResponse(r, '启动 Antigravity CLI 失败'));
        if(geminiCliInfo) geminiCliInfo.textContent = data.message || 'Antigravity CLI 命令窗口已启动';
    } catch(e){
        const message = e.message || String(e);
        if(geminiCliInfo) geminiCliInfo.textContent = message;
        alert('启动失败：' + message);
    }
}
```

- [ ] **Step 5: Run launch and API settings tests**

Run:

```powershell
node tools/tests/antigravity-cli-integration.test.mjs
node tools/tests/api-settings-provider-fusion.test.mjs
```

Expected: both PASS and no real terminal opens because `Popen` is mocked in the harness.

- [ ] **Step 6: Commit the launch control**

```powershell
git add main.py static/api-settings.html static/js/api-settings.js tools/tests/antigravity-cli-integration.test.mjs
git commit -m "feat: launch interactive Antigravity CLI"
```

### Task 5: Real CLI And Browser Acceptance

**Files:**
- Verify: `main.py`
- Verify: `static/api-settings.html`
- Verify: `static/js/api-settings.js`
- Verify: `tools/tests/*.test.mjs`

- [ ] **Step 1: Run syntax and focused checks**

Run:

```powershell
.\python\python.exe -m py_compile main.py
node --check static/js/api-settings.js
node tools/tests/antigravity-cli-integration.test.mjs
```

Expected: all commands exit `0`.

- [ ] **Step 2: Run the complete root regression suite**

Run each root test and stop on the first failure:

```powershell
$tests = Get-ChildItem -LiteralPath 'tools/tests' -Filter '*.test.mjs' | Sort-Object Name
foreach ($test in $tests) {
    node $test.FullName
    if ($LASTEXITCODE -ne 0) { throw "Test failed: $($test.Name)" }
}
```

Expected: every test exits `0`.

- [ ] **Step 3: Verify live dynamic discovery**

Run the installed CLI directly:

```powershell
agy models
```

Then click **拉取模型** in the Antigravity provider and compare the visible picker names and order with the command output. Do not assert a fixed number of models.

- [ ] **Step 4: Verify independent persistence**

Select one subset under **生图** and a different subset under **LLM**, apply, save the provider, close API settings, and reopen it. Confirm both saved lists remain distinct and unchanged.

- [ ] **Step 5: Verify real model propagation**

Choose one saved chat model and one saved image model in separate canvas requests. Confirm the engineering terminal logs contain the exact corresponding `Antigravity CLI request model=<name>` values and that Antigravity accepts those models. Do not log or expose prompts/account data.

- [ ] **Step 6: Verify the interactive launch button**

Click **启动** and confirm a visible independent PowerShell window opens, automatically enters `agy`, accepts interactive operations, and remains open until manually closed. Confirm **拉取模型** still works whether this window is open or closed.

- [ ] **Step 7: Inspect the UI at desktop and narrow widths**

Use the in-app browser to confirm the three Antigravity actions wrap cleanly without overflow and the model picker remains usable at the current desktop viewport and a narrow viewport. Check browser console and server output for errors.

- [ ] **Step 8: Review final diff and commit acceptance fixes if needed**

Run:

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors and only intentional files changed. If acceptance required a corrective edit, repeat its focused test and commit it with a narrowly scoped message before declaring completion.
