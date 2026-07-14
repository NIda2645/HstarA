import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-i18n.js');
const localePath = resolve(testDir, '..', 'locales', 'zh-CN.js');
const indexHtml = readFileSync(resolve(testDir, '..', 'index.html'), 'utf8');

async function loadI18n() {
  await import(`${pathToFileURL(runtimePath).href}?runtime=${Date.now()}-${Math.random()}`);
  await import(`${pathToFileURL(localePath).href}?locale=${Date.now()}-${Math.random()}`);
  return window.HstarOpenShopI18n;
}

function requireI18nFiles() {
  expect(existsSync(runtimePath), `${runtimePath} should exist`).toBe(true);
  expect(existsSync(localePath), `${localePath} should exist`).toBe(true);
  return existsSync(runtimePath) && existsSync(localePath);
}

describe('Hstar OpenShop localization runtime', () => {
  beforeEach(() => {
    window.HstarOpenShopI18n?.stopObserver();
    delete window.HstarOpenShopI18n;
    localStorage.clear();
    window.history.replaceState({}, '', '/');
    document.documentElement.lang = '';
    document.body.replaceChildren();
    vi.resetModules();
  });

  afterEach(() => {
    window.HstarOpenShopI18n?.stopObserver();
  });

  it('defaults to Chinese with English message ids as fallback', async () => {
    if (!requireI18nFiles()) return;
    const i18n = await loadI18n();

    expect(Object.isFrozen(i18n)).toBe(true);
    expect(i18n.DEFAULT_LOCALE).toBe('zh-CN');
    expect(i18n.FALLBACK_LOCALE).toBe('en-US');
    expect(i18n.getLocale()).toBe('zh-CN');
    expect(i18n.t('Layer')).toBe('图层');
    expect(i18n.t('Created {width} × {height} canvas', {
      width: 1920,
      height: 1080,
    })).toBe('已创建 1920 × 1080 画布');
    expect(i18n.t('Unknown application key')).toBe('Unknown application key');
    expect(document.documentElement.lang).toBe('zh-CN');

    const inheritedWidth = Object.create({ width: 999 });
    inheritedWidth.height = 1080;
    expect(i18n.t('Created {width} × {height} canvas', inheritedWidth))
      .toBe('已创建 {width} × 1080 画布');
  });

  it('loads localization before the core engine and delegates OS translations', () => {
    const runtimeScript = indexHtml.indexOf('<script src="./host/openshop-i18n.js"></script>');
    const localeScript = indexHtml.indexOf('<script src="./locales/zh-CN.js"></script>');
    const coreEngine = indexHtml.indexOf('const OS = {');

    expect(runtimeScript).toBeGreaterThan(0);
    expect(localeScript).toBeGreaterThan(runtimeScript);
    expect(coreEngine).toBeGreaterThan(localeScript);
    expect(indexHtml).not.toContain('_locales:');
    expect(indexHtml).toContain('_t(key, params) { return window.HstarOpenShopI18n.t(key, params); }');
  });

  it('translates only explicitly marked application UI', async () => {
    if (!requireI18nFiles()) return;
    const i18n = await loadI18n();
    document.body.innerHTML = `
      <button id="text" data-i18n="Layer">Layer<span class="shortcut">L</span></button>
      <button id="title" data-i18n-title="Layer" title="Layer"></button>
      <input id="placeholder" data-i18n-placeholder="Layer" placeholder="Layer">
      <button id="aria" data-i18n-aria-label="Layer" aria-label="Layer"></button>
      <div id="role-description" data-i18n-aria-roledescription="Layer" aria-roledescription="Layer"></div>
      <button id="tip" data-i18n-tip="Layer" data-tip="Layer"></button>
      <div id="user-text">User layer English text</div>
    `;

    i18n.translateTree(document);

    expect(document.querySelector('#text').childNodes[0].textContent).toBe('图层');
    expect(document.querySelector('#text .shortcut').textContent).toBe('L');
    expect(document.querySelector('#title').title).toBe('图层');
    expect(document.querySelector('#placeholder').placeholder).toBe('图层');
    expect(document.querySelector('#aria').getAttribute('aria-label')).toBe('图层');
    expect(document.querySelector('#role-description').getAttribute('aria-roledescription')).toBe('图层');
    expect(document.querySelector('#tip').dataset.tip).toBe('图层');
    expect(document.querySelector('#tip').getAttribute('aria-label')).toBe('图层');
    expect(document.querySelector('#user-text').textContent).toBe('User layer English text');

    expect(i18n.setLocale('en-US')).toBe(true);
    expect(localStorage.getItem('openshop_locale')).toBe('en-US');
    expect(document.querySelector('#text').childNodes[0].textContent).toBe('Layer');
    expect(document.querySelector('#user-text').textContent).toBe('User layer English text');
    expect(i18n.setLocale('unsupported')).toBe(false);
    expect(i18n.getLocale()).toBe('en-US');
  });

  it('observes only newly inserted explicit translation targets', async () => {
    if (!requireI18nFiles()) return;
    const i18n = await loadI18n();
    i18n.startObserver(document.body);

    const wrapper = document.createElement('div');
    wrapper.innerHTML = '<span id="dynamic" data-i18n="Layer">Layer</span><span id="user">User Layer</span>';
    document.body.appendChild(wrapper);
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 0));

    expect(document.querySelector('#dynamic').textContent).toBe('图层');
    expect(document.querySelector('#user').textContent).toBe('User Layer');
  });

  it('lets a query locale override persistence without rewriting it', async () => {
    if (!requireI18nFiles()) return;
    localStorage.setItem('openshop_locale', 'en-US');
    window.history.replaceState({}, '', '/?lang=zh-CN');

    const i18n = await loadI18n();

    expect(i18n.getLocale()).toBe('zh-CN');
    expect(localStorage.getItem('openshop_locale')).toBe('en-US');
  });
});
