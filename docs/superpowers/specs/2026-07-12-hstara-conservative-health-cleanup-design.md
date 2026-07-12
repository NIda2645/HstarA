# HstarA Conservative Health Cleanup Design

## Goal

Remove only regenerable development caches from HstarA, then rerun the existing health checks without changing application behavior or user data.

## Scope

The cleanup may remove:

- root `__pycache__` directories and `*.pyc` files;
- `integrations/storyai-3d-director-desk/tsconfig*.tsbuildinfo`;
- generated `integrations/storyai-3d-director-desk/vite.config.js` and `vite.config.d.ts`.

The cleanup must not remove or modify:

- `API/` or any API key/configuration file;
- canvas, project, history, output, asset-library, or software-settings data;
- `build/installer/stage/` or installer artifacts;
- the embedded `python/` runtime;
- Director `node_modules/` or model assets;
- the stable Hstar installation, its port-5000 service, data, or cache.

## Implementation

Resolve each candidate to an absolute path under the HstarA repository root before deletion. Delete only the explicitly listed regenerable files and directories; do not use broad cleanup commands such as `git clean -X`.

No source-code repair is included. The full test suite, UTF-8 JSON validation, syntax checks, live API health checks, and isolated browser page checks passed. The `MutationObserver` error reproduced only in the Codex in-app browser and did not reproduce in Chrome, so it is treated as browser-injection noise rather than an HstarA defect. The bundled Tailwind runtime warning is retained for a separate, visually verified CSS migration.

## Verification

After cleanup:

1. Confirm the approved cache paths are absent and protected paths still exist.
2. Confirm `git status` contains no unintended changes.
3. Run all root Node tests.
4. Run all 3D Director Vitest tests.
5. Validate tracked JSON with Node UTF-8 parsing.
6. Run JavaScript and Python syntax checks.
7. Run the live HstarA health check against port 3000.

The cleanup is complete only when all checks pass and port 5000 remains untouched.
