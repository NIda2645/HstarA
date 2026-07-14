(function initOpenShopI18n(global) {
  'use strict';

  const DEFAULT_LOCALE = 'zh-CN';
  const FALLBACK_LOCALE = 'en-US';
  const STORAGE_KEY = 'openshop_locale';
  const SUPPORTED_LOCALES = new Set([DEFAULT_LOCALE, FALLBACK_LOCALE]);
  const TRANSLATION_SELECTOR = [
    '[data-i18n]',
    '[data-i18n-title]',
    '[data-i18n-placeholder]',
    '[data-i18n-aria-label]',
    '[data-i18n-aria-roledescription]',
    '[data-i18n-tip]',
  ].join(',');
  const dictionaries = new Map([[FALLBACK_LOCALE, Object.freeze({})]]);
  let observer = null;

  function supportedLocale(value) {
    return typeof value === 'string' && SUPPORTED_LOCALES.has(value) ? value : null;
  }

  function readPersistedLocale() {
    try {
      return supportedLocale(global.localStorage?.getItem(STORAGE_KEY));
    } catch {
      return null;
    }
  }

  function queryLocale() {
    try {
      return supportedLocale(new URLSearchParams(global.location?.search || '').get('lang'));
    } catch {
      return null;
    }
  }

  let currentLocale = queryLocale() || readPersistedLocale() || DEFAULT_LOCALE;

  function updateDocumentLanguage() {
    if (global.document?.documentElement) {
      global.document.documentElement.lang = currentLocale;
    }
  }

  function register(locale, messages) {
    const normalizedLocale = supportedLocale(locale);
    if (!normalizedLocale || !messages || typeof messages !== 'object' || Array.isArray(messages)) {
      return false;
    }
    const currentMessages = dictionaries.get(normalizedLocale) || {};
    dictionaries.set(normalizedLocale, Object.freeze({ ...currentMessages, ...messages }));
    if (normalizedLocale === currentLocale && global.document) {
      translateTree(global.document);
    }
    return true;
  }

  function interpolate(template, params) {
    if (!params || typeof params !== 'object') return template;
    return template.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (match, token) => (
      Object.prototype.hasOwnProperty.call(params, token) ? String(params[token]) : match
    ));
  }

  function t(messageId, params) {
    const key = String(messageId ?? '');
    const dictionary = dictionaries.get(currentLocale) || {};
    const translated = currentLocale === FALLBACK_LOCALE ? key : dictionary[key] || key;
    return interpolate(translated, params);
  }

  function translatedTextNode(element, messageId) {
    const translated = t(messageId);
    const textNode = Array.from(element.childNodes).find((node) => (
      node.nodeType === global.Node.TEXT_NODE && node.textContent.trim()
    ));
    if (!textNode) {
      if (element.children.length === 0) element.textContent = translated;
      else element.insertBefore(global.document.createTextNode(translated), element.firstChild);
      return;
    }
    const leadingSpace = textNode.textContent.match(/^\s*/)?.[0] || '';
    const trailingSpace = textNode.textContent.match(/\s*$/)?.[0] || '';
    textNode.textContent = `${leadingSpace}${translated}${trailingSpace}`;
  }

  function translateElement(element) {
    const textKey = element.getAttribute('data-i18n');
    if (textKey) translatedTextNode(element, textKey);

    const attributeKeys = [
      ['data-i18n-title', 'title'],
      ['data-i18n-placeholder', 'placeholder'],
      ['data-i18n-aria-label', 'aria-label'],
      ['data-i18n-aria-roledescription', 'aria-roledescription'],
    ];
    for (const [dataAttribute, targetAttribute] of attributeKeys) {
      const key = element.getAttribute(dataAttribute);
      if (key) element.setAttribute(targetAttribute, t(key));
    }

    const tipKey = element.getAttribute('data-i18n-tip');
    if (tipKey) {
      const translated = t(tipKey);
      element.dataset.tip = translated;
      element.setAttribute('aria-label', translated);
    }
  }

  function translateTree(root = global.document) {
    if (!root) return 0;
    const elements = [];
    if (root.nodeType === global.Node.ELEMENT_NODE && root.matches(TRANSLATION_SELECTOR)) {
      elements.push(root);
    }
    if (typeof root.querySelectorAll === 'function') {
      elements.push(...root.querySelectorAll(TRANSLATION_SELECTOR));
    }
    for (const element of elements) translateElement(element);
    return elements.length;
  }

  function stopObserver() {
    if (observer) observer.disconnect();
    observer = null;
  }

  function startObserver(root = global.document?.body) {
    stopObserver();
    if (!root || typeof global.MutationObserver !== 'function') return false;
    observer = new global.MutationObserver((mutations) => {
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === global.Node.ELEMENT_NODE) translateTree(node);
        }
      }
    });
    observer.observe(root, { childList: true, subtree: true });
    return true;
  }

  function setLocale(locale) {
    const normalizedLocale = supportedLocale(locale);
    if (!normalizedLocale) return false;
    currentLocale = normalizedLocale;
    try {
      global.localStorage?.setItem(STORAGE_KEY, normalizedLocale);
    } catch {
      // Storage can be unavailable in privacy mode; the in-memory locale still applies.
    }
    updateDocumentLanguage();
    translateTree(global.document);
    if (typeof global.CustomEvent === 'function') {
      global.dispatchEvent(new global.CustomEvent('hstar:openshop-locale-change', {
        detail: { locale: currentLocale },
      }));
    }
    return true;
  }

  function getLocale() {
    return currentLocale;
  }

  updateDocumentLanguage();
  const api = Object.freeze({
    DEFAULT_LOCALE,
    FALLBACK_LOCALE,
    register,
    t,
    getLocale,
    setLocale,
    translateTree,
    startObserver,
    stopObserver,
  });
  global.HstarOpenShopI18n = api;

  const initializeDocument = () => {
    updateDocumentLanguage();
    translateTree(global.document);
    startObserver(global.document?.body);
  };
  if (global.document?.readyState === 'loading') {
    global.document.addEventListener('DOMContentLoaded', initializeDocument, { once: true });
  } else {
    global.queueMicrotask(initializeDocument);
  }
}(window));
