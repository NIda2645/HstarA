(function bootstrapOpenShopFontCatalog(root){
  const GENERIC_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  ]);
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

  function createManager(options = {}){
    const documentRef = options.documentRef || root.document;
    const fontProbe = typeof options.fontProbe === 'function'
      ? options.fontProbe
      : family => defaultFontProbe(documentRef, family);

    function isAvailable(family){
      const normalized = cleanFamily(family);
      if(!normalized) return false;
      if(GENERIC_FAMILIES.has(normalized.toLowerCase())) return true;
      try { return Boolean(fontProbe(normalized)); } catch(error) { return false; }
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
        if(textObject(object)) addRef(refs, seen, {family:object.fontFamily});
      });
      (Array.isArray(editor?.__hstarFontRefs) ? editor.__hstarFontRefs : []).forEach(ref => {
        addRef(refs, seen, ref);
      });
      if(editor && typeof editor === 'object') editor.__hstarFontRefs = refs;
      return refs;
    }

    function replaceFont(editor, fromFamily, toFamily){
      const from = cleanFamily(fromFamily);
      const target = cleanFamily(toFamily);
      if(!from || !target) throw new Error('字体名称无效');
      if(!isAvailable(target)) throw new Error('替代字体不可用');
      let changed = 0;
      walkObjects(editor?.canvas?.getObjects?.() || [], object => {
        if(!textObject(object) || cleanFamily(object.fontFamily).toLowerCase() !== from.toLowerCase()) return;
        if(typeof object.set === 'function') object.set({fontFamily:target});
        else object.fontFamily = target;
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
      listCommonFonts:() => COMMON_FONTS.map(item => ({...item, status:isAvailable(item.family) ? 'available' : 'missing'})),
    });
  }

  root.HstarOpenShopFontCatalog = Object.freeze({createManager});
})(window);
