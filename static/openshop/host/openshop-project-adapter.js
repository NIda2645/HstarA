(function bootstrapOpenShopProjectAdapter(root){
  const SCHEMA_VERSION = 1;

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
      assetRefs: [],
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
    layer.opacity = 100;
    layer.blend = 'source-over';
    layer.objects = Array.isArray(layer.objects) ? layer.objects : [];
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
    editor.layers.splice(0, editor.layers.length, ...sources, ...local);
  }

  function syncCanvasObjectOrder(editor){
    if(typeof editor.canvas?.moveTo !== 'function' || typeof editor.canvas?.getObjects !== 'function') return;
    const layerObjects = editor.layers.flatMap(layer => Array.isArray(layer.objects) ? layer.objects : []);
    const managed = new Set(layerObjects);
    const unmanaged = editor.canvas.getObjects().filter(object => !managed.has(object));
    [...unmanaged, ...layerObjects].forEach((object, index) => editor.canvas.moveTo(object, index));
  }

  async function queueSourceImageLayer({editor, source:sourceValue, imageLoader = defaultImageLoader}){
    if(!editor?.canvas || !Array.isArray(editor.layers)){
      throw new Error('OpenShop editor is unavailable');
    }
    const source = normalizeSource(sourceValue);
    const image = await imageLoader(source);
    if(!image) throw new Error('OpenShop source image could not be decoded');

    const values = {
      name: source.name,
      selectable: true,
      hstarAssetId: source.assetId,
      hstarEdgeId: source.edgeId,
      hstarSourceNodeId: source.sourceNodeId,
    };
    if(typeof image.set === 'function') image.set(values);
    else Object.assign(image, values);
    if(!image.src) image.src = source.url;

    const layer = createLayer(editor, source);
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
    } else if(typeof value.src === 'string' && value.src.startsWith('data:image/')){
      throw new Error('OpenShop project contains inline image data without an asset id');
    }
    Object.values(value).forEach(child => externalizeAssets(child, assetRefs));
  }

  function serializeProject({editor, context, now = Date.now}){
    if(!editor?.canvas?.toJSON || !Array.isArray(editor.layers)){
      throw new Error('OpenShop editor is unavailable');
    }
    const owner = normalizeContext(context);
    const timestamp = Number(now());
    const createdAt = Number(editor.__hstarProjectCreatedAt || timestamp);
    editor.__hstarProjectCreatedAt = createdAt;
    const editorJson = clone(editor.canvas.toJSON([
      'name',
      'excludeFromExport',
      'globalCompositeOperation',
      'hstarAssetId',
      'hstarEdgeId',
      'hstarSourceNodeId',
    ]));
    const assetRefs = new Set();
    externalizeAssets(editorJson, assetRefs);

    const layers = editor.layers.map(layer => ({
      name: safeName(layer.name, '图层'),
      visible: layer.visible !== false,
      opacity: Number.isFinite(Number(layer.opacity)) ? Number(layer.opacity) : 100,
      blend: clean(layer.blend) || 'source-over',
      sourceBinding: layer.sourceBinding ? clone(layer.sourceBinding) : null,
    }));
    const sourceBindings = layers
      .map((layer, layerIndex) => layer.sourceBinding ? {...layer.sourceBinding, layerIndex} : null)
      .filter(Boolean)
      .sort((left, right) => left.sequence - right.sequence);
    sourceBindings.forEach(binding => assetRefs.add(binding.assetId));

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
      assetRefs: [...assetRefs].sort(),
      createdAt,
      updatedAt: timestamp,
    };
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

  async function restoreProject({editor, project:projectValue, assetResolver}){
    const project = clone(projectValue);
    if(project?.schemaVersion !== SCHEMA_VERSION) throw new Error('OpenShop project version is unsupported');
    if(!editor?.canvas?.loadFromJSON) throw new Error('OpenShop editor is unavailable');
    const context = normalizeContext({...project.owner, projectId:project.projectId});
    await hydrateAssets(project.editor, assetResolver);

    editor.canvasW = positiveDimension(project.document?.width, 'width');
    editor.canvasH = positiveDimension(project.document?.height, 'height');
    editor.__hstarProjectCreatedAt = Number(project.createdAt || Date.now());
    await new Promise((resolve, reject) => {
      try {
        const result = editor.canvas.loadFromJSON(project.editor, () => resolve());
        if(result && typeof result.then === 'function') result.then(resolve, reject);
      } catch(error) {
        reject(error);
      }
    });
    editor.rebuildLayersFromCanvas?.();
    if(Array.isArray(project.layers)){
      project.layers.forEach((metadata, index) => {
        const layer = editor.layers?.[index];
        if(!layer) return;
        layer.name = safeName(metadata.name, `Layer ${index}`);
        layer.visible = metadata.visible !== false;
        layer.opacity = Number(metadata.opacity ?? 100);
        layer.blend = clean(metadata.blend) || 'source-over';
        layer.sourceBinding = metadata.sourceBinding ? clone(metadata.sourceBinding) : null;
      });
    }
    editor.canvas.renderAll?.();
    editor.updateLayersPanel?.();
    return {context, project};
  }

  root.HstarOpenShopProjectAdapter = Object.freeze({
    SCHEMA_VERSION,
    createEmptyProject,
    serializeProject,
    restoreProject,
    queueSourceImageLayer,
  });
})(window);
