import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = 'static/js/openshop-protocol.js';
assert.equal(fs.existsSync(sourcePath), true, `${sourcePath} should exist`);

const source = fs.readFileSync(sourcePath, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(source, sandbox, { filename: sourcePath });

const protocol = sandbox.window.HstarOpenShopProtocol;
assert.equal(typeof protocol, 'object');
assert.equal(protocol.PROTOCOL_VERSION, 1);
assert.equal(
  protocol.createProjectScope({
    canvasType: 'smart',
    canvasId: 'canvas-1',
    nodeId: 'node-1',
    projectId: 'project-1',
  }),
  'openshop:smart:canvas-1:node-1:project-1',
);

const envelope = protocol.createEnvelope({
  type: protocol.TYPES.OPEN_SESSION,
  sessionId: 'session-1',
  requestId: 'request-1',
  context: {
    canvasType: 'smart',
    canvasId: 'canvas-1',
    nodeId: 'node-1',
    projectId: 'project-1',
  },
  payload: { ok: true },
});

assert.equal(protocol.validateEnvelope(envelope).ok, true);
assert.equal(protocol.validateEnvelope({ ...envelope, sessionId: '' }).ok, false);
assert.equal(protocol.validateEnvelope({
  ...envelope,
  context: { ...envelope.context, nodeId: '' },
}).ok, false);
assert.equal(protocol.validateEnvelope({ ...envelope, protocolVersion: 999 }).ok, false);

console.log('OpenShop protocol tests passed');
