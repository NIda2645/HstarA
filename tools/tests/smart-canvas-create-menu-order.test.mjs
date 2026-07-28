import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync(new URL('../../static/smart-canvas.html', import.meta.url), 'utf8');
const menu = html.match(/<div id="createMenu"[\s\S]*?<div id="controllerPanel"/)?.[0] || '';
const order = [...menu.matchAll(/data-create-type="([^"]+)"/g)].map(match => match[1]);

assert.deepEqual(order, [
  'image',
  'group',
  'prompt',
  'director-3d',
  'openshop-layered',
  'loop',
  'controller',
]);

console.log('smart canvas create-menu order tests passed');
