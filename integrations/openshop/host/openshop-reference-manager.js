(function bootstrapOpenShopReferenceManager(root){
  function clean(value){
    return String(value || '').trim();
  }

  function clone(value){
    if(typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function safeName(value, fallback='参考图'){
    const name = clean(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
    return name || fallback;
  }

  async function responseJson(response, fallback){
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
    return value;
  }

  function defaultFileToDataUrl(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => reject(reader.error || new Error('本地参考图读取失败'));
      reader.readAsDataURL(file);
    });
  }

  function defaultImageLoader(url){
    return new Promise((resolve, reject) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => reject(new Error('参考图预览解码失败'));
      image.src = url;
    });
  }

  function createManager(options={}){
    const editor = options.editor;
    const runtime = options.runtime;
    const assetApi = options.assetApi;
    const documentRef = options.documentRef || root.document;
    const fetchImpl = options.fetchImpl || root.fetch?.bind(root);
    const imageLoader = options.imageLoader || defaultImageLoader;
    const fileToDataUrl = options.fileToDataUrl || defaultFileToDataUrl;
    if(!editor || !runtime || !assetApi || typeof fetchImpl !== 'function'){
      throw new Error('OpenShop 参考图管理器依赖不完整');
    }

    const state = {
      primaryMode:'full',
      primary:null,
      references:[],
      invalidAliases:[],
      thumbnailVersion:0,
      destroyed:false,
      listeners:[],
      refreshPromise:Promise.resolve(),
      selectionSyncVersion:0,
    };

    function currentContext(){
      const context = runtime.getState?.().activeSession?.context;
      if(!context?.projectId) throw new Error('OpenShop 项目会话尚未打开');
      return {...context};
    }

    function selectionBounds(){
      const bounds = editor._selectionDocumentBounds || editor._selectionBounds;
      if(!bounds) throw new Error('当前没有可用选区');
      const width = Math.max(1, Math.round(Number(bounds.w ?? bounds.width ?? 0)));
      const height = Math.max(1, Math.round(Number(bounds.h ?? bounds.height ?? 0)));
      return {
        x:Math.max(0, Math.round(Number(bounds.x || 0))),
        y:Math.max(0, Math.round(Number(bounds.y || 0))),
        width,
        height,
      };
    }

    function normalizeRegion(value={}){
      const documentWidth = Math.max(1, Math.round(Number(editor.canvasW || 1)));
      const documentHeight = Math.max(1, Math.round(Number(editor.canvasH || 1)));
      const x = Math.max(0, Math.min(documentWidth - 1, Math.round(Number(value.x || 0))));
      const y = Math.max(0, Math.min(documentHeight - 1, Math.round(Number(value.y || 0))));
      const requestedWidth = Math.max(1, Math.round(Number(value.w ?? value.width ?? 0)));
      const requestedHeight = Math.max(1, Math.round(Number(value.h ?? value.height ?? 0)));
      return {
        x,
        y,
        w:Math.min(requestedWidth, documentWidth - x),
        h:Math.min(requestedHeight, documentHeight - y),
      };
    }

    function allRecords(){
      return [state.primary, ...state.references].filter(Boolean);
    }

    function nextAlias(sourceType, excluded=null){
      const prefix = sourceType === 'selection' ? '选区' : '参考图';
      const used = new Set(
        allRecords()
          .filter(item => item !== excluded)
          .map(item => item.alias)
          .filter(Boolean),
      );
      let index = 1;
      while(used.has(`${prefix}${index}`)) index += 1;
      return `${prefix}${index}`;
    }

    function recordValue(value={}){
      const sourceType = clean(value.sourceType) || 'local';
      const alias = clean(value.alias) || nextAlias(sourceType);
      const assetId = clean(value.assetId);
      const selectionRegion = value.selectionRegion ? normalizeRegion(value.selectionRegion) : null;
      const referenceKey = clean(value.referenceKey) || (
        sourceType === 'selection' && selectionRegion
          ? `selection:${selectionRegion.x}:${selectionRegion.y}:${selectionRegion.w}:${selectionRegion.h}`
          : assetId || `${sourceType}:${alias}`
      );
      return {
        assetId,
        referenceKey,
        alias,
        mention:`@${alias}`,
        sourceType,
        order:Math.max(0, Number(value.order || 0)),
        width:Math.max(0, Number(value.width || 0)),
        height:Math.max(0, Number(value.height || 0)),
        name:safeName(value.name, alias),
        dataUrl:clean(value.dataUrl),
        thumbnailUrl:clean(value.thumbnailUrl || value.dataUrl || value.url),
        thumbnailVersion:Math.max(0, Number(value.thumbnailVersion || 0)),
        autoSelectionRegion:value.autoSelectionRegion === true,
        selectionRegionIndex:Number.isInteger(value.selectionRegionIndex)
          ? value.selectionRegionIndex
          : -1,
        selectionRegion,
        invalid:false,
      };
    }

    function persistentRecord(item, order){
      if(!item?.assetId) return null;
      return {
        assetId:item.assetId,
        referenceKey:item.referenceKey,
        alias:item.alias,
        mention:`@${item.alias}`,
        sourceType:item.sourceType,
        order,
        width:Math.max(0, Number(item.width || 0)),
        height:Math.max(0, Number(item.height || 0)),
        autoSelectionRegion:item.autoSelectionRegion === true,
        selectionRegionIndex:Number.isInteger(item.selectionRegionIndex)
          ? item.selectionRegionIndex
          : -1,
        selectionRegion:item.selectionRegion ? normalizeRegion(item.selectionRegion) : null,
      };
    }

    function persistRecords(){
      editor.__hstarAiReferenceRecords = allRecords()
        .filter(item => item?.assetId)
        .map((item, index) => persistentRecord(item, index))
        .filter(Boolean);
    }

    function markDirty(action){
      persistRecords();
      root.dispatchEvent?.(new CustomEvent('openshop:project-dirty', {detail:{action}}));
    }

    async function defaultCaptureVisibleComposite(){
      const width = Math.max(1, Math.round(Number(editor.canvasW || 1)));
      const height = Math.max(1, Math.round(Number(editor.canvasH || 1)));
      const canvas = editor.canvas;
      const capture = () => {
        const dataUrl = canvas?.toDataURL?.({
          format:'png', quality:1, left:0, top:0, width, height, multiplier:1,
        });
        if(!clean(dataUrl)) throw new Error('OpenShop 当前画面导出失败');
        return {dataUrl, width, height};
      };
      if(typeof editor._withExportCanvas === 'function'){
        return editor._withExportCanvas({opaque:false}, capture);
      }
      const viewport = Array.isArray(canvas?.viewportTransform)
        ? [...canvas.viewportTransform]
        : null;
      try {
        if(viewport) canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
        canvas?.renderAll?.();
        return capture();
      } finally {
        if(viewport) canvas.viewportTransform = viewport;
        canvas?.renderAll?.();
      }
    }

    const captureVisibleCompositeImpl = options.captureVisibleComposite || defaultCaptureVisibleComposite;

    async function defaultCaptureSelectionRegion(region, shared={}){
      const bounds = normalizeRegion(region);
      const composite = shared.composite || await captureVisibleCompositeImpl();
      const image = shared.image || await imageLoader(composite.dataUrl);
      const canvas = documentRef.createElement('canvas');
      canvas.width = bounds.w;
      canvas.height = bounds.h;
      const context = canvas.getContext('2d');
      if(!context) throw new Error('OpenShop 选区预览画布不可用');
      context.drawImage(
        image,
        bounds.x, bounds.y, bounds.w, bounds.h,
        0, 0, bounds.w, bounds.h,
      );
      return {dataUrl:canvas.toDataURL('image/png'), width:bounds.w, height:bounds.h};
    }

    async function defaultCaptureSelection(){
      return defaultCaptureSelectionRegion(selectionBounds());
    }

    const captureSelectionImpl = options.captureSelection || defaultCaptureSelection;
    const captureSelectionRegionImpl = options.captureSelectionRegion || defaultCaptureSelectionRegion;

    async function defaultCaptureLayer(layer){
      if(!layer) throw new Error('参考图层不存在');
      const active = new Set(Array.isArray(layer.objects) ? layer.objects : []);
      const objects = editor.canvas?.getObjects?.() || [];
      const snapshots = objects.map(object => ({object, visible:object.visible !== false}));
      try {
        snapshots.forEach(({object}) => {
          const visible = active.has(object) && object.name !== '__boundary__';
          if(typeof object.set === 'function') object.set({visible});
          else object.visible = visible;
        });
        editor.canvas?.renderAll?.();
        return await defaultCaptureVisibleComposite();
      } finally {
        snapshots.forEach(({object, visible}) => {
          if(typeof object.set === 'function') object.set({visible});
          else object.visible = visible;
        });
        editor.canvas?.renderAll?.();
      }
    }

    const captureLayerImpl = options.captureLayer || defaultCaptureLayer;

    function captureSelectionMask(){
      if(!editor._selectionMask && !editor._selectionBounds){
        throw new Error('当前没有可用选区');
      }
      const width = Math.max(1, Math.round(Number(editor.canvasW || 1)));
      const height = Math.max(1, Math.round(Number(editor.canvasH || 1)));
      const canvas = documentRef.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d');
      if(!context) throw new Error('OpenShop 选区蒙版画布不可用');
      context.fillStyle = '#000000';
      context.fillRect(0, 0, width, height);
      if(editor._selectionMask?.mask){
        const source = editor._selectionMask;
        const sourceWidth = Math.max(1, Number(source.w || width));
        const sourceHeight = Math.max(1, Number(source.h || height));
        const explicitSpace = ['document', 'screen'].includes(source.coordinateSpace)
          ? source.coordinateSpace
          : '';
        const coordinateSpace = explicitSpace
          || (editor._selectionMaskSpace === 'document' ? 'document' : 'screen');
        const viewport = Array.isArray(editor.canvas?.viewportTransform)
          && editor.canvas.viewportTransform.length >= 6
          ? editor.canvas.viewportTransform
          : [1, 0, 0, 1, 0, 0];
        const screenWidth = Math.max(1, Number(editor.canvas?.width || sourceWidth));
        const screenHeight = Math.max(1, Number(editor.canvas?.height || sourceHeight));
        const image = context.createImageData(width, height);
        for(let y = 0; y < height; y += 1){
          for(let x = 0; x < width; x += 1){
            let sourceX;
            let sourceY;
            if(coordinateSpace === 'document'){
              sourceX = Math.floor((x + 0.5) * sourceWidth / width);
              sourceY = Math.floor((y + 0.5) * sourceHeight / height);
            } else {
              const documentX = x + 0.5;
              const documentY = y + 0.5;
              const screenX = viewport[0] * documentX + viewport[2] * documentY + viewport[4];
              const screenY = viewport[1] * documentX + viewport[3] * documentY + viewport[5];
              sourceX = Math.floor(screenX * sourceWidth / screenWidth);
              sourceY = Math.floor(screenY * sourceHeight / screenHeight);
            }
            const selected = sourceX >= 0 && sourceY >= 0
              && sourceX < sourceWidth && sourceY < sourceHeight
              && Boolean(source.mask[sourceY * sourceWidth + sourceX]);
            const offset = (y * width + x) * 4;
            const value = selected ? 255 : 0;
            image.data[offset] = value;
            image.data[offset + 1] = value;
            image.data[offset + 2] = value;
            image.data[offset + 3] = 255;
          }
        }
        context.putImageData(image, 0, 0);
      } else {
        const bounds = selectionBounds();
        context.fillStyle = '#ffffff';
        context.fillRect(bounds.x, bounds.y, bounds.width, bounds.height);
      }
      return {dataUrl:canvas.toDataURL('image/png'), width, height};
    }

    async function refreshLegacyPrimary(){
      if(state.destroyed) return null;
      const sourceType = state.primaryMode === 'selection' ? 'selection' : 'primary';
      const captured = state.primaryMode === 'selection'
        ? await captureSelectionImpl()
        : await captureVisibleCompositeImpl();
      state.thumbnailVersion += 1;
      const alias = state.primary?.sourceType === sourceType
        ? state.primary.alias
        : nextAlias(sourceType, state.primary);
      state.primary = recordValue({
        alias,
        sourceType,
        name:state.primaryMode === 'selection' ? '主参考选区' : '主参考全图',
        dataUrl:captured.dataUrl,
        thumbnailUrl:captured.dataUrl,
        width:captured.width,
        height:captured.height,
        thumbnailVersion:state.thumbnailVersion,
      });
      return clone(state.primary);
    }

    async function syncSelectionRegions(regions=editor._selectionRegions){
      if(state.destroyed || state.primaryMode !== 'selection') return [];
      const generation = ++state.selectionSyncVersion;
      const values = Array.isArray(regions) && regions.length
        ? regions.map(normalizeRegion)
        : (editor._selectionBounds || editor._selectionDocumentBounds ? [normalizeRegion(selectionBounds())] : []);
      let captures = [];
      if(values.length){
        if(options.captureSelectionRegion){
          captures = await Promise.all(values.map(region => captureSelectionRegionImpl(region)));
        } else {
          const composite = await captureVisibleCompositeImpl();
          const image = await imageLoader(composite.dataUrl);
          captures = await Promise.all(values.map(region => (
            defaultCaptureSelectionRegion(region, {composite, image})
          )));
        }
      }
      if(state.destroyed || generation !== state.selectionSyncVersion) return [];
      const preserved = allRecords().filter(item => (
        !item.autoSelectionRegion && item.sourceType !== 'primary'
      ));
      const usedAliases = new Set(preserved.map(item => item.alias));
      let aliasIndex = 1;
      const automatic = values.map((region, index) => {
        while(usedAliases.has(`选区${aliasIndex}`)) aliasIndex += 1;
        const alias = `选区${aliasIndex}`;
        usedAliases.add(alias);
        aliasIndex += 1;
        const captured = captures[index];
        state.thumbnailVersion += 1;
        return recordValue({
          alias,
          sourceType:'selection',
          name:`选区 ${index + 1}`,
          dataUrl:captured.dataUrl,
          thumbnailUrl:captured.dataUrl,
          width:captured.width,
          height:captured.height,
          thumbnailVersion:state.thumbnailVersion,
          autoSelectionRegion:true,
          selectionRegionIndex:index,
          selectionRegion:region,
        });
      });
      const records = [...automatic, ...preserved];
      state.primary = records.shift() || null;
      state.references = records;
      return clone(automatic);
    }

    async function refreshPrimary(){
      if(state.destroyed) return null;
      if(state.primaryMode === 'selection'){
        await syncSelectionRegions(editor._selectionRegions);
        return state.primary ? clone(state.primary) : null;
      }
      const result = await refreshLegacyPrimary();
      state.references = allRecords().filter(item => item !== state.primary && !item.autoSelectionRegion);
      return result;
    }

    function schedulePrimaryRefresh(){
      state.refreshPromise = state.refreshPromise
        .catch(() => null)
        .then(() => refreshPrimary())
        .catch(() => null);
      return state.refreshPromise;
    }

    async function setPrimaryMode(mode){
      state.primaryMode = mode === 'selection' ? 'selection' : 'full';
      return refreshPrimary();
    }

    function addRecord(value){
      const record = recordValue({...value, order:state.references.length + 1});
      state.references.push(record);
      markDirty('OpenShop reference added');
      return clone(record);
    }

    async function addCurrentSelection(){
      const captured = await captureSelectionImpl();
      return addRecord({
        sourceType:'selection',
        alias:nextAlias('selection'),
        name:'选区参考',
        dataUrl:captured.dataUrl,
        width:captured.width,
        height:captured.height,
      });
    }

    async function addLayer(layer){
      const captured = await captureLayerImpl(layer);
      return addRecord({
        sourceType:'layer',
        alias:nextAlias('layer'),
        name:safeName(layer?.name, '图层参考'),
        dataUrl:captured.dataUrl,
        width:captured.width,
        height:captured.height,
      });
    }

    async function addLibraryItem(item={}){
      const context = currentContext();
      const response = await fetchImpl(
        `/api/openshop/projects/${encodeURIComponent(context.projectId)}/asset-imports`,
        {
          method:'POST',
          headers:{'Content-Type':'application/json'},
          body:JSON.stringify({
            owner:{
              canvasType:context.canvasType,
              canvasId:context.canvasId,
              nodeId:context.nodeId,
            },
            library_id:clean(item.libraryId),
            category_id:clean(item.categoryId),
            item_id:clean(item.itemId),
          }),
        },
      );
      const value = await responseJson(response, '素材库参考图导入失败');
      const asset = value.asset;
      if(!asset?.assetId) throw new Error('素材库参考图返回不完整');
      return addRecord({
        sourceType:'library',
        alias:nextAlias('library'),
        name:safeName(item.name || asset.name, '素材库参考图'),
        assetId:asset.assetId,
        thumbnailUrl:asset.url,
        width:asset.width,
        height:asset.height,
      });
    }

    async function addLocalFile(file){
      if(!file || !String(file.type || '').startsWith('image/')){
        throw new Error('请选择图片文件');
      }
      const dataUrl = await fileToDataUrl(file);
      return addRecord({
        sourceType:'local',
        alias:nextAlias('local'),
        name:safeName(file.name, '本地参考图'),
        dataUrl,
      });
    }

    async function freezeReference(item){
      if(item.assetId) return item;
      if(!item.dataUrl) throw new Error(`参考资源不可用：@${item.alias}`);
      const asset = await assetApi.upload({
        dataUrl:item.dataUrl,
        role:'ai-reference',
        name:`${item.alias}.png`,
        width:item.width,
        height:item.height,
      });
      if(!asset?.assetId) throw new Error(`参考资源上传失败：@${item.alias}`);
      item.assetId = clean(asset.assetId);
      item.thumbnailUrl = clean(asset.url || item.thumbnailUrl || item.dataUrl);
      item.width = Number(asset.width || item.width || 0);
      item.height = Number(asset.height || item.height || 0);
      return item;
    }

    const assetExists = options.assetExists || (async assetId => {
      const response = await fetchImpl(
        `/api/openshop/assets/${encodeURIComponent(assetId)}`,
        {method:'HEAD', cache:'no-store'},
      );
      return response.ok;
    });

    async function validate(){
      const invalid = [];
      for(const item of allRecords()){
        item.invalid = Boolean(item.assetId) && !(await assetExists(item.assetId));
        if(item.invalid) invalid.push(`@${item.alias}`);
      }
      state.invalidAliases = invalid;
      return invalid.length === 0;
    }

    async function snapshotForTask({
      mode=state.primaryMode,
      maxReferences=8,
      fullCompositeAsset=null,
    }={}){
      if(mode === 'full' && fullCompositeAsset?.assetId){
        if(!state.primary || state.primary.sourceType !== 'primary') await setPrimaryMode('full');
        state.primary.assetId = clean(fullCompositeAsset.assetId);
        state.primary.thumbnailUrl = clean(fullCompositeAsset.url || state.primary.thumbnailUrl);
        state.primary.width = Number(fullCompositeAsset.width || state.primary.width || editor.canvasW);
        state.primary.height = Number(fullCompositeAsset.height || state.primary.height || editor.canvasH);
      } else {
        state.primaryMode = mode === 'selection' ? 'selection' : 'full';
        await refreshPrimary();
      }
      const records = allRecords();
      const limit = Math.max(1, Number(maxReferences || 8));
      if(records.length > limit){
        throw new Error(`当前模型最多支持 ${limit} 张参考图`);
      }
      for(const item of records) await freezeReference(item);
      await validate();
      if(state.invalidAliases.length){
        throw new Error(`参考资源不可用：${state.invalidAliases.join('、')}`);
      }
      const references = records.map((item, index) => ({
        assetId:item.assetId,
        alias:item.alias,
        mention:`@${item.alias}`,
        sourceType:item.sourceType,
        order:index,
        width:Math.max(0, Number(item.width || 0)),
        height:Math.max(0, Number(item.height || 0)),
      }));
      persistRecords();
      return {
        primaryReferenceAssetId:references[0].assetId,
        references,
        mentionMap:Object.fromEntries(
          references.map(item => [item.mention, item.assetId]),
        ),
      };
    }

    function itemsForMentionPicker(query=''){
      const needle = clean(query).toLowerCase();
      return allRecords()
        .filter(item => !needle || item.alias.toLowerCase().includes(needle))
        .map(item => ({
          assetId:item.assetId,
          referenceKey:item.referenceKey || item.assetId || `${item.sourceType}:${item.alias}`,
          mention:`@${item.alias}`,
          alias:item.alias,
          sourceType:item.sourceType,
          selectionRegionIndex:item.selectionRegionIndex,
          thumbnailUrl:item.thumbnailUrl || item.dataUrl,
        }));
    }

    function insertMention(text, start, end, mention){
      const value = String(text || '');
      const from = Math.max(0, Number(start || 0));
      const to = Math.max(from, Number(end ?? from));
      const before = value.slice(0, from);
      const after = value.slice(to);
      const next = `${before}${mention} ${after}`;
      return {text:next, cursor:before.length + mention.length + 1};
    }

    function removeReference(alias){
      const normalized = clean(alias).replace(/^@/, '');
      const records = allRecords();
      const index = records.findIndex(item => item.alias === normalized);
      if(index < 0) return false;
      const [removed] = records.splice(index, 1);
      state.primary = records.shift() || null;
      state.references = records;
      if(removed.autoSelectionRegion){
        editor.removeSelectionRegion?.(removed.selectionRegionIndex);
        state.primaryMode = 'selection';
      } else if(state.primary){
        state.primaryMode = state.primary.sourceType === 'selection' ? 'selection' : 'full';
      }
      markDirty('OpenShop reference removed');
      return true;
    }

    function restore(records){
      const values = Array.isArray(records) ? records : [];
      const restored = values.map(recordValue).sort((left, right) => left.order - right.order);
      state.primary = restored[0] || null;
      state.references = restored.slice(1);
      state.primaryMode = state.primary?.sourceType === 'selection' ? 'selection' : 'full';
    }

    function addListener(type, handler){
      root.addEventListener?.(type, handler);
      state.listeners.push(() => root.removeEventListener?.(type, handler));
    }

    const dirtyHandler = () => { void schedulePrimaryRefresh(); };
    addListener('openshop:project-dirty', dirtyHandler);
    restore(editor.__hstarAiReferenceRecords);

    function destroy(){
      if(state.destroyed) return;
      state.destroyed = true;
      state.listeners.splice(0).forEach(remove => remove());
    }

    return Object.freeze({
      setPrimaryMode,
      syncSelectionRegions,
      addCurrentSelection,
      addLayer,
      addLibraryItem,
      addLocalFile,
      removeReference,
      snapshotForTask,
      validate,
      restore,
      captureVisibleComposite:() => captureVisibleCompositeImpl(),
      captureSelection:() => captureSelectionImpl(),
      captureSelectionMask,
      list:() => clone(allRecords()),
      getPrimary:() => state.primary ? clone(state.primary) : null,
      getInvalidReferences:() => [...state.invalidAliases],
      itemsForMentionPicker,
      insertMention,
      destroy,
    });
  }

  root.HstarOpenShopReferenceManager = Object.freeze({createManager});
})(window);
