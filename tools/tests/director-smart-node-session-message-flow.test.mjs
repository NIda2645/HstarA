import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const protocolSource = fs.readFileSync('static/js/director-protocol.js', 'utf8');
const hostSource = fs.readFileSync('static/js/director-host.js', 'utf8');

function createElement(id = '') {
  const listeners = new Map();
  return {
    id,
    dataset: {},
    classList: { add() {}, remove() {}, contains() { return false; } },
    src: '',
    addEventListener(type, handler) {
      const handlers = listeners.get(type) || [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    dispatchEvent(event) {
      for (const handler of listeners.get(event.type) || []) handler(event);
    },
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
const uploads = [];

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
  crypto: { randomUUID: () => `smart-flow-${uploads.length + directorMessages.length}` },
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
  fetch: async (url, options = {}) => {
    if (url === '/api/ai/upload-base64') {
      const body = JSON.parse(options.body || '{}');
      uploads.push(body);
      return {
        ok: true,
        json: async () => ({
          files: [
            {
              url: `/uploads/${body.name}`,
              name: body.name,
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

sandbox.window.HstarDirectorHost.openNodeSession(
  {
    mode: 'node',
    canvasType: 'smart',
    canvasId: 'smart-canvas-1',
    nodeId: 'smart-director-node-1',
    frameId: 'frame-canvas',
    sceneKey: 'director:smart:smart-canvas-1:smart-director-node-1',
    instanceId: 'director:smart:smart-canvas-1:smart-director-node-1',
  },
  { imageUrl: '/uploads/panorama.png', fileName: 'panorama.png' },
);

assert.deepEqual(switchedPages, ['director-desk']);
assert.equal(
  directorFrame.src,
  '/static/3d-director/index.html?instanceId=director%3Asmart%3Asmart-canvas-1%3Asmart-director-node-1',
  'smart node sessions load the director iframe with the smart node instance id',
);

dispatchDirectorMessage(
  sandbox.window.HstarDirectorProtocol.createEnvelope({
    type: sandbox.window.HstarDirectorProtocol.TYPES.READY,
    sessionId: 'director-standalone-bootstrap',
    requestId: 'ready-smart-r1',
    context: { mode: 'standalone', sceneKey: 'director:standalone' },
    payload: { ready: true },
  }),
);

assert.equal(directorMessages[0].message.type, sandbox.window.HstarDirectorProtocol.TYPES.SESSION);
assert.equal(directorMessages[0].message.context.canvasType, 'smart');
const nodeSessionId = directorMessages[0].message.sessionId;

dispatchDirectorMessage(
  sandbox.window.HstarDirectorProtocol.createEnvelope({
    type: sandbox.window.HstarDirectorProtocol.TYPES.CAPTURES_SENT,
    sessionId: nodeSessionId,
    requestId: 'smart-captures-r1',
    context: {
      mode: 'node',
      canvasType: 'smart',
      canvasId: 'smart-canvas-1',
      nodeId: 'smart-director-node-1',
      sceneKey: 'director:smart:smart-canvas-1:smart-director-node-1',
    },
    payload: {
      captures: [1, 2, 3, 4].map((index) => ({
        dataUrl: `data:image/png;base64,smart${index}`,
        fileName: `smart-capture-${index}.png`,
      })),
    },
  }),
);
await new Promise((resolve) => setTimeout(resolve, 0));

assert.equal(uploads.length, 4, 'send-all uploads every Director screenshot before importing');
assert.equal(canvasMessages.length, 1, 'send-all forwards one import message to the original smart canvas iframe');
assert.equal(canvasMessages[0].message.type, 'hstar-director-captures');
assert.equal(canvasMessages[0].message.context.canvasType, 'smart');
assert.equal(canvasMessages[0].message.context.canvasId, 'smart-canvas-1');
assert.equal(canvasMessages[0].message.context.nodeId, 'smart-director-node-1');
assert.equal(canvasMessages[0].message.captures.length, 4);
assert.deepEqual(
  Array.from(canvasMessages[0].message.captures, (capture) => capture.url),
  [
    '/uploads/smart-capture-1.png',
    '/uploads/smart-capture-2.png',
    '/uploads/smart-capture-3.png',
    '/uploads/smart-capture-4.png',
  ],
);
assert.equal(switchedPages.at(-1), 'canvas', 'send-all returns to the canvas page after forwarding screenshots');
