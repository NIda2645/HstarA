import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-writing-mode.js');
const vendorFabricPath = resolve(testDir, '..', 'vendor', 'fabric-5.3.1.min.js');
const TEXT_PROPERTIES = [
  'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'stroke', 'strokeWidth',
  'charSpacing', 'lineHeight', 'textAlign', 'textBackgroundColor', 'backgroundColor',
  'underline', 'overline', 'linethrough', 'shadow', 'styles', 'opacity', 'angle', 'left',
  'top', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY', 'originX', 'originY',
  'visible', 'selectable', 'evented',
];
const BASE_OBJECT_PROPERTIES = [
  'type', 'left', 'top', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY', 'angle',
  'opacity', 'originX', 'originY', 'visible', 'selectable', 'evented',
];
const MOCK_TEXT_PROPERTIES = [
  'text', 'baseTextOption', ...TEXT_PROPERTIES, 'direction', 'paintFirst', 'strokeUniform',
  'strokeDashArray', 'strokeDashOffset', 'strokeLineCap', 'strokeLineJoin', 'strokeMiterLimit',
  'futureTextOption',
];
const MOCK_RUNTIME_PROPERTIES = new Set([
  'canvas', 'group', 'aCoords', 'oCoords', 'matrixCache', 'ownMatrixCache', 'cacheKey',
  'dirty', 'selectionStart', 'selectionEnd', 'isEditing', 'hiddenTextarea',
  'hiddenTextareaContainer', 'cursorDuration', 'inCompositionMode', 'keysMap', 'cursorWidth',
  'cursorColor', 'cursorDelay', 'width', 'height', 'pathOffset',
]);

function cloneMockValue(value) {
  if(value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if(typeof value === 'function') return undefined;
  if(Array.isArray(value)) return value.map(cloneMockValue).filter(value => value !== undefined);
  if(Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value)
    .map(([key, child]) => [key, cloneMockValue(child)])
    .filter(([, child]) => child !== undefined));
}

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
      if(typeof values === 'string') this._set(values, value);
      else Object.entries(values || {}).forEach(([key, item]) => this._set(key, item));
      return this;
    }

    _set(key, value) {
      this[key] = value;
      return this;
    }

    setCoords() {
      return this;
    }

    toObject(extra = []) {
      const output = {};
      const names = new Set([...BASE_OBJECT_PROPERTIES, ...(Array.isArray(extra) ? extra : [])]);
      names.forEach(key => {
        if(key.startsWith('_') || MOCK_RUNTIME_PROPERTIES.has(key)) return;
        const value = this[key];
        const serializable = key.startsWith('hstar') ? value : cloneMockValue(value);
        if(serializable !== undefined) output[key] = serializable;
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

    toObject(extra = []) {
      return super.toObject([...MOCK_TEXT_PROPERTIES, ...(Array.isArray(extra) ? extra : [])]);
    }
  }

  class Text extends FabricObject {}

  Object.assign(FabricObject.prototype, {
    baseTextOption:'from-fabric-object',
    controls:{ml:{cursorStyleHandler() { return 'runtime'; }}},
  });

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
    direction:'rtl',
    paintFirst:'stroke',
    strokeUniform:true,
    strokeDashArray:[6, 3],
    strokeDashOffset:2,
    strokeLineCap:'round',
    strokeLineJoin:'bevel',
    strokeMiterLimit:9,
    futureTextOption:{source:'prototype'},
  });

  const fabric = {Object:FabricObject, IText, Text};
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

function attachEditingCanvas(object, {
  objectRect = {left:10, top:20, width:80, height:120},
  canvasRect = {left:100, top:50, width:800, height:600},
  viewportTransform = [1, 0, 0, 1, 0, 0],
  logicalWidth = 800,
  logicalHeight = 600,
} = {}) {
  const upperCanvasEl = document.createElement('canvas');
  upperCanvasEl.dataset.hstarWritingModeTest = '';
  upperCanvasEl.getBoundingClientRect = vi.fn(() => canvasRect);
  upperCanvasEl.focus = vi.fn();
  document.body.append(upperCanvasEl);
  object.getBoundingRect = vi.fn(() => objectRect);
  object.setCoords = vi.fn();
  object.canvas = {
    upperCanvasEl,
    viewportTransform,
    getWidth:vi.fn(() => logicalWidth),
    getHeight:vi.fn(() => logicalHeight),
    requestRenderAll:vi.fn(),
  };
  return object.canvas;
}

