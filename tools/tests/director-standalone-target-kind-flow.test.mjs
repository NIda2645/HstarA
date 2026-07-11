import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const protocolSource = fs.readFileSync('static/js/director-protocol.js', 'utf8');
const hostSource = fs.readFileSync('static/js/director-host.js', 'utf8');

class FakeClassList {
  constructor() {
    this.values = new Set();
  }
  add(value) {
    this.values.add(value);
  }
  remove(value) {
    this.values.delete(value);
  }
  contains(value) {
    return this.values.has(value);
  }
}

function createElement(id = '') {
  const listeners = new Map();
  const children = [];
  const element = {
    id,
    dataset: {},
    className: '',
    textContent: '',
    type: '',
    value: '',
    src: '',
    classList: new FakeClassList(),
    contentWindow: null,
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) {
        handler({ ...event, target: event.target || element, preventDefault() {} });
      }
      return true;
    },
    appendChild(child) {
      children.push(child);
      child.parentElement = element;
      return child;
    },
    get children() {
      return children;
    },
    querySelector(selector) {
      if (selector === '.director-target-row-title') return element.titleSpan || null;
      if (selector === '.director-target-row-meta') return element.metaSpan || null;
      if (selector === '.director-target-close') return element.closeButton || null;
      if (selector === '#director-target-create') return element.createButton || null;
      return children.find(child => child.matches?.(selector)) || null;
    },
    matches(selector) {
      return selector === `#${id}` || (selector.startsWith('.') && element.className.split(/\s+/).includes(selector.slice(1)));
    },
    set innerHTML(value) {
      element._innerHTML = value;
      if (String(value).includes('director-target-row-title')) {
        element.titleSpan = createElement();
        element.titleSpan.className = 'director-target-row-title';
        element.metaSpan = createElement();
        element.metaSpan.className = 'director-target-row-meta';
      }
      if (String(value).includes('director-target-create')) {
        element.closeButton = createElement();
        element.closeButton.className = 'director-target-close';
        element.createButton = createElement('director-target-create');
      }
    },
    get innerHTML() {
      return element._innerHTML || '';
    },
  };
  return element;
}

const listeners = new Map();
const directorFrameWindow = {};
const canvasMessages = [];
const sessionStorageWrites = [];
const canvasFrameWindow = {
  postMessage(message, origin) {
    canvasMessages.push({ message, origin });
  },
};

const directorFrame = createElement('frame-director-desk');
directorFrame.contentWindow = directorFrameWindow;
directorFrame.dataset.src = '/static/3d-director/index.html';

const canvasFrame = createElement('frame-canvas');
canvasFrame.contentWindow = canvasFrameWindow;

const picker = createElement('director-target-picker');
const list = createElement('director-target-list');
const elements = new Map([
  [directorFrame.id, directorFrame],
  [canvasFrame.id, canvasFrame],
  [picker.id, picker],
  [list.id, list],
]);

const switchedPages = [];
const windowRef = {
  location: { origin: 'http://127.0.0.1:3000' },
  crypto: { randomUUID: () => 'standalone-kind-uuid' },
  addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  },
  switchUI(_trigger, pageId) {
    switchedPages.push(pageId);
  },
};

function dispatchDirectorMessage(data) {
  for (const handler of listeners.get('message') || []) {
    handler({
      origin: 'http://127.0.0.1:3000',
      source: directorFrameWindow,
      data,
    });
  }
}

const sandbox = {
  console,
  CustomEvent: class CustomEvent {
    constructor(type, init = {}) {
      this.type = type;
      this.detail = init.detail;
    }
  },
  document: {
    body: createElement('body'),
    addEventListener() {},
    contains(value) {
      return [directorFrame, canvasFrame, picker, list].includes(value);
    },
    createElement,
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      if (String(selector).includes('canvas')) return createElement('canvas-nav');
      return null;
    },
  },
  fetch: async (url) => {
    if (url === '/api/projects') {
      return { ok: true, json: async () => ({ projects: [] }) };
    }
    if (url === '/api/canvases') {
      return { ok: true, json: async () => ({ canvases: [{ id: 'smart-canvas-1', title: '智能画布', kind: 'smart' }] }) };
    }
    if (url === '/api/ai/upload-base64') {
      return {
        ok: true,
        json: async () => ({ files: [{ url: '/uploads/standalone-shot.png', name: 'standalone-shot.png' }] }),
      };
    }
    throw new Error(`unexpected fetch: ${url}`);
  },
  localStorage: { getItem: () => null, setItem() {} },
  sessionStorage: {
    setItem(key, value) {
      sessionStorageWrites.push({ key, value });
    },
    getItem() {
      return null;
    },
    removeItem() {},
  },
  window: windowRef,
};
sandbox.window.document = sandbox.document;
sandbox.window.fetch = sandbox.fetch;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.sessionStorage = sandbox.sessionStorage;
sandbox.window.switchUI = sandbox.window.switchUI.bind(sandbox.window);

vm.createContext(sandbox);
vm.runInContext(protocolSource, sandbox, { filename: 'static/js/director-protocol.js' });
vm.runInContext(hostSource, sandbox, { filename: 'static/js/director-host.js' });

dispatchDirectorMessage(
  sandbox.window.HstarDirectorProtocol.createEnvelope({
    type: sandbox.window.HstarDirectorProtocol.TYPES.CAPTURES_SENT,
    sessionId: 'director-standalone-bootstrap',
    requestId: 'standalone-capture-r1',
    context: { mode: 'standalone', sceneKey: 'director:standalone' },
    payload: {
      captures: [{ dataUrl: 'data:image/png;base64,abc', fileName: 'standalone-shot.png' }],
    },
  }),
);
await new Promise(resolve => setTimeout(resolve, 0));

assert.equal(picker.classList.contains('is-open'), true, 'standalone send opens the canvas target picker');
assert.equal(list.children.length, 1, 'target picker renders one existing canvas row');
const targetButton = list.children[0];
assert.equal(targetButton.dataset.canvasType, 'smart', 'target picker preserves canvas.kind for smart canvases');

targetButton.dispatchEvent({ type: 'click' });
await new Promise(resolve => setTimeout(resolve, 0));

assert.match(canvasFrame.src, /^\/static\/smart-canvas\.html\?/, 'standalone import opens the selected smart canvas');
assert.equal(sessionStorageWrites.length, 1, 'standalone import stores a handoff for the target canvas before navigation');
assert.equal(sessionStorageWrites[0].key, 'hstar-director-standalone-handoff:smart:smart-canvas-1');
const storedHandoff = JSON.parse(sessionStorageWrites[0].value);
assert.equal(storedHandoff.type, 'hstar-director-standalone-captures');
assert.equal(storedHandoff.targetCanvasId, 'smart-canvas-1');
assert.equal(storedHandoff.targetCanvasType, 'smart');
canvasFrame.dispatchEvent({ type: 'load' });

assert.equal(switchedPages.at(-1), 'canvas', 'standalone import returns to the canvas page');
assert.equal(canvasMessages.length, 1, 'standalone import posts captures to the loaded canvas iframe');
assert.equal(canvasMessages[0].message.type, 'hstar-director-standalone-captures');
assert.equal(canvasMessages[0].message.targetCanvasId, 'smart-canvas-1');
assert.equal(canvasMessages[0].message.targetCanvasType, 'smart');
assert.equal(canvasMessages[0].message.captures[0].url, '/uploads/standalone-shot.png');
