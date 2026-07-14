import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const adapterPath = resolve(testDir, '..', 'host', 'openshop-project-adapter.js');

function deferred() {
  let resolvePromise;
  let rejectPromise;
  const promise = new Promise((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return { promise, resolve: resolvePromise, reject: rejectPromise };
}

function createImage(source) {
  return {
    type: 'image',
    src: source.url,
    set(values) {
      Object.assign(this, values);
    }
  };
}

function createEditor() {
  const canvasObjects = [];
  const editor = {
    canvasW: 1920,
    canvasH: 1080,
    activeLayerIdx: 0,
    layers: [
      { name: 'Layer 0', visible: true, opacity: 100, blend: 'source-over', objects: [] }
    ],
    canvas: {
      add: vi.fn(object => canvasObjects.push(object)),
      remove: vi.fn(object => {
        const index = canvasObjects.indexOf(object);
        if(index >= 0) canvasObjects.splice(index, 1);
      }),
      moveTo: vi.fn((object, index) => {
        const current = canvasObjects.indexOf(object);
        if(current >= 0) canvasObjects.splice(current, 1);
        canvasObjects.splice(index, 0, object);
      }),
      getObjects: vi.fn(() => canvasObjects),
      renderAll: vi.fn(),
      toJSON: vi.fn(() => ({
        objects: canvasObjects.map(object => ({
          type: object.type,
          name: object.name,
          src: object.src,
          hstarAssetId: object.hstarAssetId,
          hstarEdgeId: object.hstarEdgeId,
          hstarSourceNodeId: object.hstarSourceNodeId,
          hstarLayerId: object.hstarLayerId
        }))
      }))
    },
    addLayer: vi.fn(() => {
      const index = editor.layers.length;
      editor.layers.push({
        name: `Layer ${index}`,
        visible: true,
        opacity: 100,
        blend: 'source-over',
        objects: []
      });
      editor.activeLayerIdx = index;
    }),
    updateLayersPanel: vi.fn(),
    saveHistory: vi.fn()
  };
  return editor;
}

const context = {
  canvasType: 'classic',
  canvasId: 'canvas-1',
  nodeId: 'node-1',
  projectId: 'project-1'
};

describe('Hstar OpenShop project adapter', () => {
  beforeEach(async () => {
    expect(existsSync(adapterPath), `${adapterPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopProjectAdapter;
    await import(`${pathToFileURL(adapterPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('creates a project owned by one canvas node', () => {
    const project = window.HstarOpenShopProjectAdapter.createEmptyProject({
      context,
      width: 1280,
      height: 720,
      now: () => 1000
    });

    expect(project.schemaVersion).toBe(1);
    expect(project.projectId).toBe('project-1');
    expect(project.owner).toEqual({
      canvasType: 'classic',
      canvasId: 'canvas-1',
      nodeId: 'node-1'
    });
    expect(project.document).toEqual({
      width: 1280,
      height: 720,
      resolution: 72,
      colorSpace: 'srgb'
    });
    expect(project.createdAt).toBe(1000);
    expect(project.updatedAt).toBe(1000);
  });

  it('keeps source layer order when images resolve out of order', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const first = deferred();
    const second = deferred();
    const pending = new Map([
      ['asset-1', first],
      ['asset-2', second]
    ]);
    const imageLoader = source => pending.get(source.assetId).promise;

    const firstInsert = adapter.queueSourceImageLayer({
      editor,
      imageLoader,
      source: {
        assetId: 'asset-1',
        edgeId: 'edge-1',
        sourceNodeId: 'image-node-1',
        name: '第一张.png',
        url: 'data:image/png;base64,FIRST',
        sequence: 0
      }
    });
    const secondInsert = adapter.queueSourceImageLayer({
      editor,
      imageLoader,
      source: {
        assetId: 'asset-2',
        edgeId: 'edge-2',
        sourceNodeId: 'image-node-2',
        name: '第二张.png',
        url: 'data:image/png;base64,SECOND',
        sequence: 1
      }
    });

    second.resolve(createImage({ url: 'data:image/png;base64,SECOND' }));
    await secondInsert;
    first.resolve(createImage({ url: 'data:image/png;base64,FIRST' }));
    await firstInsert;

    expect(editor.layers.map(layer => layer.name)).toEqual(['第一张.png', '第二张.png']);
    expect(editor.layers.map(layer => layer.sourceBinding.sequence)).toEqual([0, 1]);
    expect(editor.layers[0].objects[0].hstarAssetId).toBe('asset-1');
    expect(editor.layers[1].objects[0].hstarAssetId).toBe('asset-2');
    expect(editor.canvas.getObjects().map(object => object.hstarAssetId)).toEqual(['asset-1', 'asset-2']);
  });

  it('externalizes image bytes when serializing a project', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();

    await adapter.queueSourceImageLayer({
      editor,
      imageLoader: async source => createImage(source),
      source: {
        assetId: 'asset-1',
        edgeId: 'edge-1',
        sourceNodeId: 'image-node-1',
        name: '第一张.png',
        url: 'data:image/png;base64,IMAGE_BYTES',
        sequence: 0
      }
    });

    const project = adapter.serializeProject({
      editor,
      context,
      now: () => 2000
    });
    const serialized = JSON.stringify(project);

    expect(project.layers.map(layer => layer.name)).toEqual(['第一张.png']);
    expect(project.sourceBindings.map(binding => binding.sequence)).toEqual([0]);
    expect(project.sourceBindings[0].layerId).toBe(editor.layers[0].layerId);
    expect(project.assetRefs).toEqual(['asset-1']);
    expect(project.editor.objects[0].assetRef).toBe('asset-1');
    expect(project.editor.objects[0]).not.toHaveProperty('src');
    expect(serialized).not.toContain('data:image/');
    expect(editor.layers[0].objects[0].src).toContain('data:image/');
  });

  it('rejects inline image bytes that have no asset id', () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const image = createImage({ url: 'data:image/png;base64,UNTRACKED' });
    image.name = '未托管图片.png';
    editor.canvas.add(image);
    editor.layers[0].objects.push(image);

    expect(() => adapter.serializeProject({
      editor,
      context,
      now: () => 2000
    })).toThrow('inline image data without an asset id');
  });

  it('persists local image objects before serializing the project', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const image = createImage({ url: 'blob:http://localhost/local-layer' });
    image.name = '本地图层.png';
    editor.canvas.add(image);
    editor.layers[0].objects.push(image);
    const assetWriter = vi.fn(async ({dataUrl, role}) => ({
      assetId: 'asset-local',
      url: '/api/openshop/assets/asset-local',
      role,
      received: dataUrl,
    }));

    const persisted = await adapter.persistEditorAssets({editor, assetWriter});

    expect(persisted).toEqual([{assetId: 'asset-local', role: 'layer'}]);
    expect(assetWriter).toHaveBeenCalledWith(expect.objectContaining({
      dataUrl: 'blob:http://localhost/local-layer',
      role: 'layer',
    }));
    expect(image.hstarAssetId).toBe('asset-local');
    expect(image.hstarAssetRole).toBe('layer');

    editor.__hstarPreviewAssetId = 'asset-local';
    editor.__hstarAutosaveVersion = 7;
    const project = adapter.serializeProject({editor, context, now: () => 3000});
    expect(project.previewAssetId).toBe('asset-local');
    expect(project.autosaveVersion).toBe(7);
    expect(project.layers[0].layerId).toMatch(/^layer_/);
    expect(JSON.stringify(project)).not.toMatch(/data:image\/|blob:/);
  });

  it('persists fonts, per-tool API preferences and bounded AI task records', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const sourceAssetId = 'a'.repeat(64);
    const maskAssetId = 'b'.repeat(64);
    const outputAssetId = 'c'.repeat(64);
    editor.__hstarFontRefs = [
      {family:'Microsoft YaHei UI', status:'available'},
      {family:'Missing Poster Font', status:'missing'},
    ];
    editor.__hstarAiToolPreferences = {
      'text-extract': {
        toolId:'text-extract', mode:'project', apiConfigId:'vision', modelId:'gemini-3.1-pro-high',
      },
      'text-remove': {
        toolId:'text-remove', mode:'project', apiConfigId:'image', modelId:'gemini-3-pro-image',
      },
    };
    editor.__hstarAiTaskRecords = [{
      taskId:'task-1', toolId:'text-remove', apiConfigId:'image', modelId:'gemini-3-pro-image',
      status:'succeeded', mode:'selection', sourceAssetId, maskAssetId, outputAssetId,
      createdAt:1000, updatedAt:2000, completedAt:2000, appliedAt:0, error:'',
    }];

    const project = adapter.serializeProject({editor, context, now:() => 3000});

    expect(project.fontRefs).toEqual(editor.__hstarFontRefs);
    expect(project.aiToolPreferences).toEqual(editor.__hstarAiToolPreferences);
    expect(project.aiTaskRecords).toEqual(editor.__hstarAiTaskRecords);
    expect(project.assetRefs).toEqual([maskAssetId, sourceAssetId, outputAssetId].sort());

    const restored = createEditor();
    restored.canvas.loadFromJSON = vi.fn((_json, callback) => callback());
    await adapter.restoreProject({
      editor:restored,
      project,
      assetResolver:async assetId => `/api/openshop/assets/${assetId}`,
    });

    expect(restored.__hstarFontRefs).toEqual(editor.__hstarFontRefs);
    expect(restored.__hstarAiToolPreferences).toEqual(editor.__hstarAiToolPreferences);
    expect(restored.__hstarAiTaskRecords).toEqual(editor.__hstarAiTaskRecords);
    restored.__hstarAiTaskRecords[0].status = 'failed';
    expect(project.aiTaskRecords[0].status).toBe('succeeded');
  });

  it('persists image assets nested inside Fabric groups', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const nestedImage = createImage({ url: 'data:image/png;base64,NESTED' });
    nestedImage.name = '组内图像.png';
    const group = {type: 'group', name: '图像组', _objects: [nestedImage]};
    editor.canvas.add(group);
    editor.layers[0].objects.push(group);

    const persisted = await adapter.persistEditorAssets({
      editor,
      assetWriter: async ({role}) => ({assetId: 'asset-nested', role}),
    });

    expect(persisted).toEqual([{assetId: 'asset-nested', role: 'layer'}]);
    expect(nestedImage.hstarAssetId).toBe('asset-nested');
  });

  it('reconciles new, updated and disconnected canvas sources without losing pixels', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const sourceV1 = {
      assetId: 'asset-v1',
      assetVersion: 'v1',
      edgeId: 'edge-1',
      sourceNodeId: 'image-node-1',
      name: '来源一.png',
      url: '/api/openshop/assets/asset-v1',
      sequence: 0,
    };
    const sourceV2 = {...sourceV1, assetId: 'asset-v2', assetVersion: 'v2', url: '/api/openshop/assets/asset-v2'};
    const newSource = {
      assetId: 'asset-new',
      assetVersion: 'v1',
      edgeId: 'edge-2',
      sourceNodeId: 'image-node-2',
      name: '来源二.png',
      url: '/api/openshop/assets/asset-new',
      sequence: 1,
    };
    const imageLoader = vi.fn(async source => createImage(source));

    const existingLayer = await adapter.queueSourceImageLayer({editor, source: sourceV1, imageLoader});
    const existingImage = existingLayer.objects[0];
    const result = await adapter.reconcileSources({
      editor,
      sources: [sourceV2, newSource],
      imageLoader,
    });

    expect(result.pendingUpdates).toHaveLength(1);
    expect(result.added).toHaveLength(1);
    expect(existingLayer.sourceBinding.state).toBe('update-available');
    expect(existingLayer.sourceBinding.pendingAssetId).toBe('asset-v2');
    expect(editor.layers.at(-1).sourceBinding.edgeId).toBe('edge-2');

    await adapter.resolveSourceUpdate({editor, edgeId: 'edge-1', mode: 'add', imageLoader});
    expect(editor.layers.at(-1).sourceBinding.assetVersion).toBe('v2');
    expect(existingLayer.sourceBinding.state).toBe('detached');
    expect(existingLayer.objects[0]).toBe(existingImage);

    const disconnected = await adapter.reconcileSources({
      editor,
      sources: [newSource],
      imageLoader,
    });
    expect(disconnected.detached.map(layer => layer.layerId)).toContain(existingLayer.layerId);
    expect(existingLayer.objects[0]).toBe(existingImage);
    expect(editor.canvas.getObjects()).toContain(existingImage);
  });

  it('keeps one active binding per source edge after adding, saving and restoring an update', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const sourceV1 = {
      assetId: 'asset-v1', assetVersion: 'v1', edgeId: 'edge-stable',
      sourceNodeId: 'image-node-1', name: 'source-v1.png',
      url: '/api/openshop/assets/asset-v1', sequence: 0,
    };
    const sourceV2 = {
      ...sourceV1,
      assetId: 'asset-v2',
      assetVersion: 'v2',
      name: 'source-v2.png',
      url: '/api/openshop/assets/asset-v2',
    };
    const sourceV3 = {
      ...sourceV1,
      assetId: 'asset-v3',
      assetVersion: 'v3',
      name: 'source-v3.png',
      url: '/api/openshop/assets/asset-v3',
    };
    const imageLoader = async source => createImage(source);

    await adapter.queueSourceImageLayer({editor, source: sourceV1, imageLoader});
    await adapter.reconcileSources({editor, sources: [sourceV2], imageLoader});
    await adapter.resolveSourceUpdate({editor, edgeId: sourceV2.edgeId, mode: 'add', imageLoader});

    const saved = adapter.serializeProject({editor, context, now: () => 4000});
    const restored = createEditor();
    restored.canvas.loadFromJSON = vi.fn((json, callback) => {
      json.objects.forEach(object => restored.canvas.add({...object}));
      callback();
    });
    restored.rebuildLayersFromCanvas = vi.fn(() => {
      const layersById = new Map();
      restored.canvas.getObjects().forEach(object => {
        const layerId = object.hstarLayerId;
        if(!layersById.has(layerId)){
          layersById.set(layerId, {
            layerId,
            name: object.name,
            visible: true,
            opacity: 100,
            blend: 'source-over',
            objects: [],
          });
        }
        layersById.get(layerId).objects.push(object);
      });
      restored.layers = [...layersById.values()];
    });
    await adapter.restoreProject({
      editor: restored,
      project: saved,
      assetResolver: async assetId => `/api/openshop/assets/${assetId}`,
    });

    const repeated = await adapter.reconcileSources({editor: restored, sources: [sourceV2], imageLoader});
    expect(repeated.added).toHaveLength(0);
    expect(restored.layers.filter(layer => (
      layer.sourceBinding?.edgeId === sourceV2.edgeId
      && layer.sourceBinding.state !== 'detached'
    ))).toHaveLength(1);

    const next = await adapter.reconcileSources({editor: restored, sources: [sourceV3], imageLoader});
    expect(next.added).toHaveLength(0);
    expect(next.pendingUpdates).toHaveLength(1);
    expect(restored.layers.filter(layer => (
      layer.sourceBinding?.edgeId === sourceV3.edgeId
      && layer.sourceBinding.state !== 'detached'
    ))).toHaveLength(1);
  });

  it('heals multiple active bindings left by an interrupted source restore', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const sourceV1 = {
      assetId: 'asset-v1', assetVersion: 'v1', edgeId: 'edge-legacy',
      sourceNodeId: 'image-node-1', name: 'source-v1.png',
      url: '/api/openshop/assets/asset-v1', sequence: 0,
    };
    const sourceV2 = {
      ...sourceV1,
      assetId: 'asset-v2',
      assetVersion: 'v2',
      name: 'source-v2.png',
      url: '/api/openshop/assets/asset-v2',
    };
    const sourceV3 = {
      ...sourceV1,
      assetId: 'asset-v3',
      assetVersion: 'v3',
      name: 'source-v3.png',
      url: '/api/openshop/assets/asset-v3',
    };
    const imageLoader = async source => createImage(source);

    const oldLayer = await adapter.queueSourceImageLayer({editor, source: sourceV1, imageLoader});
    await adapter.reconcileSources({editor, sources: [sourceV2], imageLoader});
    const currentLayer = await adapter.resolveSourceUpdate({
      editor,
      edgeId: sourceV2.edgeId,
      mode: 'add',
      imageLoader,
    });
    oldLayer.sourceBinding.state = 'bound';

    const repeated = await adapter.reconcileSources({editor, sources: [sourceV2], imageLoader});
    expect(repeated.added).toHaveLength(0);
    expect(repeated.pendingUpdates).toHaveLength(0);
    expect(currentLayer.sourceBinding.state).toBe('bound');
    expect(oldLayer.sourceBinding.state).toBe('detached');
    expect(editor.layers.filter(layer => (
      layer.sourceBinding?.edgeId === sourceV2.edgeId
      && layer.sourceBinding.state !== 'detached'
    ))).toHaveLength(1);

    const next = await adapter.reconcileSources({editor, sources: [sourceV3], imageLoader});
    expect(next.pendingUpdates).toHaveLength(1);
    expect(next.pendingUpdates[0].layerId).toBe(currentLayer.layerId);
  });

  it('replaces an updated source in place and preserves its image transform', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const sourceV1 = {
      assetId: 'asset-v1', assetVersion: 'v1', edgeId: 'edge-replace',
      sourceNodeId: 'image-node-1', name: '待替换.png',
      url: '/api/openshop/assets/asset-v1', sequence: 0,
    };
    const sourceV2 = {
      ...sourceV1,
      assetId: 'asset-v2',
      assetVersion: 'v2',
      url: '/api/openshop/assets/asset-v2',
    };
    const original = createImage(sourceV1);
    original.left = 123;
    original.top = 45;
    original.scaleX = 1.5;
    original.scaleY = 0.75;
    const layer = await adapter.queueSourceImageLayer({
      editor,
      source: sourceV1,
      imageLoader: async () => original,
    });
    await adapter.reconcileSources({editor, sources: [sourceV2], imageLoader: async source => createImage(source)});

    await adapter.resolveSourceUpdate({
      editor,
      edgeId: 'edge-replace',
      mode: 'replace',
      imageLoader: async source => createImage(source),
    });

    const replacement = layer.objects[0];
    expect(replacement).not.toBe(original);
    expect(replacement).toMatchObject({left: 123, top: 45, scaleX: 1.5, scaleY: 0.75});
    expect(layer.sourceBinding).toMatchObject({
      assetId: 'asset-v2', assetVersion: 'v2', state: 'bound',
    });
    expect(editor.canvas.getObjects()).not.toContain(original);
    expect(editor.canvas.getObjects()).toContain(replacement);
  });

  it('remembers an ignored source version without replacing the current pixels', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    const sourceV1 = {
      assetId: 'asset-v1', assetVersion: 'v1', edgeId: 'edge-ignore',
      sourceNodeId: 'image-node-1', name: '保留版本.png',
      url: '/api/openshop/assets/asset-v1', sequence: 0,
    };
    const sourceV2 = {
      ...sourceV1,
      assetId: 'asset-v2',
      assetVersion: 'v2',
      url: '/api/openshop/assets/asset-v2',
    };
    const layer = await adapter.queueSourceImageLayer({
      editor,
      source: sourceV1,
      imageLoader: async source => createImage(source),
    });
    await adapter.reconcileSources({editor, sources: [sourceV2], imageLoader: async source => createImage(source)});

    await adapter.resolveSourceUpdate({editor, edgeId: 'edge-ignore', mode: 'ignore'});
    const repeated = await adapter.reconcileSources({
      editor,
      sources: [sourceV2],
      imageLoader: async source => createImage(source),
    });

    expect(layer.sourceBinding).toMatchObject({
      assetId: 'asset-v1',
      assetVersion: 'v1',
      ignoredAssetVersion: 'v2',
      state: 'bound',
      pendingAssetId: '',
    });
    expect(repeated.pendingUpdates).toHaveLength(0);
  });

  it('restores layer metadata by stable layer id after layer order changes', async () => {
    const adapter = window.HstarOpenShopProjectAdapter;
    const editor = createEditor();
    editor.canvas.loadFromJSON = vi.fn((json, callback) => {
      json.objects.forEach(object => editor.canvas.add({...object}));
      callback();
    });
    editor.rebuildLayersFromCanvas = vi.fn(() => {
      const objects = editor.canvas.getObjects();
      editor.layers = [
        {name: 'temporary-a', visible: true, opacity: 100, blend: 'source-over', objects: [objects[1]]},
        {name: 'temporary-b', visible: true, opacity: 100, blend: 'source-over', objects: [objects[0]]},
      ];
    });
    const project = {
      schemaVersion: 1,
      projectId: 'project-1',
      owner: {canvasType: 'classic', canvasId: 'canvas-1', nodeId: 'node-1'},
      document: {width: 800, height: 600},
      editor: {objects: [
        {type: 'image', assetRef: 'asset-b', hstarLayerId: 'layer-b'},
        {type: 'image', assetRef: 'asset-a', hstarLayerId: 'layer-a'},
      ]},
      layers: [
        {layerId: 'layer-a', name: '图层 A', visible: true, opacity: 90, blend: 'source-over'},
        {layerId: 'layer-b', name: '图层 B', visible: false, opacity: 70, blend: 'multiply'},
      ],
      previewAssetId: 'asset-a',
      autosaveVersion: 9,
      createdAt: 1000,
    };

    await adapter.restoreProject({
      editor,
      project,
      assetResolver: async assetId => `/api/openshop/assets/${assetId}`,
    });

    const byId = Object.fromEntries(editor.layers.map(layer => [layer.layerId, layer]));
    expect(byId['layer-a']).toMatchObject({name: '图层 A', opacity: 90, visible: true});
    expect(byId['layer-b']).toMatchObject({name: '图层 B', opacity: 70, visible: false, blend: 'multiply'});
    expect(editor.__hstarPreviewAssetId).toBe('asset-a');
    expect(editor.__hstarAutosaveVersion).toBe(9);
  });
});
