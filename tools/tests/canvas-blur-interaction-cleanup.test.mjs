import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const classic = readFileSync('static/js/canvas.js', 'utf8');
const smart = readFileSync('static/js/smart-canvas.js', 'utf8');

assert.match(
  classic,
  /window\.addEventListener\('blur',[\s\S]{0,240}endDrag\(/,
  'classic canvas blur must finish node, resize, pan, knife, and connection drags',
);
assert.match(
  smart,
  /function\s+finishSmartPointerInteraction\s*\(/,
  'smart canvas must use one complete pointer-interaction termination path',
);
assert.match(
  smart,
  /window\.onmouseup\s*=\s*finishSmartPointerInteraction/,
  'smart canvas mouseup must use the shared termination path',
);
assert.match(
  smart,
  /window\.addEventListener\('blur',[\s\S]{0,240}finishSmartPointerInteraction\(/,
  'smart canvas blur must use the shared termination path',
);

console.log('canvas blur interaction cleanup tests passed');
