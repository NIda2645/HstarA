import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-selection-engine.js');

function imageData(width, height, pixels){
  const data = new Uint8ClampedArray(width * height * 4);
  pixels.forEach(([r, g, b, a = 255], index) => {
    data.set([r, g, b, a], index * 4);
  });
  return {data, width, height};
}

describe('Hstar OpenShop Photoshop-style selection engine', () => {
  beforeEach(async () => {
    expect(existsSync(runtimePath), `${runtimePath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopSelectionEngine;
    await import(`${pathToFileURL(runtimePath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('rasterizes a closed freehand polygon into a pixel mask', () => {
    const engine = window.HstarOpenShopSelectionEngine;
    const result = engine.polygonMask([
      {x:1, y:1}, {x:7, y:1}, {x:7, y:7}, {x:1, y:7},
    ], 10, 10);

    expect(result.mask[3 * 10 + 3]).toBe(1);
    expect(result.mask[0]).toBe(0);
    expect(result.bounds).toEqual({x:1, y:1, w:6, h:6});
  });

  it('selects only the connected color region when contiguous is enabled', () => {
    const engine = window.HstarOpenShopSelectionEngine;
    const red = [200, 20, 20, 255];
    const blue = [20, 20, 200, 255];
    const source = imageData(5, 3, [
      red, red, blue, red, red,
      red, red, blue, red, red,
      blue, blue, blue, blue, blue,
    ]);

    const contiguous = engine.magicWand({...source, x:0, y:0, tolerance:0, contiguous:true});
    const global = engine.magicWand({...source, x:0, y:0, tolerance:0, contiguous:false});

    expect(contiguous.count).toBe(4);
    expect(global.count).toBe(8);
    expect(contiguous.mask[4]).toBe(0);
    expect(global.mask[4]).toBe(1);
  });

  it('uses weighted color distance and supports the full 0-255 tolerance range', () => {
    const engine = window.HstarOpenShopSelectionEngine;
    const source = imageData(3, 1, [
      [100, 100, 100, 255],
      [112, 100, 100, 255],
      [180, 180, 180, 255],
    ]);

    expect(engine.magicWand({...source, x:0, y:0, tolerance:5, contiguous:false}).count).toBe(1);
    expect(engine.magicWand({...source, x:0, y:0, tolerance:10, contiguous:false}).count).toBe(2);
    expect(engine.magicWand({...source, x:0, y:0, tolerance:255, contiguous:false}).count).toBe(3);
  });

  it('keeps transparent magic-wand regions inside the supplied document mask', () => {
    const engine = window.HstarOpenShopSelectionEngine;
    const width = 5;
    const height = 3;
    const data = new Uint8ClampedArray(width * height * 4);
    const validMask = new Uint8Array([
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
      0, 1, 1, 1, 0,
    ]);

    const inside = engine.magicWand({
      data,
      width,
      height,
      x:2,
      y:1,
      tolerance:0,
      contiguous:true,
      validMask,
    });
    const outside = engine.magicWand({
      data,
      width,
      height,
      x:0,
      y:1,
      tolerance:0,
      contiguous:true,
      validMask,
    });

    expect(inside.count).toBe(9);
    expect(inside.bounds).toEqual({x:1, y:0, w:3, h:3});
    expect(outside.count).toBe(0);
    expect(outside.bounds).toBeNull();
  });

  it.each([
    ['new', [0, 1, 1, 0]],
    ['add', [1, 1, 1, 0]],
    ['subtract', [1, 0, 0, 0]],
    ['intersect', [0, 1, 0, 0]],
  ])('composes %s selections like Photoshop', (mode, expected) => {
    const engine = window.HstarOpenShopSelectionEngine;
    const existing = Uint8Array.from([1, 1, 0, 0]);
    const incoming = Uint8Array.from([0, 1, 1, 0]);

    expect([...engine.composeMasks(existing, incoming, mode)]).toEqual(expected);
  });

  it('maps selection modifiers and extracts only contour pixels', () => {
    const engine = window.HstarOpenShopSelectionEngine;
    expect(engine.selectionMode({shiftKey:false, altKey:false})).toBe('new');
    expect(engine.selectionMode({shiftKey:true, altKey:false})).toBe('add');
    expect(engine.selectionMode({shiftKey:false, altKey:true})).toBe('subtract');
    expect(engine.selectionMode({shiftKey:true, altKey:true})).toBe('intersect');

    const mask = Uint8Array.from([
      0,0,0,0,0,
      0,1,1,1,0,
      0,1,1,1,0,
      0,1,1,1,0,
      0,0,0,0,0,
    ]);
    const boundary = engine.boundaryPixels(mask, 5, 5);
    expect(boundary).toHaveLength(8);
    expect(boundary).not.toContain(12);
  });
});
