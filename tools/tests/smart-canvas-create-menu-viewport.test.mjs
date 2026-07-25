import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const jsPath = new URL('../../static/js/smart-canvas.js', import.meta.url);
const cssPath = new URL('../../static/css/smart-canvas.css', import.meta.url);
const js = readFileSync(jsPath, 'utf8');
const css = readFileSync(cssPath, 'utf8');

const start = js.indexOf('function openCreateMenu(');
const end = js.indexOf('\nfunction addCreatedNodeToMenuGroup', start);
assert.ok(start >= 0 && end > start, 'openCreateMenu should be extractable');

const state = new Set();
const menu = {
  classList: {
    add(name) { state.add(name); },
    remove(name) { state.delete(name); },
  },
  getBoundingClientRect() {
    assert.equal(state.has('open'), true, 'menu should be open before measurement');
    return {width:320, height:120};
  },
  offsetWidth: 999,
  offsetHeight: 999,
  style: {},
};
const context = {
  createMenu: menu,
  createMenuPoint: {x:0, y:0},
  createMenuGroupId: '',
  screenToWorld: () => ({x:42, y:84}),
  refreshIcons() {},
  window: {innerWidth:800, innerHeight:600},
};
vm.runInNewContext(
  `${js.slice(start, end)}\nthis.openCreateMenu = openCreateMenu;`,
  context,
  {filename:jsPath.pathname},
);

context.openCreateMenu({clientX:700, clientY:550}, {groupId:'group-1'});

assert.equal(menu.style.left, '466px', 'menu left should be clamped using rendered width');
assert.equal(menu.style.top, '466px', 'menu top should be clamped using rendered height');
assert.equal(state.has('open'), true, 'menu should be open before its rendered size is measured');
assert.deepEqual(context.createMenuPoint, {x:42, y:84});
assert.equal(context.createMenuGroupId, 'group-1');

menu.getBoundingClientRect = () => ({width:18, height:18});
context.window.innerWidth = 28;
context.window.innerHeight = 28;
context.openCreateMenu({clientX:27, clientY:27});
assert.equal(menu.style.left, '5px', 'horizontal margin should shrink to fit an extremely narrow viewport');
assert.equal(menu.style.top, '5px', 'vertical margin should shrink to fit an extremely short viewport');

assert.match(css, /\.create-menu\s*\{[^}]*max-height:\s*calc\(100vh\s*-\s*28px\)/s);
assert.match(css, /\.create-menu\s*\{[^}]*overflow-y:\s*auto/s);
assert.match(
  js,
  /shell\.addEventListener\('wheel',[\s\S]*?e\.target\.closest\([^)]*\.create-menu[^)]*\)\) return;/,
  'wheel events inside the create menu should scroll the menu instead of zooming the canvas',
);

console.log('smart canvas create-menu viewport tests passed');
