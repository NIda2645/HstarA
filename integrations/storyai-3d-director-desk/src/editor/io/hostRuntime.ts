import {
  DIRECTOR_MESSAGE_TYPES,
  type DirectorContext,
  type DirectorEnvelope,
  createEnvelope,
  validateEnvelope,
} from './hostProtocol';

export interface HostCaptureItemPayload {
  dataUrl?: unknown;
  fileName?: unknown;
}

export interface HostCaptureBatchPayload {
  captures: Array<{ dataUrl: string; fileName: string }>;
}

export type AcceptedHostMessage =
  | { ok: true; envelope: DirectorEnvelope }
  | { ok: false; reason: 'origin' | 'source' | 'envelope' | 'session' };

export interface DirectorHostRuntimeOptions {
  windowRef?: Window;
  parentRef?: Pick<Window, 'postMessage'>;
  expectedSource?: MessageEventSource | null;
}

export interface DirectorHostSession {
  sessionId: string;
  context: DirectorContext;
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function createRequestId(prefix: string): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}-${crypto.randomUUID()}`;
  }
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function normalizeCaptureBatch(captures: HostCaptureItemPayload[]): HostCaptureBatchPayload {
  return {
    captures: captures
      .map((capture, index) => {
        const dataUrl = normalizeString(capture.dataUrl);
        if (!dataUrl) return null;
        return {
          dataUrl,
          fileName: normalizeString(capture.fileName) || `director-desk-capture-${index + 1}.png`,
        };
      })
      .filter((capture): capture is { dataUrl: string; fileName: string } => Boolean(capture)),
  };
}

export function createDirectorHostRuntime({
  windowRef = window,
  parentRef = window.parent,
  expectedSource = null,
}: DirectorHostRuntimeOptions = {}) {
  let activeSession: DirectorHostSession | null = null;
  let renderPaused = false;
  const appliedRequestIds = new Set<string>();

  function getOrigin(): string {
    return windowRef.location.origin;
  }

  function acceptMessage(event: MessageEvent): AcceptedHostMessage {
    if (event.origin !== getOrigin()) return { ok: false, reason: 'origin' };
    if (expectedSource && event.source !== expectedSource) return { ok: false, reason: 'source' };

    const validation = validateEnvelope(event.data);
    if (!validation.ok) return { ok: false, reason: 'envelope' };

    const envelope = event.data as DirectorEnvelope;
    if (envelope.type === DIRECTOR_MESSAGE_TYPES.SESSION) {
      if (activeSession?.sessionId !== envelope.sessionId) {
        appliedRequestIds.clear();
      }
      activeSession = {
        sessionId: envelope.sessionId,
        context: envelope.context,
      };
      return { ok: true, envelope };
    }

    if (!activeSession || envelope.sessionId !== activeSession.sessionId) {
      return { ok: false, reason: 'session' };
    }

    return { ok: true, envelope };
  }

  function markRequestApplied(requestId: string): boolean {
    const normalized = normalizeString(requestId);
    if (!normalized || appliedRequestIds.has(normalized)) return false;
    appliedRequestIds.add(normalized);
    return true;
  }

  function postMessage<TPayload>(type: string, payload: TPayload): void {
    const session = activeSession ?? {
      sessionId: 'director-standalone-bootstrap',
      context: { mode: 'standalone' as const, sceneKey: 'director:standalone' },
    };
    parentRef?.postMessage(
      createEnvelope({
        type,
        sessionId: session.sessionId,
        requestId: createRequestId(type.replace(/^storyai:director-desk-/, 'director')),
        context: session.context,
        payload,
      }),
      getOrigin(),
    );
  }

  function postReady(): void {
    postMessage(DIRECTOR_MESSAGE_TYPES.READY, { ready: true });
  }

  function postClose(): void {
    postMessage(DIRECTOR_MESSAGE_TYPES.CLOSE, {});
  }

  function postCapturesSent(captures: HostCaptureItemPayload[]): void {
    const payload = normalizeCaptureBatch(captures);
    if (!payload.captures.length) return;
    postMessage(DIRECTOR_MESSAGE_TYPES.CAPTURES_SENT, payload);
  }

  function postPanoramaRemoved(payload: { edgeId: string; sourceNodeId: string }): void {
    postMessage(DIRECTOR_MESSAGE_TYPES.PANORAMA_REMOVED, payload);
  }

  function postError(message: string): void {
    postMessage(DIRECTOR_MESSAGE_TYPES.ERROR, { message });
  }

  function pauseRendering(): void {
    if (renderPaused) return;
    renderPaused = true;
    postMessage(DIRECTOR_MESSAGE_TYPES.RENDER_STATE, { paused: true });
  }

  function resumeRendering(): void {
    if (!renderPaused) return;
    renderPaused = false;
    postMessage(DIRECTOR_MESSAGE_TYPES.RENDER_STATE, { paused: false });
  }

  function isRenderingPaused(): boolean {
    return renderPaused;
  }

  function getActiveSession(): DirectorHostSession | null {
    return activeSession;
  }

  return {
    acceptMessage,
    getActiveSession,
    isRenderingPaused,
    markRequestApplied,
    pauseRendering,
    postCapturesSent,
    postClose,
    postError,
    postPanoramaRemoved,
    postReady,
    resumeRendering,
  };
}
