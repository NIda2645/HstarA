import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasMock,
  installFabricMock,
  installModalDelegation,
  loadOpenShop,
  mountEditorDom,
  mountOpenShopToolbar,
  quietUiMethods,
} from './os-harness.js';

function createEditor(OS, objects = []) {
  OS.canvas = createCanvasMock(objects);
  OS.canvas.getPointer = vi.fn(event => ({x:event.x || 0, y:event.y || 0}));
  OS.layers = [{name:'Background', locked:false, visible:true, objects:[...objects]}];
  quietUiMethods(OS);
  OS.saveHistory = vi.fn();
  return OS;
}

describe('OpenShop writing-mode integration', () => {
  beforeEach(() => {
    installFabricMock();
    installModalDelegation();
    mountEditorDom();
  });

  it('creates horizontal and vertical text in separate layers', () => {
    const OS = createEditor(loadOpenShop());

    OS.setTool('text-horizontal');
    OS.onMouseDown({e:{x:10, y:20}});
    OS.canvas.discardActiveObject();
    OS.setTool('text-vertical');
    OS.onMouseDown({e:{x:30, y:40}});

    expect(OS.canvas.getObjects().map(object => object.type)).toEqual(['i-text', 'hstar-vertical-text']);
    expect(OS.layers).toHaveLength(3);
    expect(OS.layers.slice(1).map(layer => layer.objects)).toEqual([
      [OS.canvas.getObjects()[0]], [OS.canvas.getObjects()[1]],
    ]);
    expect(OS.canvas.getObjects().map(object => object.hstarWritingMode)).toEqual(['horizontal', 'vertical']);
  });

  it('edits an existing vertical object without adding a layer', () => {
    const vertical = {
      type:'hstar-vertical-text', hstarWritingMode:'vertical', editable:true, isEditing:false,
      enterEditing:vi.fn(function enterEditing() { this.isEditing = true; }),
    };
    const OS = createEditor(loadOpenShop(), [vertical]);
    OS.setTool('text-vertical');

    OS.onMouseDown({e:{x:10, y:20}, target:vertical});

    expect(vertical.enterEditing).toHaveBeenCalledOnce();
    expect(OS.canvas.add).not.toHaveBeenCalled();
    expect(OS.layers).toHaveLength(1);
  });

  it('marks the Fabric text input as a voice-enabled canvas editor', () => {
    const OS = createEditor(loadOpenShop());
    const hiddenTextarea = document.createElement('textarea');
    document.body.append(hiddenTextarea);
    const horizontal = new fabric.IText('Canvas text');
    horizontal.hiddenTextarea = hiddenTextarea;
    horizontal.isEditing = true;

    expect(OS._markVoiceTextEditor(horizontal)).toBe(true);
    expect(hiddenTextarea.dataset.voiceInput).toBe('on');
    expect(hiddenTextarea.dataset.voiceLabel).toBe('画布文字编辑');
    expect(hiddenTextarea.getAttribute('aria-label')).toBe('画布文字编辑');
  });

  it('syncs selected vertical text without leaving select', () => {
    mountOpenShopToolbar();
    const vertical = {type:'hstar-vertical-text', hstarWritingMode:'vertical'};
    const OS = createEditor(loadOpenShop(), [vertical]);
    OS.setTool('select');

    OS._syncTextWritingModeFromSelection({selected:[vertical]});

    expect(OS.state.tool).toBe('select');
    expect(OS.state.textWritingMode).toBe('vertical');
    expect(document.querySelector('.tool-group[data-group="text"] > .tool-btn').dataset.tool).toBe('text-vertical');
  });

  it('converts an active text object once when the user switches writing direction', () => {
    const source = new fabric.IText('Title', {hstarWritingMode:'horizontal'});
    const OS = createEditor(loadOpenShop(), [source]);
    OS.canvas.setActiveObject(source);

    OS.setTool('text-vertical');

    const converted = OS.canvas.getActiveObject();
    expect(converted).toMatchObject({type:'hstar-vertical-text', hstarWritingMode:'vertical'});
    expect(OS.layers[0].objects).toEqual([converted]);
    expect(OS.saveHistory).toHaveBeenCalledOnce();

    OS.setTool('text-vertical');
    expect(OS.saveHistory).toHaveBeenCalledOnce();

    const horizontal = new fabric.IText('No restore conversion', {hstarWritingMode:'horizontal'});
    const restoreOS = createEditor(loadOpenShop(), [horizontal]);
    restoreOS.canvas.setActiveObject(horizontal);
    restoreOS.setTool('text-vertical', {forceInteraction:true, convertTextSelection:false});
    expect(restoreOS.canvas.getActiveObject()).toBe(horizontal);
    expect(restoreOS.saveHistory).not.toHaveBeenCalled();

    restoreOS.setTextWritingMode = vi.fn();
    restoreOS.history = [{snapshot:JSON.stringify({objects:[]}), layers:[]}];
    restoreOS.historyIdx = 0;
    restoreOS._restoreHistory();
    expect(restoreOS.setTextWritingMode).not.toHaveBeenCalled();
  });

  it('converts selected text once while preserving metadata, stack, layer, visibility, and editing', () => {
    const lower = {type:'rect', name:'Lower'};
    const source = new fabric.IText('Title', {
      left:12, top:24, fontFamily:'Noto Sans', fontSize:36, fill:'#123456', visible:false,
      hstarLayerId:'text-1', hstarOcrBlockId:'ocr-1', hstarData:{source:'ocr'},
    });
    source.isEditing = true;
    const upper = {type:'rect', name:'Upper'};
    const OS = createEditor(loadOpenShop(), [lower, source, upper]);
    OS.layers = [
      {name:'Lower', locked:false, visible:true, objects:[lower]},
      {name:'Title', locked:false, visible:false, objects:[source]},
      {name:'Upper', locked:false, visible:true, objects:[upper]},
    ];
    OS.activeLayerIdx = 1;
    OS.canvas.setActiveObject(source);

    const converted = OS.setTextWritingMode('vertical');

    expect(converted).toMatchObject({
      type:'hstar-vertical-text', text:'Title', hstarWritingMode:'vertical', visible:false,
      hstarLayerId:'text-1', hstarOcrBlockId:'ocr-1', hstarData:{source:'ocr'},
    });
    expect(OS.canvas.getObjects()).toEqual([lower, converted, upper]);
    expect(OS.layers[1].objects).toEqual([converted]);
    expect(OS.canvas.getActiveObject()).toBe(converted);
    expect(converted.isEditing).toBe(true);
    expect(OS.saveHistory).toHaveBeenCalledOnce();
    expect(OS._fabricCustomProperties).toContain('hstarWritingMode');
  });
});
