import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(testDir, '..', 'host', 'openshop-font-catalog.js');
const fallbackFamily = '阿里巴巴普惠体 3.0';
const englishFallbackFamily = '03免 阿里妈妈灵动体VF';
const englishVariableFallbackFamily = englishFallbackFamily;

function fallbackFont(styles = [
  {id:'alibaba-regular', family:fallbackFamily, label:'Regular', weight:400, italic:false},
]){
  return {
    family:fallbackFamily,
    label:fallbackFamily,
    language:'zh',
    languageGroup:'zh-hans',
    freeCommercialCategory:'',
    sortName:fallbackFamily,
    styles,
  };
}

function englishFallbackFont(styles = [
  {id:'lingdong-regular', family:englishFallbackFamily, label:'Regular', weight:400, italic:false},
]){
  return {
    family:englishFallbackFamily,
    label:englishFallbackFamily,
    language:'en',
    languageGroup:'en',
    freeCommercialCategory:'03',
    sortName:englishFallbackFamily,
    styles,
  };
}

async function loadCatalog(fonts, options = {}){
  const fetchImpl = vi.fn(async () => ({
    ok:true,
    json:async () => ({platform:'windows', fonts}),
  }));
  const manager = window.HstarOpenShopFontCatalog.createManager({
    fontProbe:options.fontProbe || (() => true),
    fetchImpl,
  });
  const loaded = await manager.loadSystemFonts();
  return {manager, loaded, fetchImpl};
}

