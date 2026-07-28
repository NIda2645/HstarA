(function bootstrapOpenShopTextTools(root){
  const TOOL_EXTRACT = 'text-extract';
  const TOOL_REMOVE = 'text-remove';
  const TOOL_ART_FONT = 'art-font-restore';
  const MAX_TASK_RECORDS = 100;
  const OCR_LAYOUT_VERSION = 5;
  const TERMINAL_STATES = new Set(['succeeded', 'failed', 'cancelled']);
  const TERMINAL_RECONCILE_STATES = new Set(['applied', 'stale', 'discarded']);

  function clean(value){
    return String(value || '').trim();
  }

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
    })[character]);
  }

  function clone(value){
    if(typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function sameContext(left, right){
    if(!left || !right) return false;
    return ['canvasType', 'canvasId', 'nodeId', 'projectId']
      .every(key => clean(left[key]) === clean(right[key]));
  }

  function sameOwner(left, right){
    if(!left || !right) return false;
    return ['canvasType', 'canvasId', 'nodeId']
      .every(key => clean(left[key]) === clean(right[key]));
  }

  function sameValue(left, right){
    try { return JSON.stringify(left) === JSON.stringify(right); }
    catch(error){ return false; }
  }

  function createId(prefix){
    const randomId = root.crypto?.randomUUID?.();
    return randomId
      ? `${prefix}-${randomId}`
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function unicodeLength(value){
    return Array.from(String(value ?? '')).length;
  }

  function scriptForCharacter(character){
    if(/[\u3400-\u9fff]/u.test(character)) return 'zh';
    if(/[A-Za-z0-9]/u.test(character)) return 'en';
    return '';
  }

  function validatedRuns(text, runs){
    const length = unicodeLength(text);
    if(!Array.isArray(runs) || !runs.length) throw new Error('OCR 文字区段无效');
    const normalized = runs.map(run => ({
      ...clone(run),
      start:Number(run?.start),
      end:Number(run?.end),
    })).sort((left, right) => left.start - right.start || left.end - right.end);
    let cursor = 0;
    normalized.forEach(run => {
      if(
        !Number.isInteger(run.start)
        || !Number.isInteger(run.end)
        || run.start !== cursor
        || run.end <= run.start
        || run.end > length
      ) throw new Error('OCR 文字区段无效');
      cursor = run.end;
    });
    if(cursor !== length) throw new Error('OCR 文字区段无效');
    return normalized;
  }

  function reconcileOcrRuns(originalText, editedText, runs){
    const source = Array.from(String(originalText ?? ''));
    const target = Array.from(String(editedText ?? ''));
    const normalized = validatedRuns(originalText, runs);
    if(!target.length) return [];
    if(normalized.length === 1) return [{...normalized[0], start:0, end:target.length}];

    const sourceStyles = source.map((_character, index) => (
      normalized.find(run => run.start <= index && index < run.end)
    ));
    const targetStyles = new Array(target.length);
    let prefix = 0;
    while(prefix < source.length && prefix < target.length && source[prefix] === target[prefix]){
      targetStyles[prefix] = sourceStyles[prefix];
      prefix += 1;
    }
    let suffix = 0;
    while(
      suffix < source.length - prefix
      && suffix < target.length - prefix
      && source[source.length - suffix - 1] === target[target.length - suffix - 1]
    ){
      targetStyles[target.length - suffix - 1] = sourceStyles[source.length - suffix - 1];
      suffix += 1;
    }
    for(let index = prefix; index < target.length - suffix; index += 1){
      const script = scriptForCharacter(target[index]);
      const left = targetStyles[index - 1];
      const right = targetStyles[target.length - suffix];
      targetStyles[index] = [left, right, ...normalized].find(run => {
        if(!run) return false;
        if(!script) return true;
        return script === 'zh'
          ? clean(run.script).startsWith('zh')
          : clean(run.script) === 'en';
      }) || left || right || normalized[0];
    }

    const reconciled = [];
    targetStyles.forEach((run, index) => {
      const signature = JSON.stringify({...run, start:undefined, end:undefined});
      const previous = reconciled.at(-1);
      if(previous?.signature === signature) previous.end = index + 1;
      else reconciled.push({start:index, end:index + 1, run, signature});
    });
    return reconciled.map(({start, end, run}) => ({...clone(run), start, end}));
  }

  function createController(options = {}){
    const editor = options.editor;
    const runtime = options.runtime;
    const aiClient = options.aiClient;
    const assetApi = options.assetApi;
    const fontManager = options.fontManager;
    const fabricRef = options.fabricRef || root.fabric;
    const writingModeRuntime = options.writingModeRuntime || root.HstarOpenShopWritingMode;
    const ocrLayout = options.ocrLayout || root.HstarOpenShopOcrLayout;
    const documentRef = options.documentRef || root.document;
    const imageLoader = options.imageLoader || defaultImageLoader;
    const artPollMaxAttempts = Math.min(5, Math.max(1, Math.floor(Number(options.artPollMaxAttempts) || 3)));
    const artPollRetryWait = typeof options.artPollRetryWait === 'function'
      ? options.artPollRetryWait
      : (delay, signal) => new Promise((resolve, reject) => {
          if(signal?.aborted){ reject(new DOMException('Polling aborted', 'AbortError')); return; }
          const timer = root.setTimeout(resolve, delay);
          signal?.addEventListener?.('abort', () => {
            root.clearTimeout(timer);
            reject(new DOMException('Polling aborted', 'AbortError'));
          }, {once:true});
        });
    if(!editor || !runtime || !aiClient || !assetApi || !fontManager || !fabricRef
      || typeof writingModeRuntime?.createTextObject !== 'function'
      || typeof ocrLayout?.quadGeometry !== 'function'
      || typeof ocrLayout?.fitLineObject !== 'function'
      || typeof ocrLayout?.paragraphPlan !== 'function'
      || typeof fontManager?.matchOcrRun !== 'function'){
      throw new Error('OpenShop 文字工具依赖不完整');
    }

    const state = {
      started:false,
      destroyed:false,
      activeTool:TOOL_EXTRACT,
      status:'idle',
      error:'',
      reviewBlocks:[],
      reviewSourceDataUrl:'',
      reviewTaskRecord:null,
      activeTaskId:'',
      activeTaskRecord:null,
      pendingTextApply:null,
      runGeneration:0,
      artSessionGeneration:0,
      artPollGeneration:0,
      artSessionVisible:true,
      artRunsByLayerId:new Map(),
      artRunsByTaskId:new Map(),
      artCreatesByClientRequestId:new Map(),
      artReconcileRuns:new Map(),
      detachedArtTasks:new Map(),
      lastRemovalOptions:{resolution:'4k', ratio:'source', quality:'auto', prompt:''},
      unsubscribeCatalog:null,
      listeners:[],
    };

    function currentContext(){
      const context = runtime.getState?.().activeSession?.context;
      if(!context?.projectId) throw new Error('OpenShop 项目会话尚未打开');
      return {...context};
    }

    function markDirty(action){
      root.dispatchEvent?.(new CustomEvent('openshop:project-dirty', {detail:{action}}));
    }

    function activeLayer(){
      return editor.layers?.[Number(editor.activeLayerIdx || 0)] || null;
    }

    function pixelImages(layer){
      return (layer?.objects || []).filter(object => clean(object?.type).toLowerCase() === 'image');
    }

    function activePixelLayer(){
      const layers = Array.isArray(editor.layers) ? editor.layers : [];
      const selected = editor.canvas?.getActiveObject?.();
      const selectedObjects = selected?._objects?.length ? selected._objects : selected ? [selected] : [];
      const selectedLayer = layers.find(layer => selectedObjects.some(object => layer?.objects?.includes(object)));
      const selectedImages = pixelImages(selectedLayer);
      if(selectedLayer && selectedImages.length) return {layer:selectedLayer, images:selectedImages};

      const layer = activeLayer();
      const images = pixelImages(layer);
      if(layer && images.length) return {layer, images};

      for(let index = layers.length - 1; index >= 0; index -= 1){
        const fallbackLayer = layers[index];
        const fallbackImages = pixelImages(fallbackLayer);
        if(fallbackLayer?.visible !== false && fallbackImages.length){
          return {layer:fallbackLayer, images:fallbackImages};
        }
      }
      return null;
    }

    function selectedPixelLayer(){
      const layers = Array.isArray(editor.layers) ? editor.layers : [];
      const selected = editor.canvas?.getActiveObject?.();
      const selectedObjects = selected?._objects?.length ? selected._objects : selected ? [selected] : [];
      const selectedLayer = layers.find(layer => selectedObjects.some(object => layer?.objects?.includes(object)));
      if(selectedLayer){
        const selectedImages = pixelImages(selectedLayer);
        return selectedImages.length ? {layer:selectedLayer, images:selectedImages} : null;
      }
      const layer = activeLayer();
      const images = pixelImages(layer);
      return layer && images.length ? {layer, images} : null;
    }

    function preferenceFor(toolId){
      const store = editor.__hstarAiToolPreferences;
      return store && typeof store === 'object' ? store[toolId] || {mode:'global'} : {mode:'global'};
    }

    function setPreference(toolId, preference = {}){
      if(![TOOL_EXTRACT, TOOL_REMOVE, TOOL_ART_FONT].includes(toolId)) throw new Error('OpenShop AI 功能不存在');
      const mode = preference.mode === 'project' ? 'project' : 'global';
      editor.__hstarAiToolPreferences = editor.__hstarAiToolPreferences && typeof editor.__hstarAiToolPreferences === 'object'
        ? editor.__hstarAiToolPreferences
        : {};
      editor.__hstarAiToolPreferences[toolId] = {
        toolId,
        mode,
        apiConfigId:mode === 'project' ? clean(preference.apiConfigId) : '',
        modelId:mode === 'project' ? clean(preference.modelId) : '',
      };
      markDirty('OpenShop AI preference');
      const saveRequest = runtime.requestSave?.({reason:'ai-preference'});
      if(saveRequest && typeof saveRequest.catch === 'function'){
        saveRequest.catch(error => root.console?.error?.('[OpenShop] 保存 AI 选择失败', error));
      }
      renderPanel();
      return editor.__hstarAiToolPreferences[toolId];
    }

    function resolvedPreference(toolId){
      return aiClient.resolvePreference(toolId, preferenceFor(toolId));
    }

    function taskRecords(){
      editor.__hstarAiTaskRecords = Array.isArray(editor.__hstarAiTaskRecords)
        ? editor.__hstarAiTaskRecords
        : [];
      return editor.__hstarAiTaskRecords;
    }

    function oldestTerminalRecordIndex(records){
      let selected = -1;
      let selectedAt = Infinity;
      records.forEach((record, index) => {
        if(['queued', 'running'].includes(clean(record?.status))) return;
        const timestamp = Number(record?.createdAt || record?.updatedAt || 0);
        if(timestamp < selectedAt){ selected = index; selectedAt = timestamp; }
      });
      return selected;
    }

    function retainTaskRecords(){
      const records = taskRecords();
      while(records.length > MAX_TASK_RECORDS){
        const index = oldestTerminalRecordIndex(records);
        if(index < 0) throw new Error('OpenShop 活动 AI 任务已达到上限');
        records.splice(index, 1);
      }
      return records;
    }

    function reserveArtTaskRecord(){
      const records = taskRecords();
      while(records.length >= MAX_TASK_RECORDS){
        const index = oldestTerminalRecordIndex(records);
        if(index < 0) throw new Error('OpenShop 活动 AI 任务已达到上限');
        records.splice(index, 1);
      }
    }

    function ownerFromContext(context){
      return {
        canvasType:clean(context?.canvasType),
        canvasId:clean(context?.canvasId),
        nodeId:clean(context?.nodeId),
      };
    }

    function contextFingerprint(context){
      return ['canvasType', 'canvasId', 'nodeId', 'projectId'].map(key => {
        const value = clean(context?.[key]);
        return `${value.length}:${value}`;
      }).join('|');
    }

    function captureArtScope(context, sessionGeneration = state.artSessionGeneration, pollGeneration = state.artPollGeneration){
      const capturedContext = {...context};
      return {
        sessionGeneration,
        pollGeneration,
        context:capturedContext,
        owner:ownerFromContext(capturedContext),
        fingerprint:contextFingerprint(capturedContext),
      };
    }

    function artScopeIsCurrent(scope){
      if(!scope || state.destroyed || !state.started || scope.sessionGeneration !== state.artSessionGeneration) return false;
      let context;
      try { context = currentContext(); }
      catch(error){ return false; }
      return scope.fingerprint === contextFingerprint(context)
        && sameContext(scope.context, context)
        && sameOwner(scope.owner, ownerFromContext(context));
    }

    function artPollIsCurrent(scope){
      return artScopeIsCurrent(scope) && scope.pollGeneration === state.artPollGeneration;
    }

    function artRequestIdPart(value, limit){
      return clean(value).replace(/[^A-Za-z0-9_.:-]/g, '_').slice(0, limit) || 'none';
    }

    function createArtClientRequestId(scope, snapshot){
      const random = root.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      return [
        'art-font-request',
        artRequestIdPart(scope.context.projectId, 24),
        artRequestIdPart(scope.context.nodeId, 24),
        artRequestIdPart(snapshot.textLayerId, 32),
        Math.max(0, Number(snapshot.requestGeneration) || 0),
        artRequestIdPart(random, 36),
      ].join('.');
    }

    function isProvisionalArtRecord(record){
      const clientRequestId = clean(record?.clientRequestId);
      return Boolean(
        record?.toolId === TOOL_ART_FONT
        && clientRequestId
        && (
          clean(record?.creationState) === 'provisional'
          || clean(record?.taskId) === `provisional:${clientRequestId}`
        )
      );
    }

    function artRequestFromRecord(record){
      return {
        toolId:TOOL_ART_FONT,
        clientRequestId:clean(record.clientRequestId),
        sourceLayerId:clean(record.sourceLayerId),
        sourceAssetId:clean(record.sourceAssetId),
        maskAssetId:'',
        apiConfigId:clean(record.apiConfigId),
        modelId:clean(record.modelId),
        mode:'layer',
        options:{artFont:clone(record.snapshot)},
      };
    }

    function isolateArtTask(record, reason){
      if(!record) return record;
      const detached = clone(record);
      detached.detachedReason = clean(reason) || 'scope-changed';
      detached.detachedAt = Date.now();
      const key = [
        contextFingerprint(detached.context), clean(detached.taskId),
        clean(detached.snapshot?.textLayerId), Number(detached.snapshot?.requestGeneration),
        clean(detached.outputAssetId),
      ].join('|');
      state.detachedArtTasks.set(key, detached);
      return record;
    }

    async function persistState(reason, action){
      markDirty(action);
      const request = runtime.requestSave?.({reason});
      if(request && typeof request.then === 'function') await request;
    }

    function appendTaskRecord(taskId, toolId, request){
      const timestamp = Date.now();
      const record = {
        taskId,
        toolId,
        apiConfigId:clean(request.apiConfigId),
        modelId:clean(request.modelId),
        status:'running',
        mode:request.mode === 'selection' ? 'selection' : 'layer',
        sourceLayerId:clean(request.sourceLayerId),
        sourceAssetId:clean(request.sourceAssetId),
        maskAssetId:clean(request.maskAssetId),
        outputAssetId:'',
        createdAt:timestamp,
        updatedAt:timestamp,
        completedAt:0,
        appliedAt:0,
        error:'',
      };
      taskRecords().push(record);
      retainTaskRecords();
      state.activeTaskRecord = record;
      markDirty('OpenShop AI task started');
      return record;
    }

    function localizedOcrError(error){
      const message = clean(error?.message || error);
      if(/reliable text positions|reliable position/i.test(message)){
        return 'OCR 模型没有返回可靠的文字位置，请重新执行文字提取';
      }
      return message || '文字提取失败，请重试';
    }

    function updateTaskRecord(record, task){
      if(!record || !task) return;
      record.status = clean(task.status) || record.status;
      record.updatedAt = Date.now();
      const taskError = record.toolId === TOOL_EXTRACT
        ? localizedOcrError(task.error)
        : clean(task.error);
      record.error = taskError.slice(0, 500);
      const result = task.result && typeof task.result === 'object' ? clone(task.result) : null;
      if(result){
        if(record.toolId === TOOL_EXTRACT) record.result = result;
        record.outputAssetId = clean(result.assetId || task.outputAssetId);
      }
      if(TERMINAL_STATES.has(record.status)) record.completedAt = Date.now();
      markDirty('OpenShop AI task updated');
    }

    function setStatus(status, error = ''){
      state.status = status;
      state.error = clean(error).slice(0, 500);
      renderPanel();
    }

    function captureActiveLayer({strictSelection = false} = {}){
      const subject = strictSelection ? selectedPixelLayer() : activePixelLayer();
      if(!subject) throw new Error('请先选择一个包含图片的像素图层');
      const canvas = editor.canvas;
      if(!canvas?.toDataURL) throw new Error('OpenShop 图层导出不可用');
      const activeObjects = new Set(subject.layer.objects || []);
      const snapshots = (canvas.getObjects?.() || []).map(object => ({object, visible:object.visible !== false}));
      const viewport = Array.isArray(canvas.viewportTransform) ? canvas.viewportTransform.slice() : null;
      try {
        snapshots.forEach(({object}) => {
          const visible = activeObjects.has(object) && object.name !== '__boundary__';
          if(typeof object.set === 'function') object.set({visible});
          else object.visible = visible;
        });
        if(viewport) canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
        canvas.renderAll?.();
        const dataUrl = canvas.toDataURL({
          format:'png', quality:1, left:0, top:0,
          width:Number(editor.canvasW || 1920), height:Number(editor.canvasH || 1080), multiplier:1,
        });
        return {dataUrl, layer:subject.layer};
      } finally {
        snapshots.forEach(({object, visible}) => {
          if(typeof object.set === 'function') object.set({visible});
          else object.visible = visible;
        });
        if(viewport) canvas.viewportTransform = viewport;
        canvas.renderAll?.();
      }
    }

    async function uploadActiveLayer(options = {}){
      const captured = captureActiveLayer(options);
      const asset = await assetApi.upload({
        dataUrl:captured.dataUrl,
        role:'ai-source',
        name:`${currentContext().projectId}-text-source.png`,
      });
      if(!asset?.assetId) throw new Error('文字工具源图上传失败');
      return {captured, asset};
    }

    async function executeTask(toolId, request, sourceDataUrl){
      const context = currentContext();
      const runGeneration = ++state.runGeneration;
      setStatus('running');
      const created = await aiClient.createTask(context, request);
      if(runGeneration !== state.runGeneration) throw new DOMException('任务已取消', 'AbortError');
      state.activeTaskId = clean(created.task_id || created.task?.taskId);
      const record = appendTaskRecord(state.activeTaskId, toolId, request);
      const task = await aiClient.pollTask(context, state.activeTaskId);
      if(runGeneration !== state.runGeneration) throw new DOMException('任务已取消', 'AbortError');
      updateTaskRecord(record, task);
      state.activeTaskId = '';
      state.activeTaskRecord = null;
      if(task.status === 'failed') throw new Error(task.error || 'OpenShop AI 任务失败');
      if(task.status === 'cancelled') throw new DOMException('任务已取消', 'AbortError');
      if(sourceDataUrl) state.reviewSourceDataUrl = sourceDataUrl;
      return task;
    }

    async function runTextExtraction(){
      state.activeTool = TOOL_EXTRACT;
      state.reviewBlocks = [];
      renderPanel();
      try {
        const selected = resolvedPreference(TOOL_EXTRACT);
        if(!selected.available) throw new Error(selected.reason || '配置不可用');
        setStatus('preparing');
        const {captured, asset} = await uploadActiveLayer();
        const task = await executeTask(TOOL_EXTRACT, {
          toolId:TOOL_EXTRACT,
          sourceLayerId:clean(captured.layer?.layerId),
          sourceAssetId:asset.assetId,
          maskAssetId:'',
          apiConfigId:selected.apiConfigId,
          modelId:selected.modelId,
          mode:'layer',
          options:{},
        }, captured.dataUrl);
        const result = task.result;
        if(!Array.isArray(result?.blocks) || !result.blocks.length){
          throw new Error('模型没有返回可靠文字位置，无法创建文字图层');
        }
        state.reviewTaskRecord = [...taskRecords()].reverse().find(record => (
          record.toolId === TOOL_EXTRACT
          && record.status === 'succeeded'
          && !record.appliedAt
        )) || null;
        state.reviewBlocks = clone(result.blocks);
        setStatus('review');
        return result;
      } catch(error){
        if(error?.name === 'AbortError'){
          if(state.activeTaskRecord && !TERMINAL_STATES.has(state.activeTaskRecord.status)){
            updateTaskRecord(state.activeTaskRecord, {status:'cancelled'});
          }
          setStatus('cancelled');
          return null;
        }
        const message = localizedOcrError(error);
        if(state.activeTaskRecord && !TERMINAL_STATES.has(state.activeTaskRecord.status)){
          updateTaskRecord(state.activeTaskRecord, {status:'failed', error:message});
        }
        state.activeTaskId = '';
        state.activeTaskRecord = null;
        setStatus('failed', message);
        return null;
      }
    }

    function quadBounds(quad){
      const points = Array.isArray(quad) ? quad : [];
      const xs = points.map(point => Number(point?.x)).filter(Number.isFinite);
      const ys = points.map(point => Number(point?.y)).filter(Number.isFinite);
      if(xs.length !== 4 || ys.length !== 4) throw new Error('文字块坐标无效');
      return {
        left:Math.min(...xs), top:Math.min(...ys),
        width:Math.max(...xs) - Math.min(...xs),
        height:Math.max(...ys) - Math.min(...ys),
      };
    }

    function fontCandidatesForBlock(block){
      return [...new Set((Array.isArray(block?.runs) ? block.runs : [])
        .flatMap(run => Array.isArray(run?.familyCandidates) ? run.familyCandidates : [])
        .map(clean)
        .filter(Boolean))];
    }

    function finite(value, fallback = 0){
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function normalizeWritingMode(value){
      const normalized = clean(value).toLowerCase().replaceAll('_', '-');
      return ['vertical', 'vertical-rl', 'vertical-lr'].includes(normalized)
        ? 'vertical'
        : 'horizontal';
    }

    function ocrVisualProfile(block){
      const run = Array.isArray(block?.runs) && block.runs[0] && typeof block.runs[0] === 'object'
        ? block.runs[0]
        : {};
      const shadow = run.shadow && typeof run.shadow === 'object' ? run.shadow : {};
      return {
        writingMode:normalizeWritingMode(block?.writingMode),
        script:clean(run.script || block?.script) || 'mixed',
        dominantScript:clean(block?.dominantScript),
        fill:clean(run.color || run.fill) || '#ffffff',
        alignment:['left', 'center', 'right', 'justify'].includes(block?.align) ? block.align : 'left',
        rotation:finite(block?.rotation),
        artistic:run.artistic === true,
        familyCandidates:fontCandidatesForBlock(block),
        size:finite(run.size),
        weight:finite(run.weight, 400),
        style:run.style === 'italic' ? 'italic' : 'normal',
        styleDescription:clean(run.styleDescription),
        letterSpacing:finite(run.letterSpacing),
        lineHeight:finite(run.lineHeight, 1.16),
        strokeColor:clean(run.strokeColor) || '#00000000',
        strokeWidth:finite(run.strokeWidth),
        shadow:{
          color:clean(shadow.color) || '#00000000',
          blur:finite(shadow.blur),
          offsetX:finite(shadow.offsetX),
          offsetY:finite(shadow.offsetY),
        },
      };
    }

    function assertOcrV5Result(record, canvasWidth, canvasHeight){
      const result = record?.result;
      if(Number(result?.schemaVersion) !== 5){
        throw new Error('旧版识别结果，请重新执行文字提取');
      }
      if(
        !Number.isFinite(Number(result.width))
        || !Number.isFinite(Number(result.height))
        || Number(result.width) !== Number(canvasWidth)
        || Number(result.height) !== Number(canvasHeight)
      ) throw new Error('识别图像尺寸与当前画板不一致，请重新执行文字提取');
      if(!Array.isArray(result.blocks) || !result.blocks.length){
        throw new Error('没有可确认的文字提取结果');
      }
      return result;
    }

    function runStyle(run){
      return {
        fontFamily:run.faceFamily,
        fontWeight:run.weight,
        fontStyle:run.italic ? 'italic' : 'normal',
        fontSize:Math.max(1, finite(run.size, 40)),
        fill:clean(run.color) || '#ffffff',
        stroke:clean(run.strokeColor) || '#00000000',
        strokeWidth:Math.max(0, finite(run.strokeWidth)),
        shadow:new fabricRef.Shadow({
          color:clean(run.shadow?.color) || '#00000000',
          blur:Math.max(0, finite(run.shadow?.blur)),
          offsetX:finite(run.shadow?.offsetX),
          offsetY:finite(run.shadow?.offsetY),
        }),
      };
    }

    function fabricStylesForRuns(text, resolvedRuns){
      const styles = {};
      let lineIndex = 0;
      let characterIndex = 0;
      Array.from(String(text ?? '')).forEach((character, codePointIndex) => {
        if(character === '\n'){
          lineIndex += 1;
          characterIndex = 0;
          return;
        }
        const run = resolvedRuns.find(item => item.start <= codePointIndex && codePointIndex < item.end);
        if(!run) throw new Error('OCR 文字区段没有覆盖全部文字');
        styles[lineIndex] = styles[lineIndex] || {};
        styles[lineIndex][characterIndex] = runStyle(run);
        characterIndex += 1;
      });
      return styles;
    }

    function runStyleSignature(resolvedRuns){
      return JSON.stringify(resolvedRuns.map(run => ({
        script:run.script,
        family:run.family,
        faceFamily:run.faceFamily,
        weight:run.weight,
        italic:run.italic,
        size:run.size,
        color:run.color,
        letterSpacing:run.letterSpacing,
        lineHeight:run.lineHeight,
        strokeColor:run.strokeColor,
        strokeWidth:run.strokeWidth,
        shadow:run.shadow,
      })));
    }

    function textLayerName(text, index){
      return clean(text).replace(/\s+/g, ' ').slice(0, 32) || `提取文字 ${index + 1}`;
    }

    function insertLayerAboveSource(layer, sourceLayerId = ''){
      const sourceIndex = clean(sourceLayerId)
        ? editor.layers.findIndex(item => clean(item?.layerId) === clean(sourceLayerId))
        : -1;
      const baseIndex = sourceIndex >= 0 ? sourceIndex : Number(editor.activeLayerIdx || 0);
      const index = Math.max(0, Math.min(editor.layers.length, baseIndex + 1));
      editor.layers.splice(index, 0, layer);
      editor.activeLayerIdx = index;
      return layer;
    }

    function syncCanvasObjectOrder(){
      if(typeof editor.canvas?.moveTo !== 'function' || typeof editor.canvas?.getObjects !== 'function') return;
      const layerObjects = editor.layers.flatMap(layer => Array.isArray(layer?.objects) ? layer.objects : []);
      const managed = new Set(layerObjects);
      const unmanaged = editor.canvas.getObjects().filter(object => !managed.has(object));
      [...unmanaged, ...layerObjects].forEach((object, index) => editor.canvas.moveTo(object, index));
    }

    function pendingOcrRecord(){
      return [...taskRecords()].reverse().find(record => (
        record?.toolId === TOOL_EXTRACT
        && record.status === 'succeeded'
        && Array.isArray(record.result?.blocks)
        && record.result.blocks.length
      )) || null;
    }

    function activeOcrReviewRecord(){
      if(!state.reviewBlocks.length) return null;
        return state.reviewTaskRecord
        || [...taskRecords()].reverse().find(item => (
          item.toolId === TOOL_EXTRACT
          && item.status === 'succeeded'
          && Array.isArray(item.result?.blocks)
          && item.result.blocks.length
        ))
        || null;
    }

    function ownsTextApply(owner){
      if(!owner || state.pendingTextApply !== owner || !state.started || state.destroyed) return false;
      if(owner.generation !== state.runGeneration || state.activeTool !== TOOL_EXTRACT) return false;
      if(activeOcrReviewRecord() !== owner.record) return false;
      try {
        return sameContext(owner.context, currentContext());
      } catch(error){
        return false;
      }
    }

    function invalidatePendingTextApply(){
      state.pendingTextApply = null;
    }

    function showOcrReview(record){
      if(!record) return false;
      state.activeTool = TOOL_EXTRACT;
      state.reviewTaskRecord = record;
      state.reviewBlocks = clone(
        Array.isArray(record.reviewBlocks) && record.reviewBlocks.length
          ? record.reviewBlocks
          : record.result.blocks
      );
      state.reviewSourceDataUrl = record.sourceAssetId
        ? `/api/openshop/assets/${encodeURIComponent(record.sourceAssetId)}`
        : '';
      setStatus(record.appliedAt ? 'applied' : 'review');
      return true;
    }

    function persistReviewBlocks(){
      const record = state.reviewTaskRecord;
      if(!record?.result || !Array.isArray(state.reviewBlocks)) return false;
      record.reviewBlocks = clone(state.reviewBlocks);
      record.updatedAt = Date.now();
      markDirty('Edit OCR review text');
      return true;
    }

    function applyTextExtraction(blocks = state.reviewBlocks){
      if(!Array.isArray(blocks) || !blocks.length){
        return Promise.reject(new Error('没有可确认的文字提取结果'));
      }
      const record = activeOcrReviewRecord();
      let context;
      try {
        context = currentContext();
        assertOcrV5Result(record, editor.canvasW, editor.canvasH);
      } catch(error){
        return Promise.reject(error);
      }
      if(state.pendingTextApply && ownsTextApply(state.pendingTextApply)){
        return state.pendingTextApply.promise;
      }
      const owner = {
        generation:state.runGeneration,
        context,
        record,
        promise:null,
      };
      let resolveApply;
      let rejectApply;
      owner.promise = new Promise((resolve, reject) => {
        resolveApply = resolve;
        rejectApply = reject;
      });
      state.pendingTextApply = owner;
      record.reviewBlocks = clone(blocks);
      record.updatedAt = Date.now();
      renderPanel();

      const sourceLayerId = clean(record.sourceLayerId);
      const sourceAssetId = clean(record.sourceAssetId);
      const originalBlocks = record.result.blocks;

      const runApply = async () => {
        try {
          if(!ownsTextApply(owner)) return [];
          await fontManager.loadSystemFonts?.();
          if(!ownsTextApply(owner)) return [];

          const prepared = blocks.flatMap((block, index) => {
            const text = String(block?.text ?? '');
            if(!text.trim()) return [];
            const originalBlock = originalBlocks.find(item => (
              clean(item?.id) && clean(item.id) === clean(block?.id)
            )) || originalBlocks[index];
            if(!originalBlock) throw new Error('识别文字与原始结果不一致');
            const rawRuns = reconcileOcrRuns(
              String(originalBlock.text ?? ''),
              text,
              originalBlock.runs,
            );
            const resolvedRuns = rawRuns.map(run => ({
              ...run,
              ...fontManager.matchOcrRun(run),
            }));
            if(!resolvedRuns.length) return [];
            const geometry = ocrLayout.quadGeometry(
              originalBlock.quad,
              editor.canvasW,
              editor.canvasH,
              originalBlock.rotation,
            );
            return [{
              index,
              block:{...block, quad:clone(originalBlock.quad), runs:rawRuns},
              originalBlock,
              text,
              rawRuns,
              resolvedRuns,
              geometry,
              visualProfile:ocrVisualProfile({...block, runs:rawRuns}),
            }];
          });
          if(!prepared.length) throw new Error('校对结果没有可创建的文字');

          const fontLoads = new Map();
          prepared.forEach(item => item.resolvedRuns.forEach(run => {
            const face = clean(run.faceFamily);
            if(!face) throw new Error('OCR font match did not return a usable face');
            const key = `${face}\u0000${run.weight}\u0000${run.italic}`;
            if(fontLoads.has(key) || typeof documentRef.fonts?.load !== 'function') return;
            const escapedFace = face.replaceAll('"', '\\"');
            const sample = Array.from(item.text).slice(run.start, run.end).join('');
            fontLoads.set(key, documentRef.fonts.load(
              `${run.italic ? 'italic' : 'normal'} ${run.weight || 400} ${Math.max(1, finite(run.size, 40))}px "${escapedFace}"`,
              sample,
            ));
          }));
          await Promise.all(fontLoads.values());
          if(!ownsTextApply(owner)) return [];

          const candidates = prepared.map(item => {
            const base = item.resolvedRuns[0];
            const layerId = createId('hstar-text-layer').replaceAll('-', '_');
            const object = writingModeRuntime.createTextObject(fabricRef, item.text, {
              left:item.geometry.left,
              top:item.geometry.top,
              originX:'left',
              originY:'top',
              fontFamily:base.faceFamily,
              fontSize:Math.max(1, finite(base.size, 40)),
              fill:clean(base.color) || '#ffffff',
              fontWeight:base.weight,
              fontStyle:base.italic ? 'italic' : 'normal',
              charSpacing:0,
              lineHeight:Math.max(0.1, finite(base.lineHeight, 1.16)),
              textAlign:item.visualProfile.alignment,
              hstarWritingMode:item.visualProfile.writingMode,
              angle:item.geometry.angle,
              stroke:clean(base.strokeColor) || '#00000000',
              strokeWidth:Math.max(0, finite(base.strokeWidth)),
              shadow:new fabricRef.Shadow({
                color:clean(base.shadow?.color) || '#00000000',
                blur:Math.max(0, finite(base.shadow?.blur)),
                offsetX:finite(base.shadow?.offsetX),
                offsetY:finite(base.shadow?.offsetY),
              }),
              styles:fabricStylesForRuns(item.text, item.resolvedRuns),
              editable:true,
              selectable:true,
              name:textLayerName(item.text, item.index),
              hstarLayerId:layerId,
              hstarOcrSchemaVersion:5,
              hstarOcrSourceAssetId:sourceAssetId,
              hstarOcrBlockId:clean(item.originalBlock.id) || `ocr-${item.index + 1}`,
              hstarOcrSourceLayerId:sourceLayerId,
              hstarOcrQuad:clone(item.originalBlock.quad),
              hstarOcrRuns:clone(item.rawRuns),
              hstarOcrVisualProfile:item.visualProfile,
              hstarOcrOriginalText:String(item.originalBlock.text ?? ''),
              hstarArtFontRequestGeneration:0,
              hstarOcrConfidence:Number(item.originalBlock.confidence || 0),
              hstarOcrLanguage:clean(item.originalBlock.language) || 'unknown',
              hstarOcrFontCandidates:fontCandidatesForBlock(item.block),
              hstarOcrLayoutVersion:OCR_LAYOUT_VERSION,
            });
            ocrLayout.fitLineObject(object, item.geometry, {
              writingMode:item.visualProfile.writingMode,
              documentRef,
            });
            return {
              ...item,
              object,
              layerId,
              styleSignature:runStyleSignature(item.resolvedRuns),
            };
          });

          const createdLayers = [];
          const consumed = new Set();
          candidates.forEach(candidate => {
            if(consumed.has(candidate)) return;
            const paragraphId = clean(candidate.originalBlock.paragraphId);
            const group = paragraphId
              ? candidates.filter(item => clean(item.originalBlock.paragraphId) === paragraphId)
              : [candidate];
            group.forEach(item => consumed.add(item));
            const plan = group.length > 1 ? ocrLayout.paragraphPlan(group.map(item => ({
              paragraphId,
              lineIndex:item.originalBlock.lineIndex,
              writingMode:item.visualProfile.writingMode,
              rotation:item.geometry.angle,
              geometry:item.geometry,
              styleSignature:item.styleSignature,
              resolvedRuns:item.resolvedRuns,
            }))) : {merge:false, reason:'single-line'};
            const first = group[0];
            const fittedCompatible = group.every(item => (
              Math.abs(finite(item.object.fontSize) - finite(first.object.fontSize)) <= 1
              && Math.abs(finite(item.object.charSpacing) - finite(first.object.charSpacing)) <= 1
              && Math.abs(finite(item.object.scaleX, 1) - finite(first.object.scaleX, 1)) <= 0.001
              && Math.abs(finite(item.object.scaleY, 1) - finite(first.object.scaleY, 1)) <= 0.001
            ));
            if(plan.merge && fittedCompatible){
              let offset = 0;
              const mergedRawRuns = [];
              const mergedResolvedRuns = [];
              group.forEach((item, lineIndex) => {
                item.rawRuns.forEach(run => mergedRawRuns.push({...run, start:run.start + offset, end:run.end + offset}));
                item.resolvedRuns.forEach(run => mergedResolvedRuns.push({...run, start:run.start + offset, end:run.end + offset}));
                offset += unicodeLength(item.text) + (lineIndex < group.length - 1 ? 1 : 0);
              });
              const mergedText = group.map(item => item.text).join('\n');
              first.object.set({
                text:mergedText,
                styles:fabricStylesForRuns(mergedText, mergedResolvedRuns),
                lineHeight:Math.max(0.1, Math.min(10, Math.abs(finite(plan.interval)) / Math.max(1, finite(first.object.fontSize)))),
                left:first.object.left,
                top:first.object.top,
                scaleX:finite(first.object.scaleX, 1),
                scaleY:finite(first.object.scaleY, 1),
                name:textLayerName(mergedText, first.index),
                hstarOcrRuns:clone(mergedRawRuns),
                hstarOcrOriginalText:group.map(item => String(item.originalBlock.text ?? '')).join('\n'),
              });
              first.object.initDimensions?.();
              first.object.setCoords?.();
              createdLayers.push({
                layerId:first.layerId,
                name:textLayerName(mergedText, first.index),
                visible:true,
                opacity:100,
                blend:'source-over',
                objects:[first.object],
              });
            }else{
              group.forEach(item => createdLayers.push({
                layerId:item.layerId,
                name:textLayerName(item.text, item.index),
                visible:true,
                opacity:100,
                blend:'source-over',
                objects:[item.object],
              }));
            }
          });

          if(!ownsTextApply(owner)) return [];
          createdLayers.forEach(layer => editor.canvas.add?.(layer.objects[0]));
          const sourceIndex = sourceLayerId
            ? editor.layers.findIndex(item => clean(item?.layerId) === sourceLayerId)
            : Number(editor.activeLayerIdx || 0);
          const insertIndex = Math.max(0, Math.min(editor.layers.length, sourceIndex + 1));
          editor.layers.splice(insertIndex, 0, ...createdLayers);
          editor.activeLayerIdx = insertIndex + createdLayers.length - 1;
          syncCanvasObjectOrder();
          editor.canvas.renderAll?.();
          editor.updateLayersPanel?.();
          editor.saveHistory?.('文字提取');
          fontManager.scanEditor(editor);
          record.appliedAt = Date.now();
          record.updatedAt = record.appliedAt;
          setStatus('applied');
          markDirty('Apply extracted text');
          return createdLayers;
        } catch(error){
          if(!ownsTextApply(owner)) return [];
          throw error;
        }
      };
      const finishApply = () => {
        const shouldRender = ownsTextApply(owner);
        if(state.pendingTextApply === owner) state.pendingTextApply = null;
        if(shouldRender) renderPanel();
      };
      void runApply().then(value => {
        finishApply();
        resolveApply(value);
      }, error => {
        finishApply();
        rejectApply(error);
      });
      return owner.promise;
    }

    async function createRemovedImageLayer(result, taskRecord = null){
      if(!result?.assetId || !result?.url) throw new Error('去字结果资源无效');
      const image = await imageLoader(result, fabricRef);
      if(!image) throw new Error('去字结果无法载入');
      const layerId = createId('hstar-remove-layer').replaceAll('-', '_');
      const width = Number(image.width || result.width || editor.canvasW || 1);
      const height = Number(image.height || result.height || editor.canvasH || 1);
      const canvasWidth = Number(editor.canvasW || width);
      const canvasHeight = Number(editor.canvasH || height);
      const scale = Math.min(canvasWidth / width, canvasHeight / height);
      const values = {
        left:(canvasWidth - width * scale) / 2,
        top:(canvasHeight - height * scale) / 2,
        scaleX:scale,
        scaleY:scale,
        selectable:true,
        name:clean(result.name) || '去除文字',
        hstarAssetId:clean(result.assetId),
        hstarAssetRole:'ai-output',
        hstarLayerId:layerId,
      };
      if(typeof image.set === 'function') image.set(values);
      else Object.assign(image, values);
      const layer = {
        layerId, name:'去除文字', visible:true, opacity:100,
        blend:'source-over', objects:[image],
      };
      const record = taskRecord
        || [...taskRecords()].reverse().find(item => item.toolId === TOOL_REMOVE && item.status === 'succeeded' && !item.appliedAt);
      insertLayerAboveSource(layer, record?.sourceLayerId);
      editor.canvas.add?.(image);
      syncCanvasObjectOrder();
      editor.canvas.renderAll?.();
      editor.updateLayersPanel?.();
      editor.saveHistory?.('去除文字');
      if(record){ record.appliedAt = Date.now(); record.updatedAt = record.appliedAt; }
      markDirty('Apply text removal');
      return layer;
    }

    function hasOutputAsset(assetId){
      const normalized = clean(assetId);
      return Boolean(normalized && editor.layers?.some(layer => (
        (layer?.objects || []).some(object => clean(object?.hstarAssetId) === normalized)
      )));
    }

    function isTextObject(object){
      return ['i-text', 'itext', 'text', 'textbox', 'hstar-vertical-text']
        .includes(clean(object?.type).toLowerCase());
    }

    function isArtFontEligibleObject(object){
      return Boolean(
        isTextObject(object)
        && clean(object?.hstarOcrSourceAssetId)
        && clean(object?.hstarOcrSourceLayerId)
        && clean(object?.hstarOcrBlockId)
        && typeof object?.hstarOcrOriginalText === 'string'
        && clean(object.hstarOcrOriginalText)
        && Array.isArray(object?.hstarOcrQuad)
        && object.hstarOcrQuad.length === 4
        && object?.hstarOcrVisualProfile
        && typeof object.hstarOcrVisualProfile === 'object'
      );
    }

    function findArtCarrierCandidate(textLayerId, ocrBlockId = ''){
      const layerId = clean(textLayerId);
      const layerIndex = editor.layers?.findIndex(layer => clean(layer?.layerId) === layerId) ?? -1;
      if(layerIndex < 0) return null;
      const layer = editor.layers[layerIndex];
      const textObjects = (layer?.objects || []).filter(isTextObject);
      const blockId = clean(ocrBlockId);
      const object = blockId
        ? textObjects.find(candidate => clean(candidate.hstarOcrBlockId) === blockId) || textObjects[0]
        : textObjects.find(isArtFontEligibleObject) || textObjects[0];
      return object ? {layer, object, layerIndex} : null;
    }

    function findArtCarrier(textLayerId, ocrBlockId = ''){
      const carrier = findArtCarrierCandidate(textLayerId, ocrBlockId);
      return carrier && isArtFontEligibleObject(carrier.object) ? carrier : null;
    }

    function findLiveSourceLayer(sourceLayerId){
      const layerId = clean(sourceLayerId);
      return layerId
        ? editor.layers?.find(layer => clean(layer?.layerId) === layerId) || null
        : null;
    }

    function exactArtIdentity(value, record){
      return Boolean(value && record && (
        clean(value.taskId) === clean(record.taskId)
        && clean(value.textLayerId) === clean(record.snapshot?.textLayerId)
        && Number(value.requestGeneration) === Number(record.snapshot?.requestGeneration)
        && clean(value.outputAssetId) === clean(record.outputAssetId)
      ));
    }

    function existingArtOutput(record){
      return editor.layers?.find(layer => (
        exactArtIdentity(layer?.hstarAiGeneration, record)
        && (layer.objects || []).some(object => exactArtIdentity(object?.hstarAiGeneration, record))
      )) || null;
    }

    function artRecordScopeMatches(record, context){
      return sameContext(record?.context, context)
        && sameOwner(record?.owner, ownerFromContext(context));
    }

    function currentArtScopeForRecord(record){
      if(!state.artSessionVisible) return null;
      let context;
      try { context = currentContext(); }
      catch(error){ return null; }
      return artRecordScopeMatches(record, context) ? captureArtScope(context) : null;
    }

    function validateArtLiveState(record, scope, expectedObject = null){
      if(scope && !artScopeIsCurrent(scope)) return {isolated:true, reason:'scope-changed'};
      const context = scope?.context || currentContext();
      if(!artRecordScopeMatches(record, context)) return {reason:'scope-mismatch'};
      if(!findLiveSourceLayer(record?.sourceLayerId)) return {reason:'source-layer-missing'};

      const snapshot = record?.snapshot;
      const carrier = findArtCarrierCandidate(snapshot?.textLayerId, snapshot?.ocrBlockId);
      if(!carrier) return {reason:'carrier-missing'};
      const object = carrier.object;
      if(expectedObject && object !== expectedObject) return {reason:'carrier-changed'};
      if(
        !isArtFontEligibleObject(object)
        || clean(object.hstarOcrSourceAssetId) !== clean(record.sourceAssetId)
        || clean(object.hstarOcrSourceLayerId) !== clean(record.sourceLayerId)
        || clean(object.hstarOcrBlockId) !== clean(snapshot?.ocrBlockId)
        || String(object.hstarOcrOriginalText ?? '') !== String(snapshot?.originalText ?? '')
        || !sameValue(object.hstarOcrQuad, snapshot?.quad)
        || !sameValue(object.hstarOcrVisualProfile, snapshot?.visualProfile)
      ) return {reason:'provenance-changed'};
      if(Number(object.hstarArtFontRequestGeneration) !== Number(snapshot?.requestGeneration)){
        return {reason:'generation-changed'};
      }
      if(String(object.text ?? '') !== String(snapshot?.currentText ?? '')){
        return {reason:'text-changed'};
      }
      if(
        Number(editor.canvasW) !== Number(snapshot?.document?.width)
        || Number(editor.canvasH) !== Number(snapshot?.document?.height)
      ) return {reason:'document-changed'};
      return {carrier, object};
    }

    function setArtBusy(layerId, run){
      const normalized = clean(layerId);
      if(run) state.artRunsByLayerId.set(normalized, run);
      else state.artRunsByLayerId.delete(normalized);
      editor.updateLayersPanel?.();
    }

    async function updateArtReconcile(record, reconcileState, reason, scope = null){
      if(!record || TERMINAL_RECONCILE_STATES.has(clean(record.reconcileState))) return record;
      if(scope && !artScopeIsCurrent(scope)) return isolateArtTask(record, 'scope-changed');
      const timestamp = Date.now();
      record.reconcileState = reconcileState;
      record.reconcileReason = clean(reason).slice(0, 160);
      record.updatedAt = timestamp;
      if(reconcileState === 'applied') record.appliedAt = timestamp;
      if(reconcileState === 'stale') record.staleAt = timestamp;
      if(reconcileState === 'discarded') record.discardedAt = timestamp;
      await persistState('art-font-reconcile', `Art font ${reconcileState}`);
      return record;
    }

    function updateArtExecution(record, task){
      const status = clean(task?.status).toLowerCase();
      if(['queued', 'running', 'succeeded', 'failed', 'cancelled'].includes(status)){
        record.status = status;
      }
      record.updatedAt = Date.now();
      record.error = clean(task?.error).slice(0, 500);
      if(task?.result && typeof task.result === 'object') record.result = clone(task.result);
      record.outputAssetId = clean(task?.outputAssetId || task?.result?.assetId || record.outputAssetId);
      if(TERMINAL_STATES.has(record.status)) record.completedAt = Date.now();
      return record;
    }

    function invalidArtOutput(message){
      const error = new Error(message);
      error.artReconcileReason = 'invalid-output';
      return error;
    }

    function validatedArtResult(record){
      const result = record?.result;
      const width = Number(result?.width);
      const height = Number(result?.height);
      const box = result?.placementBox;
      const documentWidth = Number(record?.snapshot?.document?.width);
      const documentHeight = Number(record?.snapshot?.document?.height);
      const integerBox = box && ['x', 'y', 'width', 'height'].every(key => Number.isInteger(box[key]));
      if(
        !result || clean(result.assetId) !== clean(record.outputAssetId)
        || clean(result.mime).toLowerCase() !== 'image/png'
        || !Number.isInteger(width) || width < 1
        || !Number.isInteger(height) || height < 1
        || !Number.isInteger(documentWidth) || documentWidth < 1
        || !Number.isInteger(documentHeight) || documentHeight < 1
        || !integerBox || box.x < 0 || box.y < 0 || box.width < 1 || box.height < 1
        || box.width !== width || box.height !== height
        || box.x + box.width > documentWidth || box.y + box.height > documentHeight
      ) throw invalidArtOutput('艺术字体结果 PNG 无效');
      return {
        ...clone(result), width, height,
        url:clean(result.url) || `/api/openshop/assets/${encodeURIComponent(record.outputAssetId)}`,
      };
    }

    function artGenerationMetadata(record, placementBox){
      return {
        taskId:clean(record.taskId),
        textLayerId:clean(record.snapshot?.textLayerId),
        requestGeneration:Number(record.snapshot?.requestGeneration),
        outputAssetId:clean(record.outputAssetId),
        toolId:TOOL_ART_FONT,
        placementBox:clone(placementBox),
      };
    }

    async function reconcileArtRecordOnce(record, scope = captureArtScope(currentContext())){
      if(!record || record.toolId !== TOOL_ART_FONT || record.reconcileState !== 'pending') return record;
      if(!artScopeIsCurrent(scope)) return isolateArtTask(record, 'scope-changed');
      if(!artPollIsCurrent(scope)) return record;
      if(!artRecordScopeMatches(record, scope.context)){
        return updateArtReconcile(record, 'stale', 'scope-mismatch', scope);
      }
      if(record.status === 'failed' || record.status === 'cancelled'){
        return updateArtReconcile(record, 'discarded', record.status === 'cancelled' ? 'cancelled' : 'task-failed', scope);
      }
      if(record.status !== 'succeeded') return record;

      const initialState = validateArtLiveState(record, scope);
      if(initialState.isolated) return isolateArtTask(record, initialState.reason);
      if(initialState.reason) return updateArtReconcile(record, 'stale', initialState.reason, scope);

      const existing = existingArtOutput(record);
      if(existing){
        record.generatedLayerId = clean(existing.layerId);
        return updateArtReconcile(record, 'applied', 'existing-output', scope);
      }

      const snapshot = record.snapshot;
      let image = null;
      let generatedLayer = null;
      let historySaved = false;
      let carrier = initialState.carrier;
      const object = initialState.object;
      const priorLayerVisible = carrier.layer.visible !== false;
      const priorObjectVisibility = new Map((carrier.layer.objects || []).map(item => [item, item.visible !== false]));
      let carrierVisibilityMutated = false;
      let historyLength = 0;
      let priorHistoryIndex = 0;
      let priorLastAction;
      try {
        const result = validatedArtResult(record);
        image = await imageLoader(result, fabricRef);
        if(!artScopeIsCurrent(scope)) return isolateArtTask(record, 'scope-changed');
        if(!artPollIsCurrent(scope)) return record;
        const liveState = validateArtLiveState(record, scope, object);
        if(liveState.isolated) return isolateArtTask(record, liveState.reason);
        if(liveState.reason) return updateArtReconcile(record, 'stale', liveState.reason, scope);
        const liveResult = validatedArtResult(record);
        if(!sameValue(result, liveResult)) throw invalidArtOutput('艺术字体结果在解码期间发生变化');
        if(!image || Number(image.width) !== result.width || Number(image.height) !== result.height){
          throw invalidArtOutput('艺术字体结果尺寸与 PNG 不一致');
        }
        carrier = liveState.carrier;
        historyLength = Array.isArray(editor.history) ? editor.history.length : 0;
        priorHistoryIndex = Number(editor.historyIdx);
        priorLastAction = editor._lastAction;
        const layerId = createId('hstar-art-font-layer').replaceAll('-', '_');
        const generation = artGenerationMetadata(record, result.placementBox);
        const values = {
          left:result.placementBox.x,
          top:result.placementBox.y,
          originX:'left', originY:'top', angle:0,
          scaleX:1, scaleY:1, selectable:true, visible:true,
          name:clean(result.name) || '艺术字体处理',
          hstarAssetId:clean(result.assetId), hstarAssetRole:'ai-output', hstarLayerId:layerId,
          hstarAiGeneration:generation,
        };
        if(typeof image.set === 'function') image.set(values);
        else Object.assign(image, values);
        generatedLayer = {
          layerId, name:'艺术字体处理', visible:true, locked:false, opacity:100,
          blend:'source-over', objects:[image], hstarAiGeneration:generation,
        };

        const carrierIndex = editor.layers.indexOf(carrier.layer);
        if(carrierIndex < 0) throw new Error('艺术字体载体图层已不存在');
        editor.layers.splice(carrierIndex + 1, 0, generatedLayer);
        const canvasObjects = editor.canvas.getObjects?.() || [];
        const carrierCanvasIndexes = (carrier.layer.objects || [])
          .map(item => canvasObjects.indexOf(item)).filter(index => index >= 0);
        const canvasIndex = carrierCanvasIndexes.length ? Math.max(...carrierCanvasIndexes) + 1 : canvasObjects.length;
        if(typeof editor.canvas.insertAt === 'function') editor.canvas.insertAt(image, canvasIndex, false);
        else {
          editor.canvas.add?.(image);
          editor.canvas.moveTo?.(image, canvasIndex);
        }
        syncCanvasObjectOrder();
        const orderedObjects = editor.canvas.getObjects?.() || [];
        const generatedCanvasIndex = orderedObjects.indexOf(image);
        const liveCarrierIndexes = (carrier.layer.objects || [])
          .map(item => orderedObjects.indexOf(item)).filter(index => index >= 0);
        if(
          editor.layers[carrierIndex + 1] !== generatedLayer
          || !generatedLayer.objects.includes(image)
          || generatedCanvasIndex < 0
          || (liveCarrierIndexes.length && generatedCanvasIndex <= Math.max(...liveCarrierIndexes))
        ) throw new Error('艺术字体图层堆栈校验失败');

        carrierVisibilityMutated = true;
        carrier.layer.visible = false;
        (carrier.layer.objects || []).forEach(item => { item.visible = false; });
        editor.activeLayerIdx = carrierIndex + 1;
        editor.canvas.setActiveObject?.(image);
        editor.canvas.renderAll?.();
        editor.updateLayersPanel?.();
        editor.saveHistory?.('艺术字体处理');
        historySaved = true;
        record.generatedLayerId = layerId;
        record.reconcileState = 'applied';
        record.reconcileReason = '';
        record.appliedAt = Date.now();
        record.updatedAt = record.appliedAt;
        await persistState('art-font-applied', 'Apply artistic font');
        return record;
      } catch(error){
        if(!artScopeIsCurrent(scope)) return isolateArtTask(record, 'scope-changed');
        if(generatedLayer){
          const index = editor.layers.indexOf(generatedLayer);
          if(index >= 0) editor.layers.splice(index, 1);
        }
        if(image) editor.canvas.remove?.(image);
        if(carrierVisibilityMutated){
          carrier.layer.visible = priorLayerVisible;
          priorObjectVisibility.forEach((visible, item) => { item.visible = visible; });
        }
        if(historySaved && Array.isArray(editor.history) && editor.history.length > historyLength){
          editor.history.splice(historyLength);
          editor.historyIdx = Number.isFinite(priorHistoryIndex) ? priorHistoryIndex : editor.history.length - 1;
          editor._lastAction = priorLastAction;
          editor.updateHistoryPanel?.();
        }
        record.generatedLayerId = '';
        record.reconcileState = 'pending';
        record.reconcileReason = '';
        record.appliedAt = 0;
        editor.canvas.renderAll?.();
        editor.updateLayersPanel?.();
        return updateArtReconcile(record, 'discarded', error?.artReconcileReason || 'apply-failed', scope);
      }
    }

    function artRecordIdentity(record){
      const snapshot = record?.snapshot || {};
      return [
        contextFingerprint(record?.context),
        clean(record?.clientRequestId),
        clean(record?.taskId),
        clean(snapshot.textLayerId),
        Number(snapshot.requestGeneration) || 0,
        clean(record?.outputAssetId),
      ].join('|');
    }

    function reconcileArtRecord(record, scope = captureArtScope(currentContext())){
      if(!record) return Promise.resolve(record);
      const key = artRecordIdentity(record);
      const existing = state.artReconcileRuns.get(key);
      if(existing){
        return existing.promise.then(result => {
          if(
            record.reconcileState !== 'pending'
            || TERMINAL_RECONCILE_STATES.has(clean(record.reconcileState))
          ) return result;
          let retryScope = null;
          try { retryScope = captureArtScope(currentContext()); }
          catch(error) { return result; }
          return reconcileArtRecord(record, retryScope);
        });
      }
      const run = {promise:null};
      run.promise = Promise.resolve()
        .then(() => reconcileArtRecordOnce(record, scope))
        .finally(() => {
          if(state.artReconcileRuns.get(key) === run) state.artReconcileRuns.delete(key);
        });
      state.artReconcileRuns.set(key, run);
      return run.promise;
    }

    function artPollErrorStatus(error){
      const status = Number(error?.status || error?.statusCode || 0);
      return Number.isInteger(status) ? status : 0;
    }

    function artPollTerminalReason(status){
      if(status === 401 || status === 403) return 'poll-auth-error';
      if(status >= 400 && status < 500 && ![404, 408, 425, 429].includes(status)){
        return 'poll-validation-error';
      }
      return '';
    }

    function isIntentionalArtPollAbort(error, scope){
      return error?.name === 'AbortError' || !artScopeIsCurrent(scope) || !artPollIsCurrent(scope);
    }

    async function persistArtPollError(record, error){
      record.error = clean(error?.message || error || 'Artistic font polling failed').slice(0, 500);
      record.updatedAt = Date.now();
      record.pollFailureCount = Math.max(0, Number(record.pollFailureCount) || 0) + 1;
      await persistState('art-font-poll-error', 'Update artistic font polling error');
    }

    async function pollArtRecord(record, scope, {allowRegistryRecreate = true} = {}){
      const taskId = clean(record?.taskId);
      if(!taskId || state.artRunsByTaskId.has(taskId)) return state.artRunsByTaskId.get(taskId)?.promise || record;
      const controller = new AbortController();
      const run = {record, controller, promise:null};
      run.promise = (async () => {
        for(let attempt = 1; attempt <= artPollMaxAttempts; attempt += 1){
          try {
            const task = await aiClient.pollTask(scope.context, taskId, {signal:controller.signal});
            if(!artScopeIsCurrent(scope)) return isolateArtTask(record, 'scope-changed');
            if(!artPollIsCurrent(scope) || !artRecordScopeMatches(record, scope.context)) return record;
            updateArtExecution(record, task);
            record.pollFailureCount = 0;
            await persistState('art-font-task', 'Update artistic font task');
            if(!artPollIsCurrent(scope)) return record;
            return reconcileArtRecord(record, scope);
          } catch(error){
            if(isIntentionalArtPollAbort(error, scope)) return record;
            const status = artPollErrorStatus(error);
            const terminalReason = artPollTerminalReason(status);
            if(terminalReason){
              record.status = 'failed';
              record.error = clean(error?.message || error).slice(0, 500);
              record.updatedAt = Date.now();
              record.completedAt = record.updatedAt;
              return updateArtReconcile(record, 'discarded', terminalReason, scope);
            }

            await persistArtPollError(record, error);
            if(status === 404){
              if(allowRegistryRecreate && clean(record.clientRequestId)){
                state.artCreatesByClientRequestId.delete(clean(record.clientRequestId));
                if(state.artRunsByTaskId.get(taskId) === run) state.artRunsByTaskId.delete(taskId);
                return resumeArtCreationRecord(record, scope, {allowRegistryRecreate:false});
              }
              return record;
            }
            if(attempt >= artPollMaxAttempts) return record;
            try {
              await artPollRetryWait(Math.min(2000, 250 * (2 ** (attempt - 1))), controller.signal);
            } catch(waitError){
              return record;
            }
          }
        }
        return record;
      })().catch(error => {
        if(!isIntentionalArtPollAbort(error, scope)){
          record.error = clean(error?.message || error).slice(0, 500);
          record.updatedAt = Date.now();
        }
        return record;
      }).finally(() => {
        if(state.artRunsByTaskId.get(taskId) === run) state.artRunsByTaskId.delete(taskId);
      });
      state.artRunsByTaskId.set(taskId, run);
      return run.promise;
    }

    function resumeArtCreationRecord(record, scope, {
      allowRegistryRecreate = true,
      allowCreateAbortRetry = true,
    } = {}){
      const clientRequestId = clean(record?.clientRequestId);
      if(!clientRequestId) return Promise.resolve(record);
      const existing = state.artCreatesByClientRequestId.get(clientRequestId);
      if(existing) return existing.promise;
      const run = {record, promise:null};
      run.promise = (async () => {
        if(!artScopeIsCurrent(scope) || !artRecordScopeMatches(record, scope.context)) return record;
        let created;
        try {
          created = await aiClient.createTask(scope.context, artRequestFromRecord(record));
        } catch(error){
          const retryScope = (
            allowCreateAbortRetry
            && error?.name === 'AbortError'
            && !artScopeIsCurrent(scope)
            && taskRecords().includes(record)
            && state.artCreatesByClientRequestId.get(clientRequestId) === run
          ) ? currentArtScopeForRecord(record) : null;
          if(!retryScope) throw error;
          state.artCreatesByClientRequestId.delete(clientRequestId);
          return resumeArtCreationRecord(record, retryScope, {
            allowRegistryRecreate,
            allowCreateAbortRetry:false,
          });
        }
        if(!taskRecords().includes(record)) return record;
        const creationScope = artScopeIsCurrent(scope) ? scope : currentArtScopeForRecord(record);
        if(!creationScope) return record;
        const task = created?.task && typeof created.task === 'object' ? created.task : created;
        const taskId = clean(created?.task_id || task?.taskId);
        if(!taskId) throw new Error('艺术字体任务没有返回标识');
        record.taskId = taskId;
        record.creationState = 'created';
        delete record.provisionalSaveState;
        updateArtExecution(record, {
          ...task,
          taskId,
          status:clean(task?.status || created?.status) || 'queued',
        });
        await persistState('art-font-task', 'Start artistic font task');
        const activeScope = (!artScopeIsCurrent(scope) || !artPollIsCurrent(scope))
          ? currentArtScopeForRecord(record)
          : scope;
        if(!activeScope) return record;
        if(['queued', 'running'].includes(clean(record.status))){
          return pollArtRecord(record, activeScope, {allowRegistryRecreate});
        }
        return reconcileArtRecord(record, activeScope);
      })().finally(() => {
        if(state.artCreatesByClientRequestId.get(clientRequestId) === run){
          state.artCreatesByClientRequestId.delete(clientRequestId);
        }
      });
      state.artCreatesByClientRequestId.set(clientRequestId, run);
      return run.promise;
    }

    async function persistProvisionalArtRecord(record){
      record.provisionalSaveState = 'saved';
      record.error = '';
      record.updatedAt = Date.now();
      try {
        await persistState('art-font-provisional', 'Prepare artistic font task');
        return true;
      } catch(error){
        record.provisionalSaveState = 'failed';
        record.error = clean(error?.message || error).slice(0, 500);
        record.updatedAt = Date.now();
        return false;
      }
    }

    async function resumeRecoverableArtRecord(record, scope){
      if(isProvisionalArtRecord(record)){
        if(record.provisionalSaveState !== 'saved'){
          const saved = await persistProvisionalArtRecord(record);
          if(!saved || !artScopeIsCurrent(scope)) return record;
        }
        return resumeArtCreationRecord(record, scope);
      }
      if(['queued', 'running'].includes(clean(record.status))){
        return pollArtRecord(record, scope);
      }
      return reconcileArtRecord(record, scope);
    }

    function startArtLayerRun(layerId, operation){
      const normalized = clean(layerId);
      if(!normalized) return Promise.resolve(null);
      const existing = state.artRunsByLayerId.get(normalized);
      if(existing) return existing.promise;
      const run = {promise:null};
      run.promise = Promise.resolve().then(operation)
        .catch(error => {
          root.console?.error?.('[OpenShop] 艺术字体处理失败', error);
          return null;
        })
        .finally(() => {
          if(state.artRunsByLayerId.get(normalized) === run) setArtBusy(normalized, null);
        });
      setArtBusy(normalized, run);
      return run.promise;
    }

    function recoverableArtRecordForLayer(layerId, context){
      const normalized = clean(layerId);
      return [...taskRecords()].reverse().find(record => (
        record?.toolId === TOOL_ART_FONT
        && record?.reconcileState === 'pending'
        && ['queued', 'running'].includes(clean(record?.status))
        && clean(record?.snapshot?.textLayerId) === normalized
        && artRecordScopeMatches(record, context)
      )) || null;
    }

    async function runArtFontRestore(textLayerId, sessionGeneration, pollGeneration){
      const context = currentContext();
      const scope = captureArtScope(context, sessionGeneration, pollGeneration);
      if(!artScopeIsCurrent(scope)) return null;
      const carrier = findArtCarrier(textLayerId);
      if(!carrier || !findLiveSourceLayer(carrier.object.hstarOcrSourceLayerId)) return null;
      reserveArtTaskRecord();
      const selected = resolvedPreference(TOOL_ART_FONT);
      if(!selected.available) throw new Error(selected.reason || '艺术字体模型不可用');
      const currentText = String(carrier.object.text ?? '');
      if(!currentText.trim()) return null;
      const requestGeneration = Math.max(0, Number(carrier.object.hstarArtFontRequestGeneration) || 0) + 1;
      if(typeof carrier.object.set === 'function') carrier.object.set({hstarArtFontRequestGeneration:requestGeneration});
      else carrier.object.hstarArtFontRequestGeneration = requestGeneration;
      const snapshot = {
        textLayerId:clean(carrier.layer.layerId),
        ocrBlockId:clean(carrier.object.hstarOcrBlockId),
        originalText:String(carrier.object.hstarOcrOriginalText ?? ''),
        currentText,
        requestGeneration,
        document:{width:Number(editor.canvasW), height:Number(editor.canvasH)},
        quad:clone(carrier.object.hstarOcrQuad),
        visualProfile:clone(carrier.object.hstarOcrVisualProfile),
      };
      const clientRequestId = createArtClientRequestId(scope, snapshot);
      const request = {
        toolId:TOOL_ART_FONT,
        clientRequestId,
        sourceLayerId:clean(carrier.object.hstarOcrSourceLayerId),
        sourceAssetId:clean(carrier.object.hstarOcrSourceAssetId),
        maskAssetId:'', apiConfigId:selected.apiConfigId, modelId:selected.modelId,
        mode:'layer', options:{artFont:snapshot},
      };
      const timestamp = Date.now();
      const record = {
        taskId:`provisional:${clientRequestId}`,
        clientRequestId,
        creationState:'provisional',
        toolId:TOOL_ART_FONT,
        apiConfigId:clean(request.apiConfigId), modelId:clean(request.modelId),
        status:'queued', reconcileState:'pending', reconcileReason:'', mode:'layer',
        context:{...scope.context}, owner:{...scope.owner},
        sourceLayerId:request.sourceLayerId, sourceAssetId:request.sourceAssetId,
        maskAssetId:'', outputAssetId:'', snapshot:clone(snapshot), generatedLayerId:'',
        createdAt:timestamp, updatedAt:timestamp, completedAt:0,
        appliedAt:0, staleAt:0, discardedAt:0, error:'',
      };
      const requestState = validateArtLiveState(record, scope, carrier.object);
      if(requestState.isolated || requestState.reason) return null;
      taskRecords().push(record);
      retainTaskRecords();
      const saved = await persistProvisionalArtRecord(record);
      if(!saved || !artScopeIsCurrent(scope)) return record;
      return resumeArtCreationRecord(record, scope);
    }

    function restoreArtFont(textLayerId){
      const layerId = clean(textLayerId);
      if(!layerId) return Promise.resolve(null);
      const context = currentContext();
      const scope = captureArtScope(context);
      const recoverable = recoverableArtRecordForLayer(layerId, context);
      return startArtLayerRun(layerId, () => (
        recoverable
          ? resumeRecoverableArtRecord(recoverable, scope)
          : runArtFontRestore(layerId, scope.sessionGeneration, scope.pollGeneration)
      ));
    }

    async function restorePendingArtTasks(){
      const context = currentContext();
      const scope = captureArtScope(context);
      const records = taskRecords().filter(record => (
        record?.toolId === TOOL_ART_FONT
        && !TERMINAL_RECONCILE_STATES.has(clean(record?.reconcileState))
      ));
      await Promise.allSettled(records.map(record => {
        if(!artRecordScopeMatches(record, context)) return reconcileArtRecord(record, scope);
        const layerId = clean(record?.snapshot?.textLayerId);
        return startArtLayerRun(layerId, () => resumeRecoverableArtRecord(record, scope));
      }));
    }

    function abortArtPolling({sessionChanged = false} = {}){
      if(sessionChanged) state.artSessionGeneration += 1;
      state.artPollGeneration += 1;
      state.artRunsByTaskId.forEach(run => run.controller?.abort?.());
      state.artRunsByTaskId.clear();
      state.artRunsByLayerId.clear();
      editor.updateLayersPanel?.();
    }

    function isArtFontBusy(textLayerId){
      return state.artRunsByLayerId.has(clean(textLayerId));
    }

    async function restoreTaskRecords(generation){
      const context = currentContext();
      const records = [...taskRecords()];
      for(const record of records){
        if(record?.toolId === TOOL_ART_FONT) continue;
        if(generation !== state.runGeneration) return;
        if(['queued', 'running'].includes(record?.status)){
          state.activeTaskId = clean(record.taskId);
          state.activeTaskRecord = record;
          setStatus('running');
          try {
            const task = await aiClient.pollTask(context, record.taskId);
            if(generation !== state.runGeneration) return;
            updateTaskRecord(record, task);
          } catch(error){
            if(generation !== state.runGeneration) return;
            updateTaskRecord(record, {
              status:'failed',
              error:`恢复任务失败：${clean(error?.message || error)}`,
            });
          } finally {
            if(generation === state.runGeneration){
              state.activeTaskId = '';
              state.activeTaskRecord = null;
            }
          }
        }
        if(generation !== state.runGeneration) return;
        if(record.status !== 'succeeded' || record.appliedAt || record.toolId !== TOOL_REMOVE) continue;
        const assetId = clean(record.outputAssetId);
        if(!assetId){
          updateTaskRecord(record, {status:'failed', error:'恢复任务失败：去字结果资源不存在'});
          continue;
        }
        if(hasOutputAsset(assetId)){
          record.appliedAt = Date.now();
          record.updatedAt = record.appliedAt;
          markDirty('Restore existing text removal output');
          continue;
        }
        await createRemovedImageLayer({
          assetId,
          url:`/api/openshop/assets/${encodeURIComponent(assetId)}`,
          name:'去除文字',
          width:Number(editor.canvasW || 1),
          height:Number(editor.canvasH || 1),
        }, record);
      }
      if(generation !== state.runGeneration) return;
      if(!showOcrReview(pendingOcrRecord()) && state.status === 'running') setStatus('idle');
    }

    async function runTextRemoval(runOptions = {}){
      state.activeTool = TOOL_REMOVE;
      const resolution = ['auto', '1k', '2k', '4k'].includes(runOptions.resolution) ? runOptions.resolution : '4k';
      const ratio = [
        'source', 'square', 'portrait', 'landscape', 'portrait43', 'landscape43',
        'story', 'wide', 'ultrawide', 'ultratall',
      ].includes(runOptions.ratio) ? runOptions.ratio : 'source';
      const quality = ['auto', 'low', 'medium', 'high'].includes(runOptions.quality) ? runOptions.quality : 'auto';
      const prompt = clean(runOptions.prompt).slice(0, 2000);
      state.lastRemovalOptions = {resolution, ratio, quality, prompt};
      renderPanel();
      try {
        const selected = resolvedPreference(TOOL_REMOVE);
        if(!selected.available) throw new Error(selected.reason || '配置不可用');
        setStatus('preparing');
        const {captured, asset} = await uploadActiveLayer({strictSelection:true});
        const task = await executeTask(TOOL_REMOVE, {
          toolId:TOOL_REMOVE,
          sourceLayerId:clean(captured.layer?.layerId),
          sourceAssetId:asset.assetId,
          maskAssetId:'',
          apiConfigId:selected.apiConfigId,
          modelId:selected.modelId,
          mode:'layer',
          options:{resolution, ratio, quality, prompt},
        }, captured.dataUrl);
        const layer = await createRemovedImageLayer(task.result);
        setStatus('applied');
        return layer;
      } catch(error){
        if(error?.name === 'AbortError'){
          if(state.activeTaskRecord && !TERMINAL_STATES.has(state.activeTaskRecord.status)){
            updateTaskRecord(state.activeTaskRecord, {status:'cancelled'});
          }
          state.activeTaskId = '';
          state.activeTaskRecord = null;
          setStatus('cancelled');
          return null;
        }
        if(state.activeTaskRecord && !TERMINAL_STATES.has(state.activeTaskRecord.status)){
          updateTaskRecord(state.activeTaskRecord, {status:'failed', error:error?.message || error});
        }
        state.activeTaskId = '';
        state.activeTaskRecord = null;
        setStatus('failed', error?.message || error);
        return null;
      }
    }

    async function cancelActiveTask(){
      if(!state.activeTaskId) return null;
      const taskId = state.activeTaskId;
      state.runGeneration += 1;
      const task = await aiClient.cancelTask(currentContext(), taskId);
      updateTaskRecord(state.activeTaskRecord, task || {status:'cancelled'});
      state.activeTaskId = '';
      state.activeTaskRecord = null;
      setStatus('cancelled');
      return task;
    }

    function addListener(target, type, listener){
      target?.addEventListener?.(type, listener);
      state.listeners.push(() => target?.removeEventListener?.(type, listener));
    }

    function injectStyles(){
      if(documentRef.getElementById('hstar-text-tools-style')) return;
      const style = documentRef.createElement('style');
      style.id = 'hstar-text-tools-style';
      style.textContent = `
        .hstar-tool-glyph{font-size:13px;font-weight:800;line-height:1;letter-spacing:0}
        #hstar-text-tools-panel{position:absolute;z-index:85;top:74px;right:var(--panel-width);bottom:var(--statusbar-h);width:324px;background:var(--bg-depth-1);border-left:1px solid var(--border);box-shadow:-10px 0 24px rgba(0,0,0,.22);display:none;overflow:auto;color:var(--text-primary);letter-spacing:0}
        #hstar-text-tools-panel.open{display:block}.hstar-text-head{height:42px;display:flex;align-items:center;gap:8px;padding:0 12px;border-bottom:1px solid var(--border);position:sticky;top:0;background:var(--bg-depth-1);z-index:2}
        .hstar-text-head strong{font-size:13px}.hstar-text-head button{margin-left:auto}.hstar-text-body{padding:12px}.hstar-text-section{padding:10px 0;border-bottom:1px solid var(--border)}
        .hstar-text-section:last-child{border-bottom:0}.hstar-text-label{font-size:11px;color:var(--text-muted);margin-bottom:6px}.hstar-text-model{font-size:12px;line-height:1.5;word-break:break-word}
        .hstar-text-actions{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px}.hstar-text-actions .btn{padding:6px 10px}.hstar-text-actions .btn-primary{flex:1;min-width:128px}
        .hstar-text-provider-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}.hstar-text-provider-grid label{display:grid;gap:5px;min-width:0;font-size:11px;color:var(--text-muted)}.hstar-text-provider-grid select{width:100%;min-width:0;background:var(--bg-depth-3);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;padding:7px;font-size:12px;box-sizing:border-box}
        .hstar-text-field{display:grid;gap:5px;margin-top:9px}.hstar-text-field label{font-size:11px;color:var(--text-muted)}.hstar-text-field select,.hstar-text-field textarea{width:100%;background:var(--bg-depth-3);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;padding:7px;font-size:12px;box-sizing:border-box}.hstar-text-field textarea{min-height:70px;resize:vertical}
        .hstar-text-status{font-size:11px;line-height:1.5;color:var(--text-secondary);min-height:18px}#hstar-text-tools-panel[data-status="preparing"] .hstar-text-status,#hstar-text-tools-panel[data-status="running"] .hstar-text-status{color:#42d985;font-weight:800}.hstar-text-status.error{color:var(--danger)}
        .hstar-ocr-preview{position:relative;aspect-ratio:16/9;background:#171717;border:1px solid var(--border);overflow:hidden}.hstar-ocr-preview img{width:100%;height:100%;object-fit:contain}.hstar-ocr-box{position:absolute;border:1px solid #f7c948;background:rgba(247,201,72,.12);pointer-events:none}.hstar-ocr-box.low{border-color:#ff6b6b;background:rgba(255,107,107,.14)}
        .hstar-ocr-list{display:grid;gap:7px;margin-top:9px}.hstar-ocr-row{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px;align-items:start}.hstar-ocr-row textarea{width:100%;min-width:0;min-height:34px;max-height:96px;overflow:auto;resize:vertical;background:var(--bg-depth-3);color:var(--text-primary);border:1px solid var(--border);border-radius:4px;padding:7px;font:inherit;line-height:1.35;box-sizing:border-box}.hstar-ocr-confidence{padding-top:8px;font-size:10px;color:var(--text-muted)}.hstar-ocr-confidence.low{color:#ff8c8c;font-weight:700}
        .hstar-text-modal{position:fixed;inset:0;z-index:1200;background:rgba(0,0,0,.58);display:flex;align-items:center;justify-content:center;padding:16px}.hstar-text-dialog{width:min(560px,100%);max-height:min(720px,90vh);overflow:auto;background:var(--bg-depth-1);border:1px solid var(--border-active);border-radius:6px;box-shadow:0 18px 60px rgba(0,0,0,.45);padding:16px}.hstar-text-dialog h3{font-size:15px;margin:0 0 12px}.hstar-font-list{display:grid;gap:5px;max-height:360px;overflow:auto}.hstar-font-row{display:grid;grid-template-columns:1fr auto;gap:8px;align-items:center;padding:7px 0;border-bottom:1px solid var(--border)}
        #hstar-font-manage-btn{padding:3px 7px;font-size:10px}
        @media(max-width:760px){#hstar-text-tools-panel{right:0;top:74px;bottom:48px;width:min(324px,calc(100vw - var(--toolbar-w)));max-width:calc(100vw - var(--toolbar-w))}.hstar-text-provider-grid{grid-template-columns:1fr}.hstar-text-dialog{padding:12px}}
      `;
      documentRef.head?.appendChild(style);
    }

    function injectToolbar(){
      const toolbar = documentRef.getElementById('toolbar');
      if(!toolbar || toolbar.querySelector('[data-hstar-text-tool]')) return;
      const separator = documentRef.createElement('div');
      separator.className = 'tool-sep';
      toolbar.appendChild(separator);
      [
        {id:TOOL_EXTRACT, title:'文字提取', glyph:'文'},
        {id:TOOL_REMOVE, title:'去除文字', glyph:'删'},
      ].forEach(tool => {
        const button = documentRef.createElement('button');
        button.type = 'button';
        button.className = 'tool-btn';
        button.dataset.hstarTextTool = tool.id;
        button.dataset.tip = tool.title;
        button.title = tool.title;
        button.setAttribute('aria-label', tool.title);
        button.innerHTML = `<span class="hstar-tool-glyph" aria-hidden="true">${tool.glyph}</span>`;
        button.addEventListener('click', () => openTool(tool.id));
        toolbar.appendChild(button);
      });
    }

    function injectFontButton(){
      const optionsBar = documentRef.getElementById('opt-text');
      if(!optionsBar || documentRef.getElementById('hstar-font-manage-btn')) return;
      const button = documentRef.createElement('button');
      button.id = 'hstar-font-manage-btn';
      button.type = 'button';
      button.className = 'btn';
      button.textContent = '字体管理';
      button.addEventListener('click', openFontManager);
      optionsBar.appendChild(button);
    }

    function ensurePanel(){
      let panel = documentRef.getElementById('hstar-text-tools-panel');
      if(panel) return panel;
      panel = documentRef.createElement('aside');
      panel.id = 'hstar-text-tools-panel';
      panel.setAttribute('aria-label', 'OpenShop 文字工具');
      panel.addEventListener('click', handlePanelClick);
      panel.addEventListener('input', handlePanelInput);
      panel.addEventListener('change', handlePanelInput);
      documentRef.body.appendChild(panel);
      return panel;
    }

    function statusText(){
      if(state.error) return state.error;
      return ({
        idle:'等待执行', preparing:'正在准备图层资源', running:'模型正在处理',
        review:'请校对识别文字后确认创建图层', applied:'已创建新图层',
        cancelled:'任务已取消', failed:'任务失败',
      })[state.status] || '等待执行';
    }

    function modelSection(toolId){
      const selected = resolvedPreference(toolId);
      const preference = preferenceFor(toolId);
      const tool = aiClient.getCatalog?.()?.tools?.[toolId];
      const providers = Array.isArray(tool?.providers) ? tool.providers : [];
      const providerId = clean(selected.apiConfigId || preference.apiConfigId || providers[0]?.id);
      const provider = providers.find(item => clean(item?.id) === providerId) || providers[0];
      const models = (Array.isArray(provider?.models) ? provider.models : []).filter(model => (
        toolId !== TOOL_ART_FONT
        || (model?.capabilities?.supportsImageInput !== false && model?.imageInput !== false)
      ));
      const preferredModelId = clean(selected.modelId || preference.modelId);
      const modelId = models.some(model => clean(model?.id) === preferredModelId)
        ? preferredModelId
        : clean(models.find(model => model?.available !== false)?.id || models[0]?.id);
      return `<section class="hstar-text-section" data-model-section="${escapeHtml(toolId)}">
        ${toolId === TOOL_ART_FONT ? '<div class="hstar-text-label">艺术字体图像模型</div>' : ''}
        <div class="hstar-text-provider-grid">
          <label><span>API</span><select data-text-provider data-provider-tool="${escapeHtml(toolId)}" aria-label="API">${providers.map(item => `<option value="${escapeHtml(item.id)}" ${clean(item.id) === providerId ? 'selected' : ''} ${item.available === false ? 'disabled' : ''}>${escapeHtml(item.name || item.id)}</option>`).join('')}</select></label>
          <label><span>模型</span><select data-text-model data-model-tool="${escapeHtml(toolId)}" aria-label="模型">${models.map(model => `<option value="${escapeHtml(model.id)}" ${clean(model.id) === modelId ? 'selected' : ''} ${model.available === false ? 'disabled' : ''}>${escapeHtml(model.name || model.id)}</option>`).join('')}</select></label>
        </div>
        <div class="hstar-text-label" style="margin-top:7px">${preference.mode === 'project' ? '本项目单独指定' : '跟随全局默认'}</div>
        ${selected.available ? '' : `<div class="hstar-text-status error">${escapeHtml(selected.reason || '配置不可用')}</div>`}
      </section>`;
    }

    function reviewHtml(){
      if(!state.reviewBlocks.length) return '';
      const legacyResult = Number(activeOcrReviewRecord()?.result?.schemaVersion) !== 5;
      const applyPending = Boolean(state.pendingTextApply
        && state.pendingTextApply.generation === state.runGeneration
        && state.pendingTextApply.record === activeOcrReviewRecord());
      const boxes = state.reviewBlocks.map(block => {
        const bounds = quadBounds(block.quad);
        return `<span class="hstar-ocr-box ${block.lowConfidence ? 'low' : ''}" style="left:${bounds.left * 100}%;top:${bounds.top * 100}%;width:${bounds.width * 100}%;height:${bounds.height * 100}%"></span>`;
      }).join('');
      const rows = state.reviewBlocks.map((block, index) => `<div class="hstar-ocr-row">
        <textarea rows="2" wrap="off" spellcheck="false" data-hstar-ocr-index="${index}" data-voice-input="on" data-voice-label="识别文字 ${index + 1}" aria-label="识别文字 ${index + 1}">${escapeHtml(block.text)}</textarea>
        <span class="hstar-ocr-confidence ${block.lowConfidence ? 'low' : ''}">${block.lowConfidence ? '低置信度 ' : ''}${Math.round(Number(block.confidence || 0) * 100)}%</span>
      </div>`).join('');
      return `<section class="hstar-text-section"><div class="hstar-text-label">识别校对</div>
        <div class="hstar-ocr-preview"><img src="${escapeHtml(state.reviewSourceDataUrl)}" alt="文字识别校对预览">${boxes}</div>
        <div class="hstar-ocr-list">${rows}</div>
        ${legacyResult ? '<div class="hstar-text-status error">旧版识别结果，请重新执行文字提取</div>' : ''}
        <div class="hstar-text-actions"><button type="button" class="btn btn-primary" data-hstar-action="apply-extraction" ${applyPending || legacyResult ? 'disabled' : ''}>创建文字图层</button></div>
      </section>`;
    }

    function renderPanel(){
      const panel = ensurePanel();
      panel.dataset.toolId = state.activeTool;
      panel.dataset.status = state.status;
      const running = ['preparing', 'running'].includes(state.status);
      const pixelReady = Boolean(state.activeTool === TOOL_REMOVE ? selectedPixelLayer() : activePixelLayer());
      const selected = resolvedPreference(state.activeTool);
      const disabled = running || !pixelReady || !selected.available;
      const title = state.activeTool === TOOL_EXTRACT ? '文字提取' : '去除文字';
      const body = state.activeTool === TOOL_EXTRACT
        ? `${modelSection(TOOL_EXTRACT)}
          ${modelSection(TOOL_ART_FONT)}
          <section class="hstar-text-section"><div class="hstar-text-label">非破坏式识别</div><div class="hstar-text-model">识别中文、英文和中英混排，结果确认后创建独立可编辑文字图层。</div>
          <div class="hstar-text-actions"><button type="button" class="btn btn-primary" data-hstar-action="run-extraction" ${disabled ? 'disabled' : ''}>执行文字提取</button><button type="button" class="btn" data-hstar-action="cancel" ${running ? '' : 'disabled'}>取消</button></div></section>
          ${reviewHtml()}`
        : `${modelSection(TOOL_REMOVE)}
          <section class="hstar-text-section">
            <div class="hstar-text-field"><label for="hstar-remove-resolution">画质</label><select id="hstar-remove-resolution"><option value="auto">自动</option><option value="1k">1K</option><option value="2k">2K</option><option value="4k">4K</option></select></div>
            <div class="hstar-text-field"><label for="hstar-remove-ratio">图片比例</label><select id="hstar-remove-ratio" ${state.lastRemovalOptions.resolution === 'auto' ? 'disabled' : ''}><option value="source">适配原图</option><option value="square">1:1</option><option value="portrait">2:3</option><option value="landscape">3:2</option><option value="portrait43">3:4</option><option value="landscape43">4:3</option><option value="story">9:16</option><option value="wide">16:9</option><option value="ultrawide">21:9</option><option value="ultratall">9:21</option></select></div>
            <div class="hstar-text-field"><label for="hstar-remove-quality">生成质量</label><select id="hstar-remove-quality"><option value="auto">自动</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></div>
            <div class="hstar-text-field"><label for="hstar-remove-prompt">补充要求</label><textarea id="hstar-remove-prompt" maxlength="2000" data-voice-input="on" data-voice-label="去除文字补充要求" placeholder="例如：保留纸张纹理">${escapeHtml(state.lastRemovalOptions.prompt)}</textarea></div>
            <div class="hstar-text-actions"><button type="button" class="btn btn-primary" data-hstar-action="run-removal" ${disabled ? 'disabled' : ''}>执行去除文字</button><button type="button" class="btn" data-hstar-action="cancel" ${running ? '' : 'disabled'}>取消</button></div>
          </section>`;
      panel.innerHTML = `<div class="hstar-text-head"><strong>${title}</strong><button class="btn" type="button" data-hstar-action="close">关闭</button></div><div class="hstar-text-body">${body}<section class="hstar-text-section"><div class="hstar-text-status ${state.error ? 'error' : ''}">${escapeHtml(statusText())}</div></section></div>`;
      panel.querySelectorAll('textarea[data-hstar-ocr-index]').forEach(control => {
        const block = state.reviewBlocks[Number(control.dataset.hstarOcrIndex)];
        if(block) control.value = String(block.text ?? '');
      });
      const resolution = panel.querySelector('#hstar-remove-resolution');
      if(resolution) resolution.value = state.lastRemovalOptions.resolution;
      const ratio = panel.querySelector('#hstar-remove-ratio');
      if(ratio) ratio.value = state.lastRemovalOptions.ratio;
      const quality = panel.querySelector('#hstar-remove-quality');
      if(quality) quality.value = state.lastRemovalOptions.quality;
    }

    function openTool(toolId){
      state.activeTool = toolId === TOOL_REMOVE ? TOOL_REMOVE : TOOL_EXTRACT;
      documentRef.querySelectorAll('[data-hstar-text-tool]').forEach(button => button.classList.toggle('active', button.dataset.hstarTextTool === state.activeTool));
      const panel = ensurePanel();
      panel.classList.add('open');
      renderPanel();
    }

    function closePanel(){
      ensurePanel().classList.remove('open');
      documentRef.querySelectorAll('[data-hstar-text-tool]').forEach(button => button.classList.remove('active'));
    }

    async function handlePanelClick(event){
      const action = event.target.closest?.('[data-hstar-action]')?.dataset?.hstarAction;
      if(action === 'close') closePanel();
      else if(action === 'run-extraction') await runTextExtraction();
      else if(action === 'run-removal') await runTextRemoval(state.lastRemovalOptions);
      else if(action === 'cancel') await cancelActiveTask();
      else if(action === 'apply-extraction'){
        try {
          await applyTextExtraction();
        } catch(error){
          setStatus('failed', error instanceof Error ? error.message : String(error));
        }
      }
    }

    function handlePanelInput(event){
      if(event.type === 'change' && event.target.matches?.('[data-text-provider]')){
        const toolId = clean(event.target.dataset.providerTool || state.activeTool);
        const providerId = clean(event.target.value);
        const tool = aiClient.getCatalog?.()?.tools?.[toolId];
        const provider = (tool?.providers || []).find(item => clean(item?.id) === providerId);
        const model = (provider?.models || []).find(item => (
          item?.available !== false
          && (toolId !== TOOL_ART_FONT
            || (item?.capabilities?.supportsImageInput !== false && item?.imageInput !== false))
        ));
        setPreference(toolId, {mode:'project', apiConfigId:providerId, modelId:clean(model?.id)});
        return;
      }
      if(event.type === 'change' && event.target.matches?.('[data-text-model]')){
        const toolId = clean(event.target.dataset.modelTool || state.activeTool);
        const section = event.target.closest?.('[data-model-section]');
        const providerId = clean(section?.querySelector('[data-text-provider]')?.value);
        setPreference(toolId, {mode:'project', apiConfigId:providerId, modelId:clean(event.target.value)});
        return;
      }
      if(event.target.id === 'hstar-remove-resolution'){
        state.lastRemovalOptions.resolution = event.target.value;
        renderPanel();
        return;
      }
      if(event.target.id === 'hstar-remove-ratio') state.lastRemovalOptions.ratio = event.target.value;
      if(event.target.id === 'hstar-remove-quality') state.lastRemovalOptions.quality = event.target.value;
      if(event.target.id === 'hstar-remove-prompt') state.lastRemovalOptions.prompt = event.target.value.slice(0, 2000);
      if(event.target.dataset?.hstarOcrIndex !== undefined){
        const block = state.reviewBlocks[Number(event.target.dataset.hstarOcrIndex)];
        if(block) {
          block.text = event.target.value;
          persistReviewBlocks();
        }
      }
    }

    function openFontManager(){
      documentRef.getElementById('hstar-font-manager')?.remove();
      const refs = fontManager.scanEditor(editor);
      const available = fontManager.listCommonFonts().filter(item => item.status === 'available');
      const modal = documentRef.createElement('div');
      modal.id = 'hstar-font-manager';
      modal.className = 'hstar-text-modal';
      modal.innerHTML = `<div class="hstar-text-dialog"><h3>字体管理</h3><div class="hstar-font-list">${refs.length ? refs.map((ref, index) => `<div class="hstar-font-row"><div><strong>${escapeHtml(ref.family)}</strong><div class="hstar-text-label">${ref.status === 'missing' ? '缺失字体' : ref.status === 'substituted' ? `已替换为 ${escapeHtml(ref.replacementFamily)}` : '可用'}</div></div>${ref.status === 'missing' ? `<select data-font-replacement="${index}">${available.map(item => `<option value="${escapeHtml(item.family)}">${escapeHtml(item.label || item.family)}</option>`).join('')}</select><button type="button" class="btn" data-font-apply="${index}">替换</button>` : ''}</div>`).join('') : '<div class="hstar-text-status">当前项目没有文字字体引用</div>'}</div><div class="hstar-text-actions"><button type="button" class="btn" data-font-close>关闭</button></div></div>`;
      documentRef.body.appendChild(modal);
      modal.addEventListener('click', event => {
        if(event.target.matches('[data-font-close]')) modal.remove();
        const index = event.target.dataset?.fontApply;
        if(index === undefined) return;
        const ref = refs[Number(index)];
        const select = modal.querySelector(`[data-font-replacement="${index}"]`);
        if(ref && select?.value){ fontManager.replaceFont(editor, ref.family, select.value); modal.remove(); openFontManager(); }
      });
    }

    function onSessionOpened(event){
      invalidatePendingTextApply();
      state.artSessionVisible = true;
      abortArtPolling({sessionChanged:true});
      state.runGeneration += 1;
      state.activeTaskId = '';
      state.activeTaskRecord = null;
      aiClient.startSession(event.detail?.session?.context || currentContext());
      state.reviewBlocks = [];
      state.reviewSourceDataUrl = '';
      state.reviewTaskRecord = null;
      setStatus('idle');
    }

    function onProjectLoaded(){
      invalidatePendingTextApply();
      state.artSessionVisible = true;
      abortArtPolling({sessionChanged:true});
      const generation = ++state.runGeneration;
      state.activeTaskId = '';
      state.activeTaskRecord = null;
      state.reviewBlocks = [];
      state.reviewSourceDataUrl = '';
      state.reviewTaskRecord = null;
      syncCanvasObjectOrder();
      fontManager.scanEditor(editor);
      renderPanel();
      void restoreTaskRecords(generation).catch(error => {
        if(generation !== state.runGeneration) return;
        state.activeTaskId = '';
        state.activeTaskRecord = null;
        setStatus('failed', `恢复任务失败：${clean(error?.message || error)}`);
      });
      void restorePendingArtTasks().catch(error => {
        root.console?.error?.('[OpenShop] 恢复艺术字体任务失败', error);
      });
    }

    function onSessionStopped(){
      invalidatePendingTextApply();
      state.artSessionVisible = false;
      abortArtPolling({sessionChanged:true});
      state.runGeneration += 1;
      state.activeTaskId = '';
      state.activeTaskRecord = null;
      aiClient.stopSession();
    }

    function onSessionHidden(){
      state.artSessionVisible = false;
      abortArtPolling();
    }

    function onSessionVisible(){
      state.artSessionVisible = true;
      void restorePendingArtTasks().catch(error => {
        root.console?.error?.('[OpenShop] 恢复艺术字体轮询失败', error);
      });
    }

    function onArtFontRequested(event){
      void restoreArtFont(event?.detail?.layerId);
    }

    function onHistoryRestored(){
      let changed = false;
      const timestamp = Date.now();
      taskRecords().forEach(record => {
        if(
          record?.toolId !== TOOL_ART_FONT
          || record.reconcileState !== 'applied'
          || existingArtOutput(record)
          || !findArtCarrier(record.snapshot?.textLayerId, record.snapshot?.ocrBlockId)
        ) return;
        record.reconcileState = 'discarded';
        record.reconcileReason = 'undone';
        record.discardedAt = timestamp;
        record.updatedAt = timestamp;
        changed = true;
      });
      if(changed) void persistState('art-font-undone', 'Undo artistic font').catch(error => {
        root.console?.error?.('[OpenShop] 保存艺术字体撤销状态失败', error);
      });
    }

    async function start(){
      if(state.started) return;
      state.started = true;
      injectStyles();
      injectFontButton();
      ensurePanel();
      try { aiClient.startSession(currentContext()); } catch(error) {}
      state.unsubscribeCatalog = aiClient.subscribe(() => renderPanel());
      addListener(root, 'openshop:session-opened', onSessionOpened);
      addListener(root, 'openshop:project-loaded', onProjectLoaded);
      addListener(root, 'openshop:session-stopped', onSessionStopped);
      addListener(root, 'openshop:session-hidden', onSessionHidden);
      addListener(root, 'openshop:session-visible', onSessionVisible);
      addListener(root, 'openshop:art-font-restore', onArtFontRequested);
      addListener(root, 'openshop:history-restored', onHistoryRestored);
      await aiClient.loadCatalog().catch(error => { state.error = clean(error?.message || error); });
      injectToolbar();
      fontManager.scanEditor(editor);
      renderPanel();
    }

    function destroy(){
      if(state.destroyed) return;
      state.destroyed = true;
      invalidatePendingTextApply();
      abortArtPolling({sessionChanged:true});
      state.runGeneration += 1;
      state.listeners.splice(0).forEach(remove => remove());
      state.unsubscribeCatalog?.();
      aiClient.stopSession();
      documentRef.getElementById('hstar-text-tools-panel')?.remove();
      documentRef.getElementById('hstar-api-selector')?.remove();
      documentRef.getElementById('hstar-font-manager')?.remove();
    }

    function getState(){
      return {
        activeTool:state.activeTool,
        status:state.status,
        error:state.error,
        reviewBlocks:clone(state.reviewBlocks),
        activeTaskId:state.activeTaskId,
        artBusyLayerIds:[...state.artRunsByLayerId.keys()],
        detachedArtTaskCount:state.detachedArtTasks.size,
      };
    }

    async function defaultImageLoader(result, fabric){
      return new Promise((resolve, reject) => {
        try {
          fabric.Image.fromURL(result.url, image => image ? resolve(image) : reject(new Error('图片解码失败')), {crossOrigin:'anonymous'});
        } catch(error){ reject(error); }
      });
    }

    return Object.freeze({
      start,
      destroy,
      openTool,
      setPreference,
      runTextExtraction,
      applyTextExtraction,
      runTextRemoval,
      cancelActiveTask,
      captureActiveLayer,
      createRemovedImageLayer,
      restoreArtFont,
      restorePendingArtTasks,
      isArtFontBusy,
      getState,
    });
  }

  root.HstarOpenShopTextTools = Object.freeze({createController});
})(window);
