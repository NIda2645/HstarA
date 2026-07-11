import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const protocolSource = fs.readFileSync('static/js/director-protocol.js', 'utf8');
const hostSource = fs.readFileSync('static/js/director-host.js', 'utf8');

function createElement(id = '') {
  return {
    id,
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    src: '',
    addEventListener() {},
    appendChild() {},
    querySelector() {
      return null;
    },
  };
}

const listeners = new Map();
const switchedPages = [];
const directorMessages = [];
const canvasMessages = [];
const frameWindow = {
  postMessage(message, origin) {
    directorMessages.push({ message, origin });
  },
};
const canvasWindow = {
  postMessage(message, origin) {
    canvasMessages.push({ message, origin });
  },
};

const directorFrame = createElement('frame-director-desk');
directorFrame.dataset.src = '/static/3d-director/index.html';
directorFrame.contentWindow = frameWindow;

const canvasFrame = createElement('frame-canvas');
canvasFrame.contentWindow = canvasWindow;

const elements = new Map([
  [directorFrame.id, directorFrame],
  [canvasFrame.id, canvasFrame],
]);

const windowRef = {
  location: { origin: 'http://127.0.0.1:3000' },
  crypto: { randomUUID: () => 'node-flow-uuid' },
  addEventListener(type, handler) {
    const handlers = listeners.get(type) || [];
    handlers.push(handler);
    listeners.set(type, handlers);
  },
  switchUI(_trigger, pageId) {
    switchedPages.push(pageId);
  },
};

function dispatchMessage(data) {
  for (const handler of listeners.get('message') || []) {
    handler({
      origin: 'http://127.0.0.1:3000',
      source: frameWindow,
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
      return value === directorFrame || value === canvasFrame;
    },
    createElement,
    getElementById(id) {
      return elements.get(id) || null;
    },
    querySelector(selector) {
      if (String(selector).includes('director-desk')) return createElement('director-nav');
      if (String(selector).includes('canvas')) return createElement('canvas-nav');
      return null;
    },
  },
  fetch: async (url) => {
    if (url === '/api/ai/upload-base64') {
      return {
        ok: true,
        json: async () => ({
          files: [
            {
              url: '/uploads/director-node-capture.png',
              name: 'current-view.png',
              kind: 'image',
            },
          ],
        }),
      };
    }
    return { ok: true, json: async () => ({}) };
  },
  localStorage: { getItem: () => null, setItem() {} },
  window: windowRef,
};
sandbox.window.document = sandbox.document;
sandbox.window.fetch = sandbox.fetch;
sandbox.window.localStorage = sandbox.localStorage;
sandbox.window.switchUI = sandbox.window.switchUI.bind(sandbox.window);

vm.createContext(sandbox);
vm.runInContext(protocolSource, sandbox, { filename: 'static/js/director-protocol.js' });
vm.runInContext(hostSource, sandbox, { filename: 'static/js/director-host.js' });

assert.equal(typeof sandbox.window.HstarDirectorHost?.openNodeSession, 'function');

sandbox.window.HstarDirectorHost.openNodeSession(
  {
    mode: 'node',
    canvasType: 'classic',
    canvasId: 'canvas-1',
    nodeId: 'director-node-1',
    frameId: 'frame-canvas',
    sceneKey: 'director:classic:canvas-1:director-node-1',
    instanceId: 'director:classic:canvas-1:director-node-1',
  },
  { imageUrl: '/uploads/panorama.png', fileName: 'panorama.png' },
);

assert.deepEqual(switchedPages, ['director-desk']);
assert.equal(directorMessages.length, 0, 'node session messages wait for director iframe READY');
assert.equal(
  directorFrame.src,
  '/static/3d-director/index.html?instanceId=director%3Aclassic%3Acanvas-1%3Adirector-node-1',
  'node sessions load the director iframe with the node-scoped instance id before READY',
);

dispatchMessage(
  sandbox.window.HstarDirectorProtocol.createEnvelope({
    type: sandbox.window.HstarDirectorProtocol.TYPES.READY,
    sessionId: 'director-standalone-bootstrap',
    requestId: 'ready-r1',
    context: { mode: 'standalone', sceneKey: 'director:standalone' },
    payload: { ready: true },
  }),
);

assert.equal(directorMessages.length, 2, 'bootstrap READY should flush node session and panorama messages');
assert.equal(directorMessages[0].message.type, sandbox.window.HstarDirectorProtocol.TYPES.SESSION);
assert.equal(directorMessages[1].message.type, sandbox.window.HstarDirectorProtocol.TYPES.PANORAMA);
const nodeSessionId = directorMessages[0].message.sessionId;

dispatchMessage(
  sandbox.window.HstarDirectorProtocol.createEnvelope({
    type: sandbox.window.HstarDirectorProtocol.TYPES.CAPTURES_SENT,
    sessionId: nodeSessionId,
    requestId: 'captures-r1',
    context: {
      mode: 'node',
      canvasType: 'classic',
      canvasId: 'canvas-1',
      nodeId: 'director-node-1',
      sceneKey: 'director:classic:canvas-1:director-node-1',
    },
    payload: {
      captures: [
        {
          dataUrl: 'data:image/png;base64,abc',
          fileName: 'current-view.png',
        },
      ],
    },
  }),
);
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(canvasMessages.length, 1, 'node capture import should be forwarded to the original canvas iframe');
assert.equal(canvasMessages[0].message.type, 'hstar-director-captures');
assert.equal(canvasMessages[0].message.context.nodeId, 'director-node-1');
assert.equal(canvasMessages[0].message.captures[0].url, '/uploads/director-node-capture.png');
assert.equal(switchedPages.at(-1), 'canvas', 'capture import returns to the original canvas page');

dispatchMessage(
  sandbox.window.HstarDirectorProtocol.createEnvelope({
    type: sandbox.window.HstarDirectorProtocol.TYPES.CLOSE,
    sessionId: nodeSessionId,
    requestId: 'close-r1',
    context: {
      mode: 'node',
      canvasType: 'classic',
      canvasId: 'canvas-1',
      nodeId: 'director-node-1',
      sceneKey: 'director:classic:canvas-1:director-node-1',
    },
    payload: {},
  }),
);

assert.equal(switchedPages.at(-1), 'canvas', 'close returns to the original canvas page');

sandbox.window.HstarDirectorHost.onPageSwitch('director-desk', directorFrame);
assert.equal(
  directorFrame.src,
  '/static/3d-director/index.html?instanceId=director%3Astandalone',
  'left navigation opens an independent standalone director scene after a node session',
);
