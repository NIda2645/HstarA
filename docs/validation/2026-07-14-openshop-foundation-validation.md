# OpenShop Foundation Validation

## Baseline

- Upstream repository: `https://github.com/SysAdminDoc/Openshop.git`
- Upstream commit: `60c93382868849b1f4f9b073f9519ae61136a05b`
- OpenShop version: `0.19.1`
- Original unit suite: `20 passed`
- Original Playwright suite: `6 passed`
- Current combined OpenShop unit suite: `npm.cmd test`, exit code `0`, `32 passed`

## Host foundation

- Protocol: `npm.cmd test -- tests/hstar-protocol.test.js`, exit code `0`, `2 passed`
- Project adapter: `npm.cmd test -- tests/hstar-project-adapter.test.js`, exit code `0`, `4 passed`
- Host runtime: `npm.cmd test -- tests/hstar-host-runtime.test.js`, exit code `0`, `5 passed`
- Same-origin host and 4K suite: `npm.cmd run test:hstar:e2e`, exit code `0`, `2 passed`
- Stable source ordering: `第一张.png`, `第二张.png`; source sequences `0`, `1`
- Project scope: `openshop:classic:canvas-1:node-1:project-1`
- Served URL: `http://127.0.0.1:3010/static/openshop/index.html`
- HTTP status: `200`
- Static host runtime marker: present

## PSD gate

- Dependency evaluated: `ag-psd@22.0.2`
- Structural test: `npm.cmd test -- tests/hstar-psd-probe.test.js`, exit code `0`, `1 passed`
- Probe generation: `node scripts/psd-text-probe.mjs`, exit code `0`, `PSD_STRUCTURE_PASS`
- Probe file: `integrations/openshop/tests/golden/openshop-text-layer-probe.psd`
- Probe size: `45,138 bytes`
- Structural round trip: `PASS`
- Photoshop: Adobe Photoshop 2023, version `24.7.4.1251`
- Photoshop opens file: `PASS`
- Text-layer recognition: `PASS`; both layers appeared with editable-text layer icons
- Initial text-layer update warning: `PRESENT`
- Edit layout-change warning: `PRESENT`
- Chinese source text rendering after accepting the update: `PASS`; `经典奶茶` rendered at the expected position and dark color
- Chinese text remains editable: `FAIL`; Photoshop crashed while attempting to replace the text with `快乐一天`
- Crash evidence: Windows Application Error and Windows Error Reporting at `2026-07-14 15:56:46`, exception `0xc0000005`, fault offset `0x000000000062382d`
- English text remains editable: `NOT RUN`; the Photoshop process crashed during the Chinese edit attempt before a safe English edit could be performed
- Probe file preservation: `PASS`; the file remained `45,138 bytes` with its original modification time and was not saved by Photoshop
- Writer decision: `REJECT_AG_PSD_TEXT_WRITER`

The structural PSD round trip is not sufficient evidence of Photoshop editability. Subsequent implementation must not use this `ag-psd` text-layer writer for production PSD export. A different writer or a Photoshop-compatible PSD service must pass the same executable gate before it can be adopted.

## 4K gate

- Command: `npm.cmd run test:hstar:e2e`, exit code `0`
- Document: `4096 x 4096`
- Generated raster layers: `10`
- Create duration: `1,464 ms`
- Serialize duration: `0.7000000029802322 ms`
- Composite preview duration: `5 ms`
- Serialized project size: `11,515 bytes`
- Composite preview data URL size: `40,106 bytes`
- Remaining source layers after cleanup: `0`
- Browser crash: `ABSENT`
- Page errors: `ABSENT`

These are baseline measurements, not product performance limits. The preview is a 1024-pixel scaled composite of the 4096 x 4096 document.

## Regression evidence

- Original browser suite: `npm.cmd run test:e2e`, exit code `0`, `6 passed`
- HstarA OpenShop browser suite: `npm.cmd run test:hstar:e2e`, exit code `0`, `2 passed`
- HstarA root suite: `node --test tools/tests/*.test.mjs`, exit code `0`, `61 passed`
- Host protocol mirror: `node tools/tests/openshop-protocol.test.mjs`, exit code `0`
- Deterministic static build: `node tools/tests/openshop-foundation-build.test.mjs`, exit code `0`
- Encoding health: `node tools/tests/text-encoding-health.test.mjs`, exit code `0`
- Repository health: `node tools/tests/hstarc-health-check.mjs`, exit code `0`
- Whitespace validation: `git diff --check`, exit code `0`, no output

## Decision

`CONTINUE`

Protocol versioning, same-origin source validation, node-isolated project scope, stable source ordering, deterministic static build, and the 4K ten-layer baseline all passed. The PSD investigation produced an explicit rejection rather than an unresolved result: `ag-psd@22.0.2` must not be used as the production editable-text writer. Phase 2 may proceed with OpenShop localization and offline runtime work while PSD export remains behind a replacement-writer gate.
