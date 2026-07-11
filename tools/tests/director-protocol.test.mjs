import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const sourcePath = 'static/js/director-protocol.js';
assert.equal(fs.existsSync(sourcePath), true, `${sourcePath} should exist`);

const src = fs.readFileSync(sourcePath, 'utf8');
const sandbox = { window: {}, console };
vm.createContext(sandbox);
vm.runInContext(src, sandbox, { filename: sourcePath });

const protocol = sandbox.window.HstarDirectorProtocol;
assert.equal(typeof protocol, 'object');
assert.equal(protocol.PROTOCOL_VERSION, 1);
assert.equal(protocol.SCENE_PREFIX, 'director:');
assert.equal(
  protocol.createSceneKey('classic', 'canvas-1', 'node-1'),
  'director:classic:canvas-1:node-1',
);
assert.equal(protocol.createStandaloneSceneKey(), 'director:standalone');

const envelope = protocol.createEnvelope({
  type: 'storyai:director-desk-session',
  sessionId: 's1',
  requestId: 'r1',
  context: {
    mode: 'node',
    canvasType: 'classic',
    canvasId: 'c1',
    nodeId: 'n1',
    instanceId: 'i1',
  },
  payload: { ok: true },
});

assert.equal(protocol.validateEnvelope(envelope).ok, true);
assert.equal(protocol.validateEnvelope({ ...envelope, protocolVersion: 999 }).ok, false);
assert.equal(protocol.validateEnvelope({ ...envelope, requestId: '' }).ok, false);
assert.equal(protocol.validateEnvelope({ ...envelope, type: 'bad-message' }).ok, false);
