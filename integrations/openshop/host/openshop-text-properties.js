(function bootstrapOpenShopTextProperties(root){
  const CHARACTER_PROPERTIES = new Set([
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'underline', 'linethrough',
  ]);
  const OBJECT_PROPERTIES = new Set(['textAlign', 'lineHeight', 'charSpacing']);
  const MIXED = '__mixed__';

  const pointsToPixels = value => Number(value) * 96 / 72;
  const pixelsToPoints = value => Number(value) * 72 / 96;
  const isTextObject = object => ['text', 'i-text', 'textbox'].includes(String(object?.type || '').toLowerCase());

  function clean(value){
    return String(value ?? '').trim();
  }

  function clone(value){
    if(typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function createController(options = {}){
    const editor = options.editor;
    const fontManager = options.fontManager;
    const documentRef = options.documentRef || root.document;
    if(!editor?.canvas || !fontManager) throw new Error('OpenShop 文字属性依赖不完整');

    const state = {
      started:false,
      destroyed:false,
      target:null,
      caretStyles:{},
      previousText:'',
      familyValue:'',
      listeners:[],
      unsubscribeFonts:null,
      panel:null,
      tab:null,
    };

    function addListener(target, event, listener){
      target?.on?.(event, listener);
      state.listeners.push(() => target?.off?.(event, listener));
    }

    function addDomListener(target, event, listener){
      target?.addEventListener?.(event, listener);
      state.listeners.push(() => target?.removeEventListener?.(event, listener));
    }

    function activeTextObject(){
      const active = state.target || editor.canvas.getActiveObject?.();
      return isTextObject(active) ? active : null;
    }

    function setObject(target, values){
      if(typeof target.set === 'function') target.set(values);
      else Object.assign(target, values);
    }

    function editingRange(target){
      if(!target?.isEditing) return null;
      const start = Number(target.selectionStart || 0);
      const end = Number(target.selectionEnd || 0);
      return {start, end};
    }

    function selectionValue(target, property){
      const range = editingRange(target);
      if(!range || range.start >= range.end || typeof target.getSelectionStyles !== 'function') {
        return target[property];
      }
      const styles = target.getSelectionStyles(range.start, range.end, true) || [];
      if(!styles.length) return target[property];
      const values = styles.map(style => style[property]);
      return values.every(value => value === values[0]) ? values[0] : MIXED;
    }

    function propertyValue(target, property){
      return selectionValue(target, property);
    }

    function setControlValue(selector, value, {points = false} = {}){
      const control = documentRef.querySelector(selector);
      if(!control) return;
      if(value === MIXED || value === undefined || value === null) {
        control.value = '';
        control.dataset.mixed = value === MIXED ? 'true' : 'false';
        return;
      }
      control.dataset.mixed = 'false';
      control.value = points ? String(Number(pixelsToPoints(value).toFixed(2))) : String(value);
    }

    function syncFamilyControl(value){
      const control = documentRef.querySelector('[data-text-family]');
      const label = control?.querySelector('[data-text-family-label]');
      if(!control || !label) return;
      const mixed = value === MIXED;
      state.familyValue = mixed ? '' : clean(fontManager.resolveFamily?.(value) || value);
      control.dataset.mixed = mixed ? 'true' : 'false';
      label.textContent = mixed ? '多种字体' : state.familyValue;
      control.title = label.textContent;
    }

    function ensureOption(select, value, label = value){
      if(!select || !value || value === MIXED) return;
      const existing = [...select.options].find(option => option.value === String(value));
      if(!existing) select.append(new Option(label, value));
      select.value = String(value);
    }

    function updateStyleOptions(family){
      const select = documentRef.querySelector('[data-text-style]');
      if(!select) return;
      const groupedFamily = clean(fontManager.resolveFamily?.(family) || family);
      const styles = fontManager.stylesFor?.(groupedFamily) || [];
      const current = select.value;
      select.innerHTML = '';
      styles.forEach(style => {
        const option = new Option(style.label === 'Default' ? '默认' : style.label, style.id);
        option.dataset.family = clean(style.family) || groupedFamily;
        option.dataset.weight = String(style.weight);
        option.dataset.italic = style.italic ? 'true' : 'false';
        select.append(option);
      });
      const target = activeTextObject();
      const face = propertyValue(target, 'fontFamily');
      const weight = propertyValue(target, 'fontWeight');
      const italic = propertyValue(target, 'fontStyle') === 'italic';
      const exact = face !== MIXED ? fontManager.styleForFace?.(face) : null;
      if(exact && [...select.options].some(option => option.value === exact.id)) {
        select.value = exact.id;
        return;
      }
      if(weight !== MIXED && weight !== undefined) {
        const normalizedWeight = weight === 'bold' ? 700 : Number(weight);
        const option = [...select.options].find(item => (
          Number(item.dataset.weight) === normalizedWeight
          && (item.dataset.italic === 'true') === italic
        ));
        if(option) select.value = option.value;
        else if(current && [...select.options].some(option => option.value === current)) select.value = current;
      }
    }

    function applyFontStyle(style, {commit = true} = {}){
      if(!style) return false;
      applyProperty('fontFamily', clean(style.family), {commit:false});
      applyProperty('fontWeight', Number(style.weight) || 400, {commit:false});
      applyProperty('fontStyle', style.italic ? 'italic' : 'normal', {commit:false});
      if(commit) commitChange('字型');
      return true;
    }

    function syncTopBar(target){
      if(!target) return;
      const family = propertyValue(target, 'fontFamily');
      const familyControl = documentRef.getElementById('text-font');
      if(family !== MIXED && family !== undefined) {
        ensureOption(familyControl, family);
        if(familyControl) familyControl.value = String(family);
      }
      setControlValue('#text-size', propertyValue(target, 'fontSize'), {points:true});
      setControlValue('#text-color', propertyValue(target, 'fill'));
      const bold = propertyValue(target, 'fontWeight');
      const italic = propertyValue(target, 'fontStyle');
      const boldControl = documentRef.getElementById('text-bold');
      const italicControl = documentRef.getElementById('text-italic');
      if(boldControl && bold !== MIXED) boldControl.checked = bold === 'bold' || Number(bold) >= 600;
      if(italicControl && italic !== MIXED) italicControl.checked = italic === 'italic';
    }

    function syncControls(){
      const target = activeTextObject();
      if(!target) return;
      const family = propertyValue(target, 'fontFamily');
      syncFamilyControl(family);
      updateStyleOptions(family === MIXED ? '' : family);
      setControlValue('[data-text-size]', propertyValue(target, 'fontSize'), {points:true});
      setControlValue('[data-text-line-height]', propertyValue(target, 'lineHeight'));
      setControlValue('[data-text-tracking]', propertyValue(target, 'charSpacing'));
      setControlValue('[data-text-color]', propertyValue(target, 'fill'));
      setControlValue('[data-text-align]', propertyValue(target, 'textAlign'));
      setControlValue('[data-text-kerning]', propertyValue(target, 'charSpacing'));
      const kerningMode = target.hstarKerningMode || (Number(target.charSpacing || 0) ? 'numeric' : 'auto');
      setControlValue('[data-text-kerning-mode]', kerningMode);
      const kerningInput = documentRef.querySelector('[data-text-kerning]');
      if(kerningInput) kerningInput.disabled = kerningMode !== 'numeric';
      ['underline', 'linethrough'].forEach(property => {
        const control = documentRef.querySelector(`[data-text-${property}]`);
        const value = propertyValue(target, property);
        if(control && value !== MIXED) control.checked = Boolean(value);
      });
      syncTopBar(target);
    }

    function activateTextTab(){
      const tab = state.tab;
      const panel = state.panel;
      if(!tab || !panel) return;
      tab.parentElement?.querySelectorAll('.panel-tab').forEach(item => item.classList.remove('active'));
      tab.classList.add('active');
      const group = panel.parentElement;
      group?.querySelectorAll('.panel-tab-content[data-group="ptg2"]').forEach(item => item.classList.remove('active'));
      panel.classList.add('active');
    }

    function commitChange(property){
      editor.saveHistory?.(`修改文字${property ? ` ${property}` : ''}`.trim());
      editor.updateLayersPanel?.();
      fontManager.scanEditor?.(editor);
      root.dispatchEvent?.(new CustomEvent('openshop:project-dirty', {
        detail:{action:`OpenShop text ${property || 'change'}`},
      }));
    }

    function applyProperty(property, value, {commit = true} = {}){
      const target = activeTextObject();
      if(!target) return false;
      const normalized = property === 'fontSize' ? pointsToPixels(value) : value;
      const range = editingRange(target);
      if(CHARACTER_PROPERTIES.has(property) && range) {
        if(range.start < range.end) {
          target.setSelectionStyles?.({[property]:normalized}, range.start, range.end);
        } else {
          state.caretStyles[property] = normalized;
        }
      } else {
        setObject(target, {[property]:normalized});
      }
      editor.canvas.renderAll?.();
      syncControls();
      if(commit) commitChange(property);
      return true;
    }

    function applyKerning(mode, value = 0, {commit = true} = {}){
      const target = activeTextObject();
      if(!target) return false;
      const normalizedMode = ['auto', 'metrics', 'numeric'].includes(mode) ? mode : 'auto';
      const charSpacing = normalizedMode === 'numeric' ? Number(value || 0) : 0;
      setObject(target, {charSpacing, hstarKerningMode:normalizedMode});
      editor.canvas.renderAll?.();
      syncControls();
      if(commit) commitChange('字偶距');
      return true;
    }

    function onSelection(event){
      const candidate = event?.selected?.[0] || editor.canvas.getActiveObject?.();
      if(!isTextObject(candidate)) return;
      state.target = candidate;
      state.previousText = String(candidate.text || '');
      activateTextTab();
      syncControls();
    }

    function onEditingEntered(event){
      const candidate = event?.target || editor.canvas.getActiveObject?.();
      if(!isTextObject(candidate)) return;
      state.target = candidate;
      state.previousText = String(candidate.text || '');
      activateTextTab();
      syncControls();
    }

    function onTextSelectionChanged(event){
      if(event?.target && isTextObject(event.target)) state.target = event.target;
      if(state.target) {
        activateTextTab();
        syncControls();
      }
    }

    function onTextChanged(event){
      const target = event?.target;
      if(target !== state.target || !target?.isEditing) return;
      const currentText = String(target.text || '');
      const currentEnd = Number(target.selectionEnd ?? target.selectionStart ?? currentText.length);
      const inserted = Math.max(0, currentText.length - state.previousText.length);
      if(inserted > 0 && Object.keys(state.caretStyles).length) {
        target.setSelectionStyles?.(state.caretStyles, Math.max(0, currentEnd - inserted), currentEnd);
        editor.canvas.renderAll?.();
      }
      state.previousText = currentText;
      syncControls();
    }

    function createPanel(){
      const existing = documentRef.querySelector('[data-hstar-text-properties-tab]');
      if(existing) {
        state.tab = existing;
        state.panel = documentRef.getElementById('hstar-text-properties-panel');
        return;
      }
      const group = documentRef.getElementById('ptg2-color')?.parentElement;
      const tabs = group?.querySelector('.panel-tabs');
      if(!group || !tabs) throw new Error('OpenShop 右侧面板不可用');
      const tab = documentRef.createElement('button');
      tab.type = 'button';
      tab.className = 'panel-tab';
      tab.dataset.hstarTextPropertiesTab = 'true';
      tab.textContent = '文字';
      tab.addEventListener('click', activateTextTab);
      tabs.append(tab);
      const panel = documentRef.createElement('div');
      panel.className = 'panel-tab-content';
      panel.id = 'hstar-text-properties-panel';
      panel.dataset.group = 'ptg2';
      panel.innerHTML = `
        <div class="ptc-inner hstar-text-properties-inner">
          <div class="hstar-text-property-grid">
            <label class="hstar-text-property-wide">字体
              <button type="button" class="hstar-font-select" data-text-family aria-haspopup="listbox" aria-expanded="false">
                <span data-text-family-label></span><span aria-hidden="true">▾</span>
              </button>
              <div class="hstar-font-list" data-text-font-list role="listbox" hidden></div>
            </label>
            <label>字形 <select data-text-style></select></label>
            <label>字号 <input type="number" data-text-size min="1" max="1296" step="0.1"></label>
            <label>行距 <input type="number" data-text-line-height min="0.1" max="10" step="0.05"></label>
            <label>字距 <input type="number" data-text-tracking min="-1000" max="1000"></label>
            <label>字偶距
              <select data-text-kerning-mode><option value="auto">自动</option><option value="metrics">度量</option><option value="numeric">数值</option></select>
            </label>
            <label>数值 <input type="number" data-text-kerning min="-1000" max="1000" disabled></label>
            <label>颜色 <input type="color" data-text-color></label>
            <label>对齐 <select data-text-align><option value="left">左对齐</option><option value="center">居中对齐</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select></label>
          </div>
          <div class="hstar-text-property-toggles">
            <label><input type="checkbox" data-text-bold> 粗体</label>
            <label><input type="checkbox" data-text-italic> 斜体</label>
            <label><input type="checkbox" data-text-underline> 下划线</label>
            <label><input type="checkbox" data-text-linethrough> 删除线</label>
          </div>
          <button type="button" class="btn" data-font-refresh title="刷新本机字体">刷新本机字体</button>
          <div class="hstar-font-status" data-font-status role="status"></div>
        </div>`;
      group.append(panel);
      state.tab = tab;
      state.panel = panel;
      bindPanelControls();
    }

    function bindPanelControls(){
      const family = documentRef.querySelector('[data-text-family]');
      const list = documentRef.querySelector('[data-text-font-list]');
      const closeFontList = () => {
        if(list) list.hidden = true;
        family?.setAttribute('aria-expanded', 'false');
      };
      const renderFontList = () => {
        if(!list || !family) return;
        list.innerHTML = '';
        let selectedOption = null;
        (fontManager.searchFonts?.('') || []).forEach(font => {
          const option = documentRef.createElement('button');
          option.type = 'button';
          option.className = 'hstar-font-option';
          option.dataset.family = font.family;
          option.setAttribute('role', 'option');
          const selected = clean(font.family).toLowerCase() === state.familyValue.toLowerCase();
          option.setAttribute('aria-selected', selected ? 'true' : 'false');
          if(selected) selectedOption = option;
          option.textContent = font.status === 'missing' ? `${font.label}（缺失字体）` : font.label;
          option.style.fontFamily = `'${font.family.replaceAll("'", '')}'`;
          option.addEventListener('mousedown', event => event.preventDefault());
          option.addEventListener('click', () => {
            closeFontList();
            const style = fontManager.defaultStyleFor?.(font.family);
            if(!applyFontStyle(style)) applyProperty('fontFamily', font.family);
          });
          list.append(option);
        });
        list.hidden = false;
        family.setAttribute('aria-expanded', 'true');
        selectedOption?.scrollIntoView?.({block:'nearest'});
      };
      addDomListener(family, 'click', () => {
        if(list?.hidden) renderFontList();
        else closeFontList();
      });
      addDomListener(family, 'keydown', event => {
        if(event.key === 'Escape') {
          closeFontList();
          event.preventDefault();
        }
      });
      addDomListener(documentRef, 'mousedown', event => {
        if(list && !list.contains(event.target) && !family?.contains(event.target)) {
          closeFontList();
        }
      });

      documentRef.querySelector('[data-text-style]')?.addEventListener('change', event => {
        const option = event.target.selectedOptions?.[0];
        if(!option) return;
        applyFontStyle({
          id:option.value,
          family:option.dataset.family,
          weight:Number(option.dataset.weight),
          italic:option.dataset.italic === 'true',
        });
      });
      bindCommitControl('[data-text-size]', value => applyProperty('fontSize', Number(value), {commit:false}), '字号');
      bindCommitControl('[data-text-line-height]', value => applyProperty('lineHeight', Number(value), {commit:false}), '行距');
      bindCommitControl('[data-text-tracking]', value => applyProperty('charSpacing', Number(value), {commit:false}), '字距');
      bindCommitControl('[data-text-kerning]', value => applyKerning('numeric', Number(value), {commit:false}), '字偶距');
      documentRef.querySelector('[data-text-kerning-mode]')?.addEventListener('change', event => {
        const value = Number(documentRef.querySelector('[data-text-kerning]')?.value || 0);
        applyKerning(event.target.value, value);
      });
      documentRef.querySelector('[data-text-color]')?.addEventListener('change', event => applyProperty('fill', event.target.value));
      documentRef.querySelector('[data-text-align]')?.addEventListener('change', event => applyProperty('textAlign', event.target.value));
      ['bold', 'italic', 'underline', 'linethrough'].forEach(name => {
        documentRef.querySelector(`[data-text-${name}]`)?.addEventListener('change', event => {
          if(name === 'bold') applyProperty('fontWeight', event.target.checked ? 700 : 400);
          else if(name === 'italic') applyProperty('fontStyle', event.target.checked ? 'italic' : 'normal');
          else applyProperty(name, event.target.checked);
        });
      });
      documentRef.querySelector('[data-font-refresh]')?.addEventListener('click', async () => {
        await fontManager.refreshSystemFonts?.();
        documentRef.querySelector('[data-font-status]').textContent = '本机字体已刷新';
        syncControls();
      });
    }

    function bindTopBarControls(){
      if(state.topBarBound) return;
      state.topBarBound = true;
      const family = documentRef.getElementById('text-font');
      const size = documentRef.getElementById('text-size');
      const color = documentRef.getElementById('text-color');
      const bold = documentRef.getElementById('text-bold');
      const italic = documentRef.getElementById('text-italic');
      addDomListener(family, 'change', event => applyProperty('fontFamily', event.target.value));
      addDomListener(size, 'change', event => applyProperty('fontSize', Number(event.target.value)));
      addDomListener(color, 'change', event => applyProperty('fill', event.target.value));
      addDomListener(bold, 'change', event => applyProperty('fontWeight', event.target.checked ? 700 : 400));
      addDomListener(italic, 'change', event => applyProperty('fontStyle', event.target.checked ? 'italic' : 'normal'));
    }

    function bindCommitControl(selector, apply, property){
      const control = documentRef.querySelector(selector);
      if(!control) return;
      control.addEventListener('input', event => apply(event.target.value));
      control.addEventListener('change', event => {
        const target = activeTextObject();
        if(!target) return;
        apply(event.target.value);
        commitChange(property);
      });
    }

    async function start(){
      if(state.started) return controller;
      createPanel();
      bindTopBarControls();
      state.started = true;
      addListener(editor.canvas, 'selection:created', onSelection);
      addListener(editor.canvas, 'selection:updated', onSelection);
      addListener(editor.canvas, 'selection:cleared', () => syncControls());
      addListener(editor.canvas, 'text:editing:entered', onEditingEntered);
      addListener(editor.canvas, 'text:selection:changed', onTextSelectionChanged);
      addListener(editor.canvas, 'text:changed', onTextChanged);
      addListener(editor.canvas, 'text:editing:exited', onTextSelectionChanged);
      state.unsubscribeFonts = fontManager.subscribe?.(() => syncControls());
      await fontManager.loadSystemFonts?.();
      fontManager.scanEditor?.(editor);
      syncControls();
      return controller;
    }

    function destroy(){
      if(state.destroyed) return;
      state.destroyed = true;
      state.listeners.splice(0).forEach(remove => remove());
      state.unsubscribeFonts?.();
      state.tab?.remove();
      state.panel?.remove();
    }

    const controller = {
      start,
      destroy,
      applyProperty,
      applyKerning,
      sync:syncControls,
      getState:() => ({...state, caretStyles:clone(state.caretStyles)}),
      pointsToPixels,
      pixelsToPoints,
    };
    return controller;
  }

  root.HstarOpenShopTextProperties = Object.freeze({createController});
})(window);
