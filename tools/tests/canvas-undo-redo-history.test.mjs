import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const canvasJs = readFileSync('static/js/canvas.js', 'utf8');
const smartJs = readFileSync('static/js/smart-canvas.js', 'utf8');

assert.match(canvasJs, /const\s+(?:CANVAS_)?UNDO_MAX\s*=\s*10|const\s+UNDO_LIMIT\s*=\s*10/, 'ordinary canvas should limit undo history to 10 entries');
assert.match(canvasJs, /redoStack/, 'ordinary canvas should keep a redo stack');
assert.match(canvasJs, /canvasId\s*:\s*(?:canvas\?\.id|canvasId)/, 'ordinary canvas snapshots should carry the current canvas id');
assert.match(canvasJs, /state\.canvasId\s*!==\s*(?:canvas\?\.id|canvasId)|snap\.canvasId\s*!==\s*(?:canvas\?\.id|canvasId)/, 'ordinary canvas restore should reject snapshots from another canvas');
assert.match(canvasJs, /function\s+resetCanvasHistory\(/, 'ordinary canvas should reset undo and redo stacks when a canvas is opened or loaded');
assert.match(canvasJs, /function\s+performRedo\(/, 'ordinary canvas should implement redo');
assert.match(canvasJs, /matchShortcutEvent\(e,\s*'undo'\)/, 'ordinary canvas should route configured undo shortcut through the keydown handler');
assert.match(canvasJs, /matchShortcutEvent\(e,\s*'redo'\)/, 'ordinary canvas should route configured redo shortcut through the keydown handler');
assert.match(canvasJs, /if\(e\.repeat\) return;/, 'ordinary canvas should ignore repeated keydown events for undo or redo');
assert.match(canvasJs, /pushUndo\(\)[\s\S]*redoStack\s*=\s*\[\]/, 'ordinary canvas should clear redo when a new undo snapshot is pushed');

assert.match(smartJs, /const\s+UNDO_LIMIT\s*=\s*40/, 'pure smart canvas should keep its original undo history depth');
assert.match(smartJs, /function\s+snapshotForUndo\(/, 'pure smart canvas should snapshot state for undo');
assert.match(smartJs, /function\s+pushUndo\(\)[\s\S]*if\(undoStack\.length > UNDO_LIMIT\) undoStack\.shift\(\)/, 'pure smart canvas should cap undo history');
assert.match(smartJs, /function\s+performUndo\(/, 'pure smart canvas should implement undo');

console.log('canvas undo/redo history tests passed');
