(function bootstrapOpenShopProjectAdapter(root){
  const SCHEMA_VERSION = 1;
  let layerSequence = 0;

  function clean(value){
    return String(value || '').trim();
  }

  function normalizeContext(value = {}){
    const context = {
      canvasType: clean(value.canvasType),
      canvasId: clean(value.canvasId),
      nodeId: clean(value.nodeId),
      projectId: clean(value.projectId),
    };
    if(Object.values(context).some(part => !part)){
      throw new Error('OpenShop context is incomplete');
    }
    return context;
  }

  function positiveDimension(value, label){
    const number = Math.round(Number(value));
    if(!Number.isFinite(number) || number < 1){
      throw new Error(`OpenShop ${label} is invalid`);
    }
    return number;
  }

  function safeName(value, fallback){
    const name = clean(value).replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 120);
    return name || fallback;
  }

  function clone(value){
    if(typeof structuredClone === 'function') return structuredClone(value);
    return JSON.parse(JSON.stringify(value));
  }

  function createLayerId(){
    const randomId = root.crypto?.randomUUID?.();
    if(randomId) return `layer_${randomId.replaceAll('-', '_')}`;
    layerSequence += 1;
    return `layer_${Date.now().toString(36)}_${layerSequence.toString(36)}`;
  }

  function ensureLayerId(layer){
    if(!layer || typeof layer !== 'object') throw new Error('OpenShop layer is invalid');
    const objects = Array.isArray(layer.objects) ? layer.objects : [];
    const objectLayerId = objects.map(object => clean(object?.hstarLayerId)).find(Boolean);
    const layerId = clean(layer.layerId) || objectLayerId || createLayerId();
    layer.layerId = layerId;
    objects.forEach(object => {
      if(object && typeof object === 'object') object.hstarLayerId = layerId;
    });
    return layerId;
  }

  function ensureEditorLayerIds(editor){
    if(!Array.isArray(editor?.layers)) throw new Error('OpenShop editor is unavailable');
    editor.layers.forEach(ensureLayerId);
  }

  function createEmptyProject({context, width = 1920, height = 1080, now = Date.now}){
    const owner = normalizeContext(context);
    const timestamp = Number(now());
    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: owner.projectId,
      owner: {
        canvasType: owner.canvasType,
        canvasId: owner.canvasId,
        nodeId: owner.nodeId,
      },
      document: {
        width: positiveDimension(width, 'width'),
        height: positiveDimension(height, 'height'),
        resolution: 72,
        colorSpace: 'srgb',
      },
      editor: {objects: []},
      layers: [],
      sourceBindings: [],
      fontRefs: [],
      aiToolPreferences: {},
      aiReferenceRecords: [],
      aiTaskRecords: [],
      aiPendingResults: [],
      exportRecords: [],
      assetRefs: [],
      previewAssetId: '',
      autosaveVersion: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
  }

  function normalizeSource(value = {}){
    const sequence = Number(value.sequence);
    const source = {
      assetId: clean(value.assetId),
      edgeId: clean(value.edgeId),
      sourceNodeId: clean(value.sourceNodeId),
      assetVersion: clean(value.assetVersion),
      name: safeName(value.name, '来源图片'),
      url: clean(value.url),
      sequence,
      placement: value.placement === 'top' ? 'top' : 'initial-source-order',
    };
    if(!source.assetId || !source.edgeId || !source.sourceNodeId || !source.url){
      throw new Error('OpenShop source image metadata is incomplete');
    }
    if(!Number.isInteger(sequence) || sequence < 0){
      throw new Error('OpenShop source image sequence is invalid');
    }
    return source;
  }

  function defaultImageLoader(source){
    return new Promise((resolve, reject) => {
      const fabric = root.fabric;
      if(!fabric?.Image?.fromURL){
        reject(new Error('Fabric image loader is unavailable'));
        return;
      }
      fabric.Image.fromURL(source.url, image => {
        if(image) resolve(image);
        else reject(new Error('OpenShop source image could not be decoded'));
      }, {crossOrigin:'anonymous'});
    });
  }

  function blankDefaultLayer(editor){
    if(editor.layers?.length !== 1) return null;
    const layer = editor.layers[0];
    if(layer?.sourceBinding || layer?.objects?.length) return null;
    return /^Layer 0$|^图层 0$/.test(clean(layer?.name)) ? layer : null;
  }

  function createLayer(editor, source){
    const reusable = blankDefaultLayer(editor);
    const layer = reusable || {
      name: source.name,
      visible: true,
      opacity: 100,
      blend: 'source-over',
      objects: [],
    };
    if(!reusable) editor.layers.push(layer);
    layer.name = source.name;
    layer.visible = true;
    layer.locked = false;
    layer.opacity = 100;
    layer.blend = 'source-over';
    layer.objects = Array.isArray(layer.objects) ? layer.objects : [];
    ensureLayerId(layer);
    layer.sourceBinding = {
      assetId: source.assetId,
      edgeId: source.edgeId,
      sourceNodeId: source.sourceNodeId,
      assetVersion: source.assetVersion,
      sequence: source.sequence,
      state: 'bound',
    };
    return layer;
  }

  function sortInitialSourceLayers(editor){
    const sources = editor.layers
      .filter(layer => layer?.sourceBinding)
      .sort((left, right) => {
        const sequence = left.sourceBinding.sequence - right.sourceBinding.sequence;
        return sequence || clean(left.sourceBinding.edgeId).localeCompare(clean(right.sourceBinding.edgeId));
      });
    const local = editor.layers.filter(layer => !layer?.sourceBinding);
    const base = local.filter(layer => layer.objects?.some(object => object?.name === '__boundary__'));
    const editableLocal = local.filter(layer => !base.includes(layer));
    editor.layers.splice(0, editor.layers.length, ...base, ...sources, ...editableLocal);
  }

  function syncCanvasObjectOrder(editor){
    if(typeof editor.canvas?.moveTo !== 'function' || typeof editor.canvas?.getObjects !== 'function') return;
    const layerObjects = editor.layers.flatMap(layer => Array.isArray(layer.objects) ? layer.objects : []);
    const managed = new Set(layerObjects);
    const unmanaged = editor.canvas.getObjects().filter(object => !managed.has(object));
    [...unmanaged, ...layerObjects].forEach((object, index) => editor.canvas.moveTo(object, index));
  }

  function centeredCoordinate(documentSize, objectSize, origin){
    if(origin === 'center') return documentSize / 2;
    if(origin === 'right' || origin === 'bottom') return (documentSize + objectSize) / 2;
    return (documentSize - objectSize) / 2;
  }

  function centerSourceImage(editor, image){
    const scaleX = Number.isFinite(Number(image.scaleX)) ? Number(image.scaleX) : 1;
    const scaleY = Number.isFinite(Number(image.scaleY)) ? Number(image.scaleY) : 1;
    const scaledWidth = typeof image.getScaledWidth === 'function'
      ? Number(image.getScaledWidth())
      : Number(image.width) * Math.abs(scaleX);
    const scaledHeight = typeof image.getScaledHeight === 'function'
      ? Number(image.getScaledHeight())
      : Number(image.height) * Math.abs(scaleY);
    const documentWidth = Number(editor.canvasW);
    const documentHeight = Number(editor.canvasH);
    if(
      !Number.isFinite(scaledWidth) || scaledWidth <= 0
      || !Number.isFinite(scaledHeight) || scaledHeight <= 0
      || !Number.isFinite(documentWidth) || documentWidth <= 0
      || !Number.isFinite(documentHeight) || documentHeight <= 0
    ) return false;

    const placement = {
      left:centeredCoordinate(documentWidth, scaledWidth, clean(image.originX) || 'left'),
      top:centeredCoordinate(documentHeight, scaledHeight, clean(image.originY) || 'top'),
    };
    if(typeof image.set === 'function') image.set(placement);
    else Object.assign(image, placement);
    image.setCoords?.();
    return true;
  }

  function intrinsicImageSize(image){
    const elements = [image?._originalElement, image?._element].filter(Boolean);
    const width = elements.map(element => Number(element.naturalWidth || element.videoWidth || element.width || 0))
      .find(value => Number.isFinite(value) && value > 0) || Number(image?.width || 0);
    const height = elements.map(element => Number(element.naturalHeight || element.videoHeight || element.height || 0))
      .find(value => Number.isFinite(value) && value > 0) || Number(image?.height || 0);
    if(!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) return null;
    return {width:Math.round(width), height:Math.round(height)};
  }

  function resizeEditorDocument(editor, size){
    const width = positiveDimension(size?.width, 'width');
    const height = positiveDimension(size?.height, 'height');
    editor.canvasW = width;
    editor.canvasH = height;
    const boundary = editor.canvas?.getObjects?.().find(object => object?.name === '__boundary__');
    if(boundary){
      const values = {width, height};
      if(typeof boundary.set === 'function') boundary.set(values);
      else Object.assign(boundary, values);
      boundary.setCoords?.();
    }
    const dimensions = root.document?.getElementById?.('canvas-dims');
    if(dimensions) dimensions.textContent = `${width} x ${height}`;
    editor.zoomFit?.();
    editor.canvas?.renderAll?.();
    return {width, height};
  }

  function ensureDocumentBaseLayer(editor){
    const width = positiveDimension(editor.canvasW, 'width');
    const height = positiveDimension(editor.canvasH, 'height');
    let boundary = editor.canvas?.getObjects?.().find(object => object?.name === '__boundary__');
    if(!boundary && typeof editor._createCheckerBoundary === 'function'){
      boundary = editor._createCheckerBoundary(width, height);
      if(boundary) editor.canvas.add?.(boundary);
    }
    if(!boundary) throw new Error('OpenShop document artboard is unavailable');

    const boundaryValues = {
      width,
      height,
      left:0,
      top:0,
      selectable:false,
      evented:false,
    };
    if(typeof boundary.set === 'function') boundary.set(boundaryValues);
    else Object.assign(boundary, boundaryValues);
    boundary.setCoords?.();

    let layer = editor.layers.find(item => item?.objects?.includes(boundary));
    if(!layer){
      layer = blankDefaultLayer(editor) || {
        name:'Background', visible:true, locked:true, opacity:100,
        blend:'source-over', objects:[],
      };
      if(!editor.layers.includes(layer)) editor.layers.unshift(layer);
      layer.objects = [boundary];
    }
    layer.name = 'Background';
    layer.visible = true;
    layer.locked = true;
    layer.opacity = 100;
    layer.blend = 'source-over';
    ensureLayerId(layer);
    boundary.hstarLayerId = layer.layerId;

    const index = editor.layers.indexOf(layer);
    if(index > 0){
      editor.layers.splice(index, 1);
      editor.layers.unshift(layer);
    }
    editor.canvas.moveTo?.(boundary, 0);
    return layer;
  }

  function activeSourceLayers(editor){
    return editor.layers.filter(layer => (
      layer?.sourceBinding && layer.sourceBinding.state !== 'detached'
    )).sort((left, right) => (
      Number(left.sourceBinding.sequence || 0) - Number(right.sourceBinding.sequence || 0)
      || clean(left.sourceBinding.edgeId).localeCompare(clean(right.sourceBinding.edgeId))
    ));
  }

  function sourceOnlyDocument(editor){
    const sourceLayers = activeSourceLayers(editor);
    if(!sourceLayers.length) return false;
    const sourceObjects = new Set(sourceLayers.flatMap(layer => Array.isArray(layer.objects) ? layer.objects : []));
    const canvasObjects = editor.canvas?.getObjects?.() || [];
    if(canvasObjects.some(object => object?.name === '__boundary__')) return false;
    return canvasObjects.length > 0 && canvasObjects.every(object => sourceObjects.has(object));
  }

  function repairSourceOnlyDocumentSize(editor){
    if(!sourceOnlyDocument(editor)) return false;
    const sourceLayers = activeSourceLayers(editor);
    const firstImage = sourceLayers[0]?.objects?.[0];
    const size = intrinsicImageSize(firstImage);
    if(!size) return false;
    if(Number(editor.canvasW) !== size.width || Number(editor.canvasH) !== size.height){
      resizeEditorDocument(editor, size);
    }
    sourceLayers.forEach(layer => {
      const sourceImage = layer.objects.find(object => object?.hstarAssetRole === 'source')
        || layer.objects[0];
      if(sourceImage) centerSourceImage(editor, sourceImage);
    });
    ensureDocumentBaseLayer(editor);
    sortInitialSourceLayers(editor);
    syncCanvasObjectOrder(editor);
    return true;
  }

  async function queueSourceImageLayer({
    editor,
    source:sourceValue,
    imageLoader = defaultImageLoader,
    adoptDocumentSize = false,
  }){
    if(!editor?.canvas || !Array.isArray(editor.layers)){
      throw new Error('OpenShop editor is unavailable');
    }
    const source = normalizeSource(sourceValue);
    const image = await imageLoader(source);
    if(!image) throw new Error('OpenShop source image could not be decoded');
    if(adoptDocumentSize){
      const size = intrinsicImageSize(image);
      if(size) resizeEditorDocument(editor, size);
      ensureDocumentBaseLayer(editor);
    }

    const values = {
      name: source.name,
      selectable: true,
      evented: true,
      hstarAssetId: source.assetId,
      hstarAssetRole: 'source',
      hstarEdgeId: source.edgeId,
      hstarSourceNodeId: source.sourceNodeId,
    };
    if(typeof image.set === 'function') image.set(values);
    else Object.assign(image, values);
    centerSourceImage(editor, image);
    if(!image.src) image.src = source.url;

    const layer = createLayer(editor, source);
    image.hstarLayerId = layer.layerId;
    layer.objects.push(image);
    editor.canvas.add(image);
    if(source.placement === 'initial-source-order') sortInitialSourceLayers(editor);
    editor.activeLayerIdx = editor.layers.indexOf(layer);
    syncCanvasObjectOrder(editor);
    editor.canvas.renderAll?.();
    editor.updateLayersPanel?.();
    editor.saveHistory?.('Add source image layer');
    return layer;
  }

  function sourceVersion(value){
    return clean(value?.assetVersion) || clean(value?.assetId);
  }

  function clearPendingSource(layer){
    const binding = layer?.sourceBinding;
    if(!binding) return;
    binding.pendingAssetId = '';
    binding.pendingAssetVersion = '';
    delete layer.__hstarPendingSource;
  }

  function bindLayerToSource(layer, source, state = 'bound'){
    ensureLayerId(layer);
    layer.sourceBinding = {
      assetId: source.assetId,
      edgeId: source.edgeId,
      sourceNodeId: source.sourceNodeId,
      assetVersion: source.assetVersion,
      sequence: source.sequence,
      state,
      pendingAssetId: '',
      pendingAssetVersion: '',
      ignoredAssetVersion: clean(layer.sourceBinding?.ignoredAssetVersion),
    };
    return layer.sourceBinding;
  }

  function sourceLayersByEdge(editor, sources = []){
    const candidatesByEdge = new Map();
    editor.layers.forEach(layer => {
      const edgeId = clean(layer?.sourceBinding?.edgeId);
      if(!edgeId) return;
      const candidates = candidatesByEdge.get(edgeId) || [];
      candidates.push(layer);
      candidatesByEdge.set(edgeId, candidates);
    });

    const sourcesByEdge = new Map(sources.map(source => [source.edgeId, source]));
    const layersByEdge = new Map();
    const detached = [];
    candidatesByEdge.forEach((candidates, edgeId) => {
      const expectedVersion = sourceVersion(sourcesByEdge.get(edgeId));
      const newestFirst = [...candidates].reverse();
      const active = newestFirst.filter(layer => layer.sourceBinding?.state !== 'detached');
      const selected = active.find(layer => sourceVersion(layer.sourceBinding) === expectedVersion)
        || active[0]
        || newestFirst.find(layer => sourceVersion(layer.sourceBinding) === expectedVersion)
        || newestFirst[0];
      layersByEdge.set(edgeId, selected);
      candidates.forEach(layer => {
        if(layer === selected || layer.sourceBinding?.state === 'detached') return;
        layer.sourceBinding.state = 'detached';
        clearPendingSource(layer);
        detached.push(layer);
      });
    });
    return {layersByEdge, detached};
  }

  function pendingUpdateSummary(layer){
    const binding = layer.sourceBinding || {};
    return {
      layerId: layer.layerId,
      edgeId: clean(binding.edgeId),
      currentAssetId: clean(binding.assetId),
      currentAssetVersion: clean(binding.assetVersion),
      pendingAssetId: clean(binding.pendingAssetId),
      pendingAssetVersion: clean(binding.pendingAssetVersion),
    };
  }

  async function reconcileSources({editor, sources = [], imageLoader = defaultImageLoader}){
    if(!editor?.canvas || !Array.isArray(editor.layers)){
      throw new Error('OpenShop editor is unavailable');
    }
    ensureEditorLayerIds(editor);
    const normalizedSources = sources.map(normalizeSource).sort((left, right) => (
      left.sequence - right.sequence || left.edgeId.localeCompare(right.edgeId)
    ));
    const initiallyBlank = editor.layers.every(layer => (
      !layer?.sourceBinding && !(Array.isArray(layer?.objects) && layer.objects.length)
    ));
    const currentEdges = new Set(normalizedSources.map(source => source.edgeId));
    const result = {added:[], pendingUpdates:[], detached:[]};
    const indexedLayers = sourceLayersByEdge(editor, normalizedSources);
    const layersByEdge = indexedLayers.layersByEdge;
    result.detached.push(...indexedLayers.detached);

    for(const source of normalizedSources){
      const layer = layersByEdge.get(source.edgeId);
      if(!layer){
        const addedLayer = await queueSourceImageLayer({
          editor,
          source: {...source, placement:initiallyBlank ? 'initial-source-order' : 'top'},
          imageLoader,
          adoptDocumentSize:initiallyBlank && result.added.length === 0,
        });
        layersByEdge.set(source.edgeId, addedLayer);
        result.added.push(addedLayer);
        continue;
      }

      const binding = layer.sourceBinding;
      const nextVersion = sourceVersion(source);
      const currentVersion = sourceVersion(binding);
      if(nextVersion === currentVersion){
        bindLayerToSource(layer, source, 'bound');
        clearPendingSource(layer);
        continue;
      }
      if(clean(binding.ignoredAssetVersion) === nextVersion){
        binding.state = 'bound';
        binding.sequence = source.sequence;
        binding.sourceNodeId = source.sourceNodeId;
        clearPendingSource(layer);
        continue;
      }
      binding.state = 'update-available';
      binding.sequence = source.sequence;
      binding.sourceNodeId = source.sourceNodeId;
      binding.pendingAssetId = source.assetId;
      binding.pendingAssetVersion = source.assetVersion;
      layer.__hstarPendingSource = source;
      result.pendingUpdates.push(pendingUpdateSummary(layer));
    }

    editor.layers.forEach(layer => {
      const binding = layer?.sourceBinding;
      if(!binding?.edgeId || currentEdges.has(binding.edgeId)) return;
      binding.state = 'detached';
      clearPendingSource(layer);
      result.detached.push(layer);
    });
    editor.canvas.renderAll?.();
    editor.updateLayersPanel?.();
    return result;
  }

  const TRANSFORM_PROPERTIES = [
    'left', 'top', 'scaleX', 'scaleY', 'angle', 'flipX', 'flipY',
    'skewX', 'skewY', 'originX', 'originY', 'opacity', 'visible',
    'cropX', 'cropY', 'globalCompositeOperation',
  ];

  async function resolveSourceUpdate({editor, edgeId, mode, imageLoader = defaultImageLoader}){
    if(!['replace', 'add', 'ignore'].includes(mode)){
      throw new Error('OpenShop source update mode is invalid');
    }
    ensureEditorLayerIds(editor);
    const normalizedEdgeId = clean(edgeId);
    const layer = [...editor.layers].reverse().find(candidate => (
      clean(candidate?.sourceBinding?.edgeId) === normalizedEdgeId
      && candidate.sourceBinding?.state === 'update-available'
    ));
    if(!layer) throw new Error(`OpenShop source update is unavailable: ${normalizedEdgeId}`);
    const source = layer.__hstarPendingSource;
    if(!source?.url) throw new Error('OpenShop pending source image is unavailable');

    if(mode === 'ignore'){
      layer.sourceBinding.ignoredAssetVersion = sourceVersion(source);
      layer.sourceBinding.state = 'bound';
      clearPendingSource(layer);
      editor.updateLayersPanel?.();
      return layer;
    }

    if(mode === 'add'){
      layer.sourceBinding.state = 'detached';
      clearPendingSource(layer);
      return queueSourceImageLayer({
        editor,
        source: {...source, placement:'top'},
        imageLoader,
      });
    }

    const replacement = await imageLoader(source);
    if(!replacement) throw new Error('OpenShop updated source image could not be decoded');
    const objectIndex = layer.objects.findIndex(object => (
      clean(object?.hstarEdgeId) === normalizedEdgeId || clean(object?.hstarAssetId) === clean(layer.sourceBinding.assetId)
    ));
    const original = objectIndex >= 0 ? layer.objects[objectIndex] : layer.objects[0];
    const transform = {};
    TRANSFORM_PROPERTIES.forEach(property => {
      if(original?.[property] !== undefined) transform[property] = original[property];
    });
    const values = {
      ...transform,
      name: source.name,
      selectable: true,
      hstarAssetId: source.assetId,
      hstarAssetRole: 'source',
      hstarEdgeId: source.edgeId,
      hstarSourceNodeId: source.sourceNodeId,
      hstarLayerId: layer.layerId,
    };
    if(typeof replacement.set === 'function') replacement.set(values);
    Object.assign(replacement, values);
    if(!replacement.src) replacement.src = source.url;
    if(original) editor.canvas.remove?.(original);
    if(objectIndex >= 0) layer.objects.splice(objectIndex, 1, replacement);
    else layer.objects.splice(0, layer.objects.length, replacement);
    editor.canvas.add(replacement);
    bindLayerToSource(layer, source, 'bound');
    layer.name = source.name;
    clearPendingSource(layer);
    syncCanvasObjectOrder(editor);
    editor.canvas.renderAll?.();
    editor.updateLayersPanel?.();
    editor.saveHistory?.('Replace source image');
    return layer;
  }

  function imageObjectSource(object){
    if(typeof object?.getSrc === 'function'){
      const source = clean(object.getSrc());
      if(source) return source;
    }
    return clean(
      object?.src
      || object?._element?.currentSrc
      || object?._element?.src
      || object?._originalElement?.currentSrc
      || object?._originalElement?.src
    );
  }

  function fabricObjectsInOrder(editor){
    const ordered = [];
    const visited = new Set();
    function visit(object, inheritedLayerId = ''){
      if(!object || typeof object !== 'object' || visited.has(object)) return;
      visited.add(object);
      if(!clean(object.hstarLayerId) && inheritedLayerId){
        object.hstarLayerId = inheritedLayerId;
      }
      ordered.push(object);
      const children = Array.isArray(object._objects)
        ? object._objects
        : (typeof object.getObjects === 'function' ? object.getObjects() : []);
      children.forEach(child => visit(child, clean(object.hstarLayerId) || inheritedLayerId));
    }
    editor.canvas.getObjects().forEach(object => visit(object));
    return ordered;
  }

  async function persistEditorAssets({editor, assetWriter}){
    if(!editor?.canvas?.getObjects || !Array.isArray(editor.layers)){
      throw new Error('OpenShop editor is unavailable');
    }
    if(typeof assetWriter !== 'function'){
      throw new Error('OpenShop asset writer is unavailable');
    }
    ensureEditorLayerIds(editor);
    const persisted = [];
    for(const object of fabricObjectsInOrder(editor)){
      if(clean(object?.type).toLowerCase() !== 'image' || clean(object?.hstarAssetId)) continue;
      const dataUrl = imageObjectSource(object);
      if(!dataUrl){
        throw new Error(`OpenShop image cannot be externalized: ${safeName(object?.name, 'unnamed image')}`);
      }
      const role = clean(object.hstarAssetRole) || (object.hstarEdgeId ? 'source' : 'layer');
      let asset;
      try {
        asset = await assetWriter({
          dataUrl,
          role,
          name: safeName(object.name, 'OpenShop image'),
          object,
        });
      } catch(error){
        throw new Error(`OpenShop image could not be externalized: ${error?.message || error}`);
      }
      const assetId = clean(asset?.assetId);
      if(!assetId){
        throw new Error('OpenShop asset writer returned no asset id');
      }
      const values = {
        hstarAssetId: assetId,
        hstarAssetRole: clean(asset.role) || role,
      };
      if(typeof object.set === 'function') object.set(values);
      Object.assign(object, values);
      persisted.push({assetId, role:values.hstarAssetRole});
    }
    return persisted;
  }

  function externalizeAssets(value, assetRefs){
    if(Array.isArray(value)){
      value.forEach(item => externalizeAssets(item, assetRefs));
      return;
    }
    if(!value || typeof value !== 'object') return;
    const assetId = clean(value.hstarAssetId || value.assetRef);
    if(assetId){
      assetRefs.add(assetId);
      value.assetRef = assetId;
      delete value.src;
    } else if(typeof value.src === 'string' && /^(?:data:image\/|blob:)/i.test(value.src)){
      throw new Error('OpenShop project contains inline image data without an asset id');
    }
    Object.values(value).forEach(child => externalizeAssets(child, assetRefs));
  }

  function removeBoundaryPatternBytes(value){
    if(Array.isArray(value)){
      value.forEach(removeBoundaryPatternBytes);
      return;
    }
    if(!value || typeof value !== 'object') return;
    if(clean(value.name) === '__boundary__') value.fill = null;
    Object.values(value).forEach(removeBoundaryPatternBytes);
  }

  function restoreBoundaryPattern(editor){
    const boundary = editor.canvas?.getObjects?.().find(object => object?.name === '__boundary__');
    if(!boundary || typeof editor._createCheckerBoundary !== 'function') return false;
    const restored = editor._createCheckerBoundary(editor.canvasW, editor.canvasH);
    const values = {
      width:editor.canvasW,
      height:editor.canvasH,
      fill:restored?.fill || null,
      selectable:false,
      evented:false,
    };
    if(typeof boundary.set === 'function') boundary.set(values);
    else Object.assign(boundary, values);
    boundary.setCoords?.();
    return true;
  }

  function serializeSourceBinding(binding, layerId){
    if(!binding) return null;
    const sequence = Number(binding.sequence);
    return {
      layerId,
      edgeId: clean(binding.edgeId),
      sourceNodeId: clean(binding.sourceNodeId),
      assetId: clean(binding.assetId),
      assetVersion: clean(binding.assetVersion),
      sequence: Number.isInteger(sequence) && sequence >= 0 ? sequence : 0,
      state: ['bound', 'update-available', 'detached'].includes(binding.state)
        ? binding.state
        : 'bound',
      pendingAssetId: clean(binding.pendingAssetId),
      pendingAssetVersion: clean(binding.pendingAssetVersion),
      ignoredAssetVersion: clean(binding.ignoredAssetVersion),
    };
  }

  function collectAssetRefs(value, assetRefs){
    if(Array.isArray(value)){
      value.forEach(item => collectAssetRefs(item, assetRefs));
      return;
    }
    if(!value || typeof value !== 'object') return;
    const assetKeys = new Set([
      'assetId', 'assetRef', 'hstarAssetId', 'sourceAssetId', 'maskAssetId',
      'outputAssetId', 'primaryReferenceAssetId', 'pendingAssetId',
    ]);
    Object.entries(value).forEach(([key, child]) => {
      if(assetKeys.has(key)){
        const assetId = clean(child);
        if(assetId) assetRefs.add(assetId);
      }
      collectAssetRefs(child, assetRefs);
    });
  }

  function serializeProject({editor, context, now = Date.now}){
    if(!editor?.canvas?.toJSON || !Array.isArray(editor.layers)){
      throw new Error('OpenShop editor is unavailable');
    }
    const owner = normalizeContext(context);
    const timestamp = Number(now());
    const createdAt = Number(editor.__hstarProjectCreatedAt || timestamp);
    editor.__hstarProjectCreatedAt = createdAt;
    ensureEditorLayerIds(editor);
    const editorJson = clone(editor.canvas.toJSON([
      'name',
      'excludeFromExport',
      'globalCompositeOperation',
      'hstarAssetId',
      'hstarAssetRole',
      'hstarEdgeId',
      'hstarSourceNodeId',
      'hstarLayerId',
      'hstarSnapAnchor',
      'hstarKerningMode',
      'hstarOcrBlockId',
      'hstarOcrSourceLayerId',
      'hstarOcrConfidence',
      'hstarOcrLanguage',
      'hstarOcrFontCandidates',
      'assetRef',
    ]));
    removeBoundaryPatternBytes(editorJson);
    const assetRefs = new Set();
    externalizeAssets(editorJson, assetRefs);

    const layers = editor.layers.map(layer => ({
      layerId: ensureLayerId(layer),
      type: clean(layer.type) || 'normal',
      name: safeName(layer.name, '图层'),
      visible: layer.visible !== false,
      locked: Boolean(layer.locked),
      opacity: Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 100,
      blend: clean(layer.blend) || 'source-over',
      sourceBinding: serializeSourceBinding(layer.sourceBinding, layer.layerId),
      hstarAiGeneration: layer.hstarAiGeneration ? clone(layer.hstarAiGeneration) : null,
    }));
    const sourceBindings = layers
      .map((layer, layerIndex) => layer.sourceBinding ? {...layer.sourceBinding, layerIndex} : null)
      .filter(Boolean)
      .sort((left, right) => left.sequence - right.sequence);
    sourceBindings.forEach(binding => {
      if(binding.assetId) assetRefs.add(binding.assetId);
      if(binding.pendingAssetId) assetRefs.add(binding.pendingAssetId);
    });
    const previewAssetId = clean(editor.__hstarPreviewAssetId);
    if(previewAssetId) assetRefs.add(previewAssetId);
    const fontRefs = clone(Array.isArray(editor.__hstarFontRefs) ? editor.__hstarFontRefs : []);
    const aiToolPreferences = clone(
      editor.__hstarAiToolPreferences && typeof editor.__hstarAiToolPreferences === 'object'
        ? editor.__hstarAiToolPreferences
        : {}
    );
    const aiReferenceRecords = clone(
      Array.isArray(editor.__hstarAiReferenceRecords) ? editor.__hstarAiReferenceRecords : []
    );
    const aiTaskRecords = clone(
      Array.isArray(editor.__hstarAiTaskRecords) ? editor.__hstarAiTaskRecords.slice(-100) : []
    );
    const aiPendingResults = clone(
      Array.isArray(editor.__hstarAiPendingResults) ? editor.__hstarAiPendingResults.slice(-64) : []
    );
    const exportRecords = clone(
      Array.isArray(editor.__hstarExportRecords) ? editor.__hstarExportRecords.slice(-256) : []
    );
    collectAssetRefs(aiReferenceRecords, assetRefs);
    collectAssetRefs(aiTaskRecords, assetRefs);
    collectAssetRefs(aiPendingResults, assetRefs);
    collectAssetRefs(exportRecords, assetRefs);
    collectAssetRefs(layers, assetRefs);

    return {
      schemaVersion: SCHEMA_VERSION,
      projectId: owner.projectId,
      owner: {
        canvasType: owner.canvasType,
        canvasId: owner.canvasId,
        nodeId: owner.nodeId,
      },
      document: {
        width: positiveDimension(editor.canvasW, 'width'),
        height: positiveDimension(editor.canvasH, 'height'),
        resolution: 72,
        colorSpace: 'srgb',
      },
      editor: editorJson,
      layers,
      sourceBindings,
      fontRefs,
      aiToolPreferences,
      aiReferenceRecords,
      aiTaskRecords,
      aiPendingResults,
      exportRecords,
      assetRefs: [...assetRefs].sort(),
      previewAssetId,
      autosaveVersion: Number(editor.__hstarAutosaveVersion || 0),
      createdAt,
      updatedAt: timestamp,
    };
  }

  function recordExport({editor, output, now = Date.now}){
    if(!editor || !output?.assetId) throw new Error('OpenShop export metadata is incomplete');
    const assetId = clean(output.assetId);
    const record = {
      assetId,
      name:safeName(output.name, 'OpenShop output.png'),
      width:positiveDimension(editor.canvasW, 'width'),
      height:positiveDimension(editor.canvasH, 'height'),
      createdAt:Number(now()),
    };
    const records = Array.isArray(editor.__hstarExportRecords) ? editor.__hstarExportRecords : [];
    editor.__hstarExportRecords = [
      ...records.filter(item => clean(item?.assetId) !== assetId),
      record,
    ].slice(-256);
    return clone(record);
  }

  async function hydrateAssets(value, assetResolver){
    if(Array.isArray(value)){
      await Promise.all(value.map(item => hydrateAssets(item, assetResolver)));
      return;
    }
    if(!value || typeof value !== 'object') return;
    if(value.assetRef){
      if(typeof assetResolver !== 'function') throw new Error('OpenShop asset resolver is unavailable');
      value.src = await assetResolver(clean(value.assetRef));
      if(!value.src) throw new Error(`OpenShop asset is unavailable: ${clean(value.assetRef)}`);
    }
    await Promise.all(Object.values(value).map(child => hydrateAssets(child, assetResolver)));
  }

  function applyLayerMetadata(layer, metadata, index){
    const metadataLayerId = clean(metadata?.layerId);
    if(metadataLayerId) layer.layerId = metadataLayerId;
    ensureLayerId(layer);
    layer.type = clean(metadata?.type) || clean(layer.type) || 'normal';
    layer.name = safeName(metadata?.name, `Layer ${index}`);
    layer.visible = metadata?.visible !== false;
    layer.locked = Boolean(metadata?.locked);
    if(layer.locked){
      layer.objects.forEach(object => {
        if(!object || object.name === '__boundary__') return;
        object.selectable = false;
        object.evented = false;
      });
    }
    layer.opacity = Number(metadata?.opacity ?? 100);
    layer.blend = clean(metadata?.blend) || 'source-over';
    layer.sourceBinding = metadata?.sourceBinding ? clone(metadata.sourceBinding) : null;
    layer.hstarAiGeneration = metadata?.hstarAiGeneration ? clone(metadata.hstarAiGeneration) : null;
    return layer;
  }

  function restoreProjectLayers(editor, metadataLayers){
    if(!Array.isArray(metadataLayers) || metadataLayers.length === 0){
      ensureEditorLayerIds(editor);
      return;
    }

    const runtimeLayers = [...editor.layers];
    const identifiedRuntimeLayers = new Set(runtimeLayers.filter(layer => clean(layer?.layerId)));
    runtimeLayers.forEach(layer => {
      layer.objects = Array.isArray(layer.objects) ? layer.objects : [];
      ensureLayerId(layer);
    });

    const runtimeLayersById = new Map();
    runtimeLayers.forEach(layer => {
      const layerId = clean(layer.layerId);
      const candidates = runtimeLayersById.get(layerId) || [];
      candidates.push(layer);
      runtimeLayersById.set(layerId, candidates);
    });
    const matchedRuntimeLayers = new Set();
    const orderedLayers = new Array(metadataLayers.length);

    metadataLayers.forEach((metadata, index) => {
      const layerId = clean(metadata?.layerId);
      if(!layerId) return;
      const layer = runtimeLayersById.get(layerId)?.find(candidate => !matchedRuntimeLayers.has(candidate));
      if(!layer) return;
      matchedRuntimeLayers.add(layer);
      orderedLayers[index] = layer;
    });

    metadataLayers.forEach((metadata, index) => {
      if(orderedLayers[index]) return;
      const layerId = clean(metadata?.layerId);
      let layer = null;
      if(!layerId){
        const indexedLayer = runtimeLayers[index];
        layer = indexedLayer && !matchedRuntimeLayers.has(indexedLayer)
          ? indexedLayer
          : runtimeLayers.find(candidate => (
            candidate.objects.length && !matchedRuntimeLayers.has(candidate)
          ));
      }
      if(layer) matchedRuntimeLayers.add(layer);
      orderedLayers[index] = layer || {objects:[]};
    });

    orderedLayers.forEach((layer, index) => {
      applyLayerMetadata(layer, metadataLayers[index], index);
    });
    const unmatchedRuntimeLayers = runtimeLayers.filter(layer => (
      !matchedRuntimeLayers.has(layer)
      && (layer.objects.length > 0 || identifiedRuntimeLayers.has(layer))
    ));
    editor.layers = [...orderedLayers, ...unmatchedRuntimeLayers];
    ensureEditorLayerIds(editor);
  }

  async function restoreProject({
    editor,
    project:projectValue,
    assetResolver,
    generativeClient=null,
    applyTaskResults=null,
  }){
    const project = clone(projectValue);
    if(project?.schemaVersion !== SCHEMA_VERSION) throw new Error('OpenShop project version is unsupported');
    if(!editor?.canvas?.loadFromJSON) throw new Error('OpenShop editor is unavailable');
    const context = normalizeContext({...project.owner, projectId:project.projectId});
    await hydrateAssets(project.editor, assetResolver);

    editor.canvasW = positiveDimension(project.document?.width, 'width');
    editor.canvasH = positiveDimension(project.document?.height, 'height');
    editor.__hstarProjectCreatedAt = Number(project.createdAt || Date.now());
    editor.__hstarPreviewAssetId = clean(project.previewAssetId);
    editor.__hstarAutosaveVersion = Number(project.autosaveVersion || 0);
    editor.__hstarFontRefs = clone(Array.isArray(project.fontRefs) ? project.fontRefs : []);
    editor.__hstarAiToolPreferences = clone(
      project.aiToolPreferences && typeof project.aiToolPreferences === 'object'
        ? project.aiToolPreferences
        : {}
    );
    editor.__hstarAiReferenceRecords = clone(
      Array.isArray(project.aiReferenceRecords) ? project.aiReferenceRecords : []
    );
    editor.__hstarAiTaskRecords = clone(
      Array.isArray(project.aiTaskRecords) ? project.aiTaskRecords.slice(-100) : []
    );
    editor.__hstarAiPendingResults = clone(
      Array.isArray(project.aiPendingResults) ? project.aiPendingResults.slice(-64) : []
    );
    editor.__hstarExportRecords = clone(
      Array.isArray(project.exportRecords) ? project.exportRecords.slice(-256) : []
    );
    await new Promise((resolve, reject) => {
      try {
        const result = editor.canvas.loadFromJSON(project.editor, () => resolve());
        if(result && typeof result.then === 'function') result.then(resolve, reject);
      } catch(error) {
        reject(error);
      }
    });
    restoreBoundaryPattern(editor);
    editor.rebuildLayersFromCanvas?.();
    restoreProjectLayers(editor, project.layers);
    repairSourceOnlyDocumentSize(editor);
    editor.canvas.renderAll?.();
    editor.updateLayersPanel?.();
    if(generativeClient?.restoreTasks){
      const unfinished = editor.__hstarAiTaskRecords
        .filter(record => ['queued', 'running'].includes(clean(record?.status)));
      const restoredTasks = await generativeClient.restoreTasks(unfinished, {
        onUpdate:update => {
          const index = editor.__hstarAiTaskRecords.findIndex(record => record.taskId === update.taskId);
          if(index >= 0) editor.__hstarAiTaskRecords[index] = clone(update);
          else editor.__hstarAiTaskRecords.push(clone(update));
          editor.__hstarAiTaskRecords = editor.__hstarAiTaskRecords.slice(-100);
        },
      });
      if(typeof applyTaskResults === 'function'){
        for(const task of restoredTasks) await applyTaskResults(task);
      }
    }
    if(typeof applyTaskResults === 'function'){
      const queued = clone(editor.__hstarAiPendingResults);
      for(const item of queued){
        if(!item?.task || !item?.child) continue;
        await applyTaskResults({...item.task, children:[item.child]});
      }
    }
    return {context, project};
  }

  root.HstarOpenShopProjectAdapter = Object.freeze({
    SCHEMA_VERSION,
    createEmptyProject,
    serializeProject,
    recordExport,
    restoreProject,
    queueSourceImageLayer,
    persistEditorAssets,
    reconcileSources,
    resolveSourceUpdate,
  });
})(window);
