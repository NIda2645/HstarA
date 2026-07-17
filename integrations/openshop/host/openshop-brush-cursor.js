(function bootstrapOpenShopBrushCursor(root){
  function finite(value, fallback = 0){
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
  }

  function createController(options = {}){
    const documentRef = options.documentRef || root.document;
    const area = options.area;
    const getProfile = typeof options.getProfile === 'function'
      ? options.getProfile
      : () => ({visible:false});
    if(!documentRef?.createElement || !area?.addEventListener){
      throw new Error('OpenShop brush cursor dependencies are unavailable');
    }

    const cursor = documentRef.createElement('div');
    cursor.className = 'hstar-brush-cursor';
    cursor.dataset.brushCursor = '';
    cursor.hidden = true;
    area.appendChild(cursor);
    let lastPointer = null;

    function render(){
      const profile = getProfile() || {};
      if(!lastPointer || !profile.visible){
        cursor.hidden = true;
        return;
      }
      const rect = area.getBoundingClientRect();
      const diameter = Math.max(1, finite(profile.size, 1) * Math.max(0.0001, Math.abs(finite(profile.zoom, 1))));
      cursor.hidden = false;
      cursor.dataset.shape = String(profile.shape || 'round');
      cursor.style.left = `${lastPointer.clientX - rect.left}px`;
      cursor.style.top = `${lastPointer.clientY - rect.top}px`;
      cursor.style.width = `${diameter}px`;
      cursor.style.height = `${profile.shape === 'flat' ? Math.max(1, diameter * 0.35) : diameter}px`;
    }

    function move(event){
      lastPointer = {clientX:finite(event?.clientX), clientY:finite(event?.clientY)};
      render();
    }

    function hide(){
      lastPointer = null;
      cursor.hidden = true;
    }

    area.addEventListener('pointermove', move, {passive:true});
    area.addEventListener('pointerleave', hide, {passive:true});

    return Object.freeze({
      refresh:render,
      hide,
      destroy(){
        area.removeEventListener('pointermove', move);
        area.removeEventListener('pointerleave', hide);
        cursor.remove();
      },
    });
  }

  root.HstarOpenShopBrushCursor = Object.freeze({createController});
})(window);
