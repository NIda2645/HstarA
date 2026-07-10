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

console.log('image marker API route tests passed');
