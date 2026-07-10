import assert from 'node:assert/strict';
import fs from 'node:fs';

const canvasJs = fs.readFileSync('static/js/canvas.js', 'utf8');
const smartCanvasJs = fs.readFileSync('static/js/smart-canvas.js', 'utf8');

assert.doesNotMatch(canvasJs, /smart-canvas\.html\?id=\$\{encodeURIComponent\(id\)\}&v=\d+/, 'canvas should not navigate to smart canvas with a stale fixed cache version');
assert.match(canvasJs, /smart-canvas\.html\?id=\$\{encodeURIComponent\(id\)\}&v=\$\{Date\.now\(\)\}/, 'canvas should bust smart canvas navigation cache with Date.now()');
assert.doesNotMatch(smartCanvasJs, /canvas\.html\?v=\d+/, 'pure smart canvas should not return through a stale ordinary-canvas cache URL');
assert.match(smartCanvasJs, /function backToCanvasList\(\)[\s\S]*window\.location\.href = canvasListUrlForProject\(canvas\?\.project \|\| sourceProjectId \|\| 'default'\);/, 'pure smart canvas should return through the canvas list helper');
assert.match(smartCanvasJs, /function canvasListUrlForProject\(projectId\)[\s\S]*\/static\/canvas-list\.html\?project=\$\{encodeURIComponent\(pid\)\}/, 'pure smart canvas should preserve the current project when returning to the canvas list');

console.log('canvas cache busting tests passed');
