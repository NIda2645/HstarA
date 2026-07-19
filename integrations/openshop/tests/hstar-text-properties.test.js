import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDir = dirname(fileURLToPath(import.meta.url));
const controllerPath = resolve(testDir, '..', 'host', 'openshop-text-properties.js');
const controllerCssPath = resolve(testDir, '..', 'host', 'openshop-text-properties.css');
const fontCatalogPath = resolve(testDir, '..', 'host', 'openshop-font-catalog.js');
const FONT_ROW_HEIGHT = 30;
const FONT_VIEWPORT_HEIGHT = 210;
const FONT_OVERSCAN = 4;

let animationFrames;
let nextAnimationFrame;

function flushAnimationFrames() {
  const callbacks = [...animationFrames.values()];
  animationFrames.clear();
  callbacks.forEach(callback => callback(performance.now()));
}

function createCatalogRows(count = 2500) {
  return Array.from({length:count}, (_, index) => {
    const family = `Virtual Font ${String(index).padStart(4, '0')}`;
    return {
      kind:'font',
      key:`font:${family}`,
      family,
      font:{family, label:family, status:index === 7 ? 'missing' : 'available', styles:[]},
    };
  });
}

function createSectionedCatalogRows() {
  const fonts = createCatalogRows();
  return [
    {kind:'section', key:'section-zh', label:'Chinese fonts'},
    {kind:'group', key:'group-zh-unprefixed', label:'Common Chinese'},
    fonts[0],
    {kind:'group', key:'group-01', label:'Simplified Chinese'},
    ...fonts.slice(1, 1250),
    {kind:'section', key:'section-en', label:'English fonts'},
    {kind:'group', key:'group-en-unprefixed', label:'Other English'},
    ...fonts.slice(1250),
  ];
}

function createDeferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {promise, resolve:resolvePromise, reject:rejectPromise};
}

async function settleAsyncEvent() {
  await Promise.resolve();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
}

class FakeCanvas {
  constructor() {
    this.listeners = new Map();
    this.activeObject = null;
    this.renderAll = vi.fn();
  }

