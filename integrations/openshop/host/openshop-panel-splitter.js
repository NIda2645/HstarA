(function bootstrapOpenShopPanelSplitter(root){
  const STORAGE_KEY = 'openshop.panel.secondaryHeight';

  function clamp(value, min, max){
    return Math.min(max, Math.max(min, Number(value) || min));
  }

  function createController(options = {}){
    const documentRef = options.documentRef || root.document;
    const primary = options.primary || documentRef?.getElementById('ptg1-group');
    const secondary = options.secondary || documentRef?.getElementById('ptg2-group');
    const splitter = options.splitter || documentRef?.getElementById('panel-group-splitter');
    const minPrimary = Math.max(80, Number(options.minPrimary) || 160);
    const minSecondary = Math.max(72, Number(options.minSecondary) || 110);
    const step = Math.max(4, Number(options.step) || 16);
    if(!documentRef || !primary || !secondary || !splitter) {
      throw new Error('OpenShop panel splitter dependencies are unavailable');
    }

    const state = {
      started:false,
      dragging:false,
      startY:0,
      startSecondary:0,
      total:0,
      listeners:[],
    };

    function addListener(target, event, listener, optionsValue){
      target?.addEventListener?.(event, listener, optionsValue);
      state.listeners.push(() => target?.removeEventListener?.(event, listener, optionsValue));
    }

    function heights(){
      const primaryHeight = Math.max(0, Number(primary.getBoundingClientRect?.().height) || 0);
      const secondaryHeight = Math.max(0, Number(secondary.getBoundingClientRect?.().height) || 0);
      return {primary:primaryHeight, secondary:secondaryHeight, total:primaryHeight + secondaryHeight};
    }

    function savedHeight(){
      try {
        const value = Number(root.localStorage?.getItem(STORAGE_KEY));
        return Number.isFinite(value) && value > 0 ? value : null;
      } catch (_) {
        return null;
      }
    }

    function persist(value){
      try { root.localStorage?.setItem(STORAGE_KEY, String(Math.round(value))); } catch (_) {}
    }

    function setSecondaryHeight(value, {persistValue = true, total = heights().total} = {}){
      const available = Math.max(minPrimary + minSecondary, Number(total) || 0);
      const height = Math.round(clamp(value, minSecondary, available - minPrimary));
      secondary.style.flexBasis = `${height}px`;
      splitter.setAttribute('aria-valuemin', String(minSecondary));
      splitter.setAttribute('aria-valuemax', String(Math.round(available - minPrimary)));
      splitter.setAttribute('aria-valuenow', String(height));
      if(persistValue) persist(height);
      return height;
    }

    function beginDrag(event){
      if(event.button !== undefined && event.button !== 0) return;
      const current = heights();
      state.dragging = true;
      state.startY = Number(event.clientY) || 0;
      state.startSecondary = current.secondary;
      state.total = current.total;
      documentRef.body?.classList.add('panel-split-resizing');
      splitter.setAttribute('aria-grabbed', 'true');
      event.preventDefault?.();
    }

    function moveDrag(event){
      if(!state.dragging) return;
      const delta = (Number(event.clientY) || 0) - state.startY;
      setSecondaryHeight(state.startSecondary - delta, {persistValue:false, total:state.total});
      event.preventDefault?.();
    }

    function endDrag(){
      if(!state.dragging) return;
      state.dragging = false;
      documentRef.body?.classList.remove('panel-split-resizing');
      splitter.setAttribute('aria-grabbed', 'false');
      persist(heights().secondary);
    }

    function onKeyDown(event){
      const current = heights();
      let next = null;
      if(event.key === 'ArrowUp') next = current.secondary + step;
      else if(event.key === 'ArrowDown') next = current.secondary - step;
      else if(event.key === 'Home') next = minSecondary;
      else if(event.key === 'End') next = current.total - minPrimary;
      if(next === null) return;
      setSecondaryHeight(next, {total:current.total});
      event.preventDefault();
    }

    function start(){
      if(state.started) return controller;
      const current = heights();
      setSecondaryHeight(savedHeight() ?? current.secondary, {
        persistValue:false,
        total:current.total,
      });
      addListener(splitter, 'pointerdown', beginDrag);
      addListener(documentRef, 'pointermove', moveDrag);
      addListener(documentRef, 'pointerup', endDrag);
      addListener(documentRef, 'pointercancel', endDrag);
      addListener(splitter, 'keydown', onKeyDown);
      addListener(root, 'resize', () => setSecondaryHeight(heights().secondary, {persistValue:false}));
      state.started = true;
      return controller;
    }

    function destroy(){
      state.listeners.splice(0).forEach(remove => remove());
      state.dragging = false;
      state.started = false;
      documentRef.body?.classList.remove('panel-split-resizing');
      splitter.setAttribute('aria-grabbed', 'false');
    }

    const controller = {
      start,
      destroy,
      setSecondaryHeight,
      getState:() => ({
        started:state.started,
        dragging:state.dragging,
        secondaryHeight:heights().secondary,
      }),
    };
    return controller;
  }

  root.HstarOpenShopPanelSplitter = Object.freeze({createController});
})(window);
