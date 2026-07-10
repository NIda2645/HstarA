# HstarA 3D Director Desk Integration Design

Date: 2026-07-10

## 1. Purpose

Integrate the source of `NIda2645/storyai-3d-director-desk` into HstarA as a built-in "3D Director Desk" feature while preserving the current HstarA engineering and installed-app architecture.

The integration must:

- Add a "3D Director Desk" entry directly below "Infinite Canvas" in the HstarA left sidebar.
- Run through HstarA's existing FastAPI static service on port `3000` in the engineering project and port `5000` in the installed application.
- Add a lightweight 3D Director node to both the ordinary canvas and the smart canvas.
- Accept one connected image as the scene panorama or background.
- Return 1, 4, or 12 Director captures to the originating canvas as one grouped multi-image output node.
- Preserve the upstream model-library categories and interface exactly, including empty categories and the custom FBX/OBJ upload flow.
- Let the standalone sidebar entry send captures to a newly created canvas or any existing ordinary or smart canvas.
- Keep every canvas node's 3D scene isolated and persistent.

The pinned upstream baseline is commit `8c8bd36` (`Update README.md`). The upstream MIT license and repository attribution will be retained with the vendored source.

## 2. Scope Boundaries

### In scope

- Vendoring the upstream React, TypeScript, and Three.js source into HstarA.
- Producing a relative-path-safe production build under `static/3d-director/`.
- HstarA sidebar, iframe shell, message router, ordinary-canvas adapter, and smart-canvas adapter.
- Director nodes, panorama linkage, scene persistence, capture return, target-canvas selection, canvas creation, navigation, and focus restoration.
- Windows dependency correction, upstream test reconciliation, integration tests, browser visual checks, and installer payload checks.
- Repairing mojibake found in the integrated upstream source without changing the intended upstream behavior.

### Out of scope

- Running a separate Vite development or production service.
- Embedding a live WebGL renderer inside every canvas node.
- Replacing HstarA's existing project, canvas, node, edge, or image-output data models.
- Populating empty model-library categories with sample models.
- Changing the existing Hstar stable application's data, cache, or port `5000` runtime during engineering work.
- Rebuilding or overwriting the current `Hstar_Setup_2026.07.10.exe` as part of this feature implementation.

## 3. Chosen Integration Approach

The selected approach is source-integrated static hosting.

The upstream project will be stored at:

```text
integrations/storyai-3d-director-desk/
```

Its production assets will be built into:

```text
static/3d-director/
```

HstarA will load the built application in a same-origin, full-screen iframe. This preserves the upstream React/Three.js architecture while avoiding a second server, a second port, and tight coupling between the Director renderer and HstarA's existing large canvas scripts.

The alternatives considered and rejected were:

1. A separately running Vite service. It adds lifecycle, port, installer, and cross-origin complexity.
2. Directly rewriting the Director application into HstarA's canvas JavaScript. It creates excessive coupling and makes upstream source maintenance and testing substantially harder.

## 4. Repository and Build Layout

The vendored integration contains upstream source, tests, package metadata, and the MIT license. It excludes `node_modules`, development caches, and generated temporary files.

The upstream `package.json` currently declares `@rollup/rollup-darwin-arm64` directly. That platform-specific dependency will be removed so that a clean Windows `npm ci` works without `--force`. Platform-specific Rollup binaries remain managed through Rollup's supported optional dependency mechanism.

Vite will use `base: "./"` so every generated asset URL is relative to `static/3d-director/index.html`. All runtime assets, including the UE mannequin GLB and model-library resources, must resolve from the built directory without external links.

Required clean-build commands are:

```text
npm ci
npm test
npm run build
```

The built files are part of the HstarA application and installer payload. HstarA itself continues to start exactly as it does now.

## 5. HstarA Shell Integration

`static/index.html` remains the owner of the primary sidebar and page switching.

The integration adds:

- A "3D Director Desk" sidebar item immediately below "Infinite Canvas".
- A registered page ID and a lazily loaded, full-screen iframe targeting `static/3d-director/index.html`.
- A single shell-level Director host controller that owns iframe activation, context dispatch, message validation, return navigation, and render pause/resume.

The iframe is loaded once and reused. Opening it dispatches a new session context; leaving it pauses the Three.js render loop. Returning resumes rendering and reopens the correct scoped scene.

