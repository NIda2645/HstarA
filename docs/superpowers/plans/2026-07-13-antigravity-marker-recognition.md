# Antigravity Marker Recognition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect image marker recognition to the selected Antigravity CLI model and suppress Windows console flashes for every background Antigravity command.

**Architecture:** Keep the shared marker endpoint and branch by provider before HTTP resolution. Reuse `gemini_cli_chat_text` for image localization and add one background subprocess kwargs helper used by request, discovery, status, and help commands; the explicit terminal launcher remains separate.

**Tech Stack:** FastAPI, Pydantic, asyncio subprocesses, Node-based source/integration tests, Python mock harnesses.

---

### Task 1: Add failing marker CLI regression coverage

**Files:**
- Modify: `tools/tests/antigravity-cli-integration.test.mjs`
- Modify: `tools/tests/image-marker-api-route.test.mjs`

- [ ] **Step 1: Add a backend test proving the marker route uses the CLI path**

Add a Python harness case that creates `ImageMarkerIdentifyRequest` with provider `gemini-cli`, model `Gemini 3.5 Flash (Low)`, a data-URL thumbnail and full image, then mocks `get_api_provider`, `gemini_cli_chat_text`, and `resolve_chat_provider`:

```python
marker_payload = main.ImageMarkerIdentifyRequest(
    image_url=data_image,
    thumbnail=data_image,
    x=0.5,
    y=0.5,
    number=1,
    provider="gemini-cli",
    model="Gemini 3.5 Flash (Low)",
)
with patch.object(main, "get_api_provider", return_value=provider):
    with patch.object(main, "resolve_chat_provider") as resolve_http:
        with patch.object(main, "gemini_cli_chat_text", return_value=("红色马克杯", {"text": "红色马克杯"})) as cli_chat:
            result = await main.identify_image_marker(marker_payload)
resolve_http.assert_not_called()
assert result["object_name"] == "红色马克杯"
assert result["model"] == "Gemini 3.5 Flash (Low)"
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node tools/tests/antigravity-cli-integration.test.mjs`

Expected: FAIL because `identify_image_marker` calls `resolve_chat_provider` before checking `is_gemini_cli_provider`.

- [ ] **Step 3: Extend the static route test**

Assert that the endpoint source includes both `is_gemini_cli_provider` and `gemini_cli_chat_text`, while both canvas clients continue using `/api/image-marker/identify`.

### Task 2: Add failing background-window coverage

**Files:**
- Modify: `tools/tests/antigravity-cli-integration.test.mjs`

- [ ] **Step 1: Assert Windows background subprocess flags**

Patch `main.os.name` to `nt` and `main.subprocess.CREATE_NO_WINDOW` to `0x08000000`, invoke request and discovery paths, and assert:

```python
assert kwargs["creationflags"] == 0x08000000
```

Also retain the existing launcher assertion:

```python
assert launch_kwargs["creationflags"] == 0x10
```

- [ ] **Step 2: Run the test and verify RED**

Run: `node tools/tests/antigravity-cli-integration.test.mjs`

Expected: FAIL because background subprocess calls currently omit `creationflags`.

### Task 3: Implement marker CLI routing

**Files:**
- Modify: `main.py:13105`

- [ ] **Step 1: Branch before HTTP provider resolution**

Resolve the provider configuration and selected model first:

```python
provider_id = payload.provider or "comfly"
llm_provider = get_api_provider(provider_id) if provider_id != "modelscope" else {}
if is_gemini_cli_provider(llm_provider):
    resolved_model = selected_model(
        payload.model,
        (llm_provider.get("chat_models") or GEMINI_CLI_DEFAULT_CHAT_MODELS)[0],
    )
else:
    chat_base, chat_hdrs, resolved_model = resolve_chat_provider(
        provider_id, payload.model, payload.ms_model
    )
```

- [ ] **Step 2: Reuse the existing CLI image adapter**

Construct a `SimpleNamespace` compatible with `gemini_cli_chat_text`:

```python
cli_payload = SimpleNamespace(
    message=marker_prompt,
    system_prompt="You are a precise visual labeling assistant for image annotation.",
    model=resolved_model,
    images=[value for value in (thumb_url, image_url) if value],
)
text, raw = await gemini_cli_chat_text(cli_payload, [])
```

Call `warn_unlisted_gemini_cli_model`, return the same normalized response shape, and leave the HTTP request block unchanged for other providers.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run:

```text
node tools/tests/antigravity-cli-integration.test.mjs
node tools/tests/image-marker-api-route.test.mjs
node tools/tests/canvas-marker-integration.test.mjs
node tools/tests/smart-marker-integration.test.mjs
```

Expected: all pass.

### Task 4: Suppress background Antigravity windows

**Files:**
- Modify: `main.py:5190`
- Modify: `main.py:5448`
- Modify: `main.py:13721`
- Modify: `main.py:13799`

- [ ] **Step 1: Add a platform-specific helper**

```python
def gemini_cli_background_subprocess_kwargs():
    if os.name != "nt":
        return {}
    return {"creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)}
```

- [ ] **Step 2: Apply it only to background calls**

Add `**gemini_cli_background_subprocess_kwargs()` to `run_gemini_cli`, `discover_gemini_cli_models`, `gemini_cli_status`, and `gemini_cli_help`. Do not change `launch_gemini_cli`, which must retain `CREATE_NEW_CONSOLE`.

- [ ] **Step 3: Run focused tests and verify GREEN**

Run: `node tools/tests/antigravity-cli-integration.test.mjs`

Expected: background calls use `CREATE_NO_WINDOW`; explicit launch still uses `CREATE_NEW_CONSOLE`.

### Task 5: Verify, restart, and smoke test

**Files:**
- Verify: `main.py`
- Verify: `tools/tests/*.test.mjs`

- [ ] **Step 1: Run syntax and repository checks**

Run:

```text
py -3 -m py_compile main.py
node tools/tests/text-encoding-health.test.mjs
git diff --check
```

- [ ] **Step 2: Run all 56 root tests**

Execute every `tools/tests/*.test.mjs`; expected result is `56/56` with zero failures.

- [ ] **Step 3: Restart the engineering server**

Stop only the process listening on port 3000 whose command line points to this checkout, then start `python/python.exe main.py` hidden from `E:\Claude专业组\HstarA`.

- [ ] **Step 4: Run a real marker request**

POST a real image marker payload to `/api/image-marker/identify` with provider `gemini-cli` and model `Gemini 3.5 Flash (Low)`. Require HTTP 200, a non-empty `object_name`, and the same returned model.

- [ ] **Step 5: Commit implementation**

Commit `main.py` and the focused tests after all checks pass.
