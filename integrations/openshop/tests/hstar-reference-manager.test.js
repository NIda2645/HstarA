import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const managerPath = resolve(testDir, '..', 'host', 'openshop-reference-manager.js');

const context = {
  canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
};

function createHarness() {
  const sourceLayer = {layerId:'layer-source', name:'来源图片', visible:true, objects:[]};
  const referenceLayer = {layerId:'layer-reference', name:'参考图层', visible:true, objects:[]};
  const editor = {
    canvasW:1920,
    canvasH:1080,
    activeLayerIdx:0,
    layers:[sourceLayer, referenceLayer],
    _selectionBounds:{x:100, y:80, w:640, h:420},
    canvas:{
      toDataURL:vi.fn(() => 'data:image/png;base64,CANVAS'),
      getObjects:vi.fn(() => []),
      renderAll:vi.fn(),
    },
  };
  let uploadSequence = 0;
  const assetApi = {
    upload:vi.fn(async payload => {
      uploadSequence += 1;
      const assetId = String(uploadSequence).padStart(64, '0');
      return {
        assetId,
        url:`/api/openshop/assets/${assetId}`,
        width:payload.width || 640,
        height:payload.height || 420,
      };
    }),
  };
  const fetchImpl = vi.fn(async (url, options={}) => {
    if(url === '/api/openshop/projects/project-1/asset-imports' && options.method === 'POST') {
      return new Response(JSON.stringify({asset:{
        assetId:'9'.repeat(64),
        url:`/api/openshop/assets/${'9'.repeat(64)}`,
        width:1280,
        height:720,
        role:'ai-reference',
      }}), {status:200, headers:{'Content-Type':'application/json'}});
    }
    return new Response(JSON.stringify({detail:'unexpected'}), {
      status:404,
      headers:{'Content-Type':'application/json'},
    });
  });
  const assetExists = vi.fn(async () => true);
  const captureVisibleComposite = vi.fn(async () => ({
    dataUrl:'data:image/png;base64,FULL', width:1920, height:1080,
  }));
  const captureSelection = vi.fn(async () => ({
    dataUrl:'data:image/png;base64,SELECTION', width:640, height:420,
  }));
  const captureLayer = vi.fn(async layer => ({
    dataUrl:`data:image/png;base64,LAYER_${layer.layerId}`, width:1920, height:1080,
  }));
  const fileToDataUrl = vi.fn(async () => 'data:image/png;base64,LOCAL');
  const runtime = {getState:() => ({activeSession:{context}})};
  const manager = window.HstarOpenShopReferenceManager.createManager({
    editor,
    runtime,
    assetApi,
    fetchImpl,
    assetExists,
    captureVisibleComposite,
    captureSelection,
    captureLayer,
    fileToDataUrl,
  });
  return {
    manager, editor, sourceLayer, referenceLayer, assetApi, fetchImpl, assetExists,
    captureVisibleComposite, captureSelection, captureLayer, fileToDataUrl,
  };
}

describe('Hstar OpenShop reference manager', () => {
  beforeEach(async () => {
    expect(existsSync(managerPath), `${managerPath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopReferenceManager;
    await import(`${pathToFileURL(managerPath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('assigns stable aliases and freezes every attached reference', async () => {
    const {manager, referenceLayer, assetApi, fetchImpl} = createHarness();
    await manager.setPrimaryMode('full');
    await manager.addCurrentSelection();
    await manager.addLayer(referenceLayer);
    await manager.addLibraryItem({
      libraryId:'library-1', categoryId:'category-1', itemId:'item-1', name:'素材图',
    });
    await manager.addLocalFile(new File(['local'], 'local.png', {type:'image/png'}));

    expect(manager.list().map(item => item.mention)).toEqual([
      '@参考图1', '@选区1', '@参考图2', '@参考图3', '@参考图4',
    ]);
    const fullCompositeAsset = {
      assetId:'8'.repeat(64),
      url:`/api/openshop/assets/${'8'.repeat(64)}`,
      width:1920,
      height:1080,
    };
    const snapshot = await manager.snapshotForTask({
      mode:'full', maxReferences:8, fullCompositeAsset,
    });

    expect(snapshot.primaryReferenceAssetId).toBe('8'.repeat(64));
    expect(snapshot.references).toHaveLength(5);
    expect(snapshot.references.every(item => item.assetId)).toBe(true);
    expect(snapshot.mentionMap['@参考图3']).toBe('9'.repeat(64));
    expect(JSON.stringify(snapshot)).not.toMatch(/data:image\/|blob:|seed/i);
    expect(assetApi.upload).toHaveBeenCalledTimes(3);
    expect(fetchImpl).toHaveBeenCalledWith(
      '/api/openshop/projects/project-1/asset-imports',
      expect.objectContaining({method:'POST'}),
    );

    const inserted = manager.insertMention('使用  修改', 3, 3, '@参考图3');
    expect(inserted).toEqual({text:'使用 @参考图3  修改', cursor:9});
    expect(manager.itemsForMentionPicker('参考图3')[0]).toMatchObject({
      mention:'@参考图3', sourceType:'library',
    });
    manager.destroy();
  });

  it('refreshes the live primary thumbnail and reports exact invalid aliases', async () => {
    const {manager, assetExists, captureVisibleComposite} = createHarness();
    await manager.setPrimaryMode('full');
    await manager.addCurrentSelection();
    const firstVersion = manager.getPrimary().thumbnailVersion;

    window.dispatchEvent(new CustomEvent('openshop:project-dirty'));
    await vi.waitFor(() => {
      expect(manager.getPrimary().thumbnailVersion).toBeGreaterThan(firstVersion);
    });
    expect(captureVisibleComposite.mock.calls.length).toBeGreaterThanOrEqual(2);

    const snapshot = await manager.snapshotForTask({
      mode:'full',
      fullCompositeAsset:{assetId:'7'.repeat(64), width:1920, height:1080},
    });
    const selectionAssetId = snapshot.references[1].assetId;
    assetExists.mockImplementation(async assetId => assetId !== selectionAssetId);
    await manager.validate();
    expect(manager.getInvalidReferences()).toEqual(['@选区1']);
    manager.destroy();
  });

  it('renders a document-sized white-on-black selection mask', async () => {
    const {manager} = createHarness();
    const mask = manager.captureSelectionMask();
    expect(mask.width).toBe(1920);
    expect(mask.height).toBe(1080);
    expect(mask.dataUrl).toMatch(/^data:image\/png/);
    manager.destroy();
  });
});
