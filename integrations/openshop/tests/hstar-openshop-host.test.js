import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const protocolPath = resolve(testDir, '..', 'host', 'openshop-protocol.js');
const hostPath = resolve(testDir, '..', '..', '..', 'static', 'js', 'openshop-host.js');

async function mountHost() {
  delete window.HstarOpenShopHost;
  delete window.HstarOpenShopProtocol;
  document.body.innerHTML = '<main class="stage"><iframe id="frame-canvas" class="active"></iframe><iframe id="frame-settings"></iframe></main>';
  globalThis.MutationObserver = class UnsupportedMutationObserver {
    observe() {
      throw new TypeError("Failed to execute 'observe' on 'MutationObserver': parameter 1 is not of type 'Node'.");
    }
    disconnect() {}
  };
  window.switchUI = (_trigger, id) => {
    document.querySelectorAll('iframe').forEach(frame => frame.classList.remove('active'));
    document.getElementById(`frame-${id}`)?.classList.add('active');
  };
  window.lucide = {createIcons:vi.fn()};
  await import(`${pathToFileURL(protocolPath).href}?test=${Date.now()}-${Math.random()}`);
  window.eval(readFileSync(hostPath, 'utf8'));
  document.dispatchEvent(new Event('DOMContentLoaded'));
  return window.HstarOpenShopHost;
}

async function flushMutations() {
  await Promise.resolve();
  await new Promise(resolvePromise => setTimeout(resolvePromise, 0));
}

describe('Hstar OpenShop host page visibility', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('temporarily hides an open editor outside the canvas page and restores the same session', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic',
      canvasId:'canvas-1',
      nodeId:'node-1',
      projectId:'project-1',
      projectName:'图文分层',
      frameId:'frame-canvas',
      documentWidth:1920,
      documentHeight:1080,
    });

    const overlay = document.getElementById('openshop-host');
    const editorFrame = overlay.querySelector('iframe.openshop-session-frame');
    const sessionBefore = host.getState().activeSession;
    expect(overlay.classList.contains('is-open')).toBe(true);
    expect(overlay.hidden).toBe(false);

    window.switchUI(null, 'settings');
    await flushMutations();

    expect(overlay.hidden).toBe(true);
    expect(overlay.classList.contains('is-open')).toBe(true);
    expect(host.getState().activeSession).toEqual(sessionBefore);
    expect(host.getState().sessionCount).toBe(1);
    expect(overlay.querySelector('iframe.openshop-session-frame')).toBe(editorFrame);

    window.switchUI(null, 'canvas');
    await flushMutations();

    expect(overlay.hidden).toBe(false);
    expect(overlay.classList.contains('is-open')).toBe(true);
    expect(host.getState().activeSession).toEqual(sessionBefore);
    expect(overlay.querySelector('iframe.openshop-session-frame')).toBe(editorFrame);
  });

  it('does not reopen an editor that the user explicitly closed', async () => {
    const host = await mountHost();
    host.openNodeSession({
      canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
      projectName:'图文分层', frameId:'frame-canvas', documentWidth:1920, documentHeight:1080,
    });
    const overlay = document.getElementById('openshop-host');
    host.close();

    window.switchUI(null, 'settings');
    await flushMutations();
    window.switchUI(null, 'canvas');
    await flushMutations();

    expect(overlay.classList.contains('is-open')).toBe(false);
    expect(overlay.getAttribute('aria-hidden')).toBe('true');
  });
});
