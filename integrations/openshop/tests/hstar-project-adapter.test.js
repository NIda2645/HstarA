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
          hstarSourceNodeId: object.hstarSourceNodeId
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
});