  on(event, listener) {
    const listeners = this.listeners.get(event) || [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  off(event, listener) {
    this.listeners.set(event, (this.listeners.get(event) || []).filter(item => item !== listener));
  }

  fire(event, payload = {}) {
    (this.listeners.get(event) || []).forEach(listener => listener(payload));
  }

  getActiveObject() {
    return this.activeObject;
  }
}

function createTextObject({editing = false, selectionStart = 0, selectionEnd = 0} = {}) {
  const textObject = {
    type:'i-text',
    text:'abc',
    isEditing:editing,
    selectionStart,
    selectionEnd,
    fontFamily:'Microsoft YaHei UI',
    fontSize:48,
    fontWeight:400,
    fontStyle:'normal',
    fill:'#ffffff',
    underline:false,
    linethrough:false,
    textAlign:'left',
    lineHeight:1.16,
    charSpacing:0,
    set:vi.fn(function set(values){ Object.assign(this, values); }),
    setSelectionStyles:vi.fn(function setSelectionStyles(values, start, end){
      this.lastSelectionStyles = {values, start, end};
    }),
    getSelectionStyles:vi.fn(function getSelectionStyles(){
      return Array.from({length:Math.max(0, this.selectionEnd - this.selectionStart)}, () => ({
        fontFamily:this.fontFamily,
        fontSize:this.fontSize,
        fontWeight:this.fontWeight,
        fontStyle:this.fontStyle,
        fill:this.fill,
        underline:this.underline,
        linethrough:this.linethrough,
      }));
    }),
  };
  return textObject;
}

function createHarness(options = {}) {
  const textObject = createTextObject(options);
  const canvas = new FakeCanvas();
  const editor = {
    canvas,
    saveHistory:vi.fn(),
    updateLayersPanel:vi.fn(),
    state:{textFont:'Microsoft YaHei UI', textSize:24, textColor:'#ffffff', textBold:false, textItalic:false},
    __hstarFontRefs:[],
  };
  canvas.activeObject = textObject;
  let fontSubscriber = null;
  const catalogRows = options.catalogRows || [
    {kind:'section', key:'section-zh', label:'Chinese fonts'},
    {kind:'group', key:'group-zh-unprefixed', label:'Common Chinese'},
    {
      kind:'font',
      key:'font:Microsoft YaHei UI',
      family:'Microsoft YaHei UI',
      font:{family:'Microsoft YaHei UI', label:'Microsoft YaHei UI', status:'available', styles:[]},
    },
    {
      kind:'font',
      key:'font:Missing Project Font',
      family:'Missing Project Font',
      font:{family:'Missing Project Font', label:'Missing Project Font', status:'missing', styles:[]},
    },
    {kind:'section', key:'section-en', label:'English fonts'},
    {kind:'group', key:'group-en-unprefixed', label:'Other English'},
    {
      kind:'font',
      key:'font:Century Gothic',
      family:'Century Gothic',
      font:{family:'Century Gothic', label:'Century Gothic', status:'available', styles:[]},
    },
  ];
  const fontManager = options.fontManager || {
    loadSystemFonts:vi.fn(async () => [
      {family:'Microsoft YaHei UI', label:'微软雅黑 UI', status:'available', styles:[
        {id:'yahei-400-normal', label:'常规', weight:400, italic:false, localNames:['Microsoft YaHei UI']},
        {id:'yahei-700-normal', label:'粗体', weight:700, italic:false, localNames:['Microsoft YaHei UI']},
      ]},
      {family:'Century Gothic', label:'Century Gothic', status:'available', styles:[
        {id:'century-400-normal', label:'Regular', weight:400, italic:false, localNames:['Century Gothic']},
      ]},
    ]),
    refreshSystemFonts:vi.fn(async () => []),
    getState:vi.fn(() => ({error:''})),
    searchFonts:vi.fn(() => catalogRows.filter(row => row.kind === 'font').map(row => row.font)),
    catalogRows:vi.fn(() => catalogRows),
    stylesFor:vi.fn(() => [{id:'yahei-400-normal', label:'常规', weight:400, italic:false, localNames:['Microsoft YaHei UI']}]),
    defaultStyleFor:vi.fn(() => null),
    subscribe:vi.fn(listener => {
      fontSubscriber = listener;
      listener({});
      return vi.fn(() => {
        if(fontSubscriber === listener) fontSubscriber = null;
      });
    }),
    scanEditor:vi.fn(() => []),
  };
  const controller = window.HstarOpenShopTextProperties.createController({editor, fontManager, documentRef:document});
  return {
    controller,
    editor,
    canvas,
    textObject,
    fontManager,
    notifyFonts:() => fontSubscriber?.({}),
  };
}

describe('Hstar OpenShop text properties', () => {
  beforeEach(async () => {
    animationFrames = new Map();
    nextAnimationFrame = 1;
    vi.stubGlobal('requestAnimationFrame', vi.fn(callback => {
      const id = nextAnimationFrame++;
      animationFrames.set(id, callback);
      return id;
    }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn(id => animationFrames.delete(id)));
    expect(existsSync(controllerPath), `${controllerPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopTextProperties;
    document.body.innerHTML = `
      <div id="tool-options">
        <select id="text-font"><option>Microsoft YaHei UI</option></select>
        <input id="text-size" value="24">
        <input id="text-color" value="#ffffff">
        <input id="text-bold" type="checkbox">
        <input id="text-italic" type="checkbox">
      </div>
      <div id="panels">
        <div class="panel-tab-group ptg-flex">
          <div class="panel-tabs">
            <button class="panel-tab active">Layers</button>
            <button class="panel-tab">Properties</button>
            <button class="panel-tab">Align</button>
          </div>
          <div class="panel-tab-content active" id="ptg1-layers" data-group="ptg1"></div>
          <div class="panel-tab-content" id="ptg1-props" data-group="ptg1"></div>
          <div class="panel-tab-content" id="ptg1-align" data-group="ptg1"></div>
        </div>
        <div class="panel-tab-group ptg-flex">
          <div class="panel-tabs">
            <button class="panel-tab active">Color</button>
            <button class="panel-tab">Swatches</button>
          </div>
          <div class="panel-tab-content active" id="ptg2-color" data-group="ptg2"></div>
          <div class="panel-tab-content" id="ptg2-palettes" data-group="ptg2"></div>
        </div>
      </div>`;
    await import(`${pathToFileURL(controllerPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('opens the text tab when a text object is selected or edited', async () => {
    const {controller, canvas, textObject} = createHarness();
    await controller.start();

    canvas.fire('selection:created', {selected:[textObject]});

    expect(document.querySelector('[data-hstar-text-properties-tab]').classList).toContain('active');
    expect(document.getElementById('hstar-text-properties-panel').classList).toContain('active');
    expect(document.querySelector('[data-text-family]').textContent).toContain('Microsoft YaHei UI');
    expect(document.querySelector('[data-hstar-text-properties-tab]').parentElement)
      .toBe(document.getElementById('ptg2-color').parentElement.querySelector('.panel-tabs'));
    expect(document.getElementById('hstar-text-properties-panel').dataset.group).toBe('ptg2');
    expect(document.getElementById('ptg1-layers').classList).toContain('active');

    textObject.isEditing = true;
    canvas.fire('text:editing:entered', {target:textObject});
    expect(document.querySelector('[data-hstar-text-properties-tab]').classList).toContain('active');
    controller.destroy();
  });

  it('uses separate Chinese and English-or-other font selectors with one shared listbox', async () => {
    const rows = createSectionedCatalogRows();
    const {controller, textObject} = createHarness({catalogRows:rows});
    const firstChineseFont = rows.findIndex(row => row.family === 'Virtual Font 0000');
    rows.splice(firstChineseFont, 0, {
      kind:'font',
      key:`font:${textObject.fontFamily}`,
      family:textObject.fontFamily,
      font:{family:textObject.fontFamily, label:textObject.fontFamily, status:'available', styles:[]},
    });
    await controller.start();

    const triggers = document.querySelectorAll('[data-text-family]');
    const chinese = document.querySelector('[data-text-family="zh"]');
    const other = document.querySelector('[data-text-family="other"]');
    const lists = document.querySelectorAll('[data-text-font-list]');
    const list = document.querySelector('[data-text-font-list]');
    const listSpace = document.querySelector('[data-text-font-space]');

    expect(triggers).toHaveLength(2);
    expect(chinese).not.toBeNull();
    expect(other).not.toBeNull();
    expect(lists).toHaveLength(1);
    expect(list).not.toBeNull();
    expect(listSpace.style.height).toBe('0px');
    expect(chinese.getAttribute('aria-controls')).toBe(other.getAttribute('aria-controls'));
    expect(chinese.getAttribute('aria-controls')).toBe(list.id);
    expect(chinese.querySelector('[data-text-family-label]').textContent).toBe('Microsoft YaHei UI');
    expect(other.querySelector('[data-text-family-label]').textContent).toBe('选择字体');

    chinese.click();
    expect(list.hidden).toBe(false);
    expect(listSpace.style.height).toBe(`${FONT_VIEWPORT_HEIGHT + 4}px`);
    expect(chinese.getAttribute('aria-expanded')).toBe('true');
    expect(other.getAttribute('aria-expanded')).toBe('false');
    expect(document.querySelector('[data-text-font-list]')).toBe(list);
    expect(list.querySelector('[data-family="Virtual Font 0000"]')).not.toBeNull();
    expect(list.querySelector('[data-family="Virtual Font 1250"]')).toBeNull();
    const activeOption = () => document.getElementById(list.getAttribute('aria-activedescendant'));
    list.dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true, cancelable:true}));
    expect(activeOption().dataset.family).toBe('Virtual Font 1249');

    other.dispatchEvent(new MouseEvent('mousedown', {bubbles:true, cancelable:true}));
    expect(list.hidden).toBe(false);
    other.click();
    expect(list.hidden).toBe(false);
    expect(chinese.getAttribute('aria-expanded')).toBe('false');
    expect(other.getAttribute('aria-expanded')).toBe('true');
    expect(document.querySelector('[data-text-font-list]')).toBe(list);
    expect(list.querySelector('[data-family="Virtual Font 1250"]')).not.toBeNull();
    expect(list.querySelector('[data-family="Virtual Font 0000"]')).toBeNull();
    list.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true, cancelable:true}));
    expect(activeOption().dataset.family).toBe('Virtual Font 1250');
    controller.destroy();
    expect(listSpace.style.height).toBe('0px');
  });

  it('uses catalogRows once per subscription update and never calls scrollIntoView on open', async () => {
    const rows = createCatalogRows();
    const {controller, fontManager, textObject} = createHarness({catalogRows:rows});
    textObject.fontFamily = rows[1250].family;
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, 'scrollIntoView', {configurable:true, value:scrollIntoView});

    await controller.start();
    const trigger = document.querySelector('[data-text-family]');

    expect(trigger.tagName).toBe('BUTTON');
    expect(trigger.getAttribute('aria-haspopup')).toBe('listbox');
    expect(trigger.querySelector('input')).toBeNull();
    trigger.click();
    trigger.click();
    trigger.click();

    expect(fontManager.catalogRows).toHaveBeenCalledTimes(1);
    expect(fontManager.searchFonts).not.toHaveBeenCalled();
    expect(scrollIntoView).not.toHaveBeenCalled();
    controller.destroy();
    delete Element.prototype.scrollIntoView;
  });

  it('preserves catalog headings, listbox semantics, missing badges, and DOM font previews', async () => {
    const {controller} = createHarness();
    await controller.start();
    const trigger = document.querySelector('[data-text-family]');
    const list = document.querySelector('[data-text-font-list]');

    trigger.click();
    const selected = list.querySelector('[data-family="Microsoft YaHei UI"]');
    const missing = list.querySelector('[data-family="Missing Project Font"]');

    expect(list.getAttribute('role')).toBe('listbox');
    expect(list.querySelectorAll('.hstar-font-heading')).toHaveLength(2);
    expect(selected.getAttribute('role')).toBe('option');
    expect(selected.getAttribute('aria-selected')).toBe('true');
    expect(missing.querySelector('[data-font-missing-badge]')).not.toBeNull();
    expect(missing.style.fontFamily).toContain('Missing Project Font');
    controller.destroy();
  });

  it('bounds mounted options to the viewport plus overscan for 2500 rows', async () => {
    const rows = createCatalogRows();
    const {controller, textObject} = createHarness({catalogRows:rows});
    textObject.fontFamily = rows[1250].family;
    await controller.start();

    document.querySelector('[data-text-family]').click();
    const mounted = document.querySelectorAll('[data-text-font-list] [role="option"]');
    const maximumMounted = Math.ceil(FONT_VIEWPORT_HEIGHT / FONT_ROW_HEIGHT) + (FONT_OVERSCAN * 2);

    expect(mounted.length).toBeGreaterThan(0);
    expect(mounted.length).toBeLessThanOrEqual(maximumMounted);
    controller.destroy();
  });

  it('opens at the selected family without moving the parent panel', async () => {
    const rows = createCatalogRows();
    const {controller, textObject} = createHarness({catalogRows:rows});
    textObject.fontFamily = rows[1250].family.toUpperCase();
    await controller.start();
    const panel = document.getElementById('hstar-text-properties-panel');
    const list = document.querySelector('[data-text-font-list]');
    panel.scrollTop = 73;
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      configurable:true,
      value:vi.fn(() => { panel.scrollTop = 0; }),
    });

    document.querySelector('[data-text-family]').click();

    expect(list.scrollTop).toBe(1250 * FONT_ROW_HEIGHT);
    expect(panel.scrollTop).toBe(73);
    controller.destroy();
    delete Element.prototype.scrollIntoView;
  });

