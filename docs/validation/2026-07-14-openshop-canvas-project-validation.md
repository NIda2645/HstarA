# OpenShop Canvas Project Integration Validation

## Storage

- Project schema: `1`; every project is owned by one `canvasType/canvasId/nodeId` tuple.
- Test storage: isolated temporary `HSTAR_DATA_DIR`; `/api/canvases` returned `[]` before each clean end-to-end run.
- Atomic save and optimistic version conflict checks passed. A stale `base_version` is rejected with HTTP `409`.
- Cross-node project access is rejected. Clone manifests are deep-copied while content-addressed image assets remain shared.
- Image limit: `64 MiB`; accepted MIME types are PNG, JPEG, and WebP; decoded dimensions are limited to `16384 x 16384`.
- Image asset IDs are SHA-256 content digests. Duplicate image bytes reuse one asset; deletion and canvas purge garbage-collect zero-reference assets.
- Project JSON stores asset IDs and same-origin URLs only. Canvas and project records contained no long-lived `data:image/` or `blob:` values.
- Command: `node tools/tests/openshop-project-storage.test.mjs`, exit code `0`.

## Classic canvas

- Created and opened an `openshop-layered` node with three connected image sources in persisted connection order.
- Manual save, autosave, close, page reload, and reopen restored editor objects, user text, source metadata, preview metadata, and autosave version.
- Same-canvas nodes A and B retained independent text and project data.
- Node clone received a new project ID, restored the source project, and diverged without mutating the source.
- Node deletion removed only the owned project. Canvas soft delete retained project data; permanent purge removed it.
- Every `Send to canvas` request created a new normal image node and connection back to the originating layered node.
- The OpenShop welcome overlay is hidden after the first host project restore, so the actual editor workspace is immediately usable.

## Smart canvas

- Created and opened a smart `openshop-layered` node with independent project ownership.
- Project save and output persistence used the same manifest and asset APIs as the classic canvas.
- Every `Send to canvas` request created a new smart image output without replacing an earlier output.
- Smart output import saved the canvas and retained same-origin asset metadata without inline image bytes.

## Source lifecycle

- Initial source order remained stable when image decoding completed out of order.
- A changed source produced exactly one `update-available` binding and exposed `Replace layer`, `Add as new layer`, and `Ignore` choices.
- `Add as new layer` kept the previous pixels as a detached layer and made the new version the only active binding for that edge.
- Disconnected sources remained visible as detached layers; reconnect and later updates did not destroy retained pixels.
- Editor mutation messages now run in arrival order. `SYNC_SOURCES` waits for `LOAD_PROJECT` restoration to finish.
- Historical duplicate active bindings are healed by selecting the newest active layer matching the current source version and detaching the other bindings.
- Clean E2E persistence result: `classic-edge-1` had `0` active bindings after disconnect; `classic-edge-2` had `2` retained layers and `1` active binding; `classic-edge-3` had `1` retained layer and `1` active binding.
- Late save messages from a previous node session were rejected and did not change the active node or autosave version.

## Isolation

- Same-canvas nodes, cloned nodes, classic and smart canvases, and output projects used distinct project IDs and owners.
- Reopening node A after editing node B restored only A data.
- A full shell reload restored the same project from the server manifest.
- Deleting one node or project did not remove another project's shared content-addressed assets.
- Canvas integration gate: `npm.cmd run test:hstar:canvas-integration`, exit code `0`, `2/2` passed in `12.1 s` on the final clean run.

## Visual and performance

- Inspected classic cards, smart cards, output nodes, the full-screen host, the real OpenShop workspace, saved state, failed-save state, and source-update panel.
- Viewports: `1440 x 1000`, `1920 x 1080`, and `430 x 932`.
- Final editor state during visual inspection: welcome display `none`, `5` layers, `4` source layers, and `5` Fabric objects.
- Desktop host toolbar had no horizontal overflow. At `430 x 932`, toolbar client width was `316 px` and scroll width was `469 px`; return, save, and send actions remained reachable by horizontal scrolling.
- Source panel bounds stayed within the host at all viewports. The mobile panel occupied the available host width and retained all three resolution actions.
- Simulated save failure displayed readable Chinese status text. Final visual run reported page errors `[]`.
- 4K baseline: `4096 x 4096`, `10` raster layers, create `1289.8 ms`, serialize `0.7 ms`, preview `4.6 ms`, serialized project `15,465` bytes, preview data URL `40,106` bytes, remaining source layers `0`, and no browser crash.
- Screenshots were temporary QA artifacts and were removed after inspection.

## Build

- Static runtime contains exactly `26` approved files and excludes tests, `node_modules`, caches, project manifests, logs, and temporary data.
- Integration source and `static/openshop` host protocol, project adapter, and runtime mirrors matched byte-for-byte.
- Repeated build fingerprint: `721f2a04b85e8f531db728e0323a6d6e7ae5b74a4e5f2821bdab3df55a1c8f61`.
- Commands: `npm.cmd run build:hstar`, `node tools/tests/openshop-foundation-build.test.mjs`, and `node tools/tests/openshop-localization-build.test.mjs`; all exited `0`.

## Regression

- Internationalization audit: `734/734` translated keys and `34` glossary entries.
- OpenShop unit suite: `npm.cmd test`, exit code `0`, `57/57`.
- Original OpenShop Playwright suite: `npm.cmd run test:e2e`, exit code `0`, `6/6`.
- Localization/offline Playwright suite: `npm.cmd run test:hstar:localization`, exit code `0`, `6/6`.
- Same-origin and 4K Playwright suite: `npm.cmd run test:hstar:e2e`, exit code `0`, `2/2`.
- Canvas project Playwright suite: `npm.cmd run test:hstar:canvas-integration`, exit code `0`, `2/2`.
- HstarA root suite after startup cache-key synchronization: `node --test tools/tests/*.test.mjs`, exit code `0`, `66/66`.
- Encoding health: `node tools/tests/text-encoding-health.test.mjs`, exit code `0`.
- Repository health: `node tools/tests/hstarc-health-check.mjs`, exit code `0`.
- Whitespace validation: `git diff --check`, exit code `0`.
- Runtime-generated full-site HTML cache-version stamps were removed and were not included in the integration commit.

## Scope gate

- No global HstarA API/model selector was added in this phase.
- No text extraction, text removal, generative fill, local redraw, or AI-generated-layer button was added in this phase.
- Searches of `static/js/openshop-host.js`, `static/js/canvas-openshop.js`, and `static/js/smart-canvas-openshop.js` returned no phase-4/5 feature labels or API selector controls.

## Decision

`CONTINUE`

All phase-3 gates passed: classic and smart project ownership, persistence, source lifecycle, cloning, deletion, output delivery, session isolation, deterministic build, visual states, 4K stability, encoding, and HstarA regression. Phase 4 may begin with global API selection and text extraction as a separate implementation plan.
