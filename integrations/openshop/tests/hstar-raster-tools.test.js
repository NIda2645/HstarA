import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const runtimePath = resolve(testDir, '..', 'host', 'openshop-raster-tools.js');

function createContext(){
  const assignments = [];
  const context = {
    assignments,
    save:vi.fn(),
    restore:vi.fn(),
    beginPath:vi.fn(),
    moveTo:vi.fn(),
    lineTo:vi.fn(),
    arc:vi.fn(),
    clip:vi.fn(),
    stroke:vi.fn(),
    fill:vi.fn(),
    drawImage:vi.fn(),
  };
  Object.defineProperty(context, 'globalCompositeOperation', {
    configurable:true,
    get(){ return assignments.at(-1) || 'source-over'; },
    set(value){ assignments.push(value); },
  });
  return context;
}

function createDocument(){
  const canvases = [];
  return {
    canvases,
    createElement(tag){
      if(tag !== 'canvas') return {};
      const context = createContext();
      const canvas = {width:0, height:0, context, getContext:vi.fn(() => context)};
      canvases.push(canvas);
      return canvas;
    },
  };
}

function createImage(name){
  const element = {width:100, height:100, naturalWidth:100, naturalHeight:100};
  return {
    type:'image',
    name,
    width:100,
    height:100,
    scaleX:1,
    scaleY:1,
    dirty:false,
    getElement:vi.fn(() => element),
    setElement:vi.fn(function setElement(next){ this.element = next; }),
    calcTransformMatrix:vi.fn(() => [1, 0, 0, 1, 50, 50]),
  };
}

function createEditor(){
  const lower = createImage('lower');
  const active = createImage('active');
  const objects = [lower, active];
  const editor = {
    state:{fgColor:'#336699', brushOpacity:75, brushSize:12, cloneSize:18},
    layers:[
      {name:'Lower', visible:true, locked:false, objects:[lower]},
      {name:'Active', visible:true, locked:false, objects:[active]},
    ],
    activeLayerIdx:1,
    saveHistory:vi.fn(),
    updateLayersPanel:vi.fn(),
    copyObj:vi.fn(),
    pasteObj:vi.fn(),
    duplicateSelected:vi.fn(),
    canvas:{
      add:vi.fn(),
      getActiveObject:vi.fn(() => lower),
      getObjects:vi.fn(() => objects),
      requestRenderAll:vi.fn(),
    },
  };
  return {editor, lower, active};
}

const fabricRef = {
  util:{
    invertTransform:vi.fn(matrix => matrix),
    transformPoint:vi.fn(point => ({x:point.x - 50, y:point.y - 50})),
  },
};

describe('Hstar OpenShop layer-scoped raster tools', () => {
  beforeEach(async () => {
    expect(existsSync(runtimePath), `${runtimePath} should exist`).toBe(true);
    vi.resetModules();
    delete window.HstarOpenShopRasterTools;
    await import(`${pathToFileURL(runtimePath).href}?test=${Date.now()}-${Math.random()}`);
  });

  it('targets only the active layer and paints in place without adding Fabric paths', () => {
    const documentRef = createDocument();
    const {editor, lower, active} = createEditor();
    const controller = window.HstarOpenShopRasterTools.createController({
      editor,
      fabricRef,
      documentRef,
      requestFrame:callback => { callback(); return 1; },
      cancelFrame:vi.fn(),
    });

    expect(controller.begin('brush', {x:10, y:10})).toMatchObject({ok:true, target:active});
    controller.move({x:24, y:28});
    expect(controller.end()).toBe(true);

    expect(active.setElement).toHaveBeenCalledOnce();
    expect(lower.setElement).not.toHaveBeenCalled();
    expect(editor.canvas.add).not.toHaveBeenCalled();
    expect(documentRef.canvases[0].context.assignments).toContain('source-over');
    expect(editor.saveHistory).toHaveBeenCalledTimes(1);
    expect(editor.saveHistory).toHaveBeenCalledWith('Brush');
  });

  it('erases pixels only inside the active layer backing canvas', () => {
    const documentRef = createDocument();
    const {editor, lower, active} = createEditor();
    const controller = window.HstarOpenShopRasterTools.createController({
      editor,
      fabricRef,
      documentRef,
      requestFrame:callback => { callback(); return 1; },
      cancelFrame:vi.fn(),
    });

    controller.begin('eraser', {x:12, y:14});
    controller.move({x:30, y:32});
    controller.end();

    expect(documentRef.canvases[0].context.assignments).toContain('destination-out');
    expect(active.setElement).toHaveBeenCalledOnce();
    expect(lower.setElement).not.toHaveBeenCalled();
    expect(editor.canvas.getObjects()).toHaveLength(2);
    expect(editor.saveHistory).toHaveBeenCalledWith('Eraser');
  });

  it('runs clone stamp as an in-place pixel session without copy or duplicate commands', () => {
    const documentRef = createDocument();
    const {editor, active} = createEditor();
    const controller = window.HstarOpenShopRasterTools.createController({
      editor,
      fabricRef,
      documentRef,
      requestFrame:callback => { callback(); return 1; },
      cancelFrame:vi.fn(),
    });

    expect(controller.setCloneSource({x:20, y:20})).toBe(true);
    expect(controller.begin('clone', {x:50, y:50})).toMatchObject({ok:true, target:active});
    controller.move({x:58, y:58});
    controller.end();

    expect(editor.copyObj).not.toHaveBeenCalled();
    expect(editor.pasteObj).not.toHaveBeenCalled();
    expect(editor.duplicateSelected).not.toHaveBeenCalled();
    expect(editor.canvas.add).not.toHaveBeenCalled();
    expect(editor.saveHistory).toHaveBeenCalledWith('Clone Stamp');
    expect(controller.getState()).toMatchObject({active:false, cloneSource:{x:20, y:20}});
  });
});
