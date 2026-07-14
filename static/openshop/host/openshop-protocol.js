(function bootstrapOpenShopProtocol(root){
  const PROTOCOL_VERSION = 1;
  const PREFIX = 'hstar:openshop:';
  const TYPES = Object.freeze({
    READY: `${PREFIX}ready`,
    OPEN_SESSION: `${PREFIX}open-session`,
    LOAD_PROJECT: `${PREFIX}load-project`,
    ADD_IMAGE_LAYER: `${PREFIX}add-image-layer`,
    SYNC_SOURCES: `${PREFIX}sync-sources`,
    RESOLVE_SOURCE_UPDATE: `${PREFIX}resolve-source-update`,
    REQUEST_SAVE: `${PREFIX}request-save`,
    SAVE_PROJECT: `${PREFIX}save-project`,
    SAVE_CONFIRMED: `${PREFIX}save-confirmed`,
    REQUEST_SEND_TO_CANVAS: `${PREFIX}request-send-to-canvas`,
    SEND_TO_CANVAS: `${PREFIX}send-to-canvas`,
    OPEN_API_SETTINGS: `${PREFIX}open-api-settings`,
    PROJECT_CHANGED: `${PREFIX}project-changed`,
    CLOSE: `${PREFIX}close`,
    ERROR: `${PREFIX}error`,
  });
  const KNOWN_TYPES = new Set(Object.values(TYPES));

  function clean(value){
    return String(value || '').trim();
  }

  function normalizeContext(value = {}){
    return {
      canvasType: clean(value.canvasType),
      canvasId: clean(value.canvasId),
      nodeId: clean(value.nodeId),
      projectId: clean(value.projectId),
    };
  }

  function completeContext(value){
    return Object.values(value).every(Boolean);
  }

  function createProjectScope(context){
    const value = normalizeContext(context);
    if(!completeContext(value)) throw new Error('OpenShop context is incomplete');
    const parts = [
      value.canvasType,
      value.canvasId,
      value.nodeId,
      value.projectId,
    ].map(encodeURIComponent);
    return `openshop:${parts.join(':')}`;
  }

  function createEnvelope({type, sessionId, requestId, context, payload = {}}){
    return {
      type,
      protocolVersion: PROTOCOL_VERSION,
      sessionId: clean(sessionId),
      requestId: clean(requestId),
      context: normalizeContext(context),
      payload,
    };
  }

  function validateEnvelope(value){
    if(!value || typeof value !== 'object') return {ok:false, reason:'not-object'};
    if(value.protocolVersion !== PROTOCOL_VERSION) return {ok:false, reason:'version'};
    if(!KNOWN_TYPES.has(value.type)) return {ok:false, reason:'type'};
    if(!clean(value.sessionId)) return {ok:false, reason:'session'};
    if(!clean(value.requestId)) return {ok:false, reason:'request'};
    if(!completeContext(normalizeContext(value.context))) return {ok:false, reason:'context'};
    return {ok:true};
  }

  root.HstarOpenShopProtocol = Object.freeze({
    PROTOCOL_VERSION,
    PREFIX,
    TYPES,
    normalizeContext,
    createProjectScope,
    createEnvelope,
    validateEnvelope,
  });
})(window);
