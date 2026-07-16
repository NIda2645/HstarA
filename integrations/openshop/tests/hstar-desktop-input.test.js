import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadOpenShop } from './os-harness.js';

const testDir = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(testDir, '..', 'host', 'openshop-desktop-input.js');
const indexPath = resolve(testDir, '..', 'index.html');

function loadDesktopInput() {
  delete window.HstarOpenShopDesktopInput;
  new Function(readFileSync(modulePath, 'utf8'))();
  return window.HstarOpenShopDesktopInput;
}

describe('OpenShop desktop input foundation', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    document.body.innerHTML = `
      <div id="toolbar" style="overflow:auto">
        <button class="tool-btn" data-tool="marquee-rect" data-tip="矩形选框工具">
          <span class="icon"></span>
        </button>
      </div>`;
  });

  afterEach(() => {
    vi.useRealTimers();
    delete window.HstarOpenShopDesktopInput;
  });

  it('shows a body-level localized tooltip with the Photoshop shortcut', () => {
    const desktop = loadDesktopInput();
    const button = document.querySelector('.tool-btn');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left:20, top:96, right:56, bottom:132, width:36, height:36,
    });
    Object.defineProperty(window, 'innerHeight', {value:120, configurable:true});

    const controller = desktop.createToolTooltipController({root:document, delay:250});
    button.dispatchEvent(new MouseEvent('pointerover', {bubbles:true}));
    vi.advanceTimersByTime(249);
    expect(document.getElementById('tool-tooltip').classList.contains('visible')).toBe(false);
    vi.advanceTimersByTime(1);

    const tooltip = document.getElementById('tool-tooltip');
    expect(tooltip.parentElement).toBe(document.body);
    expect(tooltip.textContent).toBe('矩形选框工具（M）');
    expect(tooltip.classList.contains('visible')).toBe(true);
    expect(Number.parseFloat(tooltip.style.left)).toBeGreaterThan(46);
    expect(Number.parseFloat(tooltip.style.top)).toBeLessThanOrEqual(112);
    expect(button.getAttribute('aria-label')).toBe('矩形选框工具（M）');

    controller.destroy();
    expect(document.getElementById('tool-tooltip')).toBeNull();
  });

  it('does not hide while the pointer moves inside the same tool button', () => {
    const desktop = loadDesktopInput();
    const button = document.querySelector('.tool-btn');
    const icon = button.querySelector('.icon');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left:20, top:20, right:56, bottom:56, width:36, height:36,
    });
    const controller = desktop.createToolTooltipController({root:document, delay:0});

    icon.dispatchEvent(new MouseEvent('pointerover', {bubbles:true}));
    vi.runAllTimers();
    icon.dispatchEvent(new MouseEvent('pointerout', {bubbles:true, relatedTarget:button}));

    expect(document.getElementById('tool-tooltip').classList.contains('visible')).toBe(true);
    controller.destroy();
  });

  it('defines Photoshop tool cycles from one registry', () => {
    const desktop = loadDesktopInput();

    expect(desktop.toolCycleForKey('b')).toEqual(['brush', 'pencil', 'spray']);
    expect(desktop.toolCycleForKey('U')).toEqual([
      'rect', 'circle', 'triangle', 'line', 'arrow', 'polygon', 'star',
    ]);
    expect(desktop.toolShortcut('line')).toBe('U');
    expect(desktop.toolShortcut('lasso')).toBe('L');
    expect(desktop.toolShortcut('note')).toBe('I');
  });

  it('supports plain, Ctrl, Shift, and Ctrl+Shift layer selection', () => {
    const desktop = loadDesktopInput();
    const layers = ['A', 'B', 'C', 'D'].map(name => ({name}));
    let state = desktop.resetLayerSelection(layers, layers[1]);

    state = desktop.selectLayerRange({layers, state, layer:layers[3], ctrl:false, shift:true});
    expect([...state.selected].map(layer => layer.name)).toEqual(['B', 'C', 'D']);
    expect(state.primary).toBe(layers[3]);
    expect(state.anchor).toBe(layers[1]);

    state = desktop.selectLayerRange({layers, state, layer:layers[0], ctrl:true, shift:false});
    expect([...state.selected].map(layer => layer.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(state.primary).toBe(layers[0]);
    expect(state.anchor).toBe(layers[1]);

    state = desktop.selectLayerRange({layers, state, layer:layers[2], ctrl:true, shift:true});
    expect([...state.selected].map(layer => layer.name)).toEqual(['A', 'B', 'C', 'D']);
    expect(state.primary).toBe(layers[2]);
    expect(state.anchor).toBe(layers[1]);
  });

  it('never leaves a nonempty layer list without a primary selection', () => {
    const desktop = loadDesktopInput();
    const only = {name:'Only'};
    const state = desktop.selectLayerRange({
      layers:[only],
      state:desktop.resetLayerSelection([only], only),
      layer:only,
      ctrl:true,
      shift:false,
    });

    expect([...state.selected]).toEqual([only]);
    expect(state.primary).toBe(only);
    expect(state.anchor).toBe(only);
  });

  it('resolves Photoshop commands and ignores editable targets', () => {
    const desktop = loadDesktopInput();

    expect(desktop.resolveShortcut(
      new KeyboardEvent('keydown', {key:'j', ctrlKey:true}),
      {context:'layers'},
    )).toEqual({command:'duplicate-context'});
    expect(desktop.resolveShortcut(
      new KeyboardEvent('keydown', {key:'Delete'}),
      {context:'layers'},
    )).toEqual({command:'delete-context'});
    expect(desktop.resolveShortcut(
      new KeyboardEvent('keydown', {key:'u', shiftKey:true}),
      {context:'canvas', currentTool:'rect'},
    )).toEqual({command:'cycle-tool', tool:'circle'});

    const input = document.createElement('input');
    expect(desktop.isEditableShortcutTarget(input, null)).toBe(true);
    expect(desktop.isEditableShortcutTarget(document.body, {isEditing:true})).toBe(true);
    expect(desktop.commandShortcut('duplicate-context')).toBe('Ctrl+J');
    expect(desktop.commandShortcut('preferences')).toBe('Ctrl+K');
    expect(desktop.shortcutRows()).toContainEqual(expect.objectContaining({
      id:'duplicate-context', keys:['Ctrl+J'],
    }));
    expect(desktop.shortcutRows()).toContainEqual(expect.objectContaining({
      id:'tool-b', keys:['B', 'Shift+B'],
    }));
  });

  it('keeps the editor tooltip localized and hides it when tool UI closes', () => {
    document.body.innerHTML = `
      <div id="toolbar">
        <button class="tool-btn" data-tool="select" data-tip="Move / Select Tool"
          data-i18n-tip="Move / Select Tool"></button>
      </div>`;
    const OS = loadOpenShop();
    OS._initI18n();
    const button = document.querySelector('.tool-btn');
    vi.spyOn(button, 'getBoundingClientRect').mockReturnValue({
      left:20, top:20, right:56, bottom:56, width:36, height:36,
    });

    button.dispatchEvent(new MouseEvent('pointerover', {bubbles:true}));
    vi.runAllTimers();
    expect(document.getElementById('tool-tooltip').textContent).toBe('Move / Select Tool（V）');

    expect(OS.setLocale('zh-CN')).toBe(true);
    expect(document.getElementById('tool-tooltip').textContent).toBe('移动工具 / 选择（V）');
    expect(button.getAttribute('aria-label')).toBe('移动工具 / 选择（V）');

    OS._closeAllFlyouts();
    expect(document.getElementById('tool-tooltip').classList.contains('visible')).toBe(false);
    OS._toolTooltipController.destroy();
    window.HstarOpenShopI18n.stopObserver();
  });

  it('loads the desktop module before the editor core and uses a body tooltip', () => {
    const html = readFileSync(indexPath, 'utf8');
    const moduleIndex = html.indexOf('<script src="./host/openshop-desktop-input.js"></script>');
    const coreIndex = html.indexOf('const OS = {');

    expect(moduleIndex).toBeGreaterThan(0);
    expect(moduleIndex).toBeLessThan(coreIndex);
    expect(html).toContain('#tool-tooltip{position:fixed');
    expect(html).not.toContain('.tool-btn:hover[data-tip]::after');
  });
});
