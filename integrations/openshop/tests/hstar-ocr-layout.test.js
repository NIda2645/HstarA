import {readFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeEach, describe, expect, it} from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-ocr-layout.js');

function loadRuntime(){
  delete window.HstarOpenShopOcrLayout;
  new Function(readFileSync(runtimePath, 'utf8'))();
  return window.HstarOpenShopOcrLayout;
}

function createObject(text, writingMode){
  return {
    text,
    hstarWritingMode:writingMode,
    fontSize:40,
    charSpacing:0,
    lineHeight:1.16,
    scaleX:3,
    scaleY:2,
    width:1,
    height:1,
    left:0,
    top:0,
    angle:0,
    set(values){ Object.assign(this, values); return this; },
    initDimensions(){
      const count = Array.from(this.text.replace(/[\r\n]/g, '')).length;
      const spacing = Math.max(0, count - 1) * this.fontSize * this.charSpacing / 1000;
      if(this.hstarWritingMode === 'vertical'){
        this.width = this.fontSize * 1.16;
        this.height = this.fontSize * count * this.lineHeight + spacing;
      }else{
        this.width = this.fontSize * 0.64 * count + spacing;
        this.height = this.fontSize * 1.2;
      }
      return this;
    },
    setCoords(){ return this; },
  };
}

function measureVisibleBounds(object){
  const count = Array.from(object.text.replace(/[\r\n]/g, '')).length;
  const spacing = Math.max(0, count - 1) * object.fontSize * object.charSpacing / 1000;
  const width = object.hstarWritingMode === 'vertical'
    ? object.fontSize * 0.75
    : object.fontSize * 0.55 * count + spacing;
  const height = object.hstarWritingMode === 'vertical'
    ? object.fontSize * 0.7 * count + spacing
    : object.fontSize * 0.72;
  return {left:-width / 2, top:-height / 2, width, height};
}

function visibleOrigin(object, bounds, angle){
  const radians = angle * Math.PI / 180;
  const x = (bounds.left + object.width / 2) * object.scaleX;
  const y = (bounds.top + object.height / 2) * object.scaleY;
  return {
    x:object.left + Math.cos(radians) * x - Math.sin(radians) * y,
    y:object.top + Math.sin(radians) * x + Math.cos(radians) * y,
  };
}

function renderedVisibleSize(object, bounds){
  return {
    width:bounds.width * Math.abs(object.scaleX),
    height:bounds.height * Math.abs(object.scaleY),
  };
}

function expectRenderedVisibleBounds(object, bounds, target){
  const rendered = renderedVisibleSize(object, bounds);
  expect(rendered.width).toBeLessThanOrEqual(target.width + 0.001);
  expect(rendered.height).toBeLessThanOrEqual(target.height + 0.001);
  expect(Math.min(
    Math.abs(rendered.width - target.width),
    Math.abs(rendered.height - target.height),
  )).toBeLessThanOrEqual(0.001);
}

