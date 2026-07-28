import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const protocolPath = resolve(testDir, '..', 'host', 'openshop-protocol.js');

describe('Hstar OpenShop protocol', () => {
  beforeEach(async () => {
    expect(existsSync(protocolPath), `${protocolPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopProtocol;
    await import(`${pathToFileURL(protocolPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('creates node-isolated project scopes', () => {
    const protocol = window.HstarOpenShopProtocol;

    expect(protocol.PROTOCOL_VERSION).toBe(1);
    expect(protocol.TYPES).toMatchObject({
      FIT_WORKSPACE: 'hstar:openshop:fit-workspace',
      SYNC_SOURCES: 'hstar:openshop:sync-sources',
      RESOLVE_SOURCE_UPDATE: 'hstar:openshop:resolve-source-update',
      REQUEST_SAVE: 'hstar:openshop:request-save',
      SAVE_CONFIRMED: 'hstar:openshop:save-confirmed',
      REQUEST_SEND_TO_CANVAS: 'hstar:openshop:request-send-to-canvas',
      SEND_TO_CANVAS: 'hstar:openshop:send-to-canvas',
      REQUEST_DOWNLOAD_LOCAL: 'hstar:openshop:request-download-local',
      DOWNLOAD_LOCAL_RESULT: 'hstar:openshop:download-local-result',
      OPEN_API_SETTINGS: 'hstar:openshop:open-api-settings',
      SESSION_VISIBILITY: 'hstar:openshop:session-visibility',
    });
    expect(protocol.createProjectScope({
      canvasType: 'classic',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      projectId: 'project-1'
    })).toBe('openshop:classic:canvas-1:node-1:project-1');
    expect(() => protocol.createProjectScope({
      canvasType: 'classic',
      canvasId: 'canvas-1',
      nodeId: 'node-1',
      projectId: ''
    })).toThrow('OpenShop context is incomplete');
  });

  it('rejects incomplete or foreign envelopes', () => {
    const protocol = window.HstarOpenShopProtocol;
    const envelope = protocol.createEnvelope({
      type: protocol.TYPES.LOAD_PROJECT,
      sessionId: 'session-1',
      requestId: 'request-1',
      context: {
        canvasType: 'classic',
        canvasId: 'canvas-1',
        nodeId: 'node-1',
        projectId: 'project-1'
      },
      payload: { project: {} }
    });

    expect(protocol.validateEnvelope(envelope)).toEqual({ ok: true });
    expect(protocol.validateEnvelope({ ...envelope, protocolVersion: 2 }).ok).toBe(false);
    expect(protocol.validateEnvelope({
      ...envelope,
      context: { ...envelope.context, projectId: '' }
    }).ok).toBe(false);
    expect(protocol.validateEnvelope({ ...envelope, type: 'unrelated-message' }).ok).toBe(false);
  });
});
