(function bootstrapOpenShopRuntime(root){
  root.HstarOpenShopRuntime?.stop?.();

  const state = {
    activeSession: null,
    processedRequestIds: new Set(),
    started: false,
    listener: null,
    editor: null,
    protocol: null,
    projectAdapter: null,
    parentWindow: null,
    origin: '',
    assetResolver: null,
    imageLoader: null,
  };

  function uuid(prefix){
    if(root.crypto && typeof root.crypto.randomUUID === 'function'){
      try {
        return `${prefix}-${root.crypto.randomUUID()}`;
      } catch(error) {
        // Fall through to a local request ID when randomUUID is unavailable.
      }
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function safeErrorMessage(error){
    return String(error?.message || error || 'OpenShop request failed')
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 300) || 'OpenShop request failed';
  }

  function sameContext(left, right){
    if(!left || !right) return false;
    try {
      return state.protocol.createProjectScope(left) === state.protocol.createProjectScope(right);
    } catch(error) {
      return false;
    }
  }

  function post(type, {sessionId, context, payload = {}, requestId = uuid('openshop')} = {}){
    if(!state.started || !state.parentWindow) return;
    const envelope = state.protocol.createEnvelope({
      type,
      sessionId: sessionId || state.activeSession?.sessionId,
      requestId,
      context: context || state.activeSession?.context,
      payload,
    });
    state.parentWindow.postMessage(envelope, state.origin);
  }

  function openSession(envelope){
    const context = state.protocol.normalizeContext(envelope.context);
    state.activeSession = {
      sessionId: envelope.sessionId,
      context,
    };
    state.processedRequestIds.clear();
    state.processedRequestIds.add(envelope.requestId);
    post(state.protocol.TYPES.READY, {
      requestId: uuid('openshop-ready'),
      payload: {
        projectScope: state.protocol.createProjectScope(context),
        protocolVersion: state.protocol.PROTOCOL_VERSION,
      },
    });
  }

  function activeEnvelope(envelope){
    return Boolean(
      state.activeSession
      && envelope.sessionId === state.activeSession.sessionId
      && sameContext(envelope.context, state.activeSession.context)
    );
  }

  function currentProject(){
    return state.projectAdapter.serializeProject({
      editor: state.editor,
      context: state.activeSession.context,
    });
  }

  async function applyRequest(envelope){
    const types = state.protocol.TYPES;
    if(envelope.type === types.LOAD_PROJECT){
      const project = envelope.payload?.project;
      if(!project || String(project.projectId || '') !== state.activeSession.context.projectId){
        throw new Error('OpenShop project does not match the active session');
      }
      await state.projectAdapter.restoreProject({
        editor: state.editor,
        project,
        assetResolver: state.assetResolver,
      });
    } else if(envelope.type === types.ADD_IMAGE_LAYER){
      await state.projectAdapter.queueSourceImageLayer({
        editor: state.editor,
        source: envelope.payload?.source,
        imageLoader: state.imageLoader || undefined,
      });
    } else {
      return;
    }

    post(types.PROJECT_CHANGED, {
      payload: {
        reason: envelope.type === types.LOAD_PROJECT ? 'project-loaded' : 'source-image-added',
        project: currentProject(),
        requestId: envelope.requestId,
      },
    });
  }

  async function handleMessage(event){
    if(!state.started) return;
    if(event.origin !== state.origin || event.source !== state.parentWindow) return;
    const envelope = event.data;
    if(!state.protocol.validateEnvelope(envelope).ok) return;

    if(envelope.type === state.protocol.TYPES.OPEN_SESSION){
      openSession(envelope);
      return;
    }
    if(!activeEnvelope(envelope)) return;
    if(state.processedRequestIds.has(envelope.requestId)) return;
    state.processedRequestIds.add(envelope.requestId);

    try {
      await applyRequest(envelope);
    } catch(error) {
      post(state.protocol.TYPES.ERROR, {
        payload: {
          code: 'OPENSHOP_REQUEST_FAILED',
          requestId: envelope.requestId,
          message: safeErrorMessage(error),
        },
      });
    }
  }

  function stop(){
    if(state.listener) root.removeEventListener('message', state.listener);
    state.activeSession = null;
    state.processedRequestIds.clear();
    state.started = false;
    state.listener = null;
    state.editor = null;
    state.protocol = null;
    state.projectAdapter = null;
    state.parentWindow = null;
    state.origin = '';
    state.assetResolver = null;
    state.imageLoader = null;
  }

  function start({
    editor,
    protocol,
    projectAdapter,
    parentWindow = root.parent,
    origin = root.location.origin,
    assetResolver = null,
    imageLoader = null,
  }){
    stop();
    if(!editor || !protocol || !projectAdapter || !parentWindow){
      throw new Error('OpenShop host runtime dependencies are incomplete');
    }
    state.editor = editor;
    state.protocol = protocol;
    state.projectAdapter = projectAdapter;
    state.parentWindow = parentWindow;
    state.origin = String(origin || '');
    state.assetResolver = assetResolver;
    state.imageLoader = imageLoader;
    state.listener = event => {
      void handleMessage(event);
    };
    state.started = true;
    root.addEventListener('message', state.listener);
  }

  function requestSave(){
    if(!state.activeSession) throw new Error('OpenShop session is not active');
    const project = currentProject();
    post(state.protocol.TYPES.SAVE_PROJECT, {payload:{project}});
    return project;
  }

  function requestClose(){
    if(!state.activeSession) return;
    post(state.protocol.TYPES.CLOSE, {payload:{project:currentProject()}});
  }

  function getState(){
    return {
      activeSession: state.activeSession ? {
        sessionId: state.activeSession.sessionId,
        context: {...state.activeSession.context},
      } : null,
      processedRequestCount: state.processedRequestIds.size,
      started: state.started,
    };
  }

  root.HstarOpenShopRuntime = Object.freeze({
    start,
    stop,
    requestSave,
    requestClose,
    getState,
  });
})(window);
