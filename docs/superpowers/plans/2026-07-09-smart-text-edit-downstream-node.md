# Smart Text Edit Downstream Node Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep recognized text attached to the source image and make text modification generate into a new downstream image node using the source node's image generation settings.

**Architecture:** Store OCR state on the smart image node per image index, hydrate the floating panel from that node state, and persist edits as the user types. Split text recognition from image generation: recognition uses the text API controls, while apply modification creates a pending downstream smart-image node and runs the source node's image API settings there.

**Tech Stack:** Plain JavaScript smart canvas frontend, existing static Node.js tests, HstarA FastAPI backend unchanged.

---

### Task 1: Lock Desired Smart Text Behavior

**Files:**
- Modify: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] Add assertions that recognized text state is stored on the node, close only hides the panel, reopen hydrates from stored state, and apply modification uses a downstream output node instead of replacing the source node.
- [ ] Run `node tools/tests/smart-text-edit-integration.test.mjs` and confirm it fails on the new assertions.

### Task 2: Persist OCR State Per Image

**Files:**
- Modify: `static/js/smart-canvas.js`

- [ ] Add helpers for a stable text edit state key based on image index.
- [ ] Save recognized rows, status, provider, and model to the source node whenever recognition succeeds or textarea content changes.
- [ ] Change close behavior so it hides the panel while leaving the node state intact.
- [ ] Hydrate the panel from stored node state when reopening the same image.

### Task 3: Generate Into A Downstream Node

**Files:**
- Modify: `static/js/smart-canvas.js`

- [ ] Change `smartTextImageRunSettings` so it preserves the node's configured `count` instead of forcing `1`.
- [ ] Change `runSmartImageTextGeneration` to create a pending output node from the source image node, connect it downstream, run generation against that output node, and write results into the output node.
- [ ] Preserve source-node settings in run metadata and keep the original image node unchanged.

### Task 4: Verify

**Files:**
- Test: `tools/tests/smart-text-edit-integration.test.mjs`
- Test: `tools/tests/static-cache-integrity.test.mjs`

- [ ] Run `node --check static/js/smart-canvas.js`.
- [ ] Run `node tools/tests/smart-text-edit-integration.test.mjs`.
- [ ] Run `node tools/tests/static-cache-integrity.test.mjs`.
- [ ] Refresh or confirm HstarA 3000 service can serve the updated smart canvas.
