export const PROTOCOL_VERSION = 1;
export const SCENE_PREFIX = 'director:';

export const DIRECTOR_MESSAGE_TYPES = Object.freeze({
  READY: 'storyai:director-desk-ready',
  CLOSE: 'storyai:director-desk-close',
  SESSION: 'storyai:director-desk-session',
  PANORAMA: 'storyai:director-desk-panorama',
  PANORAMA_REMOVED: 'storyai:director-desk-panorama-removed',
  CAPTURES_SENT: 'storyai:director-desk-captures-sent',
  PICK_TARGET: 'storyai:director-desk-pick-target',
  IMPORT_RESULT: 'storyai:director-desk-import-result',
  ERROR: 'storyai:director-desk-error',
  RENDER_STATE: 'storyai:director-desk-render-state',
});

export type DirectorMode = 'standalone' | 'node';
export type DirectorCanvasType = 'classic' | 'smart';

export type DirectorContext = {
  mode: DirectorMode;
  canvasType?: DirectorCanvasType;
  canvasId?: string;
  nodeId?: string;
  instanceId?: string;
  sceneKey?: string;
};

export type DirectorEnvelope<TPayload = unknown> = {
  type: string;
  protocolVersion: number;
  sessionId: string;
  requestId: string;
  context: DirectorContext;
  payload: TPayload;
};

export type EnvelopeValidation =
  | { ok: true }
  | { ok: false; reason: 'not-object' | 'version' | 'type' | 'session' | 'request' | 'context' };

function cleanKeyPart(value: string): string {
  return String(value || '').trim();
}

export function createSceneKey(canvasType: DirectorCanvasType, canvasId: string, nodeId: string): string {
  return `${SCENE_PREFIX}${cleanKeyPart(canvasType)}:${cleanKeyPart(canvasId)}:${cleanKeyPart(nodeId)}`;
}

export function createStandaloneSceneKey(): string {
  return `${SCENE_PREFIX}standalone`;
}

export function createEnvelope<TPayload = unknown>({
  type,
  sessionId,
  requestId,
  context,
  payload,
}: {
  type: string;
  sessionId: string;
  requestId: string;
  context: DirectorContext;
  payload: TPayload;
}): DirectorEnvelope<TPayload> {
  return {
    type,
    protocolVersion: PROTOCOL_VERSION,
    sessionId,
    requestId,
    context,
    payload,
  };
}

export function validateEnvelope(value: unknown): EnvelopeValidation {
  if (!value || typeof value !== 'object') return { ok: false, reason: 'not-object' };
  const envelope = value as Partial<DirectorEnvelope>;
  if (envelope.protocolVersion !== PROTOCOL_VERSION) return { ok: false, reason: 'version' };
  if (typeof envelope.type !== 'string' || !envelope.type.startsWith('storyai:director-desk-')) {
    return { ok: false, reason: 'type' };
  }
  if (typeof envelope.sessionId !== 'string' || !envelope.sessionId) return { ok: false, reason: 'session' };
  if (typeof envelope.requestId !== 'string' || !envelope.requestId) return { ok: false, reason: 'request' };
  if (!envelope.context || typeof envelope.context !== 'object') return { ok: false, reason: 'context' };
  return { ok: true };
}
