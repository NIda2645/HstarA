import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const catalogPath = resolve(testDir, '..', 'host', 'openshop-font-catalog.js');

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