The Director UI, model-library categories, panels, controls, and upload affordances remain visually and functionally equivalent to the upstream project. HstarA does not hide empty model categories.

## 6. Canvas Node Design

Both canvas types receive a lightweight "3D Director Desk" node. The card contains the node title, connection ports, scene status, panorama status, and an action to open the Director. It does not contain a live WebGL viewport.

Every node receives a stable scene scope key derived from:

```text
director:<canvasType>:<canvasId>:<nodeId>
```

Where `canvasType` is `classic` or `smart`. The standalone sidebar entry uses:

```text
director:standalone
```

The scope key is created once, saved with the node, and reused after reload. Renaming or moving a node does not change it. Deleting a node makes that scope unreachable from HstarA; the host rejects late messages for the deleted node.

Scene data continues to use the upstream Director store and its scoped persistence. The scope key prevents two nodes or two canvases from sharing scene state. Local FBX/OBJ model-library assets continue to use the upstream local-model persistence flow and can be referenced by any scoped scene available in the same HstarA profile.

## 7. Host Bridge Protocol

The existing `storyai:director-desk-*` message family is retained and extended through one versioned envelope:

```text
type
protocolVersion
sessionId
requestId
context { mode, canvasType, canvasId, nodeId, instanceId }
payload
```

Supported host-to-Director operations include:

- Open scoped session and apply the current HstarA theme.
- Set, replace, or clear the connected panorama.
- Pause and resume rendering.
- Confirm or reject a capture import.

Supported Director-to-host operations include:

- Ready.
- Close and return to origin.
- Panorama removed.
- Captures sent.
- Request the "Send to Canvas" target picker.
- Report a recoverable or terminal Director error.

The host accepts messages only when all of the following are true:

- `event.origin` exactly equals `window.location.origin`.
- `event.source` is the registered Director iframe window.
- The protocol version is supported.
- `sessionId` matches the currently active session.
- Canvas type, canvas ID, node ID, and instance ID match the active context.
- The target canvas and node still exist for node-originated sessions.
- The request has not already been applied.

`requestId` values are recorded for the active session so iframe retries cannot create duplicate output nodes.

## 8. Panorama Input Flow

A Director node accepts exactly one active image input edge.

When an image node is connected:

1. The canvas adapter resolves the source node's usable image URL or data URL.
2. It validates that the value is an image and is available to the same-origin Director iframe.
3. The host sends the panorama payload with the edge ID, source node ID, file name, and image source.
4. The Director imports it as a backdrop panorama for that scoped scene.
5. Replacing the input edge replaces only the panorama reference; it does not reset models, cameras, lighting, poses, or other scene state.

Removing the panorama from inside the Director sends `storyai:director-desk-panorama-removed`. The originating adapter deletes only the matching background edge/reference. It never deletes the upstream image node or unrelated scene content.

Invalid, missing, or inaccessible image sources produce a visible error and leave the previous valid panorama unchanged.

## 9. Capture Return From Canvas Nodes

The Director can return 1, 4, or 12 captures in one batch.

For a node-originated session:

1. The Director sends one capture batch with a unique request ID.
2. The host verifies the active node still exists and validates every capture.
3. The ordinary-canvas adapter creates one existing multi-image Output node.
4. The smart-canvas adapter creates one existing Group/Image output structure.
5. The adapter positions the new output to the right of the Director node, using collision-aware placement.
6. It creates an edge from the Director node to the new output.
7. It saves the canvas through the existing persistence path.
8. It restores the originating canvas, viewport, and selection, then focuses the new output node.
9. The host acknowledges success so the Director can close or clear its pending-send state.

One batch always creates one grouped output, not one node per capture. A partial or invalid capture batch is rejected as a whole to avoid silently incomplete outputs.

## 10. Standalone "Send to Canvas" Flow

The direct sidebar entry opens the `director:standalone` scene. Selecting "Send to Canvas" opens a HstarA-owned target picker over the Director page.

The picker displays:

- "New Canvas" with a required name and a `classic` or `smart` selector.
- Every existing canvas, showing project, canvas type, title, and last update time.

Existing entries are populated through HstarA's current `/api/projects` and `/api/canvases` APIs. The picker refreshes its list each time it opens.

For an existing target, HstarA imports the batch through the matching canvas adapter. For a new target, HstarA first creates the canvas through the existing API and then imports the batch. On success, it saves the target, opens that canvas, and focuses the new grouped multi-image node.

