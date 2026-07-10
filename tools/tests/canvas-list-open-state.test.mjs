import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');

assert.match(js, /let openingCanvasId = '';/, 'canvas gate should track the card currently being opened');
assert.match(js, /const isActiveCanvas = \(canvas\?\.id === item\.id\) \|\| \(openingCanvasId === item\.id\);/, 'opening canvas card should share the normal active visual state');
assert.match(js, /row\.className = `canvas-item [^`]*\$\{isActiveCanvas \? 'active' : ''\}/, 'canvas card active class should come from the combined active state');
assert.match(js, /function updateCanvasListRecord\(record, \{renderList=true\}=\{\}\)/, 'canvas list record updates should support silent in-memory updates');
assert.match(js, /if\(renderList\) renderCanvasList\(\);/, 'silent canvas list updates should avoid repainting the gate list');
assert.match(js, /async function touchCanvasOpened\(id, \{renderList=true\}=\{\}\)/, 'opening touch should expose a renderList option');
assert.match(js, /updateCanvasListRecord\(data\.canvas, \{renderList\}\)/, 'opening touch should forward the render option to the list updater');
assert.match(js, /async function openCanvas\(id\)\{\s*openingCanvasId = id \|\| '';\s*renderCanvasList\(\);/, 'clicking a canvas should immediately paint that card as selected');
assert.match(js, /const touched = await touchCanvasOpened\(canvas\.id, \{renderList:false\}\);/, 'opening a canvas should not repaint and reorder the selection list before entering');
assert.match(js, /selected\.clear\(\);\s*openingCanvasId = '';\s*setCanvasMode\(true\);/, 'classic canvas entry should clear the temporary opening state');
assert.match(js, /catch\(e\) \{\s*openingCanvasId = '';\s*renderCanvasList\(\);/, 'failed opens should clear the temporary opening state');

console.log('canvas list open state tests passed');
