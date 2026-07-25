(function bootstrapOpenShopGenerativeTools(root){
  const TOOLS = new Set(['generative-fill', 'local-redraw']);
  const SELECTION_TOOLS = new Set(['marquee-rect', 'marquee-ellipse', 'lasso', 'magic-wand', 'ai-segment']);
  const SIZE_MAP = Object.freeze({
    square:{'1k':'1024x1024', '2k':'2048x2048', '4k':'4096x4096'},
    portrait:{'1k':'1024x1536', '2k':'1360x2048', '4k':'2352x3520'},
    portrait43:{'1k':'1008x1344', '2k':'1536x2048', '4k':'2448x3264'},
    landscape43:{'1k':'1344x1008', '2k':'2048x1536', '4k':'3264x2448'},
    landscape:{'1k':'1536x1024', '2k':'2048x1360', '4k':'3520x2352'},
    story:{'1k':'720x1280', '2k':'1152x2048', '4k':'2160x3840'},
    wide:{'1k':'1280x720', '2k':'2048x1152', '4k':'3840x2160'},
    ultrawide:{'1k':'1280x544', '2k':'2048x880', '4k':'3840x1648'},
    ultratall:{'1k':'544x1280', '2k':'880x2048', '4k':'1648x3840'},
  });
  const RESOLUTION_LONG_SIDE = Object.freeze({'1k':1536, '2k':2048, '4k':3840});
  const RESOLUTION_PIXEL_LIMIT = Object.freeze({'1k':1572864, '2k':4194304, '4k':8294400});
  const RATIO_OPTIONS = Object.freeze([
    ['selection', '按选区', '按当前选区实际比例'],
    ['square', '1:1', '正方形'], ['portrait', '2:3', '竖图'],
    ['landscape', '3:2', '横图'], ['portrait43', '3:4', '竖图'],
    ['landscape43', '4:3', '横图'], ['story', '9:16', '竖屏'],
    ['wide', '16:9', '宽屏'], ['ultrawide', '21:9', '超宽'],
    ['ultratall', '9:21', '超竖'], ['source', '适配比例', '匹配选区'],
    ['custom', '自定义', '自定义比例'],
  ]);
  const QUALITY_LABELS = Object.freeze({auto:'自动质量', low:'低质量', medium:'中等质量', high:'高质量'});

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
      promptParts:[{type:'text', text:''}],
      promptRange:null,
      referenceMode:'selection',
      ratio:'selection',
      resolution:'4k',
      size:SIZE_MAP.wide['4k'],
      customRatioWidth:4,
      customRatioHeight:3,
      customWidth:2048,
      customHeight:2048,
      quality:'auto',
      count:1,
      feather:0,
      lastSelectionTool:'marquee-rect',
      lastTask:null,
      compositeVersion:0,
      mentionOpen:false,
      referenceMenuOpen:false,
      openMenu:'',
      expanded:false,
      collapsed:false,
      autoHidden:false,
      selectionActive:false,
      selectionCount:0,
      selectionRegions:[],
      feedback:'',
      feedbackTimer:0,
      unsubscribeCatalog:null,
      unregisterVoicePrompt:null,
      listeners:[],
      resumeGeneration:0,
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
      const bounds = editor._selectionDocumentBounds || editor._selectionBounds;
      return Boolean(
        editor._selectionMask
        || (bounds && Number(bounds.w ?? bounds.width) > 0 && Number(bounds.h ?? bounds.height) > 0)
      );
    }

    function selectionBounds(){
      const bounds = editor._selectionDocumentBounds || editor._selectionBounds;
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

    function sizeFor(ratio = state.ratio, resolution = state.resolution){
      if(resolution === 'auto') return 'auto';
      if(resolution === 'custom'){
        const width = Math.round(Number(state.customWidth));
        const height = Math.round(Number(state.customHeight));
        return width >= 64 && height >= 64 ? `${width}x${height}` : (state.size || 'auto');
      }
      if(ratio === 'selection' || ratio === 'source' || ratio === 'custom'){
        let ratioNumber = 0;
        if(ratio === 'selection' || ratio === 'source'){
          const bounds = editor._selectionDocumentBounds || editor._selectionBounds;
          const width = Number(bounds?.w ?? bounds?.width ?? editor.canvasW);
          const height = Number(bounds?.h ?? bounds?.height ?? editor.canvasH);
          ratioNumber = width > 0 && height > 0 ? width / height : 1;
        } else {
          const width = Number(state.customRatioWidth);
          const height = Number(state.customRatioHeight);
          ratioNumber = width > 0 && height > 0 ? width / height : 1;
        }
        const longSide = RESOLUTION_LONG_SIDE[resolution] || 1024;
        const pixelLimit = RESOLUTION_PIXEL_LIMIT[resolution] || longSide * longSide;
        const rawWidth = ratioNumber >= 1 ? longSide : longSide * ratioNumber;
        const rawHeight = ratioNumber >= 1 ? longSide / ratioNumber : longSide;
        const pixelScale = Math.min(1, Math.sqrt(pixelLimit / (rawWidth * rawHeight)));
        const width = Math.max(64, Math.floor((rawWidth * pixelScale) / 16) * 16);
        const height = Math.max(64, Math.floor((rawHeight * pixelScale) / 16) * 16);
        return `${width}x${height}`;
      }
      return SIZE_MAP[ratio]?.[resolution] || SIZE_MAP.square['1k'];
    }

    function ratioLabel(value = state.ratio){
      return RATIO_OPTIONS.find(item => item[0] === value)?.[1] || '1:1';
    }

    function availableProviders(){
      const providers = toolCatalog(state.activeTool)?.providers;
      return (Array.isArray(providers) ? providers : []).filter(item => item?.available !== false);
    }

    function availableModels(provider){
      const models = provider?.models;
      return (Array.isArray(models) ? models : []).filter(item => item?.available !== false);
    }

    function setProvider(providerId){
      const provider = availableProviders().find(item => clean(item?.id) === clean(providerId));
      const model = availableModels(provider)[0];
      if(!provider || !model) return;
      state.openMenu = '';
      setPreference(state.activeTool, {
        mode:'project', apiConfigId:provider.id, modelId:model.id,
      });
    }

    function setModel(modelId){
      const selected = resolvedModel();
      const provider = selected.provider || availableProviders().find(item => clean(item?.id) === clean(selected.apiConfigId));
      const model = availableModels(provider).find(item => clean(item?.id) === clean(modelId));
      if(!provider || !model) return;
      state.openMenu = '';
      setPreference(state.activeTool, {
        mode:'project', apiConfigId:provider.id, modelId:model.id,
      });
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
      if(task.toolId === 'local-redraw'){
        const selection = snapshot.selection && typeof snapshot.selection === 'object'
          ? snapshot.selection
          : {};
        const snapAnchor = {
          type:'selection',
          x:Number(selection.x),
          y:Number(selection.y),
          width:Number(selection.width),
          height:Number(selection.height),
          documentWidth:Number(snapshot.document?.width || editor.canvasW),
          documentHeight:Number(snapshot.document?.height || editor.canvasH),
        };
        if(
          Object.values(snapAnchor).slice(1).every(Number.isFinite)
          && snapAnchor.x >= 0 && snapAnchor.y >= 0
          && snapAnchor.width > 0 && snapAnchor.height > 0
          && snapAnchor.documentWidth > 0 && snapAnchor.documentHeight > 0
          && snapAnchor.x + snapAnchor.width <= snapAnchor.documentWidth
          && snapAnchor.y + snapAnchor.height <= snapAnchor.documentHeight
        ) image.hstarSnapAnchor = snapAnchor;
      }
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
      const existingLink = Array.from(documentRef.querySelectorAll('link[rel~="stylesheet"][href]')).find(link => {
        try{
          return new URL(link.href, documentRef.baseURI).pathname.endsWith('/host/openshop-generative-tools.css');
        }catch(_error){
          return false;
        }
      });
      if(existingLink){
        existingLink.dataset.hstarGenerativeStyles = 'true';
        return;
      }
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
      bar.addEventListener('keydown', handlePromptKeyDown);
      bar.addEventListener('paste', handlePromptPaste);
      bar.addEventListener('pointerdown', event => {
        if(event.target.closest?.('[data-reference-mention]')) event.preventDefault();
      });
      documentRef.body.appendChild(bar);
      return bar;
    }

    function popoverAttributes(name){
      return `data-generative-popover="${name}" ${state.openMenu === name ? '' : 'hidden'}`;
    }

    function qualityNodeLabel(value){
      return ({auto:'Q auto', low:'Q low', medium:'Q med', high:'Q high'})[value] || `Q ${value}`;
    }

    function providerPopoverHtml(selected){
      return `<div class="hstar-generative-popover hstar-compact-popover" ${popoverAttributes('provider')}>
        <div class="hstar-generative-popover-title">API 平台</div>
        <div class="hstar-generative-option-list">
          ${availableProviders().map(provider => `<button type="button" class="${clean(selected.apiConfigId) === clean(provider.id) ? 'active' : ''}" data-generative-provider-option="${escapeHtml(provider.id)}"><span>${escapeHtml(provider.name || provider.id)}</span></button>`).join('') || '<div class="hstar-generative-empty-option">暂无可用 API</div>'}
        </div>
      </div>`;
    }

    function modelPopoverHtml(selected){
      const provider = selected.provider || availableProviders().find(item => clean(item?.id) === clean(selected.apiConfigId));
      const models = availableModels(provider);
      return `<div class="hstar-generative-popover hstar-compact-popover" ${popoverAttributes('model')}>
        <div class="hstar-generative-popover-title">图像模型</div>
        <div class="hstar-generative-option-list">
          ${models.map(model => `<button type="button" class="${clean(model.id) === clean(selected.modelId) ? 'active' : ''}" data-generative-model-option="${escapeHtml(model.id)}"><span>${escapeHtml(model.name || model.id)}</span></button>`).join('') || '<div class="hstar-generative-empty-option">当前 API 没有可用图像模型</div>'}
        </div>
      </div>`;
    }

    function resolutionPopoverHtml(){
      return `<div class="hstar-generative-popover hstar-select-popover hstar-resolution-popover" ${popoverAttributes('resolution')}>
        <div class="hstar-generative-popover-title">分辨率</div>
        <div class="hstar-generative-select-list">
          ${['auto', '1k', '2k', '4k', 'custom'].map(value => `<button type="button" class="${state.resolution === value ? 'active' : ''}" data-generative-size-resolution="${value}">${value === 'auto' ? '自动' : value === 'custom' ? '自定义' : value.toUpperCase()}</button>`).join('')}
        </div>
        ${state.resolution === 'custom' ? `<div class="hstar-generative-custom-fields">
          <input type="number" min="64" max="4096" step="16" value="${state.customWidth}" data-generative-custom-width data-voice-input="off" aria-label="自定义宽度">
          <span>×</span>
          <input type="number" min="64" max="4096" step="16" value="${state.customHeight}" data-generative-custom-height data-voice-input="off" aria-label="自定义高度">
          <button type="button" data-generative-action="apply-custom-resolution">应用</button>
        </div>` : ''}
      </div>`;
    }

    function ratioPopoverHtml(){
      return `<div class="hstar-generative-popover hstar-select-popover hstar-ratio-popover" ${popoverAttributes('ratio')}>
        <div class="hstar-generative-popover-title">图片比例</div>
        <div class="hstar-generative-select-list">
          ${RATIO_OPTIONS.map(([value, label]) => `<button type="button" class="${state.ratio === value ? 'active' : ''}" data-generative-size-ratio="${value}">${label}</button>`).join('')}
        </div>
        ${state.ratio === 'custom' ? `<div class="hstar-generative-custom-fields">
          <input type="number" min="1" max="100" step="1" value="${state.customRatioWidth}" data-generative-custom-ratio-width data-voice-input="off" aria-label="自定义比例宽度">
          <span>:</span>
          <input type="number" min="1" max="100" step="1" value="${state.customRatioHeight}" data-generative-custom-ratio-height data-voice-input="off" aria-label="自定义比例高度">
          <button type="button" data-generative-action="apply-custom-ratio">应用</button>
        </div>` : ''}
      </div>`;
    }

    function qualityPopoverHtml(limits){
      const values = Object.keys(QUALITY_LABELS);
      return `<div class="hstar-generative-popover hstar-compact-popover" ${popoverAttributes('quality')}>
        <div class="hstar-generative-popover-title">图片质量</div>
        <div class="hstar-generative-segment-options">
          ${values.map(value => `<button type="button" class="${state.quality === value ? 'active' : ''}" data-generative-quality-option="${value}">${escapeHtml(qualityNodeLabel(value))}</button>`).join('')}
        </div>
      </div>`;
    }

    function countPopoverHtml(limits){
      return `<div class="hstar-generative-popover hstar-count-popover" ${popoverAttributes('count')}>
        <div class="hstar-generative-popover-title">生成数量</div>
        <div class="hstar-generative-count-grid">
          ${Array.from({length:limits.maxOutputs}, (_, index) => index + 1).map(value => `<button type="button" class="${state.count === value ? 'active' : ''}" data-generative-count-option="${value}">${value}</button>`).join('')}
        </div>
      </div>`;
    }

    function disabledReason(selected, limits){
      if(!selectionAvailable()) return '请先选择要修改的区域';
      if(!selected.available || !selected.model) return '配置不可用，请重新选择 API 与模型';
      if(state.activeTool === 'local-redraw' && !clean(state.prompt)) return '局部重绘需要填写修改要求';
      if(state.count < 1 || state.count > limits.maxOutputs) return `当前模型最多生成 ${limits.maxOutputs} 张`;
      return '';
    }

    function statusText(){
      if(state.error) return state.error;
      return ({
        idle:'等待操作', selecting:'请先选择要修改的区域', ready:'',
        preparing:'正在执行中', running:'正在执行中',
        succeeded:'生成完成', partial:'部分结果生成完成', failed:'生成失败',
        cancelled:'任务已取消',
      })[state.status] || '等待操作';
    }

    function referenceByAlias(alias){
      const key = clean(alias);
      if(!key) return null;
      const references = referenceManager.list?.() || [];
      const primary = referenceManager.getPrimary?.();
      return [primary, ...references].find(item => clean(item?.alias) === key) || null;
    }

    function showReferenceDetail(alias){
      const item = referenceByAlias(alias);
      const imageUrl = clean(item?.dataUrl || item?.thumbnailUrl || item?.url);
      if(!imageUrl) return;
      documentRef.querySelector('[data-reference-detail-modal]')?.remove();
      const title = clean(item?.mention || item?.alias || '参考图详情');
      const dimensions = Number(item?.width) > 0 && Number(item?.height) > 0
        ? '<small>' + Math.round(Number(item.width)) + ' × ' + Math.round(Number(item.height)) + '</small>'
        : '';
      const modal = documentRef.createElement('div');
      modal.className = 'hstar-generative-modal hstar-reference-detail-modal';
      modal.dataset.referenceDetailModal = 'true';
      modal.setAttribute('role', 'dialog');
      modal.setAttribute('aria-label', '参考图详情');
      modal.innerHTML = '<div class="hstar-reference-detail-panel">'
        + '<header><div><strong>' + escapeHtml(title) + '</strong>' + dimensions + '</div><button type="button" data-reference-detail-close aria-label="关闭">×</button></header>'
        + '<figure><img data-reference-detail-image src="' + escapeHtml(imageUrl) + '" alt="' + escapeHtml(title) + '" style="object-fit:contain"></figure>'
        + '</div>';
      modal.addEventListener('click', event => {
        if(event.target === modal || event.target.closest?.('[data-reference-detail-close]')) modal.remove();
      });
      documentRef.body.appendChild(modal);
    }

    function referenceHtml(){
      const references = referenceManager.list?.() || [];
      const rawPrimary = referenceManager.getPrimary?.() || references[0];
      const selectionReferenceAvailable = item => (
        item?.sourceType !== 'selection' || selectionAvailable()
      );
      const visibleReferences = references.filter(selectionReferenceAvailable);
      const primary = selectionReferenceAvailable(rawPrimary) ? rawPrimary : null;
      const primaryAlias = clean(primary?.alias);
      const extraReferences = visibleReferences.filter(item => (
        item !== primary && (!primaryAlias || clean(item?.alias) !== primaryAlias)
      ));
      const referenceNumber = item => {
        if(item?.autoSelectionRegion && Number.isInteger(item.selectionRegionIndex)){
          return item.selectionRegionIndex + 1;
        }
        return Math.max(1, visibleReferences.findIndex(value => clean(value?.alias) === clean(item?.alias)) + 1);
      };
      const primaryHtml = primary?.thumbnailUrl || primary?.dataUrl
        ? `<div class="hstar-primary-reference" data-primary-reference-thumbnail data-reference-thumbnail="${escapeHtml(primary.alias)}" role="button" tabindex="0" title="点击查看参考图详情">
            <img src="${escapeHtml(primary.thumbnailUrl || primary.dataUrl)}" alt="当前主参考图"><b>${referenceNumber(primary)}</b><button type="button" class="hstar-reference-delete" data-generative-remove-reference="${escapeHtml(primary.alias)}" aria-label="删除${escapeHtml(primary.alias)}" title="删除${escapeHtml(primary.alias)}">×</button>
          </div>`
        : '';
      const thumbnails = extraReferences.map(item => `<span class="hstar-reference-thumb" title="点击查看${escapeHtml(item.mention || `@${item.alias}`)}详情" data-reference-thumbnail="${escapeHtml(item.alias)}" role="button" tabindex="0">
        ${item.thumbnailUrl || item.dataUrl ? `<img src="${escapeHtml(item.thumbnailUrl || item.dataUrl)}" alt="${escapeHtml(item.alias)}">` : '<span>图</span>'}
        <b>${referenceNumber(item)}</b>
        <button type="button" class="hstar-reference-delete" data-generative-remove-reference="${escapeHtml(item.alias)}" aria-label="删除${escapeHtml(item.alias)}" title="删除${escapeHtml(item.alias)}">×</button>
      </span>`).join('');
      return `<div class="hstar-generative-reference-row" data-generative-reference-row>
        <button type="button" class="hstar-reference-marker" aria-label="参考图位置" title="参考图位置">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z"/><circle cx="12" cy="10" r="2.5"/></svg>
        </button>
        ${primaryHtml}
        <div class="hstar-reference-strip" data-reference-strip>
          ${thumbnails}
        </div>
        <button type="button" class="hstar-reference-add" data-generative-action="toggle-reference-menu" aria-label="添加参考图" title="添加参考图">+</button>
        <div class="hstar-reference-menu" data-reference-menu ${state.referenceMenuOpen ? '' : 'hidden'}>
          <button type="button" data-reference-add="selection">当前选区</button>
          <button type="button" data-reference-add="layer">当前图层</button>
          <button type="button" data-reference-add="library">素材库</button>
          <button type="button" data-reference-add="local">本地图片</button>
        </div>
        <input type="file" accept="image/*" data-reference-local-input hidden>
      </div>`;
    }

    function referenceModeHtml(){
      if(state.activeTool !== 'local-redraw') return '';
      return `<div class="hstar-reference-mode" role="radiogroup" aria-label="参考范围">
        <button type="button" data-reference-mode="selection" aria-pressed="${state.referenceMode === 'selection'}">选择区域</button>
        <button type="button" data-reference-mode="full" aria-pressed="${state.referenceMode === 'full'}">全图</button>
      </div>`;
    }

    function mentionPickerHtml(){
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

    function promptReferenceItems(){
      return referenceManager.itemsForMentionPicker?.('') || [];
    }

    function promptTextFromParts(parts){
      return (Array.isArray(parts) ? parts : [])
        .map(part => part.type === 'mention' ? clean(part.mention) : String(part.text || ''))
        .join('')
        .slice(0, 8000);
    }

    function promptPartsHtml(parts){
      return (Array.isArray(parts) ? parts : []).map(part => {
        if(part.type !== 'mention') return escapeHtml(part.text);
        return `<span class="hstar-generative-mention-token" contenteditable="false" data-generative-mention-token="true" data-reference-key="${escapeHtml(part.referenceKey)}" data-mention="${escapeHtml(part.mention)}">${escapeHtml(part.mention)}</span>`;
      }).join('');
    }

    function promptPartsFromDom(editorNode){
      const parts = [];
      const blockTags = new Set(['DIV', 'P', 'LI', 'SECTION', 'ARTICLE', 'BLOCKQUOTE']);
      const appendText = text => {
        if(!text) return;
        const last = parts[parts.length - 1];
        if(last?.type === 'text') last.text += text;
        else parts.push({type:'text', text});
      };
      const walk = node => {
        if(node.nodeType === 3){
          appendText(node.textContent);
          return;
        }
        if(node.nodeType !== 1) return;
        if(node.matches?.('[data-generative-mention-token]')){
          parts.push({
            type:'mention',
            referenceKey:clean(node.dataset.referenceKey),
            mention:clean(node.dataset.mention || node.textContent),
          });
          return;
        }
        if(node.tagName === 'BR'){
          appendText('\n');
          return;
        }
        const isBlock = node !== editorNode && blockTags.has(node.tagName);
        if(isBlock && parts.length && !promptTextFromParts(parts).endsWith('\n')) appendText('\n');
        node.childNodes.forEach(walk);
        if(isBlock && !promptTextFromParts(parts).endsWith('\n')) appendText('\n');
      };
      editorNode.childNodes.forEach(walk);
      return parts.length ? parts : [{type:'text', text:''}];
    }

    function syncPromptFromDom(){
      const editorNode = documentRef.querySelector('[data-generative-operation-bar] [data-generative-prompt]');
      if(!editorNode) return;
      state.promptParts = promptPartsFromDom(editorNode);
      state.prompt = promptTextFromParts(state.promptParts);
    }

    function captureEditorSelection(editorNode){
      const selection = root.getSelection?.();
      let range = null;
      if(selection?.rangeCount){
        const selected = selection.getRangeAt(0);
        if(editorNode.contains(selected.commonAncestorContainer)) range = selected.cloneRange();
      }
      if(!range){
        range = documentRef.createRange();
        range.selectNodeContents(editorNode);
        range.collapse(false);
      }
      return {range, beforeHtml:editorNode.innerHTML};
    }

    function dispatchVoiceInput(editorNode, type, inputType, text, isComposing=false){
      const options = {
        bubbles:true,
        cancelable:type === 'beforeinput',
        inputType,
        data:text == null ? null : String(text),
        isComposing,
      };
      let event;
      try { event = new root.InputEvent(type, options); }
      catch(error) { event = new root.Event(type, options); }
      return editorNode.dispatchEvent(event);
    }

    function updateVoiceComposition(editorNode, transaction, text){
      if(transaction.closed || !editorNode.isConnected) return false;
      const value = String(text || '');
      if(!dispatchVoiceInput(editorNode, 'beforeinput', 'insertCompositionText', value, true)) return false;
      if(!transaction.marker){
        transaction.range.deleteContents();
        transaction.marker = documentRef.createElement('span');
        transaction.marker.dataset.voiceComposition = 'true';
        transaction.range.insertNode(transaction.marker);
      }
      transaction.marker.textContent = value;
      dispatchVoiceInput(editorNode, 'input', 'insertCompositionText', value, true);
      return true;
    }

    function commitVoiceComposition(editorNode, transaction, text){
      if(transaction.closed || !editorNode.isConnected) return false;
      if(!updateVoiceComposition(editorNode, transaction, text)) return false;
      const textNode = documentRef.createTextNode(transaction.marker?.textContent || '');
      transaction.marker?.replaceWith(textNode);
      transaction.marker = null;
      transaction.closed = true;
      state.mentionOpen = false;
      syncPromptFromDom();
      renderMentionPicker();
      const selection = root.getSelection?.();
      if(selection && textNode.isConnected){
        const range = documentRef.createRange();
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
        state.promptRange = range.cloneRange();
      }
      return true;
    }

    function cancelVoiceComposition(editorNode, transaction){
      if(transaction.closed || !editorNode.isConnected) return false;
      if(!dispatchVoiceInput(editorNode, 'beforeinput', 'deleteCompositionText', null, false)) return false;
      editorNode.innerHTML = transaction.beforeHtml;
      transaction.marker = null;
      transaction.closed = true;
      state.mentionOpen = false;
      syncPromptFromDom();
      renderMentionPicker();
      const selection = root.getSelection?.();
      if(selection){
        const range = documentRef.createRange();
        range.selectNodeContents(editorNode);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        state.promptRange = range.cloneRange();
      }
      dispatchVoiceInput(editorNode, 'input', 'deleteCompositionText', null, false);
      return true;
    }

    function beginVoiceComposition(editorNode, captured=captureEditorSelection(editorNode)){
      const transaction = {
        range:captured?.range?.cloneRange?.() || captureEditorSelection(editorNode).range,
        beforeHtml:String(captured?.beforeHtml ?? editorNode.innerHTML),
        marker:null,
        closed:false,
      };
      return {
        updateComposition:text => updateVoiceComposition(editorNode, transaction, text),
        commitComposition:text => commitVoiceComposition(editorNode, transaction, text),
        cancelComposition:() => cancelVoiceComposition(editorNode, transaction),
      };
    }

    function clearVoicePromptRegistration(){
      state.unregisterVoicePrompt?.();
      state.unregisterVoicePrompt = null;
    }

    function registerVoicePrompt(bar){
      clearVoicePromptRegistration();
      const editorNode = bar.querySelector('[data-generative-prompt]');
      if(!editorNode || typeof root.HstarVoiceInputAdapter?.register !== 'function') return;
      state.unregisterVoicePrompt = root.HstarVoiceInputAdapter.register(editorNode, {
        getSelection:() => captureEditorSelection(editorNode),
        beginComposition:selection => beginVoiceComposition(editorNode, selection),
        isTargetAvailable:() => editorNode.isConnected && !bar.hidden && Boolean(state.activeTool),
        getTargetLabel:() => state.activeTool === 'generative-fill' ? '生成式填充要求' : '局部重绘要求',
      });
    }

    function removeMentionTrigger(editorNode, range){
      if(range.startContainer?.nodeType === 3 && range.startOffset > 0){
        const value = range.startContainer.textContent || '';
        if(value[range.startOffset - 1] === '@'){
          range.setStart(range.startContainer, range.startOffset - 1);
          range.deleteContents();
          return;
        }
      }
      const walker = documentRef.createTreeWalker(editorNode, root.NodeFilter?.SHOW_TEXT || 4);
      let lastText = null;
      while(walker.nextNode()) lastText = walker.currentNode;
      if(lastText && /@$/.test(lastText.textContent || '')){
        lastText.textContent = lastText.textContent.slice(0, -1);
        range.selectNodeContents(editorNode);
        range.collapse(false);
      }
    }

    function insertMentionToken(editorNode, item){
      if(!editorNode || !item?.mention) return false;
      const selection = root.getSelection?.();
      const range = state.promptRange?.cloneRange?.() || documentRef.createRange();
      if(!state.promptRange || !editorNode.contains(range.commonAncestorContainer)){
        range.selectNodeContents(editorNode);
        range.collapse(false);
      }
      removeMentionTrigger(editorNode, range);
      const token = documentRef.createElement('span');
      token.className = 'hstar-generative-mention-token';
      token.contentEditable = 'false';
      token.setAttribute('contenteditable', 'false');
      token.dataset.generativeMentionToken = 'true';
      token.dataset.referenceKey = clean(item.referenceKey || item.assetId || item.thumbnailUrl || item.mention);
      token.dataset.mention = clean(item.mention);
      token.textContent = clean(item.mention);
      range.insertNode(token);
      const spacer = documentRef.createTextNode(' ');
      token.after(spacer);
      range.setStartAfter(spacer);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      state.promptRange = range.cloneRange();
      state.mentionOpen = false;
      syncPromptFromDom();
      renderMentionPicker();
      editorNode.focus();
      return true;
    }

    function mentionTokenNearRange(range, direction){
      let candidate = null;
      const container = range.startContainer;
      const offset = range.startOffset;
      if(container?.nodeType === 3){
        if(direction < 0 && offset === 0) candidate = container.previousSibling;
        if(direction > 0 && offset === (container.textContent || '').length) candidate = container.nextSibling;
      } else if(container?.nodeType === 1){
        candidate = direction < 0 ? container.childNodes[offset - 1] : container.childNodes[offset];
      }
      if(candidate?.nodeType === 3 && !(candidate.textContent || '').trim()){
        candidate = direction < 0 ? candidate.previousSibling : candidate.nextSibling;
      }
      return candidate?.matches?.('[data-generative-mention-token]') ? candidate : null;
    }

    function handlePromptKeyDown(event){
      const editorNode = event.target.closest?.('[data-generative-prompt]');
      if(!editorNode || !['Backspace', 'Delete'].includes(event.key)) return;
      const selection = root.getSelection?.();
      if(!selection?.rangeCount) return;
      const range = selection.getRangeAt(0);
      if(!range.collapsed || !editorNode.contains(range.commonAncestorContainer)) return;
      const token = mentionTokenNearRange(range, event.key === 'Backspace' ? -1 : 1);
      if(!token) return;
      event.preventDefault();
      const spacer = event.key === 'Backspace' ? token.nextSibling : token.previousSibling;
      token.remove();
      if(spacer?.nodeType === 3 && !(spacer.textContent || '').trim()) spacer.remove();
      syncPromptFromDom();
      state.mentionOpen = false;
      renderMentionPicker();
    }

    function handlePromptPaste(event){
      const editorNode = event.target.closest?.('[data-generative-prompt]');
      if(!editorNode) return;
      event.preventDefault();
      const text = String(event.clipboardData?.getData('text/plain') || '').slice(0, 8000);
      const selection = root.getSelection?.();
      const range = selection?.rangeCount ? selection.getRangeAt(0) : documentRef.createRange();
      if(!selection?.rangeCount || !editorNode.contains(range.commonAncestorContainer)){
        range.selectNodeContents(editorNode);
        range.collapse(false);
      }
      range.deleteContents();
      const textNode = documentRef.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection?.removeAllRanges();
      selection?.addRange(range);
      state.promptRange = range.cloneRange();
      syncPromptFromDom();
    }

    function reconcilePromptReferences(items=promptReferenceItems()){
      const references = new Map(items.map(item => [clean(item.referenceKey), item]));
      state.promptParts = (state.promptParts || []).flatMap(part => {
        if(part.type !== 'mention') return [part];
        const current = references.get(clean(part.referenceKey));
        return current ? [{...part, mention:clean(current.mention)}] : [];
      });
      state.prompt = promptTextFromParts(state.promptParts);
    }

    function renderSelectionMarkers(regions = state.selectionRegions){
      const area = documentRef.getElementById('canvas-area');
      if(!area) return;
      let layer = area.querySelector('[data-generative-selection-markers]');
      if(!layer){
        layer = documentRef.createElement('div');
        layer.className = 'hstar-selection-region-markers';
        layer.dataset.generativeSelectionMarkers = 'true';
        layer.setAttribute('aria-hidden', 'true');
        area.appendChild(layer);
      }
      layer.replaceChildren();
      const vpt = Array.isArray(editor.canvas?.viewportTransform) ? editor.canvas.viewportTransform : [1, 0, 0, 1, 0, 0];
      const scaleX = Number(vpt[0]) || 1;
      const scaleY = Number(vpt[3]) || scaleX;
      const offsetX = Number(vpt[4]) || 0;
      const offsetY = Number(vpt[5]) || 0;
      (Array.isArray(regions) ? regions : []).forEach((region, index) => {
        const x = Number(region?.x);
        const y = Number(region?.y);
        const width = Number(region?.w ?? region?.width);
        const height = Number(region?.h ?? region?.height);
        if(![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) return;
        const marker = documentRef.createElement('span');
        marker.className = 'hstar-selection-region-marker';
        marker.textContent = String(index + 1);
        marker.style.left = `${x * scaleX + offsetX}px`;
        marker.style.top = `${y * scaleY + offsetY}px`;
        layer.appendChild(marker);
      });
    }

    function render(){
      if(state.destroyed) return;
      ensureEntries().querySelectorAll('[data-hstar-generative-tool]').forEach(button => {
        button.disabled = false;
        button.classList.toggle('active', button.dataset.hstarGenerativeTool === state.activeTool);
      });
      const bar = ensureBar();
      if(!state.activeTool){
        clearVoicePromptRegistration();
        bar.hidden = true;
        return;
      }
      const selected = resolvedModel();
      const limits = capabilityLimits(selected.model);
      state.count = Math.min(limits.maxOutputs, Math.max(1, Number(state.count || 1)));
      state.size = sizeFor();
      if(!Object.hasOwn(QUALITY_LABELS, state.quality)) state.quality = 'auto';
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
      bar.hidden = state.selectionActive || state.autoHidden;
      const selectionSummary = bounds
        ? `${Math.max(1, Number(state.selectionCount || state.selectionRegions.length || 1))} 个选区`
        : '等待选区';
      const providerText = selected.providerName || selected.apiConfigId || '未配置 API';
      const modelText = selected.modelName || selected.modelId || '未选择模型';
      const isRunning = ['preparing', 'running'].includes(state.status);
      const primaryStatusText = isRunning ? statusText() : (state.feedback || reason || statusText());
      const secondaryReasonText = primaryStatusText === reason ? '' : reason;
      bar.classList.toggle('is-expanded', state.expanded && !state.collapsed);
      bar.classList.toggle('is-collapsed', state.collapsed);
      clearVoicePromptRegistration();
      bar.innerHTML = `<div class="hstar-generative-grab" aria-hidden="true"></div>
      <div class="hstar-generative-workbench-top" data-generative-workbench-top>
        <div class="hstar-generative-context">
          <div class="hstar-generative-mode-chip" data-generative-mode-summary>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z"/></svg>
            <strong>${title}</strong><span> · ${selectionSummary}</span>
          </div>
        </div>
        ${referenceModeHtml()}
        <button type="button" class="hstar-icon-button" data-generative-action="zoom-panel" aria-pressed="${state.collapsed ? 'true' : 'false'}" aria-label="${state.collapsed ? '恢复面板' : '缩放面板'}" title="${state.collapsed ? '恢复面板' : '缩放面板'}">
          ${state.collapsed
            ? '<svg data-panel-zoom-icon="restore" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg>'
            : '<svg data-panel-zoom-icon="shrink" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 14h6v6M20 10h-6V4M14 10l7-7M3 21l7-7"/></svg>'}
        </button>
      </div>
      ${referenceHtml()}
      <div class="hstar-generative-prompt-stage" data-generative-prompt-stage>
        <label class="hstar-generative-prompt">
          <span class="hstar-visually-hidden">修改要求${state.activeTool === 'local-redraw' ? '，支持 @ 精确引用' : '，可以留空'}</span>
          <div class="hstar-generative-prompt-editor" data-generative-prompt data-voice-input="on" data-voice-label="${state.activeTool === 'generative-fill' ? '生成式填充要求' : '局部重绘要求'}" contenteditable="true" role="textbox" aria-multiline="true" data-maxlength="8000" data-placeholder="${state.activeTool === 'local-redraw' ? '请输入修改要求，输入 @ 可引用参考图…' : '请输入提示词，输入 @ 可引用参考图，也可以留空直接运行…'}">${promptPartsHtml(state.promptParts)}</div>
          ${mentionPickerHtml()}
        </label>
        <div class="hstar-selection-hint" data-generative-selection-hint ${selectionAvailable() ? 'hidden' : ''}>请先选择要修改的区域</div>
        <div class="hstar-generative-feedback">
          <span class="hstar-generative-status${isRunning ? ' is-running' : ''}" data-generative-status>${escapeHtml(primaryStatusText)}</span>
          <small data-generative-disabled-reason>${escapeHtml(secondaryReasonText)}</small>
        </div>
      </div>
      <div class="hstar-generative-bottom">
        <div class="hstar-generative-controls">
          <div class="hstar-generative-control hstar-api-control">
            <button type="button" class="hstar-control-pill hstar-api-pill" data-generative-menu-trigger="provider" aria-expanded="${state.openMenu === 'provider'}" title="选择 API">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 8 4-8 4-8-4Z"/><path d="m4 12 8 4 8-4M4 17l8 4 8-4"/></svg>
              <span data-generative-provider>${escapeHtml(providerText)}</span><i aria-hidden="true"></i>
            </button>
            ${providerPopoverHtml(selected)}
          </div>
          <div class="hstar-generative-control hstar-model-control">
            <button type="button" class="hstar-control-pill hstar-model-pill" data-generative-menu-trigger="model" aria-expanded="${state.openMenu === 'model'}" title="选择模型">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m7 15 3-3 2 2 2-2 3 3"/></svg>
              <span data-generative-model title="${escapeHtml(selectedModelText)}">${escapeHtml(modelText)}</span><i aria-hidden="true"></i>
            </button>
            ${modelPopoverHtml(selected)}
          </div>
          <div class="hstar-generative-control hstar-resolution-control">
            <button type="button" class="hstar-control-pill" data-generative-menu-trigger="resolution" aria-expanded="${state.openMenu === 'resolution'}" title="分辨率">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M8 21H5a2 2 0 0 1-2-2v-3M16 21h3a2 2 0 0 0 2-2v-3"/></svg>
              <span>${state.resolution === 'auto' ? '自动' : state.resolution === 'custom' ? '自定义' : state.resolution.toUpperCase()}</span><i aria-hidden="true"></i>
            </button>
            ${resolutionPopoverHtml()}
          </div>
          <div class="hstar-generative-control hstar-ratio-control">
            <button type="button" class="hstar-control-pill" data-generative-menu-trigger="ratio" aria-expanded="${state.openMenu === 'ratio'}" title="图片比例">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="6" width="16" height="12" rx="1"/></svg>
              <span>${ratioLabel()}</span><i aria-hidden="true"></i>
            </button>
            ${ratioPopoverHtml()}
          </div>
          <div class="hstar-generative-control hstar-quality-control">
            <button type="button" class="hstar-control-pill hstar-quality-pill" data-generative-menu-trigger="quality" aria-expanded="${state.openMenu === 'quality'}" title="生成质量">
              <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5h16v14H4z"/><path d="M8 9h2v6H8zM14 7h2v10h-2z"/></svg>
              <span>${escapeHtml(qualityNodeLabel(state.quality))}</span><i aria-hidden="true"></i>
            </button>
            ${qualityPopoverHtml(limits)}
          </div>
        </div>
        <div class="hstar-generative-actions">
          ${isRunning ? `<button type="button" class="hstar-secondary-action" data-generative-action="cancel">取消</button>` : ''}
          ${canRetry ? `<button type="button" class="hstar-secondary-action" data-generative-action="retry-missing">补生成剩余 ${missingCount} 张</button>` : ''}
          <div class="hstar-generative-control hstar-count-control">
            <button type="button" class="hstar-count-trigger" data-generative-menu-trigger="count" aria-expanded="${state.openMenu === 'count'}" title="生成张数">${state.count}张</button>
            ${countPopoverHtml(limits)}
          </div>
          <button type="button" class="hstar-generative-run" data-generative-submit data-generative-action="submit" ${reason || isRunning ? 'disabled' : ''}>
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 1.4 4.1L17.5 8.5l-4.1 1.4L12 14l-1.4-4.1-4.1-1.4 4.1-1.4Z"/><path d="m18 14 .8 2.2L21 17l-2.2.8L18 20l-.8-2.2L15 17l2.2-.8Z"/></svg>
            <span>运行</span>
          </button>
        </div>
      </div>`;
      renderSelectionMarkers(state.selectionRegions);
      registerVoicePrompt(bar);
    }

    function openTool(toolId){
      if(!TOOLS.has(toolId)) throw new Error('OpenShop 生成式功能不存在');
      if(state.activeTool === toolId){
        close();
        return getState();
      }
      if(typeof editor.clearSelection === 'function' && selectionAvailable()){
        editor.clearSelection();
      }
      state.activeTool = toolId;
      state.error = '';
      state.expanded = false;
      state.collapsed = true;
      state.autoHidden = false;
      state.selectionActive = false;
      state.selectionCount = 0;
      state.selectionRegions = [];
      const current = clean(editor.state?.tool);
      if(SELECTION_TOOLS.has(current)) state.lastSelectionTool = current;
      const nextTool = SELECTION_TOOLS.has(state.lastSelectionTool) ? state.lastSelectionTool : 'marquee-rect';
      editor.setTool(nextTool);
      state.status = 'selecting';
      render();
      void Promise.all([
        referenceManager.syncSelectionRegions?.([]),
        referenceManager.setPrimaryMode?.(state.referenceMode),
      ])
        .then(() => {
          if(!state.destroyed && state.activeTool === toolId) render();
        })
        .catch(error => {
          if(!state.destroyed && state.activeTool === toolId) handlePrimaryReferenceError(error);
        });
      return getState();
    }

    function close(){
      if(state.activeTool && typeof editor.clearSelection === 'function' && selectionAvailable()){
        editor.clearSelection();
      }
      state.activeTool = '';
      state.status = 'idle';
      state.error = '';
      state.expanded = false;
      state.collapsed = false;
      state.autoHidden = false;
      state.selectionActive = false;
      state.selectionCount = 0;
      state.selectionRegions = [];
      state.feedback = '';
      if(state.feedbackTimer) root.clearTimeout?.(state.feedbackTimer);
      state.feedbackTimer = 0;
      state.mentionOpen = false;
      state.referenceMenuOpen = false;
      state.openMenu = '';
      render();
    }

    function validateSubmission(selected, limits){
      const reason = disabledReason(selected, limits);
      if(reason) throw new Error(reason);
    }

    function taskError(task){
      const direct = clean(task?.error);
      if(direct) return direct;
      const children = Array.isArray(task?.children) ? task.children : [];
      const failed = children.find(child => (
        ['failed', 'cancelled'].includes(clean(child?.status)) && clean(child?.error)
      ));
      return clean(failed?.error);
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
      state.lastTask = clone(completed);
      state.status = clean(completed.status) || 'failed';
      state.error = taskError(completed);
      await applyTaskResults(completed);
      upsertTaskRecord(completed);
      await runtime.requestSave?.({reason:'ai-generation'});
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
      syncPromptFromDom();
      if(!selectionAvailable()){
        state.status = 'selecting';
        render();
        return null;
      }
      const selected = resolvedModel();
      const limits = capabilityLimits(selected.model);
      validateSubmission(selected, limits);
      state.size = sizeFor();
      state.status = 'preparing';
      state.error = '';
      state.feedback = '';
      if(state.feedbackTimer) root.clearTimeout?.(state.feedbackTimer);
      state.feedbackTimer = 0;
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
        const referenceSnapshot = await referenceManager.snapshotForTask({
          mode:state.activeTool === 'local-redraw' ? state.referenceMode : 'full',
          maxReferences:limits.maxReferences,
          fullCompositeAsset:sourceAsset,
        });
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

    function textBeforePromptCaret(editorNode, caret){
      const collectContiguousText = node => {
        const chunks = [];
        let cursor = node;
        while(cursor){
          if(cursor.nodeType === 3){
            chunks.unshift(cursor.textContent || '');
            cursor = cursor.previousSibling;
            continue;
          }
          if(cursor.nodeType === 1 && !cursor.matches?.('[data-generative-mention-token]')){
            let last = cursor.lastChild;
            while(last?.lastChild) last = last.lastChild;
            if(last?.nodeType === 3){
              chunks.unshift(last.textContent || '');
              cursor = cursor.previousSibling;
              continue;
            }
          }
          break;
        }
        return chunks.join('');
      };
      if(caret.startContainer?.nodeType === 3){
        const node = caret.startContainer;
        let text = (node.textContent || '').slice(0, caret.startOffset);
        let cursor = node.previousSibling;
        while(cursor){
          if(cursor.nodeType !== 3) break;
          text = (cursor.textContent || '') + text;
          cursor = cursor.previousSibling;
        }
        return text;
      }
      if(caret.startContainer?.nodeType === 1){
        const container = caret.startContainer;
        if(!editorNode.contains(container)) return '';
        return collectContiguousText(container.childNodes[caret.startOffset - 1]);
      }
      return '';
    }

    function mentionRange(editorNode){
      const selection = root.getSelection?.();
      if(!selection?.rangeCount) return null;
      const caret = selection.getRangeAt(0);
      if(!caret.collapsed || !editorNode.contains(caret.commonAncestorContainer)) return null;
      const prefix = textBeforePromptCaret(editorNode, caret);
      const at = prefix.lastIndexOf('@');
      if(at < 0 || /\s/.test(prefix.slice(at + 1))) return null;
      state.promptRange = caret.cloneRange();
      return {query:prefix.slice(at + 1), range:state.promptRange};
    }

    function handleBarInput(event){
      if(!event.target.matches?.('[data-generative-prompt]')) return;
      syncPromptFromDom();
      state.mentionOpen = Boolean(mentionRange(event.target));
      renderMentionPicker();
      const selected = resolvedModel();
      const limits = capabilityLimits(selected.model);
      const reason = disabledReason(selected, limits);
      const submitButton = ensureBar().querySelector('[data-generative-submit]');
      const reasonNode = ensureBar().querySelector('[data-generative-disabled-reason]');
      const statusNode = ensureBar().querySelector('[data-generative-status]');
      const isRunning = ['preparing', 'running'].includes(state.status);
      const primaryStatusText = isRunning ? statusText() : (state.feedback || reason || statusText());
      if(submitButton) submitButton.disabled = Boolean(reason);
      if(statusNode){
        statusNode.textContent = primaryStatusText;
        statusNode.classList.toggle('is-running', isRunning);
      }
      if(reasonNode) reasonNode.textContent = primaryStatusText === reason ? '' : reason;
    }

    function handleBarChange(event){
      if(event.target.matches?.('[data-reference-local-input]')){
        const file = event.target.files?.[0];
        if(file) void referenceManager.addLocalFile?.(file).then(() => render()).catch(showError);
      }
    }

    function showError(error){
      state.error = clean(error?.message || error);
      render();
    }

    function handlePrimaryReferenceError(error){
      if(state.referenceMode === 'selection' && !selectionAvailable()){
        state.status = 'selecting';
        state.error = '';
        render();
        return;
      }
      showError(error);
    }

    async function addReference(sourceType){
      state.referenceMenuOpen = false;
      if(sourceType === 'selection') await referenceManager.addCurrentSelection?.();
      else if(sourceType === 'layer') await referenceManager.addLayer?.(editor.layers?.[Number(editor.activeLayerIdx || 0)]);
      else if(sourceType === 'library') await openLibraryPicker();
      else if(sourceType === 'local'){
        const input = ensureBar().querySelector('[data-reference-local-input]');
        if(input){
          input.value = '';
          input.click();
        }
        return;
      }
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

    async function handleBarClick(event){
      const promptTarget = event.target.closest?.('[data-generative-prompt]');
      if(promptTarget && !event.target.closest?.('[data-reference-mention]')){
        const wasOpen = state.mentionOpen;
        state.mentionOpen = false;
        if(wasOpen) renderMentionPicker();
        return;
      }
      const menuTrigger = event.target.closest?.('[data-generative-menu-trigger]')?.dataset?.generativeMenuTrigger;
      if(menuTrigger){
        state.openMenu = state.openMenu === menuTrigger ? '' : menuTrigger;
        state.referenceMenuOpen = false;
        render();
        return;
      }
      const providerId = event.target.closest?.('[data-generative-provider-option]')?.dataset?.generativeProviderOption;
      if(providerId){
        setProvider(providerId);
        return;
      }
      const modelId = event.target.closest?.('[data-generative-model-option]')?.dataset?.generativeModelOption;
      if(modelId){ setModel(modelId); return; }
      const ratio = event.target.closest?.('[data-generative-size-ratio]')?.dataset?.generativeSizeRatio;
      if(ratio && RATIO_OPTIONS.some(item => item[0] === ratio)){
        state.ratio = ratio;
        state.size = sizeFor();
        state.openMenu = ratio === 'custom' ? 'ratio' : '';
        render();
        return;
      }
      const resolution = event.target.closest?.('[data-generative-size-resolution]')?.dataset?.generativeSizeResolution;
      if(['auto', '1k', '2k', '4k', 'custom'].includes(resolution)){
        state.resolution = resolution;
        state.size = sizeFor();
        state.openMenu = resolution === 'custom' ? 'resolution' : '';
        render();
        return;
      }
      const quality = event.target.closest?.('[data-generative-quality-option]')?.dataset?.generativeQualityOption;
      if(Object.hasOwn(QUALITY_LABELS, quality)){
        state.quality = quality;
        state.openMenu = '';
        render();
        return;
      }
      const count = Number(event.target.closest?.('[data-generative-count-option]')?.dataset?.generativeCountOption);
      if(Number.isInteger(count) && count > 0){
        state.count = count;
        state.openMenu = '';
        render();
        return;
      }
      const removeReferenceAlias = event.target.closest?.('[data-generative-remove-reference]')?.dataset?.generativeRemoveReference;
      if(removeReferenceAlias){
        await referenceManager.removeReference?.(removeReferenceAlias);
        reconcilePromptReferences();
        render();
        return;
      }
      const referenceThumbnail = event.target.closest?.('[data-reference-thumbnail]');
      if(referenceThumbnail){
        showReferenceDetail(referenceThumbnail.dataset.referenceThumbnail);
        return;
      }
      const action = event.target.closest?.('[data-generative-action]')?.dataset?.generativeAction;
      if(action === 'close') close();
      else if(action === 'submit') await submit();
      else if(action === 'cancel') await cancelActiveTask();
      else if(action === 'retry-missing') await retryMissing();
      else if(action === 'zoom-panel'){
        state.collapsed = !state.collapsed;
        state.expanded = false;
        state.autoHidden = false;
        state.selectionActive = false;
        render();
      }
      else if(action === 'apply-custom-resolution'){
        const bar = ensureBar();
        const width = Math.round(Number(bar.querySelector('[data-generative-custom-width]')?.value));
        const height = Math.round(Number(bar.querySelector('[data-generative-custom-height]')?.value));
        if(width >= 64 && width <= 4096 && height >= 64 && height <= 4096){
          state.customWidth = width;
          state.customHeight = height;
          state.size = sizeFor();
          state.openMenu = '';
          render();
        }
      }
      else if(action === 'apply-custom-ratio'){
        const bar = ensureBar();
        const width = Math.round(Number(bar.querySelector('[data-generative-custom-ratio-width]')?.value));
        const height = Math.round(Number(bar.querySelector('[data-generative-custom-ratio-height]')?.value));
        if(width >= 1 && width <= 100 && height >= 1 && height <= 100){
          state.customRatioWidth = width;
          state.customRatioHeight = height;
          state.size = sizeFor();
          state.openMenu = '';
          render();
        }
      }
      else if(action === 'toggle-reference-menu'){
        state.openMenu = '';
        state.referenceMenuOpen = !state.referenceMenuOpen;
        render();
      }
      const mode = event.target.closest?.('[data-reference-mode]')?.dataset?.referenceMode;
      if(mode){
        state.referenceMode = mode === 'selection' ? 'selection' : 'full';
        try{
          await referenceManager.setPrimaryMode?.(state.referenceMode);
          render();
        }catch(error){
          handlePrimaryReferenceError(error);
        }
      }
      const sourceType = event.target.closest?.('[data-reference-add]')?.dataset?.referenceAdd;
      if(sourceType) await addReference(sourceType).catch(showError);
      const mention = event.target.closest?.('[data-reference-mention]')?.dataset?.referenceMention;
      if(mention){
        if(!state.mentionOpen) return;
        const editorNode = ensureBar().querySelector('[data-generative-prompt]');
        const item = promptReferenceItems().find(value => clean(value.mention) === clean(mention));
        if(item) insertMentionToken(editorNode, item);
      }
    }

    function showSelectionFeedback(){
      state.feedback = '选取添加成功';
      if(state.feedbackTimer) root.clearTimeout?.(state.feedbackTimer);
      state.feedbackTimer = root.setTimeout?.(() => {
        state.feedback = '';
        state.feedbackTimer = 0;
        if(!state.destroyed && state.activeTool) render();
      }, 1800) || 0;
    }

    function onSelectionChanged(event){
      const current = clean(editor.state?.tool);
      if(SELECTION_TOOLS.has(current)) state.lastSelectionTool = current;
      const detail = event?.detail || {};
      const regions = Array.isArray(detail.regions) ? detail.regions : null;
      state.selectionRegions = regions ? clone(regions) : clone(editor._selectionRegions || []);
      state.selectionCount = Math.max(
        0,
        Number(detail.regionCount || state.selectionRegions.length || (detail.hasSelection ? 1 : 0)),
      );
      if(detail.incomingBounds && detail.reason !== 'cleared' && detail.mode !== 'subtract'){
        showSelectionFeedback();
        editor.toast?.('选取添加成功', 'success');
      }
      if(!state.activeTool || ['preparing', 'running'].includes(state.status)) return;
      state.autoHidden = false;
      state.selectionActive = false;
      state.collapsed = false;
      state.expanded = false;
      state.status = selectionAvailable() ? 'ready' : 'selecting';
      state.error = '';
      if(['selection', 'source'].includes(state.ratio)) state.size = sizeFor();
      render();
      void referenceManager.syncSelectionRegions?.(state.selectionRegions)
        .then(() => {
          reconcilePromptReferences();
          if(state.activeTool) render();
        })
        .catch(handlePrimaryReferenceError);
    }

    function onGlobalPointerDown(event){
      if(!state.activeTool) return;
      const bar = ensureBar();
      const target = event.target;
      let changed = false;
      if(state.openMenu){
        const popover = bar.querySelector(`[data-generative-popover="${state.openMenu}"]`);
        const trigger = bar.querySelector(`[data-generative-menu-trigger="${state.openMenu}"]`);
        if(!popover?.contains(target) && !trigger?.contains(target)){
          state.openMenu = '';
          changed = true;
        }
      }
      if(state.referenceMenuOpen){
        const menu = bar.querySelector('[data-reference-menu]');
        const trigger = bar.querySelector('[data-generative-action="toggle-reference-menu"]');
        if(!menu?.contains(target) && !trigger?.contains(target)){
          state.referenceMenuOpen = false;
          changed = true;
        }
      }
      const canvasArea = documentRef.getElementById('canvas-area');
      const isDrawingSelection = Boolean(
        !bar.contains(target)
        && canvasArea?.contains(target)
        && SELECTION_TOOLS.has(clean(editor.state?.tool))
      );
      if(isDrawingSelection){
        state.selectionActive = true;
        state.expanded = false;
        state.collapsed = false;
        state.autoHidden = false;
        changed = true;
      } else if(!bar.contains(target)){
        state.expanded = false;
        state.collapsed = false;
        state.autoHidden = true;
        changed = true;
      }
      if(changed) render();
    }

    function onGlobalPointerUp(){
      if(!state.activeTool || !state.autoHidden) return;
      state.autoHidden = false;
      render();
    }

    function onGlobalKeyDown(event){
      if((event.key === 'Enter' || event.key === ' ') && event.target?.closest?.('[data-reference-thumbnail]')){
        const referenceThumbnail = event.target.closest('[data-reference-thumbnail]');
        if(referenceThumbnail){
          event.preventDefault();
          showReferenceDetail(referenceThumbnail.dataset.referenceThumbnail);
        }
        return;
      }
      const detailModal = documentRef.querySelector('[data-reference-detail-modal]');
      if(event.key === 'Escape' && detailModal){
        detailModal.remove();
        return;
      }
      if(event.key !== 'Escape' || !state.activeTool) return;
      if(state.openMenu || state.referenceMenuOpen || state.mentionOpen){
        state.openMenu = '';
        state.referenceMenuOpen = false;
        state.mentionOpen = false;
        render();
        return;
      }
    }

    async function resumePersistedTasks(){
      const generation = ++state.resumeGeneration;
      try {
        generativeClient.startSession(currentContext());
        const unfinished = taskRecords()
          .filter(record => ['queued', 'running'].includes(clean(record?.status)));
        const restored = await generativeClient.restoreTasks(unfinished, {
          onUpdate:update => {
            if(generation !== state.resumeGeneration || state.destroyed) return;
            upsertTaskRecord(update);
            state.lastTask = clone(update);
            state.status = clean(update.status) || state.status;
            render();
          },
        });
        if(generation !== state.resumeGeneration || state.destroyed) return [];
        for(const task of restored){
          upsertTaskRecord(task);
          state.lastTask = clone(task);
          state.status = clean(task.status) || state.status;
          await applyTaskResults(task);
        }
        const queued = clone(pendingResults());
        for(const item of queued){
          if(!item?.task || !item?.child) continue;
          await applyTaskResults({...item.task, children:[item.child]});
        }
        render();
        return restored;
      } catch(error) {
        if(generation !== state.resumeGeneration || error?.name === 'AbortError') return [];
        state.error = `恢复生成任务失败：${clean(error?.message || error)}`;
        render();
        return [];
      }
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
      if(typeof editor.canvas?.on === 'function'){
        const renderMarkers = () => renderSelectionMarkers(state.selectionRegions);
        editor.canvas.on('after:render', renderMarkers);
        state.listeners.push(() => editor.canvas.off?.('after:render', renderMarkers));
      }
      addListener('pointerdown', onGlobalPointerDown);
      addListener('pointerup', onGlobalPointerUp);
      addListener('pointercancel', onGlobalPointerUp);
      addListener('keydown', onGlobalKeyDown);
      addListener('openshop:project-dirty', () => { state.compositeVersion += 1; });
      addListener('openshop:session-opened', () => {
        try { generativeClient.startSession(currentContext()); } catch(error) {}
      });
      addListener('openshop:project-loaded', () => { void resumePersistedTasks(); });
      addListener('openshop:session-stopped', () => generativeClient.stopSession());
      await aiClient.loadCatalog?.().catch(error => { state.error = clean(error?.message || error); });
      state.selectionRegions = clone(editor._selectionRegions || []);
      state.selectionCount = state.selectionRegions.length || (selectionAvailable() ? 1 : 0);
      render();
    }

    function destroy(){
      if(state.destroyed) return;
      state.destroyed = true;
      state.resumeGeneration += 1;
      if(state.feedbackTimer) root.clearTimeout?.(state.feedbackTimer);
      state.feedbackTimer = 0;
      clearVoicePromptRegistration();
      state.listeners.splice(0).forEach(remove => remove());
      state.unsubscribeCatalog?.();
      generativeClient.stopSession?.();
      documentRef.querySelector('[data-hstar-generative-entries]')?.remove();
      documentRef.querySelector('[data-generative-operation-bar]')?.remove();
      documentRef.querySelector('[data-generative-selection-markers]')?.remove();
      documentRef.querySelectorAll('.hstar-generative-modal').forEach(modal => modal.remove());
    }

    function getState(){
      return clone({
        activeTool:state.activeTool,
        status:state.status,
        error:state.error,
        prompt:state.prompt,
        referenceMode:state.referenceMode,
        ratio:state.ratio,
        resolution:state.resolution,
        size:state.size,
        quality:state.quality,
        count:state.count,
        expanded:state.expanded,
        collapsed:state.collapsed,
        autoHidden:state.autoHidden,
        selectionActive:state.selectionActive,
        selectionCount:state.selectionCount,
        selectionRegions:clone(state.selectionRegions),
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
