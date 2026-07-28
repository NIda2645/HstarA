import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const managerPath = resolve(testDir, '..', 'host', 'openshop-reference-manager.js');

const context = {
  canvasType:'classic', canvasId:'canvas-1', nodeId:'node-1', projectId:'project-1',
};

function createHarness({defaultComposite=false}={}) {
  const sourceLayer = {layerId:'layer-source', name:'来源图片', visible:true, objects:[]};
  const referenceLayer = {layerId:'layer-reference', name:'参考图层', visible:true, objects:[]};
  const editor = {
    canvasW:1920,
    canvasH:1080,
    activeLayerIdx:0,
    layers:[sourceLayer, referenceLayer],
    _selectionBounds:{x:100, y:80, w:640, h:420},
    _selectionRegions:[],
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
  const captureSelectionRegion = vi.fn(async region => ({
    dataUrl:`data:image/png;base64,REGION_${region.x}_${region.y}`,
    width:region.w,
    height:region.h,
  }));
  const captureLayer = vi.fn(async layer => ({
    dataUrl:`data:image/png;base64,LAYER_${layer.layerId}`, width:1920, height:1080,
  }));
  const fileToDataUrl = vi.fn(async () => 'data:image/png;base64,LOCAL');
  const runtime = {getState:() => ({activeSession:{context}})};
  const managerOptions = {
    editor,
    runtime,
    assetApi,
    fetchImpl,
    assetExists,
    captureSelection,
    captureSelectionRegion,
    captureLayer,
    fileToDataUrl,
  };
  if(!defaultComposite) managerOptions.captureVisibleComposite = captureVisibleComposite;
  const manager = window.HstarOpenShopReferenceManager.createManager(managerOptions);
  return {
    manager, editor, sourceLayer, referenceLayer, assetApi, fetchImpl, assetExists,
    captureVisibleComposite, captureSelection, captureSelectionRegion, captureLayer, fileToDataUrl,
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

  it('exposes stable identity and mention metadata to prompt tokens', () => {
    const {manager} = createHarness();
    manager.restore([{
      assetId:'a'.repeat(64),
      alias:'参考图1',
      mention:'@参考图1',
      sourceType:'library',
      order:0,
      width:1024,
      height:768,
    }]);

    expect(manager.itemsForMentionPicker('参考图')).toEqual([
      expect.objectContaining({
        assetId:'a'.repeat(64),
        referenceKey:'a'.repeat(64),
        alias:'参考图1',
        mention:'@参考图1',
        sourceType:'library',
      }),
    ]);
    manager.destroy();
  });

  it('keeps a transient selection identity stable after the reference is frozen', async () => {
    const {manager, editor} = createHarness();
    const region = {x:120, y:90, w:320, h:240};
    editor._selectionBounds = {...region};
    editor._selectionRegions = [{...region}];
    await manager.setPrimaryMode('selection');

    const before = manager.itemsForMentionPicker('选区1')[0];
    expect(before.assetId).toBe('');

    await manager.snapshotForTask({mode:'selection', maxReferences:8});

    const after = manager.itemsForMentionPicker('选区1')[0];
    expect(after.assetId).not.toBe('');
    expect(after.referenceKey).toBe(before.referenceKey);
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

  it('projects a zoomed and panned screen mask back to exact document pixels', () => {
    const context = {
      fillStyle:'',
      fillRect:vi.fn(),
      createImageData:vi.fn((width, height) => ({
        data:new Uint8ClampedArray(width * height * 4),
        width,
        height,
      })),
      putImageData:vi.fn(),
    };
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue(context);
    vi.spyOn(HTMLCanvasElement.prototype, 'toDataURL').mockReturnValue('data:image/png;base64,MASK');
    const {manager, editor} = createHarness();
    editor.canvasW = 8;
    editor.canvasH = 6;
    editor.canvas.viewportTransform = [2, 0, 0, 2, 4, 2];
    editor._selectionDocumentBounds = {x:1, y:1, w:2, h:1};
    editor._selectionMaskSpace = 'screen';
    editor._selectionMask = {mask:new Uint8Array(20 * 16), w:20, h:16};
    for(let y = 4; y < 6; y += 1){
      for(let x = 6; x < 10; x += 1) editor._selectionMask.mask[y * 20 + x] = 1;
    }

    manager.captureSelectionMask();

    const image = context.putImageData.mock.calls[0][0];
    const selected = [];
    for(let y = 0; y < 6; y += 1){
      for(let x = 0; x < 8; x += 1){
        if(image.data[(y * 8 + x) * 4] === 255) selected.push([x, y]);
      }
    }
    expect(selected).toEqual([[1, 1], [2, 1]]);
    manager.destroy();
  });

  it('exports the full document with an identity viewport and restores the editor view', async () => {
    const {manager, editor} = createHarness({defaultComposite:true});
    const viewport = [0.5, 0, 0, 0.5, 240, 160];
    const capturedViewports = [];
    editor.canvas.viewportTransform = [...viewport];
    editor.canvas.toDataURL.mockImplementation(() => {
      capturedViewports.push([...editor.canvas.viewportTransform]);
      return 'data:image/png;base64,DOCUMENT';
    });

    const captured = await manager.captureVisibleComposite();

    expect(captured).toMatchObject({width:1920, height:1080});
    expect(capturedViewports).toEqual([[1, 0, 0, 1, 0, 0]]);
    expect(editor.canvas.viewportTransform).toEqual(viewport);
    expect(editor.canvas.renderAll).toHaveBeenCalledTimes(2);
    manager.destroy();
  });

  it('removes every thumbnail, promotes the next reference, and returns to empty', async () => {
    const {manager} = createHarness();
    await manager.setPrimaryMode('full');
    await manager.addCurrentSelection();

    expect(manager.list().map(item => item.alias)).toEqual(['参考图1', '选区1']);
    expect(manager.removeReference('参考图1')).toBe(true);
    expect(manager.getPrimary()).toMatchObject({alias:'选区1', sourceType:'selection'});
    expect(manager.removeReference('@选区1')).toBe(true);
    expect(manager.list()).toEqual([]);
    expect(manager.getPrimary()).toBeNull();
    manager.destroy();
  });

  it('creates one live reference thumbnail for each independent selection region', async () => {
    const {manager, editor, captureSelectionRegion} = createHarness();
    editor._selectionRegions = [
      {x:100, y:80, w:240, h:120},
      {x:900, y:540, w:360, h:220},
    ];
    await manager.setPrimaryMode('selection');

    const records = manager.list();
    expect(records).toHaveLength(2);
    expect(records.map(item => item.selectionRegionIndex)).toEqual([0, 1]);
    expect(records.every(item => item.autoSelectionRegion === true)).toBe(true);
    expect(records.map(item => [item.width, item.height])).toEqual([[240, 120], [360, 220]]);
    expect(captureSelectionRegion).toHaveBeenCalledTimes(2);
    manager.destroy();
  });

  it('persists imported references with contiguous order after transient selections', async () => {
    const {manager, editor} = createHarness();
    editor._selectionRegions = [
      {x:100, y:80, w:240, h:120},
      {x:900, y:540, w:360, h:220},
    ];
    await manager.setPrimaryMode('selection');
    await manager.addLibraryItem({
      libraryId:'library-1', categoryId:'category-1', itemId:'item-1', name:'素材图',
    });

    expect(editor.__hstarAiReferenceRecords).toHaveLength(1);
    expect(editor.__hstarAiReferenceRecords[0]).toMatchObject({
      sourceType:'library', alias:'参考图1', order:0,
    });
    manager.destroy();
  });

  it('cancels the linked canvas selection when an automatic selection thumbnail is removed', async () => {
    const {manager, editor, captureSelectionRegion} = createHarness();
    const removeSelectionRegion = vi.fn(() => true);
    editor.removeSelectionRegion = removeSelectionRegion;
    editor._selectionRegions = [
      {x:100, y:80, w:240, h:120},
      {x:900, y:540, w:360, h:220},
    ];
    await manager.setPrimaryMode('selection');
    const firstAlias = manager.list()[0].alias;

    expect(manager.removeReference(firstAlias)).toBe(true);
    expect(removeSelectionRegion).toHaveBeenCalledWith(0);
    expect(manager.list()).toHaveLength(1);
    expect(manager.list()[0].selectionRegionIndex).toBe(1);
    expect(captureSelectionRegion).toHaveBeenCalledTimes(2);
    manager.destroy();
  });
});
