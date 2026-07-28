(function bootstrapOpenShopOcrLayout(root){
  'use strict';

  const MIN_FONT_SIZE = 1;
  const MAX_FONT_SIZE = 4096;
  const MAX_MEASURE_SIDE = 8192;
  const FIT_ITERATIONS = 8;
  const FIT_EPSILON = 0.001;

  function finite(value, fallback = 0){
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function clamp(value, minimum, maximum){
    return Math.max(minimum, Math.min(maximum, value));
  }

  function setValues(object, values){
    if(typeof object?.set === 'function') object.set(values);
    else Object.assign(object, values);
  }

  function updateDimensions(object){
    object?.initDimensions?.();
    object?.setCoords?.();
  }

  function normalizeWritingMode(value){
    return String(value || '').toLowerCase().startsWith('vertical')
      ? 'vertical'
      : 'horizontal';
  }

  function quadGeometry(quad, documentWidth, documentHeight, fallbackRotation = 0){
    const width = finite(documentWidth);
    const height = finite(documentHeight);
    if(width <= 0 || height <= 0) throw new Error('OCR document dimensions are invalid');
    const points = (Array.isArray(quad) ? quad : []).map(point => ({
      x:finite(point?.x, Number.NaN) * width,
      y:finite(point?.y, Number.NaN) * height,
    }));
    if(points.length !== 4 || points.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))){
      throw new Error('OCR quad is invalid');
    }
    const topEdge = {x:points[1].x - points[0].x, y:points[1].y - points[0].y};
    const sideEdge = {x:points[3].x - points[0].x, y:points[3].y - points[0].y};
    const localWidth = Math.hypot(topEdge.x, topEdge.y);
    const localHeight = Math.hypot(sideEdge.x, sideEdge.y);
    if(localWidth <= 0 || localHeight <= 0) throw new Error('OCR quad has no usable area');
    const quadAngle = Math.atan2(topEdge.y, topEdge.x) * 180 / Math.PI;
    const requested = finite(fallbackRotation);
    return {
      left:points[0].x,
      top:points[0].y,
      width:localWidth,
      height:localHeight,
      angle:Math.abs(quadAngle) > 0.01 ? quadAngle : requested,
    };
  }

  function scanAlphaBounds(context, width, height, centerX, centerY){
    const pixels = context.getImageData(0, 0, width, height).data;
    let left = width;
    let top = height;
    let right = -1;
    let bottom = -1;
    for(let y = 0; y < height; y += 1){
      for(let x = 0; x < width; x += 1){
        if(pixels[(y * width + x) * 4 + 3] <= 2) continue;
        left = Math.min(left, x);
        top = Math.min(top, y);
        right = Math.max(right, x);
        bottom = Math.max(bottom, y);
      }
    }
    if(right < left || bottom < top) throw new Error('OCR text has no visible glyph pixels');
    return {
      left:left - centerX,
      top:top - centerY,
      width:right - left + 1,
      height:bottom - top + 1,
    };
  }

  function measureVisibleBounds(object, options = {}){
    const documentRef = options.documentRef || root.document;
    if(!documentRef?.createElement || typeof object?._render !== 'function'){
      throw new Error('OCR visible glyph measurement is unavailable');
    }
    updateDimensions(object);
    const objectWidth = Math.max(1, finite(object.width, 1));
    const objectHeight = Math.max(1, finite(object.height, 1));
    const fontSize = Math.max(1, finite(object.fontSize, 40));
    const stroke = Math.max(0, finite(object.strokeWidth));
    const shadow = object.shadow && typeof object.shadow === 'object' ? object.shadow : {};
    const shadowExtent = Math.max(
      Math.abs(finite(shadow.offsetX)) + finite(shadow.blur),
      Math.abs(finite(shadow.offsetY)) + finite(shadow.blur),
    );
    const padding = Math.ceil(Math.max(12, fontSize * 0.75, stroke * 2 + shadowExtent));
    const width = Math.ceil(objectWidth + padding * 2);
    const height = Math.ceil(objectHeight + padding * 2);
    if(width > MAX_MEASURE_SIDE || height > MAX_MEASURE_SIDE || width * height > MAX_MEASURE_SIDE ** 2){
      throw new Error('OCR visible glyph measurement is too large');
    }
    const canvas = documentRef.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', {willReadFrequently:true});
    if(!context?.getImageData) throw new Error('OCR visible glyph canvas is unavailable');
    const centerX = width / 2;
    const centerY = height / 2;
    context.save?.();
    context.translate(centerX, centerY);
    object._render(context);
    context.restore?.();
    return scanAlphaBounds(context, width, height, centerX, centerY);
  }

  function normalizedBounds(value){
    const bounds = {
      left:finite(value?.left, Number.NaN),
      top:finite(value?.top, Number.NaN),
      width:finite(value?.width, Number.NaN),
      height:finite(value?.height, Number.NaN),
    };
    if(!Object.values(bounds).every(Number.isFinite) || bounds.width <= 0 || bounds.height <= 0){
      throw new Error('OCR visible glyph bounds are invalid');
    }
    return bounds;
  }

  function normalizedGeometry(value, fallbackAngle = 0){
    const geometry = {
      left:finite(value?.left, Number.NaN),
      top:finite(value?.top, Number.NaN),
      width:finite(value?.width, Number.NaN),
      height:finite(value?.height, Number.NaN),
      angle:finite(value?.angle, fallbackAngle),
    };
    if(!Object.values(geometry).every(Number.isFinite) || geometry.width <= 0 || geometry.height <= 0){
      throw new Error('OCR text target geometry is invalid');
    }
    return geometry;
  }

  function updateStyledNumber(object, property, transform){
    const styles = object?.styles;
    if(!styles || typeof styles !== 'object') return;
    Object.values(styles).forEach(line => {
      if(!line || typeof line !== 'object') return;
      Object.values(line).forEach(style => {
        if(!style || typeof style !== 'object' || !Number.isFinite(Number(style[property]))) return;
        style[property] = transform(Number(style[property]));
      });
    });
  }

  function fitLineObject(object, geometry, options = {}){
    if(!object || !geometry) throw new Error('OCR text fitting input is incomplete');
    const target = normalizedGeometry(geometry);
    const writingMode = normalizeWritingMode(options.writingMode || object.hstarWritingMode);
    const measure = typeof options.measure === 'function'
      ? options.measure
      : candidate => measureVisibleBounds(candidate, options);
    const measureObject = () => normalizedBounds(measure(object));

    const anchorFontSize = clamp(finite(object.fontSize, 40), MIN_FONT_SIZE, MAX_FONT_SIZE);
    const applyFontSize = value => {
      const current = Math.max(MIN_FONT_SIZE, finite(object.fontSize, anchorFontSize));
      const fontSize = clamp(value, MIN_FONT_SIZE, MAX_FONT_SIZE);
      if(Math.abs(fontSize - current) <= FIT_EPSILON) return false;
      updateStyledNumber(object, 'fontSize', styledValue => clamp(
        styledValue * fontSize / current,
        MIN_FONT_SIZE,
        MAX_FONT_SIZE,
      ));
      setValues(object, {fontSize, scaleX:1, scaleY:1});
      updateDimensions(object);
      return true;
    };
    setValues(object, {
      fontSize:anchorFontSize,
      charSpacing:0,
      scaleX:1,
      scaleY:1,
      angle:target.angle,
    });
    updateStyledNumber(object, 'charSpacing', () => 0);
    updateDimensions(object);

    let visibleBox = measureObject();
    const targetCross = writingMode === 'vertical' ? target.width : target.height;
    let bestCross = {
      error:Math.abs((writingMode === 'vertical' ? visibleBox.width : visibleBox.height) - targetCross),
      fontSize:Math.max(MIN_FONT_SIZE, finite(object.fontSize, 40)),
      visibleBox,
    };
    for(let iteration = 0; iteration < FIT_ITERATIONS; iteration += 1){
      const visibleCross = writingMode === 'vertical' ? visibleBox.width : visibleBox.height;
      const ratio = targetCross / visibleCross;
      if(Math.abs(ratio - 1) <= FIT_EPSILON) break;
      const current = Math.max(MIN_FONT_SIZE, finite(object.fontSize, 40));
      const fontSize = clamp(current * ratio, MIN_FONT_SIZE, MAX_FONT_SIZE);
      if(!applyFontSize(fontSize)) break;
      visibleBox = measureObject();
      const error = Math.abs(
        (writingMode === 'vertical' ? visibleBox.width : visibleBox.height) - targetCross
      );
      if(error < bestCross.error){
        bestCross = {error, fontSize, visibleBox};
      }
    }
    const currentFontSize = Math.max(MIN_FONT_SIZE, finite(object.fontSize, 40));
    if(Math.abs(bestCross.fontSize - currentFontSize) > FIT_EPSILON){
      applyFontSize(bestCross.fontSize);
      visibleBox = measureObject();
    }

    visibleBox = measureObject();
    for(let iteration = 0; iteration < FIT_ITERATIONS; iteration += 1){
      const widthRatio = target.width / visibleBox.width;
      const heightRatio = target.height / visibleBox.height;
      const fitRatio = Math.min(widthRatio, heightRatio);
      if(fitRatio >= 1 - FIT_EPSILON) break;
      const current = Math.max(MIN_FONT_SIZE, finite(object.fontSize, 40));
      if(!applyFontSize(current * fitRatio)) break;
      visibleBox = measureObject();
    }

    setValues(object, {scaleX:1, scaleY:1});
    const objectWidth = Math.max(1, finite(object.width, 1));
    const objectHeight = Math.max(1, finite(object.height, 1));
    const localVisibleOffset = {
      x:visibleBox.left + objectWidth / 2,
      y:visibleBox.top + objectHeight / 2,
    };
    const radians = target.angle * Math.PI / 180;
    const rotatedOffset = {
      x:Math.cos(radians) * localVisibleOffset.x - Math.sin(radians) * localVisibleOffset.y,
      y:Math.sin(radians) * localVisibleOffset.x + Math.cos(radians) * localVisibleOffset.y,
    };
    const left = target.left - rotatedOffset.x;
    const top = target.top - rotatedOffset.y;
    setValues(object, {left, top, angle:target.angle, scaleX:1, scaleY:1});
    updateDimensions(object);
    return {
      target,
      visibleBox,
      localVisibleOffset,
      left,
      top,
      fontSize:object.fontSize,
      charSpacing:object.charSpacing,
      scaleX:1,
      scaleY:1,
    };
  }

  function styleSignature(line){
    if(line?.styleSignature !== undefined) return String(line.styleSignature);
    const runs = Array.isArray(line?.resolvedRuns)
      ? line.resolvedRuns
      : (Array.isArray(line?.runs) ? line.runs : []);
    return JSON.stringify(runs.map(run => ({
      script:run?.script,
      family:run?.family,
      faceFamily:run?.faceFamily,
      weight:run?.weight,
      italic:run?.italic,
      size:run?.size,
      color:run?.color,
      letterSpacing:run?.letterSpacing,
      lineHeight:run?.lineHeight,
      strokeColor:run?.strokeColor,
      strokeWidth:run?.strokeWidth,
      shadow:run?.shadow,
    })));
  }

  function paragraphPlan(lines){
    const ordered = (Array.isArray(lines) ? lines : [])
      .filter(Boolean)
      .map(line => ({...line, geometry:normalizedGeometry(line.geometry, line.rotation)}))
      .sort((left, right) => finite(left.lineIndex) - finite(right.lineIndex));
    if(ordered.length < 2) return {merge:false, reason:'single-line', lines:ordered};
    const first = ordered[0];
    if(!first.paragraphId || ordered.some(line => line.paragraphId !== first.paragraphId)){
      return {merge:false, reason:'different-paragraph', lines:ordered};
    }
    const writingMode = normalizeWritingMode(first.writingMode);
    if(ordered.some(line => normalizeWritingMode(line.writingMode) !== writingMode)){
      return {merge:false, reason:'incompatible-writing-mode', lines:ordered};
    }
    const rotation = finite(first.rotation, first.geometry.angle);
    if(ordered.some(line => Math.abs(finite(line.rotation, line.geometry.angle) - rotation) > 0.5)){
      return {merge:false, reason:'incompatible-rotation', lines:ordered};
    }
    const signature = styleSignature(first);
    if(ordered.some(line => styleSignature(line) !== signature)){
      return {merge:false, reason:'incompatible-style', lines:ordered};
    }
    const crossSize = writingMode === 'vertical' ? first.geometry.width : first.geometry.height;
    if(ordered.some(line => Math.abs(
      (writingMode === 'vertical' ? line.geometry.width : line.geometry.height) - crossSize
    ) > 1)){
      return {merge:false, reason:'incompatible-cross-size', lines:ordered};
    }
    const positions = ordered.map(line => (
      writingMode === 'vertical' ? line.geometry.left : line.geometry.top
    ));
    const intervals = positions.slice(1).map((position, index) => position - positions[index]);
    const interval = intervals[0];
    if(intervals.some(value => Math.abs(value - interval) > 1)){
      return {merge:false, reason:'irregular-line-spacing', lines:ordered};
    }
    return {
      merge:true,
      paragraphId:first.paragraphId,
      writingMode,
      rotation,
      interval,
      crossSize,
      lines:ordered,
    };
  }

  root.HstarOpenShopOcrLayout = Object.freeze({
    quadGeometry,
    measureVisibleBounds,
    fitLineObject,
    paragraphPlan,
  });
})(typeof window !== 'undefined' ? window : globalThis);
