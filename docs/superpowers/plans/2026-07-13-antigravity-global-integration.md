# Antigravity Global Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate background Antigravity console flashes and complete the remaining OCR and text-edit integration contracts.

**Architecture:** Strengthen the shared Windows subprocess kwargs, branch OCR by provider before HTTP resolution, and preserve the existing shared image task pipeline for modify/erase operations while testing its reference-image contract.

**Tech Stack:** FastAPI, asyncio subprocesses, Pydantic, browser JavaScript, Node/Python integration harnesses.

---

### Task 1: Add failing Windows visibility tests

**Files:**
- Modify: `tools/tests/antigravity-cli-integration.test.mjs`

- [ ] Patch `os.name`, `CREATE_NO_WINDOW`, `STARTUPINFO`, `STARTF_USESHOWWINDOW`, and `SW_HIDE` with deterministic fakes.
- [ ] Assert each background subprocess receives `creationflags=0x08000000` and one startup-info object whose flags and show state are set.
- [ ] Retain the explicit launcher assertion for `CREATE_NEW_CONSOLE`.
- [ ] Run `node tools/tests/antigravity-cli-integration.test.mjs`; expect failure because `startupinfo` is absent.

### Task 2: Add failing OCR CLI tests

**Files:**
- Modify: `tools/tests/antigravity-cli-integration.test.mjs`
- Modify: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] Build a `SmartImageTextRecognizeRequest` with provider `gemini-cli`, exact model, and a data image.
- [ ] Mock `gemini_cli_chat_text`, assert `resolve_chat_provider` is not called, and require parsed text items plus the same returned model.
- [ ] Add a source contract assertion that `/api/smart-image/text/recognize` contains `is_gemini_cli_provider` and `gemini_cli_chat_text`.
- [ ] Run both focused tests; expect failure at the missing CLI branch.

### Task 3: Add text modification and erase contracts

**Files:**
- Modify: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] Assert both apply functions route through `runSmartImageTextGeneration`.
- [ ] Assert that function constructs `sourceRef`, filters a non-empty `refs` array, sets `requireReferenceImage`, and calls `generateUrlsForCurrentSettings(outputNode, prompt, refs, runSettings)`.
- [ ] Assert the task payload uses `provider_id`, `model`, and `reference_images:imageRefs`.

### Task 4: Implement the fixes

**Files:**
- Modify: `main.py`

- [ ] Extend `gemini_cli_background_subprocess_kwargs` with `STARTUPINFO`, `STARTF_USESHOWWINDOW`, and `SW_HIDE` only on Windows.
- [ ] Add the Antigravity branch to `recognize_smart_image_text` before `resolve_chat_provider`.
- [ ] Build a `CanvasLLMRequest` with the OCR prompt and source image, call `gemini_cli_chat_text`, and keep existing JSON/fallback parsing.
- [ ] Run focused tests and Python compilation; expect all to pass.

### Task 5: Verify and deploy

**Files:**
- Verify: `main.py`
- Verify: `static/js/smart-canvas.js`
- Verify: `tools/tests/*.test.mjs`

- [ ] Run all root tests and require zero failures.
- [ ] Merge the isolated feature branch into `codex/hstara-health-audit`.
- [ ] Restart only the HstarA engineering server on port 3000.
- [ ] POST a real Antigravity OCR request and marker request; require HTTP 200, non-empty results, and exact returned models.
- [ ] Confirm the repository is clean and the service is listening.
