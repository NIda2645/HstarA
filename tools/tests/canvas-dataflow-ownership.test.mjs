import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const canvasSource = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const smartCanvasSource = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const startIndex = source.indexOf(start);
  assert.ok(startIndex >= 0, `section start boundary should exist: ${start}`);

  const endIndex = source.indexOf(end, startIndex + start.length);
  assert.ok(endIndex > startIndex, `section end boundary should follow ${start}: ${end}`);

  return source.slice(startIndex, endIndex);
}

const canvasControllerPrompts = section(
  canvasSource,
  'function activeControllerPromptsForGeneration',
  'function activeMaterialDirectiveForMarkers',
);
assert.match(
  canvasControllerPrompts,
  /upstreamControllerPromptsForTarget\(targetNode,\s*sources,\s*graph\)/,
  'ordinary controller prompts should come from the target upstream traversal',
);
assert.doesNotMatch(
  canvasControllerPrompts,
  /\bnodes\s*\.\s*(?:find|filter)\s*\(/,
  'ordinary controller prompts must not scan the whole canvas',
);

const canvasMarkerMaterials = section(
  canvasSource,
  'function activeMaterialDirectiveForMarkers',
  'function markerReferenceDirective',
);
assert.match(
  canvasMarkerMaterials,
  /const\s+ctrl\s*=\s*direct\s*\?\s*nodes\s*\.\s*find\s*\(\s*\w+\s*=>\s*\w+\.id\s*===\s*direct\.id\s*\)\s*:\s*null/,
  'ordinary marker materials should resolve only their directly connected controller source',
);
assert.doesNotMatch(
  canvasMarkerMaterials,
  /:\s*nodes\s*\.\s*find\s*\(/,
  'ordinary marker materials must not fall back to a canvas-wide node lookup',
);
assert.equal(
  canvasMarkerMaterials.match(/\bnodes\s*\.\s*find\s*\(/g)?.length ?? 0,
  1,
  'ordinary marker materials must not add a second canvas-wide controller lookup',
);

const canvasGeneratorSources = section(
  canvasSource,
  'function generatorSources',
  'function orderedSources',
);
assert.match(
  canvasGeneratorSources,
  /return\s+connections\s*\.\s*filter\s*\(\s*\w+\s*=>\s*\w+\.to\s*===\s*gen\.id\s*\)\s*\.\s*map\s*\(/,
  'ordinary generator sources should derive inputs from connections targeting the generator',
);
assert.doesNotMatch(
  canvasGeneratorSources,
  /\bnodes\s*\.\s*(?:find|filter)\s*\([^)]*\b(?:selected|active|running)\b[^)]*\)/i,
  'ordinary generator sources must not use selected, active, or running canvas nodes as fallback inputs',
);

const smartControllerPrompts = section(
  smartCanvasSource,
  'function activeControllerPromptsForGeneration',
  'function activeMaterialDirectiveForMarkers',
);
assert.match(
  smartControllerPrompts,
  /upstreamControllerPromptsForTarget\(targetNode,\s*sources,\s*graph\)/,
  'smart controller prompts should come from the target upstream traversal',
);
assert.doesNotMatch(
  smartControllerPrompts,
  /\bnodes\s*\.\s*(?:find|filter)\s*\(/,
  'smart controller prompts must not scan the whole canvas',
);

const smartUpstreamNodes = section(
  smartCanvasSource,
  'function upstreamNodesForKinds',
  'function clearDetachedRunInputRefs',
);
assert.match(
  smartUpstreamNodes,
  /conn\.to\s*===\s*node\.id/,
  'smart upstream traversal should collect only connections targeting the node',
);
assert.match(
  smartUpstreamNodes,
  /\[\.\.\.ids\]\s*\.\s*map\s*\(\s*id\s*=>\s*nodes\.find\s*\(\s*n\s*=>\s*n\.id\s*===\s*id\s*\)\s*\)\s*\.\s*filter\s*\(Boolean\)/,
  'smart upstream traversal should resolve only the collected source IDs to nodes',
);
assert.doesNotMatch(
  smartUpstreamNodes,
  /\bselectedNode\b/,
  'smart upstream traversal must not use the selected node as a fallback input',
);
assert.doesNotMatch(
  smartUpstreamNodes,
  /\bnodes\s*\.\s*(?:find|filter)\s*\([^)]*\b(?:active|running)\b[^)]*\)/i,
  'smart upstream traversal must not use active or running canvas nodes as fallback inputs',
);

const smartDetachedRefs = section(
  smartCanvasSource,
  'function clearDetachedRunInputRefs',
  'function cleanupDetachedRunInputRefs',
);
assert.match(
  smartDetachedRefs,
  /conn\.to\s*===\s*node\.id/,
  'smart detached-input cleanup should determine ownership from inbound connections',
);
assert.match(
  smartDetachedRefs,
  /if\s*\(hasUpstream[\s\S]*?\)\s*return;[\s\S]*?delete\s+node\.runInputRefs;[\s\S]*?delete\s+node\.runPromptRefs;[\s\S]*?delete\s+node\.sourceNodeId;/,
  'smart detached-input cleanup should delete run refs and source ownership only after upstream inputs are absent',
);

console.log('Canvas dataflow ownership tests passed');
