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
  return {
    id,
    dataset: {},
    textContent: '',
    innerHTML: '',
    className: '',
    classList: new FakeClassList(),
    addEventListener() {},
    appendChild() {},
    querySelector() {
      return null;
    },
  };
}

const listeners = new Map();
const frameWindow = {};
const frame = createElement('frame-director-desk');
frame.contentWindow = frameWindow;
frame.dataset.src = '/static/3d-director/index.html';

const picker = createElement('director-target-picker');
const list = createElement('director-target-list');
const elements = new Map([
  [frame.id, frame],
  [picker.id, picker],
  [list.id, list],
]);

const windowRef = {
  location: { origin: 'http://127.0.0.1:3000' },
  crypto: { randomUUID: () => 'uuid' },
  addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  },
  dispatchEvent(event) {
    for (const handler of listeners.get(event.type) || []) {
      handler(event);
    }
    return true;
  },
};

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
      return value === frame || value === picker || value === list;
    },
    createElement,
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector() {
      return null;
    },
  },
  fetch: async (url) => {
    if (url === '/api/projects') {
      return { ok: true, json: async () => ({ projects: [] }) };
    }
    if (url === '/api/canvases') {
      return { ok: true, json: async () => ({ canvases: [] }) };
    }
    throw new Error(`unexpected fetch: ${url}`);
  },
  localStorage: { getItem: () => null },
  window: windowRef,
};
sandbox.window.document = sandbox.document;
sandbox.window.fetch = sandbox.fetch;
sandbox.window.localStorage = sandbox.localStorage;

vm.createContext(sandbox);

vm.runInContext(hostSource, sandbox, { filename: 'static/js/director-host.js' });
assert.equal(sandbox.window.HstarDirectorHost, undefined, 'host waits when protocol has not loaded yet');

vm.runInContext(protocolSource, sandbox, { filename: 'static/js/director-protocol.js' });
assert.equal(typeof sandbox.window.HstarDirectorHost, 'object', 'host initializes after protocol becomes available');

const envelope = sandbox.window.HstarDirectorProtocol.createEnvelope({
  type: sandbox.window.HstarDirectorProtocol.TYPES.CAPTURES_SENT,
  sessionId: 'director-standalone-bootstrap',
  requestId: 'capture-r1',
  context: { mode: 'standalone', sceneKey: 'director:standalone' },
  payload: {
    captures: [
      {
        dataUrl: 'data:image/png;base64,abc',
        fileName: 'director-capture.png',
      },
    ],
  },
});

for (const handler of listeners.get('message') || []) {
  handler({
    origin: 'http://127.0.0.1:3000',
    source: frameWindow,
    data: envelope,
  });
}
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(picker.classList.contains('is-open'), true, 'standalone capture import opens the target picker');
assert.equal(list.textContent, '暂无已有画布');
