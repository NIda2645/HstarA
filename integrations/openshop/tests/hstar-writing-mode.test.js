import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-writing-mode.js');
const TEXT_PROPERTIES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'stroke', 'strokeWidth',
  'charSpacing', 'lineHeight', 'textAlign', 'textBackgroundColor', 'backgroundColor',
  'underline', 'overline', 'linethrough', 'shadow', 'styles', 'opacity', 'angle', 'left',
  'top', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY', 'originX', 'originY',
  'visible', 'selectable', 'evented',
];
const BASE_OBJECT_PROPERTIES = [
  'type', 'left', 'top', 'scaleX', 'scaleY', 'angle', 'opacity', 'originX', 'originY',
  'visible', 'selectable', 'evented',
];

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
      BASE_OBJECT_PROPERTIES.forEach(key => {
        if(this[key] !== undefined) output[key] = this[key];
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

  Object.assign(IText.prototype, {
    fontFamily:'Prototype Sans',
    fontSize:31,
    fontWeight:600,
    fontStyle:'italic',
    fill:'#224466',
    stroke:'#112233',
    strokeWidth:3,
    charSpacing:48,
    lineHeight:1.4,
    textAlign:'right',
    textBackgroundColor:'#f8fafc',
    backgroundColor:'#0f172a',
    underline:true,
    overline:true,
    linethrough:true,
    shadow:{color:'#000000', blur:4, offsetX:2, offsetY:3},
    styles:{0:{0:{fill:'#ef4444'}}},
    skewX:6,
    skewY:-4,
    flipX:true,
    flipY:true,
    originX:'center',
    originY:'center',
    visible:true,
    selectable:true,
    evented:true,
  });

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

  it('converts inherited IText defaults along with enumerable Hstar metadata', () => {
    const fabric = createFabricMock();
    const source = new fabric.IText('prototype values', {left:12, top:24, opacity:0.75});
    source.hstarOrigin = {kind:'prototype-test'};
    source.hstarHandler = () => 'omit';
    source._hstarRuntime = 'omit';

    const vertical = runtime.convertTextObject(fabric, source, 'vertical');

    expect(vertical).toMatchObject({
      text:'prototype values',
      left:12,
      top:24,
      opacity:0.75,
      ...Object.fromEntries(TEXT_PROPERTIES
        .filter(key => key in source && !['left', 'top', 'opacity'].includes(key))
        .map(key => [key, source[key]])),
      hstarOrigin:{kind:'prototype-test'},
    });
    expect(Object.hasOwn(vertical, 'fontFamily')).toBe(true);
    expect(vertical.styles).not.toBe(source.styles);
    expect(vertical.shadow).not.toBe(source.shadow);
    expect(vertical.hstarHandler).toBeUndefined();
    expect(vertical._hstarRuntime).toBeUndefined();
  });

  it('renders every glyph in vertical top-to-bottom and right-to-left coordinate order', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'AB\nC', {
      hstarWritingMode:'vertical',
      fontFamily:'Render Sans',
      fontSize:24,
      fontWeight:700,
      fontStyle:'italic',
      fill:'#ff00aa',
    });
    const calls = [];
    const context = {
      save() {},
      restore() {},
      fillText(...args) { calls.push(args); },
    };

    vertical._render(context);

    expect(context.font).toBe('italic 700 24px Render Sans');
    expect(context.fillStyle).toBe('#ff00aa');
    expect(calls.map(([glyph]) => glyph)).toEqual(['A', 'B', 'C']);
    expect(calls[1][2]).toBeGreaterThan(calls[0][2]);
    expect(calls[0][1]).toBeGreaterThan(calls[2][1]);
  });

  it('serializes and restores raw vertical text, visual styles, metadata, and dimensions', () => {
    const fabric = createFabricMock();
    const original = runtime.createTextObject(fabric, 'A\nB', {
      hstarWritingMode:'vertical',
      left:28,
      top:39,
      fill:'#abcdef',
      fontSize:32,
      fontFamily:'Round Trip Sans',
      fontWeight:700,
      fontStyle:'italic',
      stroke:'#012345',
      strokeWidth:2,
      charSpacing:36,
      lineHeight:1.5,
      textAlign:'center',
      textBackgroundColor:'#fef3c7',
      backgroundColor:'#111827',
      underline:true,
      overline:true,
      linethrough:true,
      shadow:{color:'#334155', blur:5, offsetX:2, offsetY:4},
      styles:{0:{0:{fill:'#f97316', fontWeight:700}}},
      opacity:0.65,
      angle:14,
      scaleX:1.25,
      scaleY:0.8,
      skewX:7,
      skewY:-3,
      flipX:true,
      flipY:true,
      originX:'right',
      originY:'bottom',
      visible:false,
      selectable:false,
      evented:false,
    });
    original.hstarLayerId = 'vertical-title';
    original.hstarData = {tags:['title']};
    const serialized = original.toObject();
    let reconstructed;
    fabric.HstarVerticalText.fromObject(serialized, instance => { reconstructed = instance; });

    expect(serialized).toMatchObject({
      type:'hstar-vertical-text',
      text:'A\nB',
      hstarWritingMode:'vertical',
      ...Object.fromEntries(TEXT_PROPERTIES.map(key => [key, original[key]])),
      hstarLayerId:'vertical-title',
      hstarData:{tags:['title']},
    });
    expect(reconstructed).toBeInstanceOf(fabric.HstarVerticalText);
    expect(reconstructed).toMatchObject({
      text:'A\nB',
      hstarWritingMode:'vertical',
      ...Object.fromEntries(TEXT_PROPERTIES.map(key => [key, original[key]])),
      hstarLayerId:'vertical-title',
      hstarData:{tags:['title']},
    });
    expect(reconstructed.width).toBeCloseTo(original.width, 8);
    expect(reconstructed.height).toBeCloseTo(original.height, 8);
    expect(serialized.styles).not.toBe(original.styles);
    expect(serialized.shadow).not.toBe(original.shadow);
    expect(reconstructed.styles).not.toBe(serialized.styles);
    expect(reconstructed.shadow).not.toBe(serialized.shadow);
  });

  it('honors explicit writing modes and defaults legacy objects to horizontal', () => {
    expect(runtime.writingModeFor({hstarWritingMode:'vertical'})).toBe('vertical');
    expect(runtime.writingModeFor({type:'hstar-vertical-text', hstarWritingMode:'horizontal'})).toBe('horizontal');
    expect(runtime.writingModeFor({})).toBe('horizontal');
  });
});
