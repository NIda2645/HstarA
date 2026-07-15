import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const enginePath = resolve(testDir, '..', 'host', 'openshop-snap-engine.js');

describe('OpenShop geometry snap engine', () => {
  beforeEach(async () => {
    expect(existsSync(enginePath), `${enginePath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(enginePath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('prioritizes a frozen local selection over document and grid targets', () => {
    const result = window.HstarOpenShopSnapEngine.resolveMovement({
      position:{left:12, top:8},
      objectRect:{left:12, top:8, width:800, height:600},
      documentRect:{left:0, top:0, width:800, height:600},
      localAnchorRect:{left:112, top:88, width:240, height:160},
      localTargetRect:{left:100, top:80, width:240, height:160},
      tolerance:15,
      grid:{enabled:true, size:20},
    });

    expect(result).toEqual({
      left:0,
      top:0,
      sourceX:'local-selection',
      sourceY:'local-selection',
    });
  });

  it('restores a matching full-document layer as one complete overlap', () => {
    const result = window.HstarOpenShopSnapEngine.resolveMovement({
      position:{left:9, top:-7},
      objectRect:{left:9, top:-7, width:3840, height:2160},
      documentRect:{left:0, top:0, width:3840, height:2160},
      tolerance:10,
      grid:{enabled:false, size:20},
    });

    expect(result).toEqual({
      left:0,
      top:0,
      sourceX:'document-overlap',
      sourceY:'document-overlap',
    });
  });

  it('aligns ordinary layer axes independently to document edges and centers', () => {
    const result = window.HstarOpenShopSnapEngine.resolveMovement({
      position:{left:397, top:601},
      objectRect:{left:397, top:601, width:200, height:200},
      documentRect:{left:0, top:0, width:1000, height:800},
      tolerance:5,
      grid:{enabled:false, size:20},
    });

    expect(result).toEqual({
      left:400,
      top:600,
      sourceX:'document-geometry',
      sourceY:'document-geometry',
    });
  });

  it('uses grid rounding only for axes without a geometry match', () => {
    const result = window.HstarOpenShopSnapEngine.resolveMovement({
      position:{left:3, top:47},
      objectRect:{left:3, top:47, width:120, height:80},
      documentRect:{left:0, top:0, width:1000, height:800},
      tolerance:5,
      grid:{enabled:true, size:20},
    });

    expect(result).toEqual({
      left:0,
      top:40,
      sourceX:'document-geometry',
      sourceY:'grid',
    });
  });

  it('does not retain a snap after the proposed position leaves tolerance', () => {
    const result = window.HstarOpenShopSnapEngine.resolveMovement({
      position:{left:18, top:0},
      objectRect:{left:18, top:0, width:800, height:600},
      documentRect:{left:0, top:0, width:800, height:600},
      tolerance:10,
      grid:{enabled:false, size:20},
    });

    expect(result.left).toBe(18);
    expect(result.sourceX).toBe('none');
    expect(result.top).toBe(0);
    expect(result.sourceY).toBe('document-overlap');
  });
});
