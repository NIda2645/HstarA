import { useDirectorStore } from "../store/directorStore";
import { DIRECTOR_MESSAGE_TYPES, type DirectorContext, type DirectorEnvelope } from "./hostProtocol";
import {
  createDirectorHostRuntime,
  type HostCaptureItemPayload,
} from "./hostRuntime";

interface HostPanoramaPayload {
  edgeId?: unknown;
  sourceNodeId?: unknown;
  imageUrl?: unknown;
  fileName?: unknown;
}

interface HostSessionPayload {
  instanceId?: unknown;
  theme?: unknown;
}

interface HostConnectedPanorama {
  edgeId: string;
  sourceNodeId: string;
}

let initialized = false;
const hostRuntime = createDirectorHostRuntime();
let hostConnectedPanorama: HostConnectedPanorama | null = null;
let removeUnsubscribe: (() => void) | null = null;
let suppressNextPanoramaRemovalNotice = false;
let renderPaused = false;
const renderStateListeners = new Set<(paused: boolean) => void>();

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function getHostOrigin() {
  return window.location.origin;
}

function normalizeTheme(value: unknown): "dark" | "light" | null {
  return value === "light" || value === "dark" ? value : null;
}

function applyDirectorDeskTheme(theme: "dark" | "light") {
  document.documentElement.dataset.theme = theme;
  document.documentElement.classList.toggle("dark", theme === "dark");
}

function getInitialHostTheme() {
  try {
    return normalizeTheme(new URLSearchParams(window.location.search).get("theme"));
  } catch {
    return null;
  }
}

function notifyPanoramaRemoved() {
  if (!hostConnectedPanorama) {
    return;
  }

  hostRuntime.postPanoramaRemoved(hostConnectedPanorama);
  hostConnectedPanorama = null;
}

function subscribeToPanoramaRemoval() {
  if (removeUnsubscribe) {
    return;
  }

  let previousPanoramaAssetId = useDirectorStore.getState().project.panoramaAssetId;
  removeUnsubscribe = useDirectorStore.subscribe((state) => {
    const nextPanoramaAssetId = state.project.panoramaAssetId;

    if (previousPanoramaAssetId && !nextPanoramaAssetId) {
      if (suppressNextPanoramaRemovalNotice) {
        suppressNextPanoramaRemovalNotice = false;
        hostConnectedPanorama = null;
      } else {
        notifyPanoramaRemoved();
      }
    }

    previousPanoramaAssetId = nextPanoramaAssetId;
  });
}

function importHostPanorama(payload: HostPanoramaPayload) {
  const imageUrl = normalizeString(payload.imageUrl);
  if (!imageUrl) {
    return;
  }

  const fileName = normalizeString(payload.fileName) || "画布全景图.png";
  const edgeId = normalizeString(payload.edgeId);
  const sourceNodeId = normalizeString(payload.sourceNodeId);

  hostConnectedPanorama = edgeId && sourceNodeId ? { edgeId, sourceNodeId } : null;
  useDirectorStore.getState().addImportedAsset({
    kind: "panorama",
    name: fileName,
    fileName,
    url: imageUrl,
    projectionMode: "backdrop",
  });
}

function openHostSession(payload: HostSessionPayload, context?: DirectorContext) {
  const instanceId =
    normalizeString(payload.instanceId) ||
    normalizeString(context?.sceneKey) ||
    normalizeString(context?.instanceId);
  const theme = normalizeTheme(payload.theme);
  if (theme) {
    applyDirectorDeskTheme(theme);
  }
  suppressNextPanoramaRemovalNotice = Boolean(useDirectorStore.getState().project.panoramaAssetId);
  useDirectorStore.getState().openScopedScene(instanceId || null);
  suppressNextPanoramaRemovalNotice = false;
  hostConnectedPanorama = null;
}

export function postDirectorDeskCapturesToHost(
  captures: HostCaptureItemPayload[]
) {
  hostRuntime.postCapturesSent(captures);
}

export function postDirectorDeskReady() {
  hostRuntime.postReady();
}

export function postDirectorDeskClose() {
  hostRuntime.postClose();
}

export function isDirectorDeskRenderingPaused() {
  return renderPaused;
}

export function subscribeDirectorDeskRenderState(listener: (paused: boolean) => void) {
  renderStateListeners.add(listener);
  return () => renderStateListeners.delete(listener);
}

function setRenderPaused(paused: boolean) {
  if (renderPaused === paused) return;
  renderPaused = paused;
  renderStateListeners.forEach((listener) => listener(renderPaused));
}

function normalizeLegacyEnvelope(event: MessageEvent): DirectorEnvelope | null {
  if (event.origin !== getHostOrigin()) return null;
  if (!event.data || typeof event.data !== "object") return null;
  const type = normalizeString(event.data.type);
  if (!type.startsWith("storyai:director-desk-")) return null;
  const session = hostRuntime.getActiveSession();
  return {
    type,
    protocolVersion: 1,
    sessionId: session?.sessionId ?? "legacy-session",
    requestId: `${type}-legacy-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    context: session?.context ?? { mode: "standalone", sceneKey: "director:standalone" },
    payload: event.data.payload || {},
  };
}

function handleHostMessage(event: MessageEvent) {
  const accepted = hostRuntime.acceptMessage(event);
  const envelope = accepted.ok ? accepted.envelope : normalizeLegacyEnvelope(event);
  if (!envelope) return;

  if (envelope.type === DIRECTOR_MESSAGE_TYPES.SESSION) {
    openHostSession((envelope.payload || {}) as HostSessionPayload, envelope.context);
    return;
  }

  if (envelope.type === DIRECTOR_MESSAGE_TYPES.PANORAMA) {
    importHostPanorama((envelope.payload || {}) as HostPanoramaPayload);
    return;
  }

  if (envelope.type === DIRECTOR_MESSAGE_TYPES.RENDER_STATE) {
    const payload = (envelope.payload || {}) as { paused?: unknown };
    setRenderPaused(Boolean(payload.paused));
  }
}

export function initDirectorDeskHostBridge() {
  if (initialized) {
    return;
  }

  initialized = true;
  applyDirectorDeskTheme(getInitialHostTheme() ?? "dark");
  window.addEventListener("message", handleHostMessage);
  subscribeToPanoramaRemoval();
}

export function clearDirectorDeskHostBridge() {
  if (!initialized) {
    return;
  }

  initialized = false;
  hostConnectedPanorama = null;
  setRenderPaused(false);
  suppressNextPanoramaRemovalNotice = false;
  window.removeEventListener("message", handleHostMessage);
  removeUnsubscribe?.();
  removeUnsubscribe = null;
}
