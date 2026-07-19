(function(global) {
  'use strict';

  const HORIZONTAL = 'horizontal';
  const VERTICAL = 'vertical';
  const VERTICAL_TYPE = 'hstar-vertical-text';
  const RUNTIME_KEYS = new Set([
    'canvas', 'group', 'width', 'height', 'type', 'text', 'hstarWritingMode',
    'aCoords', 'oCoords', 'matrixCache', 'ownMatrixCache', 'cacheKey', 'dirty',
  ]);

  function normalizeWritingMode(value) {
    return value === VERTICAL ? VERTICAL : HORIZONTAL;
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function layoutVerticalText(raw, style = {}) {
    const text = String(raw);
    const fontSize = positiveNumber(style.fontSize, 40);
    const lineHeight = positiveNumber(style.lineHeight, 1.16);
    const charSpacing = Number.isFinite(Number(style.charSpacing)) ? Number(style.charSpacing) : 0;
    const advance = Math.max(1, fontSize * lineHeight + (fontSize * charSpacing / 1000));
    const columnGap = Math.max(0, fontSize * (lineHeight - 1));
    const columns = text.split(/\r\n|\r|\n/).map(column => Array.from(column));
    const width = Math.max(fontSize, (columns.length * fontSize) + ((columns.length - 1) * columnGap));
    const height = Math.max(fontSize, ...columns.map(column => column.length * advance));
    const glyphs = [];

    columns.forEach((column, columnIndex) => {
      const x = width - (fontSize / 2) - (columnIndex * (fontSize + columnGap));
      column.forEach((character, rowIndex) => {
        glyphs.push({
          character,
          columnIndex,
          rowIndex,
          x,
          y:rowIndex * advance,
          width:fontSize,
          height:fontSize,
          advance,
        });
      });
    });

    return {text, writingMode:VERTICAL, columns, glyphs, width, height};
  }

  function applyVerticalDimensions(object) {
    const layout = layoutVerticalText(object.text, object);
    object._hstarVerticalLayout = layout;
    if(typeof object.set === 'function') object.set({width:layout.width, height:layout.height});
    else Object.assign(object, {width:layout.width, height:layout.height});
    return layout;
  }

  function createVerticalMethods(fabric) {
    return {
      type:VERTICAL_TYPE,
      hstarWritingMode:VERTICAL,

      initialize(text, options = {}) {
        if(typeof this.callSuper === 'function') this.callSuper('initialize', options);
        else if(fabric.Object && fabric.Object.prototype && typeof fabric.Object.prototype.initialize === 'function') {
          fabric.Object.prototype.initialize.call(this, options);
        } else {
          Object.assign(this, options);
        }
        this.type = VERTICAL_TYPE;
        this.text = String(text);
        this.hstarWritingMode = VERTICAL;
        applyVerticalDimensions(this);
        return this;
      },

      initDimensions() {
        return applyVerticalDimensions(this);
      },

      _render(context) {
        const layout = this._hstarVerticalLayout || applyVerticalDimensions(this);
        const offsetX = -this.width / 2;
        const offsetY = -this.height / 2;
        if(context.save) context.save();
        if(this.fontFamily) context.font = `${this.fontStyle || 'normal'} ${this.fontWeight || 'normal'} ${this.fontSize || 40}px ${this.fontFamily}`;
        context.textAlign = 'center';
        context.textBaseline = 'top';
        if(this.fill) context.fillStyle = this.fill;
        layout.glyphs.forEach(glyph => {
          if(context.fillText) context.fillText(glyph.character, offsetX + glyph.x, offsetY + glyph.y);
        });
        if(context.restore) context.restore();
      },

      toObject(extra) {
        const parent = fabric.Object && fabric.Object.prototype && fabric.Object.prototype.toObject;
        const object = typeof parent === 'function' ? parent.call(this, extra) : {};
        object.type = VERTICAL_TYPE;
        object.text = this.text;
        object.hstarWritingMode = VERTICAL;
        return object;
      },
    };
  }

  function registerFabricClass(fabric) {
    if(!fabric) throw new Error('Fabric runtime is required');
    if(fabric.HstarVerticalText) return fabric.HstarVerticalText;

    const methods = createVerticalMethods(fabric);
    let HstarVerticalText;
    if(fabric.util && typeof fabric.util.createClass === 'function' && fabric.Object) {
      HstarVerticalText = fabric.util.createClass(fabric.Object, methods);
    } else {
      const BaseObject = fabric.Object || class {};
      HstarVerticalText = class HstarVerticalText extends BaseObject {
        constructor(text, options) {
          super();
          this.initialize(text, options);
        }
      };
      Object.assign(HstarVerticalText.prototype, methods);
    }

    HstarVerticalText.prototype.type = VERTICAL_TYPE;
    HstarVerticalText.prototype.hstarWritingMode = VERTICAL;
    HstarVerticalText.fromObject = function fromObject(object, callback) {
      const options = Object.assign({}, object || {});
      const text = options.text;
      delete options.type;
      delete options.text;
      delete options.hstarWritingMode;
      const instance = new HstarVerticalText(text, options);
      if(typeof callback === 'function') callback(instance);
      return instance;
    };
    fabric.HstarVerticalText = HstarVerticalText;
    return HstarVerticalText;
  }

  function createTextObject(fabric, text, options = {}) {
    const config = Object.assign({}, options);
    const mode = normalizeWritingMode(config.hstarWritingMode);
    if(mode === VERTICAL) {
      registerFabricClass(fabric);
      return new fabric.HstarVerticalText(text, Object.assign(config, {hstarWritingMode:VERTICAL}));
    }
    if(!fabric || !fabric.IText) throw new Error('Fabric IText is required for horizontal text');
    return new fabric.IText(String(text), Object.assign(config, {hstarWritingMode:HORIZONTAL}));
  }

  function cloneSerializable(value) {
    if(value == null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
    if(typeof value === 'function') return undefined;
    if(Array.isArray(value)) return value.map(cloneSerializable).filter(value => value !== undefined);
    if(Object.prototype.toString.call(value) !== '[object Object]') return value;
    return Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [key, cloneSerializable(child)])
      .filter(([, child]) => child !== undefined));
  }

  function copyConvertibleOptions(source) {
    const options = {};
    Object.keys(source || {}).forEach(key => {
      if(key.startsWith('_') || RUNTIME_KEYS.has(key) || typeof source[key] === 'function') return;
      const value = cloneSerializable(source[key]);
      if(value !== undefined) options[key] = value;
    });
    return options;
  }

  function writingModeFor(object) {
    return normalizeWritingMode(object && object.hstarWritingMode);
  }

  function convertTextObject(fabric, source, mode) {
    const text = source && source.text !== undefined ? source.text : '';
    const options = copyConvertibleOptions(source);
    options.hstarWritingMode = normalizeWritingMode(mode);
    return createTextObject(fabric, text, options);
  }

  function destroy() {}

  global.HstarOpenShopWritingMode = {
    HORIZONTAL,
    VERTICAL,
    normalizeWritingMode,
    layoutVerticalText,
    registerFabricClass,
    writingModeFor,
    createTextObject,
    convertTextObject,
    destroy,
  };
})(typeof window !== 'undefined' ? window : globalThis);
