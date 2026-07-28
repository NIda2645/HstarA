import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/canvas-list.js', import.meta.url), 'utf8');

assert.match(
  js,
  /function attachCreateCardDrag\(card, position\)/,
  'new-canvas card should have dedicated drag handling',
);
assert.match(
  js,
  /closest\('input, button, select, textarea, \[contenteditable="true"\]'\)/,
  'new-canvas card drag should leave form controls interactive',
);
assert.match(
  js,
  /position\.x = originX \+ deltaX;[\s\S]*position\.y = originY \+ deltaY;[\s\S]*card\.style\.left = `\$\{position\.x\}px`;[\s\S]*card\.style\.top = `\$\{position\.y\}px`;/,
  'dragging should update both the card position and its creation coordinates',
);
assert.match(
  js,
  /attachCreateCardDrag\(el, position\);/,
  'new-canvas card should activate drag handling when opened',
);
assert.match(
  js,
  /createCanvasOnBoard\(input\.value\.trim\(\), createKind, position\)/,
  'canvas creation should use the card position after dragging',
);

console.log('canvas-list create-card drag tests passed');
