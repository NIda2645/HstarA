(function(global) {
  'use strict';

  const HORIZONTAL = 'horizontal';
  const VERTICAL = 'vertical';
  const VERTICAL_TYPE = 'hstar-vertical-text';
  const VERTICAL_TEXT_PROPERTIES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'stroke', 'strokeWidth',
    'charSpacing', 'lineHeight', 'textAlign', 'textBackgroundColor', 'backgroundColor',
    'underline', 'overline', 'linethrough', 'shadow', 'styles', 'opacity', 'angle', 'left',
    'top', 'scaleX', 'scaleY', 'skewX', 'skewY', 'flipX', 'flipY', 'originX', 'originY',
    'visible', 'selectable', 'evented', 'direction', 'paintFirst', 'strokeUniform',
    'strokeDashArray', 'strokeDashOffset', 'strokeLineCap', 'strokeLineJoin', 'strokeMiterLimit',
  ];
  const RUNTIME_PROPERTIES = new Set([
    'canvas', 'group', 'aCoords', 'oCoords', 'lineCoords', 'matrixCache', 'ownMatrixCache',
    'cacheKey', 'dirty', 'stateProperties', 'cacheProperties', 'colorProperties', 'ownDefaults',
    'selectionStart', 'selectionEnd', 'isEditing', 'hiddenTextarea', 'hiddenTextareaContainer',
    'cursorDuration', '_currentCursorOpacity', '__skipDimension', '_textLines',
    '_unwrappedTextLines', '_styleMap', 'dynamicMinWidth', '__corner', 'pathOffset', 'width',
    'height', 'type', 'text', 'hstarWritingMode',
  ]);
  const LAYOUT_PROPERTIES = new Set([
    'text', 'fontSize', 'fontFamily', 'fontWeight', 'fontStyle', 'lineHeight', 'charSpacing', 'styles',
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
    if(object._hstarUpdatingLayout) return object._hstarVerticalLayout;
    object._hstarUpdatingLayout = true;
    try {
      const layout = layoutVerticalText(object.text, object);
      object._hstarVerticalLayout = layout;
      object._hstarVerticalLayoutSignature = layoutSignature(object);
      if(typeof object.set === 'function') object.set({width:layout.width, height:layout.height});
      else Object.assign(object, {width:layout.width, height:layout.height});
      return layout;
    } finally {
      object._hstarUpdatingLayout = false;
    }
  }

  function layoutSignature(object) {
    let styles = '';
    try { styles = JSON.stringify(object.styles || null); } catch(error) { styles = String(object.styles); }
    return [object.text, object.fontSize, object.fontFamily, object.fontWeight, object.fontStyle,
      object.lineHeight, object.charSpacing, styles].join('\u0001');
  }

  function currentLayout(object) {
    if(!object._hstarVerticalLayout || object._hstarVerticalLayoutSignature !== layoutSignature(object)) {
      return applyVerticalDimensions(object);
    }
    return object._hstarVerticalLayout;
  }

  function glyphStyle(object, glyph) {
    const column = object.styles && object.styles[glyph.columnIndex];
    return Object.assign({}, object, column && column[glyph.rowIndex]);
  }

  function fontString(style) {
    return `${style.fontStyle || 'normal'} ${style.fontWeight || 'normal'} ${positiveNumber(style.fontSize, 40)}px ${style.fontFamily || 'sans-serif'}`;
  }

  function setPaintStyles(context, object, style) {
    try { if(typeof object._setFillStyles === 'function') object._setFillStyles(context, style); } catch(error) {}
    try { if(typeof object._setStrokeStyles === 'function') object._setStrokeStyles(context, style); } catch(error) {}
    let shadowApplied = false;
    try {
      if(style.shadow && typeof object._setShadow === 'function') {
        object._setShadow(context, style.shadow);
        shadowApplied = true;
      }
    } catch(error) {}
    if(style.shadow && !shadowApplied) {
      context.shadowColor = style.shadow.color || 'transparent';
      context.shadowBlur = style.shadow.blur || 0;
      context.shadowOffsetX = style.shadow.offsetX || 0;
      context.shadowOffsetY = style.shadow.offsetY || 0;
    }
    if(typeof style.fill === 'string') context.fillStyle = style.fill;
    if(typeof style.stroke === 'string') context.strokeStyle = style.stroke;
    if(style.strokeWidth != null) context.lineWidth = style.strokeWidth;
  }

  function collectSerializableOptions(source) {
    const properties = {};
    const names = new Set();
    let current = source;
    while(current && current !== Object.prototype) {
      Object.getOwnPropertyNames(current).forEach(name => {
        if(names.has(name)) return;
        names.add(name);
        if(name.startsWith('_') || RUNTIME_PROPERTIES.has(name)) return;
        let value;
        try { value = source[name]; } catch(error) { return; }
        const serializable = cloneSerializable(value);
        if(serializable !== undefined) properties[name] = serializable;
      });
      current = Object.getPrototypeOf(current);
    }
    return properties;
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

      _set(key, value) {
        let result;
        if(typeof this.callSuper === 'function') result = this.callSuper('_set', key, value);
        else if(fabric.Object && fabric.Object.prototype && typeof fabric.Object.prototype._set === 'function') {
          result = fabric.Object.prototype._set.call(this, key, value);
        } else {
          this[key] = value;
          result = this;
        }
        if(!this._hstarUpdatingLayout && LAYOUT_PROPERTIES.has(key)) {
          applyVerticalDimensions(this);
          this.dirty = true;
          if(typeof this.setCoords === 'function') this.setCoords();
        }
        return result || this;
      },

      setTextContent(value) {
        if(typeof this.set === 'function') this.set('text', String(value));
        else this.text = String(value);
        const layout = currentLayout(this);
        this.dirty = true;
        if(typeof this.setCoords === 'function') this.setCoords();
        return layout;
      },

      _render(context) {
        const layout = currentLayout(this);
        const offsetX = -this.width / 2;
        const offsetY = -this.height / 2;
        if(context.save) context.save();
        context.textAlign = 'center';
        context.textBaseline = 'top';
        if(typeof this.backgroundColor === 'string' && context.fillRect) {
          context.fillStyle = this.backgroundColor;
          context.fillRect(offsetX, offsetY, this.width, this.height);
        }
        layout.glyphs.forEach(glyph => {
          const style = glyphStyle(this, glyph);
          const size = positiveNumber(style.fontSize, 40);
          const x = offsetX + glyph.x;
          const y = offsetY + glyph.y;
          if(context.save) context.save();
          context.font = fontString(style);
          setPaintStyles(context, this, style);
          if(typeof style.textBackgroundColor === 'string' && context.fillRect) {
            context.fillStyle = style.textBackgroundColor;
            context.fillRect(x - (size / 2), y, size, size);
          }
          if(style.fill != null && context.fillText) context.fillText(glyph.character, x, y);
          if(style.stroke && Number(style.strokeWidth) > 0 && context.strokeText) context.strokeText(glyph.character, x, y);
          if(context.fillRect && (style.underline || style.overline || style.linethrough)) {
            const lineWidth = Math.max(1, Number(style.strokeWidth) || 1);
            if(typeof style.fill === 'string') context.fillStyle = style.fill;
            if(style.underline) context.fillRect(x - (size / 2), y + size - lineWidth, size, lineWidth);
            if(style.overline) context.fillRect(x - (size / 2), y, size, lineWidth);
            if(style.linethrough) context.fillRect(x - (size / 2), y + (size / 2), size, lineWidth);
          }
          if(context.restore) context.restore();
        });
        if(context.restore) context.restore();
      },

      toObject(extra) {
        const parent = fabric.Object && fabric.Object.prototype && fabric.Object.prototype.toObject;
        const metadata = {};
        Object.keys(this).forEach(name => {
          if(!name.startsWith('hstar')) return;
          const value = cloneSerializable(this[name]);
          if(value !== undefined) metadata[name] = value;
        });
        const included = [...new Set([
          ...VERTICAL_TEXT_PROPERTIES,
          ...Object.keys(metadata),
          ...(Array.isArray(extra) ? extra : []),
        ])];
        const object = typeof parent === 'function'
          ? fabric.Object.prototype.toObject.call(this, included)
          : {};
        Object.assign(object, metadata);
        ['styles', 'shadow', 'strokeDashArray'].forEach(name => {
          const value = cloneSerializable(object[name]);
          if(value !== undefined) object[name] = value;
        });
        Object.keys(object).forEach(name => {
          if(name.startsWith('hstar') && (typeof object[name] === 'function' || object[name] === undefined)) {
            delete object[name];
          }
        });
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
      if(fabric.Object && typeof fabric.Object._fromObject === 'function') {
        return fabric.Object._fromObject('HstarVerticalText', object, callback, 'text');
      }
      const text = object && object.text;
      const options = Object.assign(
        {},
        collectSerializableOptions(object),
      );
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
    if(['function', 'symbol', 'undefined', 'bigint'].includes(typeof value)) return undefined;
    if(Array.isArray(value)) return value.map(cloneSerializable).filter(value => value !== undefined);
    const prototype = Object.getPrototypeOf(value);
    if(prototype !== Object.prototype && prototype !== null) return value;
    return Object.fromEntries(Object.entries(value)
      .map(([key, child]) => [key, cloneSerializable(child)])
      .filter(([, child]) => child !== undefined));
  }

  function serializableObjectProperties(source) {
    const properties = {};
    Object.keys(source || {}).forEach(name => {
      if(name.startsWith('_') || RUNTIME_PROPERTIES.has(name)) return;
      const value = cloneSerializable(source[name]);
      if(value !== undefined) properties[name] = value;
    });
    return properties;
  }

  function copyConvertibleOptions(source) {
    let serialized = {};
    if(source && typeof source.toObject === 'function') {
      try { serialized = source.toObject(); } catch(error) { serialized = {}; }
    }
    const properties = serializableObjectProperties(serialized);
    Object.keys(source || {}).forEach(name => {
      if(!name.startsWith('hstar') || name === 'hstarWritingMode' || Object.hasOwn(properties, name)) return;
      const value = cloneSerializable(source[name]);
      if(value !== undefined) properties[name] = value;
    });
    return properties;
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
