import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-writing-mode.js');

function loadRuntime() {
  delete window.HstarOpenShopWritingMode;
  new Function(readFileSync(runtimePath, 'utf8'))();
  return window.HstarOpenShopWritingMode;
}

function createFabricMock({withCreateClass = true} = {}) {
  class FabricObject {
    initialize(options = {}) {
      Object.assign(this, options);
      return this;
    }

    set(values, value) {
      if(typeof values === 'string') this[values] = value;
      else Object.assign(this, values || {});
      return this;
    }

    setCoords() {
      return this;
    }

    toObject(extra = []) {
      const output = {};
      Object.keys(this).forEach(key => {
        if(!key.startsWith('_') && typeof this[key] !== 'function') output[key] = this[key];
      });
      (Array.isArray(extra) ? extra : []).forEach(key => {
        if(this[key] !== undefined) output[key] = this[key];
      });
      return output;
    }
  }

  class IText extends FabricObject {
    constructor(text, options = {}) {
      super();
      this.initialize(text, options);
    }

    initialize(text, options = {}) {
      super.initialize(options);
      this.type = 'i-text';
      this.text = String(text);
      return this;
    }
  }

  const fabric = {Object:FabricObject, IText};
  if(withCreateClass) {
    fabric.util = {
      createClass(Parent, methods) {
        class FabricSubclass extends Parent {
          constructor(...args) {
            super();
            this.initialize(...args);
          }

          callSuper(method, ...args) {
            return Parent.prototype[method].apply(this, args);
          }
        }
        Object.assign(FabricSubclass.prototype, methods);
        return FabricSubclass;
      },
    };
  }
  return fabric;
}

let runtime;

beforeEach(() => {
  runtime = loadRuntime();
});

afterEach(() => {
  runtime?.destroy();
  delete window.HstarOpenShopWritingMode;
});

