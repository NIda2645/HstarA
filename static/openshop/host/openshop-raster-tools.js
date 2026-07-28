(function bootstrapOpenShopRasterTools(root){
  const TOOLS = new Set(['brush', 'eraser', 'clone']);
  const HISTORY_LABELS = Object.freeze({
    brush:'Brush',
    eraser:'Eraser',
    clone:'Clone Stamp',
  });

  function finitePoint(value){
    const x = Number(value?.x);
    const y = Number(value?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? {x, y} : null;
  }

  function positive(value, fallback = 1){
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function clamp(value, minimum, maximum){
    return Math.max(minimum, Math.min(maximum, Number(value) || 0));
  }

  function rgba(color, alpha){
    let value = String(color || '#000000').trim();
    if(/^#[0-9a-f]{3}$/i.test(value)){
      value = `#${value[1]}${value[1]}${value[2]}${value[2]}${value[3]}${value[3]}`;
    }
    if(/^#[0-9a-f]{6}$/i.test(value)){
      return `rgba(${Number.parseInt(value.slice(1, 3), 16)},${Number.parseInt(value.slice(3, 5), 16)},${Number.parseInt(value.slice(5, 7), 16)},${alpha})`;
    }
    return value;
  }

  function imageDimensions(target, element){
    return {
      width:Math.max(1, Math.round(positive(element?.naturalWidth || element?.videoWidth || element?.width, target?.width))),
      height:Math.max(1, Math.round(positive(element?.naturalHeight || element?.videoHeight || element?.height, target?.height))),
    };
  }

  function copyCanvas(documentRef, source, dimensions){
    const canvas = documentRef.createElement('canvas');
    canvas.width = dimensions.width;
    canvas.height = dimensions.height;
    const context = canvas.getContext('2d', {willReadFrequently:false});
    if(!context) throw new Error('OpenShop raster canvas is unavailable');
    context.drawImage(source, 0, 0, dimensions.width, dimensions.height);
    return {canvas, context};
  }

  function createController(options = {}){
    const editor = options.editor;
    const fabricRef = options.fabricRef || root.fabric;
    const documentRef = options.documentRef || root.document;
    const requestFrame = options.requestFrame || root.requestAnimationFrame?.bind(root) || (callback => {
      callback();
      return 0;
    });
    const cancelFrame = options.cancelFrame || root.cancelAnimationFrame?.bind(root) || (() => {});
    if(!editor?.canvas || !fabricRef?.util || !documentRef?.createElement){
      throw new Error('OpenShop raster tool dependencies are unavailable');
    }

    const state = {
      session:null,
      cloneSource:null,
      renderPending:false,
      frameId:0,
    };

    function notify(message){
      const text = typeof editor._t === 'function' ? editor._t(message) : message;
      editor.toast?.(text, 'info');
    }

    function activeLayer(){
      const layer = editor.layers?.[editor.activeLayerIdx];
      if(!layer || layer.visible === false || layer.locked) return null;
      return layer;
    }

    function resolveTarget(){
      const layer = activeLayer();
      if(!layer) return null;
      const selected = editor.canvas.getActiveObject?.();
      if(selected?.type === 'image' && layer.objects?.includes(selected)) return selected;
      return [...(layer.objects || [])].reverse().find(object => object?.type === 'image') || null;
    }

    function setTargetElement(target, element){
      if(typeof target.setElement === 'function') target.setElement(element);
      else {
        target._element = element;
        target._originalElement = element;
      }
      target.dirty = true;
    }

    function pixelPoint(session, documentPoint){
      const point = finitePoint(documentPoint);
      if(!point) return null;
      const matrix = session.target.calcTransformMatrix?.();
      if(!Array.isArray(matrix)) return null;
      const inverse = fabricRef.util.invertTransform(matrix);
      const local = fabricRef.util.transformPoint(point, inverse);
      const objectWidth = positive(session.target.width, session.width);
      const objectHeight = positive(session.target.height, session.height);
      const x = (Number(local?.x) + objectWidth / 2) * session.width / objectWidth;
      const y = (Number(local?.y) + objectHeight / 2) * session.height / objectHeight;
      return Number.isFinite(x) && Number.isFinite(y) ? {x, y} : null;
    }

    function pixelBrushSize(session, documentSize){
      const scaleX = Math.abs(positive(session.target.scaleX, 1));
      const scaleY = Math.abs(positive(session.target.scaleY, 1));
      const objectWidth = positive(session.target.width, session.width);
      const objectHeight = positive(session.target.height, session.height);
      const sourcePerDocumentX = session.width / objectWidth / scaleX;
      const sourcePerDocumentY = session.height / objectHeight / scaleY;
      return Math.max(1, positive(documentSize) * Math.sqrt(sourcePerDocumentX * sourcePerDocumentY));
    }

    function scheduleRender(target){
      if(state.renderPending) return;
      state.renderPending = true;
      const frameId = requestFrame(() => {
        state.renderPending = false;
        state.frameId = 0;
        target.dirty = true;
        editor.canvas.requestRenderAll?.();
      });
      if(state.renderPending) state.frameId = frameId;
    }

    function brushProfile(session){
      const preset = String(editor.state?.brushPreset || 'round');
      const hardness = preset === 'soft'
        ? clamp(editor.state?.brushHardness ?? 0, 0, 100) / 100
        : clamp(editor.state?.brushHardness ?? 100, 0, 100) / 100;
      return {
        preset,
        diameter:pixelBrushSize(session, editor.state?.brushSize || 1),
        hardness,
        opacity:clamp(editor.state?.brushOpacity ?? 100, 1, 100) / 100,
      };
    }

    function drawPaintDab(session, center, profile){
      const context = session.context;
      const radius = Math.max(0.5, profile.diameter / 2);
      const erasing = session.tool === 'eraser';
      const color = erasing ? '#000000' : String(editor.state?.fgColor || '#000000');
      context.save();
      try {
        context.globalCompositeOperation = erasing ? 'destination-out' : 'source-over';
        context.globalAlpha = profile.opacity;
        if(profile.preset === 'pixel'){
          context.fillStyle = color;
          context.fillRect(
            Math.round(center.x - radius),
            Math.round(center.y - radius),
            Math.max(1, Math.round(profile.diameter)),
            Math.max(1, Math.round(profile.diameter))
          );
        } else {
          if(profile.hardness < 0.999 && typeof context.createRadialGradient === 'function'){
            const gradient = context.createRadialGradient(
              center.x, center.y, 0,
              center.x, center.y, radius
            );
            gradient.addColorStop(0, rgba(color, 1));
            if(profile.hardness > 0) gradient.addColorStop(profile.hardness, rgba(color, 1));
            gradient.addColorStop(1, rgba(color, 0));
            context.fillStyle = gradient;
          } else {
            context.fillStyle = color;
          }
          context.beginPath();
          context.arc(center.x, center.y, radius, 0, Math.PI * 2);
          context.fill();
        }
      } finally {
        context.restore();
      }
      session.changed = true;
    }

    function drawPaintSegment(session, from, to){
      const profile = brushProfile(session);
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      if(distance < 0.001){
        drawPaintDab(session, to, profile);
        return;
      }
      const spacing = Math.max(1, profile.diameter * (profile.preset === 'soft' ? 0.12 : 0.2));
      const count = Math.max(1, Math.ceil(distance / spacing));
      for(let index = 1; index <= count; index += 1){
        const ratio = index / count;
        drawPaintDab(session, {
          x:from.x + (to.x - from.x) * ratio,
          y:from.y + (to.y - from.y) * ratio,
        }, profile);
      }
    }

    function cloneStamp(session, destinationDocumentPoint){
      const destination = pixelPoint(session, destinationDocumentPoint);
      const documentPoint = finitePoint(destinationDocumentPoint);
      if(!destination || !documentPoint || !session.cloneOffset || !session.sourceCanvas) return;
      const sourceDocumentPoint = {
        x:documentPoint.x - session.cloneOffset.x,
        y:documentPoint.y - session.cloneOffset.y,
      };
      const source = pixelPoint(session, sourceDocumentPoint);
      if(!source) return;
      const radius = pixelBrushSize(session, editor.state?.cloneSize || editor.state?.brushSize || 1) / 2;
      const size = radius * 2;
      const context = session.context;
      context.save();
      try {
        context.globalCompositeOperation = 'source-over';
        context.globalAlpha = 1;
        context.beginPath();
        context.arc(destination.x, destination.y, radius, 0, Math.PI * 2);
        context.clip();
        context.drawImage(
          session.sourceCanvas,
          source.x - radius,
          source.y - radius,
          size,
          size,
          destination.x - radius,
          destination.y - radius,
          size,
          size
        );
      } finally {
        context.restore();
      }
      session.changed = true;
    }

    function drawCloneSegment(session, fromDocumentPoint, toDocumentPoint){
      const from = finitePoint(fromDocumentPoint);
      const to = finitePoint(toDocumentPoint);
      if(!from || !to) return;
      const distance = Math.hypot(to.x - from.x, to.y - from.y);
      const step = Math.max(1, positive(editor.state?.cloneSize || 1) / 4);
      const count = Math.max(1, Math.ceil(distance / step));
      for(let index = 1; index <= count; index += 1){
        const ratio = index / count;
        cloneStamp(session, {
          x:from.x + (to.x - from.x) * ratio,
          y:from.y + (to.y - from.y) * ratio,
        });
      }
    }

    function begin(tool, documentPoint){
      const normalizedTool = String(tool || '');
      const point = finitePoint(documentPoint);
      if(!TOOLS.has(normalizedTool) || !point) return {ok:false, reason:'invalid-input'};
      if(state.session) end();
      if(normalizedTool === 'clone' && !state.cloneSource){
        notify('Alt+click to set source first');
        return {ok:false, reason:'clone-source-required'};
      }
      const layer = activeLayer();
      const target = resolveTarget();
      if(!layer || !target){
        notify('Select an image on the active layer first');
        return {ok:false, reason:'active-layer-image-required'};
      }
      const originalElement = target.getElement?.() || target._element;
      if(!originalElement){
        notify('The active layer image is unavailable');
        return {ok:false, reason:'image-element-required'};
      }
      try {
        const dimensions = imageDimensions(target, originalElement);
        const backing = copyCanvas(documentRef, originalElement, dimensions);
        const source = normalizedTool === 'clone'
          ? copyCanvas(documentRef, backing.canvas, dimensions).canvas
          : null;
        const session = {
          tool:normalizedTool,
          layer,
          target,
          originalElement,
          canvas:backing.canvas,
          context:backing.context,
          sourceCanvas:source,
          width:dimensions.width,
          height:dimensions.height,
          previousDocumentPoint:point,
          changed:false,
          cloneOffset:normalizedTool === 'clone'
            ? {x:point.x - state.cloneSource.x, y:point.y - state.cloneSource.y}
            : null,
        };
        setTargetElement(target, backing.canvas);
        state.session = session;
        const pixel = pixelPoint(session, point);
        if(normalizedTool === 'clone') cloneStamp(session, point);
        else if(pixel) drawPaintSegment(session, pixel, pixel);
        scheduleRender(target);
        return {ok:true, target, layer};
      } catch(error){
        setTargetElement(target, originalElement);
        editor.toast?.(error instanceof Error ? error.message : String(error), 'error');
        return {ok:false, reason:'canvas-copy-failed', error};
      }
    }

    function move(documentPoint){
      const session = state.session;
      const point = finitePoint(documentPoint);
      if(!session || !point) return false;
      if(session.tool === 'clone'){
        drawCloneSegment(session, session.previousDocumentPoint, point);
      } else {
        const from = pixelPoint(session, session.previousDocumentPoint);
        const to = pixelPoint(session, point);
        if(from && to) drawPaintSegment(session, from, to);
      }
      session.previousDocumentPoint = point;
      scheduleRender(session.target);
      return true;
    }

    function clearFrame(){
      if(state.renderPending && state.frameId) cancelFrame(state.frameId);
      state.renderPending = false;
      state.frameId = 0;
    }

    function end(){
      const session = state.session;
      if(!session) return false;
      state.session = null;
      clearFrame();
      session.target.dirty = true;
      editor.canvas.requestRenderAll?.();
      if(session.changed){
        editor.saveHistory?.(HISTORY_LABELS[session.tool]);
        editor._refreshLayerThumbnailForObject?.(session.target);
        editor._scheduleUi?.('status', 'minimap', 'histogram');
      }
      return session.changed;
    }

    function cancel(){
      const session = state.session;
      if(!session) return false;
      state.session = null;
      clearFrame();
      setTargetElement(session.target, session.originalElement);
      editor.canvas.requestRenderAll?.();
      return true;
    }

    function setCloneSource(point){
      const normalized = finitePoint(point);
      if(!normalized) return false;
      state.cloneSource = normalized;
      return true;
    }

    function reset(){
      cancel();
      state.cloneSource = null;
    }

    function getState(){
      return {
        active:Boolean(state.session),
        tool:state.session?.tool || '',
        target:state.session?.target || null,
        cloneSource:state.cloneSource ? {...state.cloneSource} : null,
      };
    }

    return Object.freeze({
      begin,
      move,
      end,
      cancel,
      reset,
      setCloneSource,
      resolveTarget,
      getState,
    });
  }

  root.HstarOpenShopRasterTools = Object.freeze({createController});
})(window);
