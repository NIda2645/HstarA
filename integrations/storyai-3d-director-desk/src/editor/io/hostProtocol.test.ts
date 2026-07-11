import { describe, expect, it } from 'vitest';
import {
  PROTOCOL_VERSION,
  SCENE_PREFIX,
  createEnvelope,
  createSceneKey,
  createStandaloneSceneKey,
  validateEnvelope,
} from './hostProtocol';

describe('hostProtocol', () => {
  it('creates stable Director scene keys', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(SCENE_PREFIX).toBe('director:');
    expect(createSceneKey('classic', 'canvas-1', 'node-1')).toBe(
      'director:classic:canvas-1:node-1',
    );
    expect(createStandaloneSceneKey()).toBe('director:standalone');
  });

  it('validates Director envelopes', () => {
    const envelope = createEnvelope({
      type: 'storyai:director-desk-session',
      sessionId: 's1',
      requestId: 'r1',
      context: {
        mode: 'node',
        canvasType: 'smart',
        canvasId: 'c1',
        nodeId: 'n1',
        instanceId: 'i1',
      },
      payload: { ok: true },
    });

    expect(validateEnvelope(envelope).ok).toBe(true);
    expect(validateEnvelope({ ...envelope, protocolVersion: 999 }).ok).toBe(false);
    expect(validateEnvelope({ ...envelope, requestId: '' }).ok).toBe(false);
    expect(validateEnvelope({ ...envelope, type: 'bad-message' }).ok).toBe(false);
  });
});
