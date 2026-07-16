(function bootstrapOpenShopFontCatalog(root){
  const GENERIC_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  ]);
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const FONT_COLLATOR = new Intl.Collator('zh-CN', {numeric:true, sensitivity:'base'});
  const COMMON_FONTS = [
    {family:'Microsoft YaHei UI', label:'微软雅黑 UI', language:'zh'},
    {family:'Microsoft YaHei', label:'微软雅黑', language:'zh'},
    {family:'SimSun', label:'宋体', language:'zh'},
    {family:'SimHei', label:'黑体', language:'zh'},
    {family:'KaiTi', label:'楷体', language:'zh'},
    {family:'FangSong', label:'仿宋', language:'zh'},
    {family:'Arial', label:'Arial', language:'en'},
    {family:'Georgia', label:'Georgia', language:'en'},
    {family:'Verdana', label:'Verdana', language:'en'},
    {family:'Times New Roman', label:'Times New Roman', language:'en'},
    {family:'Courier New', label:'Courier New', language:'en'},
    {family:'Consolas', label:'Consolas', language:'en'},
    {family:'Impact', label:'Impact', language:'en'},
  ];

  function cleanFamily(value){
    return String(value || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120);
  }

  function walkObjects(objects, visit){
    (Array.isArray(objects) ? objects : []).forEach(object => {
      if(!object || typeof object !== 'object') return;
      visit(object);
      const children = Array.isArray(object._objects)
        ? object._objects
        : (typeof object.getObjects === 'function' ? object.getObjects() : []);
      walkObjects(children, visit);
    });
  }

  function textObject(object){
    return ['text', 'i-text', 'textbox'].includes(String(object?.type || '').toLowerCase());
  }

  function walkTextStyles(styles, visit, seen = new Set()){
    if(!styles || typeof styles !== 'object' || seen.has(styles)) return;
    seen.add(styles);
    if(Object.prototype.hasOwnProperty.call(styles, 'fontFamily')) visit(styles);
    Object.values(styles).forEach(value => walkTextStyles(value, visit, seen));
  }

  function defaultFontProbe(documentRef, family){
    const normalized = cleanFamily(family);
    if(!normalized) return false;
    if(GENERIC_FAMILIES.has(normalized.toLowerCase())) return true;
    const canvas = documentRef?.createElement?.('canvas');
    const context = canvas?.getContext?.('2d');
    if(!context?.measureText) return false;
    const sample = 'mmmmmmmmmmlliWW中文字体@#';
    const size = '72px';
    const baselines = ['monospace', 'serif', 'sans-serif'].map(fallback => {
      context.font = `${size} ${fallback}`;
      return context.measureText(sample).width;
    });
    return baselines.some((baseline, index) => {
      const fallback = ['monospace', 'serif', 'sans-serif'][index];
      context.font = `${size} "${normalized.replaceAll('"', '')}", ${fallback}`;
      return Math.abs(context.measureText(sample).width - baseline) > 0.1;
    });
  }

  function defaultStyle(family){
    const id = cleanFamily(family).toLowerCase().replace(/\s+/g, '-');
    return {id:`${id || 'font'}-400-normal`, label:'Regular', weight:400, italic:false, localNames:[family]};
  }

  function normalizeStyle(style, family){
    const weight = Math.max(100, Math.min(900, Number.parseInt(style?.weight, 10) || 400));
    const italic = Boolean(style?.italic);
    const localNames = [...new Set(
      [family, ...(Array.isArray(style?.localNames) ? style.localNames : [])]
        .map(cleanFamily)
        .filter(Boolean)
    )];
    return {
      id:String(style?.id || `${family.toLowerCase().replace(/\s+/g, '-')}-${weight}-${italic ? 'italic' : 'normal'}`),
      label:cleanFamily(style?.label) || (italic ? 'Italic' : 'Regular'),
      weight,
      italic,
      localNames,
    };
  }

  function normalizeFont(value, status = 'available'){
    const family = cleanFamily(value?.family);
    if(!family) return null;
    const styles = (Array.isArray(value?.styles) && value.styles.length ? value.styles : [defaultStyle(family)])
      .map(style => normalizeStyle(style, family));
    const deduplicated = new Map();
    styles.forEach(style => deduplicated.set(`${style.weight}:${style.italic}`, style));
    return {
      family,
      label:cleanFamily(value?.label) || family,
      language:cleanFamily(value?.language),
      status,
      styles:[...deduplicated.values()].sort((left, right) => left.weight - right.weight || Number(left.italic) - Number(right.italic)),
    };
  }

  function cloneFont(font){
    return {
      ...font,
      styles:(font.styles || []).map(style => ({...style, localNames:[...(style.localNames || [])]})),
    };
  }

  function isChineseFont(font){
    return cleanFamily(font?.language).toLowerCase().startsWith('zh')
      || CJK_RE.test(`${cleanFamily(font?.label)} ${cleanFamily(font?.family)}`);
  }

  function compareFonts(left, right){
    const group = Number(isChineseFont(right)) - Number(isChineseFont(left));
    return group
      || FONT_COLLATOR.compare(left.label || left.family, right.label || right.family)
      || FONT_COLLATOR.compare(left.family, right.family);
  }

  function createManager(options = {}){
    const documentRef = options.documentRef || root.document;
    const fontProbe = typeof options.fontProbe === 'function'
      ? options.fontProbe
      : family => defaultFontProbe(documentRef, family);
    const fetchImpl = typeof options.fetchImpl === 'function'
      ? options.fetchImpl
      : (...args) => {
        if(typeof root.fetch !== 'function') throw new Error('本机字体目录接口不可用');
        return root.fetch(...args);
      };
    const state = {
      fonts:[],
      systemFonts:[],
      projectRefs:[],
      loaded:false,
      loading:false,
      error:'',
      platform:'',
      cached:false,
      listeners:new Set(),
    };
    let loadingPromise = null;

    function probeAvailable(family){
      try { return Boolean(fontProbe(family)); } catch(error) { return false; }
    }

    function isAvailable(family){
      const normalized = cleanFamily(family);
      if(!normalized) return false;
      if(GENERIC_FAMILIES.has(normalized.toLowerCase())) return true;
      if(state.systemFonts.some(font => font.family.toLowerCase() === normalized.toLowerCase())) return true;
      return probeAvailable(normalized);
    }

    function rebuildFonts(){
      const merged = new Map();
      COMMON_FONTS.forEach(value => {
        const font = normalizeFont(value, isAvailable(value.family) ? 'available' : 'missing');
        merged.set(font.family.toLowerCase(), font);
      });
      state.systemFonts.forEach(value => {
        const font = normalizeFont(value, 'available');
        if(!font) return;
        const previous = merged.get(font.family.toLowerCase());
        merged.set(font.family.toLowerCase(), {
          ...previous,
          ...font,
          language:font.language || previous?.language || '',
        });
      });
      state.projectRefs.forEach(ref => {
        const family = cleanFamily(ref?.family);
        if(!family) return;
        const key = family.toLowerCase();
        const requestedStatus = String(ref?.status || '').toLowerCase();
        const status = requestedStatus === 'substituted'
          ? 'substituted'
          : (isAvailable(family) ? 'available' : 'missing');
        const previous = merged.get(key);
        const font = previous || normalizeFont({family}, status);
        const replacementFamily = cleanFamily(ref?.replacementFamily);
        merged.set(key, {
          ...font,
          status,
          ...(status === 'substituted' && replacementFamily ? {replacementFamily} : {}),
        });
      });
      state.fonts = [...merged.values()].sort(compareFonts);
    }

    function getState(){
      return {
        fonts:state.fonts.map(cloneFont),
        loaded:state.loaded,
        loading:state.loading,
        error:state.error,
        platform:state.platform,
        cached:state.cached,
      };
    }

    function notify(){
      const snapshot = getState();
      state.listeners.forEach(listener => listener(snapshot));
    }

    function subscribe(listener){
      if(typeof listener !== 'function') return () => {};
      state.listeners.add(listener);
      listener(getState());
      return () => state.listeners.delete(listener);
    }

    function loadSystemFonts({refresh = false} = {}){
      if(state.loading && loadingPromise) return loadingPromise;
      if(state.loaded && !refresh) return Promise.resolve(state.systemFonts.map(cloneFont));
      state.loading = true;
      state.error = '';
      notify();
      loadingPromise = (async () => {
        try {
          const url = `/api/openshop/fonts${refresh ? '?refresh=1' : ''}`;
          const response = await fetchImpl(url, {cache:'no-store'});
          if(!response?.ok) throw new Error(`字体目录加载失败 (${response?.status || 0})`);
          const payload = await response.json();
          state.systemFonts = (Array.isArray(payload?.fonts) ? payload.fonts : [])
            .map(value => normalizeFont(value, 'available'))
            .filter(Boolean);
          state.platform = cleanFamily(payload?.platform);
          state.cached = Boolean(payload?.cached);
          state.loaded = true;
          rebuildFonts();
          return state.systemFonts.map(cloneFont);
        } catch(error) {
          state.error = error instanceof Error ? error.message : String(error);
          state.loaded = true;
          rebuildFonts();
          return [];
        } finally {
          state.loading = false;
          loadingPromise = null;
          notify();
        }
      })();
      return loadingPromise;
    }

    function refreshSystemFonts(){
      return loadSystemFonts({refresh:true});
    }

    function searchFonts(query = ''){
      const term = cleanFamily(query).toLowerCase();
      return state.fonts.filter(font => {
        if(!term) return true;
        const names = [font.family, font.label];
        font.styles.forEach(style => names.push(...style.localNames));
        return names.some(name => String(name || '').toLowerCase().includes(term));
      }).map(cloneFont);
    }

    function stylesFor(family){
      const normalized = cleanFamily(family).toLowerCase();
      const font = state.fonts.find(item => item.family.toLowerCase() === normalized);
      return (font?.styles || []).map(style => ({...style, localNames:[...style.localNames]}));
    }

    function addRef(target, seen, value){
      const family = cleanFamily(value?.family);
      if(!family) return;
      const key = family.toLowerCase();
      if(seen.has(key)) return;
      seen.add(key);
      const requestedStatus = String(value?.status || '').toLowerCase();
      const status = requestedStatus === 'substituted'
        ? 'substituted'
        : (isAvailable(family) ? 'available' : 'missing');
      const item = {family, status};
      const replacementFamily = cleanFamily(value?.replacementFamily);
      if(status === 'substituted' && replacementFamily) item.replacementFamily = replacementFamily;
      target.push(item);
    }

    function scanEditor(editor){
      const refs = [];
      const seen = new Set();
      walkObjects(editor?.canvas?.getObjects?.() || [], object => {
        if(!textObject(object)) return;
        addRef(refs, seen, {family:object.fontFamily});
        walkTextStyles(object.styles, style => addRef(refs, seen, {family:style.fontFamily}));
      });
      (Array.isArray(editor?.__hstarFontRefs) ? editor.__hstarFontRefs : []).forEach(ref => {
        addRef(refs, seen, ref);
      });
      if(editor && typeof editor === 'object') editor.__hstarFontRefs = refs;
      state.projectRefs = refs.map(ref => ({...ref}));
      rebuildFonts();
      notify();
      return refs;
    }

    function replaceFont(editor, fromFamily, toFamily){
      const from = cleanFamily(fromFamily);
      const target = cleanFamily(toFamily);
      if(!from || !target) throw new Error('字体名称无效');
      if(!isAvailable(target)) throw new Error('替代字体不可用');
      let changed = 0;
      walkObjects(editor?.canvas?.getObjects?.() || [], object => {
        if(!textObject(object)) return;
        let objectChanged = false;
        let stylesChanged = false;
        if(cleanFamily(object.fontFamily).toLowerCase() === from.toLowerCase()){
          if(typeof object.set === 'function') object.set({fontFamily:target});
          else object.fontFamily = target;
          objectChanged = true;
        }
        walkTextStyles(object.styles, style => {
          if(cleanFamily(style.fontFamily).toLowerCase() !== from.toLowerCase()) return;
          style.fontFamily = target;
          objectChanged = true;
          stylesChanged = true;
        });
        if(!objectChanged) return;
        if(stylesChanged){
          object.dirty = true;
          object.initDimensions?.();
          object.setCoords?.();
        }
        changed += 1;
      });
      if(!changed) return 0;
      const previous = Array.isArray(editor.__hstarFontRefs) ? editor.__hstarFontRefs : [];
      editor.__hstarFontRefs = previous.map(ref => (
        cleanFamily(ref?.family).toLowerCase() === from.toLowerCase()
          ? {family:from, status:'substituted', replacementFamily:target}
          : ref
      ));
      scanEditor(editor);
      editor.canvas?.renderAll?.();
      editor.updateLayersPanel?.();
      editor.saveHistory?.('替换缺失字体');
      root.dispatchEvent?.(new CustomEvent('openshop:project-dirty', {detail:{action:'Replace missing font'}}));
      return changed;
    }

    return Object.freeze({
      isAvailable,
      scanEditor,
      replaceFont,
      loadSystemFonts,
      refreshSystemFonts,
      searchFonts,
      stylesFor,
      subscribe,
      getState,
      listCommonFonts:() => COMMON_FONTS.map(item => ({...item, status:isAvailable(item.family) ? 'available' : 'missing'})),
    });
  }

  root.HstarOpenShopFontCatalog = Object.freeze({createManager});
})(window);
