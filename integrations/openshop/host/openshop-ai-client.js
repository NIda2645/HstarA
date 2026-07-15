(function bootstrapOpenShopAiClient(root){
  function clean(value){
    return String(value || '').trim();
  }

  function abortError(message = 'OpenShop AI session changed'){
    if(typeof root.DOMException === 'function') return new root.DOMException(message, 'AbortError');
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  function safeContext(value = {}){
    const context = {
      canvasType:clean(value.canvasType),
      canvasId:clean(value.canvasId),
      nodeId:clean(value.nodeId),
      projectId:clean(value.projectId),
    };
    if(Object.values(context).some(part => !part)) throw new Error('OpenShop AI project context is incomplete');
    return context;
  }

  function sameContext(left, right){
    if(!left || !right) return false;
    return ['canvasType', 'canvasId', 'nodeId', 'projectId'].every(key => clean(left[key]) === clean(right[key]));
  }

  async function responseJson(response, fallback = 'OpenShop AI request failed'){
    let value = {};
    let text = '';
    try {
      text = await response.text();
      value = text ? JSON.parse(text) : {};
    } catch(error) {
      if(response.ok) throw new Error(`${fallback}: invalid JSON response`);
    }
    if(!response.ok){
      const detail = typeof value?.detail === 'string' ? value.detail : value?.error;
      throw new Error(clean(detail || text || `${fallback} (${response.status})`).slice(0, 500));
    }
    return value || {};
  }

  function projectTaskUrl(context, taskId = ''){
    const normalized = safeContext(context);
    const base = `/api/openshop/projects/${encodeURIComponent(normalized.projectId)}/ai-tasks`;
    if(!taskId) return base;
    const params = new URLSearchParams({
      canvas_type:normalized.canvasType,
      canvas_id:normalized.canvasId,
      node_id:normalized.nodeId,
    });
    return `${base}/${encodeURIComponent(taskId)}?${params}`;
  }

  function createClient(options = {}){
    const fetchImpl = options.fetchImpl || root.fetch?.bind(root);
    const BroadcastChannelImpl = options.BroadcastChannelImpl || root.BroadcastChannel;
    const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs || 700));
    if(typeof fetchImpl !== 'function') throw new Error('OpenShop AI fetch API is unavailable');
    const listeners = new Set();
    const state = {
      catalog:null,
      catalogPromise:null,
      session:null,
      generation:0,
      sessionController:null,
      destroyed:false,
      channel:null,
    };

    function notify(){
      listeners.forEach(listener => {
        try { listener(state.catalog); } catch(error) {}
      });
    }

    async function loadCatalog(){
      if(state.destroyed) throw abortError('OpenShop AI client is closed');
      if(state.catalogPromise) return state.catalogPromise;
      state.catalogPromise = fetchImpl('/api/openshop/ai/catalog', {cache:'no-store'})
        .then(response => responseJson(response, '无法读取 HstarA API 配置'))
        .then(catalog => {
          if(!catalog?.tools || typeof catalog.tools !== 'object') throw new Error('HstarA API 能力目录无效');
          state.catalog = catalog;
          notify();
          return catalog;
        })
        .finally(() => { state.catalogPromise = null; });
      return state.catalogPromise;
    }

    function subscribe(listener){
      if(typeof listener !== 'function') return () => {};
      listeners.add(listener);
      if(state.catalog) listener(state.catalog);
      return () => listeners.delete(listener);
    }

    function toolCatalog(toolId){
      return state.catalog?.tools?.[toolId] || null;
    }

    function unavailable(toolId, preference = {}, providerName = ''){
      return {
        available:false,
        mode:preference.mode === 'project' ? 'project' : 'global',
        apiConfigId:clean(preference.apiConfigId),
        modelId:clean(preference.modelId),
        providerName:clean(providerName || preference.apiConfigId),
        modelName:clean(preference.modelId),
        reason:'配置不可用',
      };
    }

    function resolvePreference(toolId, preference = {}){
      const tool = toolCatalog(toolId);
      const mode = preference?.mode === 'project' ? 'project' : 'global';
      if(!tool) return unavailable(toolId, {...preference, mode});
      const providers = Array.isArray(tool.providers) ? tool.providers : [];
      if(mode === 'project'){
        const apiConfigId = clean(preference.apiConfigId);
        const modelId = clean(preference.modelId);
        const provider = providers.find(item => clean(item?.id) === apiConfigId);
        const model = provider?.models?.find(item => clean(item?.id) === modelId);
        if(!provider || provider.available === false || !model || model.available === false){
          return unavailable(toolId, {mode, apiConfigId, modelId}, provider?.name);
        }
        return {
          available:true,
          mode,
          apiConfigId,
          modelId,
          providerName:clean(provider.name || provider.id),
          modelName:clean(model.name || model.id),
          reason:'',
        };
      }
      const primaryId = clean(state.catalog?.primaryProviderId);
      const provider = providers.find(item => clean(item?.id) === primaryId && item.available !== false);
      const model = provider?.models?.find(item => item?.available !== false);
      if(!provider || !model) return unavailable(toolId, {mode, apiConfigId:primaryId, modelId:''});
      return {
        available:true,
        mode,
        apiConfigId:clean(provider.id),
        modelId:clean(model.id),
        providerName:clean(provider.name || provider.id),
        modelName:clean(model.name || model.id),
        reason:'',
      };
    }

    async function discoverModels(providerId){
      const id = clean(providerId);
      if(!id) throw new Error('请先选择 API 配置');
      const response = await fetchImpl(`/api/providers/${encodeURIComponent(id)}/fetch-models`, {cache:'no-store'});
      return responseJson(response, '实时拉取模型失败');
    }

    function startSession(context){
      state.sessionController?.abort();
      state.generation += 1;
      state.session = safeContext(context);
      state.sessionController = new AbortController();
      return {...state.session};
    }

    function assertSession(context, generation = state.generation){
      if(
        state.destroyed
        || generation !== state.generation
        || !sameContext(context, state.session)
        || state.sessionController?.signal?.aborted
      ) throw abortError();
    }

    async function createTask(context, input = {}){
      const normalized = safeContext(context);
      const generation = state.generation;
      assertSession(normalized, generation);
      const response = await fetchImpl(projectTaskUrl(normalized), {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        signal:state.sessionController.signal,
        body:JSON.stringify({
          owner:{
            canvasType:normalized.canvasType,
            canvasId:normalized.canvasId,
            nodeId:normalized.nodeId,
          },
          tool_id:clean(input.toolId),
          source_asset_id:clean(input.sourceAssetId),
          mask_asset_id:clean(input.maskAssetId),
          provider_id:clean(input.apiConfigId),
          model_id:clean(input.modelId),
          mode:input.mode === 'selection' ? 'selection' : 'layer',
          options:input.options && typeof input.options === 'object' ? input.options : {},
        }),
      });
      const value = await responseJson(response, '创建 OpenShop AI 任务失败');
      assertSession(normalized, generation);
      return value;
    }

    function wait(ms, signal){
      return new Promise((resolve, reject) => {
        if(signal?.aborted){ reject(abortError()); return; }
        const timer = root.setTimeout(resolve, ms);
        signal?.addEventListener?.('abort', () => {
          root.clearTimeout(timer);
          reject(abortError());
        }, {once:true});
      });
    }

    async function pollTask(context, taskId, pollOptions = {}){
      const normalized = safeContext(context);
      const generation = state.generation;
      const externalSignal = pollOptions.signal;
      assertSession(normalized, generation);
      while(true){
        if(externalSignal?.aborted) throw abortError();
        const response = await fetchImpl(projectTaskUrl(normalized, taskId), {
          method:'GET', cache:'no-store', signal:state.sessionController.signal,
        });
        const value = await responseJson(response, '查询 OpenShop AI 任务失败');
        assertSession(normalized, generation);
        const task = value.task || value;
        if(['succeeded', 'partial', 'failed', 'cancelled'].includes(task?.status)) return task;
        await wait(Number(pollOptions.intervalMs || pollIntervalMs), state.sessionController.signal);
      }
    }

    async function cancelTask(context, taskId){
      const normalized = safeContext(context);
      const generation = state.generation;
      assertSession(normalized, generation);
      const response = await fetchImpl(projectTaskUrl(normalized, taskId), {
        method:'DELETE', signal:state.sessionController.signal,
      });
      const value = await responseJson(response, '取消 OpenShop AI 任务失败');
      assertSession(normalized, generation);
      return value.task || value;
    }

    function stopSession(){
      state.sessionController?.abort();
      state.sessionController = null;
      state.session = null;
      state.generation += 1;
    }

    function handleApiChange(message){
      if(message?.type !== 'providers-changed') return;
      void loadCatalog().catch(() => {});
    }

    const messageListener = event => handleApiChange(event?.data);
    root.addEventListener?.('message', messageListener);
    if(typeof BroadcastChannelImpl === 'function'){
      try {
        state.channel = new BroadcastChannelImpl('studio-api');
        state.channel.onmessage = event => handleApiChange(event?.data);
      } catch(error) {}
    }

    function destroy(){
      if(state.destroyed) return;
      stopSession();
      state.destroyed = true;
      listeners.clear();
      state.channel?.close?.();
      root.removeEventListener?.('message', messageListener);
    }

    return Object.freeze({
      loadCatalog,
      subscribe,
      resolvePreference,
      discoverModels,
      startSession,
      createTask,
      pollTask,
      cancelTask,
      stopSession,
      destroy,
      getCatalog:() => state.catalog,
    });
  }

  root.HstarOpenShopAiClient = Object.freeze({createClient});
})(window);
