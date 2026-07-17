import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const canvasCreatingSpecs = [
  'hstar-canvas-integration.e2e.spec.js',
  'hstar-text-tools.e2e.spec.js',
  'hstar-generative-tools.e2e.spec.js',
];

function response({ok, status, body=''}) {
  return {
    ok:() => ok,
    status:() => status,
    text:vi.fn(async () => body),
  };
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
    const request = {
      delete:vi.fn(async () => response({ok:true, status:200})),
    };

    await cleanup.purgeAll(request);

    expect(request.delete).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/canvases/canvas%20a/purge'
    );
    expect(cleanup.pendingIds()).toEqual([]);
  });

  it('treats a missing canvas as already purged', async () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000');
    cleanup.track('missing');

    await cleanup.purgeAll({
      delete:async () => response({ok:false, status:404}),
    });

    expect(cleanup.pendingIds()).toEqual([]);
  });

  it('retries a transient purge failure before leaving test data behind', async () => {
    const sleep = vi.fn(async () => {});
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000', {
      retries:2,
      retryDelayMs:1,
      sleep,
    });
    cleanup.track('busy-canvas');
    const request = {
      delete:vi.fn()
        .mockResolvedValueOnce(response({ok:false, status:500, body:'file busy'}))
        .mockResolvedValueOnce(response({ok:true, status:200})),
    };

    await cleanup.purgeAll(request);

    expect(request.delete).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1);
    expect(cleanup.pendingIds()).toEqual([]);
  });

  it('reports every failed ID and keeps failures pending', async () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000', {retries:0});
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

  it('allows canvas creation only when storage is inside the current worktree', async () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000');
    const storageRoot = resolve(testDir, '..', '..', '..', 'tmp', 'e2e-runtime');
    const request = {
      get:vi.fn(async () => ({
        ok:() => true,
        status:() => 200,
        json:async () => ({settings:{active_storage_root:storageRoot}}),
      })),
    };

    await expect(cleanup.assertStorageIsolated(request)).resolves.toBe(storageRoot);
    expect(request.get).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/software-settings'
    );
  });

  it('refuses canvas creation when storage is outside the current worktree', async () => {
    const cleanup = createTestCanvasCleanup('http://127.0.0.1:3000');
    const storageRoot = resolve(testDir, '..', '..', '..', '..', 'shared-hstar-data');
    const request = {
      get:async () => ({
        ok:() => true,
        status:() => 200,
        json:async () => ({settings:{active_storage_root:storageRoot}}),
      }),
    };

    await expect(cleanup.assertStorageIsolated(request)).rejects.toThrow(
      /outside the current HstarA worktree/
    );
  });

  it.each(canvasCreatingSpecs)('registers and purges canvases in %s', fileName => {
    const source = readFileSync(resolve(testDir, fileName), 'utf8');

    expect(source).toContain(
      "import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';"
    );
    expect(source).toContain('const canvasCleanup = createTestCanvasCleanup(baseUrl);');
    expect(source).toMatch(
      /test\.afterEach\(async \(\{page, request\}\) => \{\s*await page\.close\(\);\s*await canvasCleanup\.purgeAll\(request\);\s*\}\);/
    );
    expect(source).toMatch(
      /async function createCanvas\([\s\S]*?await canvasCleanup\.assertStorageIsolated\(request\);\s*const created = await apiJson\(await request\.post/
    );
    expect(source).toMatch(
      /const created = await apiJson\(await request\.post\([\s\S]*?\}\)\);\s*canvasCleanup\.track\(created\.canvas\);/
    );
  });
});
