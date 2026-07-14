# OpenShop Localization and Offline Runtime Validation

## Runtime dependencies

- OpenShop version: `0.19.1`.
- Runtime manifest: schema `1`, `10` checksum-controlled files.
- Runtime packages: `ag-psd@22.0.2`, `fabric@5.3.1`, `gif.js@0.2.0`, `jspdf@4.2.1`, `@silvia-odwyer/photon@0.3.3`, `onnxruntime-web@1.25.0-dev.20260327-722743c0e2`, and `@huggingface/transformers@4.0.0`.
- Manifest and build mirror: `node tools/tests/openshop-localization-build.test.mjs`, exit code `0`; all `10` runtime SHA-256 digests and byte counts matched, and the build contained exactly `26` approved files.
- Deterministic rebuild: pre-build and post-build tree fingerprints both equaled `5d68b1bf5b98e64cde5caff331cbb3207baf5b7e46c732afcd61adfa063089a3`.
- Production dependency audit: `npm.cmd audit --omit=dev`, exit code `0`, `0` vulnerabilities.

## Localization

- Localization audit: `734` keys, `734` translated, `34` Photoshop glossary entries; exit code `0`.
- Default locale: `zh-CN`.
- English fallback: `en-US`; the original English Playwright suite passed `6/6`.
- User layer names, canvas text, filenames, and custom preset names remained unchanged across dialogs and locale switches.
- Command palette labels, categories, search, dynamic messages, dialogs, status text, history actions, tooltips, and accessibility summaries were verified in Simplified Chinese.

## Offline gate

- Served URL: `http://127.0.0.1:3010/static/openshop/index.html`.
- Blocked external request list: `[]`.
- Page error list: `[]`.
- Offline operation result: created a `320 x 240` document, added one generated raster layer, applied Sharpen, completed undo and redo, opened Preferences, and exported a PNG preview data URL.
- Observed result: `layerCount=1`, `previewBytes=1198`, `preferencesVisible=true`, `historyAction="Filter: Sharpen"`.

## Visual gate

- Inspected viewports: `1440 x 1000`, `1920 x 1080`, `375 x 667`, and `430 x 932`.
- Inspected states at every viewport: Welcome, workspace, Preferences, New Image, filter dialog, and command palette, producing `24` matrix screenshots plus one final corrected `375 x 667` Preferences screenshot.
- Corrected mobile Welcome layout so all four primary actions remain in the initial viewport while templates scroll normally.
- Corrected command palette labels and categories to use the Chinese dictionary while retaining bilingual search.
- Corrected mobile modal sizing so a `375`-pixel viewport retains `12`-pixel side margins; final modal bounds were `x=12`, `width=351`.
- Command results remain inside the command palette's scroll container. No page errors, overlapping controls, clipped primary actions, or unreadable Chinese were observed in the final screenshots.

## Regression

- Internationalization audit: `npm.cmd run audit:i18n`, exit code `0`, `734/734`.
- OpenShop unit suite: `npm.cmd test`, exit code `0`, `40/40`.
- Original OpenShop Playwright suite: `npm.cmd run test:e2e`, exit code `0`, `6/6`.
- Hstar localization and offline Playwright suite: `npm.cmd run test:hstar:localization`, exit code `0`, `6/6`.
- Hstar same-origin and 4K Playwright suite: `npm.cmd run test:hstar:e2e`, exit code `0`, `2/2`.
- 4K baseline: `4096 x 4096`, `10` layers, create `1303.3 ms`, serialize `0.6 ms`, preview `5.2 ms`, serialized project `11,515` bytes, preview data URL `40,106` bytes, and `0` remaining source layers.
- HstarA root suite: after the project's static HTML cache-key synchronization converged, `node --test tools/tests/*.test.mjs` exited `0` with `62/62`.
- Encoding health: `node tools/tests/text-encoding-health.test.mjs`, exit code `0`.
- Repository health: `node tools/tests/hstarc-health-check.mjs`, exit code `0`; audited OpenShop vendor subtrees are checksum-gated instead of scanned as application text.
- Whitespace validation: `git diff --check`, exit code `0` with no whitespace errors.
- Validation server: stopped; port `3010` no longer listens. Runtime-generated HTML version-stamp changes were removed from the worktree.

## Decision

`CONTINUE`

The localized OpenShop runtime is complete for this phase: its basic editor runs without remote executable dependencies, default and fallback locales pass, visual regressions are covered, and the HstarA build and regression gates pass. Canvas node persistence, HstarA global API selectors, and AI editing controls remain outside this phase and have not been started.
