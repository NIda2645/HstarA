import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createCanvasMock,
  installFabricMock,
  installModalDelegation,
  loadOpenShop,
  mountEditorDom,
  mountOpenShopToolbar,
  quietUiMethods
} from './os-harness.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const snapEnginePath = resolve(testDir, '..', 'host', 'openshop-snap-engine.js');
const OCR_CUSTOM_PROPERTIES = [
  'hstarOcrSourceAssetId',
  'hstarOcrSourceLayerId',
  'hstarOcrBlockId',
  'hstarOcrQuad',
  'hstarOcrVisualProfile',
  'hstarOcrOriginalText',
  'hstarArtFontRequestGeneration',
  'hstarOcrConfidence',
  'hstarOcrLanguage',
  'hstarOcrFontCandidates',
];
const ART_GENERATION = {
  taskId:'task-art-1', textLayerId:'text-layer-1', requestGeneration:1,
  outputAssetId:'c'.repeat(64), toolId:'art-font-restore',
  contentBox:{x:10,y:5,width:340,height:110},
};

function mountToolbarFromSource() {
  const source = new DOMParser().parseFromString(
    readFileSync(resolve(testDir, '..', 'index.html'), 'utf8'),
    'text/html',
  );
  const toolbar = document.importNode(source.getElementById('toolbar'), true);
  document.getElementById('toolbar').replaceWith(toolbar);
  return toolbar;
}

