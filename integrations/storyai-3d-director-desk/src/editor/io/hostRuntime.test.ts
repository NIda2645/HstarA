import { describe, expect, it, vi } from 'vitest';
import { DIRECTOR_MESSAGE_TYPES, createEnvelope } from './hostProtocol';
import { createDirectorHostRuntime } from './hostRuntime';

describe('createDirectorHostRuntime', () => {
  function createMessage(data: unknown, origin = window.location.origin) {
    return new MessageEvent('message', {
      data,
      origin,
      source: window,
    });
  }

  it('accepts only same-origin Director messages', () => {
    const runtime = createDirectorHostRuntime({ windowRef: window, parentRef: window.parent });
    const session = createEnvelope({
      type: DIRECTOR_MESSAGE_TYPES.SESSION,
      sessionId: 's1',
      requestId: 'r1',
      context: { mode: 'node', canvasType: 'classic', canvasId: 'c1', nodeId: 'n1', sceneKey: 'director:classic:c1:n1' },
      payload: { theme: 'dark' },
    });

    expect(runtime.acceptMessage(createMessage(session, 'https://example.invalid'))).toEqual({
      ok: false,
      reason: 'origin',
    });
    expect(runtime.acceptMessage(createMessage(session))).toEqual({ ok: true, envelope: session });
    expect(runtime.getActiveSession()?.sessionId).toBe('s1');
  });

  it('deduplicates request ids until the session changes', () => {
    const runtime = createDirectorHostRuntime({ windowRef: window, parentRef: window.parent });
    const session = createEnvelope({
      type: DIRECTOR_MESSAGE_TYPES.SESSION,
      sessionId: 's1',
      requestId: 'session-r1',
      context: { mode: 'standalone', sceneKey: 'director:standalone' },
      payload: {},
    });
    runtime.acceptMessage(createMessage(session));

    expect(runtime.markRequestApplied('capture-r1')).toBe(true);
    expect(runtime.markRequestApplied('capture-r1')).toBe(false);

    runtime.acceptMessage(
      createMessage(
        createEnvelope({
          ...session,
          sessionId: 's2',
          requestId: 'session-r2',
        }),
      ),
    );

    expect(runtime.markRequestApplied('capture-r1')).toBe(true);
  });

  it('emits render-state pause and resume notifications', () => {
    const parentRef = { postMessage: vi.fn() };
    const runtime = createDirectorHostRuntime({ windowRef: window, parentRef });
    const session = createEnvelope({
      type: DIRECTOR_MESSAGE_TYPES.SESSION,
      sessionId: 's1',
      requestId: 'session-r1',
      context: { mode: 'standalone', sceneKey: 'director:standalone' },
      payload: {},
    });
    runtime.acceptMessage(createMessage(session));

    runtime.pauseRendering();
    runtime.resumeRendering();

    expect(parentRef.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: DIRECTOR_MESSAGE_TYPES.RENDER_STATE, payload: { paused: true } }),
      window.location.origin,
    );
    expect(parentRef.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: DIRECTOR_MESSAGE_TYPES.RENDER_STATE, payload: { paused: false } }),
      window.location.origin,
    );
  });

  it('normalizes capture batches before sending them to the host', () => {
    const parentRef = { postMessage: vi.fn() };
    const runtime = createDirectorHostRuntime({ windowRef: window, parentRef });
    runtime.acceptMessage(
      createMessage(
        createEnvelope({
          type: DIRECTOR_MESSAGE_TYPES.SESSION,
          sessionId: 's1',
          requestId: 'session-r1',
          context: { mode: 'node', canvasType: 'smart', canvasId: 'c1', nodeId: 'n1', sceneKey: 'director:smart:c1:n1' },
          payload: {},
        }),
      ),
    );

    runtime.postCapturesSent([{ dataUrl: 'data:image/png;base64,abc', fileName: '' }]);

    expect(parentRef.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: DIRECTOR_MESSAGE_TYPES.CAPTURES_SENT,
        payload: { captures: [{ dataUrl: 'data:image/png;base64,abc', fileName: 'director-desk-capture-1.png' }] },
      }),
      window.location.origin,
    );
  });
});