  it('mounts a persistent spacer for the complete 2500-row catalog', async () => {
    const rows = createCatalogRows();
    const {controller} = createHarness({catalogRows:rows});
    await controller.start();

    const list = document.querySelector('[data-text-font-list]');
    const spacer = list.querySelector('[data-font-spacer]');
    const rowsLayer = list.querySelector('[data-font-rows]');

    expect(spacer.style.height).toBe(`${rows.length * FONT_ROW_HEIGHT}px`);
    expect(rowsLayer).not.toBeNull();
    document.querySelector('[data-text-family]').click();
    expect(list.firstElementChild).toBe(spacer);
    expect(list.querySelector('[data-font-spacer]')).toBe(spacer);
    controller.destroy();
  });

  it('renders new visible families after its own scroll frame', async () => {
    const rows = createCatalogRows();
    const {controller, textObject} = createHarness({catalogRows:rows});
    textObject.fontFamily = rows[0].family;
    await controller.start();
    const list = document.querySelector('[data-text-font-list]');
    document.querySelector('[data-text-family]').click();
    const targetFamily = rows[2000].family;

    expect(list.querySelector(`[data-family="${targetFamily}"]`)).toBeNull();
    list.scrollTop = 2000 * FONT_ROW_HEIGHT;
    list.dispatchEvent(new Event('scroll'));
    expect(list.querySelector(`[data-family="${targetFamily}"]`)).toBeNull();
    flushAnimationFrames();

    expect(list.querySelector(`[data-family="${targetFamily}"]`)).not.toBeNull();
    expect(list.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(16);
    controller.destroy();
  });

  it('delegates selection without ending Fabric text editing or moving focus', async () => {
    const rows = createCatalogRows();
    const {controller, textObject} = createHarness({
      catalogRows:rows,
      editing:true,
      selectionStart:0,
      selectionEnd:3,
    });
    textObject.fontFamily = rows[0].family;
    await controller.start();
    const trigger = document.querySelector('[data-text-family]');
    const list = document.querySelector('[data-text-font-list]');
    trigger.focus();
    trigger.click();
    const targetFamily = rows[5].family;
    const label = list.querySelector(`[data-family="${targetFamily}"] [data-font-label]`);
    const mouseDown = new MouseEvent('mousedown', {bubbles:true, cancelable:true});

    expect(label.dispatchEvent(mouseDown)).toBe(false);
    expect(mouseDown.defaultPrevented).toBe(true);
    label.click();

    expect(textObject.setSelectionStyles).toHaveBeenCalledWith({fontFamily:targetFamily}, 0, 3);
    expect(textObject.isEditing).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(list.hidden).toBe(true);
    controller.destroy();
  });

  it('prevents trigger mousedown only while the active Fabric text is editing', async () => {
    const {controller, textObject} = createHarness({
      catalogRows:createCatalogRows(),
      editing:true,
      selectionStart:2,
      selectionEnd:2,
    });
    await controller.start();
    const trigger = document.querySelector('[data-text-family]');
    const list = document.querySelector('[data-text-font-list]');
    const editingMouseDown = new MouseEvent('mousedown', {bubbles:true, cancelable:true});

    expect(trigger.dispatchEvent(editingMouseDown)).toBe(false);
    expect(editingMouseDown.defaultPrevented).toBe(true);

    textObject.isEditing = false;
    const normalMouseDown = new MouseEvent('mousedown', {bubbles:true, cancelable:true});
    expect(trigger.dispatchEvent(normalMouseDown)).toBe(true);
    expect(normalMouseDown.defaultPrevented).toBe(false);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    expect(list.hidden).toBe(false);
    controller.destroy();
  });

  it('navigates the complete virtual row model while skipping headings', async () => {
    const rows = createSectionedCatalogRows();
    const sectionRows = rows.slice(rows.findIndex(row => row.key === 'section-en'));
    const fontRows = sectionRows.filter(row => row.kind === 'font');
    const {controller, textObject} = createHarness({catalogRows:rows});
    textObject.fontFamily = fontRows[0].family;
    await controller.start();
    const trigger = document.querySelector('[data-text-family="other"]');
    const list = document.querySelector('[data-text-font-list]');
    const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles:true,
      cancelable:true,
    }));
    const activeOption = () => document.getElementById(list.getAttribute('aria-activedescendant'));

