(function bootstrapOpenShopTextProperties(root){
  const CHARACTER_PROPERTIES = new Set([
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'fill', 'underline', 'linethrough',
  ]);
  const OBJECT_PROPERTIES = new Set(['textAlign', 'lineHeight', 'charSpacing']);
  const MIXED = '__mixed__';
  const FONT_ROW_HEIGHT = 30;
  const FONT_VIEWPORT_HEIGHT = 210;
  const FONT_OVERSCAN = 4;

  const pointsToPixels = value => Number(value) * 96 / 72;
  const pixelsToPoints = value => Number(value) * 72 / 96;
  const isTextObject = object => ['text', 'i-text', 'textbox'].includes(String(object?.type || '').toLowerCase());

  function clean(value){
    return String(value ?? '').trim();
  }

  function normalizeColor(value, fallback = '#000000'){
    const normalizer = root.HstarOpenShopColorPanel?.normalizeHex;
    if(typeof normalizer === 'function') return normalizer(value, fallback);
    const candidate = clean(value).toLowerCase();
    return /^#[0-9a-f]{6}$/.test(candidate) ? candidate : fallback;
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
    let allFontRows = [];
    let fontRows = [];
    let fontTriggers = [];
    let activeFontTrigger = null;
    let activeFontSection = 'zh';
    let fontList = null;
    let fontSpacer = null;
    let fontListSpace = null;
    let fontRowsLayer = null;
    let fontRenderFrame = null;
    let fontActiveIndex = -1;
    let fontListResizeObserver = null;

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
      if(!range) return target[property];
      if(range.start === range.end) {
        return Object.prototype.hasOwnProperty.call(state.caretStyles, property)
          ? state.caretStyles[property]
          : target[property];
      }
      if(typeof target.getSelectionStyles !== 'function') {
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

    function fontRowsForSection(rows, section){
      const sectionKey = section === 'zh' ? 'section-zh' : 'section-en';
      const start = rows.findIndex(row => row.kind === 'section' && row.key === sectionKey);
      if(start < 0) return rows.filter(row => row.kind === 'font');
      const end = rows.findIndex((row, index) => index > start && row.kind === 'section');
      return rows.slice(start, end < 0 ? rows.length : end);
    }

    function sectionForFamily(family){
      const target = clean(family).toLowerCase();
      let section = 'other';
      for(const row of allFontRows){
        if(row.kind === 'section') section = row.key === 'section-zh' ? 'zh' : 'other';
        if(row.kind === 'font' && clean(row.family).toLowerCase() === target) return section;
      }
      return 'other';
    }

    function syncFamilyControl(value){
      const mixed = value === MIXED;
      state.familyValue = mixed ? '' : clean(fontManager.resolveFamily?.(value) || value);
      const selectedSection = sectionForFamily(state.familyValue);
      fontTriggers.forEach(control => {
        const label = control.querySelector('[data-text-family-label]');
        if(!label) return;
        const selected = !mixed && Boolean(state.familyValue) && control.dataset.textFamily === selectedSection;
        control.dataset.mixed = mixed ? 'true' : 'false';
        label.textContent = mixed ? '多种字体' : (selected ? state.familyValue : '选择字体');
        control.title = label.textContent;
      });
    }

    function syncTextColorControl(value){
      const control = documentRef.querySelector('[data-text-color]');
      if(!control) return;
      const mixed = value === MIXED;
      const color = normalizeColor(mixed ? activeTextObject()?.fill : value);
      control.dataset.mixed = mixed ? 'true' : 'false';
      control.dataset.value = color;
      control.setAttribute('aria-label', mixed ? '多种文字颜色' : `文字颜色 ${color.toUpperCase()}`);
      const swatch = control.querySelector?.('[data-text-color-swatch]');
      if(swatch) swatch.style.background = mixed
        ? 'linear-gradient(135deg,#ffffff 0 25%,#777777 25% 50%,#ffffff 50% 75%,#777777 75%)'
        : color;
      const label = control.querySelector?.('[data-text-color-value]');
      if(label) label.textContent = mixed ? '多种颜色' : color.toUpperCase();
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
      syncTextColorControl(propertyValue(target, 'fill'));
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
      if(property === 'fill' && normalized !== MIXED) editor.state.textColor = normalizeColor(normalized);
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

    function cancelFontRender(){
      if(fontRenderFrame === null) return;
      root.cancelAnimationFrame?.(fontRenderFrame);
      fontRenderFrame = null;
    }

    function closeFontList({restoreFocus = false} = {}){
      cancelFontRender();
      if(fontList) fontList.hidden = true;
      fontList?.removeAttribute('aria-activedescendant');
      fontTriggers.forEach(trigger => trigger.setAttribute('aria-expanded', 'false'));
      if(fontListSpace) fontListSpace.style.height = '0px';
      resetFontListPosition();
      if(restoreFocus && !activeTextObject()?.isEditing) activeFontTrigger?.focus?.({preventScroll:true});
    }

    function fontOptionId(index){
      return `hstar-font-option-${index}`;
    }

    function findFontIndex(start, direction){
      for(let index = start; index >= 0 && index < fontRows.length; index += direction) {
        if(fontRows[index]?.kind === 'font') return index;
      }
      return -1;
    }

    function selectedFontIndex(){
      const selectedFamily = state.familyValue.toLowerCase();
      return fontRows.findIndex(row => (
        row.kind === 'font' && clean(row.family).toLowerCase() === selectedFamily
      ));
    }

    function syncActiveDescendant(){
      if(!fontList || fontActiveIndex < 0) return;
      const id = fontOptionId(fontActiveIndex);
      const option = documentRef.getElementById(id);
      if(option && fontList.contains(option)) fontList.setAttribute('aria-activedescendant', id);
      else fontList.removeAttribute('aria-activedescendant');
    }

    function createFontRow(row, index){
      if(row.kind !== 'font') {
        const heading = documentRef.createElement('div');
        heading.className = `hstar-font-heading hstar-font-${row.kind}`;
        heading.setAttribute('role', 'presentation');
        const label = documentRef.createElement('span');
        label.className = 'hstar-font-row-label';
        label.textContent = clean(row.label);
        heading.append(label);
        return heading;
      }

      const font = row.font || row;
      const family = clean(row.family || font.family);
      const option = documentRef.createElement('button');
      option.type = 'button';
      option.tabIndex = -1;
      option.id = fontOptionId(index);
      option.className = 'hstar-font-option';
      option.dataset.family = family;
      option.dataset.active = index === fontActiveIndex ? 'true' : 'false';
      option.setAttribute('role', 'option');
      option.setAttribute('aria-selected', family.toLowerCase() === state.familyValue.toLowerCase() ? 'true' : 'false');
      option.style.fontFamily = family;
      const label = documentRef.createElement('span');
      label.className = 'hstar-font-row-label';
      label.dataset.fontLabel = 'true';
      label.textContent = clean(font.label) || family;
      option.append(label);
      if(font.status === 'missing') {
        const badge = documentRef.createElement('span');
        badge.className = 'hstar-font-missing-badge';
        badge.dataset.fontMissingBadge = 'true';
        badge.textContent = '缺失字体';
        option.append(badge);
      }
      return option;
    }

    function renderFontRows(){
      if(!fontList || !fontRowsLayer) return;
      const firstVisible = Math.floor(fontList.scrollTop / FONT_ROW_HEIGHT);
      const first = Math.max(0, firstVisible - FONT_OVERSCAN);
      const visibleEnd = Math.ceil((fontList.scrollTop + FONT_VIEWPORT_HEIGHT) / FONT_ROW_HEIGHT);
      const end = Math.min(fontRows.length, visibleEnd + FONT_OVERSCAN);
      const fragment = documentRef.createDocumentFragment();
      for(let index = first; index < end; index += 1) {
        fragment.append(createFontRow(fontRows[index], index));
      }
      fontRowsLayer.style.transform = `translateY(${first * FONT_ROW_HEIGHT}px)`;
      fontRowsLayer.replaceChildren(fragment);
      syncActiveDescendant();
    }

    function scheduleFontRender(){
      if(fontRenderFrame !== null) return;
      if(typeof root.requestAnimationFrame !== 'function') {
        renderFontRows();
        return;
      }
      fontRenderFrame = root.requestAnimationFrame(() => {
        fontRenderFrame = null;
        if(!fontList?.hidden) renderFontRows();
      });
    }

    function updateFontRows(){
      allFontRows = fontManager.catalogRows?.() || [];
      fontRows = fontRowsForSection(allFontRows, activeFontSection);
      if(fontSpacer) fontSpacer.style.height = `${fontRows.length * FONT_ROW_HEIGHT}px`;
      if(fontRowsLayer) {
        fontRowsLayer.style.transform = 'translateY(0px)';
        fontRowsLayer.replaceChildren();
      }
      if(fontList) fontList.scrollTop = 0;
      fontActiveIndex = -1;
    }

    function setActiveFontSection(section, trigger){
      const nextSection = section === 'other' ? 'other' : 'zh';
      const changed = activeFontSection !== nextSection;
      activeFontSection = nextSection;
      activeFontTrigger = trigger || activeFontTrigger;
      if(changed) {
        fontRows = fontRowsForSection(allFontRows, activeFontSection);
        if(fontSpacer) fontSpacer.style.height = `${fontRows.length * FONT_ROW_HEIGHT}px`;
        if(fontRowsLayer) {
          fontRowsLayer.style.transform = 'translateY(0px)';
          fontRowsLayer.replaceChildren();
        }
        if(fontList) fontList.scrollTop = 0;
        fontActiveIndex = -1;
      }
    }

    function positionFontList(){
      if(!fontList || fontList.hidden) return;
      const otherTrigger = fontTriggers.find(trigger => trigger.dataset.textFamily === 'other') || fontTriggers[1];
      const anchor = otherTrigger?.closest('label');
      const rect = anchor?.getBoundingClientRect?.();
      if(!rect) return;
      fontList.style.position = 'fixed';
      fontList.style.top = `${rect.bottom + 4}px`;
      fontList.style.left = `${rect.left}px`;
      fontList.style.width = `${rect.width}px`;
      fontList.style.right = 'auto';
    }

    function resetFontListPosition(){
      if(!fontList) return;
      fontList.style.position = '';
      fontList.style.top = '';
      fontList.style.left = '';
      fontList.style.width = '';
      fontList.style.right = '';
    }

    function observeFontListLayout(){
      const ResizeObserverCtor = root.ResizeObserver;
      if(typeof ResizeObserverCtor !== 'function') return;
      fontListResizeObserver?.disconnect?.();
      fontListResizeObserver = new ResizeObserverCtor(() => positionFontList());
      [state.panel, state.panel?.parentElement].forEach(element => {
        if(element) fontListResizeObserver.observe(element);
      });
    }

    function setActiveFontIndex(index){
      if(!fontList || fontRows[index]?.kind !== 'font') return;
      fontActiveIndex = index;
      const rowTop = index * FONT_ROW_HEIGHT;
      const rowBottom = rowTop + FONT_ROW_HEIGHT;
      if(rowTop < fontList.scrollTop) fontList.scrollTop = rowTop;
      else if(rowBottom > fontList.scrollTop + FONT_VIEWPORT_HEIGHT) {
        fontList.scrollTop = rowBottom - FONT_VIEWPORT_HEIGHT;
      }
      cancelFontRender();
      renderFontRows();
    }

    function selectFontFamily(family, {restoreFocus = false} = {}){
      const normalizedFamily = clean(family);
      if(!normalizedFamily) return;
      closeFontList({restoreFocus});
      const style = fontManager.defaultStyleFor?.(normalizedFamily);
      if(!applyFontStyle(style)) applyProperty('fontFamily', normalizedFamily);
    }

    function openFontList(trigger, {keyboard = false, activeIndex = -1} = {}){
      if(!fontList || !trigger || !fontSpacer || !fontRowsLayer) return;
      setActiveFontSection(trigger.dataset.textFamily, trigger);
      cancelFontRender();
      fontList.hidden = false;
      fontTriggers.forEach(item => item.setAttribute('aria-expanded', item === trigger ? 'true' : 'false'));
      if(fontListSpace) fontListSpace.style.height = `${FONT_VIEWPORT_HEIGHT + 4}px`;
      positionFontList();
      const selectedIndex = selectedFontIndex();
      fontActiveIndex = fontRows[activeIndex]?.kind === 'font'
        ? activeIndex
        : (selectedIndex >= 0 ? selectedIndex : findFontIndex(0, 1));
      fontList.scrollTop = Math.max(0, fontActiveIndex) * FONT_ROW_HEIGHT;
      renderFontRows();
      if(keyboard && !activeTextObject()?.isEditing) fontList.focus?.({preventScroll:true});
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
      addDomListener(tab, 'click', activateTextTab);
      tabs.append(tab);
      const panel = documentRef.createElement('div');
      panel.className = 'panel-tab-content';
      panel.id = 'hstar-text-properties-panel';
      panel.dataset.group = 'ptg2';
      panel.innerHTML = `
        <div class="ptc-inner hstar-text-properties-inner">
          <div class="hstar-text-property-grid">
            <div class="hstar-font-selectors hstar-text-property-wide" data-text-font-selectors>
              <label>中文字体
                <button type="button" class="hstar-font-select" data-text-family="zh" aria-haspopup="listbox" aria-expanded="false">
                  <span data-text-family-label>选择字体</span><span aria-hidden="true">▾</span>
                </button>
              </label>
              <label>英文及其他语言字体
                <button type="button" class="hstar-font-select" data-text-family="other" aria-haspopup="listbox" aria-expanded="false">
                  <span data-text-family-label>选择字体</span><span aria-hidden="true">▾</span>
                </button>
              </label>
              <div class="hstar-font-list" data-text-font-list role="listbox" hidden></div>
              <div class="hstar-font-list-space" data-text-font-space aria-hidden="true"></div>
            </div>
            <label>字形 <select data-text-style></select></label>
            <label>字号 <input type="number" data-text-size min="1" max="1296" step="0.1"></label>
            <label>行距 <input type="number" data-text-line-height min="0.1" max="10" step="0.05"></label>
            <label>字距 <input type="number" data-text-tracking min="-1000" max="1000"></label>
            <label>字偶距
              <select data-text-kerning-mode><option value="auto">自动</option><option value="metrics">度量</option><option value="numeric">数值</option></select>
            </label>
            <label>数值 <input type="number" data-text-kerning min="-1000" max="1000" disabled></label>
            <label>颜色
              <button type="button" class="hstar-text-color-select" data-text-color aria-haspopup="dialog">
                <span class="hstar-text-color-swatch" data-text-color-swatch aria-hidden="true"></span>
                <span data-text-color-value>#000000</span>
              </button>
            </label>
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
      fontTriggers = [...documentRef.querySelectorAll('[data-text-family]')];
      fontList = documentRef.querySelector('[data-text-font-list]');
      fontListSpace = documentRef.querySelector('[data-text-font-space]');
      if(fontListSpace) fontListSpace.style.height = '0px';
      fontList.id = 'hstar-font-listbox';
      fontList.tabIndex = -1;
      fontTriggers.forEach(trigger => trigger.setAttribute('aria-controls', fontList.id));
      fontSpacer = documentRef.createElement('div');
      fontSpacer.className = 'hstar-font-spacer';
      fontSpacer.dataset.fontSpacer = 'true';
      fontSpacer.setAttribute('aria-hidden', 'true');
      fontRowsLayer = documentRef.createElement('div');
      fontRowsLayer.className = 'hstar-font-rows';
      fontRowsLayer.dataset.fontRows = 'true';
      fontList?.replaceChildren(fontSpacer, fontRowsLayer);
      observeFontListLayout();

      fontTriggers.forEach(trigger => {
        addDomListener(trigger, 'mousedown', event => {
          if(activeTextObject()?.isEditing) event.preventDefault();
        });
        addDomListener(trigger, 'keydown', event => {
          if(!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const isOpen = !fontList?.hidden;
          if(isOpen && activeFontTrigger === trigger) {
            let activeIndex = fontActiveIndex;
            if(event.key === 'ArrowDown') activeIndex = findFontIndex(fontActiveIndex + 1, 1);
            else if(event.key === 'ArrowUp') activeIndex = findFontIndex(fontActiveIndex - 1, -1);
            else if(event.key === 'Home') activeIndex = findFontIndex(0, 1);
            else if(event.key === 'End') activeIndex = findFontIndex(fontRows.length - 1, -1);
            if(activeIndex >= 0) setActiveFontIndex(activeIndex);
            fontList.focus?.({preventScroll:true});
            return;
          }
          setActiveFontSection(trigger.dataset.textFamily, trigger);
          const selectedIndex = selectedFontIndex();
          let activeIndex = selectedIndex;
          if(event.key === 'Home') activeIndex = findFontIndex(0, 1);
          else if(event.key === 'End') activeIndex = findFontIndex(fontRows.length - 1, -1);
          else if(activeIndex < 0) {
            activeIndex = event.key === 'ArrowUp'
              ? findFontIndex(fontRows.length - 1, -1)
              : findFontIndex(0, 1);
          }
          openFontList(trigger, {keyboard:true, activeIndex});
        });
        addDomListener(trigger, 'click', event => {
          const keyboard = event.detail === 0 && !activeTextObject()?.isEditing;
          if(fontList?.hidden || activeFontTrigger !== trigger) openFontList(trigger, {keyboard});
          else closeFontList({restoreFocus:keyboard});
        });
      });
      addDomListener(fontList, 'scroll', scheduleFontRender);
      addDomListener(state.panel, 'scroll', positionFontList);
      addDomListener(root, 'resize', positionFontList);
      addDomListener(fontList, 'keydown', event => {
        let targetIndex = -1;
        if(event.key === 'ArrowDown') targetIndex = findFontIndex(fontActiveIndex + 1, 1);
        else if(event.key === 'ArrowUp') targetIndex = findFontIndex(fontActiveIndex - 1, -1);
        else if(event.key === 'Home') targetIndex = findFontIndex(0, 1);
        else if(event.key === 'End') targetIndex = findFontIndex(fontRows.length - 1, -1);
        else if(event.key === 'Enter' || event.key === ' ') {
          const row = fontRows[fontActiveIndex];
          if(row?.kind === 'font') selectFontFamily(row.family, {restoreFocus:true});
          event.preventDefault();
          event.stopPropagation();
          return;
        } else if(event.key === 'Escape') {
          closeFontList({restoreFocus:true});
          event.preventDefault();
          event.stopPropagation();
          return;
        } else return;
        if(targetIndex >= 0) setActiveFontIndex(targetIndex);
        event.preventDefault();
        event.stopPropagation();
      });
      addDomListener(fontList, 'mousedown', event => {
        const option = event.target.closest?.('[data-family]');
        if(option && fontList.contains(option)) event.preventDefault();
      });
      addDomListener(fontList, 'click', event => {
        const option = event.target.closest?.('[data-family]');
        if(!option || !fontList.contains(option)) return;
        selectFontFamily(option.dataset.family);
      });
      addDomListener(documentRef, 'keydown', event => {
        if(event.key === 'Escape' && !fontList?.hidden) {
          closeFontList();
          event.preventDefault();
        }
      });
      addDomListener(documentRef, 'mousedown', event => {
        const insideTrigger = fontTriggers.some(trigger => trigger.contains(event.target));
        if(fontList && !fontList.contains(event.target) && !insideTrigger) {
          closeFontList();
        }
      });

      addDomListener(documentRef.querySelector('[data-text-style]'), 'change', event => {
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
      addDomListener(documentRef.querySelector('[data-text-kerning-mode]'), 'change', event => {
        const value = Number(documentRef.querySelector('[data-text-kerning]')?.value || 0);
        applyKerning(event.target.value, value);
      });
      addDomListener(documentRef.querySelector('[data-text-color]'), 'click', event => {
        const target = activeTextObject();
        const colorPanel = editor._colorPanelController;
        if(!target || !colorPanel?.open) return;
        const value = propertyValue(target, 'fill');
        const original = normalizeColor(value === MIXED ? target.fill : value);
        let draft = original;
        colorPanel.open('text', event.currentTarget, {
          color:original,
          title:'选择文字颜色',
          commitOnOutside:true,
          onPreview:color => {
            draft = normalizeColor(color, draft);
            applyProperty('fill', draft, {commit:false});
          },
          onCommit:color => {
            const committed = normalizeColor(color, draft);
            if(committed !== draft) applyProperty('fill', committed, {commit:false});
            if(committed !== original) commitChange('颜色');
          },
          onCancel:() => {
            if(draft !== original) applyProperty('fill', original, {commit:false});
          },
        });
      });
      addDomListener(documentRef.querySelector('[data-text-align]'), 'change', event => applyProperty('textAlign', event.target.value));
      ['bold', 'italic', 'underline', 'linethrough'].forEach(name => {
        addDomListener(documentRef.querySelector(`[data-text-${name}]`), 'change', event => {
          if(name === 'bold') applyProperty('fontWeight', event.target.checked ? 700 : 400);
          else if(name === 'italic') applyProperty('fontStyle', event.target.checked ? 'italic' : 'normal');
          else applyProperty(name, event.target.checked);
        });
      });
      addDomListener(documentRef.querySelector('[data-font-refresh]'), 'click', async () => {
        closeFontList();
        try {
          await fontManager.refreshSystemFonts?.();
        } catch(error) {
          if(state.destroyed) return;
          const status = documentRef.querySelector('[data-font-status]');
          if(status) status.textContent = '本机字体刷新失败';
          return;
        }
        if(state.destroyed) return;
        const refreshState = fontManager.getState?.();
        const status = documentRef.querySelector('[data-font-status]');
        if(!status) return;
        if(refreshState?.error){
          status.textContent = '本机字体刷新失败';
          return;
        }
        status.textContent = '本机字体已刷新';
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
      addDomListener(control, 'input', event => apply(event.target.value));
      addDomListener(control, 'change', event => {
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
      state.unsubscribeFonts = fontManager.subscribe?.(() => {
        closeFontList();
        updateFontRows();
        syncControls();
      });
      await fontManager.loadSystemFonts?.();
      fontManager.scanEditor?.(editor);
      syncControls();
      return controller;
    }

    function destroy(){
      if(state.destroyed) return;
      state.destroyed = true;
      closeFontList();
      fontListResizeObserver?.disconnect?.();
      fontListResizeObserver = null;
      state.listeners.splice(0).forEach(remove => remove());
      state.unsubscribeFonts?.();
      state.tab?.remove();
      state.panel?.remove();
      fontRows = [];
      allFontRows = [];
      fontTriggers = [];
      activeFontTrigger = null;
      activeFontSection = 'zh';
      fontActiveIndex = -1;
      fontList = null;
      fontSpacer = null;
      fontListSpace = null;
      fontRowsLayer = null;
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
