(function bootstrapOpenShopGenerativeClient(root){
  const PARENT_TERMINAL = new Set(['succeeded', 'partial', 'failed', 'cancelled']);
  const GENERATIVE_TOOLS = new Set(['generative-fill', 'local-redraw']);

  function clean(value){
    return String(value || '').trim();
  }

  function clone(value){
    if(typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function abortError(message='OpenShop 生成任务会话已停止'){
    if(typeof root.DOMException === 'function') return new root.DOMException(message, 'AbortError');
    const error = new Error(message);
    error.name = 'AbortError';
    return error;
  }

  function safeContext(value={}){
    const context = {
      canvasType:clean(value.canvasType),
      canvasId:clean(value.canvasId),
      nodeId:clean(value.nodeId),
      projectId:clean(value.projectId),
    };
    if(Object.values(context).some(part => !part)){
      throw new Error('OpenShop 生成任务项目上下文不完整');
    }
    return context;
  }

  function sameContext(left, right){
    if(!left || !right) return false;
    return ['canvasType', 'canvasId', 'nodeId', 'projectId']
      .every(key => clean(left[key]) === clean(right[key]));
  }

  function owner(context){
    return {
      canvasType:context.canvasType,
      canvasId:context.canvasId,
      nodeId:context.nodeId,
    };
  }

  function projectTaskUrl(context, taskId='', action=''){
    const normalized = safeContext(context);
    let url = `/api/openshop/projects/${encodeURIComponent(normalized.projectId)}/ai-tasks`;
    if(!taskId) return url;
    url += `/${encodeURIComponent(taskId)}`;
    if(action) url += `/${encodeURIComponent(action)}`;
    const params = new URLSearchParams({
      canvas_type:normalized.canvasType,
      canvas_id:normalized.canvasId,
      node_id:normalized.nodeId,
    });
    return `${url}?${params}`;
  }

  function requestBody(context, input={}){
    return {
      owner:owner(context),
      tool_id:clean(input.toolId),
      source_asset_id:clean(input.sourceAssetId),
      mask_asset_id:clean(input.maskAssetId),
      primary_reference_asset_id:clean(input.primaryReferenceAssetId),
      reference_assets:Array.isArray(input.references) ? clone(input.references) : [],
      provider_id:clean(input.apiConfigId),
      model_id:clean(input.modelId),
      prompt:String(input.prompt || ''),
      size:clean(input.size) || 'auto',
      quality:clean(input.quality) || 'auto',
      target_count:Math.max(1, Number(input.targetCount || 1)),
      reference_mode:input.referenceMode === 'selection' ? 'selection' : 'full',
      source_layer_id:clean(input.sourceLayerId),
      source_layer_index:Math.max(0, Number(input.sourceLayerIndex || 0)),
      document:input.document && typeof input.document === 'object' ? clone(input.document) : {},
      selection:input.selection && typeof input.selection === 'object' ? clone(input.selection) : {},
      options:{},
    };
  }

  async function responseJson(response, fallback='OpenShop 生成任务请求失败'){
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
      const error = new Error(clean(detail || text || `${fallback} (${response.status})`).slice(0, 500));
      error.status = response.status;
      throw error;
    }
    return value || {};
  }

  function createClient(options={}){
    const fetchImpl = options.fetchImpl || root.fetch?.bind(root);
    const pollIntervalMs = Math.max(1, Number(options.pollIntervalMs || 700));
    if(typeof fetchImpl !== 'function') throw new Error('OpenShop 生成任务 fetch API 不可用');

    const state = {
      session:null,
      sessionController:null,
      generation:0,
      destroyed:false,
      activePolls:new Set(),
      cancelledTasks:new Map(),
    };

    function assertSession(context, generation=state.generation){
      if(
        state.destroyed
        || generation !== state.generation
        || !sameContext(context, state.session)
        || state.sessionController?.signal?.aborted
      ) throw abortError();
    }

    function startSession(context){
      const normalized = safeContext(context);
      if(sameContext(normalized, state.session) && !state.sessionController?.signal?.aborted){
        return {...state.session};
      }
      state.sessionController?.abort();
      state.generation += 1;
      state.session = normalized;
      state.sessionController = new AbortController();
      state.cancelledTasks.clear();
      return {...state.session};
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

    async function createTask(context, input={}){
      const normalized = safeContext(context);
      const generation = state.generation;
      assertSession(normalized, generation);
      const response = await fetchImpl(projectTaskUrl(normalized), {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        signal:state.sessionController.signal,
        body:JSON.stringify(requestBody(normalized, input)),
      });
      const value = await responseJson(response, '创建 OpenShop 生成任务失败');
      assertSession(normalized, generation);
      return value;
    }

    async function pollTask(context, taskId, pollOptions={}){
      const normalized = safeContext(context);
      const generation = state.generation;
      const normalizedTaskId = clean(taskId);
      const externalSignal = pollOptions.signal;
      const pollToken = Symbol(normalizedTaskId);
      assertSession(normalized, generation);
      state.activePolls.add(pollToken);
      try {
        while(true){
          if(externalSignal?.aborted) throw abortError();
          const cancelled = state.cancelledTasks.get(normalizedTaskId);
          if(cancelled) return clone(cancelled);
          let value;
          try {
            const response = await fetchImpl(projectTaskUrl(normalized, normalizedTaskId), {
              method:'GET', cache:'no-store', signal:state.sessionController.signal,
            });
            value = await responseJson(response, '查询 OpenShop 生成任务失败');
          } catch(error) {
            const cancelledAfterError = state.cancelledTasks.get(normalizedTaskId);
            if(cancelledAfterError) return clone(cancelledAfterError);
            throw error;
          }
          assertSession(normalized, generation);
          const cancelledAfterResponse = state.cancelledTasks.get(normalizedTaskId);
          if(cancelledAfterResponse) return clone(cancelledAfterResponse);
          const task = value.task || value;
          pollOptions.onUpdate?.(task);
          if(PARENT_TERMINAL.has(task?.status)){
            if(task.status !== 'cancelled') pollOptions.onResult?.(task);
            return task;
          }
          await wait(Number(pollOptions.intervalMs || pollIntervalMs), state.sessionController.signal);
        }
      } finally {
        state.activePolls.delete(pollToken);
      }
    }

    async function cancelTask(context, taskId){
      const normalized = safeContext(context);
      const generation = state.generation;
      const normalizedTaskId = clean(taskId);
      assertSession(normalized, generation);
      state.cancelledTasks.set(normalizedTaskId, {taskId:normalizedTaskId, status:'cancelled'});
      try {
        const response = await fetchImpl(projectTaskUrl(normalized, normalizedTaskId), {
          method:'DELETE', signal:state.sessionController.signal,
        });
        const value = await responseJson(response, '取消 OpenShop 生成任务失败');
        assertSession(normalized, generation);
        const task = value.task || value;
        const cancelled = {...task, taskId:clean(task?.taskId || normalizedTaskId), status:'cancelled'};
        state.cancelledTasks.set(normalizedTaskId, cancelled);
        return clone(cancelled);
      } catch(error) {
        state.cancelledTasks.delete(normalizedTaskId);
        throw error;
      }
    }

    async function retryMissing(context, taskId){
      const normalized = safeContext(context);
      const generation = state.generation;
      assertSession(normalized, generation);
      const response = await fetchImpl(projectTaskUrl(normalized, clean(taskId), 'retry-missing'), {
        method:'POST',
        headers:{'Content-Type':'application/json'},
        signal:state.sessionController.signal,
        body:JSON.stringify({owner:owner(normalized)}),
      });
      const value = await responseJson(response, '补生成 OpenShop 结果失败');
      assertSession(normalized, generation);
      return value;
    }

    async function restoreTasks(records, restoreOptions={}){
      const context = safeContext(state.session);
      const unfinished = (Array.isArray(records) ? records : [])
        .filter(record => (
          GENERATIVE_TOOLS.has(clean(record?.toolId))
          && ['queued', 'running'].includes(clean(record?.status))
        ));
      return Promise.all(unfinished.map(async record => {
        try {
          return await pollTask(context, record.taskId, restoreOptions);
        } catch(error) {
          if(Number(error?.status) !== 404) throw error;
          const failed = {
            ...clone(record),
            status:'failed',
            error:'后台服务已重启，任务状态不可恢复',
          };
          restoreOptions.onUpdate?.(failed);
          return failed;
        }
      }));
    }

    function stopSession(){
      state.sessionController?.abort();
      state.sessionController = null;
      state.session = null;
      state.generation += 1;
      state.cancelledTasks.clear();
    }

    const sessionStoppedListener = () => stopSession();
    root.addEventListener?.('openshop:session-stopped', sessionStoppedListener);

    function destroy(){
      if(state.destroyed) return;
      stopSession();
      state.destroyed = true;
      root.removeEventListener?.('openshop:session-stopped', sessionStoppedListener);
    }

    return Object.freeze({
      startSession,
      createTask,
      pollTask,
      cancelTask,
      retryMissing,
      restoreTasks,
      stopSession,
      destroy,
      getState:() => ({
        session:state.session ? {...state.session} : null,
        activePolls:state.activePolls.size,
        cancelledTaskIds:[...state.cancelledTasks.keys()],
        destroyed:state.destroyed,
      }),
    });
  }

  root.HstarOpenShopGenerativeClient = Object.freeze({createClient});
})(window);
