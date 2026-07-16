# HstarA Engineering E2E Canvas Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Permanently purge every canvas created by the three HstarA/OpenShop E2E suites after each test without scanning or touching any pre-existing or stable-installation canvas data.

**Architecture:** Add a test-only in-memory registry scoped to each Playwright spec module. A canvas ID is registered immediately after a successful create response, then `test.afterEach` purges only those registered IDs through the same engineering server URL; successful and already-missing IDs leave the registry, while failures remain pending and fail the test with their exact IDs.

**Tech Stack:** JavaScript ES modules, Vitest, Playwright APIRequestContext, HstarA FastAPI canvas API.

---

### Task 1: Add the exact-ID cleanup registry

**Files:**
- Create: `integrations/openshop/tests/hstar-test-canvas-cleanup.js`
- Create: `integrations/openshop/tests/hstar-test-canvas-cleanup.test.js`

- [ ] **Step 1: Write failing registry tests**

Create tests that define the intended API and cover registration, deduplication, successful purge, `404` idempotency, and aggregated failures:

```js
import { describe, expect, it, vi } from 'vitest';
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

function response({ok, status, body=''}) {
  return {ok:() => ok, status:() => status, text:vi.fn(async () => body)};
}

describe('HstarA E2E canvas cleanup', () => {
  it('tracks exact canvas IDs once and returns the tracked value', () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000/');
    const canvas = {id:'canvas-a'};
    expect(cleanup.track(canvas)).toBe(canvas);
    cleanup.track('canvas-a');
    cleanup.track('canvas-b');
    expect(cleanup.pendingIds()).toEqual(['canvas-a', 'canvas-b']);
  });

  it('purges registered IDs and clears successful entries', async () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000');
    cleanup.track('canvas a');
    const request = {delete:vi.fn(async () => response({ok:true, status:200}))};
    await cleanup.purgeAll(request);
    expect(request.delete).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/canvases/canvas%20a/purge'
    );
    expect(cleanup.pendingIds()).toEqual([]);
  });

  it('treats a missing canvas as already purged', async () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000');
    cleanup.track('missing');
    await cleanup.purgeAll({delete:async () => response({ok:false, status:404})});
    expect(cleanup.pendingIds()).toEqual([]);
  });

  it('reports every failed ID and keeps failures pending', async () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000');
    cleanup.track('canvas-a');
    cleanup.track('canvas-b');
    const request = {
      delete:vi.fn()
        .mockResolvedValueOnce(response({ok:false, status:500, body:'storage failure'}))
        .mockRejectedValueOnce(new Error('network failure')),
    };
    await expect(cleanup.purgeAll(request)).rejects.toThrow(/canvas-a.*canvas-b/s);
    expect(cleanup.pendingIds()).toEqual(['canvas-a', 'canvas-b']);
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run from `integrations/openshop`:

```powershell
npm.cmd test -- tests/hstar-test-canvas-cleanup.test.js
```

Expected: FAIL because `hstar-test-canvas-cleanup.js` does not exist.

- [ ] **Step 3: Implement the minimal registry**

Create `hstar-test-canvas-cleanup.js` with this public API:

```js
function exactCanvasId(canvasOrId) {
  const value = typeof canvasOrId === 'string' ? canvasOrId : canvasOrId?.id;
  const id = typeof value === 'string' ? value.trim() : '';
  if(!id) throw new TypeError('A created canvas ID is required');
  return id;
}

