import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const canvasSource = readFileSync(resolve('static/js/canvas.js'), 'utf8');

assert.doesNotMatch(
  canvasSource,
  /media\.visiblePromptInputsForNode\(/,
  'RunningHub model previews must call the shared prompt-input helper directly',
);

const modelPreviewCalls = canvasSource.match(
  /renderPromptPreview\([^;]+visiblePromptInputsForNode\(media\.sources\)\)/g,
) || [];

assert.equal(
  modelPreviewCalls.length,
  2,
  'initial and incremental RunningHub renders must derive prompt previews from media.sources',
);

console.log('RunningHub model prompt preview tests passed');
