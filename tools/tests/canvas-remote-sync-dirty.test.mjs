import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync('static/js/canvas.js', 'utf8');
const start = js.indexOf('function handleCanvasUpdatedMessage');
const end = js.indexOf('async function returnToCanvasManager', start);
assert.ok(start >= 0 && end > start, 'ordinary canvas remote update handler should be present');

const handler = js.slice(start, end);
const guardIndex = handler.search(/localCanvasDirty\s*\|\|\s*saveTimer\s*\|\|\s*savingCanvasNow\s*\|\|\s*saveCanvasAgain/);
const clearDirtyIndex = handler.indexOf('localCanvasDirty = false');

assert.ok(guardIndex >= 0, 'ordinary canvas should defer remote sync while local node edits are pending');
assert.ok(clearDirtyIndex < 0 || guardIndex < clearDirtyIndex, 'ordinary canvas should check local dirty state before clearing it for remote sync');

console.log('ordinary canvas dirty remote sync tests passed');
