(function bootstrapOpenShopLiveEraser(root){
  const PREVIEW_COLOR = 'rgba(0,0,0,0.001)';
  const FINAL_COLOR = 'rgba(0,0,0,1)';

  function finitePoint(value){
    const x = Number(value?.x);
    const y = Number(value?.y);
    return Number.isFinite(x) && Number.isFinite(y) ? {x, y} : null;
  }

  function drawSegment(canvas, brush, fromValue, toValue){
    const context = canvas?.contextContainer;
    const from = finitePoint(fromValue);
    const to = finitePoint(toValue);
    if(!context || !from || !to) return false;
    const transform = Array.isArray(canvas.viewportTransform)
      ? canvas.viewportTransform
      : [1, 0, 0, 1, 0, 0];
    context.save();
    try {
      context.transform(...transform);
      context.globalCompositeOperation = 'destination-out';
      context.strokeStyle = FINAL_COLOR;
      context.lineWidth = Math.max(1, Number(brush.width) || 1);
      context.lineCap = 'round';
      context.lineJoin = 'round';
      context.beginPath();
      context.moveTo(from.x, from.y);
      context.lineTo(to.x, to.y);
      context.stroke();
      return true;
    } finally {
      context.restore();
    }
  }

  function createBrush({fabricRef, canvas} = {}){
    if(typeof fabricRef?.PencilBrush !== 'function' || !canvas) {
      throw new Error('OpenShop eraser dependencies are unavailable');
    }
    const brush = new fabricRef.PencilBrush(canvas);
    const baseMouseDown = brush.onMouseDown?.bind(brush);
    const baseMouseMove = brush.onMouseMove?.bind(brush);
    brush.color = PREVIEW_COLOR;
    if(baseMouseDown) {
      brush.onMouseDown = function onMouseDown(pointer, options){
        this.color = PREVIEW_COLOR;
        return baseMouseDown(pointer, options);
      };
    }
    if(baseMouseMove) {
      brush.onMouseMove = function onMouseMove(pointer, options){
        const previous = finitePoint(this._points?.at?.(-1)) || finitePoint(pointer);
        const result = baseMouseMove(pointer, options);
        const current = finitePoint(this._points?.at?.(-1)) || finitePoint(pointer);
        if(previous && current && (previous.x !== current.x || previous.y !== current.y)) {
          drawSegment(canvas, this, previous, current);
        }
        return result;
      };
    }
    return brush;
  }

  function configureFinalPath(path){
    if(!path) return path;
    path.globalCompositeOperation = 'destination-out';
    path.stroke = FINAL_COLOR;
    path.dirty = true;
    return path;
  }

  root.HstarOpenShopLiveEraser = Object.freeze({
    createBrush,
    configureFinalPath,
    previewColor:PREVIEW_COLOR,
  });
})(window);
