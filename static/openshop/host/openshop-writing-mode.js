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
  const PAINT_PROPERTIES = new Set([
    'fill', 'stroke', 'strokeWidth', 'strokeDashArray', 'strokeDashOffset', 'strokeLineCap',
    'strokeLineJoin', 'strokeMiterLimit', 'paintFirst', 'shadow', 'textBackgroundColor',
    'underline', 'overline', 'linethrough', 'opacity', 'styles', 'backgroundColor',
  ]);
  const VERTICAL_EDITOR_SELECTOR = 'textarea[data-hstar-vertical-editor]';
  const MIN_EDITOR_WIDTH = 32;
  const MIN_EDITOR_HEIGHT = 48;
  let editorElement = null;
  let activeObject = null;
  let activeFabric = null;
  let activeOriginalText = null;
  let activeCanvas = null;
  let activeCanvasBindings = [];
  let editorDocument = null;
  let pendingEditorInput = null;
  let compositionReplacement = null;
  let compositionActive = false;
  let pointerFocusObject = null;
  let pointerFocusTimer = 0;

  function documentForRuntime() {
    return global && global.document ? global.document : null;
  }

  function clearPointerFocusGuard() {
    if(pointerFocusTimer && typeof global.clearTimeout === 'function') global.clearTimeout(pointerFocusTimer);
    pointerFocusTimer = 0;
    pointerFocusObject = null;
  }

  function armPointerFocusGuard(object, event) {
    const type = String(event && event.type || '').toLowerCase();
    if(!/(?:mouse|pointer|touch)/.test(type) || typeof global.setTimeout !== 'function') return;
    clearPointerFocusGuard();
    pointerFocusObject = object;
    pointerFocusTimer = global.setTimeout(() => {
      pointerFocusTimer = 0;
      if(activeObject === object && editorElement && editorElement.ownerDocument?.activeElement !== editorElement) {
        try { editorElement.focus({preventScroll:true}); } catch(error) { editorElement.focus?.(); }
      }
      pointerFocusObject = null;
    }, 0);
  }

  function readRect(element) {
    if(!element || typeof element.getBoundingClientRect !== 'function') return null;
    try {
      return element.getBoundingClientRect() || null;
    } catch(error) {
      return null;
    }
  }

  function finiteValue(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function logicalCanvasDimension(canvas, canvasElement, axis) {
    const getter = axis === 'width' ? 'getWidth' : 'getHeight';
    if(canvas && typeof canvas[getter] === 'function') {
      try {
        const value = Number(canvas[getter]());
        if(Number.isFinite(value) && value > 0) return value;
      } catch(error) {
        // Fall through to the logical canvas element dimensions.
      }
    }
    const lowerCanvasValue = Number(canvas && canvas.lowerCanvasEl && canvas.lowerCanvasEl[axis]);
    if(Number.isFinite(lowerCanvasValue) && lowerCanvasValue > 0) return lowerCanvasValue;
    const elementValue = Number(canvasElement && canvasElement[axis]);
    return Number.isFinite(elementValue) && elementValue > 0 ? elementValue : null;
  }

  function canvasCssRatio(canvas, canvasElement, canvasRect) {
    const logicalWidth = logicalCanvasDimension(canvas, canvasElement, 'width');
    const logicalHeight = logicalCanvasDimension(canvas, canvasElement, 'height');
    const cssWidth = finiteValue(canvasRect && canvasRect.width);
    const cssHeight = finiteValue(canvasRect && canvasRect.height);
    return {
      x:logicalWidth && cssWidth > 0 ? cssWidth / logicalWidth : 1,
      y:logicalHeight && cssHeight > 0 ? cssHeight / logicalHeight : 1,
    };
  }

  function validTransformMatrix(matrix) {
    return Array.isArray(matrix) && matrix.length >= 6
      && matrix.slice(0, 6).every(value => Number.isFinite(Number(value)));
  }

  function multiplyTransformMatrices(left, right) {
    return [
      (left[0] * right[0]) + (left[2] * right[1]),
      (left[1] * right[0]) + (left[3] * right[1]),
      (left[0] * right[2]) + (left[2] * right[3]),
      (left[1] * right[2]) + (left[3] * right[3]),
      (left[0] * right[4]) + (left[2] * right[5]) + left[4],
      (left[1] * right[4]) + (left[3] * right[5]) + left[5],
    ];
  }

  function combinedTransform(fabric, viewport, objectMatrix) {
    const multiply = fabric && fabric.util && fabric.util.multiplyTransformMatrices;
    if(typeof multiply === 'function') {
      try {
        const combined = multiply(viewport, objectMatrix);
        if(validTransformMatrix(combined)) return combined.map(Number);
      } catch(error) {
        // Use the local Fabric-compatible matrix multiplication below.
      }
    }
    return multiplyTransformMatrices(viewport.map(Number), objectMatrix.map(Number));
  }

  function editorGeometry(object, fabric) {
    const canvas = object && object.canvas;
    const canvasElements = canvas ? [canvas.upperCanvasEl, canvas.lowerCanvasEl].filter(Boolean) : [];
    let canvasElement = null;
    let canvasRect = null;
    for(const candidate of canvasElements) {
      canvasRect = readRect(candidate);
      canvasElement = candidate;
      if(canvasRect) break;
    }
    canvasRect = canvasRect || {left:0, top:0};
    const ratio = canvasCssRatio(canvas, canvasElement, canvasRect);
    const viewport = canvas && canvas.viewportTransform;
    if(object && typeof object.calcTransformMatrix === 'function' && validTransformMatrix(viewport)) {
      try {
        const objectMatrix = object.calcTransformMatrix();
        if(validTransformMatrix(objectMatrix)) {
          const combined = combinedTransform(fabric, viewport, objectMatrix);
          return {
            left:finiteValue(canvasRect.left) + (combined[4] * ratio.x),
            top:finiteValue(canvasRect.top) + (combined[5] * ratio.y),
            width:Math.max(MIN_EDITOR_WIDTH, finiteValue(object.width, MIN_EDITOR_WIDTH)),
            height:Math.max(MIN_EDITOR_HEIGHT, finiteValue(object.height, MIN_EDITOR_HEIGHT)),
            matrix:[
              combined[0] * ratio.x,
              combined[1] * ratio.y,
              combined[2] * ratio.x,
              combined[3] * ratio.y,
            ],
          };
        }
      } catch(error) {
        // Fall back to Fabric's viewport-transformed bounding rectangle.
      }
    }
    let objectRect = null;
    try {
      objectRect = object && typeof object.getBoundingRect === 'function'
        ? object.getBoundingRect() : null;
    } catch(error) {
      objectRect = null;
    }
    const left = finiteValue(objectRect && (objectRect.left ?? objectRect.x), finiteValue(object && object.left)) * ratio.x;
    const top = finiteValue(objectRect && (objectRect.top ?? objectRect.y), finiteValue(object && object.top)) * ratio.y;
    const fallbackWidth = finiteValue(object && object.width, MIN_EDITOR_WIDTH);
    const fallbackHeight = finiteValue(object && object.height, MIN_EDITOR_HEIGHT);
    const width = finiteValue(objectRect && objectRect.width, fallbackWidth) * ratio.x;
    const height = finiteValue(objectRect && objectRect.height, fallbackHeight) * ratio.y;
    return {
      left:finiteValue(canvasRect.left) + left,
      top:finiteValue(canvasRect.top) + top,
      width:Math.max(MIN_EDITOR_WIDTH, width),
      height:Math.max(MIN_EDITOR_HEIGHT, height),
      matrix:null,
    };
  }

  function applyEditorStyles(object, fabric = activeFabric) {
    if(!editorElement) return;
    const geometry = editorGeometry(object, fabric);
    const fontSize = positiveNumber(object && object.fontSize, 40);
    const lineHeight = positiveNumber(object && object.lineHeight, 1.16);
    editorElement.style.display = 'block';
    editorElement.style.position = 'fixed';
    editorElement.style.zIndex = '2147483647';
    editorElement.style.resize = 'none';
    editorElement.style.writingMode = 'vertical-rl';
    editorElement.style.textOrientation = 'mixed';
    editorElement.style.fontFamily = String(object && object.fontFamily || 'sans-serif');
    editorElement.style.fontSize = `${fontSize}px`;
    editorElement.style.fontWeight = String(object && object.fontWeight || 'normal');
    editorElement.style.fontStyle = String(object && object.fontStyle || 'normal');
    editorElement.style.color = String(object && object.fill || 'currentColor');
    editorElement.style.lineHeight = String(lineHeight);
    editorElement.style.transform = geometry.matrix
      ? `matrix(${geometry.matrix.join(', ')}, 0, 0) translate(-50%, -50%)`
      : 'none';
    editorElement.style.transformOrigin = '0px 0px';
    editorElement.style.left = `${geometry.left}px`;
    editorElement.style.top = `${geometry.top}px`;
    editorElement.style.width = `${geometry.width}px`;
    editorElement.style.height = `${geometry.height}px`;
  }

  function requestObjectRender(object, canvas = object && object.canvas) {
    if(canvas && typeof canvas.requestRenderAll === 'function') {
      try { canvas.requestRenderAll(); } catch(error) { /* disposed canvases cannot render */ }
    }
  }

  function fireEvent(target, name, payload) {
    if(!target || typeof target.fire !== 'function') return;
    try {
      if(payload === undefined) target.fire(name);
      else target.fire(name, payload);
    } catch(error) { /* disposed Fabric targets may reject events */ }
  }

  function rawText(value) {
    return String(value == null ? '' : value);
  }

  function verticalGlyphLocations(value) {
    const text = rawText(value);
    const glyphs = [];
    let columnIndex = 0;
    let rowIndex = 0;
    for(let offset = 0; offset < text.length;) {
      const character = text[offset];
      if(character === '\r') {
        offset += text[offset + 1] === '\n' ? 2 : 1;
        columnIndex += 1;
        rowIndex = 0;
        continue;
      }
      if(character === '\n') {
        offset += 1;
        columnIndex += 1;
        rowIndex = 0;
        continue;
      }
      const length = String.fromCodePoint(text.codePointAt(offset)).length;
      glyphs.push({offset, length, columnIndex, rowIndex});
      offset += length;
      rowIndex += 1;
    }
    return glyphs;
  }

  function sharedTextRange(before, after) {
    const commonLength = Math.min(before.length, after.length);
    let prefix = 0;
    while(prefix < commonLength && before[prefix] === after[prefix]) prefix += 1;
    let suffix = 0;
    while(
      suffix < commonLength - prefix
      && before[before.length - suffix - 1] === after[after.length - suffix - 1]
    ) suffix += 1;
    return {
      prefix,
      beforeSuffixStart:before.length - suffix,
      afterSuffixStart:after.length - suffix,
    };
  }

  function boundedTextRange(text, start, end) {
    const from = Math.max(0, Math.min(text.length, Number(start) || 0));
    return {start:from, end:Math.max(from, Math.min(text.length, Number(end) || from))};
  }

  function targetTextRange(event, text) {
    if(!event || typeof event.getTargetRanges !== 'function') return null;
    try {
      const ranges = event.getTargetRanges();
      if(!ranges || ranges.length !== 1) return null;
      const range = ranges[0];
      const start = Number(range && range.startOffset);
      const end = Number(range && range.endOffset);
      if(!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start || end > text.length) return null;
      return {start, end};
    } catch(error) {
      return null;
    }
  }

  function isCompositionInputType(inputType) {
    return typeof inputType === 'string' && inputType.includes('Composition');
  }

  function clearCompositionState() {
    compositionReplacement = null;
    compositionActive = false;
  }

  function caretAnchoredTextRange(before, after, oldCaret, newCaret) {
    const oldRange = boundedTextRange(before, oldCaret, oldCaret);
    const newRange = boundedTextRange(after, newCaret, newCaret);
    const oldOffset = oldRange.start;
    const newOffset = newRange.start;
    let prefix = 0;
    let suffix = 0;
    if(before.slice(oldOffset) === after.slice(newOffset)) {
      while(prefix < oldOffset && prefix < newOffset && before[prefix] === after[prefix]) prefix += 1;
      return {prefix, beforeSuffixStart:oldOffset, afterSuffixStart:newOffset};
    }
    if(before.slice(0, oldOffset) === after.slice(0, newOffset)) {
      while(
        before.length - suffix > oldOffset
        && after.length - suffix > newOffset
        && before[before.length - suffix - 1] === after[after.length - suffix - 1]
      ) suffix += 1;
      return {prefix:oldOffset, beforeSuffixStart:before.length - suffix, afterSuffixStart:after.length - suffix};
    }
    while(prefix < oldOffset && prefix < newOffset && before[prefix] === after[prefix]) prefix += 1;
    while(
      before.length - suffix > oldOffset
      && after.length - suffix > newOffset
      && before[before.length - suffix - 1] === after[after.length - suffix - 1]
    ) suffix += 1;
    return {prefix, beforeSuffixStart:before.length - suffix, afterSuffixStart:after.length - suffix};
  }

  function replacementTextRange(before, after, start, end, inputType, afterSelection, rangeSource) {
    const selection = boundedTextRange(before, start, end);
    let from = selection.start;
    let to = selection.end;
    const deletedLength = before.length - after.length;
    if(from === to && deletedLength > 0 && typeof inputType === 'string' && inputType.startsWith('delete')) {
      if(inputType.endsWith('Backward')) from = Math.max(0, from - deletedLength);
      if(inputType.endsWith('Forward')) to = Math.min(before.length, to + deletedLength);
    }
    const shouldAnchorToCarets = from === to && rangeSource === 'selection'
      && (inputType === 'insertReplacementText' || inputType === 'deleteEntireSoftLine');
    if(shouldAnchorToCarets) {
      const afterRange = boundedTextRange(after, afterSelection && afterSelection.start, afterSelection && afterSelection.end);
      return caretAnchoredTextRange(before, after, from, afterRange.start);
    }
    return {
      prefix:from,
      beforeSuffixStart:to,
      afterSuffixStart:Math.max(from, after.length - (before.length - to)),
    };
  }

  function stylesByRawOffset(object, text) {
    const result = new Map();
    const styles = object && object.styles;
    verticalGlyphLocations(text).forEach(location => {
      const column = styles && styles[location.columnIndex];
      if(column && Object.prototype.hasOwnProperty.call(column, location.rowIndex)) {
        result.set(location.offset, cloneSerializable(column[location.rowIndex]));
      }
    });
    return result;
  }

  function styleImmediatelyBefore(styles, locations, offset) {
    const location = locations.find(candidate => candidate.offset + candidate.length === offset);
    return location && styles.has(location.offset) ? styles.get(location.offset) : undefined;
  }

  function styleAtReplacementStart(styles, locations, offset) {
    const location = locations.find(candidate => candidate.offset <= offset && offset < candidate.offset + candidate.length);
    return location && styles.has(location.offset) ? styles.get(location.offset) : undefined;
  }

  function rebaseVerticalStyles(object, before, after, replacement, afterSelection) {
    const beforeLocations = verticalGlyphLocations(before);
    const afterLocations = verticalGlyphLocations(after);
    const oldStyles = stylesByRawOffset(object, before);
    const rebased = new Map();
    const range = replacement && replacement.text === before
      ? replacementTextRange(
        before, after, replacement.selectionStart, replacement.selectionEnd, replacement.inputType,
        afterSelection, replacement.rangeSource,
      )
      : sharedTextRange(before, after);
    const delta = after.length - before.length;

    beforeLocations.forEach(location => {
      if(!oldStyles.has(location.offset)) return;
      if(location.offset + location.length <= range.prefix) rebased.set(location.offset, oldStyles.get(location.offset));
      else if(location.offset >= range.beforeSuffixStart) rebased.set(location.offset + delta, oldStyles.get(location.offset));
    });

    const caretStyle = styleImmediatelyBefore(oldStyles, beforeLocations, range.prefix)
      ?? styleAtReplacementStart(oldStyles, beforeLocations, range.prefix);
    afterLocations.forEach(location => {
      const isInserted = location.offset < range.afterSuffixStart && location.offset + location.length > range.prefix;
      if(isInserted && caretStyle !== undefined) rebased.set(location.offset, cloneSerializable(caretStyle));
    });

    const styles = {};
    afterLocations.forEach(location => {
      if(!rebased.has(location.offset)) return;
      const column = Object.assign({}, styles[location.columnIndex] || {});
      column[location.rowIndex] = cloneSerializable(rebased.get(location.offset));
      styles[location.columnIndex] = column;
    });
    return styles;
  }

  function syncEditorText(object, {force = false, render = true, replacement = null, afterSelection = null} = {}) {
    if(!object || !editorElement) return false;
    const value = editorElement.value;
    if(!force && object.text === value) return false;
    const oldText = rawText(object.text);
    const styles = rebaseVerticalStyles(object, oldText, value, replacement, afterSelection);
    if(typeof object.set === 'function') object.set('styles', styles);
    else object.styles = styles;
    if(typeof object.set === 'function') object.set('text', value);
    else if(typeof object.setTextContent === 'function') object.setTextContent(value);
    else object.text = value;
    if(object.text !== value) object.text = value;
    applyVerticalDimensions(object);
    object.dirty = true;
    if(typeof object.setCoords === 'function') object.setCoords();
    if(render) requestObjectRender(object);
    return true;
  }

  function focusCanvas(object, canvas = object && object.canvas) {
    const element = canvas && (canvas.upperCanvasEl || canvas.lowerCanvasEl);
    if(element && typeof element.focus === 'function') {
      try { element.focus(); } catch(error) { /* jsdom and detached canvases can reject focus */ }
    }
  }

  function unbindActiveCanvas() {
    const canvas = activeCanvas;
    activeCanvasBindings.forEach(({name, handler, dispose}) => {
      try {
        if(canvas && typeof canvas.off === 'function') canvas.off(name, handler);
        else if(typeof dispose === 'function') dispose();
      } catch(error) {
        // The canvas may already be disposed.
      }
    });
    activeCanvasBindings = [];
    activeCanvas = null;
  }

  function closeActiveEditor() {
    if(activeObject) exitEditing(activeObject);
  }

  function onActiveObjectRemoved(event) {
    if(activeObject && event && event.target === activeObject) closeActiveEditor();
  }

  function onActiveSelectionChanged(event) {
    if(!activeObject) return;
    const selected = event && Array.isArray(event.selected) ? event.selected : [];
    if(event && event.target === activeObject || selected.includes(activeObject)) return;
    closeActiveEditor();
  }

  function bindActiveCanvas(canvas) {
    unbindActiveCanvas();
    activeCanvas = canvas || null;
    if(!canvas || typeof canvas.on !== 'function') return;
    const bindings = [
      ['object:removed', onActiveObjectRemoved],
      ['canvas:cleared', closeActiveEditor],
      ['canvas:disposed', closeActiveEditor],
      ['selection:created', onActiveSelectionChanged],
      ['selection:updated', onActiveSelectionChanged],
      ['selection:cleared', closeActiveEditor],
    ];
    bindings.forEach(([name, handler]) => {
      try {
        const dispose = canvas.on(name, handler);
        activeCanvasBindings.push({name, handler, dispose:typeof dispose === 'function' ? dispose : null});
      } catch(error) {
        // Ignore event APIs that disappear while a canvas is being disposed.
      }
    });
  }

  function exitEditing(object) {
    if(!object) return object;
    object.isEditing = false;
    if(activeObject !== object) return object;
    clearPointerFocusGuard();
    const canvas = activeCanvas || object.canvas;
    syncEditorText(object, {render:false});
    pendingEditorInput = null;
    clearCompositionState();
    const changed = String(object.text == null ? '' : object.text) !== activeOriginalText;
    activeObject = null;
    activeOriginalText = null;
    activeFabric = null;
    unbindActiveCanvas();
    if(editorElement) {
      editorElement.style.display = 'none';
      editorElement.blur?.();
    }
    if(changed) fireEvent(canvas, 'object:modified', {target:object});
    focusCanvas(object, canvas);
    requestObjectRender(object, canvas);
    return object;
  }

  function onEditorInput() {
    if(!activeObject) return;
    const object = activeObject;
    const canvas = activeCanvas || object.canvas;
    const replacement = pendingEditorInput;
    pendingEditorInput = null;
    const before = rawText(object.text);
    const after = rawText(editorElement && editorElement.value);
    const afterSelection = boundedTextRange(after, editorElement && editorElement.selectionStart, editorElement && editorElement.selectionEnd);
    syncEditorText(object, {force:true, render:false, replacement, afterSelection});
    if(replacement && replacement.text === before && isCompositionInputType(replacement.inputType)) {
      const range = replacementTextRange(
        before, after, replacement.selectionStart, replacement.selectionEnd, replacement.inputType,
        afterSelection, replacement.rangeSource,
      );
      compositionReplacement = {text:after, selectionStart:range.prefix, selectionEnd:range.afterSuffixStart};
      if(replacement.inputType === 'insertFromComposition') clearCompositionState();
    } else if(!compositionActive && !isCompositionInputType(replacement && replacement.inputType)) {
      clearCompositionState();
    }
    syncEditorSelection();
    applyEditorStyles(object, activeFabric);
    fireEvent(object, 'changed');
    fireEvent(canvas, 'text:changed', {target:object});
    requestObjectRender(object, canvas);
  }

  function onEditorBeforeInput(event) {
    if(!activeObject || !editorElement) return;
    const text = rawText(editorElement.value);
    const inputType = event && event.inputType || '';
    const targetRange = targetTextRange(event, text);
    const compositionRange = isCompositionInputType(inputType) && compositionReplacement && compositionReplacement.text === text
      ? {start:compositionReplacement.selectionStart, end:compositionReplacement.selectionEnd} : null;
    const selection = targetRange || compositionRange || boundedTextRange(text, editorElement.selectionStart, editorElement.selectionEnd);
    pendingEditorInput = {
      text,
      selectionStart:selection.start,
      selectionEnd:selection.end,
      inputType,
      rangeSource:targetRange ? 'target' : compositionRange ? 'composition' : 'selection',
    };
  }

  function onCompositionStart() {
    if(!activeObject || !editorElement) return;
    const text = rawText(editorElement.value);
    const selection = boundedTextRange(text, editorElement.selectionStart, editorElement.selectionEnd);
    compositionReplacement = {text, selectionStart:selection.start, selectionEnd:selection.end};
    compositionActive = true;
  }

  function onCompositionUpdate() {
    if(activeObject) compositionActive = true;
  }

  function onCompositionEnd() {
    compositionActive = false;
  }

  function syncEditorSelection() {
    if(!activeObject || !editorElement) return;
    const length = editorElement.value.length;
    const start = Math.max(0, Math.min(length, Number(editorElement.selectionStart) || 0));
    const end = Math.max(start, Math.min(length, Number(editorElement.selectionEnd) || start));
    activeObject.selectionStart = start;
    activeObject.selectionEnd = end;
    fireEvent(activeCanvas || activeObject.canvas, 'text:selection:changed', {target:activeObject});
  }

  function onEditorBlur() {
    if(activeObject && pointerFocusObject !== activeObject) exitEditing(activeObject);
  }

  function onEditorKeyDown(event) {
    if(!activeObject || !event) return;
    if(event.key !== 'Escape' && event.code !== 'NumpadEnter') return;
    event.preventDefault?.();
    exitEditing(activeObject);
  }

  function onDocumentPointer(event) {
    if(!activeObject || !editorElement) return;
    const target = event && event.target;
    if(target !== editorElement && !editorElement.contains?.(target)) exitEditing(activeObject);
  }

  function detachEditorListeners() {
    if(editorElement) {
      editorElement.removeEventListener('beforeinput', onEditorBeforeInput);
      editorElement.removeEventListener('input', onEditorInput);
      editorElement.removeEventListener('compositionstart', onCompositionStart);
      editorElement.removeEventListener('compositionupdate', onCompositionUpdate);
      editorElement.removeEventListener('compositionend', onCompositionEnd);
      editorElement.removeEventListener('blur', onEditorBlur);
      editorElement.removeEventListener('keydown', onEditorKeyDown);
      ['select', 'keyup', 'click'].forEach(name => editorElement.removeEventListener(name, syncEditorSelection));
    }
    pendingEditorInput = null;
    clearCompositionState();
    clearPointerFocusGuard();
    if(editorDocument) {
      editorDocument.removeEventListener('pointerdown', onDocumentPointer, true);
      editorDocument.removeEventListener('mousedown', onDocumentPointer, true);
    }
    editorDocument = null;
  }

  function ensureEditor() {
    const documentRef = documentForRuntime();
    if(!documentRef || !documentRef.body) return null;
    if(editorElement && editorElement.ownerDocument !== documentRef) {
      detachEditorListeners();
      editorElement.remove();
      editorElement = null;
    }
    const existing = [...documentRef.querySelectorAll(VERTICAL_EDITOR_SELECTOR)];
    if(!editorElement) {
      editorElement = existing.find(element => element.tagName === 'TEXTAREA') || documentRef.createElement('textarea');
      editorElement.addEventListener('beforeinput', onEditorBeforeInput);
      editorElement.addEventListener('input', onEditorInput);
      editorElement.addEventListener('compositionstart', onCompositionStart);
      editorElement.addEventListener('compositionupdate', onCompositionUpdate);
      editorElement.addEventListener('compositionend', onCompositionEnd);
      editorElement.addEventListener('blur', onEditorBlur);
      editorElement.addEventListener('keydown', onEditorKeyDown);
      ['select', 'keyup', 'click'].forEach(name => editorElement.addEventListener(name, syncEditorSelection));
      editorDocument = documentRef;
      editorDocument.addEventListener('pointerdown', onDocumentPointer, true);
      editorDocument.addEventListener('mousedown', onDocumentPointer, true);
    }
    editorElement.classList.add('hstar-vertical-text-editor');
    editorElement.setAttribute('data-hstar-vertical-editor', '');
    editorElement.setAttribute('aria-label', '竖排文字编辑');
    editorElement.setAttribute('spellcheck', 'false');
    editorElement.autocomplete = 'off';
    editorElement.spellcheck = false;
    existing.filter(element => element !== editorElement).forEach(element => element.remove());
    if(!editorElement.isConnected) documentRef.body.append(editorElement);
    return editorElement;
  }

  function enterEditing(object, event, fabric) {
    if(activeObject === object) {
      applyEditorStyles(object, activeFabric || fabric);
      armPointerFocusGuard(object, event);
      try { editorElement?.focus({preventScroll:true}); } catch(error) { editorElement?.focus(); }
      return object;
    }
    if(activeObject && activeObject !== object) exitEditing(activeObject);
    const editor = ensureEditor();
    activeObject = object;
    pendingEditorInput = null;
    clearCompositionState();
    activeFabric = fabric || null;
    activeOriginalText = String(object.text == null ? '' : object.text);
    bindActiveCanvas(object.canvas);
    object.isEditing = true;
    if(!editor) return object;
    editor.value = activeOriginalText;
    applyEditorStyles(object, activeFabric);
    armPointerFocusGuard(object, event);
    try { editor.focus({preventScroll:true}); } catch(error) { editor.focus?.(); }
    if(typeof editor.setSelectionRange === 'function') {
      const storedStart = Number(object.selectionStart);
      const storedEnd = Number(object.selectionEnd);
      const hasStoredRange = Number.isFinite(storedStart) && Number.isFinite(storedEnd);
      const start = hasStoredRange ? Math.max(0, Math.min(editor.value.length, storedStart)) : editor.value.length;
      const end = hasStoredRange ? Math.max(start, Math.min(editor.value.length, storedEnd)) : editor.value.length;
      editor.setSelectionRange(start, end);
      syncEditorSelection();
    }
    return object;
  }

  function normalizeWritingMode(value) {
    return value === VERTICAL ? VERTICAL : HORIZONTAL;
  }

  function normalizeStyles(fabric, styles, text) {
    if(Array.isArray(styles) && fabric && fabric.util && typeof fabric.util.stylesFromArray === 'function') {
      return fabric.util.stylesFromArray(styles, text);
    }
    return styles;
  }

  function positiveNumber(value, fallback) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function layoutVerticalText(raw, style = {}) {
    const text = String(raw);
    const fontSize = positiveNumber(style.fontSize, 40);
    const lineHeight = positiveNumber(style.lineHeight, 1.16);
    const columnGap = Math.max(0, fontSize * (lineHeight - 1));
    const columns = text.split(/\r\n|\r|\n/).map(column => Array.from(column));
    const columnLayouts = columns.map((column, columnIndex) => {
      let height = 0;
      let width = 0;
      const glyphs = column.map((character, rowIndex) => {
        const glyphStyle = styleForCell(style, columnIndex, rowIndex);
        const size = positiveNumber(glyphStyle.fontSize, 40);
        const glyphLineHeight = positiveNumber(glyphStyle.lineHeight, 1.16);
        const charSpacing = Number.isFinite(Number(glyphStyle.charSpacing)) ? Number(glyphStyle.charSpacing) : 0;
        const advance = Math.max(1, (size * glyphLineHeight) + (size * charSpacing / 1000));
        const glyph = {character, columnIndex, rowIndex, width:size, height:size, advance, y:height};
        height += advance;
        width = Math.max(width, size);
        return glyph;
      });
      return {glyphs, width:Math.max(width, fontSize), height};
    });
    const width = Math.max(fontSize, columnLayouts.reduce((sum, column) => sum + column.width, 0)
      + Math.max(0, columnLayouts.length - 1) * columnGap);
    const height = Math.max(fontSize, ...columnLayouts.map(column => column.height));
    const glyphs = [];
    let right = width;
    columnLayouts.forEach(column => {
      const x = right - (column.width / 2);
      column.glyphs.forEach(glyph => {
        glyph.x = x;
        glyphs.push(glyph);
      });
      right -= column.width + columnGap;
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
    return styleForCell(object, glyph.columnIndex, glyph.rowIndex);
  }

  function styleForCell(object, columnIndex, rowIndex) {
    const column = object.styles && object.styles[columnIndex];
    return Object.assign({}, object, column && column[rowIndex]);
  }

  function verticalCellsForRange(object, start, end) {
    const text = rawText(object && object.text);
    const from = Math.max(0, Math.min(text.length, Number(start) || 0));
    const to = Math.max(from, Math.min(text.length, Number(end) || from));
    return verticalGlyphLocations(text).filter(location => location.offset < to && location.offset + location.length > from);
  }

  function selectionStylesForRange(object, start, end, complete) {
    return verticalCellsForRange(object, start, end).map(cell => {
      const style = object.styles && object.styles[cell.columnIndex] && object.styles[cell.columnIndex][cell.rowIndex];
      return complete ? Object.assign({}, object, style) : Object.assign({}, style);
    });
  }

  function applySelectionStyles(object, style, start, end) {
    const cells = verticalCellsForRange(object, start, end);
    if(!cells.length) return object;
    const styles = cloneSerializable(object.styles) || {};
    cells.forEach(({columnIndex, rowIndex}) => {
      const column = Object.assign({}, styles[columnIndex] || {});
      column[rowIndex] = Object.assign({}, column[rowIndex] || {}, cloneSerializable(style) || {});
      styles[columnIndex] = column;
    });
    if(typeof object.set === 'function') object.set('styles', styles);
    else {
      object.styles = styles;
      applyVerticalDimensions(object);
      object.dirty = true;
    }
    if(typeof object.setCoords === 'function') object.setCoords();
    requestObjectRender(object);
    return object;
  }

  function fontString(style) {
    return `${style.fontStyle || 'normal'} ${style.fontWeight || 'normal'} ${positiveNumber(style.fontSize, 40)}px ${style.fontFamily || 'sans-serif'}`;
  }

  function paintOffset(value) {
    if(Array.isArray(value)) return {offsetX:Number(value[0]) || 0, offsetY:Number(value[1]) || 0};
    if(value && typeof value === 'object') {
      return {offsetX:Number(value.offsetX) || 0, offsetY:Number(value.offsetY) || 0};
    }
    return {offsetX:0, offsetY:0};
  }

  function setStrokeGeometry(context, style) {
    if(style.strokeWidth != null) context.lineWidth = style.strokeWidth;
    if(typeof context.setLineDash === 'function') context.setLineDash(style.strokeDashArray || []);
    if(style.strokeDashOffset != null) context.lineDashOffset = style.strokeDashOffset;
    if(style.strokeLineCap) context.lineCap = style.strokeLineCap;
    if(style.strokeLineJoin) context.lineJoin = style.strokeLineJoin;
    if(style.strokeMiterLimit != null) context.miterLimit = style.strokeMiterLimit;
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
    function paintWithFabricTextFiller(context, property, filler) {
      if(fabric.Text && fabric.Text.prototype && typeof fabric.Text.prototype.handleFiller === 'function') {
        return paintOffset(fabric.Text.prototype.handleFiller.call(this, context, property, filler));
      }
      if(typeof filler === 'string') context[property] = filler;
      return {offsetX:0, offsetY:0};
    }

    return {
      type:VERTICAL_TYPE,
      hstarWritingMode:VERTICAL,

      initialize(text, options = {}) {
        const config = Object.assign({}, options, {styles:normalizeStyles(fabric, options.styles, text)});
        if(typeof this.callSuper === 'function') this.callSuper('initialize', config);
        else if(fabric.Object && fabric.Object.prototype && typeof fabric.Object.prototype.initialize === 'function') {
          fabric.Object.prototype.initialize.call(this, config);
        } else {
          Object.assign(this, config);
        }
        this.type = VERTICAL_TYPE;
        this.text = String(text);
        this.styles = normalizeStyles(fabric, this.styles, this.text);
        this.hstarWritingMode = VERTICAL;
        applyVerticalDimensions(this);
        return this;
      },

      initDimensions() {
        return applyVerticalDimensions(this);
      },

      enterEditing(event) {
        return enterEditing(this, event, fabric);
      },

      exitEditing() {
        return exitEditing(this);
      },

      getSelectionStyles(start, end, complete) {
        return selectionStylesForRange(this, start, end, complete);
      },

      setSelectionStyles(style, start, end) {
        return applySelectionStyles(this, style, start, end);
      },

      _set(key, value) {
        if(key === 'styles') {
          const normalized = normalizeStyles(fabric, value, this.text);
          value = cloneSerializable(normalized) || {};
        }
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
        } else if(!this._hstarUpdatingLayout && PAINT_PROPERTIES.has(key)) {
          this.dirty = true;
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
        layout.glyphs.forEach(glyph => {
          const style = glyphStyle(this, glyph);
          const size = positiveNumber(style.fontSize, 40);
          const x = offsetX + glyph.x;
          const y = offsetY + glyph.y;
          if(context.save) context.save();
          context.font = fontString(style);
          if(style.textBackgroundColor && context.fillRect) {
            if(context.save) context.save();
            context.fillStyle = style.textBackgroundColor;
            context.fillRect(x - (size / 2), y, size, size);
            if(context.restore) context.restore();
          }
          const fill = () => {
            if(style.fill == null || !context.fillText) return;
            if(context.save) context.save();
            const offset = paintWithFabricTextFiller.call(this, context, 'fillStyle', style.fill);
            context.fillText(glyph.character, x - offset.offsetX, y - offset.offsetY);
            if(context.restore) context.restore();
          };
          const stroke = () => {
            if(!style.stroke || Number(style.strokeWidth) <= 0 || !context.strokeText) return;
            if(context.save) context.save();
            setStrokeGeometry(context, style);
            const offset = paintWithFabricTextFiller.call(this, context, 'strokeStyle', style.stroke);
            context.strokeText(glyph.character, x - offset.offsetX, y - offset.offsetY);
            if(context.restore) context.restore();
          };
          if(style.paintFirst === 'stroke') {
            stroke();
            fill();
          } else {
            fill();
            stroke();
          }
          if(context.fillRect && (style.underline || style.overline || style.linethrough)) {
            if(context.save) context.save();
            const lineWidth = Math.max(1, Number(style.strokeWidth) || 1);
            if(typeof style.fill === 'string') context.fillStyle = style.fill;
            if(style.underline) context.fillRect(x - (size / 2), y + size - lineWidth, size, lineWidth);
            if(style.overline) context.fillRect(x - (size / 2), y, size, lineWidth);
            if(style.linethrough) context.fillRect(x - (size / 2), y + (size / 2), size, lineWidth);
            if(context.restore) context.restore();
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
      const normalizedObject = Object.assign({}, object, {
        styles:normalizeStyles(fabric, object && object.styles, object && object.text),
      });
      if(fabric.Object && typeof fabric.Object._fromObject === 'function') {
        return fabric.Object._fromObject('HstarVerticalText', normalizedObject, callback, 'text');
      }
      const text = normalizedObject.text;
      const options = Object.assign(
        {},
        collectSerializableOptions(normalizedObject),
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

  function setGlyphStyle(object, columnIndex, rowIndex, stylePatch) {
    if(!object) throw new Error('Text object is required');
    const styles = cloneSerializable(object.styles) || {};
    const column = Object.assign({}, styles[columnIndex] || {});
    column[rowIndex] = Object.assign({}, column[rowIndex] || {}, cloneSerializable(stylePatch) || {});
    styles[columnIndex] = column;
    if(typeof object.set === 'function') object.set('styles', styles);
    else {
      object.styles = styles;
      applyVerticalDimensions(object);
      object.dirty = true;
      if(typeof object.setCoords === 'function') object.setCoords();
    }
    if(object.canvas && typeof object.canvas.requestRenderAll === 'function') object.canvas.requestRenderAll();
    return object;
  }

  function writingModeFor(object) {
    return normalizeWritingMode(object && object.hstarWritingMode);
  }

  function convertTextObject(fabric, source, mode) {
    const text = source && source.text !== undefined ? source.text : '';
    const options = copyConvertibleOptions(source);
    options.styles = normalizeStyles(fabric, options.styles, text);
    options.hstarWritingMode = normalizeWritingMode(mode);
    const converted = createTextObject(fabric, text, options);
    ['selectionStart', 'selectionEnd'].forEach(property => {
      if(Number.isFinite(Number(source && source[property]))) converted[property] = Number(source[property]);
    });
    return converted;
  }

  function activeEditorObject() {
    return activeObject;
  }

  function refreshActiveEditor() {
    if(!activeObject || !editorElement) return false;
    applyEditorStyles(activeObject, activeFabric);
    return true;
  }

  function destroy() {
    if(activeObject) exitEditing(activeObject);
    else unbindActiveCanvas();
    detachEditorListeners();
    if(editorElement) editorElement.remove();
    editorElement = null;
    activeObject = null;
    activeFabric = null;
    activeOriginalText = null;
  }

  global.HstarOpenShopWritingMode = {
    HORIZONTAL,
    VERTICAL,
    normalizeWritingMode,
    layoutVerticalText,
    registerFabricClass,
    writingModeFor,
    createTextObject,
    convertTextObject,
    setGlyphStyle,
    activeEditorObject,
    refreshActiveEditor,
    destroy,
  };
})(typeof window !== 'undefined' ? window : globalThis);