If creation or import fails, the Director remains open, the captured batch remains available for retry, and no half-created output is considered successful. If a newly created canvas exists but output insertion fails, the error identifies that canvas and allows retrying into it without creating another canvas.

## 11. Navigation and View State

When a Director node is opened, the host snapshots:

- Current page and canvas type.
- Project and canvas ID.
- Viewport pan and zoom.
- Selected node IDs.
- Originating Director node ID.

Closing without sending returns to the origin and restores that snapshot. Successful sending restores the viewport and then selects and focuses the newly created output. A stale or deleted origin returns to the canvas list with a clear notice instead of trying to revive deleted state.

## 12. Rendering Lifecycle and Performance

Only the full-screen Director iframe owns a Three.js renderer. Canvas cards stay DOM-only.

The Director render loop pauses when:

- Its HstarA page is inactive.
- The iframe is hidden.
- The document is not visible.

It resumes only when the iframe becomes active again. Event listeners, observers, object URLs, and WebGL resources created for a session are cleaned up when replaced or no longer needed. WebGL context loss produces a recoverable state with a retry action; it does not corrupt the saved scene.

## 13. Error Handling and Data Safety

The integration must provide explicit terminal states for failed operations rather than leaving indefinite loading indicators.

Handled cases include:

- Deleted or changed target canvas/node.
- Invalid panorama URL, data URL, or image payload.
- Duplicate or late message delivery.
- Capture decoding or storage failure.
- Browser storage quota exhaustion.
- WebGL context loss or unsupported WebGL.
- Canvas creation or save API failure.
- Missing built asset or model resource.

Scene persistence failures keep the current in-memory session usable and show that changes are not fully persisted. Capture import is transactional at the adapter level: output node creation, image assignment, edge creation, and save must all complete before success is acknowledged.

Engineering work must not read, migrate, clear, or overwrite the installed stable Hstar application's data and cache. Tests run against HstarA on port `3000` and disposable test canvases.

## 14. Test Strategy

### Upstream Director tests

The current upstream baseline builds but reports 304 passing and 8 failing tests. The integration will first preserve the currently visible intended behavior, repair mojibake, and reconcile those stale assertions so the vendored suite passes without hiding failures.

Coverage includes:

- Scoped scene loading and persistence.
- Panorama import, replacement, and removal notification.
- Capture batching and host acknowledgements.
- Model-library categories and local FBX/OBJ flow.
- Render pause/resume and cleanup.
- Same-origin and session validation.

### HstarA integration tests

Coverage includes:

- Sidebar placement and Director page switching.
- Ordinary and smart Director node creation.
- One-image panorama linkage and removal semantics.
- Scene isolation across canvas type, canvas ID, and node ID.
- 1, 4, and 12 capture return as one grouped output.
- Automatic right-side placement, connection, save, navigation, and focus.
- Standalone picker listing projects and canvases.
- New ordinary and smart canvas creation.
- Deleted targets, duplicate requests, invalid captures, and save failures.

### Browser and packaging verification

Desktop and mobile browser checks verify:

- The Three.js canvas is nonblank through screenshot and canvas-pixel checks.
- The scene is correctly framed and interactive.
- No controls or text overlap.
- Relative static assets and the UE mannequin GLB load successfully.
- Hiding the iframe pauses rendering and returning resumes it.

The final verification also runs HstarA's full health checks, mojibake scan, static-reference scan, and installer payload validation. Installer creation remains a separate explicit release step.

## 15. Acceptance Criteria

The feature is accepted when all of the following are true:

1. "3D Director Desk" appears directly below "Infinite Canvas" and opens the upstream Director interface within HstarA.
2. HstarA requires no additional runtime service or port.
3. A Director node can be created, opened, saved, and reopened independently in both canvas types.
4. A connected image becomes the active panorama, and removing it affects only that panorama linkage.
5. 1, 4, or 12 captures return as one grouped output node to the right of the source node, connected and persisted.
6. The standalone entry can send captures to a named new ordinary/smart canvas or any listed existing canvas, then open and focus the imported output.
7. The complete upstream model-library interface remains present, and custom FBX/OBJ upload still works.
8. Same-origin, session, target, and deduplication checks prevent stale or duplicate imports.
9. A clean Windows install, test, and build succeeds; HstarA integration and browser checks pass.
10. No mojibake remains in the integrated user-facing source or built output.
11. The stable installed Hstar application's data and cache remain untouched.
