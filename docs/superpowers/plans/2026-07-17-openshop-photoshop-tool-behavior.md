# OpenShop Photoshop Tool Behavior Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the affected OpenShop editing behaviors with testable Photoshop 2023-style raster, font, snapping, zoom, lasso, and magic-wand behavior while preserving the existing UI layout.

**Architecture:** Put pixel and selection algorithms in small host modules and keep `index.html` as the interaction coordinator. All geometry engines remain stateless; session state lives in the controller that owns the pointer gesture.

**Tech Stack:** JavaScript, Canvas 2D, Fabric.js 5, Python/Win32 GDI, Vitest, unittest, Playwright.

---

### Task 1: Raster opacity and brush cursor

**Files:**
- Modify: `integrations/openshop/host/openshop-raster-tools.js`
- Create: `integrations/openshop/host/openshop-brush-cursor.js`
- Modify: `integrations/openshop/index.html`
- Test: `integrations/openshop/tests/hstar-raster-tools.test.js`
- Test: `integrations/openshop/tests/hstar-brush-cursor.test.js`

- [ ] Add failing tests proving eraser `globalAlpha` follows `brushOpacity`, soft dabs have radial alpha falloff, and hard round dabs remain uniform.
- [ ] Replace line-only raster strokes with spaced brush dabs that interpolate fast pointer movement and use `destination-out` with the configured alpha.
- [ ] Add a pointer-events-none DOM outline whose diameter is `toolSize * viewportZoom`, and update it on pointer movement, tool, size, preset, and zoom changes.
- [ ] Run `npm test -- --run hstar-raster-tools.test.js hstar-brush-cursor.test.js` and expect all tests to pass.

### Task 2: Real installed font family/style grouping

**Files:**
- Modify: `openshop_fonts.py`
- Modify: `tests/test_openshop_fonts.py`

- [ ] Add failing fixtures for `阿里巴巴普惠体 2.0 55 Regular`, `阿里巴巴普惠体 2.0 65 Medium`, `Alibaba PuHuiTi B`, and `Alibaba PuHuiTi H`.
- [ ] Parse style tokens from installed face names while preserving real style labels and actual CSS `font-family` face names.
- [ ] Deduplicate only identical faces; do not replace vendor-specific `B`/`H` with invented Regular/Light labels.
- [ ] Run `python -m unittest tests.test_openshop_fonts -v` and expect all tests to pass.

### Task 3: Stateless scale snapping

**Files:**
- Modify: `integrations/openshop/host/openshop-snap-engine.js`
- Modify: `integrations/openshop/index.html`
- Test: `integrations/openshop/tests/openshop-snap-engine.test.js`
- Test: `integrations/openshop/tests/os-unit.test.js`

- [ ] Add failing tests for immediate snap/release and for repeated scaling events that begin from a frozen gesture origin.
- [ ] Capture the object's unsnapped transform at `before:transform`, derive each proposal from Fabric's current raw transform, and clear the gesture state at `mouse:up`/`object:modified`.
- [ ] Preserve the opposite anchor while changing only the moving edge; do not repeatedly multiply an already-snapped scale.
- [ ] Run the focused snap and editor unit tests and expect all tests to pass.

### Task 4: Photoshop wheel zoom

**Files:**
- Modify: `integrations/openshop/index.html`
- Test: `integrations/openshop/tests/os-unit.test.js`

- [ ] Add a failing test proving `Ctrl+wheel` zooms around the pointer and plain wheel does not zoom.
- [ ] Gate `preventDefault`, zoom calculation, status update, and viewport scheduling behind Ctrl/Command.
- [ ] Run `npm test -- --run os-unit.test.js` and expect all tests to pass.

### Task 5: Lasso and magic-wand selection engine

**Files:**
- Create: `integrations/openshop/host/openshop-selection-engine.js`
- Modify: `integrations/openshop/index.html`
- Test: `integrations/openshop/tests/hstar-selection-engine.test.js`
- Test: `integrations/openshop/tests/os-unit.test.js`

- [ ] Add failing tests for freehand polygon masks, perceptual color tolerance, contiguous/non-contiguous wand selection, and new/add/subtract/intersect composition.
- [ ] Implement bounded iterative flood fill and mask operations without the current one-million-pixel early truncation.
- [ ] Route lasso through pointer down/move/up, simplify dense paths, close the path on release, and store a real pixel mask.
- [ ] Render marching ants from the mask boundary and remove the blue wand tint overlay.
- [ ] Run focused selection tests and expect all tests to pass.

### Task 6: Build and end-to-end verification

**Files:**
- Generated: `static/openshop/**`

- [ ] Run the complete Vitest suite.
- [ ] Run Python font tests, localization audit, encoding audit, and the OpenShop build.
- [ ] Run Playwright desktop interaction, text properties, high-resolution, and import/performance suites.
- [ ] Inspect desktop screenshots for cursor alignment, lasso/magic-wand display, and absence of overlap.
- [ ] Confirm `git status` excludes all user-owned canvas, asset-library, and `assets/` changes from the commit.