describe('OpenShop OCR v5 visible glyph layout', () => {
  let runtime;

  beforeEach(() => {
    runtime = loadRuntime();
  });

  it('fits horizontal visible glyphs to the complete OCR region', () => {
    const object = createObject('SUMMER', 'horizontal');
    const target = {left:120, top:80, width:360, height:72, angle:0};

    const result = runtime.fitLineObject(object, target, {
      writingMode:'horizontal', measure:measureVisibleBounds,
    });

    expect(object.scaleY).toBe(1);
    expect(object.fontSize).toBeGreaterThan(40);
    expect(object.charSpacing).toBe(0);
    expect(result.visibleBox.height).toBeCloseTo(target.height, 3);
    expect(object.scaleX).toBe(1);
    expectRenderedVisibleBounds(object, result.visibleBox, target);
    expect(visibleOrigin(object, result.visibleBox, target.angle)).toEqual({x:target.left, y:target.top});
  });

  it('fits vertical visible glyphs to the complete OCR region', () => {
    const object = createObject('小暑节气', 'vertical');
    const target = {left:420, top:130, width:90, height:300, angle:0};

    const result = runtime.fitLineObject(object, target, {
      writingMode:'vertical', measure:measureVisibleBounds,
    });

    expect(object.fontSize).toBeGreaterThan(40);
    expect(object.charSpacing).toBe(0);
    expect(object.scaleX).toBeCloseTo(1, 6);
    expect(object.scaleY).toBe(1);
    expectRenderedVisibleBounds(object, result.visibleBox, target);
    expect(visibleOrigin(object, result.visibleBox, target.angle)).toEqual({x:target.left, y:target.top});
  });

  it('rotates the visible-bound offset around the OCR quad top-left', () => {
    const object = createObject('ROTATE', 'horizontal');
    const target = {left:250, top:140, width:300, height:60, angle:17};

    const result = runtime.fitLineObject(object, target, {
      writingMode:'horizontal', measure:measureVisibleBounds,
    });

    const origin = visibleOrigin(object, result.visibleBox, target.angle);
    expect(origin.x).toBeCloseTo(target.left, 6);
    expect(origin.y).toBeCloseTo(target.top, 6);
    expect(object.angle).toBe(17);
  });

  it('treats punctuation as normal text and does not read v4 fitting options', () => {
    const object = createObject('微风不燥，', 'vertical');
    const target = {left:60, top:90, width:75, height:350, angle:0};
    const options = {
      writingMode:'vertical',
      measure:measureVisibleBounds,
      get metricGeometry(){ throw new Error('must not read metricGeometry'); },
      get metricText(){ throw new Error('must not read metricText'); },
      get glyphGeometries(){ throw new Error('must not read glyphGeometries'); },
      get hstarVerticalTrailingPunctuationOffset(){ throw new Error('must not read punctuation offsets'); },
    };

    const result = runtime.fitLineObject(object, target, options);

    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expectRenderedVisibleBounds(object, result.visibleBox, target);
    expect(object).not.toHaveProperty('hstarVerticalTrailingPunctuationOffset');
  });

  it('fits a single glyph region without introducing tracking', () => {
    const object = createObject('夏', 'horizontal');
    const target = {left:25, top:35, width:180, height:72, angle:0};

    const result = runtime.fitLineObject(object, target, {
      writingMode:'horizontal', measure:measureVisibleBounds,
    });

    expect(object.fontSize).toBeGreaterThan(40);
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expectRenderedVisibleBounds(object, result.visibleBox, target);
    expect(object.charSpacing).toBe(0);
    expect(visibleOrigin(object, result.visibleBox, target.angle)).toEqual({x:target.left, y:target.top});
  });

  it('scales character-level font sizes with the fitted base size', () => {
    const object = createObject('A', 'horizontal');
    object.styles = {0:{0:{fontSize:20}}};
    const measure = candidate => {
      const size = candidate.styles[0][0].fontSize;
      return {left:-size * 0.25, top:-size * 0.36, width:size * 0.5, height:size * 0.72};
    };

    runtime.fitLineObject(object, {left:10, top:20, width:50, height:72, angle:0}, {
      writingMode:'horizontal', measure,
    });

    expect(object.fontSize).toBeCloseTo(200, 3);
    expect(object.styles[0][0].fontSize).toBeCloseTo(100, 3);
    expect(object.scaleX).toBeCloseTo(1, 6);
    expect(object.scaleY).toBe(1);
  });

  it('fits a narrow horizontal line with zero tracking', () => {
    const object = createObject('12345678', 'horizontal');
    object.fontSize = 14;
    const measure = candidate => {
      const count = Array.from(candidate.text).length;
      const spacing = Math.max(0, count - 1) * candidate.fontSize * candidate.charSpacing / 1000;
      const width = candidate.fontSize * count + spacing;
      const height = candidate.fontSize * 0.72;
      return {left:-width / 2, top:-height / 2, width, height};
    };

    const result = runtime.fitLineObject(object, {
      left:75, top:120, width:112, height:15, angle:0,
    }, {writingMode:'horizontal', measure});

    expect(object.charSpacing).toBe(0);
    expect(object.fontSize).toBeGreaterThanOrEqual(14);
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expectRenderedVisibleBounds(object, result.visibleBox, {width:112, height:15});
    expect(visibleOrigin(object, result.visibleBox, 0)).toEqual({x:75, y:120});
  });

  it('reduces font size instead of scaling or negative tracking for flow overflow', () => {
    const object = createObject('ABCDEFGH', 'horizontal');
    const measure = candidate => {
      const count = Array.from(candidate.text).length;
      const spacing = Math.max(0, count - 1) * candidate.fontSize * candidate.charSpacing / 1000;
      const width = candidate.fontSize * count + spacing;
      const height = candidate.fontSize * 0.72;
      return {left:-width / 2, top:-height / 2, width, height};
    };

    const result = runtime.fitLineObject(object, {
      left:10, top:20, width:100, height:100, angle:0,
    }, {writingMode:'horizontal', measure});

    expect(object.charSpacing).toBe(0);
    expect(object.fontSize).toBeLessThan(40);
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expectRenderedVisibleBounds(object, result.visibleBox, {width:100, height:100});
  });

  it('enlarges a vertical estimate when the OCR region is larger', () => {
    const object = createObject('AB', 'vertical');
    object.fontSize = 286;
    object.charSpacing = 120;
    const target = {left:195, top:369, width:531, height:924, angle:0};

    const result = runtime.fitLineObject(object, target, {
      writingMode:'vertical', measure:measureVisibleBounds,
    });

    expect(object.fontSize).toBeGreaterThan(286);
    expect(object.charSpacing).toBe(0);
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expectRenderedVisibleBounds(object, result.visibleBox, target);
    expect(visibleOrigin(object, result.visibleBox, 0)).toEqual({x:target.left, y:target.top});
  });

  it('normalizes a negative OCR spacing estimate to zero', () => {
    const object = createObject('ABCD', 'horizontal');
    object.charSpacing = -80;
    object.styles = {0:{0:{charSpacing:-120}, 1:{charSpacing:-40}}};

    runtime.fitLineObject(object, {
      left:10, top:20, width:80, height:30, angle:0,
    }, {writingMode:'horizontal', measure:measureVisibleBounds});

    expect(object.charSpacing).toBe(0);
    expect(object.styles[0][0].charSpacing).toBe(0);
    expect(object.styles[0][1].charSpacing).toBe(0);
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expectRenderedVisibleBounds(object, measureVisibleBounds(object), {width:80, height:30});
  });

  it('normalizes a positive OCR spacing estimate and character styles to zero', () => {
    const object = createObject('ABCD', 'horizontal');
    object.charSpacing = 180;
    object.styles = {0:{0:{charSpacing:120}, 1:{charSpacing:40}}};

    runtime.fitLineObject(object, {
      left:10, top:20, width:180, height:40, angle:0,
    }, {writingMode:'horizontal', measure:measureVisibleBounds});

    expect(object.charSpacing).toBe(0);
    expect(object.styles[0][0].charSpacing).toBe(0);
    expect(object.styles[0][1].charSpacing).toBe(0);
    expect(object.fontSize).toBeGreaterThan(40);
    expect(object.scaleY).toBe(1);
    expect(object.scaleX).toBe(1);
    expectRenderedVisibleBounds(object, measureVisibleBounds(object), {width:180, height:40});
  });

  it('keeps the closest flow-axis fit when pixel measurements oscillate', () => {
    const object = createObject('ABCD', 'vertical');
    const target = {left:10, top:20, width:50, height:275.1, angle:0};
    const measure = candidate => {
      const height = candidate.charSpacing < -20 ? 274 : 276;
      return {left:-25, top:-height / 2, width:50, height};
    };

    const result = runtime.fitLineObject(object, target, {
      writingMode:'vertical', measure,
    });

    expect(result.visibleBox.height).toBe(276);
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
    expect(renderedVisibleSize(object, result.visibleBox).height).toBeLessThanOrEqual(target.height + 1);
  });

  it('rejects a non-finite visible measurement without leaving object scaling', () => {
    const object = createObject('FAIL', 'horizontal');

    expect(() => runtime.fitLineObject(object, {
      left:0, top:0, width:100, height:30, angle:0,
    }, {
      writingMode:'horizontal',
      measure:() => ({left:0, top:0, width:Number.NaN, height:20}),
    })).toThrow('OCR visible glyph bounds are invalid');
    expect(object.scaleX).toBe(1);
    expect(object.scaleY).toBe(1);
  });

  it('merges only paragraph lines representable by one uniform interval', () => {
    const line = (lineIndex, top) => ({
      paragraphId:'p-1',
      lineIndex,
      writingMode:'horizontal',
      rotation:0,
      styleSignature:'same-style',
      geometry:{left:100, top, width:240, height:40, angle:0},
    });

    expect(runtime.paragraphPlan([line(0, 80), line(1, 140), line(2, 200)]))
      .toMatchObject({merge:true, interval:60});
    expect(runtime.paragraphPlan([line(0, 80), line(1, 140), line(2, 225)]))
      .toMatchObject({merge:false, reason:'irregular-line-spacing'});
  });

  it('does not merge paragraphs with incompatible styles or cross-axis sizes', () => {
    const base = {
      paragraphId:'p-1', writingMode:'vertical', rotation:0,
      styleSignature:'style-a', geometry:{left:300, top:50, width:50, height:220, angle:0},
    };

    expect(runtime.paragraphPlan([
      {...base, lineIndex:0},
      {...base, lineIndex:1, styleSignature:'style-b', geometry:{...base.geometry, left:240}},
    ])).toMatchObject({merge:false, reason:'incompatible-style'});
    expect(runtime.paragraphPlan([
      {...base, lineIndex:0},
      {...base, lineIndex:1, geometry:{...base.geometry, left:240, width:54}},
    ])).toMatchObject({merge:false, reason:'incompatible-cross-size'});
  });

  it('maps normalized OCR quads back to document pixels', () => {
    const geometry = runtime.quadGeometry([
      {x:0.1, y:0.2}, {x:0.4, y:0.2}, {x:0.4, y:0.3}, {x:0.1, y:0.3},
    ], 1920, 1080, 0);

    expect(geometry).toEqual({left:192, top:216, width:576, height:108, angle:0});
  });
});
