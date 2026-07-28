import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const classic = readFileSync('static/js/canvas.js', 'utf8');
const smart = readFileSync('static/js/smart-canvas.js', 'utf8');

function extractFunction(source, declaration) {
  const start = source.indexOf(declaration);
  assert.ok(start >= 0, `${declaration} should exist`);
  const bodyStart = source.indexOf('{', start);
  let depth = 0;
  for(let index = bodyStart; index < source.length; index += 1) {
    if(source[index] === '{') depth += 1;
    else if(source[index] === '}') {
      depth -= 1;
      if(depth === 0) return source.slice(start, index + 1);
    }
  }
  throw new Error(`${declaration} has no closing brace`);
}

const classicFlush = extractFunction(classic, 'window.hstarFlushCanvasSave = async function(');
const smartFlush = extractFunction(smart, 'window.hstarFlushCanvasSave = async function(');
const classicSave = extractFunction(classic, 'async function saveCanvas(');
const classicBack = extractFunction(classic, 'async function returnToCanvasManager(');
const smartSave = extractFunction(smart, 'async function saveCanvas(');
const smartBackDeclaration = smart.includes('async function backToCanvasList(')
  ? 'async function backToCanvasList('
  : 'function backToCanvasList(';
const smartBack = extractFunction(smart, smartBackDeclaration);

assert.match(classicFlush, /if\(!canvas \|\| applyingRemoteCanvas\) return true;/);
assert.match(classicFlush, /saveCanvasAgain = false;/);
assert.match(
  classicFlush,
  /return await saveCanvas\(\)/,
  'classic canvas flush should expose whether persistence succeeded',
);
assert.match(
  classicBack,
  /const saved = await saveCanvas\(\);\s*if\(!saved\) return;/,
  'classic canvas should stay open when its final save fails',
);
assert.match(classicSave, /if\(!res\.ok\) throw new Error\('save failed'\);[\s\S]*return true;/);
assert.match(classicSave, /catch\(e\) \{[\s\S]*return false;/);

assert.doesNotMatch(
  smartFlush,
  /\b(?:applyingRemoteCanvas|saveCanvasAgain)\b/,
  'smart canvas flush must not reference state that only exists in the classic canvas',
);
assert.match(
  smartFlush,
  /if\(!canvas \|\| !smartLocalDirty\) return true;/,
  'smart canvas flush should skip the network request when no local changes are pending',
);
assert.match(
  smartFlush,
  /return await saveCanvas\(\)/,
  'smart canvas flush should expose whether persistence succeeded',
);
assert.match(
  smartBack,
  /^async function backToCanvasList\(/,
  'smart canvas back navigation should be asynchronous so it can await persistence',
);
assert.match(
  smartBack,
  /const saved = await window\.hstarFlushCanvasSave\(\);\s*if\(!saved\) return;/,
  'smart canvas should stay open when its final save fails',
);
assert.match(
  smartSave,
  /if\(res\.ok\)\{[\s\S]*return true;[\s\S]*else if\(res\.status === 409\)/,
  'smart canvas save should report a successful write',
);
assert.match(
  smartSave,
  /else \{\s*throw new Error\('save failed'\);\s*\}/,
  'smart canvas should not silently ignore non-conflict save failures',
);
assert.match(smartSave, /catch\(e\) \{[\s\S]*return false;/);
assert.match(
  smartBack,
  /await window\.hstarFlushCanvasSave\(\)/,
  'smart canvas should finish its pending save before navigating back to the canvas list',
);

console.log('canvas flush save tests passed');
