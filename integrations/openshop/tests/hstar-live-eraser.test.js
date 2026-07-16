import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const eraserPath = resolve(testDir, '..', 'host', 'openshop-live-eraser.js');

class FakePencilBrush {
  constructor(canvas) {
    this.canvas = canvas;
    this.color = '#000000';
    this.width = 1;
    this._points = [];
  }

  onMouseDown(pointer) {
    this._points = [{...pointer}];
    return true;
  }

  onMouseMove(pointer) {
    this._points.push({...pointer});
    return true;
  }
}

function createContext() {
  const assignments = [];
  const context = {
    assignments,
    save:vi.fn(),
    restore:vi.fn(),
    transform:vi.fn(),
    beginPath:vi.fn(),
    moveTo:vi.fn(),
    lineTo:vi.fn(),
    stroke:vi.fn(),
  };
  Object.defineProperty(context, 'globalCompositeOperation', {
    configurable:true,
    set(value) { assignments.push(value); },
    get() { return assignments.at(-1) || 'source-over'; },
  });
  return context;
}

describe('Hstar OpenShop live eraser', () => {
  beforeEach(async () => {
    expect(existsSync(eraserPath), `${eraserPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopLiveEraser;
    await import(`${pathToFileURL(eraserPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('renders each accepted pointer segment directly as destination-out feedback', () => {
    const context = createContext();
    const canvas = {
      contextContainer:context,
      viewportTransform:[2, 0, 0, 2, 5, 6],
    };
    const brush = window.HstarOpenShopLiveEraser.createBrush({
      fabricRef:{PencilBrush:FakePencilBrush},
      canvas,
    });
    brush.width = 12;

    brush.onMouseDown({x:10, y:20}, {e:{}});
    brush.onMouseMove({x:18, y:28}, {e:{}});

    expect(brush.color).toBe('rgba(0,0,0,0.001)');
    expect(context.assignments).toContain('destination-out');
    expect(context.transform).toHaveBeenCalledWith(2, 0, 0, 2, 5, 6);
    expect(context.moveTo).toHaveBeenCalledWith(10, 20);
    expect(context.lineTo).toHaveBeenCalledWith(18, 28);
    expect(context.stroke).toHaveBeenCalledOnce();
    expect(context.restore).toHaveBeenCalledOnce();
  });

  it('configures the finalized Fabric path as an opaque destination-out stroke', () => {
    const path = {stroke:'transparent', dirty:false};

    const result = window.HstarOpenShopLiveEraser.configureFinalPath(path);

    expect(result).toBe(path);
    expect(path).toMatchObject({
      stroke:'rgba(0,0,0,1)',
      globalCompositeOperation:'destination-out',
      dirty:true,
    });
  });
});
