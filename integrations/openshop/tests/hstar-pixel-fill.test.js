import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(testDir, '..', 'host', 'openshop-pixel-fill.js');

describe('Hstar OpenShop pixel fill', () => {
  beforeEach(async () => {
    expect(existsSync(modulePath), `${modulePath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopPixelFill;
    await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('fills every RGBA pixel with an opaque validated color', () => {
    const imageData = new ImageData(2, 2);

    const count = window.HstarOpenShopPixelFill.fillImageData(imageData, '#12ab34');

    expect(count).toBe(4);
    expect([...imageData.data]).toEqual([
      0x12, 0xab, 0x34, 255,
      0x12, 0xab, 0x34, 255,
      0x12, 0xab, 0x34, 255,
      0x12, 0xab, 0x34, 255,
    ]);
  });

  it('fills only pixels accepted by the selection predicate', () => {
    const imageData = new ImageData(new Uint8ClampedArray([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
      13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24,
    ]), 3, 2);

    const count = window.HstarOpenShopPixelFill.fillImageData(
      imageData,
      '#fedcba',
      (x, y) => x === 1 && y === 0,
    );

    expect(count).toBe(1);
    expect([...imageData.data.slice(4, 8)]).toEqual([0xfe, 0xdc, 0xba, 255]);
    expect([...imageData.data.slice(0, 4)]).toEqual([1, 2, 3, 4]);
    expect([...imageData.data.slice(8, 12)]).toEqual([9, 10, 11, 12]);
  });

  it('rejects unsupported color strings without mutating pixels', () => {
    const imageData = new ImageData(new Uint8ClampedArray([1, 2, 3, 4]), 1, 1);

    expect(() => window.HstarOpenShopPixelFill.fillImageData(imageData, 'red')).toThrow('颜色格式无效');
    expect([...imageData.data]).toEqual([1, 2, 3, 4]);
  });
});
