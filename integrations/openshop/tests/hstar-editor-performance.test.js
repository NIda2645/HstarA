import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createCanvasMock,
  installFabricMock,
  installModalDelegation,
  loadOpenShop,
  mountEditorDom,
  quietUiMethods,
} from './os-harness.js';

function mountAnalysisPanels() {
  document.body.insertAdjacentHTML('beforeend', `
    <div id="ptg3-nav" class="active">
      <div id="minimap-wrap">
        <canvas id="minimap-canvas" width="240" height="135"></canvas>
        <div id="minimap-vp"></div>
      </div>
      <canvas id="histogram-canvas" width="240" height="80"></canvas>
      <span id="hist-min"></span>
      <span id="hist-mean"></span>
      <span id="hist-max"></span>
    </div>
  `);
  const wrap = document.getElementById('minimap-wrap');
  Object.defineProperties(wrap, {
    clientWidth:{value:240, configurable:true},
    clientHeight:{value:135, configurable:true},
  });
}

function createPreview(width = 320, height = 180) {
  const preview = document.createElement('canvas');
  preview.width = width;
  preview.height = height;
  const context = preview.getContext('2d');
  context.fillStyle = '#336699';
  context.fillRect(0, 0, width, height);
  return preview;
}

describe('OpenShop editor performance paths', () => {
  beforeEach(() => {
    localStorage.clear();
    installFabricMock();
    installModalDelegation();
    mountEditorDom();
  });

  it.each([
    [800, 600],
    [3840, 2160],
    [7680, 4320],
    [10000, 8000],
  ])('builds a bounded analysis preview for %d x %d without a resolution special case', (width, height) => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvasW = width;
    OS.canvasH = height;
    OS._analysisRevision = 7;
    const preview = createPreview(
      Math.max(1, Math.round(width * Math.min(320 / width, 320 / height, 1))),
      Math.max(1, Math.round(height * Math.min(320 / width, 320 / height, 1))),
    );
    OS.canvas.toCanvasElement = vi.fn(() => preview);
    const viewport = [0.5, 0, 0, 0.5, 120, 80];
    OS.canvas.viewportTransform = [...viewport];

    const first = OS._getAnalysisPreview();
    const second = OS._getAnalysisPreview();

    const scale = Math.min(320 / width, 320 / height, 1);
    expect(first).toBe(preview);
    expect(second).toBe(first);
    expect(OS.canvas.toCanvasElement).toHaveBeenCalledOnce();
    expect(OS.canvas.toCanvasElement).toHaveBeenCalledWith(scale, {
      left:0,
      top:0,
      width,
      height,
    });
    expect(OS.canvas.viewportTransform).toEqual(viewport);
    expect(OS.canvas.renderAll).not.toHaveBeenCalled();

    OS._analysisRevision += 1;
    OS._getAnalysisPreview();
    expect(OS.canvas.toCanvasElement).toHaveBeenCalledTimes(2);
  });

  it('shares one revisioned preview between navigator and histogram', () => {
    const OS = loadOpenShop();
    mountAnalysisPanels();
    OS.canvas = createCanvasMock([]);
    OS.canvasW = 7680;
    OS.canvasH = 4320;
    OS.zoom = 0.25;
    OS._analysisRevision = 3;
    OS._histChannel = 'luminance';
    const preview = createPreview(320, 180);
    OS.canvas.toCanvasElement = vi.fn(() => preview);
    OS.canvas.viewportTransform = [0.25, 0, 0, 0.25, -100, -50];
    const viewport = [...OS.canvas.viewportTransform];

    OS._renderMinimap();
    OS._renderHistogram();

    expect(OS.canvas.toCanvasElement).toHaveBeenCalledOnce();
    expect(OS.canvas.viewportTransform).toEqual(viewport);
    expect(OS.canvas.renderAll).not.toHaveBeenCalled();
    expect(document.getElementById('hist-mean').textContent).toContain('Mean:');
  });

  it('routes public navigator and histogram requests through the scheduler', () => {
    const OS = loadOpenShop();
    OS._scheduleUi = vi.fn();

    OS.updateMinimap();
    OS.updateHistogram();

    expect(OS._scheduleUi).toHaveBeenCalledWith('minimap');
    expect(OS._scheduleUi).toHaveBeenCalledWith('histogram');
  });

  it('caches tool DOM, reuses brushes, and skips unchanged object interaction profiles', () => {
    const OS = loadOpenShop();
    const objects = Array.from({length:5000}, (_, index) => ({
      name:`Object ${index}`,
      selectable:false,
      evented:false,
    }));
    const lockedObject = objects.at(-1);
    OS.canvas = createCanvasMock(objects);
    OS.layers = [
      {name:'Content', locked:false, objects:objects.slice(0, -1)},
      {name:'Locked', locked:true, objects:[lockedObject]},
    ];
    quietUiMethods(OS);
    OS._initToolRuntimeCache();
    const queryAll = vi.spyOn(document, 'querySelectorAll');

    OS.setTool('select');
    expect(OS.canvas.forEachObject).toHaveBeenCalledTimes(1);
    expect(objects[0]).toMatchObject({selectable:true, evented:true});
    expect(lockedObject).toMatchObject({selectable:false, evented:false});

    OS.setTool('select');
    expect(OS.canvas.forEachObject).toHaveBeenCalledTimes(1);

    OS.setTool('brush');
    expect(OS.canvas.isDrawingMode).toBe(false);
    expect(OS.canvas.freeDrawingBrush).toBeUndefined();
    expect(OS.canvas.forEachObject).toHaveBeenCalledTimes(2);

    OS.setTool('pencil');
    const pencilBrush = OS.canvas.freeDrawingBrush;
    expect(OS.canvas.forEachObject).toHaveBeenCalledTimes(2);
    OS.setTool('brush');
    expect(OS.canvas.isDrawingMode).toBe(false);
    expect(OS.canvas.freeDrawingBrush).toBe(pencilBrush);
    expect(queryAll).not.toHaveBeenCalled();
  });

  it('keeps brush and eraser outside Fabric free drawing mode', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.layers = [{name:'Content', locked:false, objects:[]}];
    quietUiMethods(OS);

    OS.setTool('eraser');
    expect(OS.canvas.isDrawingMode).toBe(false);
    expect(OS.canvas.freeDrawingBrush).toBeUndefined();
    OS.setTool('brush');
    OS.setTool('eraser');

    expect(OS.canvas.isDrawingMode).toBe(false);
    expect(OS.canvas.freeDrawingBrush).toBeUndefined();
  });

  it('uses frame-coalesced rendering for temporary shape feedback', () => {
    const OS = loadOpenShop();
    document.body.insertAdjacentHTML('beforeend', '<span id="cursor-pos"></span><span id="info-cursor"></span>');
    OS.canvas = createCanvasMock([]);
    OS.canvas.getPointer = vi.fn(() => ({x:120, y:90}));
    OS.state.tool = 'rect';
    OS.state.isDrawing = true;
    OS._shapeStart = {x:10, y:20};
    OS._tempShape = {
      set:vi.fn(),
    };

    OS.onMouseMove({e:{}});

    expect(OS._tempShape.set).toHaveBeenCalled();
    expect(OS.canvas.requestRenderAll).toHaveBeenCalledOnce();
    expect(OS.canvas.renderAll).not.toHaveBeenCalled();
  });

  it('coalesces repeated viewport overlay updates into one animation frame', () => {
    const OS = loadOpenShop();
    OS.canvas = createCanvasMock([]);
    OS.canvas.viewportTransform = [1, 0, 0, 1, 0, 0];
    OS.zoom = 1;
    const frameQueue = [];
    const idleQueue = [];
    OS.drawGrid = vi.fn();
    OS.drawRulers = vi.fn();
    OS._drawPixelGrid = vi.fn();
    OS._updateMinimapViewport = vi.fn();
    OS._initUpdateScheduler({
      frameRequest:callback => { frameQueue.push(callback); return frameQueue.length; },
      idleRequest:callback => { idleQueue.push(callback); return idleQueue.length; },
    });

    for (let index = 0; index < 10; index += 1) {
      OS.onMouseWheel({
        e:{preventDefault:vi.fn(), deltaY:1, offsetX:100, offsetY:80},
      });
    }

    expect(frameQueue).toHaveLength(1);
    expect(OS.drawGrid).not.toHaveBeenCalled();
    frameQueue.shift()();
    expect(OS.drawGrid).toHaveBeenCalledOnce();
    expect(OS.drawRulers).toHaveBeenCalledOnce();
    expect(OS._drawPixelGrid).toHaveBeenCalledOnce();
    expect(OS._updateMinimapViewport).toHaveBeenCalledOnce();
    expect(idleQueue).toHaveLength(0);
  });
});
