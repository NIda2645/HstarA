(function bootstrapOpenShopRuntime(root){
  root.HstarOpenShopRuntime?.stop?.();

  const AUTOSAVE_DELAY_MS = 1200;
  const PREVIEW_MAX_EDGE = 512;
  const state = {
    activeSession: null,
    processedRequestIds: new Set(),
    started: false,
    listener: null,
    dirtyListener: null,
    apiSettingsListener: null,
    editor: null,
    protocol: null,
    projectAdapter: null,
    parentWindow: null,
    origin: '',
    assetResolver: null,
    imageLoader: null,
    assetWriter: null,
    previewWriter: null,
    outputWriter: null,
    saving: false,
    saveAgain: false,
    dirty: false,
    applying: false,
    saveTimer: null,
    pendingSave: null,
    queuedSaveOptions: null,
    messageQueue: Promise.resolve(),
    queuedMutationCount: 0,
    runtimeGeneration: 0,
    workspaceInitialized: false,
    entryMode: 'welcome',
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
    if(!state.started || !state.parentWindow) return null;
    const envelope = state.protocol.createEnvelope({
      type,
      sessionId: sessionId || state.activeSession?.sessionId,
      requestId,
      context: context || state.activeSession?.context,
      payload,
    });
    state.parentWindow.postMessage(envelope, state.origin);
    return envelope;
  }

  function clearSaveTimer(){
    if(state.saveTimer !== null) root.clearTimeout(state.saveTimer);
    state.saveTimer = null;
  }

  function cancelPendingSave(){
    const pending = state.pendingSave;
    state.pendingSave = null;
    state.saving = false;
    if(pending) pending.resolve({cancelled:true});
  }

  function resetSaveState(){
    clearSaveTimer();
    cancelPendingSave();
    state.saveAgain = false;
    state.dirty = false;
    state.queuedSaveOptions = null;
  }

  function positiveDimension(value, fallback){
    const number = Math.round(Number(value));
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function resetEditorSession(payload = {}){
    const documentState = payload.document || {};
    const width = positiveDimension(documentState.width, 1920);
    const height = positiveDimension(documentState.height, 1080);
    state.applying = true;
    try {
      state.editor.createNewDocument?.(width, height);
      state.editor.canvasW = width;
      state.editor.canvasH = height;
      state.editor.history = [];
      state.editor.historyIdx = -1;
      state.editor.__hstarProjectCreatedAt = 0;
      state.editor.__hstarPreviewAssetId = '';
      state.editor.__hstarAutosaveVersion = 0;
      state.editor._selectionBounds = null;
      state.editor._selectionMask = null;
      state.editor._cropRegion = null;
      state.editor._marqueeStart = null;
      state.editor._cloneSource = null;
      state.editor._cloneOffset = null;
      state.editor._lassoPoints = [];
      state.editor._penPoints = [];
      state.editor.canvas?.discardActiveObject?.();
      state.editor.canvas?.renderAll?.();
      state.editor.updateHistoryPanel?.();
      state.editor.updateLayersPanel?.();
    } finally {
      state.applying = false;
    }
  }

  function openSession(envelope){
    resetSaveState();
    const context = state.protocol.normalizeContext(envelope.context);
    state.entryMode = envelope.payload?.entryMode === 'workspace' ? 'workspace' : 'welcome';
    state.workspaceInitialized = false;
    state.activeSession = {
      sessionId: envelope.sessionId,
      context,
    };
    state.processedRequestIds.clear();
    state.processedRequestIds.add(envelope.requestId);
    resetEditorSession(envelope.payload);
    root.dispatchEvent?.(new CustomEvent('openshop:session-opened', {
      detail:{session:{sessionId:state.activeSession.sessionId, context:{...context}}},
    }));
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

  function captureSession(){
    if(!state.activeSession) throw new Error('OpenShop session is not active');
    return {
      sessionId: state.activeSession.sessionId,
      context: {...state.activeSession.context},
    };
  }

  function assertActiveSession(session){
    if(
      !state.activeSession
      || state.activeSession.sessionId !== session.sessionId
      || !sameContext(state.activeSession.context, session.context)
    ){
      throw new Error('OpenShop session changed before the request completed');
    }
  }

  function currentProject(){
    return state.projectAdapter.serializeProject({
      editor: state.editor,
      context: state.activeSession.context,
    });
  }

  async function whileApplying(operation){
    const previous = state.applying;
    state.applying = true;
    try {
      return await operation();
    } finally {
      state.applying = previous;
    }
  }

  function revealEditorWorkspace(){
    if(state.workspaceInitialized) return;
    state.editor.dismissWelcome?.();
    state.workspaceInitialized = true;
  }

  function renderPng(maxEdge = 0){
    const canvas = state.editor?.canvas;
    if(!canvas?.toDataURL) throw new Error('OpenShop canvas export is unavailable');
    const width = positiveDimension(state.editor.canvasW, 1920);
    const height = positiveDimension(state.editor.canvasH, 1080);
    const largestEdge = Math.max(width, height);
    const multiplier = maxEdge > 0 ? Math.min(1, maxEdge / largestEdge) : 1;
    const viewport = Array.isArray(canvas.viewportTransform) ? canvas.viewportTransform.slice() : null;
    const boundary = canvas.getObjects?.().find(object => object?.name === '__boundary__');
    const boundaryOpacity = boundary?.opacity;
    try {
      if(viewport) canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
      boundary?.set?.('opacity', 0);
      canvas.renderAll?.();
      return canvas.toDataURL({
        format: 'png',
        quality: 1,
        left: 0,
        top: 0,
        width,
        height,
        multiplier,
      });
    } finally {
      if(boundary && boundaryOpacity !== undefined) boundary.set?.('opacity', boundaryOpacity);
      if(viewport) canvas.viewportTransform = viewport;
      canvas.renderAll?.();
    }
  }

  function reportRuntimeError(error, requestId = ''){
    post(state.protocol.TYPES.ERROR, {
      payload: {
        code: 'OPENSHOP_REQUEST_FAILED',
        requestId,
        message: safeErrorMessage(error),
      },
    });
  }

  function mergeSaveOptions(current, incoming){
    const next = incoming || {};
    return {
      reason: String(next.reason || current?.reason || 'autosave'),
      closeAfter: Boolean(current?.closeAfter || next.closeAfter),
    };
  }

  function markDirty(reason = 'editor-change'){
    if(!state.started || !state.activeSession || state.applying) return;
    state.dirty = true;
    if(state.saving){
      state.saveAgain = true;
      state.queuedSaveOptions = mergeSaveOptions(state.queuedSaveOptions, {reason:'autosave'});
      return;
    }
    clearSaveTimer();
    state.saveTimer = root.setTimeout(() => {
      state.saveTimer = null;
      void requestSave({reason:'autosave', action:reason}).catch(error => reportRuntimeError(error));
    }, AUTOSAVE_DELAY_MS);
  }

  async function requestSave({reason = 'manual', closeAfter = false} = {}){
    const session = captureSession();
    clearSaveTimer();
    if(state.saving){
      if(state.dirty || closeAfter){
        state.saveAgain = true;
        state.queuedSaveOptions = mergeSaveOptions(state.queuedSaveOptions, {reason, closeAfter});
      }
      return state.pendingSave?.promise || {queued:true};
    }

    state.saving = true;
    state.saveAgain = false;
    state.dirty = false;
    state.queuedSaveOptions = null;
    let resolvePromise;
    let rejectPromise;
    const promise = new Promise((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    });
    const pending = {
      requestId: '',
      session,
      promise,
      resolve:resolvePromise,
      reject:rejectPromise,
    };
    state.pendingSave = pending;
    try {
      await state.projectAdapter.persistEditorAssets({
        editor: state.editor,
        assetWriter: state.assetWriter,
      });
      assertActiveSession(session);
      if(typeof state.previewWriter !== 'function'){
        throw new Error('OpenShop preview writer is unavailable');
      }
      const preview = await state.previewWriter({
        dataUrl: renderPng(PREVIEW_MAX_EDGE),
        role: 'preview',
        name: `${session.context.projectId}-preview.png`,
      });
      assertActiveSession(session);
      if(!preview?.assetId) throw new Error('OpenShop preview writer returned no asset id');
      state.editor.__hstarPreviewAssetId = String(preview.assetId);
      const project = currentProject();
      const requestId = uuid('openshop-save');
      pending.requestId = requestId;
      post(state.protocol.TYPES.SAVE_PROJECT, {
        sessionId: session.sessionId,
        context: session.context,
        requestId,
        payload: {reason, closeAfter:Boolean(closeAfter), project},
      });
      return promise;
    } catch(error){
      if(state.pendingSave === pending){
        state.saving = false;
        state.pendingSave = null;
        pending.reject(error);
      }
      return promise;
    }
  }

  function confirmSave(envelope){
    const pending = state.pendingSave;
    if(!pending || envelope.requestId !== pending.requestId) return false;
    if(
      pending.session.sessionId !== envelope.sessionId
      || !sameContext(pending.session.context, envelope.context)
    ) return false;
    const confirmedProject = envelope.payload?.project || {};
    state.editor.__hstarAutosaveVersion = Number(
      confirmedProject.autosaveVersion
      ?? envelope.payload?.autosaveVersion
      ?? state.editor.__hstarAutosaveVersion
      ?? 0
    );
    if(confirmedProject.previewAssetId){
      state.editor.__hstarPreviewAssetId = String(confirmedProject.previewAssetId);
    }
    const saveAgain = state.saveAgain || state.dirty;
    const queuedOptions = state.queuedSaveOptions || {reason:'autosave', closeAfter:false};
    state.pendingSave = null;
    state.saving = false;
    state.saveAgain = false;
    state.dirty = false;
    state.queuedSaveOptions = null;
    pending.resolve(confirmedProject);
    if(saveAgain){
      Promise.resolve().then(() => {
        void requestSave(queuedOptions).catch(error => reportRuntimeError(error));
      });
    }
    return true;
  }

  function rejectSave(envelope){
    const pending = state.pendingSave;
    if(!pending || envelope.requestId !== pending.requestId) return false;
    const error = new Error(envelope.payload?.message || 'OpenShop save was rejected');
    state.pendingSave = null;
    state.saving = false;
    state.saveAgain = false;
    state.dirty = true;
    state.queuedSaveOptions = null;
    pending.reject(error);
    return true;
  }

  async function requestSendToCanvas({requestId = uuid('openshop-send')} = {}){
    const session = captureSession();
    const saveResult = await requestSave({reason:'send-to-canvas'});
    if(saveResult?.cancelled) throw new Error('OpenShop send was cancelled because the session changed');
    assertActiveSession(session);
    if(typeof state.outputWriter !== 'function'){
      throw new Error('OpenShop output writer is unavailable');
    }
    const output = await state.outputWriter({
      dataUrl: renderPng(),
      role: 'output',
      name: '\u56fe\u6587\u5206\u5c42\u8f93\u51fa.png',
    });
    assertActiveSession(session);
    if(!output?.assetId || !output?.url){
      throw new Error('OpenShop output writer returned incomplete metadata');
    }
    if(typeof state.projectAdapter.recordExport !== 'function'){
      throw new Error('OpenShop export recorder is unavailable');
    }
    state.projectAdapter.recordExport({editor:state.editor, output});
    const exportSave = await requestSave({reason:'send-to-canvas-output'});
    if(exportSave?.cancelled) throw new Error('OpenShop send was cancelled before the output was saved');
    assertActiveSession(session);
    const payload = {
      assetId: String(output.assetId),
      url: String(output.url),
      name: String(output.name || '\u56fe\u6587\u5206\u5c42\u8f93\u51fa.png'),
      width: positiveDimension(state.editor.canvasW, 1920),
      height: positiveDimension(state.editor.canvasH, 1080),
    };
    post(state.protocol.TYPES.SEND_TO_CANVAS, {
      requestId,
      sessionId: session.sessionId,
      context: session.context,
      payload,
    });
    return payload;
  }

  async function applyRequest(envelope){
    const types = state.protocol.TYPES;
    let reason = '';
    if(envelope.type === types.SAVE_CONFIRMED){
      confirmSave(envelope);
      return;
    }
    if(envelope.type === types.ERROR){
      rejectSave(envelope);
      return;
    }
    if(envelope.type === types.REQUEST_SAVE){
      await requestSave({
        reason: envelope.payload?.reason || 'manual',
        closeAfter: Boolean(envelope.payload?.closeAfter),
      });
      return;
    }
    if(envelope.type === types.REQUEST_SEND_TO_CANVAS){
      await requestSendToCanvas({requestId:envelope.requestId});
      return;
    }
    if(envelope.type === types.FIT_WORKSPACE){
      state.editor.resizeCanvas?.();
      state.editor.zoomFit?.();
      state.editor.canvas?.renderAll?.();
      return;
    }
    if(envelope.type === types.LOAD_PROJECT){
      const project = envelope.payload?.project;
      if(!project || String(project.projectId || '') !== state.activeSession.context.projectId){
        throw new Error('OpenShop project does not match the active session');
      }
      await whileApplying(() => state.projectAdapter.restoreProject({
        editor: state.editor,
        project,
        assetResolver: state.assetResolver,
      }));
      root.dispatchEvent?.(new CustomEvent('openshop:project-loaded', {detail:{project}}));
      reason = 'project-loaded';
    } else if(envelope.type === types.SYNC_SOURCES){
      const sources = envelope.payload?.sources || [];
      await whileApplying(() => state.projectAdapter.reconcileSources({
        editor: state.editor,
        sources,
        imageLoader: state.imageLoader || undefined,
      }));
      if(state.entryMode === 'workspace' || sources.length > 0) revealEditorWorkspace();
      reason = 'sources-synchronized';
      markDirty(reason);
    } else if(envelope.type === types.RESOLVE_SOURCE_UPDATE){
      await whileApplying(() => state.projectAdapter.resolveSourceUpdate({
        editor: state.editor,
        edgeId: envelope.payload?.edgeId,
        mode: envelope.payload?.mode,
        imageLoader: state.imageLoader || undefined,
      }));
      reason = 'source-update-resolved';
      markDirty(reason);
    } else if(envelope.type === types.ADD_IMAGE_LAYER){
      await whileApplying(() => state.projectAdapter.queueSourceImageLayer({
        editor: state.editor,
        source: envelope.payload?.source,
        imageLoader: state.imageLoader || undefined,
      }));
      revealEditorWorkspace();
      reason = 'source-image-added';
      markDirty(reason);
    } else {
      return;
    }

    post(types.PROJECT_CHANGED, {
      payload: {
        reason,
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
      if(activeEnvelope(envelope)) reportRuntimeError(error, envelope.requestId);
    }
  }

  function requiresOrderedEditorMutation(envelope){
    const types = state.protocol?.TYPES || {};
    return [
      types.OPEN_SESSION,
      types.LOAD_PROJECT,
      types.SYNC_SOURCES,
      types.RESOLVE_SOURCE_UPDATE,
      types.ADD_IMAGE_LAYER,
    ].includes(envelope?.type);
  }

  function enqueueEditorMutation(event){
    const generation = state.runtimeGeneration;
    state.queuedMutationCount += 1;
    const operation = state.messageQueue.then(async () => {
      if(!state.started || generation !== state.runtimeGeneration) return;
      await handleMessage(event);
    }).finally(() => {
      if(generation === state.runtimeGeneration){
        state.queuedMutationCount = Math.max(0, state.queuedMutationCount - 1);
      }
    });
    state.messageQueue = operation.catch(error => {
      if(state.started && generation === state.runtimeGeneration){
        root.console?.error?.('[HstarOpenShopRuntime] ordered message failed', error);
      }
    });
  }

  function stop(){
    const shouldNotify = state.started || Boolean(state.activeSession);
    if(state.listener) root.removeEventListener('message', state.listener);
    if(state.dirtyListener) root.removeEventListener('openshop:project-dirty', state.dirtyListener);
    if(state.apiSettingsListener) root.removeEventListener('openshop:open-api-settings', state.apiSettingsListener);
    resetSaveState();
    state.activeSession = null;
    state.processedRequestIds.clear();
    state.started = false;
    state.listener = null;
    state.dirtyListener = null;
    state.apiSettingsListener = null;
    state.editor = null;
    state.protocol = null;
    state.projectAdapter = null;
    state.parentWindow = null;
    state.origin = '';
    state.assetResolver = null;
    state.imageLoader = null;
    state.assetWriter = null;
    state.previewWriter = null;
    state.outputWriter = null;
    state.applying = false;
    state.runtimeGeneration += 1;
    state.messageQueue = Promise.resolve();
    state.queuedMutationCount = 0;
    state.workspaceInitialized = false;
    state.entryMode = 'welcome';
    if(shouldNotify) root.dispatchEvent?.(new CustomEvent('openshop:session-stopped'));
  }

  function start({
    editor,
    protocol,
    projectAdapter,
    parentWindow = root.parent,
    origin = root.location.origin,
    assetResolver = null,
    imageLoader = null,
    assetWriter = null,
    previewWriter = null,
    outputWriter = null,
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
    state.assetWriter = assetWriter;
    state.previewWriter = previewWriter;
    state.outputWriter = outputWriter;
    state.listener = event => {
      const envelope = event?.data;
      if(envelope?.type === state.protocol?.TYPES?.OPEN_SESSION && state.queuedMutationCount === 0){
        void handleMessage(event);
      } else if(requiresOrderedEditorMutation(envelope)) {
        enqueueEditorMutation(event);
      } else {
        void handleMessage(event);
      }
    };
    state.dirtyListener = event => {
      markDirty(event?.detail?.action || 'editor-change');
    };
    state.apiSettingsListener = () => {
      if(!state.activeSession) return;
      post(state.protocol.TYPES.OPEN_API_SETTINGS, {payload:{}});
    };
    state.started = true;
    root.addEventListener('message', state.listener);
    root.addEventListener('openshop:project-dirty', state.dirtyListener);
    root.addEventListener('openshop:open-api-settings', state.apiSettingsListener);
  }

  function requestClose(){
    if(!state.activeSession) return Promise.resolve(null);
    return requestSave({reason:'close', closeAfter:true});
  }

  function getState(){
    return {
      activeSession: state.activeSession ? {
        sessionId: state.activeSession.sessionId,
        context: {...state.activeSession.context},
      } : null,
      processedRequestCount: state.processedRequestIds.size,
      started: state.started,
      saving: state.saving,
      saveAgain: state.saveAgain,
      dirty: state.dirty,
      applying: state.applying,
      autosaveVersion: Number(state.editor?.__hstarAutosaveVersion || 0),
      pendingSaveRequestId: state.pendingSave?.requestId || '',
    };
  }

  root.HstarOpenShopRuntime = Object.freeze({
    start,
    stop,
    requestSave,
    requestSendToCanvas,
    requestClose,
    getState,
  });
})(window);