describe('Hstar OpenShop writing mode runtime', () => {
  it('normalizes only the canonical vertical value', () => {
    expect(runtime.HORIZONTAL).toBe('horizontal');
    expect(runtime.VERTICAL).toBe('vertical');
    expect(runtime.normalizeWritingMode('vertical')).toBe('vertical');
    expect(runtime.normalizeWritingMode('vertical-rl')).toBe('horizontal');
    expect(runtime.normalizeWritingMode('Vertical')).toBe('horizontal');
    expect(runtime.normalizeWritingMode()).toBe('horizontal');
  });

  it('keeps raw text, including null and explicit newlines, in distinct vertical columns', () => {
    const raw = 'first\nsecond';
    const layout = runtime.layoutVerticalText(raw, {fontSize:20, lineHeight:1});

    expect(layout.text).toBe(raw);
    expect(layout.writingMode).toBe('vertical');
    expect(layout.columns).toEqual([['f', 'i', 'r', 's', 't'], ['s', 'e', 'c', 'o', 'n', 'd']]);
    expect(layout.glyphs.map(glyph => glyph.character).join('')).toBe('firstsecond');
    expect(runtime.layoutVerticalText(null).text).toBe('null');
  });

  it('uses Array.from Unicode code points and flows columns top-to-bottom from right to left', () => {
    const layout = runtime.layoutVerticalText('A\u{1F642}e\u0301\nB2', {fontSize:20, lineHeight:1});
    const firstColumn = layout.glyphs.filter(glyph => glyph.columnIndex === 0);
    const secondColumn = layout.glyphs.filter(glyph => glyph.columnIndex === 1);

    expect(firstColumn.map(glyph => glyph.character)).toEqual(Array.from('A\u{1F642}e\u0301'));
    expect(secondColumn.map(glyph => glyph.character)).toEqual(['B', '2']);
    expect(firstColumn[1].y).toBeGreaterThan(firstColumn[0].y);
    expect(secondColumn[1].y).toBeGreaterThan(secondColumn[0].y);
    expect(firstColumn[0].x).toBeGreaterThan(secondColumn[0].x);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });

  it('registers the Fabric vertical class once with a createClass and class fallback', () => {
    const fabric = createFabricMock();
    const first = runtime.registerFabricClass(fabric);
    const second = runtime.registerFabricClass(fabric);
    const fallbackFabric = createFabricMock({withCreateClass:false});
    const FallbackVerticalText = runtime.registerFabricClass(fallbackFabric);

    expect(second).toBe(first);
    expect(fabric.HstarVerticalText).toBe(first);
    expect(first.prototype).toBeInstanceOf(fabric.Object);
    expect(first.prototype.type).toBe('hstar-vertical-text');
    expect(new FallbackVerticalText('fallback')).toBeInstanceOf(fallbackFabric.Object);
  });

  it('creates horizontal IText and vertical objects with their writing modes', () => {
    const fabric = createFabricMock();
    const horizontal = runtime.createTextObject(fabric, 'horizontal', {
      left:12,
      fontSize:30,
      hstarWritingMode:'horizontal',
    });
    const vertical = runtime.createTextObject(fabric, 'vertical', {
      left:14,
      fontSize:30,
      hstarWritingMode:'vertical',
    });

    expect(horizontal).toBeInstanceOf(fabric.IText);
    expect(horizontal).toMatchObject({text:'horizontal', hstarWritingMode:'horizontal', left:12});
    expect(vertical).toBeInstanceOf(fabric.HstarVerticalText);
    expect(vertical).toMatchObject({text:'vertical', hstarWritingMode:'vertical', left:14});
    expect(vertical.width).toBeGreaterThan(0);
    expect(vertical.height).toBeGreaterThan(0);
  });

  it('converts text while retaining visual fields and enumerable Hstar metadata', () => {
    const fabric = createFabricMock();
    const source = runtime.createTextObject(fabric, 'keep\nthis', {
      left:10,
      top:20,
      scaleX:1.2,
      scaleY:0.8,
      angle:15,
      opacity:0.6,
      fill:'#123456',
      fontFamily:'Arial',
      fontSize:28,
      fontWeight:700,
      fontStyle:'italic',
    });
    source.hstarLayerId = 'copy-me';
    source.hstarData = {tags:['title']};
    source.hstarRuntime = () => 'omit';
    source._hstarPrivate = 'omit';

    const vertical = runtime.convertTextObject(fabric, source, 'vertical');
    const horizontal = runtime.convertTextObject(fabric, vertical, 'horizontal');

    for(const object of [vertical, horizontal]) {
      expect(object).toMatchObject({
        text:'keep\nthis',
        left:10,
        top:20,
        scaleX:1.2,
        scaleY:0.8,
        angle:15,
        opacity:0.6,
        fill:'#123456',
        fontFamily:'Arial',
        fontSize:28,
        fontWeight:700,
        fontStyle:'italic',
        hstarLayerId:'copy-me',
        hstarData:{tags:['title']},
      });
      expect(object.hstarRuntime).toBeUndefined();
      expect(object._hstarPrivate).toBeUndefined();
    }
    expect(vertical).toBeInstanceOf(fabric.HstarVerticalText);
    expect(horizontal).toBeInstanceOf(fabric.IText);
  });

  it('serializes and restores raw vertical text and honors explicit writing modes', () => {
    const fabric = createFabricMock();
    const original = runtime.createTextObject(fabric, 'A\nB', {
      hstarWritingMode:'vertical',
      left:28,
      top:39,
      fill:'#abcdef',
      fontSize:32,
    });
    const serialized = original.toObject();
    let reconstructed;
    fabric.HstarVerticalText.fromObject(serialized, instance => { reconstructed = instance; });

    expect(serialized).toMatchObject({
      type:'hstar-vertical-text',
      text:'A\nB',
      hstarWritingMode:'vertical',
      left:28,
      top:39,
      fill:'#abcdef',
      fontSize:32,
    });
    expect(reconstructed).toBeInstanceOf(fabric.HstarVerticalText);
    expect(reconstructed).toMatchObject({text:'A\nB', hstarWritingMode:'vertical', left:28, top:39});
    expect(runtime.writingModeFor({hstarWritingMode:'vertical'})).toBe('vertical');
    expect(runtime.writingModeFor({type:'hstar-vertical-text', hstarWritingMode:'horizontal'})).toBe('horizontal');
    expect(runtime.writingModeFor({})).toBe('horizontal');
  });
});
