(function bootstrapOpenShopGenerativeTools(root){
  const TOOLS = new Set(['generative-fill', 'local-redraw']);
  const SELECTION_TOOLS = new Set(['marquee-rect', 'marquee-ellipse', 'lasso', 'magic-wand', 'ai-segment']);

  function clean(value){
    return String(value || '').trim();
  }

  function clone(value){
    if(typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function escapeHtml(value){
    return String(value ?? '').replace(/[&<>"']/g, character => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
    })[character]);
  }

  function createId(prefix){
    const randomId = root.crypto?.randomUUID?.();
    return randomId
      ? `${prefix}-${randomId}`
      : `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  }

  function defaultImageLoader(result, fabricRef){
    return new Promise((resolve, reject) => {
      if(!fabricRef?.Image?.fromURL){
        reject(new Error('OpenShop 生成图片解码器不可用'));
        return;
      }
      fabricRef.Image.fromURL(result.url, image => {
        if(image) resolve(image);
        else reject(new Error('OpenShop 生成图片解码失败'));
      }, {crossOrigin:'anonymous'});
    });
  }

  function createController(options={}){
    const editor = options.editor;
    const runtime = options.runtime;
    const aiClient = options.aiClient;
    const generativeClient = options.generativeClient;
    const assetApi = options.assetApi;
    const referenceManager = options.referenceManager;
    const documentRef = options.documentRef || root.document;
    const fetchImpl = options.fetchImpl || root.fetch?.bind(root);
    const fabricRef = options.fabricRef || root.fabric;
    const imageLoader = options.imageLoader || defaultImageLoader;
    if(!editor || !runtime || !aiClient || !generativeClient || !assetApi || !referenceManager){
      throw new Error('OpenShop 生成式编辑依赖不完整');
    }

    const state = {
      started:false,
      destroyed:false,
      activeTool:'',
      status:'idle',
      error:'',
      prompt:'',
      referenceMode:'full',
      size:'auto',
      quality:'auto',
      count:1,
      feather:0,
      lastSelectionTool:'marquee-rect',
      lastTask:null,
      compositeVersion:0,
      mentionOpen:false,
      referenceMenuOpen:false,
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

    function selectionAvailable(){
      const bounds = editor._selectionBounds;
      return Boolean(
        editor._selectionMask
        || (bounds && Number(bounds.w ?? bounds.width) > 0 && Number(bounds.h ?? bounds.height) > 0)
      );
    }

    function selectionBounds(){
      const bounds = editor._selectionBounds;
      if(!bounds) throw new Error('当前没有可用选区');
      return {
        x:Math.max(0, Math.round(Number(bounds.x || 0))),
        y:Math.max(0, Math.round(Number(bounds.y || 0))),
        width:Math.max(1, Math.round(Number(bounds.w ?? bounds.width ?? 0))),
        height:Math.max(1, Math.round(Number(bounds.h ?? bounds.height ?? 0))),
      };
    }

    function preferenceFor(toolId){
      const preferences = editor.__hstarAiToolPreferences;
      return preferences && typeof preferences === 'object'
        ? preferences[toolId] || {mode:'global'}
        : {mode:'global'};
    }

    function setPreference(toolId, preference={}){
      if(!TOOLS.has(toolId)) throw new Error('OpenShop 生成式功能不存在');
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
      markDirty('OpenShop generative preference');
      render();
      return clone(editor.__hstarAiToolPreferences[toolId]);
    }

    function toolCatalog(toolId){
      return aiClient.getCatalog?.()?.tools?.[toolId] || null;
    }

    function resolvedModel(){
      const preference = preferenceFor(state.activeTool);
      const resolved = aiClient.resolvePreference(state.activeTool, preference);
      const providers = Array.isArray(toolCatalog(state.activeTool)?.providers)
        ? toolCatalog(state.activeTool).providers
        : [];
      const provider = providers.find(item => clean(item?.id) === clean(resolved.apiConfigId));
      const model = resolved.model || provider?.models?.find(item => clean(item?.id) === clean(resolved.modelId));
      return {...resolved, provider, model};
    }

    function capabilityLimits(model){
      const capabilities = model?.capabilities || {};
      return {
        maxOutputs:Math.max(1, Number(capabilities.maxOutputs || 8)),
        maxReferences:Math.max(1, Number(capabilities.maxReferenceImages || 8)),
        sizes:Array.isArray(capabilities.sizes) && capabilities.sizes.length ? capabilities.sizes : ['auto'],
        qualities:Array.isArray(capabilities.qualities) && capabilities.qualities.length ? capabilities.qualities : ['auto'],
      };
    }

    function taskRecords(){
      editor.__hstarAiTaskRecords = Array.isArray(editor.__hstarAiTaskRecords)
        ? editor.__hstarAiTaskRecords
        : [];
      return editor.__hstarAiTaskRecords;
    }

    function upsertTaskRecord(task){
      if(!task?.taskId) return null;
      const records = taskRecords();
      const index = records.findIndex(item => item.taskId === task.taskId);
      const record = clone(task);
      if(index >= 0) records[index] = record;
      else records.push(record);
      editor.__hstarAiTaskRecords = records.slice(-100);
      markDirty('OpenShop generation task updated');
      return record;
    }

    function pendingResults(){
      editor.__hstarAiPendingResults = Array.isArray(editor.__hstarAiPendingResults)
        ? editor.__hstarAiPendingResults
        : [];
      return editor.__hstarAiPendingResults;
    }

    function queuePendingResults(task, children){
      const records = pendingResults();
      const queued = new Set(records.map(item => clean(item?.child?.childTaskId)).filter(Boolean));
      children.forEach(child => {
        if(queued.has(clean(child.childTaskId))) return;
        records.push({task:clone(task), child:clone(child)});
        queued.add(clean(child.childTaskId));
      });
      editor.__hstarAiPendingResults = records.slice(-64);
    }

    function removePendingResults(childIds){
      const removed = new Set(childIds);
      editor.__hstarAiPendingResults = pendingResults()
        .filter(item => !removed.has(clean(item?.child?.childTaskId)));
    }

    async function createGenerationLayer(task, child){
      const result = child.result && typeof child.result === 'object' ? child.result : {};
      const outputAssetId = clean(child.outputAssetId || result.assetId);
      const image = await imageLoader({
        ...result,
        assetId:outputAssetId,
        url:clean(result.url) || `/api/openshop/assets/${encodeURIComponent(outputAssetId)}`,
      }, fabricRef);
      const title = task.toolId === 'generative-fill' ? '生成式填充' : '局部重绘';
      const layerId = createId('hstar-generation-layer').replaceAll('-', '_');
      const values = {left:0, top:0, selectable:true, visible:true, name:title};
      if(typeof image.set === 'function') image.set(values);
      else Object.assign(image, values);
      image.assetRef = outputAssetId;
      image.hstarAssetId = outputAssetId;
      image.hstarAssetRole = 'ai-output';
      image.hstarLayerId = layerId;
      const snapshot = task.snapshot && typeof task.snapshot === 'object' ? task.snapshot : {};
      const denominator = Math.max(1, Number(snapshot.originalTargetCount || task.targetCount || 1));
      const numerator = Math.max(0, Number(child.index || 0)) + 1;
      return {
        layerId,
        name:`${title} ${numerator}/${denominator}`,
        visible:true,
        opacity:100,
        blend:'source-over',
        objects:[image],
        hstarAiGeneration:{
          taskId:clean(task.taskId),
          childTaskId:clean(child.childTaskId),
          retryOfTaskId:clean(task.retryOfTaskId),
          toolId:clean(task.toolId),
          prompt:String(snapshot.prompt || ''),
          apiConfigId:clean(task.apiConfigId),
          modelId:clean(task.modelId),
          size:clean(snapshot.size) || 'auto',
          quality:clean(snapshot.quality) || 'auto',
          referenceMode:snapshot.referenceMode === 'selection' ? 'selection' : 'full',
          references:clone(Array.isArray(snapshot.references) ? snapshot.references : []),
          sourceLayerId:clean(snapshot.sourceLayerId),
          selection:clone(snapshot.selection && typeof snapshot.selection === 'object' ? snapshot.selection : {}),
        },
      };
    }

    function syncGenerationObjectOrder(){
      if(typeof editor.canvas?.moveTo !== 'function') return;
      editor.layers.flatMap(layer => Array.isArray(layer.objects) ? layer.objects : [])
        .forEach((object, index) => editor.canvas.moveTo(object, index));
    }

    async function applyTaskResults(task){
      if(!task || task.status === 'cancelled') return [];
      const children = Array.isArray(task.children) ? task.children : [];
      const successful = children
        .filter(child => child?.status === 'succeeded' && clean(child.outputAssetId || child.result?.assetId))
        .sort((left, right) => Number(left.index || 0) - Number(right.index || 0));
      if(!successful.length) return [];
      const applied = new Set(editor.layers.flatMap(layer => (
        layer?.hstarAiGeneration?.childTaskId ? [clean(layer.hstarAiGeneration.childTaskId)] : []
      )));
      const unapplied = successful.filter(child => !applied.has(clean(child.childTaskId)));
      if(!unapplied.length) return [];
      const snapshot = task.snapshot && typeof task.snapshot === 'object' ? task.snapshot : {};
      const sourceExists = editor.layers.some(layer => clean(layer?.layerId) === clean(snapshot.sourceLayerId));
      if(!sourceExists){
        queuePendingResults(task, unapplied);
        markDirty('OpenShop AI results pending insertion');
        await runtime.requestSave?.({reason:'ai-generation'});
        return [];
      }
      const frozenSourceIndex = Math.max(
        0,
        Math.min(editor.layers.length - 1, Number(snapshot.sourceLayerIndex || 0)),
      );
      const inserted = [];
      for(const child of unapplied){
        const layer = await createGenerationLayer(task, child);
        editor.layers.splice(frozenSourceIndex + 1 + inserted.length, 0, layer);
        editor.canvas?.add?.(layer.objects[0]);
        inserted.push(layer);
      }
      if(!inserted.length) return [];
      removePendingResults(inserted.map(layer => layer.hstarAiGeneration.childTaskId));
      editor.activeLayerIdx = frozenSourceIndex + inserted.length;
      syncGenerationObjectOrder();
      editor.updateLayersPanel?.();
      editor.canvas?.renderAll?.();
      markDirty('OpenShop AI layers inserted');
      await runtime.requestSave?.({reason:'ai-generation'});
      return inserted;
    }

    function injectStyles(){
      if(documentRef.querySelector('link[data-hstar-generative-styles]')) return;
      const link = documentRef.createElement('link');
      link.rel = 'stylesheet';
      link.href = './host/openshop-generative-tools.css';
      link.dataset.hstarGenerativeStyles = 'true';
      documentRef.head.appendChild(link);
    }

    function ensureEntries(){
      let entries = documentRef.querySelector('[data-hstar-generative-entries]');
      if(entries) return entries;
      const optionsBar = documentRef.getElementById('tool-options') || documentRef.body;
      entries = documentRef.createElement('div');
      entries.className = 'hstar-generative-entries';
      entries.dataset.hstarGenerativeEntries = 'true';
      entries.innerHTML = `
        <button type="button" class="btn hstar-generative-entry" data-hstar-generative-tool="generative-fill">生成式填充</button>
        <button type="button" class="btn hstar-generative-entry" data-hstar-generative-tool="local-redraw">局部重绘</button>`;
      entries.addEventListener('click', event => {
        const toolId = event.target.closest?.('[data-hstar-generative-tool]')?.dataset?.hstarGenerativeTool;
        if(toolId) openTool(toolId);
      });
      optionsBar.appendChild(entries);
      return entries;
    }

    function ensureBar(){
      let bar = documentRef.querySelector('[data-generative-operation-bar]');
      if(bar) return bar;
      bar = documentRef.createElement('aside');
      bar.className = 'hstar-generative-bar';
      bar.dataset.generativeOperationBar = 'true';
      bar.setAttribute('aria-label', '生成式编辑操作栏');
      bar.hidden = true;
      bar.addEventListener('click', handleBarClick);
      bar.addEventListener('input', handleBarInput);
      bar.addEventListener('change', handleBarChange);
      documentRef.body.appendChild(bar);
      return bar;
    }

    function optionsHtml(values, selected){
      return values.map(value => `<option value="${escapeHtml(value)}" ${value === selected ? 'selected' : ''}>${escapeHtml(value === 'auto' ? '自动' : value)}</option>`).join('');
    }

    function disabledReason(selected, limits){
      if(!selectionAvailable()) return '请先选择要修改的区域';
      if(!selected.available || !selected.model) return '配置不可用，请重新选择 API 与模型';
      if(state.activeTool === 'local-redraw' && !clean(state.prompt)) return '局部重绘需要填写修改要求';
      if(state.count < 1 || state.count > limits.maxOutputs) return `当前模型最多生成 ${limits.maxOutputs} 张`;
      if(['preparing', 'running'].includes(state.status)) return '当前任务正在执行';
      return '';
    }

    function statusText(){
      if(state.error) return state.error;
      return ({
        idle:'等待操作', selecting:'请先选择要修改的区域', ready:'可以提交',
        preparing:'正在冻结源图、蒙版和参考图', running:'生成任务正在后台执行',
        succeeded:'生成完成', partial:'部分结果生成完成', failed:'生成失败',
        cancelled:'任务已取消',
      })[state.status] || '等待操作';
    }

    function referenceHtml(){
      if(state.activeTool !== 'local-redraw') return '';
      const primary = referenceManager.getPrimary?.();
      const references = referenceManager.list?.() || [];
      const thumbnails = references.map(item => `<span class="hstar-reference-thumb" title="${escapeHtml(item.mention || `@${item.alias}`)}">
        ${item.thumbnailUrl || item.dataUrl ? `<img src="${escapeHtml(item.thumbnailUrl || item.dataUrl)}" alt="${escapeHtml(item.alias)}">` : '<span>图</span>'}
        <small>${escapeHtml(item.alias)}</small>
      </span>`).join('');
      return `<div class="hstar-generative-reference-block">
        <div class="hstar-primary-reference" data-primary-reference-thumbnail>
          ${primary?.thumbnailUrl || primary?.dataUrl
            ? `<img src="${escapeHtml(primary.thumbnailUrl || primary.dataUrl)}" alt="当前主参考图">`
            : '<span class="hstar-reference-empty">等待参考预览</span>'}
          <div><strong>主参考</strong><small>${state.referenceMode === 'selection' ? '选择区域' : '当前全图'}</small></div>
        </div>
        <div class="hstar-reference-mode" role="radiogroup" aria-label="参考范围">
          <button type="button" data-reference-mode="selection" aria-pressed="${state.referenceMode === 'selection'}">参考选择区域</button>
          <button type="button" data-reference-mode="full" aria-pressed="${state.referenceMode === 'full'}">参考全图</button>
        </div>
        <div class="hstar-reference-strip" data-reference-strip>
          <button type="button" class="hstar-reference-add" data-generative-action="toggle-reference-menu" aria-label="添加参考图" title="添加参考图">+</button>
          ${thumbnails}
          <div class="hstar-reference-menu" data-reference-menu ${state.referenceMenuOpen ? '' : 'hidden'}>
            <button type="button" data-reference-add="selection">当前选区</button>
            <button type="button" data-reference-add="layer">当前图层</button>
            <button type="button" data-reference-add="library">素材库</button>
            <button type="button" data-reference-add="local">本地图片</button>
          </div>
          <input type="file" accept="image/*" data-reference-local-input hidden>
        </div>
      </div>`;
    }

    function mentionPickerHtml(){
      if(state.activeTool !== 'local-redraw') return '';
      const items = referenceManager.itemsForMentionPicker?.('') || [];
      return `<div class="hstar-reference-mention-picker" data-reference-mention-picker ${state.mentionOpen ? '' : 'hidden'}>
        ${items.map(item => `<button type="button" data-reference-mention="${escapeHtml(item.mention)}">
          ${item.thumbnailUrl ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="">` : '<span class="hstar-mention-placeholder">@</span>'}
          <span>${escapeHtml(item.mention)}</span>
        </button>`).join('')}
      </div>`;
    }

    function renderMentionPicker(){
      const bar = ensureBar();
      const picker = bar.querySelector('[data-reference-mention-picker]');
      if(!picker) return;
      picker.hidden = !state.mentionOpen;
      if(!state.mentionOpen) return;
      const items = referenceManager.itemsForMentionPicker?.('') || [];
      picker.innerHTML = items.map(item => `<button type="button" data-reference-mention="${escapeHtml(item.mention)}">
        ${item.thumbnailUrl ? `<img src="${escapeHtml(item.thumbnailUrl)}" alt="">` : '<span class="hstar-mention-placeholder">@</span>'}
        <span>${escapeHtml(item.mention)}</span>
      </button>`).join('');
    }

    function render(){
      ensureEntries().querySelectorAll('[data-hstar-generative-tool]').forEach(button => {
        button.disabled = false;
        button.classList.toggle('active', button.dataset.hstarGenerativeTool === state.activeTool);
      });
      const bar = ensureBar();
      if(!state.activeTool){ bar.hidden = true; return; }
      const selected = resolvedModel();
      const limits = capabilityLimits(selected.model);
      state.count = Math.min(limits.maxOutputs, Math.max(1, Number(state.count || 1)));
      if(!limits.sizes.includes(state.size)) state.size = limits.sizes[0];
      if(!limits.qualities.includes(state.quality)) state.quality = limits.qualities[0];
      const reason = disabledReason(selected, limits);
      const title = state.activeTool === 'generative-fill' ? '生成式填充' : '局部重绘';
      const bounds = selectionAvailable() ? selectionBounds() : null;
      const selectedModelText = selected.available
        ? `${selected.providerName || selected.apiConfigId} · ${selected.modelName || selected.modelId}`
        : `${selected.apiConfigId || '未配置'} · ${selected.modelId || '未选择模型'}`;
      const missingCount = Math.max(
        0,
        Number(state.lastTask?.targetCount || 0) - Number(state.lastTask?.completedCount || 0),
      );
      const canRetry = ['partial', 'failed'].includes(clean(state.lastTask?.status)) && missingCount > 0;
      bar.hidden = false;
      bar.innerHTML = `<div class="hstar-generative-head">
        <div><strong>${title}</strong><span>${bounds ? `${bounds.width} × ${bounds.height}px` : '等待选区'}</span></div>
        <button type="button" class="hstar-icon-button" data-generative-action="close" aria-label="关闭" title="关闭">×</button>
      </div>
      <div class="hstar-generative-body">
        <div class="hstar-selection-hint" data-generative-selection-hint ${selectionAvailable() ? 'hidden' : ''}>请先选择要修改的区域</div>
        ${referenceHtml()}
        <label class="hstar-generative-prompt"><span>修改要求${state.activeTool === 'local-redraw' ? ' · 支持 @ 精确引用' : ' · 可留空'}</span>
          <textarea data-generative-prompt maxlength="8000" placeholder="描述希望生成或修改的内容">${escapeHtml(state.prompt)}</textarea>
          ${mentionPickerHtml()}
        </label>
        <div class="hstar-generative-controls">
          <button type="button" class="hstar-model-button" data-generative-action="choose-api"><span>API / 模型</span><strong data-generative-model>${escapeHtml(selectedModelText)}</strong></button>
          <label><span>尺寸</span><select data-generative-size>${optionsHtml(limits.sizes, state.size)}</select></label>
          <label><span>质量</span><select data-generative-quality>${optionsHtml(limits.qualities, state.quality)}</select></label>
          <label><span>数量</span><input type="number" min="1" max="${limits.maxOutputs}" step="1" value="${state.count}" data-generative-count></label>
        </div>
        <div class="hstar-generative-foot">
          <div><span class="hstar-generative-status">${escapeHtml(statusText())}</span><small data-generative-disabled-reason>${escapeHtml(reason)}</small></div>
          <div class="hstar-generative-actions">
            <button type="button" class="btn" data-generative-action="cancel" ${['preparing', 'running'].includes(state.status) ? '' : 'disabled'}>取消</button>
            ${canRetry ? `<button type="button" class="btn" data-generative-action="retry-missing">补生成剩余 ${missingCount} 张</button>` : ''}
            <button type="button" class="btn btn-primary" data-generative-submit data-generative-action="submit" ${reason ? 'disabled' : ''}>生成 ${state.count} 张</button>
          </div>
        </div>
      </div>`;
    }

    function openTool(toolId){
      if(!TOOLS.has(toolId)) throw new Error('OpenShop 生成式功能不存在');
      state.activeTool = toolId;
      state.error = '';
      if(!selectionAvailable()){
        const current = clean(editor.state?.tool);
        if(SELECTION_TOOLS.has(current)) state.lastSelectionTool = current;
        const nextTool = SELECTION_TOOLS.has(state.lastSelectionTool) ? state.lastSelectionTool : 'marquee-rect';
        editor.setTool(nextTool);
        state.status = 'selecting';
      } else {
        state.status = 'ready';
      }
      render();
      if(toolId === 'local-redraw'){
        void referenceManager.setPrimaryMode?.(state.referenceMode).then(() => render()).catch(error => {
          state.error = clean(error?.message || error);
          render();
        });
      }
      return getState();
    }

    function close(){
      state.activeTool = '';
      state.status = 'idle';
      state.error = '';
      state.mentionOpen = false;
      state.referenceMenuOpen = false;
      render();
    }

    function validateSubmission(selected, limits){
      const reason = disabledReason(selected, limits);
      if(reason) throw new Error(reason);
    }

    async function monitorTask(task){
      const context = currentContext();
      const completed = await generativeClient.pollTask(context, task.taskId, {
        onUpdate:update => {
          upsertTaskRecord(update);
          state.lastTask = clone(update);
          state.status = 'running';
          render();
        },
      });
      upsertTaskRecord(completed);
      state.lastTask = clone(completed);
      state.status = clean(completed.status) || 'failed';
      state.error = clean(completed.error);
      await applyTaskResults(completed);
      render();
      return completed;
    }

    async function retryMissing(){
      const task = state.lastTask;
      const missing = Number(task?.targetCount || 0) - Number(task?.completedCount || 0);
      if(!['partial', 'failed'].includes(clean(task?.status)) || missing < 1) return null;
      const created = await generativeClient.retryMissing(currentContext(), task.taskId);
      const parent = created.task || created;
      upsertTaskRecord(parent);
      state.lastTask = clone(parent);
      state.status = 'running';
      render();
      return monitorTask(parent);
    }

    async function submit(){
      if(!selectionAvailable()){
        state.status = 'selecting';
        render();
        return null;
      }
      const selected = resolvedModel();
      const limits = capabilityLimits(selected.model);
      validateSubmission(selected, limits);
      state.status = 'preparing';
      state.error = '';
      render();
      try {
        const context = currentContext();
        const sourceLayerIndex = Math.max(0, Number(editor.activeLayerIdx || 0));
        const sourceLayer = editor.layers?.[sourceLayerIndex];
        if(!sourceLayer?.layerId) throw new Error('当前源图层不可用');
        const composite = await referenceManager.captureVisibleComposite();
        const mask = await referenceManager.captureSelectionMask();
        const sourceAsset = await assetApi.upload({
          dataUrl:composite.dataUrl,
          role:'ai-source',
          name:`${context.projectId}-composite.png`,
          width:composite.width,
          height:composite.height,
        });
        const maskAsset = await assetApi.upload({
          dataUrl:mask.dataUrl,
          role:'ai-mask',
          name:`${context.projectId}-mask.png`,
          width:mask.width,
          height:mask.height,
        });
        const referenceSnapshot = state.activeTool === 'local-redraw'
          ? await referenceManager.snapshotForTask({
              mode:state.referenceMode,
              maxReferences:limits.maxReferences,
              fullCompositeAsset:sourceAsset,
            })
          : {primaryReferenceAssetId:sourceAsset.assetId, references:[]};
        const bounds = selectionBounds();
        const request = {
          toolId:state.activeTool,
          sourceAssetId:sourceAsset.assetId,
          maskAssetId:maskAsset.assetId,
          primaryReferenceAssetId:referenceSnapshot.primaryReferenceAssetId,
          references:referenceSnapshot.references,
          apiConfigId:selected.apiConfigId,
          modelId:selected.modelId,
          prompt:state.prompt,
          size:state.size,
          quality:state.quality,
          targetCount:state.count,
          referenceMode:state.activeTool === 'generative-fill' ? 'full' : state.referenceMode,
          sourceLayerId:sourceLayer.layerId,
          sourceLayerIndex,
          document:{
            width:Number(editor.canvasW),
            height:Number(editor.canvasH),
            layerVersion:Number(editor.historyIdx || 0),
            visibleCompositeVersion:state.compositeVersion,
          },
          selection:{...bounds, feather:Math.max(0, Number(state.feather || 0))},
        };
        const created = await generativeClient.createTask(context, request);
        const parent = created.task || {
          taskId:clean(created.task_id), kind:'parent', status:clean(created.status) || 'queued',
          targetCount:state.count, completedCount:0, failedCount:0,
        };
        upsertTaskRecord(parent);
        state.lastTask = clone(parent);
        state.status = 'running';
        render();
        return await monitorTask(parent);
      } catch(error) {
        state.status = error?.name === 'AbortError' ? 'cancelled' : 'failed';
        state.error = clean(error?.message || error);
        render();
        throw error;
      }
    }

    async function cancelActiveTask(){
      const taskId = clean(state.lastTask?.taskId);
      if(!taskId) return null;
      const task = await generativeClient.cancelTask(currentContext(), taskId);
      upsertTaskRecord(task || {taskId, status:'cancelled'});
      state.lastTask = clone(task || {taskId, status:'cancelled'});
      state.status = 'cancelled';
      render();
      return task;
    }

    function mentionRange(textarea){
      const cursor = Math.max(0, Number(textarea.selectionStart || 0));
      const prefix = textarea.value.slice(0, cursor);
      const at = prefix.lastIndexOf('@');
      if(at < 0 || /\s/.test(prefix.slice(at + 1))) return null;
      return {start:at, end:cursor};
    }

    function handleBarInput(event){
      if(!event.target.matches?.('[data-generative-prompt]')) return;
      state.prompt = event.target.value;
      state.mentionOpen = state.activeTool === 'local-redraw' && Boolean(mentionRange(event.target));
      renderMentionPicker();
      const selected = resolvedModel();
      const limits = capabilityLimits(selected.model);
      const reason = disabledReason(selected, limits);
      const submitButton = ensureBar().querySelector('[data-generative-submit]');
      const reasonNode = ensureBar().querySelector('[data-generative-disabled-reason]');
      if(submitButton) submitButton.disabled = Boolean(reason);
      if(reasonNode) reasonNode.textContent = reason;
    }

    function handleBarChange(event){
      if(event.target.matches?.('[data-generative-count]')) state.count = Math.max(1, Number(event.target.value || 1));
      if(event.target.matches?.('[data-generative-size]')) state.size = clean(event.target.value) || 'auto';
      if(event.target.matches?.('[data-generative-quality]')) state.quality = clean(event.target.value) || 'auto';
      if(event.target.matches?.('[data-reference-local-input]')){
        const file = event.target.files?.[0];
        if(file) void referenceManager.addLocalFile?.(file).then(() => render()).catch(showError);
      }
      render();
    }

    function showError(error){
      state.error = clean(error?.message || error);
      render();
    }

    async function addReference(sourceType){
      state.referenceMenuOpen = false;
      if(sourceType === 'selection') await referenceManager.addCurrentSelection?.();
      else if(sourceType === 'layer') await referenceManager.addLayer?.(editor.layers?.[Number(editor.activeLayerIdx || 0)]);
      else if(sourceType === 'library') await openLibraryPicker();
      else if(sourceType === 'local') ensureBar().querySelector('[data-reference-local-input]')?.click();
      render();
    }

    async function responseJson(response){
      const value = await response.json().catch(() => ({}));
      if(!response.ok) throw new Error(clean(value?.detail || value?.error || '素材库读取失败'));
      return value;
    }

    async function openLibraryPicker(){
      if(typeof fetchImpl !== 'function') throw new Error('素材库接口不可用');
      const value = await responseJson(await fetchImpl('/api/asset-library', {cache:'no-store'}));
      const libraries = Array.isArray(value?.library?.libraries) ? value.library.libraries : [];
      const items = libraries.flatMap(library => (library.categories || []).flatMap(category =>
        (category.type === 'workflow' ? [] : (category.items || [])).map(item => ({
          ...item,
          libraryId:library.id,
          categoryId:category.id,
          libraryName:library.name,
          categoryName:category.name,
        })),
      )).filter(item => item.kind === 'image' || /\.(png|jpe?g|webp|gif|bmp|avif)(?:[?#]|$)/i.test(item.url || ''));
      const modal = documentRef.createElement('div');
      modal.className = 'hstar-generative-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', '选择素材库参考图');
      modal.innerHTML = `<div class="hstar-generative-modal-panel"><header><strong>素材库参考图</strong><button type="button" data-library-close aria-label="关闭">×</button></header>
        <div class="hstar-library-grid">${items.length ? items.map(item => `<button type="button" data-library-id="${escapeHtml(item.libraryId)}" data-category-id="${escapeHtml(item.categoryId)}" data-item-id="${escapeHtml(item.id)}" data-item-name="${escapeHtml(item.name)}">
          <img src="${escapeHtml(item.url)}" alt=""><span>${escapeHtml(item.name || item.categoryName)}</span>
        </button>`).join('') : '<p>素材库中暂无可用图片</p>'}</div></div>`;
      modal.addEventListener('click', async event => {
        if(event.target === modal || event.target.closest?.('[data-library-close]')){ modal.remove(); return; }
        const button = event.target.closest?.('[data-item-id]');
        if(!button) return;
        try {
          await referenceManager.addLibraryItem?.({
            libraryId:button.dataset.libraryId,
            categoryId:button.dataset.categoryId,
            itemId:button.dataset.itemId,
            name:button.dataset.itemName,
          });
          modal.remove();
          render();
        } catch(error) { showError(error); }
      });
      documentRef.body.appendChild(modal);
    }

    function openApiSelector(toolId){
      const tool = toolCatalog(toolId);
      const providers = Array.isArray(tool?.providers) ? tool.providers : [];
      const preference = preferenceFor(toolId);
      const modal = documentRef.createElement('div');
      modal.className = 'hstar-generative-modal';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', '选择 API 与模型');
      modal.innerHTML = `<div class="hstar-generative-modal-panel hstar-api-selector"><header><strong>API 与模型</strong><button type="button" data-api-close aria-label="关闭">×</button></header>
        <label><span>配置方式</span><select data-api-mode><option value="global">跟随 HstarA 全局默认</option><option value="project">本项目单独指定</option></select></label>
        <label><span>API</span><select data-api-provider>${providers.map(provider => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name || provider.id)}</option>`).join('')}</select></label>
        <label><span>模型</span><select data-api-model></select></label>
        <footer><button type="button" class="btn" data-api-close>取消</button><button type="button" class="btn btn-primary" data-api-confirm>确认</button></footer></div>`;
      const mode = modal.querySelector('[data-api-mode]');
      const provider = modal.querySelector('[data-api-provider]');
      const model = modal.querySelector('[data-api-model]');
      mode.value = preference.mode === 'project' ? 'project' : 'global';
      provider.value = clean(preference.apiConfigId) || clean(providers[0]?.id);
      function renderModels(){
        const selectedProvider = providers.find(item => clean(item.id) === provider.value) || providers[0];
        const models = Array.isArray(selectedProvider?.models) ? selectedProvider.models : [];
        model.innerHTML = models.map(item => `<option value="${escapeHtml(item.id)}">${escapeHtml(item.name || item.id)}</option>`).join('');
        model.value = clean(preference.modelId) || clean(models[0]?.id);
        const projectMode = mode.value === 'project';
        provider.disabled = !projectMode;
        model.disabled = !projectMode;
      }
      renderModels();
      provider.addEventListener('change', renderModels);
      mode.addEventListener('change', renderModels);
      modal.addEventListener('click', event => {
        if(event.target === modal || event.target.closest?.('[data-api-close]')){ modal.remove(); return; }
        if(event.target.closest?.('[data-api-confirm]')){
          setPreference(toolId, {mode:mode.value, apiConfigId:provider.value, modelId:model.value});
          modal.remove();
        }
      });
      documentRef.body.appendChild(modal);
    }

    async function handleBarClick(event){
      const action = event.target.closest?.('[data-generative-action]')?.dataset?.generativeAction;
      if(action === 'close') close();
      else if(action === 'submit') await submit();
      else if(action === 'cancel') await cancelActiveTask();
      else if(action === 'retry-missing') await retryMissing();
      else if(action === 'choose-api') openApiSelector(state.activeTool);
      else if(action === 'toggle-reference-menu'){
        state.referenceMenuOpen = !state.referenceMenuOpen;
        render();
      }
      const mode = event.target.closest?.('[data-reference-mode]')?.dataset?.referenceMode;
      if(mode){
        state.referenceMode = mode === 'selection' ? 'selection' : 'full';
        await referenceManager.setPrimaryMode?.(state.referenceMode);
        render();
      }
      const sourceType = event.target.closest?.('[data-reference-add]')?.dataset?.referenceAdd;
      if(sourceType) await addReference(sourceType).catch(showError);
      const mention = event.target.closest?.('[data-reference-mention]')?.dataset?.referenceMention;
      if(mention){
        const textarea = ensureBar().querySelector('[data-generative-prompt]');
        const range = mentionRange(textarea) || {start:textarea.selectionStart, end:textarea.selectionEnd};
        const inserted = referenceManager.insertMention(textarea.value, range.start, range.end, mention);
        state.prompt = inserted.text;
        state.mentionOpen = false;
        textarea.value = inserted.text;
        textarea.focus();
        textarea.setSelectionRange(inserted.cursor, inserted.cursor);
        renderMentionPicker();
      }
    }

    function onSelectionChanged(){
      const current = clean(editor.state?.tool);
      if(SELECTION_TOOLS.has(current)) state.lastSelectionTool = current;
      if(!state.activeTool || ['preparing', 'running'].includes(state.status)) return;
      state.status = selectionAvailable() ? 'ready' : 'selecting';
      state.error = '';
      render();
    }

    function addListener(type, handler){
      root.addEventListener?.(type, handler);
      state.listeners.push(() => root.removeEventListener?.(type, handler));
    }

    async function start(){
      if(state.started) return;
      state.started = true;
      injectStyles();
      ensureEntries();
      ensureBar();
      try { generativeClient.startSession(currentContext()); } catch(error) {}
      state.unsubscribeCatalog = aiClient.subscribe?.(() => render());
      addListener('openshop:selection-changed', onSelectionChanged);
      addListener('openshop:project-dirty', () => { state.compositeVersion += 1; });
      addListener('openshop:session-opened', () => {
        try { generativeClient.startSession(currentContext()); } catch(error) {}
      });
      addListener('openshop:session-stopped', () => generativeClient.stopSession());
      await aiClient.loadCatalog?.().catch(error => { state.error = clean(error?.message || error); });
      render();
    }

    function destroy(){
      if(state.destroyed) return;
      state.destroyed = true;
      state.listeners.splice(0).forEach(remove => remove());
      state.unsubscribeCatalog?.();
      generativeClient.stopSession?.();
      documentRef.querySelector('[data-hstar-generative-entries]')?.remove();
      documentRef.querySelector('[data-generative-operation-bar]')?.remove();
      documentRef.querySelectorAll('.hstar-generative-modal').forEach(modal => modal.remove());
    }

    function getState(){
      return clone({
        activeTool:state.activeTool,
        status:state.status,
        error:state.error,
        prompt:state.prompt,
        referenceMode:state.referenceMode,
        size:state.size,
        quality:state.quality,
        count:state.count,
        lastTask:state.lastTask,
        compositeVersion:state.compositeVersion,
      });
    }

    return Object.freeze({
      start,
      openTool,
      close,
      submit,
      cancelActiveTask,
      retryMissing,
      applyTaskResults,
      setPreference,
      getState,
      destroy,
    });
  }

  root.HstarOpenShopGenerativeTools = Object.freeze({createController});
})(window);
