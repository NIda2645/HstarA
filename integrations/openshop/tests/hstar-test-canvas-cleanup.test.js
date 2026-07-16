import { describe, expect, it, vi } from 'vitest';
import { createTestCanvasCleanup } from './hstar-test-canvas-cleanup.js';

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