export function createTestCanvasCleanup(baseUrl) {
  const endpoint = String(baseUrl || '').replace(/\/+$/, '');
  if(!endpoint) throw new TypeError('HSTAR_BASE_URL is required');
  const ids = new Set();

  return {
    track(canvasOrId) {
      ids.add(exactCanvasId(canvasOrId));
      return canvasOrId;
    },
    pendingIds() {
      return [...ids];
    },
    async purgeAll(request) {
      const failures = [];
      for(const id of [...ids]) {
        try {
          const result = await request.delete(
            `${endpoint}/api/canvases/${encodeURIComponent(id)}/purge`
          );
          if(result.ok() || result.status() === 404) {
            ids.delete(id);
            continue;
          }
          const detail = await result.text().catch(() => '');
          failures.push(`${id}: HTTP ${result.status()}${detail ? ` ${detail}` : ''}`);
        } catch(error) {
          failures.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      if(failures.length) {
        throw new Error(`Failed to purge HstarA E2E canvases:\n${failures.join('\n')}`);
      }
    },
  };
}
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/hstar-test-canvas-cleanup.test.js
```

Expected: 4 tests pass with exit code 0.

- [ ] **Step 5: Commit the cleanup registry**

```powershell
git add integrations/openshop/tests/hstar-test-canvas-cleanup.js integrations/openshop/tests/hstar-test-canvas-cleanup.test.js
git commit -m "test: purge engineering E2E canvases"
```

### Task 2: Register every E2E-created canvas

**Files:**
- Modify: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`
- Modify: `integrations/openshop/tests/hstar-text-tools.e2e.spec.js`
- Modify: `integrations/openshop/tests/hstar-generative-tools.e2e.spec.js`

- [ ] **Step 1: Add a static guard test for all three suites**

Extend `hstar-test-canvas-cleanup.test.js` with these imports and checks. This prevents a future E2E helper from silently creating unregistered canvases:

```js
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const canvasCreatingSpecs = [
  'hstar-canvas-integration.e2e.spec.js',
  'hstar-text-tools.e2e.spec.js',
  'hstar-generative-tools.e2e.spec.js',
];

it.each(canvasCreatingSpecs)('registers and purges canvases in %s', fileName => {
  const source = readFileSync(resolve(testDir, fileName), 'utf8');
  expect(source).toContain(
    "import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';"
  );
  expect(source).toContain('const canvasCleanup = createTestCanvasCleanup(baseUrl);');
  expect(source).toMatch(
    /test\.afterEach\(async \(\{request\}\) => \{\s*await canvasCleanup\.purgeAll\(request\);\s*\}\);/
  );
  expect(source).toMatch(
    /const created = await apiJson\([\s\S]*?request\.post\([\s\S]*?\)\);\s*canvasCleanup\.track\(created\.canvas\);/
  );
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npm.cmd test -- tests/hstar-test-canvas-cleanup.test.js
```

Expected: the guard test fails because the E2E suites do not yet register or purge canvases.

- [ ] **Step 3: Wire the registry into each E2E suite**

In each of the three specs:

```js
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

const canvasCleanup = createTestCanvasCleanup(baseUrl);

test.afterEach(async ({request}) => {
  await canvasCleanup.purgeAll(request);
});
```

Inside each `createCanvas`, register before the first update request:

```js
const created = await apiJson(await request.post(`${baseUrl}/api/canvases`, {
  data:/* existing create payload */,
}));
canvasCleanup.track(created.canvas);
```

Do not add title scans, filesystem scans, global cleanup endpoints, or stable-installation paths.

- [ ] **Step 4: Run the focused test and verify GREEN**

Run:

```powershell
npm.cmd test -- tests/hstar-test-canvas-cleanup.test.js
```

Expected: all cleanup tests pass.

- [ ] **Step 5: Commit the three-suite integration**

```powershell
git add integrations/openshop/tests/hstar-test-canvas-cleanup.test.js integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js integrations/openshop/tests/hstar-text-tools.e2e.spec.js integrations/openshop/tests/hstar-generative-tools.e2e.spec.js
git commit -m "test: clean created canvases after E2E runs"
```

### Task 3: Verify cleanup against the engineering service

**Files:**
- No product files changed.

- [ ] **Step 1: Snapshot engineering canvas IDs**

Query `GET http://127.0.0.1:3000/api/canvases` and save only the returned ID set in memory for comparison. Confirm the running process command line points to the current worktree before destructive calls.

- [ ] **Step 2: Run the complete unit suite**

Run from `integrations/openshop`:

```powershell
npm.cmd test
```

Expected: all Vitest tests pass with exit code 0.

- [ ] **Step 3: Run all canvas-creating E2E suites**

Run with the engineering URL:

```powershell
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm.cmd run test:hstar:canvas-integration
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm.cmd run test:hstar:text-tools
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'; npm.cmd run test:hstar:generative
```

Expected: every suite passes and each `afterEach` purge request succeeds.

- [ ] **Step 4: Verify no newly created IDs remain**

Query the engineering API again and compare the exact ID set with Step 1. Expected: no IDs created by the three runs remain; all pre-existing IDs are unchanged.

### Task 4: Audit and purge historical engineering-only test canvases

**Files:**
- Read only: `data/canvases/*.json`
- No cleanup script is retained in the repository.

- [ ] **Step 1: Produce a reviewed candidate table**

Read the engineering API response, resolve each candidate's exact `data/canvases/{id}.json` under the current worktree, and list its ID, title, kind, E2E client markers, OpenShop project IDs, and test node IDs. A title alone is insufficient evidence.

- [ ] **Step 2: Freeze the exact purge list**

Keep only IDs whose worktree JSON contains unambiguous E2E markers such as `openshop-e2e-*`, `e2e_*` project IDs, or dedicated test node IDs. Do not inspect `%APPDATA%`, installed Hstar directories, or any other canvas root.

- [ ] **Step 3: Purge only the reviewed IDs**

For each frozen ID, call:

```text
DELETE http://127.0.0.1:3000/api/canvases/{exact-id}/purge
```

Abort and report the exact ID on any non-success response.

- [ ] **Step 4: Verify API and filesystem removal**

Re-query the engineering API and current worktree directory. Expected: every reviewed ID and its canvas JSON file is gone; every non-candidate ID remains.

### Task 5: Final branch verification

**Files:**
- Review only the files listed in Tasks 1 and 2 plus this plan.

- [ ] **Step 1: Inspect the scoped diff and worktree status**

Run:

```powershell
git diff --check
git status --short
git log -5 --oneline
```

Expected: no whitespace errors; pre-existing user changes remain untouched and unstaged; cleanup commits are present only on `codex/openshop-inline-generative-editing`.

- [ ] **Step 2: Re-run the focused cleanup tests**

Run:

```powershell
npm.cmd test -- tests/hstar-test-canvas-cleanup.test.js
```

Expected: all cleanup tests pass with exit code 0.

- [ ] **Step 3: Do not merge main**

Leave the verified commits on the feature branch for the user's manual application testing. Do not merge or push unless the user requests it later.
