import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const modulePath = resolve(testDir, '..', 'host', 'openshop-panel-splitter.js');

function createHarness({total = 700, secondaryHeight = 230} = {}) {
  document.body.innerHTML = `
    <aside id="panels">
      <section id="ptg1-group"></section>
      <div id="panel-group-splitter" role="separator" tabindex="0"></div>
      <section id="ptg2-group"></section>
    </aside>`;
  const primary = document.getElementById('ptg1-group');
  const secondary = document.getElementById('ptg2-group');
  const splitter = document.getElementById('panel-group-splitter');
  secondary.style.flexBasis = `${secondaryHeight}px`;
  secondary.getBoundingClientRect = vi.fn(() => ({height:Number.parseFloat(secondary.style.flexBasis)}));
  primary.getBoundingClientRect = vi.fn(() => ({height:total - Number.parseFloat(secondary.style.flexBasis)}));
  const controller = window.HstarOpenShopPanelSplitter.createController({
    documentRef:document,
    root:window,
    primary,
    secondary,
    splitter,
    minPrimary:180,
    minSecondary:100,
  });
  return {controller, primary, secondary, splitter};
}

describe('Hstar OpenShop panel splitter', () => {
  beforeEach(async () => {
    expect(existsSync(modulePath), `${modulePath} should exist`).toBe(true);
    vi.resetModules();
    localStorage.clear();
    delete window.HstarOpenShopPanelSplitter;
    await import(`${pathToFileURL(modulePath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('drags downward to grow layers while shrinking the text and color region', () => {
    const {controller, secondary, splitter} = createHarness();
    controller.start();

    splitter.dispatchEvent(new MouseEvent('pointerdown', {clientY:300, button:0, bubbles:true}));
    document.dispatchEvent(new MouseEvent('pointermove', {clientY:380, bubbles:true}));

    expect(secondary.style.flexBasis).toBe('150px');
    expect(document.body.classList).toContain('panel-split-resizing');
    document.dispatchEvent(new MouseEvent('pointerup', {clientY:380, bubbles:true}));
    expect(document.body.classList).not.toContain('panel-split-resizing');
    expect(localStorage.getItem('openshop.panel.secondaryHeight')).toBe('150');
    controller.destroy();
  });

  it('clamps both panel regions and supports keyboard resizing', () => {
    const {controller, secondary, splitter} = createHarness({total:500, secondaryHeight:180});
    controller.start();

    splitter.dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowUp', bubbles:true}));
    expect(secondary.style.flexBasis).toBe('196px');
    splitter.dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}));
    expect(secondary.style.flexBasis).toBe('320px');
    splitter.dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}));
    expect(secondary.style.flexBasis).toBe('100px');
    controller.destroy();
  });

  it('restores the saved secondary height on the next start', () => {
    localStorage.setItem('openshop.panel.secondaryHeight', '140');
    const {controller, secondary} = createHarness();

    controller.start();

    expect(secondary.style.flexBasis).toBe('140px');
    controller.destroy();
  });
});