let runtime;

beforeEach(() => {
  runtime = loadRuntime();
});

afterEach(() => {
  runtime?.destroy();
  document.querySelectorAll('[data-hstar-writing-mode-test]').forEach(element => element.remove());
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

  it('opens and reuses one styled vertical textarea without changing its text', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'first\nsecond', {
      hstarWritingMode:'vertical',
      fontFamily:'Editor Sans',
      fontSize:28,
      fontWeight:700,
      fontStyle:'italic',
      fill:'red',
      lineHeight:1.4,
      angle:17,
    });
    attachEditingCanvas(vertical);

    vertical.enterEditing();

    const editor = document.querySelector('textarea[data-hstar-vertical-editor]');
    expect(editor).not.toBeNull();
    expect(editor.classList.contains('hstar-vertical-text-editor')).toBe(true);
    expect(editor.value).toBe('first\nsecond');
    expect(editor.style.display).toBe('block');
    expect(editor.style.position).toBe('fixed');
    expect(editor.style.writingMode).toBe('vertical-rl');
    expect(editor.style.textOrientation).toBe('mixed');
    expect(editor.style.resize).toBe('none');
    expect(editor.style.fontFamily).toContain('Editor Sans');
    expect(editor.style.fontSize).toBe('28px');
    expect(editor.style.fontWeight).toBe('700');
    expect(editor.style.fontStyle).toBe('italic');
    expect(editor.style.color).toBe('red');
    expect(editor.style.lineHeight).toBe('1.4');
    expect(editor.style.transform).toBe('rotate(17deg)');
    expect(editor.style.left).toBe('110px');
    expect(editor.style.top).toBe('70px');
    expect(editor.style.width).toBe('80px');
    expect(editor.style.height).toBe('120px');
    expect(Number(editor.style.zIndex)).toBeGreaterThanOrEqual(10000);
    expect(vertical.isEditing).toBe(true);
    expect(runtime.activeEditorObject()).toBe(vertical);

    vertical.exitEditing();
    expect(editor.style.display).toBe('none');
    const duplicate = document.createElement('textarea');
    duplicate.setAttribute('data-hstar-vertical-editor', '');
    document.body.append(duplicate);
    vertical.enterEditing();

    expect(document.querySelectorAll('textarea[data-hstar-vertical-editor]')).toHaveLength(1);
    expect(document.querySelector('textarea[data-hstar-vertical-editor]')).toBe(editor);
  });

  it('uses CSS canvas ratios without applying viewport zoom twice to transformed bounds', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'zoomed', {hstarWritingMode:'vertical'});
    attachEditingCanvas(vertical, {
      objectRect:{left:40, top:60, width:100, height:160},
      canvasRect:{left:25, top:35, width:600, height:500},
      viewportTransform:[2, 0, 0, 2, 0, 0],
      logicalWidth:400,
      logicalHeight:400,
    });

    vertical.enterEditing();

    const editor = document.querySelector('textarea[data-hstar-vertical-editor]');
    expect(editor.style.left).toBe('85px');
    expect(editor.style.top).toBe('110px');
    expect(editor.style.width).toBe('150px');
    expect(editor.style.height).toBe('200px');
  });

  it('syncs textarea input to the object dimensions and canvas immediately', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'A', {hstarWritingMode:'vertical', fontSize:20});
    const canvas = attachEditingCanvas(vertical);
    const set = vi.spyOn(vertical, 'set');
    vertical.enterEditing();
    const editor = document.querySelector('textarea[data-hstar-vertical-editor]');
    const initialHeight = vertical.height;

    editor.value = 'ABCDE';
    editor.dispatchEvent(new Event('input', {bubbles:true}));

    expect(set).toHaveBeenCalledWith('text', 'ABCDE');
    expect(vertical.text).toBe('ABCDE');
    expect(vertical.height).toBeGreaterThan(initialHeight);
    expect(vertical.dirty).toBe(true);
    expect(vertical.setCoords).toHaveBeenCalled();
    expect(canvas.requestRenderAll).toHaveBeenCalled();
  });

  it('commits the first object and hands the same textarea to a second object', () => {
    const fabric = createFabricMock();
    const first = runtime.createTextObject(fabric, 'first', {hstarWritingMode:'vertical'});
    const second = runtime.createTextObject(fabric, 'second', {hstarWritingMode:'vertical'});
    attachEditingCanvas(first);
    attachEditingCanvas(second, {objectRect:{left:30, top:40, width:90, height:130}});
    first.enterEditing();
    const editor = document.querySelector('textarea[data-hstar-vertical-editor]');
    editor.value = 'committed first';

    second.enterEditing();

    expect(first.text).toBe('committed first');
    expect(first.isEditing).toBe(false);
    expect(second.isEditing).toBe(true);
    expect(runtime.activeEditorObject()).toBe(second);
    expect(editor.value).toBe('second');
    expect(document.querySelectorAll('textarea[data-hstar-vertical-editor]')).toHaveLength(1);
    expect(document.querySelector('textarea[data-hstar-vertical-editor]')).toBe(editor);
  });

  it('exits editing on blur and outside pointer or mouse input', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'close me', {hstarWritingMode:'vertical'});
    const canvas = attachEditingCanvas(vertical);
    const outside = document.createElement('button');
    outside.dataset.hstarWritingModeTest = '';
    document.body.append(outside);
    vertical.enterEditing();
    const editor = document.querySelector('textarea[data-hstar-vertical-editor]');

    editor.dispatchEvent(new FocusEvent('blur'));

    expect(vertical.isEditing).toBe(false);
    expect(runtime.activeEditorObject()).toBeNull();
    expect(editor.style.display).toBe('none');
    expect(canvas.upperCanvasEl.focus).toHaveBeenCalled();
    expect(canvas.requestRenderAll).toHaveBeenCalled();

    vertical.enterEditing();
    outside.dispatchEvent(new MouseEvent('pointerdown', {bubbles:true}));
    expect(vertical.isEditing).toBe(false);

    vertical.enterEditing();
    outside.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
    expect(vertical.isEditing).toBe(false);
  });

  it('uses minimum editor dimensions when canvas and object geometry are unavailable', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, '', {hstarWritingMode:'vertical', fontSize:0});
    const canvas = attachEditingCanvas(vertical);
    const lowerCanvasEl = document.createElement('canvas');
    lowerCanvasEl.dataset.hstarWritingModeTest = '';
    lowerCanvasEl.getBoundingClientRect = vi.fn(() => ({left:25, top:35, width:640, height:480}));
    document.body.append(lowerCanvasEl);
    canvas.lowerCanvasEl = lowerCanvasEl;
    canvas.getZoom = vi.fn(() => { throw new Error('zoom unavailable'); });
    vertical.getBoundingRect.mockImplementation(() => { throw new Error('geometry unavailable'); });
    canvas.upperCanvasEl.getBoundingClientRect.mockImplementation(() => { throw new Error('canvas unavailable'); });

    expect(() => vertical.enterEditing()).not.toThrow();

    const editor = document.querySelector('textarea[data-hstar-vertical-editor]');
    expect(Number.parseFloat(editor.style.width)).toBeGreaterThanOrEqual(32);
    expect(Number.parseFloat(editor.style.height)).toBeGreaterThanOrEqual(48);
    expect(editor.style.left).toBe('25px');
    expect(editor.style.top).toBe('35px');
  });

  it('destroys editor DOM and listeners idempotently while clearing active state', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'destroy me', {hstarWritingMode:'vertical'});
    attachEditingCanvas(vertical);
    vertical.enterEditing();
    const editor = document.querySelector('textarea[data-hstar-vertical-editor]');
    const removeEventListener = vi.spyOn(document, 'removeEventListener');

    runtime.destroy();

    expect(vertical.isEditing).toBe(false);
    expect(runtime.activeEditorObject()).toBeNull();
    expect(editor.isConnected).toBe(false);
    expect(removeEventListener).toHaveBeenCalledWith('pointerdown', expect.any(Function), true);
    expect(removeEventListener).toHaveBeenCalledWith('mousedown', expect.any(Function), true);
    expect(() => runtime.destroy()).not.toThrow();
    expect(document.querySelector('[data-hstar-vertical-editor]')).toBeNull();
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

  it('collects inherited Fabric text options without copying runtime state', () => {
    const fabric = createFabricMock();
    const source = new fabric.IText('full inherited options');
    source.canvas = {requestRenderAll() {}};
    source.group = {objects:[]};
    source.aCoords = {tl:{x:0, y:0}};
    source.matrixCache = {key:'runtime'};
    source.cacheKey = 'runtime-cache';
    source.runtimeCallback = () => 'omit';
    source._privateRuntime = 'omit';

    const vertical = runtime.convertTextObject(fabric, source, 'vertical');
    const serialized = vertical.toObject();
    const reconstructed = fabric.HstarVerticalText.fromObject(serialized);
    const expected = {
      baseTextOption:'from-fabric-object',
      direction:'rtl',
      paintFirst:'stroke',
      strokeUniform:true,
      strokeDashArray:[6, 3],
      strokeDashOffset:2,
      strokeLineCap:'round',
      strokeLineJoin:'bevel',
      strokeMiterLimit:9,
      futureTextOption:{source:'prototype'},
    };

    expect(vertical).toMatchObject(expected);
    const serializedExpected = {
      direction:'rtl',
      paintFirst:'stroke',
      strokeUniform:true,
      strokeDashArray:[6, 3],
      strokeDashOffset:2,
      strokeLineCap:'round',
      strokeLineJoin:'bevel',
      strokeMiterLimit:9,
    };
    for(const object of [serialized, reconstructed]) {
      expect(object).toMatchObject(serializedExpected);
      expect(object.canvas).toBeUndefined();
      expect(object.group).toBeUndefined();
      expect(object.aCoords).toBeUndefined();
      expect(object.matrixCache).toBeUndefined();
      expect(object.cacheKey).toBeUndefined();
      expect(object.runtimeCallback).toBeUndefined();
      expect(object._privateRuntime).toBeUndefined();
    }
    expect(vertical.strokeDashArray).not.toBe(source.strokeDashArray);
    expect(vertical.futureTextOption).not.toBe(source.futureTextOption);
    expect(reconstructed.strokeDashArray).not.toBe(serialized.strokeDashArray);
    expect(serialized.futureTextOption).toBeUndefined();
  });

  it('omits Fabric editor runtime state during text conversion', () => {
    const fabric = createFabricMock();
    const source = new fabric.IText('editor state', {
      direction:'ltr',
      selectionStart:2,
      selectionEnd:5,
      isEditing:true,
      hiddenTextarea:{value:'editor state'},
      hiddenTextareaContainer:{remove() {}},
      cursorDuration:600,
      inCompositionMode:true,
      keysMap:{TAB:9},
      cursorWidth:3,
      cursorColor:'#ff00aa',
      cursorDelay:250,
    });
    const baseToObject = source.toObject.bind(source);
    const calls = [];
    source.toObject = (...args) => {
      calls.push(args);
      return {...baseToObject(), serializedContractOption:{from:'toObject'}};
    };

    const vertical = runtime.convertTextObject(fabric, source, 'vertical');

    expect(calls).toEqual([[]]);
    expect(vertical).toMatchObject({
      text:'editor state',
      direction:'ltr',
      paintFirst:'stroke',
      strokeUniform:true,
      strokeDashArray:[6, 3],
      serializedContractOption:{from:'toObject'},
    });
    for(const key of [
      'selectionStart', 'selectionEnd', 'isEditing', 'hiddenTextarea',
      'hiddenTextareaContainer', 'cursorDuration', 'inCompositionMode', 'keysMap',
      'cursorWidth', 'cursorColor', 'cursorDelay',
    ]) {
      expect(vertical[key]).toBeUndefined();
    }
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

  it('recomputes dimensions after text and typography changes', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'AB', {hstarWritingMode:'vertical', fontSize:20});
    const initial = {width:vertical.width, height:vertical.height};

    vertical.set({text:'ABCD', fontSize:40});

    expect(vertical.width).toBeGreaterThan(initial.width);
    expect(vertical.height).toBeGreaterThan(initial.height);
    expect(vertical._hstarVerticalLayout.glyphs.map(glyph => glyph.character)).toEqual(['A', 'B', 'C', 'D']);
    expect(vertical.dirty).toBe(true);
  });

  it('marks paint changes dirty and sizes cells from per-glyph styles', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'AB\nC', {
      hstarWritingMode:'vertical',
      fontSize:10,
      lineHeight:1,
      styles:{0:{1:{fontSize:40, lineHeight:1.5, charSpacing:50}}},
    });
    const firstColumn = vertical._hstarVerticalLayout.glyphs.filter(glyph => glyph.columnIndex === 0);

    expect(firstColumn[1]).toMatchObject({width:40, height:40});
    expect(firstColumn[1].y).toBeGreaterThan(firstColumn[0].y);
    expect(vertical.width).toBeGreaterThan(40);
    vertical.dirty = false;
    vertical.set('underline', true);
    expect(vertical.dirty).toBe(true);
    vertical.dirty = false;
    vertical.set('backgroundColor', '#123456');
    expect(vertical.dirty).toBe(true);
  });

  it('strokes before filling with dash state and leaves object backgrounds to Fabric', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'A', {
      hstarWritingMode:'vertical',
      fill:'#111111',
      stroke:'#222222',
      strokeWidth:2,
      paintFirst:'stroke',
      strokeDashArray:[4, 2],
      strokeDashOffset:3,
      strokeLineCap:'round',
      strokeLineJoin:'bevel',
      strokeMiterLimit:7,
      textBackgroundColor:'#eeeeee',
      backgroundColor:'#ff00ff',
    });
    const events = [];
    const rects = [];
    const context = {
      save() {}, restore() {},
      fillText() { events.push('fill'); },
      strokeText() { events.push('stroke'); },
      fillRect(...args) { rects.push(args); },
      setLineDash(value) { this.dash = value; },
    };

    vertical._render(context);

    expect(events).toEqual(['stroke', 'fill']);
    expect(context.dash).toEqual([4, 2]);
    expect(context.lineDashOffset).toBe(3);
    expect(context.lineCap).toBe('round');
    expect(context.lineJoin).toBe('bevel');
    expect(context.miterLimit).toBe(7);
    expect(rects).not.toContainEqual([-vertical.width / 2, -vertical.height / 2, vertical.width, vertical.height]);
    expect(rects).toHaveLength(1);
  });

  it('renders defaults, glyph overrides, stroke, backgrounds, and decorations', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'AB', {
      hstarWritingMode:'vertical',
      fill:'#111111',
      stroke:'#222222',
      strokeWidth:2,
      shadow:{color:'#334155', blur:3, offsetX:1, offsetY:2},
      underline:true,
      textBackgroundColor:'#eeeeee',
      styles:{0:{1:{fontFamily:'Override Sans', fontSize:24, fontWeight:700, fontStyle:'italic', fill:'#ff0000'}}},
    });
    const fonts = [];
    const fills = [];
    const strokes = [];
    const lineWidths = [];
    const shadows = [];
    const rects = [];
    const context = {
      save() {}, restore() {},
      set font(value) { fonts.push(value); },
      set fillStyle(value) { fills.push(value); },
      set strokeStyle(value) { strokes.push(value); },
      set lineWidth(value) { lineWidths.push(value); },
      set shadowColor(value) { shadows.push(value); },
      fillText(...args) { this.fillTexts.push(args); },
      strokeText(...args) { this.strokeTexts.push(args); },
      fillRect(...args) { rects.push(args); },
      fillTexts:[], strokeTexts:[],
    };

    vertical._render(context);

    expect(fonts).toContain('normal normal 40px sans-serif');
    expect(fonts).toContain('italic 700 24px Override Sans');
    expect(context.fillTexts.map(([glyph]) => glyph)).toEqual(['A', 'B']);
    expect(context.strokeTexts).toHaveLength(2);
    expect(fills).toContain('#ff0000');
    expect(strokes).toContain('#222222');
    expect(lineWidths).toContain(2);
    expect(shadows).toEqual([]);
    expect(rects.length).toBeGreaterThan(2);
  });

  it('restores glyph paint after drawing a text background', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'A', {
      hstarWritingMode:'vertical',
      fill:'#ff0000',
      textBackgroundColor:'#eeeeee',
    });
    const fills = [];
    const context = {
      save() {}, restore() {}, fillRect() {},
      set fillStyle(value) { this.currentFill = value; },
      fillText() { fills.push(this.currentFill); },
    };

    vertical._render(context);

    expect(fills).toEqual(['#ff0000']);
  });

  it('applies Fabric glyph paint helpers once after a text background without glyph shadows', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'A', {
      hstarWritingMode:'vertical', fill:'#ff0000', stroke:'#111111', strokeWidth:2,
      textBackgroundColor:'#eeeeee', shadow:{color:'#000000', blur:2},
    });
    const handleFiller = vi.fn((context, property, filler) => { context[property] = filler; });
    const shadowSetup = vi.fn();
    fabric.Text.prototype.handleFiller = handleFiller;
    vertical._setShadow = shadowSetup;
    const context = {save() {}, restore() {}, fillRect() {}, fillText() {}, strokeText() {}};

    vertical._render(context);

    expect(handleFiller).toHaveBeenCalledWith(context, 'fillStyle', '#ff0000');
    expect(handleFiller).toHaveBeenCalledWith(context, 'strokeStyle', '#111111');
    expect(handleFiller).toHaveBeenCalledTimes(2);
    expect(shadowSetup).not.toHaveBeenCalled();
  });

  it('applies separate Fabric paint offsets without leaking glyph transforms', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'A', {
      hstarWritingMode:'vertical', fill:'#ff0000', stroke:'#111111', strokeWidth:2,
    });
    const handleFiller = vi.fn((context, property, filler) => (
      property === 'fillStyle' ? {offsetX:2, offsetY:3} : [4, 5]
    ));
    fabric.Text.prototype.handleFiller = handleFiller;
    vertical._setFillStyles = vi.fn();
    vertical._setStrokeStyles = vi.fn();
    vertical._applyPatternGradientTransform = vi.fn();
    const fillCalls = [];
    const strokeCalls = [];
    let saves = 0;
    let restores = 0;
    const context = {
      save() { saves += 1; },
      restore() { restores += 1; },
      fillText(...args) { fillCalls.push(args); },
      strokeText(...args) { strokeCalls.push(args); },
    };
    const glyph = vertical._hstarVerticalLayout.glyphs[0];
    const glyphX = (-vertical.width / 2) + glyph.x;
    const glyphY = (-vertical.height / 2) + glyph.y;

    vertical._render(context);

    expect(fillCalls[0]).toEqual(['A', glyphX - 2, glyphY - 3]);
    expect(strokeCalls[0]).toEqual(['A', glyphX - 4, glyphY - 5]);
    expect(handleFiller).toHaveBeenCalledWith(context, 'fillStyle', '#ff0000');
    expect(handleFiller).toHaveBeenCalledWith(context, 'strokeStyle', '#111111');
    expect(handleFiller).toHaveBeenCalledTimes(2);
    expect(vertical._setFillStyles).not.toHaveBeenCalled();
    expect(vertical._setStrokeStyles).not.toHaveBeenCalled();
    expect(vertical._applyPatternGradientTransform).not.toHaveBeenCalled();
    expect(saves).toBe(restores);
    expect(saves).toBeGreaterThanOrEqual(3);
  });

  it('updates one glyph style through the runtime API', () => {
    const fabric = createFabricMock();
    const vertical = runtime.createTextObject(fabric, 'AB', {hstarWritingMode:'vertical', fontSize:12, fill:'#111111'});
    const requestRenderAll = vi.fn();
    const setCoords = vi.fn();
    vertical.canvas = {requestRenderAll};
    vertical.setCoords = setCoords;
    const beforeHeight = vertical.height;
    const fills = [];
    const context = {
      save() {}, restore() {}, fillRect() {}, strokeText() {},
      set fillStyle(value) { this.currentFill = value; },
      fillText() { fills.push(this.currentFill); },
    };

    runtime.setGlyphStyle(vertical, 0, 1, {fontSize:36, fill:'#00aa00'});
    vertical._render(context);

    expect(vertical.dirty).toBe(true);
    expect(vertical.height).toBeGreaterThan(beforeHeight);
    expect(vertical._hstarVerticalLayout.glyphs[1]).toMatchObject({width:36, height:36});
    expect(vertical.styles[0][1]).toMatchObject({fontSize:36, fill:'#00aa00'});
    expect(setCoords).toHaveBeenCalled();
    expect(requestRenderAll).toHaveBeenCalledOnce();
    expect(fills).toContain('#00aa00');
  });

  it('uses real Fabric enlivening for vertical object reconstruction', async () => {
    new Function(readFileSync(vendorFabricPath, 'utf8'))();
    const realFabric = window.fabric;
    runtime.registerFabricClass(realFabric);
    const original = new realFabric.HstarVerticalText('A', {
      fontSize:28,
      fill:'#123456',
      stroke:'#abcdef',
      strokeWidth:1,
      shadow:new realFabric.Shadow({color:'#000000', blur:3, offsetX:1, offsetY:2}),
    });
    const serialized = original.toObject();
    const fromObject = vi.spyOn(realFabric.Object, '_fromObject');
    const reconstructed = await new Promise(resolveObject => {
      realFabric.HstarVerticalText.fromObject(serialized, resolveObject);
    });
    const context = {save() {}, restore() {}, fillText() {}, strokeText() {}, fillRect() {}};
    const handleFiller = vi.spyOn(realFabric.Text.prototype, 'handleFiller');

    expect(fromObject).toHaveBeenCalledWith('HstarVerticalText', serialized, expect.any(Function), 'text');
    expect(typeof realFabric.Text.prototype.handleFiller).toBe('function');
    expect(reconstructed.shadow).toBeInstanceOf(realFabric.Shadow);
    expect(() => reconstructed._render(context)).not.toThrow();
    expect(handleFiller).toHaveBeenCalledWith(context, 'fillStyle', '#123456');
    expect(() => reconstructed.drawObject(context)).not.toThrow();
    fromObject.mockRestore();
    delete window.fabric;
  });

  it('normalizes real Fabric serialized style ranges for vertical glyph layout and paint', () => {
    new Function(readFileSync(vendorFabricPath, 'utf8'))();
    const realFabric = window.fabric;
    runtime.registerFabricClass(realFabric);
    const source = new realFabric.IText('AB', {
      fontSize:20,
      fill:'#111111',
      styles:{0:{1:{fontSize:36, fill:'#ff0000'}}},
    });
    const serialized = source.toObject();
    const vertical = runtime.convertTextObject(realFabric, source, 'vertical');
    const fills = [];
    const context = {
      save() {}, restore() {}, fillRect() {}, strokeText() {},
      set fillStyle(value) { this.currentFill = value; },
      fillText() { fills.push(this.currentFill); },
    };

    expect(Array.isArray(serialized.styles)).toBe(true);
    expect(vertical._hstarVerticalLayout.glyphs[1]).toMatchObject({width:36, height:36});
    vertical._render(context);
    expect(fills).toContain('#ff0000');
    delete window.fabric;
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
      strokeDashArray:[5, 2],
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
    original.hstarRuntime = () => 'omit';
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
    expect(serialized.controls).toBeUndefined();
    expect(serialized.hstarRuntime).toBeUndefined();
    expect(reconstructed.styles).not.toBe(serialized.styles);
    expect(reconstructed.shadow).not.toBe(serialized.shadow);
    serialized.styles[0][0].fill = '#000000';
    serialized.shadow.color = '#ffffff';
    serialized.strokeDashArray[0] = 99;
    serialized.hstarData.tags.push('serialized-only');
    expect(original.styles[0][0].fill).toBe('#f97316');
    expect(original.shadow.color).toBe('#334155');
    expect(original.strokeDashArray[0]).toBe(5);
    expect(original.hstarData.tags).toEqual(['title']);
  });

  it('honors explicit writing modes and defaults legacy objects to horizontal', () => {
    expect(runtime.writingModeFor({hstarWritingMode:'vertical'})).toBe('vertical');
    expect(runtime.writingModeFor({type:'hstar-vertical-text', hstarWritingMode:'horizontal'})).toBe('horizontal');
    expect(runtime.writingModeFor({})).toBe('horizontal');
  });
});
