import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const panelPath = resolve(testDir, '..', 'host', 'openshop-color-panel.js');

function createHarness({sampleHex = '#336699', sampleError = null} = {}) {
  document.body.innerHTML = `
    <button type="button" id="fg-color"></button>
    <button type="button" id="bg-color"></button>
    <input id="fg-picker" value="#112233">
    <input id="bg-picker" value="#445566">
  `;
  const editor = {
    state:{tool:'brush', fgColor:'#112233', bgColor:'#445566'},
    canvas:{defaultCursor:'default', hoverCursor:'default'},
    canvasW:800,
    canvasH:600,
    setFgColor:vi.fn(function setFgColor(value) { this.state.fgColor = value; }),
    setBgColor:vi.fn(function setBgColor(value) { this.state.bgColor = value; }),
    setTool:vi.fn(function setTool(tool) { this.state.tool = tool; }),
    toast:vi.fn(),
  };
  const sampler = {
    sample:vi.fn(() => {
      if(sampleError) throw sampleError;
      return {hex:sampleHex};
    }),
  };
  const controller = window.HstarOpenShopColorPanel.createController({
    editor,
    sampler,
    documentRef:document,
  });
  return {controller, editor, sampler};
}

describe('Hstar OpenShop color panel', () => {
  beforeEach(async () => {
    expect(existsSync(panelPath), `${panelPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopColorPanel;
    await import(`${pathToFileURL(panelPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('normalizes colors and round-trips RGB and HSV values', () => {
    const api = window.HstarOpenShopColorPanel;

    expect(api.normalizeHex('#F43F46')).toBe('#f43f46');
    expect(api.normalizeHex('bad', '#123456')).toBe('#123456');
    expect(api.rgbToHex({r:300, g:-2, b:70})).toBe('#ff0046');
    expect(api.hexToRgb('#336699')).toEqual({r:51, g:102, b:153});
    expect(api.hsvToRgb(api.rgbToHsv({r:51, g:102, b:153}))).toEqual({r:51, g:102, b:153});
  });

  it('cancels foreground drafts and commits background drafts', () => {
    const {controller, editor} = createHarness();
    controller.start();

    controller.open('foreground');
    controller.setDraft('#f43f46');
    controller.cancel();
    expect(editor.setFgColor).not.toHaveBeenCalled();
    expect(controller.getState()).toMatchObject({target:null, draft:'#112233'});

    controller.open('background');
    controller.setDraft('#123456');
    controller.commit();
    expect(editor.setBgColor).toHaveBeenCalledWith('#123456');
    expect(controller.getState()).toMatchObject({target:null, draft:'#123456'});
    controller.destroy();
  });

  it('samples the current canvas once and restores the previous tool', () => {
    const {controller, editor, sampler} = createHarness();
    controller.start();
    controller.open('foreground');
    controller.beginSampling();

    expect(controller.getState()).toMatchObject({sampling:true, previousTool:'brush'});
    expect(editor.canvas.defaultCursor).toBe('crosshair');

    const handled = controller.handleCanvasSample({
      event:{offsetX:12, offsetY:18},
      documentPoint:{x:12, y:18},
    });

    expect(handled).toBe(true);
    expect(sampler.sample).toHaveBeenCalledWith(expect.objectContaining({
      canvas:editor.canvas,
      documentPoint:{x:12, y:18},
      documentWidth:800,
      documentHeight:600,
    }));
    expect(editor.setFgColor).toHaveBeenCalledWith('#336699');
    expect(editor.setTool).toHaveBeenCalledWith('brush', {forceInteraction:true});
    expect(controller.getState()).toMatchObject({sampling:false, target:null, draft:'#336699'});
    controller.destroy();
  });

  it('keeps the original color after a failed sample and allows Escape to cancel', () => {
    const {controller, editor} = createHarness({sampleError:new Error('outside')});
    controller.start();
    controller.open('background');
    controller.beginSampling();

    expect(controller.handleCanvasSample({event:{}, documentPoint:{x:-1, y:-1}})).toBe(true);
    expect(editor.setBgColor).not.toHaveBeenCalled();
    expect(controller.getState().sampling).toBe(true);
    expect(editor.toast).toHaveBeenCalledWith('outside', 'error');

    document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true}));
    expect(controller.getState().sampling).toBe(false);
    expect(editor.setTool).toHaveBeenCalledWith('brush', {forceInteraction:true});
    expect(editor.state.bgColor).toBe('#445566');
    controller.destroy();
  });
});
