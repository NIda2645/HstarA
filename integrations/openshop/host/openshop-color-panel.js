(function bootstrapOpenShopColorPanel(root){
  function clamp(value, min, max){
    const number = Number(value);
    return Math.min(max, Math.max(min, Number.isFinite(number) ? number : min));
  }

  function normalizeHex(value, fallback = '#000000'){
    const clean = String(value || '').trim().toLowerCase();
    if(/^#[0-9a-f]{6}$/.test(clean)) return clean;
    if(/^#[0-9a-f]{3}$/.test(clean)) {
      return `#${clean.slice(1).split('').map(part => part + part).join('')}`;
    }
    const safeFallback = String(fallback || '#000000').trim().toLowerCase();
    return /^#[0-9a-f]{6}$/.test(safeFallback) ? safeFallback : '#000000';
  }

  function hexToRgb(value){
    const hex = normalizeHex(value);
    return {
      r:Number.parseInt(hex.slice(1, 3), 16),
      g:Number.parseInt(hex.slice(3, 5), 16),
      b:Number.parseInt(hex.slice(5, 7), 16),
    };
  }

  function byte(value){
    return Math.round(clamp(value, 0, 255));
  }

  function rgbToHex(value){
    return `#${[byte(value?.r), byte(value?.g), byte(value?.b)]
      .map(part => part.toString(16).padStart(2, '0')).join('')}`;
  }

  function rgbToHsv(value){
    const r = byte(value?.r) / 255;
    const g = byte(value?.g) / 255;
    const b = byte(value?.b) / 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const delta = max - min;
    let h = 0;
    if(delta) {
      if(max === r) h = 60 * (((g - b) / delta) % 6);
      else if(max === g) h = 60 * ((b - r) / delta + 2);
      else h = 60 * ((r - g) / delta + 4);
    }
    if(h < 0) h += 360;
    return {
      h,
      s:max ? delta / max * 100 : 0,
      v:max * 100,
    };
  }

  function hsvToRgb(value){
    const h = ((clamp(value?.h, 0, 360) % 360) + 360) % 360;
    const s = clamp(value?.s, 0, 100) / 100;
    const v = clamp(value?.v, 0, 100) / 100;
    const chroma = v * s;
    const part = chroma * (1 - Math.abs((h / 60) % 2 - 1));
    const offset = v - chroma;
    let channels;
    if(h < 60) channels = [chroma, part, 0];
    else if(h < 120) channels = [part, chroma, 0];
    else if(h < 180) channels = [0, chroma, part];
    else if(h < 240) channels = [0, part, chroma];
    else if(h < 300) channels = [part, 0, chroma];
    else channels = [chroma, 0, part];
    return {
      r:Math.round((channels[0] + offset) * 255),
      g:Math.round((channels[1] + offset) * 255),
      b:Math.round((channels[2] + offset) * 255),
    };
  }

  function createController(options = {}){
    const editor = options.editor;
    const sampler = options.sampler || root.HstarOpenShopCanvasSampler;
    const documentRef = options.documentRef || root.document;
    if(!editor?.canvas || !documentRef) throw new Error('OpenShop color panel dependencies are unavailable');
    const state = {
      started:false,
      target:null,
      original:'#000000',
      draft:'#000000',
      sampling:false,
      previousTool:'select',
      panel:null,
      anchor:null,
      draggingField:false,
      listeners:[],
    };

    function addListener(target, event, listener, optionsValue){
      target?.addEventListener?.(event, listener, optionsValue);
      state.listeners.push(() => target?.removeEventListener?.(event, listener, optionsValue));
    }

    function targetColor(target = state.target){
      return target === 'background'
        ? normalizeHex(editor.state?.bgColor)
        : normalizeHex(editor.state?.fgColor, '#ffffff');
    }

    function hidePanel(){
      if(state.panel) state.panel.hidden = true;
    }

    function panelElement(selector){
      return state.panel?.querySelector(selector) || null;
    }

    function syncPanel(){
      if(!state.panel) return;
      const rgb = hexToRgb(state.draft);
      const hsv = rgbToHsv(rgb);
      state.panel.dataset.target = state.target || '';
      const title = panelElement('[data-color-title]');
      if(title) title.textContent = state.target === 'background' ? '选择背景色' : '选择前景色';
      const field = panelElement('[data-color-field]');
      if(field) field.style.backgroundColor = `hsl(${hsv.h} 100% 50%)`;
      const cursor = panelElement('[data-color-cursor]');
      if(cursor) {
        cursor.style.left = `${hsv.s}%`;
        cursor.style.top = `${100 - hsv.v}%`;
      }
      const hue = panelElement('[data-color-hue]');
      if(hue) hue.value = String(hsv.h);
      const preview = panelElement('[data-color-preview]');
      if(preview) preview.style.background = state.draft;
      const hex = panelElement('[data-color-hex]');
      if(hex) hex.textContent = state.draft.toUpperCase();
      ['r', 'g', 'b'].forEach(channel => {
        const input = panelElement(`[data-color-${channel}]`);
        if(input) input.value = String(rgb[channel]);
      });
    }

    function positionPanel(anchor = state.anchor){
      if(!state.panel || !anchor?.getBoundingClientRect) return;
      const rect = anchor.getBoundingClientRect();
      const width = state.panel.offsetWidth || 332;
      const height = state.panel.offsetHeight || 380;
      const viewportWidth = documentRef.documentElement?.clientWidth || root.innerWidth || 1280;
      const viewportHeight = documentRef.documentElement?.clientHeight || root.innerHeight || 720;
      const preferredLeft = rect.left - width - 10;
      const left = clamp(preferredLeft >= 10 ? preferredLeft : rect.right + 10, 10, Math.max(10, viewportWidth - width - 10));
      const top = clamp(rect.top, 10, Math.max(10, viewportHeight - height - 10));
      state.panel.style.left = `${Math.round(left)}px`;
      state.panel.style.top = `${Math.round(top)}px`;
    }

    function createPanel(){
      const existing = documentRef.querySelector('[data-hstar-color-panel]');
      if(existing) {
        state.panel = existing;
        return;
      }
      const panel = documentRef.createElement('div');
      panel.className = 'hstar-color-panel';
      panel.dataset.hstarColorPanel = 'true';
      panel.hidden = true;
      panel.innerHTML = `
        <div class="hstar-color-header">
          <strong data-color-title>选择前景色</strong>
          <button type="button" class="hstar-color-close" data-color-cancel aria-label="关闭">×</button>
        </div>
        <div class="hstar-color-field" data-color-field>
          <span class="hstar-color-cursor" data-color-cursor></span>
        </div>
        <div class="hstar-color-controls">
          <div class="hstar-color-primary-row">
            <button type="button" class="hstar-color-sample" data-color-sample><span aria-hidden="true"></span>从画布取色</button>
            <span class="hstar-color-preview" data-color-preview></span>
            <input type="range" min="0" max="359" value="0" class="hstar-color-hue" data-color-hue aria-label="色相">
          </div>
          <div class="hstar-color-rgb">
            <label>R<input type="number" min="0" max="255" data-color-r></label>
            <label>G<input type="number" min="0" max="255" data-color-g></label>
            <label>B<input type="number" min="0" max="255" data-color-b></label>
          </div>
          <div class="hstar-color-footer">
            <code data-color-hex>#000000</code>
            <div><button type="button" class="btn" data-color-cancel>取消</button><button type="button" class="btn btn-primary" data-color-commit>确定</button></div>
          </div>
        </div>`;
      documentRef.body.append(panel);
      state.panel = panel;
    }

    function setDraft(value){
      state.draft = normalizeHex(value, state.draft);
      syncPanel();
      return state.draft;
    }

    function setFromField(event){
      const field = panelElement('[data-color-field]');
      if(!field) return;
      const rect = field.getBoundingClientRect();
      const saturation = clamp((event.clientX - rect.left) / Math.max(1, rect.width) * 100, 0, 100);
      const brightness = clamp(100 - (event.clientY - rect.top) / Math.max(1, rect.height) * 100, 0, 100);
      const hue = Number(panelElement('[data-color-hue]')?.value || 0);
      setDraft(rgbToHex(hsvToRgb({h:hue, s:saturation, v:brightness})));
    }

    function setFromRgbInputs(){
      setDraft(rgbToHex({
        r:panelElement('[data-color-r]')?.value,
        g:panelElement('[data-color-g]')?.value,
        b:panelElement('[data-color-b]')?.value,
      }));
    }

    function open(target, anchor){
      const normalizedTarget = target === 'background' ? 'background' : 'foreground';
      if(state.sampling) cancelSampling();
      state.target = normalizedTarget;
      state.anchor = anchor || documentRef.getElementById(normalizedTarget === 'background' ? 'bg-color' : 'fg-color');
      state.original = targetColor(normalizedTarget);
      state.draft = state.original;
      syncPanel();
      state.panel.hidden = false;
      positionPanel(state.anchor);
      return state.draft;
    }

    function close({keepDraft = false} = {}){
      hidePanel();
      state.target = null;
      state.anchor = null;
      if(!keepDraft) state.draft = state.original;
    }

    function commit(){
      if(!state.target || state.sampling) return false;
      const target = state.target;
      const color = normalizeHex(state.draft, state.original);
      if(target === 'background') editor.setBgColor?.(color);
      else editor.setFgColor?.(color);
      state.original = color;
      state.draft = color;
      close({keepDraft:true});
      return true;
    }

    function cancel(){
      if(state.sampling) return cancelSampling();
      state.draft = state.original;
      close({keepDraft:true});
      return true;
    }

    function restoreTool(){
      const tool = state.previousTool || 'select';
      state.sampling = false;
      editor.setTool?.(tool, {forceInteraction:true});
    }

    function beginSampling(){
      if(!state.target || state.sampling) return false;
      state.previousTool = String(editor.state?.tool || 'select');
      state.sampling = true;
      hidePanel();
      editor.canvas.defaultCursor = 'crosshair';
      editor.canvas.hoverCursor = 'crosshair';
      return true;
    }

    function cancelSampling(){
      if(!state.sampling) return false;
      state.draft = state.original;
      restoreTool();
      close({keepDraft:true});
      return true;
    }

    function handleCanvasSample({event, documentPoint} = {}){
      if(!state.sampling) return false;
      try {
        const result = sampler?.sample?.({
          canvas:editor.canvas,
          event,
          documentPoint,
          documentWidth:editor.canvasW,
          documentHeight:editor.canvasH,
        });
        const color = normalizeHex(result?.hex, '');
        if(!result?.hex || !/^#[0-9a-f]{6}$/.test(color)) throw new Error('Canvas color could not be sampled');
        const target = state.target;
        state.draft = color;
        state.original = color;
        if(target === 'background') editor.setBgColor?.(color);
        else editor.setFgColor?.(color);
        restoreTool();
        close({keepDraft:true});
      } catch(error) {
        editor.toast?.(error instanceof Error ? error.message : String(error), 'error');
        editor.canvas.defaultCursor = 'crosshair';
        editor.canvas.hoverCursor = 'crosshair';
      }
      return true;
    }

    function bindPanel(){
      const field = panelElement('[data-color-field]');
      addListener(field, 'mousedown', event => {
        state.draggingField = true;
        setFromField(event);
        event.preventDefault();
      });
      addListener(documentRef, 'mousemove', event => {
        if(state.draggingField) setFromField(event);
      });
      addListener(documentRef, 'mouseup', () => { state.draggingField = false; });
      addListener(panelElement('[data-color-hue]'), 'input', event => {
        const hsv = rgbToHsv(hexToRgb(state.draft));
        setDraft(rgbToHex(hsvToRgb({h:event.target.value, s:hsv.s, v:hsv.v})));
      });
      ['r', 'g', 'b'].forEach(channel => addListener(
        panelElement(`[data-color-${channel}]`), 'input', setFromRgbInputs
      ));
      addListener(panelElement('[data-color-sample]'), 'click', beginSampling);
      state.panel.querySelectorAll('[data-color-cancel]').forEach(button => addListener(button, 'click', cancel));
      addListener(panelElement('[data-color-commit]'), 'click', commit);
    }

    function start(){
      if(state.started) return controller;
      createPanel();
      bindPanel();
      const foreground = documentRef.getElementById('fg-color');
      const background = documentRef.getElementById('bg-color');
      addListener(foreground, 'click', () => open('foreground', foreground));
      addListener(background, 'click', () => open('background', background));
      [foreground, background].forEach(button => addListener(button, 'keydown', event => {
        if(event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        open(button === background ? 'background' : 'foreground', button);
      }));
      addListener(documentRef, 'mousedown', event => {
        if(state.sampling || !state.target || state.panel.hidden) return;
        if(state.panel.contains(event.target) || state.anchor?.contains?.(event.target)) return;
        cancel();
      });
      addListener(documentRef, 'keydown', event => {
        if(event.key !== 'Escape') return;
        if(state.sampling) cancelSampling();
        else if(state.target) cancel();
      });
      addListener(root, 'resize', () => {
        if(state.target && !state.panel.hidden) positionPanel();
      });
      state.started = true;
      return controller;
    }

    function destroy(){
      if(state.sampling) cancelSampling();
      state.listeners.splice(0).forEach(remove => remove());
      state.panel?.remove();
      state.panel = null;
      state.started = false;
      state.target = null;
    }

    const controller = {
      start,
      destroy,
      open,
      commit,
      cancel,
      setDraft,
      beginSampling,
      cancelSampling,
      handleCanvasSample,
      getState:() => ({
        started:state.started,
        target:state.target,
        original:state.original,
        draft:state.draft,
        sampling:state.sampling,
        previousTool:state.previousTool,
      }),
    };
    return controller;
  }

  root.HstarOpenShopColorPanel = Object.freeze({
    createController,
    normalizeHex,
    hexToRgb,
    rgbToHex,
    rgbToHsv,
    hsvToRgb,
  });
})(window);
