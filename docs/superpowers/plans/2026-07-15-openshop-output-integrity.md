# OpenShop Output Integrity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep every OpenShop canvas export readable at its original document size and prevent routine layer operations from exposing transparent borders around the first full-document source image.

**Architecture:** Persist exported asset IDs in each OpenShop project before announcing the output to the HstarA canvas, and make garbage collection consider asset URLs still stored in canvas records. When the first source establishes a blank project's document size, create a locked 1:1 blank artboard layer at the bottom and place the connected source as a separate editable layer directly above it, matching Photoshop 2023 layer behavior.

**Tech Stack:** JavaScript, Fabric.js 5.3, Vitest, Playwright, Python/FastAPI, Pillow, Node test harnesses.

---

### Task 1: Persist and retain exported assets

**Files:**
- Modify: `integrations/openshop/host/openshop-host-runtime.js`
- Modify: `integrations/openshop/host/openshop-project-adapter.js`
- Modify: `openshop_projects.py`
- Modify: `main.py`
- Test: `integrations/openshop/tests/hstar-host-runtime.test.js`
- Test: `integrations/openshop/tests/hstar-project-adapter.test.js`
- Test: `tools/tests/openshop-project-storage.test.mjs`

- [ ] Add failing tests proving an output is recorded in `exportRecords`, included in `assetRefs`, saved before `SEND_TO_CANVAS`, and retained by garbage collection while a canvas URL references it.
- [ ] Run the focused tests and confirm failures identify the missing persistence behavior.
- [ ] Serialize and restore bounded export records, perform a confirmed post-upload save, and add structured canvas asset reference collection to garbage collection.
- [ ] Run focused unit and storage tests until green.

### Task 2: Establish a Photoshop-style locked base artboard

**Files:**
- Modify: `integrations/openshop/host/openshop-project-adapter.js`
- Modify: `integrations/openshop/index.html`
- Test: `integrations/openshop/tests/hstar-project-adapter.test.js`
- Test: `integrations/openshop/tests/os-unit.test.js`

- [ ] Add failing tests proving the first source that adopts document dimensions creates a locked 1:1 base artboard below an unlocked source layer, lock state survives serialization/restoration, and tool switching does not make locked objects interactive.
- [ ] Run focused tests and confirm the existing code fails for the expected reasons.
- [ ] Create or repair the locked bottom artboard, keep the source layer editable, persist `locked`, and make `setTool('select')` apply layer lock state to Fabric objects.
- [ ] Run focused tests until green.

### Task 3: End-to-end 4K regression verification

**Files:**
- Modify: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`

- [ ] Extend the 4K canvas test to perform layer operations, export, trigger garbage collection, reload the output URL, and inspect edge alpha coverage.
- [ ] Run the E2E test against a clean local server and confirm the old behavior fails before implementation when applicable.
- [ ] Run the complete OpenShop unit, storage, build, and canvas integration suites.
- [ ] Inspect the final diff, keep unrelated user changes untouched, and commit only this repair.
