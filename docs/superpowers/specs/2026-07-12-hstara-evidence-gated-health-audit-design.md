# HstarA Evidence-Gated Health Audit Design

## Goal

Perform a conservative, end-to-end health audit of the HstarA engineering repository. Detect and repair proven cross-node data leakage, task lifecycle defects, API protocol regressions, user-visible encoding defects, stale static cache keys, and regenerable development residue without changing user data or stable-installation behavior.

## Approved Approach

Use an evidence-gated, phased audit. Each behavioral defect must be reproduced before repair, covered by a failing regression test, fixed with the smallest scoped change, and verified against the complete relevant test surface. Static analysis may identify candidates, but candidate code is not changed unless its incorrect behavior or invalid artifact can be demonstrated.

## Scope

The audit includes:

- ordinary canvas node inputs, connections, prompts, references, controllers, loops, generators, outputs, logs, deletion, and persistence;
- smart canvas node inputs, workflow and input edges, prompt relays, image references, controller directives, loops, downstream generation, task recovery, and logs;
- 3D Director node and standalone data isolation, capture transfer, persistence, and cleanup behavior;
- provider configuration, protocol routing, model selection, endpoint overrides, reference-image payloads, 4K size requests, error mapping, cancellation, polling, and terminal task states;
- user-visible UTF-8 text, replacement characters, mojibake candidates, static asset references, and cache keys;
- explicitly allowlisted regenerable development caches and generated residue.

The existing ordinary-canvas and smart-canvas controller isolation repair remains part of the working baseline and must be preserved.

## Safety Boundaries

The audit must not delete or reset:

- canvases, projects, history, generated media, assets, recycle-bin records, software settings, or API configuration;
- API keys or endpoint overrides;
- the embedded Python runtime, Director dependencies, Director model assets, installer staging, or packaged installers;
- the stable Hstar installation, its port-5000 process, data, or cache.

Only paths on a resolved, repository-local cleanup allowlist may be deleted. Broad cleanup commands such as `git clean -X` are prohibited. Encoding repairs are limited to confirmed user-visible defects; no bulk rewrite of large source files is allowed.

## Canvas Data-Flow Rules

Every request input must have an explicit owner and provenance:

- direct inputs come from a connection into the target node;
- inherited inputs come only from a traversed upstream chain permitted by that node type;
- node-local settings and manually selected references belong only to that node;
- controller directives require both an enabled controller section and a valid direct or upstream connection;
- fallback logic must not scan the entire canvas and silently adopt the first, only, selected, active, or recently used unrelated node;
- deleting or disconnecting a node must remove its contribution from future requests and previews;
- data from one canvas or one Director session must never become an implicit input to another.

Tests must cover unconnected active nodes, connected disabled nodes, disconnected stale inputs, deleted nodes, multiple candidate nodes, and valid direct and inherited inputs.

## Task Lifecycle Rules

Generation and analysis tasks must have explicit ownership and terminal behavior:

- starting a task records its owning canvas and node;
- cancellation aborts local requests or polling and ignores late responses;
- explicit upstream failure ends polling, clears running state, and records a redacted log entry;
- node deletion prevents pending responses from recreating the node or restoring stale position/state;
- recovery resumes only tasks still owned by an existing node;
- timers, animation frames, event listeners, and abort controllers are released at terminal states.

## API Protocol Audit

Static and local protocol tests cover every configured provider rule without consuming paid API quota. Limited live validation is additionally authorized for `https://img.688.qzz.io` under these constraints:

- no more than 10 upstream requests for the complete audit;
- every generation request asks for 4K output and one image;
- the sequence is capability or health probe, text-to-image, image-to-image, text modification, and text removal, with additional calls only when needed to isolate a failure;
- the API key is provided only through temporary process memory or environment state and is never written to source, tests, logs, documentation, shell history artifacts, or Git;
- diagnostics may record endpoint host, provider protocol, model, requested size, status code, duration, and redacted error text;
- unsupported 4K behavior is reported as a protocol compatibility defect and is not silently downgraded;
- VPN, DNS, transport, upstream service, and local payload errors are distinguished before code changes are made.

Live outputs are test artifacts and must not be inserted into user canvases, history, or asset libraries unless the user explicitly requests it later.

## Encoding and Static Resource Audit

Tracked text and structured files are decoded as UTF-8 or UTF-8 with BOM where already established. JSON must parse successfully. Candidate mojibake is identified using replacement characters, common broken UTF-8 byte sequences rendered as text, and suspicious placeholder patterns.

A candidate is repaired only when the intended user-visible text can be proven from a clean source, matching UI copy, translation key, or valid counterpart. Console-only browser-injection noise and PowerShell display-decoding artifacts are not source defects.

Every changed static JavaScript or CSS file receives a cache key derived from the repository version and file modification time. The global static-cache integrity test remains authoritative.

## Cleanup Policy

The previously approved cleanup allowlist remains the starting point:

- root `__pycache__` and Python bytecode generated by local checks;
- Director `tsconfig*.tsbuildinfo`;
- generated Director `vite.config.js` and `vite.config.d.ts` when they are confirmed build residue rather than tracked source.

Additional cleanup targets require all of the following evidence:

1. the path is inside the active repository;
2. the path is ignored or proven generated;
3. the artifact can be recreated from tracked source;
4. no runtime, installer, model, dependency, or user-data path depends on it;
5. protected-path fingerprints remain unchanged after deletion.

## Verification

Each repair uses a red-green regression cycle. Final verification includes:

1. targeted tests for every confirmed defect;
2. every root `tools/tests/*.test.mjs` test;
3. the complete 3D Director Vitest suite;
4. tracked JavaScript, MJS, Python, and JSON syntax or parse checks;
5. static cache-key integrity;
6. live HstarA health checks on port 3000 while leaving port 5000 untouched;
7. browser checks for the ordinary canvas, smart canvas, shell, API settings, online archive, and Director entry points;
8. protected-path and API configuration fingerprint comparison;
9. a clean review of the final Git diff, with unrelated working changes preserved.

## Success Criteria

The audit is complete only when:

- no proven feature block can enter an unrelated node, canvas, or Director session;
- prompts, images, markers, controllers, loops, and Director captures follow explicit graph or ownership rules;
- failed, cancelled, deleted, and recovered tasks reach correct terminal states and cannot resurrect stale nodes;
- configured 4K text-to-image and image-to-image protocol behavior has been validated within the 10-request limit;
- confirmed user-visible encoding defects are fixed without bulk source rewriting;
- static cache keys match changed assets;
- only approved regenerable development residue is removed;
- all required automated, health, and browser checks pass;
- user data, API configuration, protected resources, and the stable installation remain unchanged.