describe('OpenShop core object', () => {
  beforeEach(() => {
    localStorage.clear();
    delete window.HstarOpenShopTextPropertiesController;
    installFabricMock();
    installModalDelegation();
    mountEditorDom();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('omits legacy AI commands from the top menu bar', () => {
    const source = new DOMParser().parseFromString(
      readFileSync(resolve(testDir, '..', 'index.html'), 'utf8'),
      'text/html',
    );
    const topbar = source.getElementById('topbar');
    const topLevelLabels = [...topbar.querySelectorAll(':scope > .menu-item')]
      .map(item => item.childNodes[0]?.textContent?.trim())
      .filter(Boolean);

    expect(topLevelLabels).not.toContain('AI');
    expect(topbar.querySelector('[onclick*="OS.ai"]')).toBeNull();
    expect(topbar.querySelector('[onclick*="OS.activateSegmentSelect"]')).toBeNull();
  });

  it('switches tools and updates canvas interaction state', () => {
    const OS = loadOpenShop();
    const object = { name: 'Layer Object', selectable: false, evented: false };
    const lockedObject = { name: 'Locked Base', selectable: false, evented: false };
    OS.canvas = createCanvasMock([object, lockedObject]);
    OS.layers = [
      {name:'Layer 0', locked:false, objects:[object]},
      {name:'Locked source', locked:true, objects:[lockedObject]},
    ];
    quietUiMethods(OS);
    OS._rasterTools = {end:vi.fn()};

    OS.setTool('brush');

    expect(OS.state.tool).toBe('brush');
    expect(OS.canvas.isDrawingMode).toBe(false);
    expect(document.querySelector('[data-tool="brush"]').classList.contains('active')).toBe(true);
    expect(document.getElementById('opt-brush').style.display).toBe('flex');

    OS.setTool('select');

    expect(OS.canvas.selection).toBe(true);
    expect(OS.canvas.defaultCursor).toBe('default');
    expect(object.selectable).toBe(true);
    expect(object.evented).toBe(true);
    expect(lockedObject.selectable).toBe(false);
    expect(lockedObject.evented).toBe(false);

    OS.setTool('ai-segment');

    expect(OS.state.tool).toBe('ai-segment');
    expect(OS.canvas.defaultCursor).toBe('crosshair');
    expect(document.querySelector('[data-tool="ai-segment"]').classList.contains('active')).toBe(true);
    expect(document.getElementById('opt-ai-segment').style.display).toBe('flex');
  });

  it('positions tool flyouts inside the viewport gutter near the bottom-right corner', () => {
    const OS = loadOpenShop();
    const face = document.createElement('button');
    const flyout = document.createElement('div');
    document.body.append(face, flyout);
    vi.stubGlobal('innerWidth', 180);
    vi.stubGlobal('innerHeight', 100);
    vi.spyOn(face, 'getBoundingClientRect').mockReturnValue({
      left:140, top:80, right:176, bottom:116, width:36, height:36,
    });
    Object.defineProperties(flyout, {
      offsetWidth:{value:160, configurable:true},
      offsetHeight:{value:72, configurable:true},
    });

    OS._positionToolFlyout(face, flyout);

    expect(flyout.classList.contains('show')).toBe(true);
    expect(Number.parseFloat(flyout.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(flyout.style.left)).toBeLessThanOrEqual(12);
    expect(Number.parseFloat(flyout.style.top)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(flyout.style.top)).toBeLessThanOrEqual(20);
  });

  it('opens the text flyout by keyboard and manages its menu focus', () => {
    mountToolbarFromSource();
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.layers = [{name:'Layer 0', locked:false, objects:[]}];
    quietUiMethods(OS);
    OS.initToolGroups();

    const group = document.querySelector('.tool-group[data-group="text"]');
    const face = group.querySelector(':scope > .tool-btn');
    const flyout = [...document.querySelectorAll('#flyout-host > .tool-flyout')]
      .find(candidate => candidate._parentGroup === group);
    const rows = [...flyout.querySelectorAll(':scope > .tool-btn')];

    expect(face.getAttribute('aria-haspopup')).toBe('menu');
    expect(face.getAttribute('aria-expanded')).toBe('false');
    expect(flyout.getAttribute('role')).toBe('menu');
    expect(rows.map(row => row.getAttribute('role'))).toEqual(['menuitem', 'menuitem']);
    expect(rows.map(row => row.getAttribute('tabindex'))).toEqual(['-1', '-1']);

    const toolbarFaces = [...document.querySelectorAll('#toolbar > .tool-btn, #toolbar > .tool-group > .tool-btn')];
    face.focus();
    face.click();
    expect(flyout.classList.contains('show')).toBe(true);
    expect(document.activeElement).toBe(face);
    toolbarFaces[toolbarFaces.indexOf(face) + 1].focus();
    expect(flyout.classList.contains('show')).toBe(false);
    expect(face.getAttribute('aria-expanded')).toBe('false');

    face.focus();
    face.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
    expect(flyout.classList.contains('show')).toBe(true);
    expect(face.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(rows[0]);

    rows[0].dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
    expect(document.activeElement).toBe(rows[1]);
    rows[1].dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true}));
    expect(document.activeElement).toBe(rows[0]);
    rows[0].dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    expect(flyout.classList.contains('show')).toBe(false);
    expect(face.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(face);

    face.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
    rows[0].dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', bubbles:true}));
    expect(flyout.classList.contains('show')).toBe(false);
    expect(face.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(toolbarFaces[toolbarFaces.indexOf(face) + 1]);

    face.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
    rows[0].dispatchEvent(new KeyboardEvent('keydown', {key:'Tab', shiftKey:true, bubbles:true}));
    expect(flyout.classList.contains('show')).toBe(false);
    expect(document.activeElement).toBe(face);

    face.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true}));
    rows[0].dispatchEvent(new FocusEvent('focusout', {bubbles:true, relatedTarget:face}));
    expect(flyout.classList.contains('show')).toBe(true);
    const external = document.createElement('button');
    document.body.appendChild(external);
    rows[0].dispatchEvent(new FocusEvent('focusout', {bubbles:true, relatedTarget:external}));
    expect(flyout.classList.contains('show')).toBe(false);
    expect(face.getAttribute('aria-expanded')).toBe('false');

    face.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true}));
    OS.flyoutSelect(rows[1], 'text');
    expect(flyout.classList.contains('show')).toBe(false);
    expect(face.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(face);
  });

  it('renders exactly the two localized text modes with icons and T hints', () => {
    mountOpenShopToolbar();
    const group = document.querySelector('.tool-group[data-group="text"]');

    expect(group).not.toBeNull();
    if (!group) return;
    const face = group.querySelector(':scope > .tool-btn');
    const rows = [...group.querySelectorAll(':scope > .tool-flyout > [data-tool]')];
    expect(rows.map(row => row.dataset.tool)).toEqual(['text-horizontal', 'text-vertical']);
    expect(rows).toHaveLength(2);
    expect(group.querySelector('[data-tool*="mask"]')).toBeNull();
    expect(rows.map(row => row.querySelector('.tool-flyout-label')?.textContent.trim())).toEqual([
      '横排文字工具',
      '直排文字工具',
    ]);
    expect(rows.map(row => row.querySelector('.tool-flyout-shortcut')?.textContent.trim())).toEqual(['T', 'T']);
    expect(rows.every(row => row.querySelector('svg'))).toBe(true);
    expect(face.dataset.tool).toBe('text-horizontal');
    expect(face.querySelector('svg')).not.toBeNull();
    expect(face.querySelector('.tool-flyout-label')).toBeNull();
  });

  it('keeps the text flyout in its portal, viewport-safe, and closes it on outside click', () => {
    mountOpenShopToolbar();
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.layers = [{name:'Layer 0', locked:false, objects:[]}];
    quietUiMethods(OS);
    OS.setLocale('zh-CN');
    OS.initToolGroups();

    const group = document.querySelector('.tool-group[data-group="text"]');
    expect(group).not.toBeNull();
    if (!group) return;
    const face = group.querySelector(':scope > .tool-btn');
    const flyout = [...document.querySelectorAll('#flyout-host > .tool-flyout')]
      .find(candidate => candidate._parentGroup === group);
    vi.stubGlobal('innerWidth', 180);
    vi.stubGlobal('innerHeight', 100);
    vi.spyOn(face, 'getBoundingClientRect').mockReturnValue({
      left:140, top:80, right:176, bottom:116, width:36, height:36,
    });
    Object.defineProperties(flyout, {
      offsetWidth:{value:160, configurable:true},
      offsetHeight:{value:72, configurable:true},
    });

    face.click();

    expect(flyout.classList.contains('show')).toBe(true);
    expect(flyout.parentElement.id).toBe('flyout-host');
    expect(Number.parseFloat(flyout.style.left)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(flyout.style.left)).toBeLessThanOrEqual(12);
    expect(Number.parseFloat(flyout.style.top)).toBeGreaterThanOrEqual(8);
    expect(Number.parseFloat(flyout.style.top)).toBeLessThanOrEqual(20);

    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
    expect(flyout.classList.contains('show')).toBe(false);

    const vertical = flyout.querySelector('[data-tool="text-vertical"]');
    OS.flyoutSelect(vertical, 'text');

    expect(OS.state.textWritingMode).toBe('vertical');
    expect(OS.state.tool).toBe('text-vertical');
    expect(vertical.classList.contains('active')).toBe(true);
    expect(face.classList.contains('active')).toBe(true);
    expect(face.dataset.tool).toBe('text-vertical');
    expect(face.dataset.tip).toBe('直排文字工具');
    expect(face.getAttribute('aria-label')).toBe('直排文字工具（T）');
    expect(face.querySelector('svg')?.innerHTML).toBe(vertical.querySelector('svg')?.innerHTML);
    expect(face.querySelector('.tool-flyout-label')).toBeNull();
    expect(face.textContent.trim()).toBe('');
  });

  it('maps legacy text to horizontal and gives both modes the text interaction profile', () => {
    mountOpenShopToolbar();
    const OS = loadOpenShop();
    const text = {type:'i-text', selectable:false, evented:false};
    const image = {type:'image', selectable:true, evented:true};
    OS.canvas = createCanvasMock([text, image]);
    OS.layers = [{name:'Layer 0', locked:false, objects:[text, image]}];
    quietUiMethods(OS);

    expect(OS.state.textWritingMode).toBe('horizontal');
    OS.setTool('text');

    expect(OS.state.tool).toBe('text-horizontal');
    expect(OS.state.textWritingMode).toBe('horizontal');
    expect(OS._toolInteractionProfile('text-horizontal')).toBe('text');
    expect(OS.canvas.defaultCursor).toBe('text');
    expect(OS.canvas.hoverCursor).toBe('text');
    expect(document.getElementById('opt-text').style.display).toBe('flex');
    expect(text).toMatchObject({selectable:true, evented:true});
    expect(image).toMatchObject({selectable:false, evented:false});

    OS.setTool('text-vertical');

    expect(OS.state.tool).toBe('text-vertical');
    expect(OS.state.textWritingMode).toBe('vertical');
    expect(OS._toolInteractionProfile('text-vertical')).toBe('text');
    expect(OS.canvas.defaultCursor).toBe('text');
    expect(OS.canvas.hoverCursor).toBe('text');
    expect(document.getElementById('opt-text').style.display).toBe('flex');
  });

  it('creates horizontal and vertical text as one separate layer per object', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(event => ({x:event.x, y:event.y}));
    OS.layers = [{name:'Background', locked:false, visible:true, objects:[]}];
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();

    OS.setTool('text-horizontal');
    OS.onMouseDown({e:{x:10, y:20}});
    OS.canvas.discardActiveObject();
    OS.setTool('text-vertical');
    OS.onMouseDown({e:{x:30, y:40}});

    expect(OS.canvas.getObjects().map(object => object.type)).toEqual(['i-text', 'hstar-vertical-text']);
    expect(OS.layers).toHaveLength(3);
    expect(OS.layers.slice(1).map(layer => layer.objects)).toEqual([
      [OS.canvas.getObjects()[0]], [OS.canvas.getObjects()[1]],
    ]);
    expect(OS.canvas.getObjects()[0].hstarWritingMode).toBe('horizontal');
    expect(OS.canvas.getObjects()[1].hstarWritingMode).toBe('vertical');
    expect(OS.canvas.getObjects()[0].hstarAutomaticFontPolicy).toBe('script-default');
    expect(OS.canvas.getObjects()[1].hstarAutomaticFontPolicy).toBe('script-default');
    expect(OS.saveHistory).toHaveBeenCalledTimes(2);
  });

  it('preserves an explicitly selected creation font without automatic replacement', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(event => ({x:event.x, y:event.y}));
    OS.layers = [{name:'Background', locked:false, visible:true, objects:[]}];
    quietUiMethods(OS);
    OS.state.textFont = 'Century Gothic';
    OS.state.textFontAutomatic = false;

    OS.setTool('text-horizontal');
    OS.onMouseDown({e:{x:10, y:20}});

    expect(OS.canvas.getObjects()[0]).toMatchObject({
      fontFamily:'Century Gothic',
      hstarWritingMode:'horizontal',
    });
    expect(OS.canvas.getObjects()[0].hstarAutomaticFontPolicy).toBeUndefined();
  });

  it('edits an existing vertical text object without creating another layer', () => {
    const OS = loadOpenShop();
    const vertical = {
      type:'hstar-vertical-text', text:'Existing', editable:true, isEditing:false,
      enterEditing:vi.fn(function enterEditing() { this.isEditing = true; }),
    };
    OS.canvas = createCanvasMock([vertical]);
    OS.canvas.getPointer = vi.fn(() => ({x:10, y:20}));
    OS.layers = [{name:'Existing', locked:false, visible:true, objects:[vertical]}];
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();
    OS.setTool('text-vertical');

    OS.onMouseDown({e:{x:10, y:20}, target:vertical});

    expect(vertical.enterEditing).toHaveBeenCalledOnce();
    expect(OS.canvas.add).not.toHaveBeenCalled();
    expect(OS.layers).toHaveLength(1);
    expect(OS.saveHistory).not.toHaveBeenCalled();
  });

  it('syncs the selected text writing mode and flyout face without leaving select', () => {
    mountOpenShopToolbar();
    const OS = loadOpenShop();
    const vertical = {type:'hstar-vertical-text', text:'Vertical', hstarWritingMode:'vertical'};
    OS.canvas = createCanvasMock([vertical]);
    OS.layers = [{name:'Vertical', locked:false, visible:true, objects:[vertical]}];
    quietUiMethods(OS);
    OS.setTool('select');

    OS._syncTextWritingModeFromSelection({selected:[vertical]});

    const face = document.querySelector('.tool-group[data-group="text"] > .tool-btn');
    expect(OS.state.tool).toBe('select');
    expect(OS.state.textWritingMode).toBe('vertical');
    expect(face.dataset.tool).toBe('text-vertical');
  });

  it('converts selected text once while preserving metadata, layer, stack, and editing intent', () => {
    const OS = loadOpenShop();
    const lower = {type:'rect', name:'Lower'};
    const source = new fabric.IText('Title', {
      left:12, top:24, fontFamily:'Noto Sans', fontSize:36, fill:'#123456',
      fontWeight:700, fontStyle:'italic', hstarOcrBlockId:'ocr-1', hstarLayerId:'text-1',
      hstarData:{source:'ocr'}, visible:false, selectable:true, evented:true,
    });
    source.isEditing = true;
    const upper = {type:'rect', name:'Upper'};
    OS.canvas = createCanvasMock([lower, source, upper]);
    OS.layers = [
      {name:'Lower', locked:false, visible:true, objects:[lower]},
      {name:'Title', locked:false, visible:false, objects:[source]},
      {name:'Upper', locked:false, visible:true, objects:[upper]},
    ];
    OS.activeLayerIdx = 1;
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();
    OS.canvas.setActiveObject(source);

    const converted = OS.setTextWritingMode('vertical');

    expect(converted).toMatchObject({
      type:'hstar-vertical-text', text:'Title', hstarWritingMode:'vertical',
      hstarOcrBlockId:'ocr-1', hstarLayerId:'text-1', hstarData:{source:'ocr'},
      visible:false, fontFamily:'Noto Sans', fontSize:36, fill:'#123456',
    });
    expect(OS.canvas.getObjects()).toEqual([lower, converted, upper]);
    expect(OS.layers[1].objects).toEqual([converted]);
    expect(OS.canvas.getActiveObject()).toBe(converted);
    expect(converted.isEditing).toBe(true);
    expect(OS.saveHistory).toHaveBeenCalledOnce();
    expect(OS._fabricCustomProperties).toContain('hstarWritingMode');
    expect(OS._fabricCustomProperties).toContain('hstarAutomaticFontPolicy');
    expect(converted.toObject(OS._fabricCustomProperties).hstarWritingMode).toBe('vertical');
  });

  it('provides exact Simplified Chinese text and artistic-font labels', () => {
    const OS = loadOpenShop();
    window.HstarOpenShopI18n.setLocale('zh-CN');

    expect(OS._t('Horizontal Type Tool')).toBe('横排文字工具');
    expect(OS._t('Vertical Type Tool')).toBe('直排文字工具');
    expect(OS._t('Artistic font processing')).toBe('艺术字体处理');
    expect(OS._t('No original image reference')).toBe('没有原图参考');
    expect(OS._t('Artistic font processing in progress')).toBe('艺术字体处理中');
  });

  it('localizes the visible tool name when switching tools', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.layers = [{name:'Layer 0', locked:false, objects:[]}];
    quietUiMethods(OS);
    window.HstarOpenShopI18n.setLocale('zh-CN');

    OS.setTool('rect');

    expect(document.getElementById('tool-display').textContent).toBe('矩形工具');
  });

  it('routes brush and eraser pointers through one raster session instead of Fabric paths', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(event => ({x:event.x, y:event.y}));
    OS.layers = [{name:'Raster', locked:false, visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    let rasterActive = false;
    OS._rasterTools = {
      begin:vi.fn(() => { rasterActive = true; return {ok:true}; }),
      move:vi.fn(() => true),
      end:vi.fn(() => { rasterActive = false; return true; }),
      cancel:vi.fn(),
      getState:vi.fn(() => ({active:rasterActive, tool:OS.state.tool})),
    };

    OS.setTool('eraser');
    OS.onMouseDown({e:{x:10, y:12, buttons:1}});
    OS.onMouseMove({e:{x:18, y:20, buttons:1}});
    OS.onMouseUp({e:{x:18, y:20, buttons:0}});

    expect(OS.canvas.isDrawingMode).toBe(false);
    expect(OS._rasterTools.begin).toHaveBeenCalledWith('eraser', {x:10, y:12});
    expect(OS._rasterTools.move).toHaveBeenCalledWith({x:18, y:20});
    expect(OS._rasterTools.end).toHaveBeenCalledOnce();
    expect(OS.canvas.add).not.toHaveBeenCalled();
  });

  it('resolves raster commands exclusively inside the visible unlocked active layer', () => {
    const OS = loadOpenShop();
    const lower = {type:'image', name:'Lower image'};
    const active = {type:'image', name:'Active image'};
    OS.canvas = createCanvasMock([lower, active]);
    OS.canvas.setActiveObject(lower);
    OS.layers = [
      {name:'Lower', locked:false, visible:true, objects:[lower]},
      {name:'Active', locked:false, visible:true, objects:[active]},
    ];
    OS.activeLayerIdx = 1;

    expect(OS._activeLayerRasterTarget()).toBe(active);

    OS.layers[1].locked = true;
    expect(OS._activeLayerRasterTarget()).toBeNull();

    OS.layers[1].locked = false;
    OS.layers[1].visible = false;
    expect(OS._activeLayerRasterTarget()).toBeNull();
  });

  it('creates a transparent document-sized paint target inside an empty active layer', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvasW = 320;
    OS.canvasH = 180;
    OS.layers = [{name:'Layer 1', locked:false, visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    fabric.Image = class {
      constructor(element, options = {}) {
        this.type = 'image';
        this._element = element;
        Object.assign(this, options);
      }
      getElement() { return this._element; }
    };

    const target = OS._ensureActiveRasterTarget();

    expect(target).toMatchObject({type:'image', width:320, height:180, left:0, top:0, hstarPaintSurface:true});
    expect(target.getElement()).toMatchObject({width:320, height:180});
    expect(OS.layers[0].objects).toEqual([target]);
    expect(OS.canvas.getObjects()).toContain(target);
  });

  it('creates a brush raster target without discarding pencil paths on the active layer', () => {
    const OS = loadOpenShop();
    const pencilPath = {type:'path', name:'Pencil stroke'};
    OS.canvas = createCanvasMock([pencilPath]);
    OS.canvasW = 320;
    OS.canvasH = 180;
    OS.layers = [{name:'Sketch', locked:false, visible:true, objects:[pencilPath]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    fabric.Image = class {
      constructor(element, options = {}) {
        this.type = 'image';
        this._element = element;
        Object.assign(this, options);
      }
      getElement() { return this._element; }
    };

    const target = OS._ensureActiveRasterTarget();

    expect(target).toMatchObject({type:'image', hstarPaintSurface:true});
    expect(OS.layers[0].objects).toEqual([pencilPath, target]);
    expect(OS.canvas.getObjects()).toEqual([pencilPath, target]);
  });

  it('pastes one copied object into a new layer', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.layers = [{name:'Base', locked:false, visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    const pasted = {
      type:'rect', name:'Source', left:10, top:20, evented:false,
      set(values) { Object.assign(this, values); return this; },
    };
    OS._clipboard = {
      left:10, top:20,
      clone(callback) { callback(pasted); },
      set(values) { Object.assign(this, values); return this; },
    };

    OS._pasteSelection();

    expect(OS.layers).toHaveLength(2);
    expect(OS.layers[1].objects).toEqual([pasted]);
    expect(OS.layers[0].objects).toEqual([]);
    expect(OS.canvas.getActiveObject()).toBe(pasted);
  });

  it('pastes each object from a copied active selection into its own new layer', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.layers = [{name:'Base', locked:false, visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    const first = {type:'rect', name:'First'};
    const second = {type:'circle', name:'Second'};
    const clonedSelection = {
      type:'activeSelection', left:10, top:20,
      set(values) { Object.assign(this, values); return this; },
      setCoords:vi.fn(),
      forEachObject(callback) { [first, second].forEach(callback); },
    };
    OS._clipboard = {
      left:10, top:20,
      clone(callback) { callback(clonedSelection); },
      set(values) { Object.assign(this, values); return this; },
    };

    OS._pasteSelection();

    expect(OS.layers).toHaveLength(3);
    expect(OS.layers[1].objects).toEqual([first]);
    expect(OS.layers[2].objects).toEqual([second]);
    expect(OS.canvas.getActiveObject()).toMatchObject({type:'activeSelection'});
  });

  it('routes Ctrl+C and Ctrl+V through the new-layer paste workflow', () => {
    const OS = loadOpenShop();
    const source = {
      type:'rect', name:'Source', left:5, top:7,
      clone(callback) {
        callback({
          left:5, top:7,
          clone(pasteCallback) {
            pasteCallback({
              type:'rect', name:'Source', left:5, top:7,
              set(values) { Object.assign(this, values); return this; },
            });
          },
          set(values) { Object.assign(this, values); return this; },
        });
      },
    };
    OS.canvas = createCanvasMock([source]);
    OS.canvas.setActiveObject(source);
    OS.layers = [{name:'Source', locked:false, visible:true, objects:[source]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    OS._initKeyboardShortcuts();

    document.dispatchEvent(new KeyboardEvent('keydown', {key:'c', ctrlKey:true, bubbles:true}));
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'v', ctrlKey:true, bubbles:true}));

    expect(OS.layers).toHaveLength(2);
    expect(OS.layers[0].objects).toEqual([source]);
    expect(OS.layers[1].objects).toHaveLength(1);
    expect(OS.layers[1].objects[0]).not.toBe(source);
  });

  it('duplicates a selected object into a new layer', () => {
    const OS = loadOpenShop();
    const duplicate = {
      type:'rect', name:'Source', left:5, top:7,
      set(values) { Object.assign(this, values); return this; },
    };
    const source = {
      type:'rect', name:'Source', left:5, top:7,
      clone(callback) { callback(duplicate); },
    };
    OS.canvas = createCanvasMock([source]);
    OS.canvas.setActiveObject(source);
    OS.layers = [{name:'Source', locked:false, visible:true, objects:[source]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);

    OS._duplicateSelection();

    expect(OS.layers).toHaveLength(2);
    expect(OS.layers[0].objects).toEqual([source]);
    expect(OS.layers[1].objects).toEqual([duplicate]);
    expect(duplicate).toMatchObject({left:25, top:27});
  });

  it('routes Ctrl+J to pixel selection copy before object duplication', () => {
    const OS = loadOpenShop();
    OS._keyboardContext = 'canvas';
    OS._selectionMask = {mask:new Uint8Array([1]), w:1, h:1, coordinateSpace:'document'};
    OS._copySelectionToNewLayer = vi.fn();
    OS._duplicateSelection = vi.fn();

    OS._shortcutCommands()['duplicate-context']();

    expect(OS._copySelectionToNewLayer).toHaveBeenCalledOnce();
    expect(OS._duplicateSelection).not.toHaveBeenCalled();
  });

  it('copies only selected source pixels into a new layer above the active layer', () => {
    const OS = loadOpenShop();
    const source = {type:'image', name:'Source', render:vi.fn()};
    OS.canvas = createCanvasMock([source]);
    OS.layers = [{name:'Source', locked:false, visible:true, opacity:100, blend:'source-over', objects:[source]}];
    OS.activeLayerIdx = 0;
    OS.canvasW = 4;
    OS.canvasH = 4;
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();
    const mask = new Uint8Array(16);
    mask[1 * 4 + 1] = 1;
    mask[1 * 4 + 2] = 1;
    mask[2 * 4 + 1] = 1;
    OS._selectionMask = {mask, w:4, h:4, coordinateSpace:'document'};
    OS._selectionMaskSpace = 'document';
    OS._selectionDocumentBounds = {x:1, y:1, w:2, h:2};
    OS._selectionBounds = {x:1, y:1, w:2, h:2};
    const pixels = new Uint8ClampedArray(2 * 2 * 4);
    for(let index=0; index<4; index+=1) pixels.set([20, 40, 60, 255], index * 4);
    const context = {
      save:vi.fn(),
      restore:vi.fn(),
      translate:vi.fn(),
      getImageData:vi.fn(() => ({data:pixels, width:2, height:2})),
      putImageData:vi.fn(),
    };
    const surface = {
      width:0,
      height:0,
      getContext:vi.fn(() => context),
    };
    const nativeCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(tag => (
      tag === 'canvas' ? surface : nativeCreateElement(tag)
    ));
    fabric.Image = class {
      constructor(element, options = {}) {
        this.type = 'image';
        this._element = element;
        Object.assign(this, options);
      }
      set(values) { Object.assign(this, values); return this; }
      setCoords() { return this; }
    };

    expect(OS._copySelectionToNewLayer()).toBe(true);

    expect(source.render).toHaveBeenCalledWith(context);
    expect(context.translate).toHaveBeenCalledWith(-1, -1);
    expect([...pixels.filter((_value, index) => index % 4 === 3)]).toEqual([255, 255, 255, 0]);
    expect(OS.layers).toHaveLength(2);
    expect(OS.layers[1].objects[0]).toMatchObject({type:'image', left:1, top:1, width:2, height:2});
    expect(OS.activeLayerIdx).toBe(1);
    expect(OS.saveHistory).toHaveBeenCalledWith('Layer Via Copy');
  });

  it('selects the owning layer when a canvas object is selected', () => {
    const OS = loadOpenShop();
    const boundary = {type:'rect', name:'__boundary__'};
    const lowerImage = {type:'image', name:'Lower image'};
    const upperImage = {type:'image', name:'Upper image'};
    OS.canvas = createCanvasMock([boundary, lowerImage, upperImage]);
    quietUiMethods(OS, {keepLayersPanel:true});
    OS.layers = [
      {name:'Background', locked:true, visible:true, opacity:100, blend:'source-over', objects:[boundary]},
      {name:'Lower', locked:false, visible:true, opacity:100, blend:'source-over', objects:[lowerImage]},
      {name:'Upper', locked:false, visible:true, opacity:100, blend:'source-over', objects:[upperImage]},
    ];
    OS._resetLayerSelection(OS.layers[0]);
    OS.updateLayersPanel();

    const synced = OS._syncLayerSelectionFromCanvasSelection?.({
      target:lowerImage,
      selected:[lowerImage],
    }) ?? false;

    expect(synced).toBe(true);
    expect(OS.activeLayerIdx).toBe(1);
    expect(OS._selectedLayerIndices()).toEqual([1]);
    expect(document.querySelector('.layer-item.primary .layer-name').textContent).toBe('Lower');
    expect(OS._keyboardContext).toBe('canvas');
  });

  it('creates a document-sized raster surface when filling an empty normal layer', () => {
    const OS = loadOpenShop();
    const canvas = createCanvasMock([]);
    OS.canvas = canvas;
    OS.canvasW = 4;
    OS.canvasH = 3;
    OS.layers = [{name:'Layer 1', locked:false, visible:true, opacity:100, blend:'source-over', objects:[]}];
    OS.activeLayerIdx = 0;
    OS.saveHistory = vi.fn();
    quietUiMethods(OS);
    const sourceElement = document.createElement('canvas');
    sourceElement.width = 4;
    sourceElement.height = 3;
    const source = {
      type:'image',
      set:vi.fn(function set(values){ Object.assign(this, values); }),
      getElement:vi.fn(() => sourceElement),
      calcTransformMatrix:vi.fn(() => [1, 0, 0, 1, 2, 1.5]),
    };
    const replacement = {
      type:'image',
      set:vi.fn(function set(values){ Object.assign(this, values); }),
    };
    fabric.Image = {
      fromURL:vi.fn()
        .mockImplementationOnce((_url, callback) => callback(source))
        .mockImplementationOnce((_url, callback) => callback(replacement)),
    };

    expect(OS._fillActiveImage('#123456', 'Fill Foreground')).toBe(true);
    expect(fabric.Image.fromURL).toHaveBeenCalledTimes(2);
    expect(OS.layers[0].objects).toEqual([replacement]);
    expect(replacement.left).toBe(0);
    expect(replacement.top).toBe(0);
    expect(OS.saveHistory).toHaveBeenCalledWith('Fill Foreground');
  });

  it.each([
    ['text', {type:'i-text', text:'Hello'}],
    ['shape', {type:'rect', width:20, height:10}],
  ])('does not raster-fill a %s layer', (_name, object) => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([object]);
    OS.layers = [{name:'Special', locked:false, visible:true, opacity:100, blend:'source-over', objects:[object]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    OS.toast = vi.fn();
    fabric.Image = {fromURL:vi.fn()};

    expect(OS._fillActiveImage('#123456', 'Fill Foreground')).toBe(false);
    expect(fabric.Image.fromURL).not.toHaveBeenCalled();
    expect(OS.toast).toHaveBeenCalled();
  });

  it('replaces raster content at its original canvas and layer index', () => {
    const OS = loadOpenShop();
    const before = {type:'rect', name:'Before'};
    const active = {
      type:'image', name:'Source', left:12, top:34, scaleX:1.5, scaleY:0.75,
      angle:0, flipX:false, flipY:false, originX:'left', originY:'top',
      hstarLayerId:'layer-active', hstarAssetId:'asset-active', hstarSnapAnchor:{type:'selection', x:1},
    };
    const after = {type:'rect', name:'After'};
    const objects = [before, active, after];
    OS.canvas = createCanvasMock(objects);
    OS.canvas.insertAt = vi.fn((object, index) => OS.canvas.objects.splice(index, 0, object));
    OS.layers = [{name:'Active', locked:false, visible:true, objects:[active]}];
    OS.activeLayerIdx = 0;
    OS.saveHistory = vi.fn();
    quietUiMethods(OS);
    const replacement = {type:'image', set:vi.fn(function set(values){ Object.assign(this, values); })};
    fabric.Image = {fromURL:vi.fn((_url, callback) => callback(replacement))};

    OS._replaceActiveImage(active, 'data:image/png;base64,TEST', 'Retouch');

    expect(OS.canvas.getObjects()).toEqual([before, replacement, after]);
    expect(OS.layers[0].objects).toEqual([replacement]);
    expect(replacement).toMatchObject({
      left:12,
      top:34,
      scaleX:1.5,
      scaleY:0.75,
      hstarLayerId:'layer-active',
      hstarAssetId:'asset-active',
      hstarSnapAnchor:{type:'selection', x:1},
    });
    expect(OS.saveHistory).toHaveBeenCalledWith('Retouch');
  });

  it('finalizes healing and retouch sessions exactly once without per-stroke listeners', () => {
    const OS = loadOpenShop();
    const healingTarget = {type:'image', name:'Healing target'};
    const retouchTarget = {type:'image', name:'Retouch target'};
    OS._replaceActiveImage = vi.fn();

    OS._healOC = {toDataURL:vi.fn(() => 'data:image/png;base64,HEAL')};
    OS._healTarget = healingTarget;
    expect(OS._finishDeferredRasterOperation()).toBe(true);
    expect(OS._replaceActiveImage).toHaveBeenCalledWith(
      healingTarget,
      'data:image/png;base64,HEAL',
      'Healing Brush',
    );
    expect(OS._finishDeferredRasterOperation()).toBe(false);

    OS._retouchOC = {toDataURL:vi.fn(() => 'data:image/png;base64,RETOUCH')};
    OS._retouchTarget = retouchTarget;
    expect(OS._finishDeferredRasterOperation()).toBe(true);
    expect(OS._replaceActiveImage).toHaveBeenCalledWith(
      retouchTarget,
      'data:image/png;base64,RETOUCH',
      'Retouch',
    );
    expect(OS._finishDeferredRasterOperation()).toBe(false);
    expect(OS._replaceActiveImage).toHaveBeenCalledTimes(2);
  });

  it('edits an existing text target without creating another object', () => {
    const OS = loadOpenShop();
    const text = new fabric.IText('Existing', {left:20, top:30});
    const image = {type:'image', name:'Reference'};
    OS.canvas = createCanvasMock([text, image]);
    OS.canvas.getPointer = vi.fn(() => ({x:25, y:35}));
    OS.layers = [{name:'Layer 1', locked:false, objects:[text, image]}];
    OS.activeLayerIdx = 0;
    OS.saveHistory = vi.fn();
    quietUiMethods(OS);

    OS.setTool('text');
    OS.onMouseDown({e:{}, target:text});

    expect(text.selectable).toBe(true);
    expect(text.evented).toBe(true);
    expect(image.selectable).toBe(false);
    expect(image.evented).toBe(false);
    expect(OS.canvas.getObjects()).toHaveLength(2);
    expect(OS.canvas.setActiveObject).toHaveBeenCalledWith(text);
    expect(text.enterEditing).toHaveBeenCalledOnce();
    expect(OS.saveHistory).not.toHaveBeenCalled();
  });

  it('enters an existing vertical text object on canvas double-click', () => {
    const OS = loadOpenShop();
    const vertical = {
      type:'hstar-vertical-text', text:'直排文字', isEditing:false,
      enterEditing:vi.fn(function enterEditing() { this.isEditing = true; }),
    };
    OS.canvas = createCanvasMock([vertical]);
    OS.layers = [{name:'直排文字', locked:false, objects:[vertical]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);

    OS.onMouseDoubleClick({e:{type:'dblclick'}, target:vertical});

    expect(OS.canvas.setActiveObject).toHaveBeenCalledWith(vertical);
    expect(vertical.enterEditing).toHaveBeenCalledOnce();
    expect(vertical.isEditing).toBe(true);
    expect(OS.canvas.requestRenderAll).toHaveBeenCalledOnce();
  });

  it('creates one text object only when the text tool hits empty canvas', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(() => ({x:120, y:80}));
    OS.layers = [{name:'Layer 1', locked:false, objects:[]}];
    OS.activeLayerIdx = 0;
    OS.saveHistory = vi.fn();
    quietUiMethods(OS);

    OS.setTool('text');
    OS.onMouseDown({e:{}, target:null});

    expect(OS.state.textColor).toBe('#000000');
    expect(OS.canvas.getObjects()).toHaveLength(1);
    expect(OS.canvas.getObjects()[0].fill).toBe('#000000');
    expect(OS.layers).toHaveLength(2);
    expect(OS.layers[0].objects).toHaveLength(0);
    expect(OS.layers[1]).toMatchObject({name:'Type here', objects:[OS.canvas.getObjects()[0]]});
    expect(OS.activeLayerIdx).toBe(1);
    expect(OS.canvas.getObjects()[0].enterEditing).toHaveBeenCalledOnce();
    expect(OS.saveHistory).toHaveBeenCalledOnce();
    expect(OS.saveHistory).toHaveBeenCalledWith('Add Text');
  });

  it('routes legacy and vertical text pointers through the existing text branch', () => {
    const OS = loadOpenShop();
    const text = new fabric.IText('Existing', {left:20, top:30});
    OS.canvas = createCanvasMock([text]);
    OS.canvas.getPointer = vi.fn(() => ({x:120, y:80}));
    OS.layers = [{name:'Layer 1', locked:false, objects:[text]}];
    OS.activeLayerIdx = 0;
    OS.saveHistory = vi.fn();
    quietUiMethods(OS);

    OS.setTool('text');
    OS.onMouseDown({e:{}, target:text});
    expect(text.enterEditing).toHaveBeenCalledOnce();

    text.isEditing = false;
    OS.state.tool = 'text';
    OS.onMouseDown({e:{}, target:text});
    expect(text.enterEditing).toHaveBeenCalledTimes(2);

    OS.setTool('text-vertical');
    OS.onMouseDown({e:{}, target:null});
    expect(OS.canvas.getObjects()).toHaveLength(2);
    expect(OS.canvas.getObjects()[1].isEditing).toBe(true);
  });

  it('creates each completed shape on its own layer', () => {
    const OS = loadOpenShop();
    class Rect {
      constructor(options = {}) { this.type = 'rect'; Object.assign(this, options); }
      set(values) { Object.assign(this, values); }
      setCoords() {}
    }
    fabric.Rect = Rect;
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(event => ({x:event.x, y:event.y}));
    OS.layers = [{name:'Layer 0', locked:false, visible:true, opacity:100, blend:'source-over', objects:[]}];
    OS.activeLayerIdx = 0;
    OS.saveHistory = vi.fn();
    quietUiMethods(OS);

    OS.setTool('rect');
    OS.onMouseDown({e:{x:40, y:50}});
    OS.onMouseMove({e:{x:240, y:170}});
    OS.onMouseUp({e:{x:240, y:170}});

    const shape = OS.canvas.getObjects()[0];
    expect(OS.layers).toHaveLength(2);
    expect(OS.layers[0].objects).toEqual([]);
    expect(OS.layers[1]).toMatchObject({name:'Rectangle', objects:[shape]});
    expect(OS.activeLayerIdx).toBe(1);
    expect(shape).toMatchObject({left:40, top:50, width:200, height:120, selectable:true});
    expect(OS.saveHistory).toHaveBeenCalledWith('Draw rect');
  });

  it('applies always-on document snapping with screen-space tolerance', async () => {
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(snapEnginePath).href}?test=${Date.now()}-${Math.random()}`);
    const OS = loadOpenShop();
    const object = {
      left:24,
      top:-14,
      width:3840,
      height:2160,
      scaleX:1,
      scaleY:1,
      selectable:true,
      set(values) { Object.assign(this, values); },
      setCoords:vi.fn(),
      getBoundingRect() {
        return {left:this.left, top:this.top, width:3840, height:2160};
      },
    };
    OS.canvas = createCanvasMock([object]);
    OS.canvas.viewportTransform = [0.21, 0, 0, 0.21, 0, 0];
    OS.canvasW = 3840;
    OS.canvasH = 2160;
    OS.layers = [{name:'整图', locked:false, objects:[object]}];
    OS._prefs.snapTolerance = 6;

    OS._applyObjectSnapping(object);

    expect(object.left).toBe(0);
    expect(object.top).toBe(0);
    expect(object.setCoords).toHaveBeenCalledOnce();

    object.left = 22;
    object.top = 0;
    OS.canvas.viewportTransform = [0.5, 0, 0, 0.5, 0, 0];
    OS._prefs.snapTolerance = 10;
    OS._applyObjectSnapping(object);

    expect(object.left).toBe(22);
    expect(object.top).toBe(0);
  });

  it('applies right and bottom document snaps to the Fabric object origin', async () => {
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(snapEnginePath).href}?test=${Date.now()}-${Math.random()}`);
    const OS = loadOpenShop();
    const object = {
      left:797,
      top:603,
      width:200,
      height:200,
      scaleX:1,
      scaleY:1,
      selectable:true,
      set(values) { Object.assign(this, values); },
      setCoords:vi.fn(),
      getBoundingRect() {
        return {left:this.left, top:this.top, width:200, height:200};
      },
    };
    OS.canvas = createCanvasMock([object]);
    OS.canvasW = 1000;
    OS.canvasH = 800;
    OS.layers = [{name:'普通图层', locked:false, objects:[object]}];
    OS._prefs.snapTolerance = 5;

    OS._applyObjectSnapping(object);

    expect(object.left).toBe(800);
    expect(object.top).toBe(600);
    expect(object.getBoundingRect()).toMatchObject({left:800, top:600, width:200, height:200});
    expect(object.setCoords).toHaveBeenCalledOnce();
  });

  it('applies right and bottom scaling snaps to the transformed object bounds', async () => {
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(snapEnginePath).href}?test=${Date.now()}-${Math.random()}`);
    const OS = loadOpenShop();
    const object = {
      left:100,
      top:200,
      width:900,
      height:600,
      scaleX:0.9995,
      scaleY:0.9995,
      angle:0,
      skewX:0,
      skewY:0,
      selectable:true,
      set(values) { Object.assign(this, values); },
      setCoords:vi.fn(),
      getBoundingRect() {
        return {
          left:this.left,
          top:this.top,
          width:this.width * this.scaleX,
          height:this.height * this.scaleY,
        };
      },
    };
    OS.canvas = createCanvasMock([object]);
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvasW = 1000;
    OS.canvasH = 800;
    OS.layers = [{name:'普通图层', locked:false, objects:[object]}];
    OS._prefs.snapTolerance = 5;

    OS._applyObjectScaleSnapping(object, {corner:'br'});

    expect(object.scaleX).toBeCloseTo(1, 6);
    expect(object.scaleY).toBeCloseTo(1, 6);
    expect(object.getBoundingRect().left + object.getBoundingRect().width).toBeCloseTo(1000, 6);
    expect(object.getBoundingRect().top + object.getBoundingRect().height).toBeCloseTo(800, 6);
    expect(object.setCoords).toHaveBeenCalledTimes(2);
  });

  it('applies left and top scaling snaps through the Fabric object transform', async () => {
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(snapEnginePath).href}?test=${Date.now()}-${Math.random()}`);
    const OS = loadOpenShop();
    const object = {
      left:3, top:2, width:900, height:600,
      scaleX:1, scaleY:1, angle:0, skewX:0, skewY:0, selectable:true,
      set(values) { Object.assign(this, values); },
      setCoords:vi.fn(),
      getBoundingRect() {
        return {left:this.left, top:this.top, width:this.width*this.scaleX, height:this.height*this.scaleY};
      },
    };
    OS.canvas = createCanvasMock([object]);
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvasW = 1000;
    OS.canvasH = 800;
    OS.layers = [{name:'Image', locked:false, objects:[object]}];

    OS._applyObjectScaleSnapping(object, {corner:'tl'});

    expect(object.left).toBeCloseTo(0, 8);
    expect(object.top).toBeCloseTo(0, 8);
    expect(object.getBoundingRect().left).toBeCloseTo(0, 8);
    expect(object.getBoundingRect().top).toBeCloseTo(0, 8);
    expect(object.setCoords).toHaveBeenCalledTimes(2);
  });

  it('preserves image proportions when a corner snaps on only one document axis', async () => {
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(snapEnginePath).href}?test=${Date.now()}-${Math.random()}`);
    const OS = loadOpenShop();
    const object = {
      left:100,
      top:200,
      width:400,
      height:200,
      scaleX:2.2475,
      scaleY:2.2475,
      angle:0,
      skewX:0,
      skewY:0,
      selectable:true,
      set(values) { Object.assign(this, values); },
      setCoords:vi.fn(),
      getBoundingRect() {
        return {
          left:this.left,
          top:this.top,
          width:this.width * this.scaleX,
          height:this.height * this.scaleY,
        };
      },
    };
    OS.canvas = createCanvasMock([object]);
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvasW = 1000;
    OS.canvasH = 800;
    OS.layers = [{name:'Image', locked:false, objects:[object]}];
    OS._prefs.snapTolerance = 10;

    OS._applyObjectScaleSnapping(object, {corner:'br'});

    expect(object.scaleX).toBeCloseTo(2.25, 6);
    expect(object.scaleY).toBeCloseTo(2.25, 6);
    expect(object.scaleX / object.scaleY).toBeCloseTo(1, 8);
    expect(object.left + object.width * object.scaleX).toBeCloseTo(1000, 6);
    expect(object.top).toBeCloseTo(200, 6);
  });

  it('keeps scale snapping discoverable within three screen pixels', async () => {
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(snapEnginePath).href}?test=${Date.now()}-${Math.random()}`);
    const OS = loadOpenShop();
    const object = {
      left:100, top:100, width:400, height:200,
      scaleX:2.245, scaleY:2.245,
      angle:0, skewX:0, skewY:0, selectable:true,
      set(values) { Object.assign(this, values); },
      setCoords:vi.fn(),
      getBoundingRect() {
        return {left:this.left, top:this.top, width:this.width*this.scaleX, height:this.height*this.scaleY};
      },
    };
    OS.canvas = createCanvasMock([object]);
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvasW = 1000;
    OS.canvasH = 800;
    OS.layers = [{name:'Image', locked:false, objects:[object]}];
    OS._prefs.snapTolerance = 10;

    OS._applyObjectScaleSnapping(object, {corner:'br'});

    expect(object.scaleX).toBeCloseTo(2.25, 8);
    expect(object.scaleY).toBeCloseTo(2.25, 8);
    expect(object.left + object.width*object.scaleX).toBeCloseTo(1000, 8);
    expect(object.setCoords).toHaveBeenCalledTimes(2);
  });

  it('zooms around the pointer only while Ctrl or Command is held', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.zoom = 1;
    OS._scheduleUi = vi.fn();
    OS._brushCursor = {refresh:vi.fn()};
    const plain = {
      e:{deltaY:-120, offsetX:240, offsetY:160, ctrlKey:false, metaKey:false, preventDefault:vi.fn()},
    };

    OS.onMouseWheel(plain);

    expect(plain.e.preventDefault).not.toHaveBeenCalled();
    expect(OS.canvas.zoomToPoint).not.toHaveBeenCalled();
    expect(OS.zoom).toBe(1);

    const modified = {
      e:{deltaY:-120, offsetX:240, offsetY:160, ctrlKey:true, metaKey:false, preventDefault:vi.fn()},
    };
    OS.onMouseWheel(modified);

    expect(modified.e.preventDefault).toHaveBeenCalledOnce();
    expect(OS.canvas.zoomToPoint).toHaveBeenCalledWith(
      {x:240, y:160},
      expect.any(Number),
    );
    expect(OS.zoom).toBeGreaterThan(1);
    expect(OS._brushCursor.refresh).toHaveBeenCalledOnce();
  });

  it('routes Ctrl+wheel from the vertical text editor to canvas zoom coordinates', () => {
    const OS = loadOpenShop();
    const editor = document.createElement('textarea');
    editor.setAttribute('data-hstar-vertical-editor', '');
    document.body.append(editor);
    OS.canvas = createCanvasMock();
    OS.canvas.upperCanvasEl = document.createElement('canvas');
    vi.spyOn(OS.canvas.upperCanvasEl, 'getBoundingClientRect').mockReturnValue({
      left:100, top:40, right:900, bottom:640, width:800, height:600,
    });
    OS.zoom = 1;
    OS._scheduleUi = vi.fn();
    OS._brushCursor = {refresh:vi.fn()};
    const event = {
      target:editor,
      deltaY:-120,
      offsetX:4,
      offsetY:6,
      clientX:260,
      clientY:180,
      ctrlKey:true,
      metaKey:false,
      preventDefault:vi.fn(),
    };

    expect(OS._handleVerticalEditorWheel(event)).toBe(true);

    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(OS.canvas.zoomToPoint).toHaveBeenCalledWith(
      {x:160, y:140},
      expect.any(Number),
    );
    expect(OS.zoom).toBeGreaterThan(1);
  });

  it('creates a real pixel mask from a press-drag-release freehand lasso', () => {
    mountEditorDom();
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.width = 100;
    OS.canvas.height = 100;
    OS.canvasW = 100;
    OS.canvasH = 100;
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();
    OS.toast = vi.fn();

    OS._lassoStart({offsetX:10, offsetY:10, shiftKey:false, altKey:false});
    OS._lassoMove({offsetX:80, offsetY:10});
    OS._lassoMove({offsetX:80, offsetY:80});
    OS._lassoMove({offsetX:10, offsetY:80});
    OS._lassoFinish({offsetX:10, offsetY:10});

    expect(OS._selectionMask).toMatchObject({w:100, h:100});
    expect(OS._selectionMask.mask[40 * 100 + 40]).toBe(1);
    expect(OS._selectionMask.mask[2 * 100 + 2]).toBe(0);
    expect(OS._selectionBounds).toEqual({x:10, y:10, w:70, h:70});
    expect(OS._showMaskOverlay).toHaveBeenCalledWith(OS._selectionMask);
    expect(OS._emitSelectionChanged).toHaveBeenCalledWith('lasso', expect.objectContaining({
      mode:'new',
      incomingBounds:{x:10, y:10, w:70, h:70},
    }));
    expect(document.getElementById('lasso-overlay').style.display).toBe('none');
  });

  it('keeps lasso points anchored to document coordinates while the viewport changes', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.upperCanvasEl = document.createElement('canvas');
    vi.spyOn(OS.canvas.upperCanvasEl, 'getBoundingClientRect').mockReturnValue({left:0, top:0});
    OS.canvasW = 200;
    OS.canvasH = 120;
    OS.canvas.viewportTransform = [2, 0, 0, 2, 40, 30];

    OS._lassoStart({offsetX:60, offsetY:50, shiftKey:false, altKey:false});
    OS._lassoMove({offsetX:100, offsetY:70});
    expect(OS._lassoPoints).toEqual([{x:10, y:10}, {x:30, y:20}]);

    OS.canvas.viewportTransform = [1, 0, 0, 1, 5, 7];
    OS._refreshSelectionViewport();

    expect(document.querySelector('#lasso-overlay svg polyline').getAttribute('points')).toBe('15,17 35,27');
    expect(OS._lassoPoints).toEqual([{x:10, y:10}, {x:30, y:20}]);
  });

  it('clears pen closure feedback when switching away from the pen tool', () => {
    const OS = loadOpenShop();
    document.getElementById('pen-overlay').innerHTML = '<svg><path></path><circle class="pen-close-hint active"></circle></svg>';
    OS.canvas = createCanvasMock();
    OS.layers = [{name:'Layer 1', locked:false, visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    quietUiMethods(OS);
    OS.state.tool = 'pen';
    OS._penPoints = [{x:10, y:10}, {x:40, y:10}, {x:40, y:40}];
    OS._penHoverPoint = {x:10, y:10};
    OS._penCanClose = true;

    OS.setTool('select');

    expect(OS._penPoints).toEqual([]);
    expect(OS._penHoverPoint).toBeNull();
    expect(OS._penCanClose).toBe(false);
    expect(document.querySelector('.pen-close-hint').classList.contains('active')).toBe(false);
  });

  it('reprojects the pen preview after zoom or pan and signals first-point closure', () => {
    const OS = loadOpenShop();
    document.getElementById('pen-overlay').innerHTML = '<svg><path></path><circle class="pen-close-hint"></circle></svg>';
    OS.canvas = createCanvasMock();
    OS.canvas.viewportTransform = [2, 0, 0, 2, 40, 30];
    OS._penPoints = [{x:10, y:10}, {x:40, y:10}, {x:40, y:40}];

    OS._penPointerMove({x:11, y:11});

    expect(OS._penCanClose).toBe(true);
    expect(document.querySelector('.pen-close-hint').classList.contains('active')).toBe(true);
    expect(document.querySelector('#pen-overlay path').getAttribute('d')).toContain('L 60 50');

    OS.canvas.viewportTransform = [1, 0, 0, 1, 5, 7];
    OS._refreshSelectionViewport();

    expect(document.querySelector('#pen-overlay path').getAttribute('d')).toBe('M 15 17 L 45 17 L 45 47 L 15 17');
  });

  it('adds a second magic-wand region while Shift is held', () => {
    mountEditorDom();
    const OS = loadOpenShop();
    const red = [200, 20, 20, 255];
    const blue = [20, 20, 200, 255];
    const pixels = [
      red, red, blue, red, red,
      red, red, blue, red, red,
      blue, blue, blue, blue, blue,
    ];
    const data = new Uint8ClampedArray(pixels.flat());
    OS.canvas = createCanvasMock();
    OS.canvas.width = 5;
    OS.canvas.height = 3;
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvasW = 5;
    OS.canvasH = 3;
    OS.layers = [{name:'Active', visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    OS._magicWandSample = vi.fn(() => ({
      data,
      validMask:new Uint8Array(15).fill(1),
    }));
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();
    OS.toast = vi.fn();
    OS.state.wandTolerance = 0;
    OS.state.wandContiguous = true;

    OS._doMagicWand({x:0, y:0}, {shiftKey:false, altKey:false});
    expect(OS._selectionMask.mask.filter(Boolean)).toHaveLength(4);
    OS._doMagicWand({x:4, y:0}, {shiftKey:true, altKey:false});

    expect(OS._selectionMask.mask.filter(Boolean)).toHaveLength(8);
    expect(OS._selectionBounds).toEqual({x:0, y:0, w:5, h:2});
    expect(OS._showMaskOverlay).toHaveBeenCalledTimes(2);
    expect(OS._emitSelectionChanged).toHaveBeenLastCalledWith('magic-wand', expect.objectContaining({
      mode:'add',
      incomingBounds:{x:3, y:0, w:2, h:2},
    }));
  });

  it('keeps a magic-wand mask in document space under zoom and pan', () => {
    const OS = loadOpenShop();
    const data = new Uint8ClampedArray(5 * 3 * 4);
    for(let index=0; index<15; index+=1) data.set([200, 20, 20, 255], index * 4);
    OS.canvas = createCanvasMock();
    OS.canvas.width = 800;
    OS.canvas.height = 600;
    OS.canvas.viewportTransform = [2, 0, 0, 2, 40, 30];
    OS.canvasW = 5;
    OS.canvasH = 3;
    OS.layers = [{name:'Active', visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    OS._magicWandSample = vi.fn(() => ({data, validMask:new Uint8Array(15).fill(1)}));
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();
    OS.toast = vi.fn();
    OS.state.wandTolerance = 0;
    OS.state.wandContiguous = true;

    OS._doMagicWand({x:2, y:1});

    expect(OS._magicWandSample).toHaveBeenCalledWith(5, 3, [1, 0, 0, 1, 0, 0]);
    expect(OS._selectionMaskSpace).toBe('document');
    expect(OS._selectionDocumentBounds).toEqual({x:0, y:0, w:5, h:3});

    OS.canvas.viewportTransform = [1, 0, 0, 1, 5, 7];
    OS._refreshSelectionViewport();
    expect(OS._selectionDocumentBounds).toEqual({x:0, y:0, w:5, h:3});
  });

  it('keeps rectangular selections usable with a cached legacy selection engine', () => {
    mountEditorDom();
    const OS = loadOpenShop();
    const legacyEngine = {
      ...window.HstarOpenShopSelectionEngine,
      maskRegions:undefined,
    };
    Object.defineProperty(window, 'HstarOpenShopSelectionEngine', {
      configurable:true,
      writable:true,
      value:legacyEngine,
    });
    OS.canvas = createCanvasMock();
    OS.canvas.width = 6;
    OS.canvas.height = 4;
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvasW = 6;
    OS.canvasH = 4;
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();

    const mask = new Uint8Array(24);
    mask[1 * 6 + 2] = 1;
    mask[2 * 6 + 4] = 1;

    expect(() => OS._applyPixelSelection(mask, 6, 4, 'new', 'marquee')).not.toThrow();
    expect(OS._selectionBounds).toEqual({x:2, y:1, w:3, h:2});
    expect(OS._selectionRegions).toEqual([{x:2, y:1, w:3, h:2}]);
    expect(OS._emitSelectionChanged).toHaveBeenCalledWith('marquee', expect.objectContaining({
      incomingBounds:{x:2, y:1, w:3, h:2},
    }));
  });

  it('stores a rectangular marquee in document coordinates under zoom and pan', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.width = 800;
    OS.canvas.height = 600;
    OS.canvasW = 500;
    OS.canvasH = 400;
    OS.canvas.viewportTransform = [2, 0, 0, 2, 40, 30];
    OS.canvas.getPointer = vi.fn(event => ({
      x:(event.offsetX - 40) / 2,
      y:(event.offsetY - 30) / 2,
    }));
    OS.state.tool = 'marquee-rect';
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS.toast = vi.fn();

    OS.onMouseDown({e:{offsetX:240, offsetY:130}});
    OS.onMouseMove({e:{offsetX:440, offsetY:330}});
    OS.onMouseUp({e:{offsetX:440, offsetY:330}});

    expect(OS._selectionDocumentBounds).toEqual({x:100, y:50, w:100, h:100});
    expect(OS._selectionBounds).toEqual({x:240, y:130, w:200, h:200});
    expect(OS._selectionMask).toMatchObject({w:500, h:400});
    expect(OS._selectionMask.mask[75 * 500 + 125]).toBe(1);
    expect(OS._selectionMask.mask[25 * 500 + 50]).toBe(0);
  });

  it('clears a zero-size rectangular marquee without throwing', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.width = 800;
    OS.canvas.height = 600;
    OS.canvasW = 500;
    OS.canvasH = 400;
    OS.canvas.viewportTransform = [2, 0, 0, 2, 40, 30];
    OS.canvas.getPointer = vi.fn(event => ({
      x:(event.offsetX - 40) / 2,
      y:(event.offsetY - 30) / 2,
    }));
    OS.state.tool = 'marquee-rect';
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();

    OS.onMouseDown({e:{offsetX:240, offsetY:130}});

    expect(() => OS.onMouseUp({e:{offsetX:240, offsetY:130}})).not.toThrow();
    expect(document.getElementById('selection-overlay').style.display).toBe('none');
    expect(OS._selectionMask).toBeNull();
    expect(OS._selectionDocumentBounds).toBeNull();
    expect(OS._selectionRegions).toEqual([]);
    expect(OS._emitSelectionChanged).toHaveBeenCalledWith('cleared');
  });

  it('keeps document selection and mask fixed when the viewport changes', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.width = 800;
    OS.canvas.height = 600;
    OS.canvasW = 500;
    OS.canvasH = 400;
    OS.canvas.viewportTransform = [2, 0, 0, 2, 40, 30];
    OS._selectionDocumentBounds = {x:100, y:50, w:100, h:100};
    OS._selectionBounds = {x:240, y:130, w:200, h:200};
    OS._selectionMask = {mask:new Uint8Array(500 * 400), w:500, h:400};
    OS._selectionMaskSpace = 'document';
    OS._selectionMask.mask[75 * 500 + 125] = 1;

    OS.canvas.viewportTransform = [1, 0, 0, 1, 10, 20];
    OS._refreshSelectionViewport();

    expect(OS._selectionDocumentBounds).toEqual({x:100, y:50, w:100, h:100});
    expect(OS._selectionBounds).toEqual({x:110, y:70, w:100, h:100});
    expect(OS._selectionMask).toMatchObject({w:500, h:400});
    expect(OS._selectionMask.mask[75 * 500 + 125]).toBe(1);
    expect(document.getElementById('selection-mask-overlay').style.transform)
      .toBe('matrix(1, 0, 0, 1, 10, 20)');
  });

  it('draws selected-state marching ants with scale-aware visibility after zooming out', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.width = 800;
    OS.canvas.height = 600;
    OS.canvasW = 20;
    OS.canvasH = 20;
    OS.canvas.viewportTransform = [0.2, 0, 0, 0.2, 0, 0];
    const context = {
      clearRect:vi.fn(),
      beginPath:vi.fn(),
      rect:vi.fn(),
      fill:vi.fn(),
      fillStyle:'',
    };
    document.getElementById('selection-mask-overlay').getContext = vi.fn(() => context);
    let frame = null;
    const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
    const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
    globalThis.requestAnimationFrame = vi.fn(callback => { frame = callback; return 1; });
    globalThis.cancelAnimationFrame = vi.fn();
    const mask = new Uint8Array(20 * 20);
    for(let y = 4; y < 12; y += 1){
      for(let x = 5; x < 14; x += 1) mask[y * 20 + x] = 1;
    }

    try {
      OS._showMaskOverlay({mask, w:20, h:20, coordinateSpace:'document'});
      frame?.(120);
    } finally {
      globalThis.requestAnimationFrame = originalRequestAnimationFrame;
      globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
    }

    expect(context.rect).toHaveBeenCalled();
    const widths = context.rect.mock.calls.map(call => call[2]);
    expect(widths.some(width => width > 10)).toBe(true);
    expect(widths.some(width => width >= 2 && width <= 10)).toBe(true);
    expect(Math.max(...widths)).toBeLessThanOrEqual(14);
    expect(document.getElementById('selection-overlay').style.display).toBe('none');
  });

  it('removes a document-space selection region without viewport drift', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.width = 80;
    OS.canvas.height = 60;
    OS.canvasW = 20;
    OS.canvasH = 10;
    OS.canvas.viewportTransform = [2, 0, 0, 2, 5, 7];
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();
    const mask = new Uint8Array(20 * 10);
    for(let y = 1; y < 3; y += 1){
      for(let x = 1; x < 3; x += 1) mask[y * 20 + x] = 1;
      for(let x = 10; x < 12; x += 1) mask[y * 20 + x] = 1;
    }
    OS._selectionMask = {mask, w:20, h:10, coordinateSpace:'document'};
    OS._selectionMaskSpace = 'document';
    OS._selectionDocumentBounds = {x:1, y:1, w:11, h:2};
    OS._selectionBounds = {x:7, y:9, w:22, h:4};
    OS._selectionRegions = [{x:1, y:1, w:2, h:2}, {x:10, y:1, w:2, h:2}];

    expect(OS.removeSelectionRegion(0)).toBe(true);

    expect(OS._selectionMaskSpace).toBe('document');
    expect(OS._selectionDocumentBounds).toEqual({x:10, y:1, w:2, h:2});
    expect(OS._selectionBounds).toEqual({x:25, y:9, w:4, h:4});
    expect(OS._selectionRegions).toEqual([{x:10, y:1, w:2, h:2, count:4}]);
  });

  it('reselects the original document region after the viewport changes', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.canvas.width = 80;
    OS.canvas.height = 60;
    OS.canvasW = 20;
    OS.canvasH = 10;
    OS.canvas.viewportTransform = [2, 0, 0, 2, 5, 7];
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();
    OS.toast = vi.fn();
    const mask = new Uint8Array(20 * 10);
    for(let y = 1; y < 3; y += 1){
      for(let x = 10; x < 12; x += 1) mask[y * 20 + x] = 1;
    }
    OS._selectionMask = {mask, w:20, h:10, coordinateSpace:'document'};
    OS._selectionMaskSpace = 'document';
    OS._selectionDocumentBounds = {x:10, y:1, w:2, h:2};
    OS._selectionBounds = {x:25, y:9, w:4, h:4};
    OS._selectionRegions = [{x:10, y:1, w:2, h:2}];

    OS.clearSelection();
    OS.canvas.viewportTransform = [1, 0, 0, 1, 3, 4];
    OS.reselectSelection();

    expect(OS._selectionMaskSpace).toBe('document');
    expect(OS._selectionDocumentBounds).toEqual({x:10, y:1, w:2, h:2});
    expect(OS._selectionBounds).toEqual({x:13, y:5, w:2, h:2});
  });

  it('samples the active layer without the checker boundary or inactive layers', () => {
    mountEditorDom();
    const OS = loadOpenShop();
    const pixels = new Uint8ClampedArray(5 * 3 * 4);
    const context = {
      fillStyle:'#000000',
      save:vi.fn(),
      restore:vi.fn(),
      setTransform:vi.fn(),
      beginPath:vi.fn(),
      rect:vi.fn(),
      clip:vi.fn(),
      fillRect:vi.fn(function fillRect(x, y, width, height) {
        const channels = this.fillStyle === '#c81414'
          ? [200, 20, 20, 255]
          : this.fillStyle === '#1414c8'
            ? [20, 20, 200, 255]
            : [153, 153, 153, 255];
        for(let py=y;py<y+height;py+=1){
          for(let px=x;px<x+width;px+=1) pixels.set(channels,(py*5+px)*4);
        }
      }),
      getImageData:vi.fn(() => ({data:pixels, width:5, height:3})),
    };
    const sampleCanvas = {width:0, height:0, getContext:vi.fn(() => context)};
    const createElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation(tagName => (
      tagName === 'canvas' ? sampleCanvas : createElement(tagName)
    ));
    const boundary = {name:'__boundary__', visible:true, render:vi.fn(ctx => {
      ctx.fillStyle = '#999999';
      ctx.fillRect(0, 0, 5, 3);
    })};
    const active = {name:'Active', visible:true, render:vi.fn(ctx => {
      ctx.fillStyle = '#c81414';
      ctx.fillRect(0, 0, 2, 2);
    })};
    const inactive = {name:'Inactive', visible:true, render:vi.fn(ctx => {
      ctx.fillStyle = '#1414c8';
      ctx.fillRect(3, 0, 2, 2);
    })};
    OS.canvas = createCanvasMock([boundary, active, inactive]);
    OS.canvas.width = 5;
    OS.canvas.height = 3;
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvasW = 5;
    OS.canvasH = 3;
    OS.layers = [
      {name:'Background', visible:true, objects:[boundary]},
      {name:'Active', visible:true, objects:[active]},
      {name:'Inactive', visible:true, objects:[inactive]},
    ];
    OS.activeLayerIdx = 1;
    OS._showMaskOverlay = vi.fn();
    OS._renderAccessibilityTree = vi.fn();
    OS._emitSelectionChanged = vi.fn();
    OS.toast = vi.fn();
    OS.state.wandTolerance = 0;
    OS.state.wandContiguous = true;

    OS._doMagicWand({x:0, y:0});

    expect(OS._selectionMask.mask.filter(Boolean)).toHaveLength(4);
    expect(OS._selectionBounds).toEqual({x:0, y:0, w:2, h:2});
    expect(active.render).toHaveBeenCalledOnce();
    expect(boundary.render).not.toHaveBeenCalled();
    expect(inactive.render).not.toHaveBeenCalled();
  });

  it('ignores magic-wand clicks outside the document even when they are inside the viewport', () => {
    mountEditorDom();
    const OS = loadOpenShop();
    const getImageData = vi.fn(() => ({data:new Uint8ClampedArray(8 * 3 * 4), width:8, height:3}));
    OS.canvas = createCanvasMock([]);
    OS.canvas.width = 8;
    OS.canvas.height = 3;
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.canvas.getContext = vi.fn(() => ({getImageData}));
    OS.canvasW = 5;
    OS.canvasH = 3;
    OS.layers = [{name:'Active', visible:true, objects:[]}];
    OS.activeLayerIdx = 0;
    OS.toast = vi.fn();

    OS._doMagicWand({x:6, y:1});

    expect(OS._selectionMask).toBeNull();
    expect(getImageData).not.toHaveBeenCalled();
  });

  it('derives local selection snapping from legacy generation layer metadata', async () => {
    delete window.HstarOpenShopSnapEngine;
    await import(`${pathToFileURL(snapEnginePath).href}?test=${Date.now()}-${Math.random()}`);
    const OS = loadOpenShop();
    const object = {
      left:55,
      top:44,
      width:800,
      height:600,
      scaleX:0.5,
      scaleY:0.5,
      angle:0,
      skewX:0,
      skewY:0,
      selectable:true,
      set(values) { Object.assign(this, values); },
      setCoords:vi.fn(),
      getBoundingRect() {
        return {left:this.left, top:this.top, width:400, height:300};
      },
    };
    OS.canvas = createCanvasMock([object]);
    OS.canvasW = 800;
    OS.canvasH = 600;
    OS.layers = [{
      name:'旧局部重绘',
      locked:false,
      objects:[object],
      hstarAiGeneration:{
        toolId:'local-redraw',
        selection:{x:100, y:80, width:240, height:160},
      },
    }];
    OS._prefs.snapTolerance = 6;

    OS._applyObjectSnapping(object);

    expect(object.left).toBe(50);
    expect(object.top).toBe(40);
  });

  it('opens an image through the native backend without clicking the iframe input', async () => {
    const OS = loadOpenShop();
    quietUiMethods(OS);
    document.body.insertAdjacentHTML('beforeend', '<input id="file-input" type="file">');
    const input = document.getElementById('file-input');
    const click = vi.spyOn(input, 'click');
    OS._handleFileLoad = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      new Blob(['image-bytes'], {type:'image/png'}),
      {status:200, headers:{
        'Content-Type':'image/png',
        'X-Hstar-Filename':encodeURIComponent('测试图片.png'),
      }},
    ));
    vi.stubGlobal('fetch', fetchMock);

    await OS.openFile();

    expect(fetchMock).toHaveBeenCalledWith('/api/native/open-local-file', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({kind:'image'}),
    });
    expect(OS._handleFileLoad).toHaveBeenCalledOnce();
    const file = OS._handleFileLoad.mock.calls[0][0];
    expect(file).toBeInstanceOf(File);
    expect(file.name).toBe('测试图片.png');
    expect(file.type).toBe('image/png');
    expect(click).not.toHaveBeenCalled();
  });

  it('opens a PSD through the native backend without clicking the iframe input', async () => {
    const OS = loadOpenShop();
    quietUiMethods(OS);
    document.body.insertAdjacentHTML('beforeend', '<input id="psd-input" type="file">');
    const click = vi.spyOn(document.getElementById('psd-input'), 'click');
    OS._loadPSDFile = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(
      new Blob(['8BPS'], {type:'image/vnd.adobe.photoshop'}),
      {status:200, headers:{
        'Content-Type':'image/vnd.adobe.photoshop',
        'X-Hstar-Filename':encodeURIComponent('分层文件.psd'),
      }},
    )));

    await OS.openPSD();

    expect(OS._loadPSDFile).toHaveBeenCalledOnce();
    expect(OS._loadPSDFile.mock.calls[0][0]).toEqual(expect.objectContaining({
      name:'分层文件.psd',
      type:'image/vnd.adobe.photoshop',
    }));
    expect(click).not.toHaveBeenCalled();
  });

  it('keeps the document unchanged on cancel or Windows picker failure', async () => {
    const OS = loadOpenShop();
    quietUiMethods(OS);
    document.body.insertAdjacentHTML('beforeend', '<input id="file-input" type="file">');
    const click = vi.spyOn(document.getElementById('file-input'), 'click');
    OS._handleFileLoad = vi.fn();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, {status:204}))
      .mockResolvedValueOnce(new Response(
        JSON.stringify({detail:'独立文件窗口启动失败'}),
        {status:500, headers:{'Content-Type':'application/json'}},
      ));
    vi.stubGlobal('fetch', fetchMock);

    await OS.openFile();
    await OS.openFile();

    expect(OS._handleFileLoad).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    expect(OS.toast).toHaveBeenCalledWith('独立文件窗口启动失败', 'error');
  });

  it('falls back to browser input only when the backend reports an unsupported platform', async () => {
    const OS = loadOpenShop();
    quietUiMethods(OS);
    document.body.insertAdjacentHTML('beforeend', '<input id="psd-input" type="file">');
    const click = vi.spyOn(document.getElementById('psd-input'), 'click');
    OS._loadPSDFile = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(new Response(
      JSON.stringify({detail:'unsupported'}),
      {status:501, headers:{'Content-Type':'application/json'}},
    ));
    vi.stubGlobal('fetch', fetchMock);

    await OS.openPSD();

    expect(fetchMock).toHaveBeenCalledWith('/api/native/open-local-file', {
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({kind:'psd'}),
    });
    expect(click).toHaveBeenCalledOnce();
    expect(OS._loadPSDFile).not.toHaveBeenCalled();
  });

  it('fits an oversized opened image proportionally inside the current document', () => {
    const OS = loadOpenShop();
    const base = {name:'__boundary__', type:'rect'};
    const existing = {name:'Existing content', type:'rect'};
    const originalLayers = [
      {name:'Background', visible:true, locked:true, opacity:100, blend:'source-over', objects:[base]},
      {name:'Existing', visible:true, locked:false, opacity:100, blend:'source-over', objects:[existing]},
    ];
    OS.canvas = createCanvasMock([base, existing]);
    OS.layers = [...originalLayers];
    OS.activeLayerIdx = 1;
    OS.canvasW = 3840;
    OS.canvasH = 2160;
    OS._docName = 'existing-project';
    OS.history = [{action:'Before import'}];
    OS.historyIdx = 0;
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();
    OS.createNewDocument = vi.fn();
    const image = {
      width:9000,
      height:4000,
      type:'image',
      set:vi.fn(function set(values) { Object.assign(this, values); }),
      scaleToWidth:vi.fn(),
    };

    OS._addDecodedImageToCanvas(image, {name:'reference-wide.png', mode:'open'});

    expect(OS.createNewDocument).not.toHaveBeenCalled();
    expect(OS.canvasW).toBe(3840);
    expect(OS.canvasH).toBe(2160);
    expect(OS._docName).toBe('existing-project');
    expect(OS.layers.slice(0, 2)).toEqual(originalLayers);
    expect(OS.layers.at(-1)).toMatchObject({
      name:'reference-wide.png',
      visible:true,
      locked:false,
      opacity:100,
      blend:'source-over',
      objects:[image],
    });
    expect(image.set).toHaveBeenCalledWith(expect.objectContaining({
      left:0,
      name:'reference-wide.png',
    }));
    expect(image.scaleX).toBeCloseTo(3840 / 9000, 8);
    expect(image.scaleY).toBeCloseTo(3840 / 9000, 8);
    expect(image.left).toBeCloseTo(0, 8);
    expect(image.top).toBeCloseTo((2160 - 4000 * (3840 / 9000)) / 2, 8);
    expect(image.scaleToWidth).not.toHaveBeenCalled();
    expect(OS.canvas.setActiveObject).toHaveBeenCalledWith(image);
    expect(OS.saveHistory).toHaveBeenCalledOnce();
  });

  it('does not rename the document before an opened image finishes decoding', () => {
    const OS = loadOpenShop();
    OS._docName = 'existing-project';
    quietUiMethods(OS);
    class DeferredFileReader {
      readAsDataURL() {}
    }
    vi.stubGlobal('FileReader', DeferredFileReader);

    OS._handleFileLoad(new File(['image'], 'replacement.png', {type:'image/png'}));

    expect(OS._docName).toBe('existing-project');
  });

  it('imports GIF frames into one animation layer without rebuilding the document', async () => {
    const OS = loadOpenShop();
    const base = {name:'__boundary__', type:'rect'};
    const existing = {name:'Existing content', type:'rect'};
    const originalLayers = [
      {name:'Background', visible:true, locked:true, opacity:100, blend:'source-over', objects:[base]},
      {name:'Existing', visible:true, locked:false, opacity:100, blend:'source-over', objects:[existing]},
    ];
    OS.canvas = createCanvasMock([base, existing]);
    OS.layers = [...originalLayers];
    OS.activeLayerIdx = 1;
    OS.canvasW = 1920;
    OS.canvasH = 1080;
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();
    OS.createNewDocument = vi.fn();
    OS._renderFrames = vi.fn();
    document.body.insertAdjacentHTML('beforeend', '<div id="timeline-panel"></div>');
    const decodedImage = {
      width:320,
      height:180,
      type:'image',
      set:vi.fn(function set(values) { Object.assign(this, values); }),
    };
    fabric.Image = {
      fromURL:vi.fn((_source, callback) => callback(decodedImage)),
    };
    class FakeImageDecoder {
      constructor() {
        this.completed = Promise.resolve();
        this.tracks = {selectedTrack:{frameCount:3, frameWidth:320, frameHeight:180}};
      }
      async decode() {
        const frame = document.createElement('canvas');
        frame.width = 320;
        frame.height = 180;
        Object.defineProperties(frame, {
          displayWidth:{value:320},
          displayHeight:{value:180},
          close:{value:vi.fn()},
        });
        return {
          image:frame,
        };
      }
      close() {}
    }
    vi.stubGlobal('ImageDecoder', FakeImageDecoder);

    const gifFile = new File(['gif'], 'motion.gif', {type:'image/gif'});
    Object.defineProperty(gifFile, 'stream', {value:() => ({})});

    await OS._importGifFrames(gifFile);

    expect(OS.createNewDocument).not.toHaveBeenCalled();
    expect(OS.canvasW).toBe(1920);
    expect(OS.canvasH).toBe(1080);
    expect(OS.layers.slice(0, 2)).toEqual(originalLayers);
    expect(OS.layers.at(-1)).toMatchObject({
      name:'motion.gif',
      objects:[decodedImage],
    });
    expect(OS.layers.at(-1).animationFrames).toHaveLength(3);
    expect(OS._animFrames).toBe(OS.layers.at(-1).animationFrames);
    expect(OS.saveHistory).toHaveBeenCalledOnce();
  });

  it('switches an imported GIF frame without clearing unrelated layers', () => {
    const OS = loadOpenShop();
    const existing = {name:'Existing content', type:'rect'};
    const target = {
      name:'motion.gif',
      type:'image',
      setElement:vi.fn(),
      set:vi.fn(function set(values) { Object.assign(this, values); }),
      setCoords:vi.fn(),
    };
    const animationLayer = {
      name:'motion.gif',
      visible:true,
      locked:false,
      opacity:100,
      blend:'source-over',
      objects:[target],
      animationFrames:['frame-1', 'frame-2'],
    };
    OS.canvas = createCanvasMock([existing, target]);
    OS.canvas.clear = vi.fn();
    OS.layers = [
      {name:'Existing', visible:true, locked:false, opacity:100, blend:'source-over', objects:[existing]},
      animationLayer,
    ];
    OS.activeLayerIdx = 1;
    OS._activeAnimationLayer = animationLayer;
    OS._animFrames = animationLayer.animationFrames;
    OS._renderFrames = vi.fn();
    OS._makeBoundary = vi.fn(() => ({name:'__boundary__'}));
    quietUiMethods(OS);
    const frameElement = {};
    const frameImage = {
      width:320,
      height:180,
      type:'image',
      getElement:() => frameElement,
      set:vi.fn(),
    };
    fabric.Image = {
      fromURL:vi.fn((_source, callback) => callback(frameImage)),
    };

    OS.selectFrame(1);

    expect(OS.canvas.clear).not.toHaveBeenCalled();
    expect(OS.layers).toEqual([
      expect.objectContaining({name:'Existing'}),
      animationLayer,
    ]);
    expect(target.setElement).toHaveBeenCalledWith(frameElement);
    expect(OS._animIdx).toBe(1);
  });

  it('clears animation ownership when a new document replaces the workspace', () => {
    const OS = loadOpenShop();
    const oldLayer = {name:'motion.gif', animationFrames:['frame-1', 'frame-2'], objects:[]};
    OS.canvas = createCanvasMock([]);
    OS.canvas.clear = vi.fn();
    OS.canvas.setBackgroundColor = vi.fn((_color, callback) => callback());
    OS._createCheckerBoundary = vi.fn(() => ({name:'__boundary__'}));
    OS.zoomFit = vi.fn();
    OS.saveHistory = vi.fn();
    OS.updateLayersPanel = vi.fn();
    OS._captureBA = vi.fn();
    OS.addLayer = vi.fn(function addLayer() {
      const layer = {name:'Layer 1', visible:true, locked:false, opacity:100, blend:'source-over', objects:[]};
      this.layers.push(layer);
      this.activeLayerIdx = this.layers.length - 1;
    });
    document.body.insertAdjacentHTML('beforeend', `
      <span id="canvas-dims"></span>
      <div id="timeline-panel" class="visible"></div>
      <button id="tl-play" class="active"></button>
    `);
    OS._activeAnimationLayer = oldLayer;
    OS._animFrames = oldLayer.animationFrames;
    OS._animIdx = 1;
    OS._animPlaying = true;
    OS._animTimer = setInterval(() => {}, 1000);

    OS.createNewDocument(1024, 768);

    expect(OS._activeAnimationLayer).toBeNull();
    expect(OS._animFrames).toEqual([]);
    expect(OS._animIdx).toBe(0);
    expect(OS._animPlaying).toBe(false);
    expect(OS._animTimer).toBeNull();
    expect(document.getElementById('timeline-panel').classList.contains('visible')).toBe(false);
    expect(document.getElementById('tl-play').classList.contains('active')).toBe(false);
  });

  it('uses the composited canvas sampler for the eyedropper tool', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(() => ({x:120, y:80}));
    OS.canvas.getContext = vi.fn(() => ({
      getImageData:() => ({data:new Uint8ClampedArray([0, 0, 0, 255])}),
    }));
    OS.canvasW = 800;
    OS.canvasH = 600;
    OS.state.tool = 'eyedropper';
    quietUiMethods(OS);
    OS.setFgColor = vi.fn();
    const sample = vi.fn(() => ({
      red:51,
      green:102,
      blue:153,
      alpha:255,
      hex:'#336699',
    }));
    window.HstarOpenShopCanvasSampler = {sample};
    const event = {clientX:280, clientY:190};

    OS.onMouseDown({e:event});

    expect(sample).toHaveBeenCalledWith({
      canvas:OS.canvas,
      event,
      documentPoint:{x:120, y:80},
      documentWidth:800,
      documentHeight:600,
    });
    expect(OS.setFgColor).toHaveBeenCalledWith('#336699');
    expect(OS.toast).toHaveBeenCalledWith('Picked: #336699', 'info');
  });

  it('keeps the foreground color unchanged when eyedropper sampling fails', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(() => ({x:-5, y:20}));
    OS.canvas.getContext = vi.fn(() => ({
      getImageData:() => ({data:new Uint8ClampedArray([0, 0, 0, 255])}),
    }));
    OS.canvasW = 800;
    OS.canvasH = 600;
    OS.state.tool = 'eyedropper';
    OS.state.fgColor = '#abcdef';
    quietUiMethods(OS);
    OS.setFgColor = vi.fn();
    window.HstarOpenShopCanvasSampler = {
      sample:vi.fn(() => { throw new Error('Canvas color could not be sampled'); }),
    };

    OS.onMouseDown({e:{clientX:1, clientY:1}});

    expect(OS.setFgColor).not.toHaveBeenCalled();
    expect(OS.state.fgColor).toBe('#abcdef');
    expect(OS.toast).toHaveBeenCalledWith('Canvas color could not be sampled', 'error');
  });

  it('routes the next canvas click to an armed color-panel sampler', () => {
    const OS = loadOpenShop();
    const event = {offsetX:14, offsetY:18};
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(() => ({x:14, y:18}));
    OS._colorPanelController = {
      getState:vi.fn(() => ({sampling:true})),
      handleCanvasSample:vi.fn(() => true),
    };
    quietUiMethods(OS);

    OS.onMouseDown({e:event, target:null});

    expect(OS._colorPanelController.handleCanvasSample).toHaveBeenCalledWith({
      event,
      documentPoint:{x:14, y:18},
    });
  });

  it('records history immediately while scheduling derived panel updates', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([{name:'Shape', type:'rect'}]);
    OS.layers = [
      {name:'Layer 0', visible:true, locked:false, opacity:100, blend:'source-over', objects:[]},
    ];
    OS.history = [];
    OS.historyIdx = -1;
    const frameQueue = [];
    const idleQueue = [];
    document.body.insertAdjacentHTML('beforeend', '<div id="ptg3-nav" class="active"></div>');
    OS.updateHistoryPanel = vi.fn();
    OS.updateStatus = vi.fn();
    OS.updateMinimap = vi.fn();
    OS.updateHistogram = vi.fn();
    OS._renderMinimap = vi.fn();
    OS._renderHistogram = vi.fn();
    OS.recordMacroStep = vi.fn();
    OS._initUpdateScheduler({
      frameRequest:callback => { frameQueue.push(callback); return frameQueue.length; },
      idleRequest:callback => { idleQueue.push(callback); return idleQueue.length; },
    });

    OS.saveHistory('Shape changed');

    expect(OS.history).toHaveLength(1);
    expect(OS.historyIdx).toBe(0);
    expect(OS.updateHistoryPanel).not.toHaveBeenCalled();
    expect(OS.updateStatus).not.toHaveBeenCalled();
    expect(OS.updateMinimap).not.toHaveBeenCalled();
    expect(OS.updateHistogram).not.toHaveBeenCalled();
    expect(OS._renderMinimap).not.toHaveBeenCalled();
    expect(OS._renderHistogram).not.toHaveBeenCalled();
    expect(frameQueue).toHaveLength(1);
    expect(idleQueue).toHaveLength(1);

    frameQueue.shift()();
    expect(OS.updateHistoryPanel).toHaveBeenCalledOnce();
    expect(OS.updateStatus).toHaveBeenCalledOnce();
    expect(OS._renderMinimap).not.toHaveBeenCalled();

    idleQueue.shift()({didTimeout:false, timeRemaining:() => 10});
    expect(OS._renderMinimap).toHaveBeenCalledOnce();
    expect(OS._renderHistogram).toHaveBeenCalledOnce();
  });

  it('adds and deletes layers while keeping canvas objects in sync', () => {
    const OS = loadOpenShop();
    const canvasObject = { name: 'Pixel Layer', type: 'image' };
    OS.canvas = createCanvasMock([canvasObject]);
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();

    OS.addLayer();

    expect(OS.layers).toHaveLength(1);
    expect(OS.layers[0].name).toBe('Layer 0');
    expect(OS.activeLayerIdx).toBe(0);
    expect(OS.saveHistory).toHaveBeenCalledWith('New Layer');

    OS.layers[0].objects.push(canvasObject);
    OS.deleteLayer();

    expect(OS.canvas.remove).toHaveBeenCalledWith(canvasObject);
    expect(OS.layers).toHaveLength(1);
    expect(OS.layers[0].name).toBe('Layer 0');
    expect(OS.layers[0].objects).toHaveLength(0);
    expect(OS.saveHistory).toHaveBeenCalledWith('Delete Layer');
  });

  it('removes an unlocked object layer when its last object is deleted', () => {
    const OS = loadOpenShop();
    const boundary = {name:'__boundary__', type:'rect'};
    const object = {name:'Only object', type:'rect'};
    OS.canvas = createCanvasMock([boundary, object]);
    quietUiMethods(OS);
    OS.layers = [
      {name:'Background', locked:true, visible:true, opacity:100, blend:'source-over', objects:[boundary]},
      {name:'Object layer', locked:false, visible:true, opacity:100, blend:'source-over', objects:[object]},
    ];
    OS.activeLayerIdx = 1;
    OS._resetLayerSelection(OS.layers[1]);
    OS.canvas.setActiveObject(object);
    OS.saveHistory = vi.fn();

    OS._deleteSelected();

    expect(OS.canvas.remove).toHaveBeenCalledWith(object);
    expect(OS.layers.map(layer => layer.name)).toEqual(['Background']);
    expect(OS.layers[0].objects).toEqual([boundary]);
    expect(OS.activeLayerIdx).toBe(0);
    expect(OS._selectedLayerIndices()).toEqual([0]);
    expect(OS.saveHistory).toHaveBeenCalledOnce();
    expect(OS.saveHistory).toHaveBeenCalledWith('Delete');
  });

  it('renders live image thumbnails for non-text layers only', () => {
    const OS = loadOpenShop();
    const source = document.createElement('canvas');
    source.width = 120;
    source.height = 60;
    const shape = {
      name:'Card', type:'rect', visible:true, opacity:1,
      getBoundingRect:vi.fn(() => ({left:40, top:20, width:120, height:60})),
      toCanvasElement:vi.fn(() => source),
    };
    const textObject = {name:'Title', type:'i-text', text:'Title'};
    OS.canvas = createCanvasMock([shape, textObject]);
    quietUiMethods(OS, {keepLayersPanel:true});
    OS.canvasW = 200;
    OS.canvasH = 100;
    OS.layers = [
      {name:'Shape', locked:false, visible:true, opacity:100, blend:'source-over', objects:[shape]},
      {name:'Text', locked:false, visible:true, opacity:100, blend:'source-over', objects:[textObject]},
    ];
    OS.activeLayerIdx = 0;
    OS._resetLayerSelection(OS.layers[0]);

    OS.updateLayersPanel();

    const shapeRow = document.querySelector('[data-layer-index="0"]');
    const textRow = document.querySelector('[data-layer-index="1"]');
    const thumbnail = shapeRow.querySelector('.layer-thumb-canvas');
    expect(thumbnail).toBeInstanceOf(HTMLCanvasElement);
    expect(shape.toCanvasElement).toHaveBeenCalledWith({
      multiplier:expect.any(Number),
      enableRetinaScaling:false,
    });
    expect(shape.toCanvasElement.mock.calls[0][0].multiplier).toBeLessThanOrEqual(1);
    expect(thumbnail.getContext('2d').drawImage).toHaveBeenCalled();
    expect(textRow.querySelector('.layer-thumb')).toBeNull();

    OS._refreshLayerThumbnail(OS.layers[0]);

    expect(shape.toCanvasElement).toHaveBeenCalledTimes(2);
    expect(shapeRow.querySelector('.layer-thumb-canvas')).toBe(thumbnail);
  });

  it('does not render the OpenShop logo in the top menu', () => {
    const html = readFileSync(resolve(testDir, '..', 'index.html'), 'utf8');

    expect(html).not.toMatch(/<div class="logo"[^>]*>\s*OpenShop/i);
  });

  it('renders primary and additive layer selections from mouse modifiers', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS, {keepLayersPanel:true});
    OS.layers = ['A', 'B', 'C', 'D'].map(name => ({
      name, visible:true, locked:false, opacity:100, blend:'source-over', objects:[],
    }));
    OS._resetLayerSelection(OS.layers[1]);
    OS.updateLayersPanel();

    OS.selectLayer(3, new MouseEvent('click', {shiftKey:true}));
    expect(OS._selectedLayerIndices()).toEqual([1, 2, 3]);
    expect(OS.activeLayerIdx).toBe(3);

    OS.selectLayer(0, new MouseEvent('click', {ctrlKey:true}));
    expect(OS._selectedLayerIndices()).toEqual([0, 1, 2, 3]);
    expect(OS.activeLayerIdx).toBe(0);
    expect(document.querySelectorAll('.layer-item.selected')).toHaveLength(4);
    expect(document.querySelectorAll('.layer-item.primary')).toHaveLength(1);
    expect(document.querySelector('.layer-item.primary').getAttribute('aria-selected')).toBe('true');
    expect(OS._keyboardContext).toBe('layers');
  });

  it('activates the canvas object when its layer row is selected', () => {
    const OS = loadOpenShop();
    const text = {type:'i-text', name:'Title', visible:true};
    OS.canvas = createCanvasMock([text]);
    quietUiMethods(OS, {keepLayersPanel:true});
    OS.layers = [
      {name:'Title', visible:true, locked:false, opacity:100, blend:'source-over', objects:[text]},
    ];
    OS._resetLayerSelection(OS.layers[0]);

    OS.selectLayer(0);

    expect(OS.canvas.setActiveObject).toHaveBeenCalledWith(text);
    expect(OS.canvas.getActiveObject()).toBe(text);
    expect(OS.canvas.discardActiveObject).not.toHaveBeenCalled();
    expect(OS._keyboardContext).toBe('layers');
  });

  it('creates a canvas active selection for multiple selected layer rows without selection feedback', () => {
    const OS = loadOpenShop();
    const lower = {type:'rect', name:'Lower', visible:true};
    const upper = {type:'i-text', name:'Upper', visible:true};
    OS.canvas = createCanvasMock([lower, upper]);
    quietUiMethods(OS, {keepLayersPanel:true});
    OS.layers = [
      {name:'Lower', visible:true, locked:false, opacity:100, blend:'source-over', objects:[lower]},
      {name:'Upper', visible:true, locked:false, opacity:100, blend:'source-over', objects:[upper]},
    ];
    OS._resetLayerSelection(OS.layers[0]);

    OS.selectLayer(0);
    OS.selectLayer(1, {ctrlKey:true});

    const activeSelection = OS.canvas.setActiveObject.mock.calls.at(-1)[0];
    expect(activeSelection).toMatchObject({type:'activeSelection', canvas:OS.canvas});
    expect(activeSelection._objects).toEqual([lower, upper]);
    expect(OS._selectedLayerIndices()).toEqual([0, 1]);

    OS._syncingCanvasSelectionFromLayers = true;
    expect(OS._syncLayerSelectionFromCanvasSelection({target:lower, selected:[lower]})).toBe(false);
    expect(OS._selectedLayerIndices()).toEqual([0, 1]);
    OS._syncingCanvasSelectionFromLayers = false;
  });

  it('renders a fixed artistic-font action per text layer with eligibility and busy state', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS, {keepLayersPanel:true});
    OS.updateInfoPanel = vi.fn();
    OS.setLocale('zh-CN');
    const eligible = {
      type:'hstar-vertical-text', text:'OCR\n标题', hstarLayerId:'text-layer-1',
      hstarOcrSourceAssetId:'a'.repeat(64), hstarOcrSourceLayerId:'source-layer-1',
      hstarOcrBlockId:'ocr-title',
      hstarOcrQuad:[{x:.1,y:.2},{x:.4,y:.2},{x:.4,y:.3},{x:.1,y:.3}],
      hstarOcrVisualProfile:{writingMode:'vertical', script:'zh-hans', fill:'#112233'},
      hstarOcrOriginalText:'Original OCR title',
    };
    const manual = {type:'i-text', text:'Manual', hstarLayerId:'text-layer-2'};
    OS.layers = [
      {layerId:'text-layer-1',name:'OCR title',visible:true,locked:false,opacity:100,blend:'source-over',objects:[eligible]},
      {layerId:'text-layer-2',name:'Manual',visible:true,locked:false,opacity:100,blend:'source-over',objects:[manual]},
      {layerId:'source-layer-1',name:'Source',visible:true,locked:false,opacity:100,blend:'source-over',objects:[]},
    ];
    OS.activeLayerIdx = 0;
    OS._selectedLayers = new Set([OS.layers[0]]);
    window.HstarOpenShopTextToolsController = {isArtFontBusy:vi.fn(layerId => layerId === 'text-layer-1')};
    const dispatched = vi.fn();
    window.addEventListener('openshop:art-font-restore', dispatched, {once:true});

    OS.updateLayersPanel();

    const enabled = document.querySelector('[data-layer-index="0"] .layer-art-font');
    const disabled = document.querySelector('[data-layer-index="1"] .layer-art-font');
    expect(enabled).toBeTruthy();
    expect(enabled.classList.contains('busy')).toBe(true);
    expect(enabled.disabled).toBe(true);
    expect(enabled.title).toBe('艺术字体处理中');
    expect(disabled.disabled).toBe(true);
    expect(disabled.title).toBe('没有原图参考');
    expect(readFileSync(resolve(testDir, '..', 'index.html'), 'utf8'))
      .toMatch(/\.layer-art-font\s*\{[^}]*width:24px;[^}]*height:24px;/s);

    window.HstarOpenShopTextToolsController.isArtFontBusy.mockReturnValue(false);
    OS.updateLayersPanel();
    const action = document.querySelector('[data-layer-index="0"] .layer-art-font');
    expect(action.title).toBe('艺术字体处理');
    action.click();
    expect(OS.activeLayerIdx).toBe(0);
    expect(dispatched).toHaveBeenCalledOnce();
    expect(dispatched.mock.calls[0][0].detail).toEqual({layerId:'text-layer-1'});

    OS.layers = OS.layers.filter(layer => layer.layerId !== 'source-layer-1');
    OS.updateLayersPanel();
    const missingSource = document.querySelector('[data-layer-index="0"] .layer-art-font');
    expect(missingSource.disabled).toBe(true);
    expect(missingSource.title).toBe('没有原图参考');
    delete window.HstarOpenShopTextToolsController;
  });

  it('applies text effects to editable vertical text', () => {
    const OS = loadOpenShop();
    const vertical = {
      type:'hstar-vertical-text', text:'甲乙\n丙丁', set:vi.fn(function set(...args) {
        if(typeof args[0] === 'string') this[args[0]] = args[1];
        else Object.assign(this, args[0]);
      }),
    };
    OS.canvas = createCanvasMock([vertical]);
    OS.canvas.setActiveObject(vertical);
    quietUiMethods(OS);
    document.body.insertAdjacentHTML('beforeend', `
      <input id="tfx-sx" value="2"><input id="tfx-sy" value="3">
      <input id="tfx-blur" value="4"><input id="tfx-color" value="#112233">
      <input id="tfx-stroke" value="2"><input id="tfx-stroke-color" value="#445566">`);

    OS.applyTextFx();

    expect(vertical.set).toHaveBeenCalled();
    expect(vertical.stroke).toBe('#445566');
    expect(vertical.shadow).toEqual(expect.objectContaining({offsetX:2, offsetY:3, blur:4}));
  });

  it('counts editable vertical text in image information', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([
      {type:'hstar-vertical-text', text:'甲乙\n丙丁'},
      {type:'rect'},
    ]);
    OS.layers = [{objects:[]}, {objects:[]}];

    OS.showImageInfo();

    const values = [...document.querySelectorAll('.info-grid dd')].map(item => item.textContent);
    expect(values[4]).toBe('1');
    expect(values[5]).toBe('1');
  });

  it('keeps a layer row mounted so double-click can start rename after selection', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS, {keepLayersPanel:true});
    OS.layers = ['A', 'B'].map(name => ({
      name, visible:true, locked:false, opacity:100, blend:'source-over', objects:[],
    }));
    OS.activeLayerIdx = 1;
    OS._resetLayerSelection(OS.layers[1]);
    OS.updateLayersPanel();
    const name = [...document.querySelectorAll('.layer-name')]
      .find(element => element.textContent === 'A');

    name.dispatchEvent(new MouseEvent('click', {bubbles:true}));
    name.dispatchEvent(new MouseEvent('dblclick', {bubbles:true}));

    expect(OS.activeLayerIdx).toBe(0);
    expect(document.querySelector('.layer-name-input')).not.toBeNull();
  });

  it('deletes selected unlocked layers in one history entry and keeps locked layers', () => {
    const OS = loadOpenShop();
    const objects = [{name:'A'}, {name:'B'}, {name:'Locked'}];
    OS.canvas = createCanvasMock(objects);
    quietUiMethods(OS);
    OS.layers = [
      {name:'Background', locked:true, visible:true, opacity:100, blend:'source-over', objects:[objects[2]]},
      {name:'A', locked:false, visible:true, opacity:100, blend:'source-over', objects:[objects[0]]},
      {name:'B', locked:false, visible:true, opacity:100, blend:'source-over', objects:[objects[1]]},
    ];
    OS._selectedLayers = new Set(OS.layers);
    OS.activeLayerIdx = 2;
    OS.saveHistory = vi.fn();

    OS.deleteLayers();

    expect(OS.layers.map(layer => layer.name)).toEqual(['Background']);
    expect(OS.canvas.remove).toHaveBeenCalledWith(objects[0]);
    expect(OS.canvas.remove).toHaveBeenCalledWith(objects[1]);
    expect(OS.canvas.remove).not.toHaveBeenCalledWith(objects[2]);
    expect(OS.saveHistory).toHaveBeenCalledTimes(1);
  });

  it('applies opacity and blend to every selected layer', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.layers = ['A', 'B', 'C'].map(name => ({
      name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[],
    }));
    OS._selectedLayers = new Set([OS.layers[0], OS.layers[2]]);
    OS.saveHistory = vi.fn();

    OS.setLayerOpacity(42);
    expect(OS.saveHistory).not.toHaveBeenCalled();
    OS.commitLayerOpacity();
    OS.setLayerBlend('multiply');

    expect(OS.layers.map(layer => layer.opacity)).toEqual([42, 100, 42]);
    expect(OS.layers.map(layer => layer.blend)).toEqual(['multiply', 'source-over', 'multiply']);
    expect(OS.saveHistory).toHaveBeenNthCalledWith(1, 'Layer Opacity');
    expect(OS.saveHistory).toHaveBeenNthCalledWith(2, 'Blend: multiply');
  });

  it('duplicates selected empty layers as one ordered block above the highest selection', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.layers = ['A', 'B', 'C'].map(name => ({
      name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[],
    }));
    OS._selectedLayers = new Set([OS.layers[0], OS.layers[2]]);
    OS.activeLayerIdx = 2;
    OS.saveHistory = vi.fn();

    OS.duplicateLayer();

    expect(OS.layers.map(layer => layer.name)).toEqual(['A', 'B', 'C', 'A Copy', 'C Copy']);
    expect(OS._selectedLayerList().map(layer => layer.name)).toEqual(['A Copy', 'C Copy']);
    expect(OS.saveHistory).toHaveBeenCalledTimes(1);
  });

  it('propagates clicked visibility and lock state to selected rows', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.layers = ['A', 'B', 'C'].map(name => ({
      name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[],
    }));
    OS._selectedLayers = new Set([OS.layers[0], OS.layers[2]]);
    OS.saveHistory = vi.fn();

    OS.toggleLayerVisibility(0);
    OS.toggleLayerLock(0);

    expect(OS.layers.map(layer => layer.visible)).toEqual([false, true, false]);
    expect(OS.layers.map(layer => layer.locked)).toEqual([true, false, true]);
    expect(OS.saveHistory).toHaveBeenCalledTimes(2);
  });

  it('moves selected layers as an ordered block and merges selected layers once', () => {
    const OS = loadOpenShop();
    const objects = ['A', 'B', 'C', 'D'].map(name => ({name}));
    OS.canvas = createCanvasMock(objects);
    quietUiMethods(OS);
    OS.layers = objects.map(object => ({
      name:object.name, locked:false, visible:true, opacity:100, blend:'source-over', objects:[object],
    }));
    OS._selectedLayers = new Set([OS.layers[1], OS.layers[3]]);
    OS.activeLayerIdx = 3;
    OS.saveHistory = vi.fn();

    OS._moveSelectedLayersToIndex(0);
    expect(OS.layers.map(layer => layer.name)).toEqual(['B', 'D', 'A', 'C']);
    expect(OS.saveHistory).toHaveBeenLastCalledWith('Reorder Layers');

    OS.mergeSelectedOrDown();
    expect(OS.layers.map(layer => layer.name)).toEqual(['B', 'A', 'C']);
    expect(OS.layers[0].objects.map(object => object.name)).toEqual(['B', 'D']);
    expect(OS.saveHistory).toHaveBeenLastCalledWith('Merge Layers');
  });

  it('leaves selected locked layers in place during block movement', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.layers = ['A', 'B', 'C', 'D'].map(name => ({
      name, locked:name === 'B', visible:true, opacity:100, blend:'source-over', objects:[],
    }));
    OS._selectedLayers = new Set([OS.layers[1], OS.layers[3]]);
    OS.activeLayerIdx = 3;
    OS.saveHistory = vi.fn();

    OS._moveSelectedLayersToIndex(0);

    expect(OS.layers.map(layer => layer.name)).toEqual(['D', 'A', 'B', 'C']);
    expect(OS.toast).toHaveBeenCalledWith('Skipped 1 locked layers', 'info');
  });

  it('restores prior snapshots through undo and redo', () => {
    const OS = loadOpenShop();
    const canvas = createCanvasMock();
    let snapshotName = 'Initial';
    const provenance = {
      hstarOcrSourceAssetId:'f'.repeat(64),
      hstarOcrSourceLayerId:'layer-source',
      hstarOcrBlockId:'ocr-title',
      hstarOcrQuad:[{x:0.1,y:0.2},{x:0.4,y:0.2},{x:0.4,y:0.3},{x:0.1,y:0.3}],
      hstarOcrVisualProfile:{script:'zh-hans', fill:'#112233', weight:700},
      hstarOcrOriginalText:'Original OCR',
      hstarArtFontRequestGeneration:0,
      hstarAiGeneration:ART_GENERATION,
      hstarOcrConfidence:0.98,
      hstarOcrLanguage:'zh',
      hstarOcrFontCandidates:['01免Title Face'],
    };
    canvas.toJSON = vi.fn(properties => ({
      objects:[{
        name:snapshotName,
        ...Object.fromEntries(properties
          .filter(property => property in provenance)
          .map(property => [property, provenance[property]])),
      }],
    }));
    const restored = [];
    canvas.loadFromJSON = vi.fn((json, callback) => {
      restored.push(json);
      callback();
    });
    OS.canvas = canvas;
    quietUiMethods(OS);
    OS.rebuildLayersFromCanvas = vi.fn();
    OS.setTool = vi.fn();

    OS.saveHistory('Initial');
    snapshotName = 'Edited';
    OS.saveHistory('Edited');

    OS.undo();
    OS.redo();

    expect(restored.map(json => json.objects[0].name)).toEqual(['Initial', 'Edited']);
    expect(restored[0].objects[0]).toMatchObject(provenance);
    expect(restored[1].objects[0]).toMatchObject(provenance);
    expect(OS.historyIdx).toBe(1);
    expect(OS.setTool).toHaveBeenCalledWith('select', {forceInteraction:true});
  });

  it('undoes an applied artistic-font raster, reveals its carrier and terminals the matching record', () => {
    const OS = loadOpenShop();
    const carrier = {
      type:'i-text', text:'Edited title', name:'Carrier', visible:true, hstarLayerId:'text-layer-1',
      hstarArtFontRequestGeneration:1,
    };
    const canvas = createCanvasMock([carrier]);
    canvas.toJSON = vi.fn(properties => ({
      objects:canvas.objects.map(object => ({
        type:object.type, text:object.text, name:object.name, visible:object.visible,
        ...Object.fromEntries(properties.filter(property => property in object).map(property => [property, object[property]])),
      })),
    }));
    canvas.loadFromJSON = vi.fn((json, callback) => {
      canvas.objects.splice(0, canvas.objects.length, ...json.objects.map(object => ({...object})));
      callback();
    });
    OS.canvas = canvas;
    OS.layers = [{
      layerId:'text-layer-1', name:'Carrier', visible:true, locked:false,
      opacity:100, blend:'source-over', objects:[carrier],
    }];
    OS.activeLayerIdx = 0;
    OS._selectedLayers = new Set([OS.layers[0]]);
    OS.__hstarAiTaskRecords = [{
      taskId:'task-art-1', toolId:'art-font-restore', status:'succeeded', reconcileState:'applied',
      reconcileReason:'', generatedLayerId:'generated-layer-1', snapshot:{
        textLayerId:'text-layer-1', requestGeneration:1,
      }, outputAssetId:'c'.repeat(64), discardedAt:0, updatedAt:1,
    }];
    quietUiMethods(OS);
    OS.setTool = vi.fn();
    const restoredEvents = vi.fn();
    window.addEventListener('openshop:history-restored', restoredEvents);
    OS.saveHistory('Before artistic font');

    carrier.visible = false;
    OS.layers[0].visible = false;
    const raster = {
      type:'image', name:'Art font', visible:true, hstarLayerId:'generated-layer-1',
      hstarAiGeneration:ART_GENERATION,
    };
    canvas.add(raster);
    OS.layers.push({
      layerId:'generated-layer-1', name:'Art font', visible:true, locked:false,
      opacity:100, blend:'source-over', objects:[raster], hstarAiGeneration:ART_GENERATION,
    });
    OS.saveHistory('艺术字体处理');

    OS.undo();

    expect(canvas.getObjects()).toHaveLength(1);
    expect(canvas.getObjects()[0]).toMatchObject({hstarLayerId:'text-layer-1', visible:true});
    expect(OS.layers.map(layer => layer.layerId)).toEqual(['text-layer-1']);
    expect(OS.layers[0].visible).toBe(true);
    expect(OS.__hstarAiTaskRecords[0]).toMatchObject({
      reconcileState:'discarded', reconcileReason:'undone', generatedLayerId:'generated-layer-1',
    });
    expect(OS.__hstarAiTaskRecords[0].discardedAt).toBeGreaterThan(0);
    expect(restoredEvents).toHaveBeenCalledOnce();

    OS.redo();

    const redoneRasters = canvas.getObjects().filter(object => object.hstarAiGeneration?.taskId === 'task-art-1');
    expect(redoneRasters).toHaveLength(1);
    expect(redoneRasters[0].hstarAiGeneration).toEqual(ART_GENERATION);
    expect(OS.layers.filter(layer => layer.hstarAiGeneration?.taskId === 'task-art-1')).toHaveLength(1);
    expect(OS.layers.find(layer => layer.layerId === 'text-layer-1')).toMatchObject({visible:false});
    expect(OS.__hstarAiTaskRecords[0]).toMatchObject({reconcileState:'discarded', reconcileReason:'undone'});
    OS._reconcileArtFontHistoryRestore();
    expect(canvas.getObjects().filter(object => object.hstarAiGeneration?.taskId === 'task-art-1')).toHaveLength(1);
    expect(restoredEvents).toHaveBeenCalledTimes(2);
    window.removeEventListener('openshop:history-restored', restoredEvents);
  });

  it('keeps the text kerning mode in history snapshots', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);

    OS.saveHistory('Text Kerning');

    expect(OS.canvas.toJSON).toHaveBeenCalledWith(expect.arrayContaining(['hstarKerningMode']));
    expect(OS.canvas.toJSON).toHaveBeenCalledWith(expect.arrayContaining(OCR_CUSTOM_PROPERTIES));
    expect(OS.canvas.toJSON).toHaveBeenCalledWith(expect.arrayContaining(['hstarAiGeneration']));
  });

  it('creates an original-size PNG artifact and restores viewport and boundary state', async () => {
    const OS = loadOpenShop();
    const boundary = {
      name: '__boundary__',
      opacity: 1,
      fill: '#ffffff',
      visible: true,
      set(property, value) {
        this[property] = value;
      }
    };
    OS.canvas = createCanvasMock([boundary]);
    quietUiMethods(OS);
    OS.canvasW = 3840;
    OS.canvasH = 2160;
    OS.canvas.viewportTransform = [0.5, 0, 0, 0.5, 120, 80];
    OS._docName = 'Client Proof 01';

    const artifact = await OS._createExportArtifact('png');

    expect(artifact).toMatchObject({
      filename: 'Client Proof 01.png',
      format: 'png',
      mimeType: 'image/png',
      width: 3840,
      height: 2160,
    });
    expect(artifact.blob).toBeInstanceOf(Blob);
    expect(OS.canvas.toDataURL).toHaveBeenCalledWith({
      format: 'png',
      quality: 1,
      left: 0,
      top: 0,
      width: 3840,
      height: 2160,
      multiplier: 1,
    });
    expect(OS.canvas.viewportTransform).toEqual([0.5, 0, 0, 0.5, 120, 80]);
    expect(boundary.opacity).toBe(1);
    expect(boundary.fill).toBe('#ffffff');
    expect(boundary.visible).toBe(true);
  });

  it('restores editor state when raster encoding throws', async () => {
    const OS = loadOpenShop();
    const boundary = {
      name: '__boundary__', opacity: 0.75, fill: '#eeeeee', visible: true,
      set(property, value) { this[property] = value; },
    };
    OS.canvas = createCanvasMock([boundary]);
    OS.canvas.viewportTransform = [2, 0, 0, 2, -10, -20];
    OS.canvas.toDataURL.mockImplementation(() => { throw new Error('encode failed'); });

    await expect(OS._createExportArtifact('jpeg')).rejects.toThrow('encode failed');

    expect(OS.canvas.viewportTransform).toEqual([2, 0, 0, 2, -10, -20]);
    expect(boundary).toMatchObject({opacity:0.75, fill:'#eeeeee', visible:true});
  });

  it('routes all public export formats and batch export through one native service', async () => {
    const OS = loadOpenShop();
    window.HstarOpenShopI18n.setLocale('zh-CN');
    OS.canvas = createCanvasMock([]);
    quietUiMethods(OS);
    OS._exportService = {
      saveFormat: vi.fn(async format => ({ok:true, filename:`saved.${format}`})),
      saveBatch: vi.fn(async formats => ({ok:true, count:formats.length})),
    };

    for (const format of ['png','jpeg','webp','svg','pdf','psd']) {
      await OS.saveFile(format);
    }
    await OS._saveBatchFormats(['png','jpeg','webp','svg','pdf','psd']);

    expect(OS._exportService.saveFormat.mock.calls.map(([format]) => format)).toEqual([
      'png','jpeg','webp','svg','pdf','psd',
    ]);
    expect(OS._exportService.saveBatch).toHaveBeenCalledTimes(1);
    expect(OS._exportService.saveBatch).toHaveBeenCalledWith(['png','jpeg','webp','svg','pdf','psd']);
    expect(OS.toast).toHaveBeenCalledWith('已保存：saved.png', 'success');
  });

  it('shows six batch formats and saves them with one service call', async () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    quietUiMethods(OS);
    OS._saveBatchFormats = vi.fn(async formats => ({ok:true, count:formats.length}));

    OS.batchExport();
    const overlay = document.querySelector('.modal-overlay');
    const formats = ['png','jpeg','webp','svg','pdf','psd'];
    expect(formats.every(format => overlay.querySelector(`#batch-${format}`))).toBe(true);

    overlay.querySelector('[data-modal-action]').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(OS._saveBatchFormats).toHaveBeenCalledTimes(1);
    expect(OS._saveBatchFormats).toHaveBeenCalledWith(formats);
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('routes export settings through native save with explicit options', async () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    quietUiMethods(OS);
    OS.saveFile = vi.fn(async () => ({ok:true, filename:'settings.webp'}));

    OS.showExportSettings();
    const overlay = document.querySelector('.modal-overlay');
    overlay.querySelector('[data-fmt="webp"]').click();
    overlay.querySelector('#es-quality').value = '77';
    overlay.querySelector('#es-scale').value = '2';
    overlay.querySelector('#es-transparent').checked = true;
    overlay.querySelector('[data-modal-action]').click();
    await Promise.resolve();
    await Promise.resolve();

    expect(OS.saveFile).toHaveBeenCalledWith('webp', {
      quality:0.77,
      scale:2,
      transparent:true,
    });
    expect(document.body.contains(overlay)).toBe(false);
  });

  it('routes keyboard shortcuts to undo, redo, save, and tool selection', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.undo = vi.fn();
    OS.redo = vi.fn();
    OS.saveProject = vi.fn();
    OS.setTool = vi.fn(tool => { OS.state.tool = tool; });

    OS._initKeyboardShortcuts();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, shiftKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'b', bubbles: true }));
    OS.state.textWritingMode = 'vertical';
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', bubbles: true }));
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 't', shiftKey: true, bubbles: true }));

    expect(OS.undo).toHaveBeenCalledTimes(1);
    expect(OS.redo).toHaveBeenCalledTimes(1);
    expect(OS.saveProject).toHaveBeenCalledTimes(1);
    expect(OS.setTool).toHaveBeenCalledWith('brush');
    expect(OS.setTool).toHaveBeenCalledWith('text-horizontal');
    expect(OS.setTool).toHaveBeenCalledWith('text-vertical');
  });

  it('routes Delete to layers or canvas according to the last editing context', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([{name:'Canvas Object'}]);
    quietUiMethods(OS);
    OS.deleteLayers = vi.fn();
    OS._deleteSelected = vi.fn();
    OS._initKeyboardShortcuts();

    OS._keyboardContext = 'layers';
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));
    expect(OS.deleteLayers).toHaveBeenCalledOnce();

    OS._keyboardContext = 'canvas';
    OS.canvas.setActiveObject(OS.canvas.getObjects()[0]);
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));
    expect(OS._deleteSelected).toHaveBeenCalledOnce();
  });

  it('does not run editor shortcuts while an editable target or Fabric text is active', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.deleteLayers = vi.fn();
    OS.setTool = vi.fn();
    OS._initKeyboardShortcuts();

    const input = document.createElement('input');
    document.body.appendChild(input);
    input.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));

    const editable = document.createElement('div');
    editable.setAttribute('contenteditable', 'true');
    document.body.appendChild(editable);
    editable.dispatchEvent(new KeyboardEvent('keydown', {key:'b', bubbles:true}));

    OS.canvas.setActiveObject({type:'i-text', isEditing:true});
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Delete', bubbles:true}));

    expect(OS.deleteLayers).not.toHaveBeenCalled();
    expect(OS.setTool).not.toHaveBeenCalled();
  });

  it('uses Ctrl+K for preferences and Ctrl+Alt+K for the command palette once', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.showPreferences = vi.fn();
    OS.toggleCmdPalette = vi.fn();
    OS.initCmdPalette();
    OS._initKeyboardShortcuts();

    document.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, bubbles:true}));
    document.dispatchEvent(new KeyboardEvent('keydown', {key:'k', ctrlKey:true, altKey:true, bubbles:true}));

    expect(OS.showPreferences).toHaveBeenCalledOnce();
    expect(OS.toggleCmdPalette).toHaveBeenCalledOnce();
  });

  it('mirrors canvas state into hidden accessibility nodes', () => {
    const OS = loadOpenShop();
    const canvasObject = { name: 'Subject', type: 'image' };
    OS.canvas = createCanvasMock([canvasObject]);
    OS.cancelCrop = vi.fn();
    OS.updateInfoPanel = vi.fn();
    OS.updateMinimap = vi.fn();
    OS.updateHistogram = vi.fn();
    OS.updateHistoryPanel = vi.fn();
    OS.recordMacroStep = vi.fn();
    OS.layers = [
      { name: 'Background', visible: true, locked: true, opacity: 100, blend: 'source-over', objects: [] },
      { name: 'Subject Layer', visible: true, locked: false, opacity: 80, blend: 'multiply', objects: [canvasObject] }
    ];
    OS.activeLayerIdx = 1;
    OS._selectionBounds = { x: 4, y: 6, w: 10, h: 12 };
    OS._selectionMask = { w: 20, h: 20, mask: new Uint8Array(400) };
    OS._selectionMask.mask[0] = 1;
    OS._selectionMask.mask[1] = 1;

    OS.setTool('ai-segment');
    OS._lastAction = 'Filter: Sharpen';
    OS._renderAccessibilityTree();
    OS.toast('Filter applied', 'success');

    expect(document.getElementById('canvas-a11y-tool').textContent).toBe('Tool: AI Segment');
    expect(document.getElementById('canvas-a11y-layer').textContent).toContain('Subject Layer');
    expect(document.getElementById('canvas-a11y-layer').textContent).toContain('multiply');
    expect(document.getElementById('canvas-a11y-selection').textContent).toContain('2 pixels selected');
    expect(document.getElementById('canvas-a11y-summary').textContent).toContain('Last action: Filter: Sharpen');
    expect(document.getElementById('canvas-a11y-live').textContent).toBe('Filter applied');
    expect(document.getElementById('canvas-area').getAttribute('aria-label')).toContain('Tool: AI Segment');
    expect(document.querySelectorAll('#canvas-a11y-layers li')).toHaveLength(2);
  });

  it('renders persisted recent files, palettes, and presets as inert DOM', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    OS.cancelCrop = vi.fn();
    const payload = '<img src=x onerror=alert(1)>';
    localStorage.setItem('openshop_recent', JSON.stringify([
      { name: payload, dims: '<svg onload=alert(2)>', date: '<script>alert(3)</script>' }
    ]));
    localStorage.setItem('os_palette', JSON.stringify([
      '#112233',
      'url(javascript:alert(1))',
      '#AABBCC',
      '<img src=x onerror=alert(1)>'
    ]));
    localStorage.setItem('os_presets', JSON.stringify([
      { name: payload, adjustments: { brightness: '20', contrast: 'bad' }, custom: true }
    ]));

    OS.populateRecentFiles();
    OS.loadSavedPalette();
    OS.showPresets();

    expect(document.querySelector('#recent-files-area img')).toBeNull();
    expect(document.querySelector('#recent-files-area script')).toBeNull();
    expect(document.getElementById('recent-files-area').textContent).toContain(payload);
    expect(document.querySelectorAll('#palette-saved .palette-swatch')).toHaveLength(2);
    expect([...document.querySelectorAll('#palette-saved .palette-swatch')].map(el => el.title)).toEqual(['#112233', '#aabbcc']);
    const presetModal = document.querySelector('.modal-overlay .modal');
    expect(presetModal.querySelector('img')).toBeNull();
    expect(presetModal.querySelector('script')).toBeNull();
    expect(presetModal.textContent).toContain(payload);
  });

  it('renders dynamic command, context, note, timeline, macro, and AI UI as inert DOM', () => {
    const OS = loadOpenShop();
    const payload = '<img src=x onerror=alert(1)>';
    const active = {
      name: 'Photo',
      type: 'image',
      bringToFront: vi.fn(),
      bringForward: vi.fn(),
      sendBackwards: vi.fn(),
      sendToBack: vi.fn()
    };
    const canvas = createCanvasMock([active]);
    canvas.setActiveObject(active);
    OS.canvas = canvas;
    quietUiMethods(OS);

    OS._getCommands = () => [{ label: payload, cat: '<script>alert(2)</script>', key: '<svg onload=alert(3)>', fn: vi.fn() }];
    OS.filterCommands('');
    expect(document.querySelector('#cmd-results img')).toBeNull();
    expect(document.getElementById('cmd-results').textContent).toContain(payload);

    OS._lastFilter = payload;
    OS.initContextMenu();
    document.getElementById('canvas-area').dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 4, clientY: 6 }));
    expect(document.querySelector('#context-menu img')).toBeNull();
    expect(document.getElementById('context-menu').textContent).toContain(payload);

    OS.addStickyNote({ clientX: 10, clientY: 20 });
    expect(document.querySelector('#sticky-container [onclick]')).toBeNull();
    expect(document.querySelector('#sticky-container textarea').placeholder).toBe('Type a note...');

    OS.canvasW = 2;
    OS.canvasH = 2;
    OS._animFrames = ['data:image/png;base64,TEST'];
    OS._renderFrames();
    expect(document.querySelector('#timeline-frames [onclick]')).toBeNull();
    expect(document.getElementById('timeline-frames').textContent).toContain('#1');

    OS._macroSteps = [{ action: payload }];
    OS._renderMacroList();
    expect(document.querySelector('#macro-list img')).toBeNull();
    expect(document.getElementById('macro-list').textContent).toContain(payload);

    OS._showAIProgress(payload, '<script>alert(4)</script>');
    expect(document.querySelector('#ai-title img')).toBeNull();
    expect(document.getElementById('ai-title').textContent).toContain(payload);
    expect(document.getElementById('ai-msg').textContent).toBe('<script>alert(4)</script>');

    OS.saveCurrentAsPreset();
    const presetOverlay = document.querySelector('.modal-overlay');
    expect(presetOverlay.querySelector('[onclick]')).toBeNull();
    expect(presetOverlay.textContent).toContain('Save Preset');
  });

  it('keeps the filter worker on named operations instead of string execution', async () => {
    const source = readFileSync('index.html', 'utf8');
    expect(source).not.toContain("'unsafe-eval'");
    expect(source).not.toContain('new Function');
    expect(source).not.toMatch(/_runFilterInWorker\s*\(\s*`/);
    expect(source).not.toMatch(/\bfn:`/);

    const OS = loadOpenShop();
    OS._photonFilterDisabled = true;
    OS._runFilterJob = vi.fn().mockResolvedValue('filtered');
    const imageData = new ImageData(new Uint8ClampedArray(4), 1, 1);

    await expect(OS._runFilterWithPhoton('threshold', imageData, 1, 1, { thr: 128 })).resolves.toBe('filtered');
    expect(OS._runFilterJob).toHaveBeenCalledWith(
      { backend: 'worker', op: 'threshold' },
      imageData,
      1,
      1,
      { thr: 128 }
    );
    expect(OS._getDirectPhotonFilter('Sharpen')).toEqual({ op: 'sharpen' });
    expect(OS._getDirectPhotonFilter('BlackWhite')).toEqual({ op: 'threshold', params: { thr: 128 } });
  });

  it('converts a clicked segmentation result into a pixel selection mask', async () => {
    const OS = loadOpenShop();
    const target = {
      name: 'Subject Photo',
      type: 'image',
      width: 16,
      height: 16,
      scaleX: 1,
      scaleY: 1,
      originX: 'left',
      originY: 'top',
      visible: true,
      getElement: () => ({ naturalWidth: 16, naturalHeight: 16 }),
      calcTransformMatrix: () => [1, 0, 0, 1, 8, 8]
    };
    const canvas = createCanvasMock([target]);
    canvas.setActiveObject(target);
    OS.canvas = canvas;
    quietUiMethods(OS);
    OS._showAIProgress = vi.fn();
    OS._hideAIProgress = vi.fn();
    OS._showMaskOverlay = vi.fn();
    OS._imageToDataURL = vi.fn(() => 'data:image/png;base64,TEST');

    const makeMask = (predicate) => {
      const data = new Uint8Array(16 * 16);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          if (predicate(x, y)) data[y * 16 + x] = 255;
        }
      }
      return { width: 16, height: 16, channels: 1, data };
    };
    const results = [
      { label: 'left-object', score: 0.95, mask: makeMask((x, y) => x >= 1 && x <= 4 && y >= 4 && y <= 11) },
      { label: 'right-object', score: 0.9, mask: makeMask((x, y) => x >= 12 && x <= 15 && y >= 4 && y <= 11) }
    ];
    const segmenter = vi.fn().mockResolvedValue(results);
    OS._loadPipeline = vi.fn().mockResolvedValue(segmenter);

    await OS.aiSegmentSelectAt({ x: 14, y: 8 });

    expect(OS._loadPipeline).toHaveBeenCalledWith(
      'image-segmentation',
      'Xenova/detr-resnet-50-panoptic',
      'Segment Select'
    );
    expect(segmenter).toHaveBeenCalledWith('data:image/png;base64,TEST');
    expect(OS._selectionBounds).toEqual({ x: 13, y: 5, w: 4, h: 8 });
    expect(OS._selectionMask.mask.filter(Boolean)).toHaveLength(32);
    expect(OS._showMaskOverlay).toHaveBeenCalledWith(OS._selectionMask);
    expect(OS.toast).toHaveBeenCalledWith('Selected segment: right-object (32 px)', 'success');
  });

  it('prefers Photon filters and falls back to the JS worker after failure', async () => {
    const OS = loadOpenShop();
    const input = { data: new Uint8ClampedArray([10, 20, 30, 255]) };
    const photonResult = { data: new Uint8ClampedArray([255, 255, 255, 255]) };
    const fallbackResult = { data: new Uint8ClampedArray([0, 0, 0, 255]) };

    OS._runPhotonFilterInWorker = vi.fn().mockResolvedValueOnce(photonResult);
    OS._runFilterInWorker = vi.fn();

    await expect(OS._runFilterWithPhoton('edgeDetect', input, 1, 1)).resolves.toBe(photonResult);
    expect(OS._runPhotonFilterInWorker).toHaveBeenCalledWith('edgeDetect', input, 1, 1, undefined);
    expect(OS._runFilterInWorker).not.toHaveBeenCalled();

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    OS._runPhotonFilterInWorker = vi.fn().mockRejectedValueOnce(new Error('WASM blocked'));
    OS._runFilterInWorker = vi.fn().mockResolvedValueOnce(fallbackResult);

    await expect(OS._runFilterWithPhoton('threshold', input, 1, 1, { thr: 128 })).resolves.toBe(fallbackResult);
    expect(OS._photonFilterDisabled).toBe(true);
    expect(OS._runFilterInWorker).toHaveBeenCalledWith('threshold', input, 1, 1, { thr: 128 });
    warn.mockRestore();
  });

  it('routes one-click direct filters through the image-data backend', async () => {
    const OS = loadOpenShop();
    const active = { name: 'Photo', type: 'image' };
    const canvas = createCanvasMock([active]);
    canvas.setActiveObject(active);
    OS.canvas = canvas;
    quietUiMethods(OS);

    const input = { data: new Uint8ClampedArray([10, 20, 30, 255]), width: 1, height: 1 };
    const output = { data: new Uint8ClampedArray([30, 40, 50, 255]), width: 1, height: 1 };
    const info = { active, canvas: { width: 1, height: 1 }, imgData: input };
    OS._getActiveImageData = vi.fn(() => info);
    OS._runFilterWithPhoton = vi.fn().mockResolvedValue(output);
    OS._commitImageData = vi.fn();

    await OS.applyFilterDirect('Sharpen');

    expect(OS._runFilterWithPhoton).toHaveBeenCalledWith(
      'sharpen',
      input,
      1,
      1,
      {}
    );
    expect(OS._commitImageData).toHaveBeenCalledWith({...info, imgData: output}, 'Filter: Sharpen');
    expect(OS._lastFilter).toBe('Sharpen');
    expect(OS.toast).toHaveBeenCalledWith('Applied Sharpen', 'success');
  });

  it('preflights PSD headers, dimensions, layers, and metadata before bitmap decode', async () => {
    const OS = loadOpenShop();
    const makeHeader = ({ width = 100, height = 80, channels = 4, depth = 8, colorMode = 3 } = {}) => {
      const bytes = new Uint8Array(26);
      bytes.set([0x38, 0x42, 0x50, 0x53], 0);
      const view = new DataView(bytes.buffer);
      view.setUint16(4, 1, false);
      view.setUint16(12, channels, false);
      view.setUint32(14, height, false);
      view.setUint32(18, width, false);
      view.setUint16(22, depth, false);
      view.setUint16(24, colorMode, false);
      return bytes;
    };
    const lib = {
      readPsd: vi.fn(() => ({
        width: 100,
        height: 80,
        children: [{ name: '<img src=x onerror=alert(1)>', left: 0, top: 0, right: 10, bottom: 10 }]
      }))
    };

    await expect(OS._preflightPSD(lib, makeHeader(), 1024)).resolves.toMatchObject({ width: 100, height: 80 });
    expect(lib.readPsd).toHaveBeenCalledWith(expect.any(Uint8Array), expect.objectContaining({
      skipCompositeImageData: true,
      skipLayerImageData: true
    }));

    expect(() => OS._validatePSDHeader(OS._readPSDHeader(makeHeader({ width: 90000 })), 1024)).toThrow(/dimensions exceed/);
    expect(() => OS._validatePSDHeader(OS._readPSDHeader(makeHeader({ depth: 32 })), 1024)).toThrow(/bit depth/);
    expect(() => OS._validatePSDHeader(OS._readPSDHeader(makeHeader({ colorMode: 4 })), 1024)).toThrow(/RGB/);
    expect(() => OS._validatePSDStructure({
      width: 100,
      height: 80,
      children: Array.from({ length: OS._psdLimits.maxLayers + 1 }, (_, i) => ({ name: `Layer ${i}` }))
    })).toThrow(/layers/);
    expect(() => OS._validatePSDStructure({
      width: 100,
      height: 80,
      children: [{ left: 0, top: 0, right: 100000, bottom: 2 }]
    })).toThrow(/layer 1 exceeds/);
  });

  it('centralizes import schemas and resource budgets', () => {
    const OS = loadOpenShop();
    OS.toast = vi.fn();
    const image = { type: 'image/png', size: 1024, name: 'safe.png' };
    expect(() => OS._validateImageFile(image)).not.toThrow();
    expect(() => OS._validateImageFile({ type: 'text/html', size: 1 })).toThrow(/Unsupported image/);
    expect(() => OS._validateDecodedImage({ width: 40000, height: 10 })).toThrow(/dimensions exceed/);
    expect(() => OS._assertJsonFileBudget({ size: OS._importLimits.maxJsonBytes + 1 }, 'Project')).toThrow(/Project file exceeds/);

    const project = {
      _openShop: { w: '1200', h: '800' },
      objects: [{ id: '<bad>', name: 'javascript:alert(1) onerror=x' }]
    };
    OS._sanitizeProjectJSON(project);
    expect(project._openShop).toEqual({ w: 1200, h: 800 });
    expect(project.objects[0].id).toBe('bad');
    expect(project.objects[0].name).not.toContain('javascript:');

    expect(() => OS._sanitizeProjectJSON({ _openShop: { w: 100000, h: 100000 } })).toThrow(/Project dimensions/);
    expect(OS._sanitizePaletteColors(['#ABCDEF', 'javascript:alert(1)', '#112233']).map(c => c)).toEqual(['#abcdef', '#112233']);
    expect(OS._sanitizePresetList([
      { name: '<img src=x onerror=alert(1)>', adjustments: { brightness: '9999', contrast: 'bad' } },
      { name: '', adjustments: {} }
    ])).toEqual([
      { name: '<img src=x onerror=alert(1)>', adjustments: { brightness: 300, contrast: 0, saturation: 0, hue: 0, vibrance: 0 }, custom: false }
    ]);
  });

  it('starts standalone recovery exactly once for a top-level window', () => {
    const OS = loadOpenShop();
    OS._initAutoSave = vi.fn();
    OS._persistenceMode = 'standalone';

    OS._startRecoveryForCurrentMode({topLevel:true});
    OS._startRecoveryForCurrentMode({topLevel:true});

    expect(OS._persistenceMode).toBe('standalone');
    expect(OS._initAutoSave).toHaveBeenCalledTimes(1);
  });

  it('does not start standalone recovery in a frame or in an embedded mode', () => {
    const OS = loadOpenShop();
    OS._initAutoSave = vi.fn();

    OS._persistenceMode = 'standalone';
    OS._startRecoveryForCurrentMode({topLevel:false});
    OS._persistenceMode = 'embedded-pending';
    OS._startRecoveryForCurrentMode({topLevel:true});
    OS._persistenceMode = 'embedded-hstara';
    OS._startRecoveryForCurrentMode({topLevel:true});

    expect(OS._initAutoSave).not.toHaveBeenCalled();
  });

  it('disables local recovery state for embedded HstarA without discarding storage', () => {
    vi.useFakeTimers();
    try {
      const OS = loadOpenShop();
      OS._discardRecovery = vi.fn();
      OS._clearAutoSave = vi.fn();
      OS._offerRecovery(JSON.stringify({_openShop:{w:320,h:240}, objects:[]}));
      const autoSaveTimer = setInterval(() => {}, 30000);
      const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
      OS._autoSaveTimer = autoSaveTimer;
      OS._autoSaveDirty = true;
      const worker = {terminate:vi.fn()};
      OS._autoSaveWorker = worker;

      OS._setPersistenceMode('embedded-hstara');

      expect(OS._persistenceMode).toBe('embedded-hstara');
      expect(OS._autoSaveTimer).toBeNull();
      expect(OS._autoSaveDirty).toBe(false);
      expect(OS._recoveryData).toBeNull();
      expect(OS._autoSaveWorker).toBeNull();
      expect(worker.terminate).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[data-recovery-restore]')).toBeNull();
      expect(clearIntervalSpy).toHaveBeenCalledWith(autoSaveTimer);
      expect(OS._discardRecovery).not.toHaveBeenCalled();
      expect(OS._clearAutoSave).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps embedded recovery entry points away from OPFS and recovery UI', async () => {
    vi.useFakeTimers();
    try {
      const storage = {
        getDirectory:vi.fn(),
        estimate:vi.fn(),
      };
      vi.stubGlobal('navigator', {storage});
      const OS = loadOpenShop();
      OS._persistenceMode = 'embedded-hstara';
      OS._getRecoveryInfo = vi.fn().mockResolvedValue({supported:true, exists:false});
      OS._autoSaveDirty = true;
      OS.historyIdx = 1;
      OS.canvas = createCanvasMock();
      OS.layers = [];
      const timerCountBefore = vi.getTimerCount();

      await OS._initAutoSave();
      await OS._autoSave();
      await OS._clearAutoSave();
      await OS._discardRecovery();
      await OS.showRecoveryManager();
      OS._offerRecovery('{}');

      expect(OS._getRecoveryInfo).not.toHaveBeenCalled();
      expect(storage.getDirectory).not.toHaveBeenCalled();
      expect(storage.estimate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(timerCountBefore);
      expect(document.querySelector('.modal-overlay')).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps complete OCR provenance in standalone auto-save snapshots', async () => {
    const writable = {write:vi.fn(async () => {}), close:vi.fn(async () => {})};
    const root = {
      getFileHandle:vi.fn(async () => ({createWritable:vi.fn(async () => writable)})),
    };
    vi.stubGlobal('navigator', {storage:{getDirectory:vi.fn(async () => root)}});
    const OS = loadOpenShop();
    const canvas = createCanvasMock();
    OS._persistenceMode = 'standalone';
    OS._autoSaveDirty = true;
    OS.historyIdx = 1;
    OS.canvas = canvas;
    OS.layers = [];

    await OS._autoSave();

    expect(canvas.toJSON).toHaveBeenCalledWith(expect.arrayContaining(OCR_CUSTOM_PROPERTIES));
    expect(writable.write).toHaveBeenCalledOnce();
  });

  it('shows recovery storage status and restores sanitized recovery data', async () => {
    const OS = loadOpenShop();
    const canvas = createCanvasMock();
    OS.canvas = canvas;
    quietUiMethods(OS);
    OS.rebuildLayersFromCanvas = vi.fn();
    OS.zoomFit = vi.fn();
    const recovery = JSON.stringify({ _openShop: { w: 640, h: 480 }, objects: [{ name: 'javascript:alert(1)' }] });
    OS._getRecoveryInfo = vi.fn().mockResolvedValue({
      supported: true,
      exists: true,
      corrupt: false,
      ageMs: 120000,
      size: recovery.length,
      usage: 2048,
      quota: 4096,
      text: recovery
    });

    await OS.showRecoveryManager();
    const modal = document.querySelector('.modal-overlay .modal');
    expect(modal.textContent).toContain('Recovery Storage');
    expect(modal.textContent).toContain('Available');
    expect(modal.textContent).toContain('2 min ago');
    expect(modal.querySelector('[onclick]')).toBeNull();

    modal.querySelector('.btn-primary').click();
    expect(canvas.loadFromJSON).toHaveBeenCalledWith(
      expect.objectContaining({ _openShop: { w: 640, h: 480 } }),
      expect.any(Function)
    );
    expect(OS.toast).toHaveBeenCalledWith('Project restored from auto-save', 'success');

    OS._getRecoveryInfo = vi.fn().mockResolvedValue({
      supported: true,
      exists: true,
      corrupt: true,
      error: '<img src=x onerror=alert(1)>',
      ageMs: 0,
      size: 4,
      usage: 4,
      quota: 10,
      text: '{bad'
    });
    await OS.showRecoveryManager();
    const corruptModal = document.querySelector('.modal-overlay .modal');
    expect(corruptModal.querySelector('img')).toBeNull();
    expect(corruptModal.textContent).toContain('Corrupt');
    expect(corruptModal.querySelector('.btn-primary').disabled).toBe(true);
  });

  it('round-trips project save and open with sanitization', async () => {
    const OS = loadOpenShop();
    const boundary = { name: '__boundary__', type: 'rect', visible: true };
    const photo = { name: 'Photo', type: 'image', visible: true, opacity: 1 };
    const canvas = createCanvasMock([boundary, photo]);
    canvas.toJSON = vi.fn(() => ({
      objects: [
        { name: '__boundary__', type: 'rect' },
        { name: 'Photo', type: 'image' }
      ]
    }));
    OS.canvas = canvas;
    OS.layers = [{ name: 'Background', visible: true, opacity: 100, blend: 'source-over', objects: [boundary, photo] }];
    OS.canvasW = 800;
    OS.canvasH = 600;
    quietUiMethods(OS);
    OS.rebuildLayersFromCanvas = vi.fn();
    OS.zoomFit = vi.fn();
    OS.saveHistory = vi.fn();
    OS._clearAutoSave = vi.fn();

    const json = canvas.toJSON();
    json._openShop = { version: '0.18.13', w: OS.canvasW, h: OS.canvasH, layers: OS.layers.map(l => ({ name: l.name, visible: l.visible, opacity: l.opacity, blend: l.blend })) };
    expect(json._openShop.version).toBe('0.18.13');
    expect(json._openShop.w).toBe(800);
    expect(json._openShop.h).toBe(600);
    expect(json._openShop.layers).toHaveLength(1);

    const clicks = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function click() {
      clicks.push({ download: this.download });
    });
    await OS.saveProject();
    expect(canvas.toJSON).toHaveBeenLastCalledWith(expect.arrayContaining(OCR_CUSTOM_PROPERTIES));
    expect(clicks).toHaveLength(1);
    expect(clicks[0].download).toBe('openshop-project.json');

    const hostile = {
      _openShop: { w: '640', h: '480' },
      objects: [{ name: '<script>alert(1)</script>', src: 'javascript:alert(2)' }]
    };
    OS._sanitizeProjectJSON(hostile);
    expect(hostile._openShop.w).toBe(640);
    expect(hostile.objects[0].name).not.toContain('onerror=');
    expect(hostile.objects[0].src).not.toContain('javascript:');
  });

  it('offers recovery with event-delegated buttons and restores or discards', () => {
    const OS = loadOpenShop();
    const canvas = createCanvasMock();
    OS.canvas = canvas;
    quietUiMethods(OS);
    OS.rebuildLayersFromCanvas = vi.fn();
    OS.zoomFit = vi.fn();
    OS.saveHistory = vi.fn();
    OS._clearAutoSave = vi.fn();

    const project = JSON.stringify({ _openShop: { w: 320, h: 240 }, objects: [] });
    OS._offerRecovery(project);

    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('[onclick]')).toBeNull();
    expect(overlay.textContent).toContain('Recover Unsaved Work');

    overlay.querySelector('[data-recovery-restore]').click();
    expect(canvas.loadFromJSON).toHaveBeenCalled();
    expect(OS.toast).toHaveBeenCalledWith('Project restored from auto-save', 'success');

    OS._offerRecovery(project);
    const overlay2 = document.querySelector('.modal-overlay');
    OS._discardRecovery = vi.fn();
    overlay2.querySelector('[data-recovery-discard]').click();
    expect(OS._discardRecovery).toHaveBeenCalled();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });

  it('sanitizes SVG export by stripping scripts and event handlers', () => {
    const OS = loadOpenShop();

    const malicious = `<svg xmlns="http://www.w3.org/2000/svg">
      <script>alert(1)</script>
      <rect width="100" height="100" onclick="alert(2)"/>
      <circle cx="50" cy="50" r="25" onload="alert(3)"/>
      <a href="javascript:alert(4)"><text>Click</text></a>
      <a href="data:text/html,test"><text>Link</text></a>
      <rect width="50" height="50" fill="blue"/>
    </svg>`;

    const clean = OS._sanitizeSVG(malicious);
    expect(clean).not.toContain('<script>');
    expect(clean).not.toContain('onclick');
    expect(clean).not.toContain('onload');
    expect(clean).not.toContain('javascript:');
    expect(clean).not.toContain('data:text/html');
    expect(clean).toContain('fill="blue"');
  });

  it('creates SVG and PDF Blobs without browser download side effects', async () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvasW = 640;
    OS.canvasH = 480;
    OS.canvas.toSVG = vi.fn(() => '<svg width="640" height="480"></svg>');
    quietUiMethods(OS);
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const pdf = {
      addImage: vi.fn(),
      output: vi.fn(() => new Blob(['pdf'], {type:'application/pdf'})),
      save: vi.fn(),
    };
    window.jspdf = {jsPDF:vi.fn(function MockJsPdf() { return pdf; })};

    const svg = await OS._createExportArtifact('svg');
    const pdfArtifact = await OS._createExportArtifact('pdf');

    expect(svg).toMatchObject({format:'svg', width:640, height:480, mimeType:'image/svg+xml'});
    expect(pdfArtifact).toMatchObject({format:'pdf', width:640, height:480, mimeType:'application/pdf'});
    expect(svg.blob).toBeInstanceOf(Blob);
    expect(pdfArtifact.blob).toBeInstanceOf(Blob);
    expect(pdf.addImage).toHaveBeenCalledWith(expect.stringMatching(/^data:image\/png;base64,/), 'PNG', 0, 0, 640, 480);
    expect(pdf.save).not.toHaveBeenCalled();
    expect(click).not.toHaveBeenCalled();
    delete window.jspdf;
  });

  it('builds a PSD Blob with correct layer metadata and no browser download', async () => {
    const OS = loadOpenShop();
    const boundary = { name: '__boundary__', visible: true, toCanvasElement: vi.fn(() => document.createElement('canvas')), left: 0, top: 0, opacity: 1 };
    const photo = { name: 'Portrait', visible: true, toCanvasElement: vi.fn(() => document.createElement('canvas')), left: 10, top: 20, opacity: 0.8 };
    const canvas = createCanvasMock([boundary, photo]);
    OS.canvas = canvas;
    OS.canvasW = 400;
    OS.canvasH = 300;
    OS.layers = [
      { name: 'BG', visible: true, opacity: 100, blend: 'source-over', objects: [boundary] },
      { name: 'Subject', visible: true, opacity: 80, blend: 'multiply', objects: [photo] }
    ];
    quietUiMethods(OS);

    let writtenPsd = null;
    const mockLib = {
      writePsd: vi.fn(psd => { writtenPsd = psd; return new Uint8Array([0x38, 0x42, 0x50, 0x53]); })
    };
    globalThis.agPsd = mockLib;

    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const artifact = await OS._createExportArtifact('psd');

    expect(mockLib.writePsd).toHaveBeenCalled();
    expect(writtenPsd.width).toBe(400);
    expect(writtenPsd.height).toBe(300);
    expect(writtenPsd.children).toHaveLength(1);
    expect(writtenPsd.children[0].name).toBe('Subject');
    expect(writtenPsd.children[0].opacity).toBe(Math.round(0.8 * 255));
    expect(artifact).toMatchObject({
      filename:'openshop-export.psd',
      mimeType:'image/vnd.adobe.photoshop',
      format:'psd',
      width:400,
      height:300,
    });
    expect(artifact.blob).toBeInstanceOf(Blob);
    expect(click).not.toHaveBeenCalled();

    delete globalThis.agPsd;
  });

  it('wires modal close and action buttons via data attributes', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock();
    quietUiMethods(OS);
    OS.saveHistory = vi.fn();
    OS._clearAutoSave = vi.fn();
    OS.rebuildLayersFromCanvas = vi.fn();
    OS.zoomFit = vi.fn();

    OS.newImage();
    const overlay = document.querySelector('.modal-overlay');
    expect(overlay).not.toBeNull();
    expect(overlay.querySelector('[onclick]')).toBeNull();

    const presets = overlay.querySelectorAll('[data-pw]');
    expect(presets.length).toBeGreaterThanOrEqual(4);
    presets[0].click();
    expect(overlay.querySelector('#ni-w').value).toBe(presets[0].dataset.pw);
    expect(overlay.querySelector('#ni-h').value).toBe(presets[0].dataset.ph);

    overlay.querySelector('[data-modal-close]').click();
    expect(document.querySelector('.modal-overlay')).toBeNull();
  });
});
