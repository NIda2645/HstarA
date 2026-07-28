import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const samplerPath = resolve(testDir, '..', 'host', 'openshop-canvas-sampler.js');

describe('OpenShop canvas sampler', () => {
  beforeEach(() => {
    delete window.HstarOpenShopCanvasSampler;
    new Function(readFileSync(samplerPath, 'utf8'))();
  });

  it('samples the composited backing pixel at Retina scale', () => {
    const getImageData = vi.fn(() => ({
      data:new Uint8ClampedArray([17, 34, 51, 128]),
    }));
    const lowerCanvasEl = {
      width:1600,
      height:1200,
      getBoundingClientRect:() => ({left:100, top:50, width:800, height:600}),
      getContext:() => ({getImageData}),
    };

    const result = window.HstarOpenShopCanvasSampler.sample({
      canvas:{lowerCanvasEl},
      event:{clientX:300, clientY:200},
      documentPoint:{x:240, y:180},
      documentWidth:800,
      documentHeight:600,
    });

    expect(getImageData).toHaveBeenCalledWith(400, 300, 1, 1);
    expect(result).toEqual({
      red:17,
      green:34,
      blue:51,
      alpha:128,
      hex:'#112233',
    });
  });

  it('uses the display click while the Fabric pointer validates a transformed document', () => {
    const getImageData = vi.fn(() => ({
      data:new Uint8ClampedArray([240, 128, 64, 255]),
    }));
    const lowerCanvasEl = {
      width:1000,
      height:800,
      getBoundingClientRect:() => ({left:20, top:40, width:500, height:400}),
      getContext:() => ({getImageData}),
    };

    const result = window.HstarOpenShopCanvasSampler.sample({
      canvas:{lowerCanvasEl},
      event:{clientX:145, clientY:140},
      documentPoint:{x:710, y:405},
      documentWidth:1920,
      documentHeight:1080,
    });

    expect(getImageData).toHaveBeenCalledWith(250, 200, 1, 1);
    expect(result.hex).toBe('#f08040');
  });

  it('rejects document-outside clicks without touching the backing context', () => {
    const getContext = vi.fn();

    expect(() => window.HstarOpenShopCanvasSampler.sample({
      canvas:{lowerCanvasEl:{getContext}},
      event:{clientX:10, clientY:10},
      documentPoint:{x:-1, y:20},
      documentWidth:800,
      documentHeight:600,
    })).toThrowError('Color sample is outside the document');

    expect(getContext).not.toHaveBeenCalled();
  });

  it('rejects clicks outside the canvas backing element', () => {
    const getImageData = vi.fn();
    const lowerCanvasEl = {
      width:100,
      height:100,
      getBoundingClientRect:() => ({left:20, top:20, width:100, height:100}),
      getContext:() => ({getImageData}),
    };

    expect(() => window.HstarOpenShopCanvasSampler.sample({
      canvas:{lowerCanvasEl},
      event:{clientX:15, clientY:40},
      documentPoint:{x:10, y:10},
      documentWidth:100,
      documentHeight:100,
    })).toThrowError('Color sample is outside the canvas');

    expect(getImageData).not.toHaveBeenCalled();
  });

  it('normalizes backing-store read failures', () => {
    const lowerCanvasEl = {
      width:100,
      height:100,
      getBoundingClientRect:() => ({left:0, top:0, width:100, height:100}),
      getContext:() => ({
        getImageData:() => { throw new DOMException('tainted'); },
      }),
    };

    expect(() => window.HstarOpenShopCanvasSampler.sample({
      canvas:{lowerCanvasEl},
      event:{clientX:1, clientY:1},
      documentPoint:{x:1, y:1},
      documentWidth:100,
      documentHeight:100,
    })).toThrowError('Canvas color could not be sampled');
  });
});
