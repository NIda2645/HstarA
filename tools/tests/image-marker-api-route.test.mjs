import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const py = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');
const canvasJs = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const smartJs = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');

assert.match(canvasJs, /fetch\('\/api\/image-marker\/identify'/, 'normal canvas should call the marker identify endpoint');
assert.match(smartJs, /fetch\('\/api\/image-marker\/identify'/, 'smart canvas marker mode should call the shared marker identify endpoint');
assert.match(
  py,
  /@app\.post\(["']\/api\/image-marker\/identify["']\)\s*\nasync def identify_image_marker\(payload: ImageMarkerIdentifyRequest\):/,
  'backend should register the image marker identify endpoint used by both canvases',
);
const markerRouteStart = py.indexOf('@app.post("/api/image-marker/identify")');
const markerRouteEnd = py.indexOf('@app.post("/api/smart-image/text/recognize")', markerRouteStart);
const markerRoute = py.slice(markerRouteStart, markerRouteEnd);
assert.match(markerRoute, /is_gemini_cli_provider\(/, 'marker recognition should detect the Antigravity CLI provider');
assert.match(markerRoute, /gemini_cli_chat_text\(/, 'marker recognition should use the Antigravity CLI chat adapter');

console.log('image marker API route tests passed');
