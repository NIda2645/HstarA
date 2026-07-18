(function bootstrapOpenShopFontCatalog(root){
  const GENERIC_FAMILIES = new Set([
    'serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui',
  ]);
  const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/u;
  const FONT_COLLATOR = new Intl.Collator('zh-CN', {numeric:true, sensitivity:'base'});
  const FALLBACK_FAMILY = '阿里巴巴普惠体 3.0';
  const SCRIPT_CATEGORY = Object.freeze({'zh-hans':'01', 'zh-hant':'02', en:'03'});
  // Below this normalized family-name score, a visually unrelated font is less safe than the fallback.
  const OCR_MATCH_THRESHOLD = 0.72;
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
  const CATALOG_GROUPS = [
    {section:'zh', key:'zh-unprefixed', label:'常用中文', test:font => font.languageGroup.startsWith('zh') && !font.freeCommercialCategory},
    {section:'zh', key:'01', label:'01免 简体中文', test:font => font.freeCommercialCategory === '01'},
    {section:'zh', key:'02', label:'02免 繁体中文', test:font => font.freeCommercialCategory === '02'},
    {section:'en', key:'03', label:'03免 英文字体', test:font => font.freeCommercialCategory === '03'},
    {section:'en', key:'en-unprefixed', label:'其他英文字体', test:font => !font.languageGroup.startsWith('zh') && !font.freeCommercialCategory},
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
    return {id:`${id || 'font'}-400-normal`, family, label:'Regular', weight:400, italic:false, localNames:[family]};
  }

  function normalizeStyle(style, family){
    const faceFamily = cleanFamily(style?.family) || family;
    const weight = Math.max(100, Math.min(900, Number.parseInt(style?.weight, 10) || 400));
    const italic = Boolean(style?.italic);
    const localNames = [...new Set(
      [faceFamily, family, ...(Array.isArray(style?.localNames) ? style.localNames : [])]
        .map(cleanFamily)
        .filter(Boolean)
    )];
    return {
      id:String(style?.id || `${family.toLowerCase().replace(/\s+/g, '-')}-${weight}-${italic ? 'italic' : 'normal'}`),
      family:faceFamily,
      label:cleanFamily(style?.label) || (italic ? 'Italic' : 'Regular'),
      weight,
      italic,
      localNames,
    };
  }

  function inferredMetadata(value){
    const family = cleanFamily(value?.family);
    const prefix = /^(0[123])免\s*/u.exec(family);
    const freeCommercialCategory = cleanFamily(value?.freeCommercialCategory) || prefix?.[1] || '';
    const sortName = cleanFamily(value?.sortName)
      || family.slice(prefix?.[0]?.length || 0).trim()
      || family;
    const supplied = cleanFamily(value?.languageGroup).toLowerCase();
    const legacy = cleanFamily(value?.language).toLowerCase();
    let languageGroup = supplied;
    if(!languageGroup){
      if(freeCommercialCategory === '01') languageGroup = 'zh-hans';
      else if(freeCommercialCategory === '02') languageGroup = 'zh-hant';
      else if(freeCommercialCategory === '03') languageGroup = 'en';
      else if(/^(?:zh-hant|zh-tw|zh-hk|zh-mo)/u.test(legacy)) languageGroup = 'zh-hant';
      else if(legacy.startsWith('zh')) languageGroup = 'zh-hans';
      else if(legacy.startsWith('en')) languageGroup = 'en';
      else languageGroup = CJK_RE.test(`${sortName} ${cleanFamily(value?.label)}`) ? 'zh-hans' : 'en';
    }
    return {languageGroup, freeCommercialCategory, sortName};
  }

  function normalizeFont(value, status = 'available'){
    const family = cleanFamily(value?.family);
    if(!family) return null;
    const styles = (Array.isArray(value?.styles) && value.styles.length ? value.styles : [defaultStyle(family)])
      .map(style => normalizeStyle(style, family));
    const deduplicated = new Map();
    styles.forEach(style => deduplicated.set(`${style.family.toLowerCase()}:${style.weight}:${style.italic}`, style));
    return {
      family,
      label:cleanFamily(value?.label) || family,
      language:cleanFamily(value?.language),
      ...inferredMetadata(value),
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
    const languageGroup = cleanFamily(font?.languageGroup).toLowerCase();
    if(languageGroup) return languageGroup.startsWith('zh');
    return cleanFamily(font?.language).toLowerCase().startsWith('zh')
      || CJK_RE.test(`${cleanFamily(font?.label)} ${cleanFamily(font?.family)}`);
  }

  function compareSubgroupFonts(left, right){
    return FONT_COLLATOR.compare(left.sortName || left.family, right.sortName || right.family)
      || FONT_COLLATOR.compare(left.family, right.family);
  }

  function compareFonts(left, right){
    const group = Number(isChineseFont(right)) - Number(isChineseFont(left));
    return group
      || FONT_COLLATOR.compare(left.label || left.family, right.label || right.family)
      || FONT_COLLATOR.compare(left.family, right.family);
  }

  function buildCatalogRows(fonts){
    const rows = [];
    for(const section of [{key:'zh', label:'中文字体'}, {key:'en', label:'英文字体'}]){
      const groups = CATALOG_GROUPS
        .filter(group => group.section === section.key)
        .map(group => ({...group, fonts:fonts.filter(group.test).sort(compareSubgroupFonts)}))
        .filter(group => group.fonts.length);
      if(!groups.length) continue;
      rows.push({kind:'section', key:`section-${section.key}`, label:section.label});
      groups.forEach(group => {
        rows.push({kind:'group', key:`group-${group.key}`, label:group.label});
        group.fonts.forEach(font => rows.push({kind:'font', key:`font:${font.family}`, family:font.family, font}));
      });
    }
    return rows;
  }

  function cloneCatalogRow(row){
    return row.kind === 'font' ? {...row, font:cloneFont(row.font)} : {...row};
  }

  function normalizedMatchName(value){
    let normalized = cleanFamily(value)
      .replace(/^(?:01|02|03)免\s*/u, '')
      .replace(/\s*\[(?:\d+|other-\d+)\]\s*$/iu, '')
      .replace(/\s*\((?:truetype|opentype)\)\s*$/iu, '')
      .trim();
    const styleSuffix = /(?:[\s._-]+)(?:\d{2,3}[\s._-]+)?(?:thin|extra\s*light|ultra\s*light|light|regular|normal|medium|semi\s*bold|demi\s*bold|bold|extra\s*bold|ultra\s*bold|black|heavy|italic|oblique)(?:[\s._-]+(?:italic|oblique))?$/iu;
    let previous = '';
    while(normalized !== previous){
      previous = normalized;
      normalized = normalized.replace(styleSuffix, '').trim();
    }
    return normalized
      .replace(/\b(?:version|ver|v)[\s._-]*(\d+)\b/giu, '$1')
      .replace(/(\d+)\.0+\b/gu, '$1')
      .replace(/[\p{P}\p{S}\s]+/gu, '')
      .toLocaleLowerCase('zh-CN');
  }

  function nameScore(candidate, font){
    const expected = normalizedMatchName(candidate);
    if(!expected) return 0;
    const aliases = new Set([
      font.family,
      font.label,
      font.sortName,
      ...font.styles.flatMap(style => [style.family, ...(style.localNames || [])]),
    ].map(normalizedMatchName).filter(Boolean));
    if(aliases.has(expected)) return 1;
    let score = 0;
    aliases.forEach(alias => {
      if(alias.includes(expected) || expected.includes(alias)){
        score = Math.max(score, Math.min(alias.length, expected.length) / Math.max(alias.length, expected.length));
      }
    });
    return score;
  }

  function descriptorScore(description, font){
    const words = cleanFamily(description).toLocaleLowerCase('en-US').match(/[\p{L}\p{N}]+/gu) || [];
    if(!words.length) return 0;
    const haystack = `${font.family} ${font.label} ${font.sortName}`.toLocaleLowerCase('en-US');
    return words.filter(word => word.length > 2 && haystack.includes(word)).length / words.length;
  }

  function nearestStyle(styles, weight, italic){
    const parsedWeight = Number(weight);
    const targetWeight = Number.isFinite(parsedWeight)
      ? Math.max(100, Math.min(900, parsedWeight))
      : 400;
    return [...styles].sort((left, right) => (
      Number(Boolean(left.italic) !== italic) * 1000 + Math.abs(left.weight - targetWeight)
      - (Number(Boolean(right.italic) !== italic) * 1000 + Math.abs(right.weight - targetWeight))
      || left.weight - right.weight
      || FONT_COLLATOR.compare(left.family, right.family)
    ))[0] || null;
  }

  function normalizedScript(value){
    const script = cleanFamily(value).toLowerCase();
    if(['zh-hans', 'zh-cn', 'zh-sg', 'zh', 'cn'].includes(script)) return 'zh-hans';
    if(['zh-hant', 'zh-tw', 'zh-hk', 'zh-mo'].includes(script)) return 'zh-hant';
    if(['en', 'english'].includes(script)) return 'en';
    return script === 'mixed' ? 'mixed' : '';
  }

  function categoryForBlock(block){
    const script = normalizedScript(block?.script);
    if(SCRIPT_CATEGORY[script]) return SCRIPT_CATEGORY[script];
    const reported = [
      block?.dominantScript,
      block?.reportedScript,
      block?.reportedDominantScript,
      block?.font?.dominantScript,
      block?.language,
    ].map(normalizedScript).find(value => SCRIPT_CATEGORY[value]);
    return SCRIPT_CATEGORY[reported] || '';
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
      catalogRows:[],
      catalogSignature:'',
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
      if(state.systemFonts.some(font => (
        font.family.toLowerCase() === normalized.toLowerCase()
        || font.styles.some(style => style.family.toLowerCase() === normalized.toLowerCase())
      ))) return true;
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
        const groupedEntry = [...merged.entries()].find(([, font]) => (
          font.family.toLowerCase() === key
          || font.styles.some(style => style.family.toLowerCase() === key)
        ));
        const mergedKey = groupedEntry?.[0] || key;
        const previous = groupedEntry?.[1] || merged.get(key);
        const font = previous || normalizeFont({family}, status);
        const replacementFamily = cleanFamily(ref?.replacementFamily);
        merged.set(mergedKey, {
          ...font,
          status,
          ...(status === 'substituted' && replacementFamily ? {replacementFamily} : {}),
        });
      });
      const fonts = [...merged.values()].sort(compareFonts);
      const signature = JSON.stringify(fonts);
      state.fonts = fonts;
      if(signature !== state.catalogSignature){
        state.catalogSignature = signature;
        state.catalogRows = buildCatalogRows(fonts);
      }
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
        const names = [font.family, font.label, font.sortName];
        font.styles.forEach(style => names.push(...style.localNames));
        return names.some(name => String(name || '').toLowerCase().includes(term));
      }).map(cloneFont);
    }

    function catalogRows(){
      return state.catalogRows.map(cloneCatalogRow);
    }

    function fontForFace(family){
      const normalized = cleanFamily(family).toLowerCase();
      return state.fonts.find(font => (
        font.family.toLowerCase() === normalized
        || font.styles.some(style => style.family.toLowerCase() === normalized)
      )) || null;
    }

    function resolveFamily(family){
      return fontForFace(family)?.family || cleanFamily(family);
    }

    function stylesFor(family){
      const normalized = resolveFamily(family).toLowerCase();
      const font = state.fonts.find(item => item.family.toLowerCase() === normalized);
      return (font?.styles || []).map(style => ({...style, localNames:[...style.localNames]}));
    }

    function defaultStyleFor(family){
      const styles = stylesFor(family);
      return styles.sort((left, right) => (
        Number(left.italic) - Number(right.italic)
        || Math.abs(left.weight - 400) - Math.abs(right.weight - 400)
        || left.weight - right.weight
      ))[0] || null;
    }

    function styleForFace(family){
      const normalized = cleanFamily(family).toLowerCase();
      const font = fontForFace(family);
      if(!font) return null;
      const exact = font.styles.find(style => style.family.toLowerCase() === normalized);
      const style = exact || (font.family.toLowerCase() === normalized ? defaultStyleFor(font.family) : null);
      return style ? {...style, localNames:[...style.localNames]} : null;
    }

    function matchOcrFont(block = {}){
      const profile = block.font && typeof block.font === 'object' ? block.font : {};
      const requestedStyle = cleanFamily(profile.style).toLowerCase();
      const italic = profile.italic === true || ['italic', 'oblique'].includes(requestedStyle);
      const fallbackFont = state.systemFonts.find(font => font.family === FALLBACK_FAMILY) || null;
      let selected = null;
      let fallback = Boolean(profile.artistic);

      if(!profile.artistic){
        const category = categoryForBlock(block);
        const pool = category
          ? state.systemFonts.filter(font => font.freeCommercialCategory === category)
          : [];
        const candidates = Array.isArray(profile.familyCandidates)
          ? profile.familyCandidates.map(cleanFamily).filter(Boolean)
          : [];
        const ranked = pool.map(font => {
          const candidateScores = candidates.map((candidate, index) => ({index, score:nameScore(candidate, font)}));
          const best = candidateScores.sort((left, right) => right.score - left.score || left.index - right.index)[0]
            || {index:Number.MAX_SAFE_INTEGER, score:0};
          return {
            font,
            nameScore:best.score,
            candidateIndex:best.index,
            descriptionScore:descriptorScore(profile.styleDescription, font),
          };
        }).sort((left, right) => (
          right.nameScore - left.nameScore
          || left.candidateIndex - right.candidateIndex
          || right.descriptionScore - left.descriptionScore
          || compareSubgroupFonts(left.font, right.font)
        ));
        if(ranked[0]?.nameScore >= OCR_MATCH_THRESHOLD) selected = ranked[0].font;
        else fallback = true;
      }

      if(!selected) selected = fallbackFont;
      if(!selected) throw new Error(`未安装必需的回退字体：${FALLBACK_FAMILY}`);
      const style = nearestStyle(selected.styles, profile.weight, italic);
      if(!style) throw new Error(`字体 ${selected.family} 没有可用字型`);
      return {
        family:selected.family,
        faceFamily:style.family,
        styleId:style.id,
        weight:style.weight,
        italic:style.italic,
        fallback,
      };
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
      catalogRows,
      matchOcrFont,
      stylesFor,
      resolveFamily,
      defaultStyleFor,
      styleForFace,
      subscribe,
      getState,
      listCommonFonts:() => COMMON_FONTS.map(item => ({...item, status:isAvailable(item.family) ? 'available' : 'missing'})),
    });
  }

  root.HstarOpenShopFontCatalog = Object.freeze({createManager});
})(window);