describe('Hstar OpenShop font catalog', () => {
  beforeEach(async () => {
    expect(existsSync(catalogPath), `${catalogPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopFontCatalog;
    await import(`${pathToFileURL(catalogPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('detects and deduplicates Chinese, English and missing project fonts', () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fontProbe:family => !family.includes('Missing'),
    });
    const nested = {type:'i-text', fontFamily:'Arial', text:'English'};
    const editor = {
      __hstarFontRefs:[{family:'Missing Poster Font', status:'missing'}],
      canvas:{
        getObjects:() => [
          {type:'i-text', fontFamily:'Microsoft YaHei UI', text:'中文'},
          {type:'group', _objects:[nested]},
          {type:'i-text', fontFamily:'Microsoft YaHei UI', text:'重复'},
        ],
      },
    };

    expect(manager.scanEditor(editor)).toEqual([
      {family:'Microsoft YaHei UI', status:'available'},
      {family:'Arial', status:'available'},
      {family:'Missing Poster Font', status:'missing'},
    ]);
    expect(editor.__hstarFontRefs).toEqual([
      {family:'Microsoft YaHei UI', status:'available'},
      {family:'Arial', status:'available'},
      {family:'Missing Poster Font', status:'missing'},
    ]);
  });

  it('keeps missing fonts unchanged until the user explicitly replaces them', () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fontProbe:family => !family.includes('Missing'),
    });
    const missingText = {type:'i-text', fontFamily:'Missing Poster Font', text:'海报标题', set:vi.fn(function set(values){ Object.assign(this, values); })};
    const otherText = {type:'i-text', fontFamily:'Arial', text:'Keep me'};
    const editor = {
      __hstarFontRefs:[{family:'Missing Poster Font', status:'missing'}],
      canvas:{getObjects:() => [missingText, otherText], renderAll:vi.fn()},
      updateLayersPanel:vi.fn(),
      saveHistory:vi.fn(),
    };

    manager.scanEditor(editor);
    expect(missingText.fontFamily).toBe('Missing Poster Font');
    expect(() => manager.replaceFont(editor, 'Missing Poster Font', 'Another Missing Font')).toThrow('替代字体不可用');

    const changed = manager.replaceFont(editor, 'Missing Poster Font', 'Microsoft YaHei UI');

    expect(changed).toBe(1);
    expect(missingText.fontFamily).toBe('Microsoft YaHei UI');
    expect(otherText.fontFamily).toBe('Arial');
    expect(editor.__hstarFontRefs).toEqual([
      {family:'Microsoft YaHei UI', status:'available'},
      {family:'Arial', status:'available'},
      {family:'Missing Poster Font', status:'substituted', replacementFamily:'Microsoft YaHei UI'},
    ]);
    expect(editor.canvas.renderAll).toHaveBeenCalledTimes(1);
    expect(editor.saveHistory).toHaveBeenCalledWith('替换缺失字体');
  });

  it('collects fonts used by per-character text styles', () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({fontProbe:() => true});
    const editor = {
      canvas:{
        getObjects:() => [{
          type:'i-text',
          fontFamily:'Microsoft YaHei UI',
          text:'中文 English',
          styles:{
            0:{
              0:{fontFamily:'Century Gothic'},
              1:{fontFamily:'Century Gothic'},
              3:{fontFamily:'Arial'},
            },
          },
        }],
      },
    };

    expect(manager.scanEditor(editor)).toEqual([
      {family:'Microsoft YaHei UI', status:'available'},
      {family:'Century Gothic', status:'available'},
      {family:'Arial', status:'available'},
    ]);
  });

  it('collects fonts from editable vertical text objects', () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({fontProbe:() => true});
    const editor = {
      canvas:{getObjects:() => [{
        type:'hstar-vertical-text', fontFamily:'Microsoft YaHei UI', text:'甲乙\n丙丁',
      }]},
    };

    expect(manager.scanEditor(editor)).toEqual([
      {family:'Microsoft YaHei UI', status:'available'},
    ]);
  });

  it('replaces a missing font inside per-character text styles', () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fontProbe:family => !family.includes('Missing'),
    });
    const text = {
      type:'i-text',
      fontFamily:'Arial',
      text:'海报 Title',
      styles:{0:{0:{fontFamily:'Missing Poster Font'}, 1:{fontFamily:'Arial'}}},
      set:vi.fn(function set(values){ Object.assign(this, values); }),
      initDimensions:vi.fn(),
      setCoords:vi.fn(),
    };
    const editor = {
      canvas:{getObjects:() => [text], renderAll:vi.fn()},
      updateLayersPanel:vi.fn(),
      saveHistory:vi.fn(),
    };

    manager.scanEditor(editor);
    const changed = manager.replaceFont(editor, 'Missing Poster Font', 'Microsoft YaHei UI');

    expect(changed).toBe(1);
    expect(text.fontFamily).toBe('Arial');
    expect(text.styles[0][0].fontFamily).toBe('Microsoft YaHei UI');
    expect(text.initDimensions).toHaveBeenCalledTimes(1);
    expect(text.setCoords).toHaveBeenCalledTimes(1);
    expect(editor.__hstarFontRefs).toContainEqual({
      family:'Missing Poster Font',
      status:'substituted',
      replacementFamily:'Microsoft YaHei UI',
    });
  });

  it('exposes a restrained common font catalog for mixed-language editing', () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({fontProbe:() => true});
    const families = manager.listCommonFonts().map(item => item.family);

    expect(families).toContain('Microsoft YaHei UI');
    expect(families).toContain('SimSun');
    expect(families).toContain('Arial');
    expect(families).toContain('Georgia');
    expect(new Set(families).size).toBe(families.length);
  });

  it('loads, searches and refreshes installed font families', async () => {
    const fetchImpl = vi.fn(async url => ({
      ok:true,
      json:async () => ({
        platform:'windows',
        cached:!String(url).includes('refresh=1'),
        fonts:[
          {
            family:'Microsoft YaHei UI',
            label:'微软雅黑 UI',
            styles:[
              {id:'yahei-400-normal', label:'常规', weight:400, italic:false, localNames:['Microsoft YaHei UI', '微软雅黑 UI']},
              {id:'yahei-700-normal', label:'粗体', weight:700, italic:false, localNames:['Microsoft YaHei UI', '微软雅黑 UI']},
            ],
          },
          {
            family:'Century Gothic',
            label:'Century Gothic',
            styles:[
              {id:'century-400-normal', label:'Regular', weight:400, italic:false, localNames:['Century Gothic']},
            ],
          },
        ],
      }),
    }));
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fetchImpl,
      fontProbe:() => true,
    });

    const loaded = await manager.loadSystemFonts();

    expect(loaded.map(item => item.family)).toContain('Century Gothic');
    expect(manager.searchFonts('century').map(item => item.family)).toEqual(['Century Gothic']);
    expect(manager.searchFonts('微软雅黑').map(item => item.family)).toContain('Microsoft YaHei UI');
    expect(manager.stylesFor('Microsoft YaHei UI')).toEqual([
      expect.objectContaining({weight:400, italic:false}),
      expect.objectContaining({weight:700, italic:false}),
    ]);
    expect(manager.getState()).toMatchObject({loaded:true, loading:false, error:'', platform:'windows'});

    await manager.loadSystemFonts();
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    await manager.refreshSystemFonts();
    expect(fetchImpl).toHaveBeenLastCalledWith('/api/openshop/fonts?refresh=1', {cache:'no-store'});
  });

  it('resolves real installed faces through a grouped family and default style', async () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fontProbe:() => true,
      fetchImpl:async () => ({
        ok:true,
        json:async () => ({fonts:[{
          family:'DengXian',
          label:'等线',
          language:'zh',
          styles:[
            {id:'dengxian-light', family:'DengXian Light', label:'Light', weight:300, italic:false, localNames:['等线 Light']},
            {id:'dengxian-regular', family:'DengXian', label:'Regular', weight:400, italic:false, localNames:['等线']},
          ],
        }]}),
      }),
    });

    await manager.loadSystemFonts();

    expect(manager.searchFonts('')).toEqual(expect.arrayContaining([
      expect.objectContaining({family:'DengXian', styles:expect.any(Array)}),
    ]));
    expect(manager.resolveFamily('DengXian Light')).toBe('DengXian');
    expect(manager.defaultStyleFor('DengXian')).toMatchObject({
      id:'dengxian-regular', family:'DengXian', weight:400, italic:false,
    });
    expect(manager.styleForFace('DengXian Light')).toMatchObject({
      id:'dengxian-light', family:'DengXian Light', weight:300,
    });

    manager.scanEditor({
      canvas:{getObjects:() => [{type:'i-text', fontFamily:'DengXian Light', text:'已用字型'}]},
    });
    expect(manager.searchFonts('').filter(font => font.family.startsWith('DengXian'))).toEqual([
      expect.objectContaining({family:'DengXian', styles:expect.any(Array)}),
    ]);
  });

  it('resolves an installed registry face through its local-name alias', async () => {
    const family = '\u963f\u91cc\u5df4\u5df4\u666e\u60e0\u4f53 3.0';
    const registryFace = '\u963f\u91cc\u5df4\u5df4\u666e\u60e0\u4f53 3 85 Bold';
    const style = {
      id:'alibaba-puhuiti-3.0-700-normal',
      family:'Alibaba PuHuiTi 3.0',
      label:'85 Bold',
      weight:700,
      italic:false,
      localNames:['Alibaba PuHuiTi 3.0', registryFace, 'AlibabaPuHuiTi_3_85_Bold'],
    };
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fontProbe:() => false,
      fetchImpl:async () => ({
        ok:true,
        json:async () => ({fonts:[{family, label:family, languageGroup:'zh-hans', styles:[style]}]}),
      }),
    });
    await manager.loadSystemFonts();

    expect(manager.resolveFamily(registryFace)).toBe(family);
    expect(manager.styleForFace(registryFace)).toMatchObject({
      id:style.id,
      family:style.family,
      label:'85 Bold',
      weight:700,
    });

    const editor = {
      canvas:{getObjects:() => [{type:'i-text', fontFamily:registryFace, text:'85 Bold'}]},
    };
    expect(manager.scanEditor(editor)).toEqual([{family:registryFace, status:'available'}]);
    expect(manager.searchFonts('').filter(font => font.family === registryFace)).toEqual([]);
  });

  it('preserves every registry alias when duplicate face records share one style', async () => {
    const family = '\u963f\u91cc\u5df4\u5df4\u666e\u60e0\u4f53 3.0';
    const regularAlias = '\u963f\u91cc\u5df4\u5df4\u666e\u60e0\u4f53 3.0 55 Regular';
    const {manager} = await loadCatalog([{
      family,
      label:family,
      languageGroup:'zh-hans',
      styles:[
        {
          id:'alibaba-puhuiti-3.0-400-normal',
          family:'Alibaba PuHuiTi 3.0',
          label:'55 Regular',
          weight:400,
          italic:false,
          localNames:['Alibaba PuHuiTi 3.0', regularAlias],
        },
        {
          id:'alibaba-puhuiti-3.0-400-normal',
          family:'Alibaba PuHuiTi 3.0',
          label:'55 Regular L3',
          weight:400,
          italic:false,
          localNames:['Alibaba PuHuiTi 3.0', 'AlibabaPuHuiTi_3_55_Regular_L3'],
        },
      ],
    }], {fontProbe:() => false});

    expect(manager.resolveFamily(regularAlias)).toBe(family);
    expect(manager.styleForFace(regularAlias)).toMatchObject({
      id:'alibaba-puhuiti-3.0-400-normal',
      label:'55 Regular',
      weight:400,
    });
    expect(manager.stylesFor(family)).toHaveLength(1);
  });

  it('sorts Chinese fonts before every non-Chinese family', async () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fontProbe:() => true,
      fetchImpl:async () => ({
        ok:true,
        json:async () => ({
          fonts:[
            {family:'04b', label:'04b'},
            {family:'Arial', label:'Arial'},
            {family:'Alibaba PuHuiTi', label:'阿里巴巴普惠体', language:'zh'},
            {family:'FZHei', label:'方正黑体'},
          ],
        }),
      }),
    });

    await manager.loadSystemFonts();
    const fonts = manager.searchFonts('');
    const isChinese = font => (
      String(font.language || '').toLowerCase().startsWith('zh')
      || /[\u3400-\u9fff]/u.test(`${font.family} ${font.label}`)
    );
    const groups = fonts.map(font => isChinese(font));
    const firstOther = groups.indexOf(false);

    expect(firstOther).toBeGreaterThan(0);
    expect(groups.slice(0, firstOther).every(Boolean)).toBe(true);
    expect(groups.slice(firstOther).some(Boolean)).toBe(false);
  });

  it('preserves legacy Chinese-first label and family ordering in state and search results', async () => {
    const fixtures = [
      {family:'Zh Order Fixture A', label:'Alpha Label', languageGroup:'zh-hans', sortName:'Zulu Sort'},
      {family:'Zh Order Fixture B', label:'Beta Label', languageGroup:'zh-hans', sortName:'Able Sort'},
      {family:'Zh Order Fixture C', label:'Alpha Label', languageGroup:'zh-hans', sortName:'Middle Sort'},
      {family:'En Order Fixture A', label:'Alpha Label', languageGroup:'en', sortName:'Zulu Sort'},
      {family:'En Order Fixture B', label:'Beta Label', languageGroup:'en', sortName:'Able Sort'},
      {family:'En Order Fixture C', label:'Alpha Label', languageGroup:'en', sortName:'Middle Sort'},
    ];
    const {manager} = await loadCatalog(fixtures);
    const expected = [
      'Zh Order Fixture A',
      'Zh Order Fixture C',
      'Zh Order Fixture B',
      'En Order Fixture A',
      'En Order Fixture C',
      'En Order Fixture B',
    ];

    expect(manager.getState().fonts.filter(font => font.family.includes('Order Fixture')).map(font => font.family)).toEqual(expected);
    expect(manager.searchFonts('Order Fixture').map(font => font.family)).toEqual(expected);
  });

  it('orders section and group headings while preserving server metadata and family prefixes', async () => {
    const {manager, loaded} = await loadCatalog([
      {family:'03免English Free', label:'03免English Free', language:'en', languageGroup:'en', freeCommercialCategory:'03', sortName:'English Free'},
      {family:'Zulu Sans', label:'Zulu Sans', language:'en', languageGroup:'en', freeCommercialCategory:'', sortName:'Zulu Sans'},
      {family:'02免繁體', label:'02免繁體', language:'zh', languageGroup:'zh-hant', freeCommercialCategory:'02', sortName:'繁體'},
      {family:'01免简体', label:'01免简体', language:'zh', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'简体'},
      {family:'思源黑体', label:'思源黑体', language:'zh', languageGroup:'zh-hans', freeCommercialCategory:'', sortName:'思源黑体'},
    ]);

    const rows = manager.catalogRows();
    expect(rows.filter(row => row.kind !== 'font').map(row => row.key)).toEqual([
      'section-zh',
      'group-zh-unprefixed',
      'group-01',
      'group-02',
      'section-en',
      'group-03',
      'group-en-unprefixed',
    ]);

    const rowIndex = family => rows.findIndex(row => row.kind === 'font' && row.family === family);
    const fixturePositions = [
      rowIndex('思源黑体'),
      rowIndex('01免简体'),
      rowIndex('02免繁體'),
      rowIndex('03免English Free'),
      rowIndex('Zulu Sans'),
    ];
    expect(fixturePositions.every(index => index >= 0)).toBe(true);
    expect(fixturePositions).toEqual([...fixturePositions].sort((left, right) => left - right));

    expect(loaded.find(font => font.family === '01免简体')).toMatchObject({
      language:'zh',
      languageGroup:'zh-hans',
      freeCommercialCategory:'01',
      sortName:'简体',
    });
    const prefixedRow = rows.find(row => row.family === '01免简体');
    expect(prefixedRow).toMatchObject({family:'01免简体', font:{family:'01免简体'}});
    prefixedRow.font.sortName = 'mutated';
    expect(manager.catalogRows().find(row => row.family === '01免简体').font.sortName).toBe('简体');
  });

  it('infers a project-only 03免 font as English instead of treating 免 as Chinese', async () => {
    const {manager} = await loadCatalog([], {fontProbe:() => false});
    manager.scanEditor({
      __hstarFontRefs:[{family:'03免English Project', status:'missing'}],
      canvas:{getObjects:() => []},
    });

    const rows = manager.catalogRows();
    const projectIndex = rows.findIndex(row => row.family === '03免English Project');
    const group03Index = rows.findIndex(row => row.key === 'group-03');
    const englishOtherIndex = rows.findIndex(row => row.key === 'group-en-unprefixed');

    expect(projectIndex).toBeGreaterThan(group03Index);
    expect(projectIndex).toBeLessThan(englishOtherIndex);
    expect(rows[projectIndex].font).toMatchObject({
      family:'03免English Project',
      languageGroup:'en',
      freeCommercialCategory:'03',
      sortName:'English Project',
      status:'missing',
    });
  });

  it('uses numeric-aware sortName ordering within a subgroup', async () => {
    const {manager} = await loadCatalog([
      {family:'01免Poster 10', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Poster 10'},
      {family:'01免Poster 2', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Poster 2'},
      {family:'01免Poster 1', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Poster 1'},
    ]);

    const rows = manager.catalogRows();
    const groupIndex = rows.findIndex(row => row.key === 'group-01');
    const nextHeadingIndex = rows.findIndex((row, index) => index > groupIndex && row.kind !== 'font');
    const subgroupFamilies = rows
      .slice(groupIndex + 1, nextHeadingIndex)
      .filter(row => row.kind === 'font')
      .map(row => row.family);

    expect(subgroupFamilies).toEqual(['01免Poster 1', '01免Poster 2', '01免Poster 10']);
  });

  it('keeps missing and substituted project refs visible but excludes them from matching', async () => {
    const {manager} = await loadCatalog([fallbackFont()], {fontProbe:() => false});
    manager.scanEditor({
      __hstarFontRefs:[
        {family:'01免Missing Project', status:'missing'},
        {family:'03免Substituted Project', status:'substituted', replacementFamily:'Arial'},
      ],
      canvas:{getObjects:() => []},
    });

    expect(manager.searchFonts('Project')).toEqual(expect.arrayContaining([
      expect.objectContaining({family:'01免Missing Project', status:'missing'}),
      expect.objectContaining({family:'03免Substituted Project', status:'substituted', replacementFamily:'Arial'}),
    ]));
    expect(manager.catalogRows().find(row => row.family === '01免Missing Project')?.font.status).toBe('missing');
    expect(manager.catalogRows().find(row => row.family === '03免Substituted Project')?.font.status).toBe('substituted');
    expect(manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['Missing Project']}})).toMatchObject({
      family:fallbackFamily,
      fallback:true,
    });
    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Substituted Project']}})).toMatchObject({
      family:'system-ui',
      fallback:true,
    });
  });

  it('keeps zh-hans, zh-hant, en, and mixed OCR matching inside the reported category', async () => {
    const {manager} = await loadCatalog([
      {family:'01免Poster Sans', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Poster Sans'},
      {family:'02免Poster Sans', languageGroup:'zh-hant', freeCommercialCategory:'02', sortName:'Poster Sans'},
      {family:'03免Poster Sans', languageGroup:'en', freeCommercialCategory:'03', sortName:'Poster Sans'},
      {family:'Commercial Poster', languageGroup:'en', freeCommercialCategory:'', sortName:'Commercial Poster'},
      fallbackFont(),
    ]);

    expect(manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['Poster Sans']}})).toMatchObject({family:'01免Poster Sans', fallback:false});
    expect(manager.matchOcrFont({script:'zh-hant', font:{familyCandidates:['Poster Sans']}})).toMatchObject({family:'02免Poster Sans', fallback:false});
    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Poster Sans']}})).toMatchObject({family:'03免Poster Sans', fallback:false});
    expect(manager.matchOcrFont({script:'mixed', dominantScript:'zh-hant', font:{familyCandidates:['Poster Sans']}})).toMatchObject({family:'02免Poster Sans', fallback:false});
    expect(manager.matchOcrFont({script:'mixed', font:{familyCandidates:['Commercial Poster']}})).toMatchObject({family:fallbackFamily, fallback:true});
  });

  it('matches OCR runs by script and uses distinct Chinese and English fallbacks', async () => {
    const {manager} = await loadCatalog([
      {
        family:'01免海报体',
        languageGroup:'zh-hans',
        freeCommercialCategory:'01',
        sortName:'海报体',
        styles:[{id:'poster-bold', family:'01免海报体 Bold', label:'Bold', weight:700, italic:false}],
      },
      {
        family:'03免Poster',
        languageGroup:'en',
        freeCommercialCategory:'03',
        sortName:'Poster',
        styles:[{id:'poster-light', family:'03免Poster Light', label:'Light', weight:300, italic:false}],
      },
      fallbackFont([
        {id:'alibaba-light', family:'阿里巴巴普惠体 3.0 Light', label:'Light', weight:300, italic:false},
        {id:'alibaba-bold', family:'阿里巴巴普惠体 3.0 Bold', label:'Bold', weight:700, italic:false},
      ]),
      englishFallbackFont([
        {id:'lingdong-regular', family:englishFallbackFamily, label:'Regular', weight:400, italic:false},
        {id:'lingdong-bold', family:englishFallbackFamily, label:'Bold', weight:700, italic:false},
      ]),
    ]);

    expect(manager.matchOcrRun({
      script:'zh-hans', familyCandidates:['海报体'], weight:680,
    })).toMatchObject({family:'01免海报体', faceFamily:'01免海报体 Bold', weight:700, fallback:false});
    expect(manager.matchOcrRun({
      script:'zh-hans', familyCandidates:['Missing'], weight:260,
    })).toMatchObject({family:fallbackFamily, faceFamily:'阿里巴巴普惠体 3.0 Light', weight:300, fallback:true});
    expect(manager.matchOcrRun({
      script:'zh-hant', familyCandidates:['Missing'], weight:680,
    })).toMatchObject({family:fallbackFamily, faceFamily:'阿里巴巴普惠体 3.0 Bold', weight:700, fallback:true});
    expect(manager.matchOcrRun({
      script:'en', familyCandidates:['Missing'], weight:680,
    })).toMatchObject({family:englishFallbackFamily, faceFamily:englishFallbackFamily, weight:700, fallback:true});
  });

  it('resolves preferred Chinese and English default faces when installed', async () => {
    const {manager} = await loadCatalog([
      fallbackFont(),
      englishFallbackFont(),
    ]);

    expect(manager.resolveDefaultFace('zh-hans')).toMatchObject({
      family:fallbackFamily,
      faceFamily:fallbackFamily,
      weight:400,
      italic:false,
    });
    expect(manager.resolveDefaultFace('en')).toMatchObject({
      family:englishFallbackFamily,
      faceFamily:englishFallbackFamily,
      weight:400,
      italic:false,
    });
  });

  it('resolves installed script-suitable faces before the generic fallback', async () => {
    const {manager} = await loadCatalog([
      {family:'Microsoft YaHei UI', languageGroup:'zh-hans', sortName:'Microsoft YaHei UI'},
      {family:'Arial', languageGroup:'en', sortName:'Arial'},
    ]);

    expect(manager.resolveDefaultFace('zh-hans', {weight:700})).toMatchObject({
      family:'Microsoft YaHei UI',
      faceFamily:'Microsoft YaHei UI',
      weight:400,
    });
    expect(manager.resolveDefaultFace('en', {italic:true})).toMatchObject({
      family:'Arial',
      faceFamily:'Arial',
      italic:false,
    });
  });

  it('returns system-ui when no installed face can satisfy the script', async () => {
    const {manager} = await loadCatalog([]);

    expect(manager.resolveDefaultFace('zh-hans', {weight:650, italic:true})).toEqual({
      family:'system-ui',
      faceFamily:'system-ui',
      styleId:'generic-system-ui',
      weight:650,
      italic:true,
      fallback:true,
    });
    expect(manager.matchOcrRun({
      script:'en', familyCandidates:['Missing'], weight:550, style:'italic',
    })).toMatchObject({
      family:'system-ui',
      faceFamily:'system-ui',
      weight:550,
      italic:true,
      fallback:true,
    });
  });

  it('builds mixed-script default runs and assigns neutral text to the nearest script', async () => {
    const {manager} = await loadCatalog([
      fallbackFont(),
      englishFallbackFont(),
    ]);

    expect(manager.defaultTextRuns('夏日，Open 2026！中文')).toEqual([
      expect.objectContaining({start:0, end:3, script:'zh-hans', faceFamily:fallbackFamily}),
      expect.objectContaining({start:3, end:13, script:'en', faceFamily:englishFallbackFamily}),
      expect.objectContaining({start:13, end:15, script:'zh-hans', faceFamily:fallbackFamily}),
    ]);
    expect(manager.defaultTextRuns(' - ').map(run => run.script)).toEqual(['zh-hans']);
    expect(manager.defaultTextRuns('中   A').map(run => ({start:run.start, end:run.end, script:run.script}))).toEqual([
      {start:0, end:3, script:'zh-hans'},
      {start:3, end:5, script:'en'},
    ]);
  });

  it('prefers italic first and the lower real face when weight distances tie', async () => {
    const {manager} = await loadCatalog([
      fallbackFont([
        {id:'alibaba-medium', family:'阿里巴巴普惠体 3.0 Medium', label:'Medium', weight:500, italic:false},
        {id:'alibaba-bold', family:'阿里巴巴普惠体 3.0 Bold', label:'Bold', weight:700, italic:false},
        {id:'alibaba-bold-italic', family:'阿里巴巴普惠体 3.0 Bold Italic', label:'Bold Italic', weight:700, italic:true},
      ]),
      englishFallbackFont(),
    ]);

    expect(manager.matchOcrRun({
      script:'zh-hans', familyCandidates:['Missing'], weight:600, style:'normal',
    })).toMatchObject({faceFamily:'阿里巴巴普惠体 3.0 Medium', weight:500, italic:false});
    expect(manager.matchOcrRun({
      script:'zh-hans', familyCandidates:['Missing'], weight:600, style:'italic',
    })).toMatchObject({faceFamily:'阿里巴巴普惠体 3.0 Bold Italic', weight:700, italic:true});
  });

  it('accepts the installed variable-font family as the English OCR fallback', async () => {
    const {manager} = await loadCatalog([{
      family:englishVariableFallbackFamily,
      label:englishVariableFallbackFamily,
      language:'en',
      languageGroup:'en',
      freeCommercialCategory:'03',
      sortName:englishVariableFallbackFamily,
      styles:[{
        id:'lingdong-vf',
        family:englishVariableFallbackFamily,
        label:'Variable',
        weight:400,
        italic:false,
        localNames:[englishVariableFallbackFamily],
      }],
    }]);

    expect(manager.matchOcrRun({
      script:'en', familyCandidates:['Unknown English Font'], weight:400, style:'normal',
    })).toEqual({
      family:englishVariableFallbackFamily,
      faceFamily:englishVariableFallbackFamily,
      styleId:'lingdong-vf',
      weight:400,
      italic:false,
      fallback:true,
    });
  });

  it('normalizes OCR aliases and selects the nearest real light, bold, or italic face', async () => {
    const {manager} = await loadCatalog([
      {
        family:'01免Poster Sans 3.0',
        label:'01免Poster Sans 3.0',
        languageGroup:'zh-hans',
        freeCommercialCategory:'01',
        sortName:'Poster Sans 3.0',
        styles:[
          {id:'poster-light', family:'01免Poster Sans 3.0 Light [123]', label:'Light', weight:300, italic:false},
          {id:'poster-regular', family:'01免Poster Sans 3.0 Regular', label:'Regular', weight:400, italic:false},
          {id:'poster-italic', family:'01免Poster Sans 3.0 Italic', label:'Italic', weight:400, italic:true},
          {id:'poster-bold', family:'01免Poster Sans 3.0 Bold', label:'Bold', weight:700, italic:false},
        ],
      },
      fallbackFont(),
    ]);

    expect(manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['Poster Sans v3 Light'], weight:260, style:'normal'}})).toMatchObject({
      family:'01免Poster Sans 3.0', faceFamily:'01免Poster Sans 3.0 Light [123]', styleId:'poster-light', weight:300, italic:false,
    });
    expect(manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['01免 Poster-Sans 3 Bold [other-12]'], weight:650, style:'normal'}})).toMatchObject({
      family:'01免Poster Sans 3.0', faceFamily:'01免Poster Sans 3.0 Bold', styleId:'poster-bold', weight:700, italic:false,
    });
    expect(manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['Poster_Sans version 3 Oblique'], weight:760, style:'italic'}})).toMatchObject({
      family:'01免Poster Sans 3.0', faceFamily:'01免Poster Sans 3.0 Italic', styleId:'poster-italic', weight:400, italic:true,
    });
  });

  it('uses OCR family candidate order before the style description signal', async () => {
    const {manager} = await loadCatalog([
      {family:'03免Alpha Sans', languageGroup:'en', freeCommercialCategory:'03', sortName:'Alpha Sans'},
      {family:'03免Beta Sans', languageGroup:'en', freeCommercialCategory:'03', sortName:'Beta Sans'},
      fallbackFont(),
    ]);

    expect(manager.matchOcrFont({
      script:'en',
      font:{familyCandidates:['Beta Sans', 'Alpha Sans'], styleDescription:'Alpha Sans letterforms'},
    })).toMatchObject({family:'03免Beta Sans', fallback:false});
  });

  it('prefers the raw exact A-B alias over a lossy AB collision', async () => {
    const {manager} = await loadCatalog([
      {family:'03免AB', languageGroup:'en', freeCommercialCategory:'03', sortName:'A First'},
      {family:'03免A-B', languageGroup:'en', freeCommercialCategory:'03', sortName:'Z Last'},
      fallbackFont(),
    ]);

    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['A-B']}})).toMatchObject({
      family:'03免A-B',
      fallback:false,
    });
  });

  it('prefers the raw exact AB alias over a lossy A-B collision', async () => {
    const {manager} = await loadCatalog([
      {family:'03免A-B', languageGroup:'en', freeCommercialCategory:'03', sortName:'A First'},
      {family:'03免AB', languageGroup:'en', freeCommercialCategory:'03', sortName:'Z Last'},
      fallbackFont(),
    ]);

    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['AB']}})).toMatchObject({
      family:'03免AB',
      fallback:false,
    });
  });

  it('invalidates installed alias pools when the system catalog refreshes', async () => {
    const catalogs = [
      [
        {family:'03免Refresh A', languageGroup:'en', freeCommercialCategory:'03', sortName:'Refresh A'},
        fallbackFont(),
      ],
      [
        {family:'03免Refresh B', languageGroup:'en', freeCommercialCategory:'03', sortName:'Refresh B'},
        fallbackFont(),
      ],
    ];
    const fetchImpl = vi.fn(async () => ({
      ok:true,
      json:async () => ({fonts:catalogs.shift()}),
    }));
    const manager = window.HstarOpenShopFontCatalog.createManager({fetchImpl, fontProbe:() => true});

    await manager.loadSystemFonts();
    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Refresh A']}}).family).toBe('03免Refresh A');

    await manager.refreshSystemFonts();
    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Refresh B']}}).family).toBe('03免Refresh B');
    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Refresh A']}})).toMatchObject({
      family:'03免Refresh B',
      fallback:true,
    });
  });

  it('matches repeatedly against a 2,500-font installed catalog within a practical bound', async () => {
    const fonts = Array.from({length:2498}, (_, index) => ({
      family:`03免Scale Font ${index}`,
      languageGroup:'en',
      freeCommercialCategory:'03',
      sortName:`Scale Font ${index}`,
    }));
    fonts.push(
      {family:'03免Needle-Font', languageGroup:'en', freeCommercialCategory:'03', sortName:'Needle-Font'},
      fallbackFont(),
    );
    const {manager} = await loadCatalog(fonts);
    const block = {script:'en', font:{familyCandidates:['Needle-Font'], weight:400}};

    const startedAt = performance.now();
    for(let index = 0; index < 100; index += 1){
      expect(manager.matchOcrFont(block).family).toBe('03免Needle-Font');
    }
    expect(performance.now() - startedAt).toBeLessThan(5000);
  }, 15000);

  it('routes artistic OCR directly to the exact installed Alibaba 3.0 nearest face', async () => {
    const {manager} = await loadCatalog([
      {family:'01免Poster Sans', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Poster Sans'},
      fallbackFont([
        {id:'alibaba-light', family:'阿里巴巴普惠体 3.0 45 Light', label:'Light', weight:300, italic:false},
        {id:'alibaba-italic', family:'阿里巴巴普惠体 3.0 55 Italic', label:'Italic', weight:400, italic:true},
        {id:'alibaba-heavy', family:'阿里巴巴普惠体 3.0 85 Heavy', label:'Heavy', weight:850, italic:false},
      ]),
    ]);

    expect(manager.matchOcrFont({
      script:'zh-hans',
      font:{artistic:true, familyCandidates:['Poster Sans'], weight:820, style:'italic'},
    })).toEqual({
      family:fallbackFamily,
      faceFamily:'阿里巴巴普惠体 3.0 55 Italic',
      styleId:'alibaba-italic',
      weight:400,
      italic:true,
      fallback:true,
    });
  });

  it('falls back to Alibaba 3.0 and its nearest real face for a weak or unknown match', async () => {
    const {manager} = await loadCatalog([
      {family:'01免Unrelated Serif', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Unrelated Serif'},
      fallbackFont([
        {id:'alibaba-light', family:'阿里巴巴普惠体 3.0 Light', label:'Light', weight:300, italic:false},
        {id:'alibaba-heavy', family:'阿里巴巴普惠体 3.0 Heavy', label:'Heavy', weight:850, italic:false},
      ]),
    ]);

    expect(manager.matchOcrFont({
      script:'zh-hans',
      font:{familyCandidates:['Totally Unknown', 'Unrelated'], styleDescription:'serif', weight:820},
    })).toEqual({
      family:fallbackFamily,
      faceFamily:'阿里巴巴普惠体 3.0 Heavy',
      styleId:'alibaba-heavy',
      weight:850,
      italic:false,
      fallback:true,
    });
  });

  it('uses an installed same-script family when the exact Alibaba 3.0 family is not installed', async () => {
    const {manager} = await loadCatalog([
      {family:'01免Unrelated Serif', languageGroup:'zh-hans', freeCommercialCategory:'01', sortName:'Unrelated Serif'},
    ], {fontProbe:() => true});

    expect(manager.matchOcrFont({script:'zh-hans', font:{familyCandidates:['Unknown Sans']}})).toMatchObject({
      family:'01免Unrelated Serif',
      faceFamily:'01免Unrelated Serif',
      fallback:true,
    });
  });

  it('never treats project refs or common-font probes as installed automatic candidates', async () => {
    const {manager} = await loadCatalog([fallbackFont()], {fontProbe:() => true});
    manager.scanEditor({
      __hstarFontRefs:[{family:'03免Project Probe Sans', status:'available'}],
      canvas:{getObjects:() => []},
    });

    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Project Probe Sans']}})).toMatchObject({
      family:'system-ui',
      fallback:true,
    });
    expect(manager.matchOcrFont({script:'en', font:{familyCandidates:['Arial']}})).toMatchObject({
      family:'system-ui',
      fallback:true,
    });

    const {manager:probeOnlyManager} = await loadCatalog([], {fontProbe:() => true});
    probeOnlyManager.scanEditor({
      __hstarFontRefs:[
        {family:'03免Project Probe Sans', status:'available'},
        {family:fallbackFamily, status:'available'},
      ],
      canvas:{getObjects:() => []},
    });
    expect(probeOnlyManager.matchOcrFont({script:'en', font:{familyCandidates:['Project Probe Sans']}}))
      .toMatchObject({family:'system-ui', faceFamily:'system-ui', fallback:true});
  });

  it('notifies subscribers when loading starts and finishes', async () => {
    let resolveRequest;
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fetchImpl:() => new Promise(resolve => { resolveRequest = resolve; }),
      fontProbe:() => true,
    });
    const states = [];
    const unsubscribe = manager.subscribe(state => states.push(state));

    const loading = manager.loadSystemFonts();
    expect(states.at(-1)).toMatchObject({loading:true, loaded:false});

    resolveRequest({ok:true, json:async () => ({platform:'windows', fonts:[]})});
    await loading;
    expect(states.at(-1)).toMatchObject({loading:false, loaded:true, platform:'windows'});

    unsubscribe();
  });

  it('keeps the previous system font catalog and exposes the error when refresh fails', async () => {
    const family = 'Refresh Fixture Sans';
    const fetchImpl = vi.fn(async url => {
      if(String(url).includes('refresh=1')) throw new Error('refresh offline');
      return {
        ok:true,
        json:async () => ({
          platform:'windows',
          fonts:[{family, label:family}],
        }),
      };
    });
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fetchImpl,
      fontProbe:() => false,
    });

    await manager.loadSystemFonts();
    const previousRows = manager.catalogRows();

    await expect(manager.refreshSystemFonts()).resolves.toEqual([]);

    expect(manager.catalogRows()).toEqual(previousRows);
    expect(manager.getState()).toMatchObject({
      loaded:true,
      loading:false,
      error:'refresh offline',
      platform:'windows',
    });
    expect(manager.getState().fonts).toContainEqual(expect.objectContaining({family, status:'available'}));
  });

  it('keeps common and project fonts usable when the system endpoint fails', async () => {
    const manager = window.HstarOpenShopFontCatalog.createManager({
      fetchImpl:async () => { throw new Error('offline'); },
      fontProbe:family => !family.includes('Missing'),
    });
    const editor = {
      __hstarFontRefs:[{family:'Missing Poster Font', status:'missing'}],
      canvas:{getObjects:() => []},
    };
    manager.scanEditor(editor);

    await expect(manager.loadSystemFonts()).resolves.toEqual([]);

    expect(manager.searchFonts('Arial')[0]).toMatchObject({family:'Arial'});
    expect(manager.searchFonts('Missing Poster')).toEqual([
      expect.objectContaining({family:'Missing Poster Font', status:'missing'}),
    ]);
    expect(manager.getState().error).toContain('offline');
  });
});
