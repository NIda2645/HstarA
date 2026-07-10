import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');

assert.match(js, /function isCanvasNavigationClickTarget\(/, 'canvas click zoom should ignore nodes, menus, and editable UI');
assert.match(js, /function isClassicCanvasNavigationEnabled\(/, 'canvas click zoom should be gated to classic canvases only');
assert.match(js, /\(canvas\.kind \|\| 'classic'\) !== 'smart'/, 'smart canvases should not receive double/triple click zoom gestures');
assert.match(js, /function zoomCanvasToPointAt100\(/, 'double click should zoom canvas to 100% centered on the clicked point');
assert.match(js, /function fitCanvasToAllNodes\(/, 'triple click should fit all active workflow nodes into the viewport');
assert.match(js, /function handleCanvasClickZoomGesture\(/, 'canvas should centralize double/triple click gesture handling');
assert.match(js, /board\.addEventListener\('mouseup',\s*handleCanvasClickZoomGesture/, 'canvas should detect gestures after non-drag left mouse clicks');
assert.match(js, /viewport\.scale\s*=\s*1[\s\S]*centerViewportOnWorldPoint\(point\)/, '100% zoom should keep the clicked world point centered');
assert.match(js, /Math\.min\(rect\.width\s*\/\s*bounds\.w,\s*rect\.height\s*\/\s*bounds\.h\)/, 'fit-all should scale to include the complete node bounds');
assert.match(js, /canvasClickZoomGesture\.count >= 3\)[\s\S]*endDrag\(e\);[\s\S]*fitCanvasToAllNodes\(\)/, 'triple click should release any board pan before fitting all nodes');
assert.doesNotMatch(js, /canvasClickZoomGesture\.count >= 3\)[\s\S]{0,260}e\.stopPropagation\(\)/, 'triple click should not block the existing mouseup cleanup flow');

console.log('canvas click zoom gesture tests passed');
