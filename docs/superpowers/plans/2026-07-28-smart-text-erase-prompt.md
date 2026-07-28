# Smart Text Erase Prompt Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan inline. Subagents are prohibited by the user. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Strengthen Smart Canvas text erasure so the selected image model is instructed to remove only text while preserving all non-text design content.

**Architecture:** Keep the existing Smart Canvas image-generation pipeline and user-selected settings authoritative. Change only the dedicated erasure prompt and protect the behavior with a focused source-level regression test.

**Tech Stack:** Browser JavaScript, Node.js assertions, Hstar Smart Canvas source gates.

**Constraints:** Do not add OCR, masks, source-size locking, provider restrictions, commits, merges, pushes, cache migration, or paid generation requests.

---

### Task 1: Lock The Prompt Contract With A Failing Test

**Files:**
- Modify: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] Add assertions requiring the erase prompt to remove text-like content, preserve named non-text elements, restrict edits to text-covered areas, forbid new text, and respect user-selected target framing.
- [ ] Run `node --test tools/tests/smart-text-edit-integration.test.mjs` and verify it fails because the current prompt lacks the new constraints.

### Task 2: Strengthen Only The Erasure Prompt

**Files:**
- Modify: `static/js/smart-canvas.js`

- [ ] Replace `smartTextErasePrompt()` with a precise ordered instruction that preserves non-text content and allows only target-size adaptation required by user settings.
- [ ] Keep `smartTextEraseRunSettings()` and `applySmartTextErase()` unchanged so model, ratio, resolution, quality, and count remain user-controlled.
- [ ] Re-run the focused test and verify it passes.

### Task 3: Refresh Cache And Verify

**Files:**
- Modify: `static/smart-canvas.html`

- [ ] Refresh only the `smart-canvas.js` cache key using the repository version-plus-mtime convention.
- [ ] Run the Smart Canvas text-edit tests, static cache integrity test, encoding audit, `git diff --check`, and `build/scripts/Test-HstarSource.ps1`.
- [ ] Reload `http://127.0.0.1:3000/` and inspect the erase window without submitting a paid image-generation request.
