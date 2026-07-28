import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const schedulerPath = resolve(testDir, '..', 'host', 'openshop-update-scheduler.js');

function createHarness({visibility = {}} = {}) {
  const frameQueue = [];
  const idleQueue = [];
  const handlers = {
    layers:vi.fn(),
    status:vi.fn(),
    minimap:vi.fn(),
    histogram:vi.fn(),
  };
  const onError = vi.fn();
  const scheduler = window.HstarOpenShopUpdateScheduler.create({
    frameRequest:callback => {
      frameQueue.push(callback);
      return frameQueue.length;
    },
    idleRequest:callback => {
      idleQueue.push(callback);
      return idleQueue.length;
    },
    handlers,
    idleKeys:['minimap', 'histogram'],
    isVisible:key => visibility[key] !== false,
    onError,
  });
  return {scheduler, frameQueue, idleQueue, handlers, onError, visibility};
}

describe('OpenShop update scheduler', () => {
  beforeEach(() => {
    delete window.HstarOpenShopUpdateScheduler;
    new Function(readFileSync(schedulerPath, 'utf8'))();
  });

  it('coalesces duplicate frame updates', () => {
    const {scheduler, frameQueue, handlers} = createHarness();

    scheduler.request('layers', 'layers', 'status');

    expect(frameQueue).toHaveLength(1);
    frameQueue.shift()();
    expect(handlers.layers).toHaveBeenCalledOnce();
    expect(handlers.status).toHaveBeenCalledOnce();
    expect(scheduler.isDirty('layers')).toBe(false);
  });

  it('coalesces idle updates separately from frame work', () => {
    const {scheduler, frameQueue, idleQueue, handlers} = createHarness();

    scheduler.request('layers', 'minimap', 'histogram', 'minimap');

    expect(frameQueue).toHaveLength(1);
    expect(idleQueue).toHaveLength(1);
    frameQueue.shift()();
    expect(handlers.layers).toHaveBeenCalledOnce();
    expect(handlers.minimap).not.toHaveBeenCalled();
    idleQueue.shift()({didTimeout:false, timeRemaining:() => 10});
    expect(handlers.minimap).toHaveBeenCalledOnce();
    expect(handlers.histogram).toHaveBeenCalledOnce();
  });

  it('keeps a hidden idle panel dirty until it becomes visible', () => {
    const visibility = {minimap:false};
    const {scheduler, idleQueue, handlers} = createHarness({visibility});

    scheduler.request('minimap');
    expect(idleQueue).toHaveLength(1);
    idleQueue.shift()({didTimeout:false, timeRemaining:() => 10});

    expect(handlers.minimap).not.toHaveBeenCalled();
    expect(scheduler.isDirty('minimap')).toBe(true);
    expect(idleQueue).toHaveLength(0);

    visibility.minimap = true;
    scheduler.flushVisible('minimap');
    expect(handlers.minimap).toHaveBeenCalledOnce();
    expect(scheduler.isDirty('minimap')).toBe(false);
  });

  it('isolates handler failures and continues other updates', () => {
    const {scheduler, frameQueue, handlers, onError} = createHarness();
    handlers.layers.mockImplementation(() => { throw new Error('layers failed'); });

    scheduler.request('layers', 'status');
    frameQueue.shift()();

    expect(onError).toHaveBeenCalledWith(expect.any(Error), 'layers');
    expect(handlers.status).toHaveBeenCalledOnce();
    expect(scheduler.isDirty('layers')).toBe(false);
  });

  it('ignores new requests after disposal', () => {
    const {scheduler, frameQueue, idleQueue, handlers} = createHarness();
    scheduler.dispose();

    scheduler.request('layers', 'minimap');
    scheduler.flushVisible('layers', 'minimap');

    expect(frameQueue).toHaveLength(0);
    expect(idleQueue).toHaveLength(0);
    expect(handlers.layers).not.toHaveBeenCalled();
    expect(handlers.minimap).not.toHaveBeenCalled();
  });
});
