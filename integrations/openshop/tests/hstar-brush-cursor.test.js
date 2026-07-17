import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-brush-cursor.js');

describe('Hstar OpenShop brush cursor', () => {
  beforeEach(async () => {
    expect(existsSync(runtimePath), `${runtimePath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopBrushCursor;
    document.body.innerHTML = '<div id="canvas-area"></div>';
    await import(`${pathToFileURL(runtimePath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('tracks the pointer and scales the outline to the document brush diameter', () => {
    const area = document.getElementById('canvas-area');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({left:100, top:40, width:800, height:600});
    let profile = {visible:true, size:24, zoom:1.5, shape:'round'};
    const controller = window.HstarOpenShopBrushCursor.createController({
      documentRef:document,
      area,
      getProfile:() => profile,
    });

    area.dispatchEvent(new PointerEvent('pointermove', {clientX:220, clientY:160, bubbles:true}));
    const cursor = area.querySelector('[data-brush-cursor]');

    expect(cursor.hidden).toBe(false);
    expect(cursor.style.left).toBe('120px');
    expect(cursor.style.top).toBe('120px');
    expect(cursor.style.width).toBe('36px');
    expect(cursor.style.height).toBe('36px');
    expect(cursor.dataset.shape).toBe('round');

    profile = {visible:true, size:10, zoom:2, shape:'pixel'};
    controller.refresh();
    expect(cursor.style.width).toBe('20px');
    expect(cursor.dataset.shape).toBe('pixel');
    controller.destroy();
  });

  it('hides outside the canvas and for non-brush tools', () => {
    const area = document.getElementById('canvas-area');
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({left:0, top:0, width:800, height:600});
    let profile = {visible:true, size:12, zoom:1, shape:'round'};
    const controller = window.HstarOpenShopBrushCursor.createController({
      documentRef:document,
      area,
      getProfile:() => profile,
    });

    area.dispatchEvent(new PointerEvent('pointermove', {clientX:50, clientY:60, bubbles:true}));
    const cursor = area.querySelector('[data-brush-cursor]');
    expect(cursor.hidden).toBe(false);

    area.dispatchEvent(new PointerEvent('pointerleave', {bubbles:true}));
    expect(cursor.hidden).toBe(true);
    profile = {visible:false, size:12, zoom:1, shape:'round'};
    area.dispatchEvent(new PointerEvent('pointermove', {clientX:70, clientY:80, bubbles:true}));
    expect(cursor.hidden).toBe(true);
    controller.destroy();
  });
});