    expect(trigger).not.toBeNull();
    trigger.focus();
    press(trigger, 'ArrowDown');

    expect(list.hidden).toBe(false);
    expect(list.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(list);
    expect(activeOption().dataset.family).toBe(fontRows[0].family);
    expect(activeOption().getAttribute('aria-selected')).toBe('true');

    press(list, 'ArrowDown');
    expect(activeOption().dataset.family).toBe(fontRows[1].family);
    expect(activeOption().getAttribute('aria-selected')).toBe('false');
    expect(list.querySelector(`[data-family="${fontRows[0].family}"]`).getAttribute('aria-selected')).toBe('true');

    press(list, 'End');
    expect(activeOption().dataset.family).toBe(fontRows.at(-1).family);
    expect(list.scrollTop).toBeGreaterThan(1000 * FONT_ROW_HEIGHT);
    expect(list.querySelectorAll('[role="option"]').length).toBeLessThanOrEqual(16);

    press(list, 'Home');
    expect(activeOption().dataset.family).toBe(fontRows[0].family);
    expect(list.scrollTop).toBe(sectionRows.findIndex(row => row === fontRows[0]) * FONT_ROW_HEIGHT);

    press(list, 'End');
    press(list, 'Enter');
    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(textObject.set).toHaveBeenCalledWith({fontFamily:fontRows.at(-1).family});
    controller.destroy();
  });

  it('selects the keyboard-active font with Space and restores trigger focus', async () => {
    const rows = createSectionedCatalogRows();
    const fontRows = rows
      .slice(0, rows.findIndex(row => row.key === 'section-en'))
      .filter(row => row.kind === 'font');
    const {controller, textObject} = createHarness({catalogRows:rows});
    textObject.fontFamily = fontRows[0].family;
    await controller.start();
    const trigger = document.querySelector('[data-text-family="zh"]');
    const list = document.querySelector('[data-text-font-list]');
    const press = (target, key) => target.dispatchEvent(new KeyboardEvent('keydown', {
      key,
      bubbles:true,
      cancelable:true,
    }));

    expect(trigger).not.toBeNull();
    trigger.focus();
    press(trigger, 'ArrowDown');
    press(list, 'ArrowDown');
    press(list, ' ');

    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(textObject.set).toHaveBeenCalledWith({fontFamily:fontRows[1].family});
    controller.destroy();
  });

  it('moves from the selected row when ArrowDown follows a pointer-opened list', async () => {
    const rows = createSectionedCatalogRows();
    const fontRows = rows
      .slice(0, rows.findIndex(row => row.key === 'section-en'))
      .filter(row => row.kind === 'font');
    const {controller, textObject} = createHarness({catalogRows:rows});
    textObject.fontFamily = fontRows[0].family;
    await controller.start();
    const trigger = document.querySelector('[data-text-family="zh"]');
    const list = document.querySelector('[data-text-font-list]');
    expect(trigger).not.toBeNull();
    trigger.focus();
    trigger.dispatchEvent(new MouseEvent('click', {bubbles:true, detail:1}));

    trigger.dispatchEvent(new KeyboardEvent('keydown', {
      key:'ArrowDown',
      bubbles:true,
      cancelable:true,
    }));

    const activeOption = document.getElementById(list.getAttribute('aria-activedescendant'));
    expect(activeOption.dataset.family).toBe(fontRows[1].family);
    expect(document.activeElement).toBe(list);
    controller.destroy();
  });

  it('closes keyboard navigation with Escape without selecting', async () => {
    const rows = createSectionedCatalogRows();
    const {controller, textObject} = createHarness({catalogRows:rows});
    await controller.start();
    const trigger = document.querySelector('[data-text-family="other"]');
    const list = document.querySelector('[data-text-font-list]');
    expect(trigger).not.toBeNull();
    trigger.focus();
    trigger.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown', bubbles:true, cancelable:true}));
    list.dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true, cancelable:true}));
    textObject.set.mockClear();

    list.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}));

    expect(list.hidden).toBe(true);
    expect(document.activeElement).toBe(trigger);
    expect(textObject.set).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('closes the virtualized list on Escape and outside mousedown', async () => {
    const {controller} = createHarness({catalogRows:createCatalogRows()});
    await controller.start();
    const trigger = document.querySelector('[data-text-family]');
    const list = document.querySelector('[data-text-font-list]');

    trigger.click();
    list.scrollTop = 9000;
    list.dispatchEvent(new Event('scroll'));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    trigger.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    expect(list.hidden).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    trigger.click();
    list.scrollTop = 12000;
    list.dispatchEvent(new Event('scroll'));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(2);
    document.body.dispatchEvent(new MouseEvent('mousedown', {bubbles:true}));
    expect(list.hidden).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(2);
    controller.destroy();
  });

  it('closes and cancels pending rendering through the refresh control', async () => {
    const {controller, fontManager} = createHarness({catalogRows:createCatalogRows()});
    await controller.start();
    const trigger = document.querySelector('[data-text-family]');
    const list = document.querySelector('[data-text-font-list]');
    trigger.click();
    list.scrollTop = 15000;
    list.dispatchEvent(new Event('scroll'));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    document.querySelector('[data-font-refresh]').click();

    expect(fontManager.refreshSystemFonts).toHaveBeenCalledTimes(1);
    expect(list.hidden).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    await vi.waitFor(() => {
      expect(document.querySelector('[data-font-status]').textContent).toBe('本机字体已刷新');
    });
    controller.destroy();
  });

  it('shows a failed refresh when the font manager captures a fetch error', async () => {
    delete window.HstarOpenShopFontCatalog;
    await import(`${pathToFileURL(fontCatalogPath).href}?test=${Date.now()}-${Math.random()}`);
    const fetchImpl = vi.fn(async () => { throw new Error('refresh offline'); });
    const fontManager = window.HstarOpenShopFontCatalog.createManager({
      fetchImpl,
      fontProbe:() => true,
    });
    const {controller} = createHarness({fontManager});
    await controller.start();

    document.querySelector('[data-font-refresh]').click();

    await vi.waitFor(() => {
      expect(document.querySelector('[data-font-status]').textContent).toBe('本机字体刷新失败');
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(fontManager.getState().error).toContain('refresh offline');
    controller.destroy();
  });

  it('ignores an in-flight refresh that resolves after destroy', async () => {
    const deferred = createDeferred();
    const {controller, fontManager} = createHarness();
    fontManager.refreshSystemFonts.mockReturnValue(deferred.promise);
    await controller.start();
    const status = document.querySelector('[data-font-status]');
    document.querySelector('[data-font-refresh]').click();
    controller.destroy();

    deferred.resolve([]);
    await settleAsyncEvent();

    expect(document.getElementById('hstar-text-properties-panel')).toBeNull();
    expect(fontManager.getState).not.toHaveBeenCalled();
    expect(status.textContent).toBe('');
  });

  it('handles an in-flight refresh rejection after destroy', async () => {
    const deferred = createDeferred();
    const {controller, fontManager} = createHarness();
    fontManager.refreshSystemFonts.mockReturnValue(deferred.promise);
    await controller.start();
    document.querySelector('[data-font-refresh]').click();
    controller.destroy();

    deferred.reject(new Error('refresh failed'));
    await settleAsyncEvent();

    expect(document.getElementById('hstar-text-properties-panel')).toBeNull();
  });

  it('closes, swaps rows, and cancels stale rendering on a catalog subscription update', async () => {
    const rows = createCatalogRows();
    const replacementRows = createCatalogRows(12).map(row => {
      const family = row.family.replace('Virtual', 'Replacement');
      return {...row, key:`font:${family}`, family, font:{...row.font, family, label:family}};
    });
    const {controller, fontManager, notifyFonts} = createHarness({catalogRows:rows});
    await controller.start();
    const trigger = document.querySelector('[data-text-family]');
    const list = document.querySelector('[data-text-font-list]');
    trigger.click();
    list.scrollTop = 9000;
    list.dispatchEvent(new Event('scroll'));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
    fontManager.catalogRows.mockReturnValue(replacementRows);

    notifyFonts();

    expect(list.hidden).toBe(true);
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(list.querySelector('[data-family]')).toBeNull();
    trigger.click();
    expect(list.querySelector(`[data-family="${replacementRows[0].family}"]`)).not.toBeNull();
    expect(list.querySelector(`[data-family="${rows[0].family}"]`)).toBeNull();
    controller.destroy();
  });

  it('destroy cancels pending rendering and removes dropdown listeners', async () => {
    const {controller, textObject} = createHarness({catalogRows:createCatalogRows()});
    await controller.start();
    const trigger = document.querySelector('[data-text-family]');
    const list = document.querySelector('[data-text-font-list]');
    const align = document.querySelector('[data-text-align]');
    trigger.click();
    list.scrollTop = 12000;
    list.dispatchEvent(new Event('scroll'));
    expect(requestAnimationFrame).toHaveBeenCalledTimes(1);

    textObject.set.mockClear();
    controller.destroy();
    const requestedFrames = requestAnimationFrame.mock.calls.length;
    expect(cancelAnimationFrame).toHaveBeenCalledTimes(1);
    expect(list.hidden).toBe(true);
    trigger.click();
    list.dispatchEvent(new Event('scroll'));
    align.value = 'right';
    align.dispatchEvent(new Event('change', {bubbles:true}));
    flushAnimationFrames();

    expect(list.hidden).toBe(true);
    expect(requestAnimationFrame).toHaveBeenCalledTimes(requestedFrames);
    expect(textObject.set).not.toHaveBeenCalledWith({textAlign:'right'});
  });

  it('keeps a closed font list visually hidden from the layout', () => {
    const css = readFileSync(controllerCssPath, 'utf8');
    const listRule = css.match(/\.hstar-font-list\{([^}]*)\}/)?.[1] || '';

    expect(css).toMatch(
      /\.hstar-font-list\[hidden\]\s*\{\s*display\s*:\s*none\s*!important\s*\}/
    );
    expect(listRule).toContain('box-sizing:border-box');
    expect(listRule).toContain('height:210px');
    expect(listRule).toContain('max-height:210px');
    expect(listRule).toContain('overflow-y:auto');
    expect(listRule).toContain('overflow-x:hidden');
    expect(listRule).toContain('padding:0');
    expect(listRule).toContain('contain:layout paint');
    expect(listRule).toContain('overscroll-behavior:contain');
    expect(listRule).toContain('scrollbar-gutter:stable');
    expect(css).toMatch(/\.hstar-font-option,.hstar-font-heading\{[^}]*height:30px/);
    expect(css).toMatch(/\.hstar-font-row-label\{[^}]*text-overflow:ellipsis/);
    expect(css).toMatch(/\.hstar-font-option\[data-active=true\]\{[^}]*outline:/);
  });

  it('applies styles to the whole object outside editing and syncs the top bar', async () => {
    const {controller, canvas, textObject, editor, fontManager} = createHarness();
    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    controller.applyProperty('fontFamily', 'Century Gothic');

    expect(textObject.set).toHaveBeenCalledWith({fontFamily:'Century Gothic'});
    expect(document.getElementById('text-font').value).toBe('Century Gothic');
    expect(editor.saveHistory).toHaveBeenCalledWith(expect.stringContaining('修改文字'));
    expect(fontManager.scanEditor).toHaveBeenCalledWith(editor);
    controller.destroy();
  });

  it('shows a grouped family while applying the selected real installed face', async () => {
    const {controller, canvas, textObject, fontManager} = createHarness();
    textObject.fontFamily = 'DengXian Light';
    textObject.fontWeight = 300;
    fontManager.resolveFamily = vi.fn(face => face.startsWith('DengXian') ? 'DengXian' : face);
    fontManager.stylesFor = vi.fn(family => family === 'DengXian' ? [
      {id:'dengxian-light', family:'DengXian Light', label:'Light', weight:300, italic:false, localNames:['等线 Light']},
      {id:'dengxian-regular', family:'DengXian', label:'Regular', weight:400, italic:false, localNames:['等线']},
    ] : []);
    fontManager.styleForFace = vi.fn(face => face === 'DengXian Light'
      ? {id:'dengxian-light', family:'DengXian Light', label:'Light', weight:300, italic:false}
      : null);
    fontManager.defaultStyleFor = vi.fn(() => (
      {id:'dengxian-regular', family:'DengXian', label:'Regular', weight:400, italic:false}
    ));

    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    expect(document.querySelector('[data-text-family="other"] [data-text-family-label]').textContent).toBe('DengXian');
    const style = document.querySelector('[data-text-style]');
    expect(style.value).toBe('dengxian-light');

    style.value = 'dengxian-regular';
    style.dispatchEvent(new Event('change', {bubbles:true}));

    expect(textObject.set).toHaveBeenCalledWith({fontFamily:'DengXian'});
    expect(textObject.set).toHaveBeenCalledWith({fontWeight:400});
    expect(textObject.set).toHaveBeenCalledWith({fontStyle:'normal'});
    controller.destroy();
  });

  it('shows Cambria and Cambria Math as default and Math faces of one family', async () => {
    const {controller, canvas, textObject, fontManager} = createHarness();
    textObject.fontFamily = 'Cambria';
    fontManager.resolveFamily = vi.fn(() => 'Cambria');
    fontManager.stylesFor = vi.fn(() => [
      {id:'cambria-default', family:'Cambria', label:'Default', weight:400, italic:false, localNames:['Cambria']},
      {id:'cambria-math', family:'Cambria Math', label:'Math', weight:400, italic:false, localNames:['Cambria Math']},
    ]);
    fontManager.styleForFace = vi.fn(() => (
      {id:'cambria-default', family:'Cambria', label:'Default', weight:400, italic:false}
    ));

    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    expect(document.querySelector('[data-text-family="other"] [data-text-family-label]').textContent).toBe('Cambria');
    expect([...document.querySelector('[data-text-style]').options].map(option => option.textContent))
      .toEqual(['默认', 'Math']);
    controller.destroy();
  });

  it('keeps complete font properties populated when all text is selected', async () => {
    const {controller, canvas, textObject} = createHarness({
      editing:true,
      selectionStart:0,
      selectionEnd:3,
    });
    textObject.getSelectionStyles.mockImplementation(function getSelectionStyles(start, end, complete) {
      return Array.from({length:Math.max(0, end - start)}, () => complete ? {
        fontFamily:this.fontFamily,
        fontSize:this.fontSize,
        fontWeight:this.fontWeight,
        fontStyle:this.fontStyle,
        fill:this.fill,
        underline:this.underline,
        linethrough:this.linethrough,
      } : {});
    });

    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    expect(textObject.getSelectionStyles).toHaveBeenCalledWith(0, 3, true);
    expect(document.querySelector('[data-text-family-label]').textContent).toBe('Microsoft YaHei UI');
    expect(document.querySelector('[data-text-style]').value).not.toBe('');
    expect(document.querySelector('[data-text-size]').value).toBe('36');
    expect(document.getElementById('text-font').value).toBe('Microsoft YaHei UI');
    expect(document.getElementById('text-size').value).toBe('36');
    controller.destroy();
  });

  it('applies supported character styles only to the selected range', async () => {
    const {controller, canvas, textObject} = createHarness({editing:true, selectionStart:1, selectionEnd:3});
    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    controller.applyProperty('fontWeight', 700);

    expect(textObject.setSelectionStyles).toHaveBeenCalledWith({fontWeight:700}, 1, 3);
    expect(textObject.set).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('stores a caret style and applies it only to newly typed characters', async () => {
    const {controller, canvas, textObject} = createHarness({editing:true, selectionStart:3, selectionEnd:3});
    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    controller.applyProperty('fontFamily', 'Century Gothic');
    const chinese = document.querySelector('[data-text-family="zh"]');
    const other = document.querySelector('[data-text-family="other"]');
    expect(chinese.querySelector('[data-text-family-label]').textContent).toBe('选择字体');
    expect(other.querySelector('[data-text-family-label]').textContent).toBe('Century Gothic');
    other.click();
    expect(document.querySelector('[data-family="Century Gothic"]').getAttribute('aria-selected')).toBe('true');
    other.click();

    controller.applyProperty('fill', '#ef4444');
    textObject.text = 'abcX';
    textObject.selectionStart = textObject.selectionEnd = 4;
    canvas.fire('text:changed', {target:textObject});

    expect(textObject.setSelectionStyles).toHaveBeenCalledWith({
      fontFamily:'Century Gothic',
      fill:'#ef4444',
    }, 3, 4);
    expect(textObject.set).not.toHaveBeenCalled();
    controller.destroy();
  });

  it('keeps paragraph properties object-level and exposes tracking and kerning modes', async () => {
    const {controller, canvas, textObject} = createHarness({editing:true, selectionStart:1, selectionEnd:3});
    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    controller.applyProperty('textAlign', 'center');
    controller.applyProperty('lineHeight', 1.5);
    controller.applyProperty('charSpacing', 40);
    controller.applyKerning('metrics');
    expect(textObject.set).toHaveBeenCalledWith({textAlign:'center'});
    expect(textObject.set).toHaveBeenCalledWith({lineHeight:1.5});
    expect(textObject.set).toHaveBeenCalledWith({charSpacing:0, hstarKerningMode:'metrics'});

    controller.applyKerning('numeric', 80);
    expect(textObject.set).toHaveBeenCalledWith({charSpacing:80, hstarKerningMode:'numeric'});
    expect(document.querySelector('[data-text-kerning-mode]').value).toBe('numeric');
    controller.destroy();
  });

  it('converts points to Fabric pixels and records one dirty history event per change', async () => {
    const {controller, canvas, textObject, editor} = createHarness();
    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});
    const dirty = vi.fn();
    window.addEventListener('openshop:project-dirty', dirty);

    controller.applyProperty('fontSize', 72);

    expect(textObject.set).toHaveBeenCalledWith({fontSize:96});
    expect(document.querySelector('[data-text-size]').value).toBe('72');
    expect(editor.saveHistory).toHaveBeenCalledTimes(1);
    expect(dirty).toHaveBeenCalledTimes(1);
    window.removeEventListener('openshop:project-dirty', dirty);
    controller.destroy();
  });

  it('uses the shared color panel for live text preview and one committed history entry', async () => {
    const {controller, canvas, textObject, editor} = createHarness();
    editor._colorPanelController = {open:vi.fn()};
    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    const color = document.querySelector('[data-text-color]');
    color.click();
    expect(editor._colorPanelController.open).toHaveBeenCalledOnce();
    const [target, anchor, binding] = editor._colorPanelController.open.mock.calls[0];
    expect(target).toBe('text');
    expect(anchor).toBe(color);
    expect(binding).toMatchObject({
      color:'#ffffff',
      title:'选择文字颜色',
      commitOnOutside:true,
    });

    binding.onPreview('#22c55e');
    expect(textObject.set).toHaveBeenCalledWith({fill:'#22c55e'});
    expect(editor.state.textColor).toBe('#22c55e');
    expect(color.dataset.value).toBe('#22c55e');
    expect(editor.saveHistory).not.toHaveBeenCalled();

    binding.onCommit('#22c55e');
    expect(editor.saveHistory).toHaveBeenCalledOnce();
    controller.destroy();
  });

  it('applies top-bar changes back to the active text object', async () => {
    const {controller, canvas, textObject} = createHarness();
    await controller.start();
    canvas.fire('selection:created', {selected:[textObject]});

    const size = document.getElementById('text-size');
    size.value = '36';
    size.dispatchEvent(new Event('change', {bubbles:true}));
    const color = document.getElementById('text-color');
    color.value = '#22c55e';
    color.dispatchEvent(new Event('change', {bubbles:true}));

    expect(textObject.set).toHaveBeenCalledWith({fontSize:48});
    expect(textObject.set).toHaveBeenCalledWith({fill:'#22c55e'});
    controller.destroy();
  });
});
