import assert from 'node:assert/strict';
import fs from 'node:fs';

const classic = fs.readFileSync('static/js/canvas.js', 'utf8');
const smart = fs.readFileSync('static/js/smart-canvas.js', 'utf8');

assert.match(
  classic,
  /function\s+removeDirectorSceneStorageForNode\s*\(/,
  'classic canvas defines a director scene cleanup helper',
);
assert.match(
  classic,
  /function\s+deleteNode\s*\([^)]*\)\s*\{[\s\S]*?removeDirectorSceneStorageForNode\s*\(/,
  'classic canvas clears node-scoped director data when deleting a director node',
);
assert.match(
  classic,
  /storyai-3d-director-desk-demo:/,
  'classic canvas removes the same scoped storage prefix used by the director desk store',
);

assert.match(
  smart,
  /function\s+removeDirectorSceneStorageForNode\s*\(/,
  'smart canvas defines a director scene cleanup helper',
);
assert.match(
  smart,
  /function\s+deleteNode\s*\([^)]*\)\s*\{[\s\S]*?removeDirectorSceneStorageForNode\s*\(/,
  'smart canvas clears node-scoped director data when deleting a director node',
);
assert.match(
  smart,
  /storyai-3d-director-desk-demo:/,
  'smart canvas removes the same scoped storage prefix used by the director desk store',
);
