import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const jsPath = new URL('../../static/js/canvas.js', import.meta.url);
const htmlPath = new URL('../../static/canvas.html', import.meta.url);
const js = readFileSync(jsPath, 'utf8');
const html = readFileSync(htmlPath, 'utf8');
const start = js.indexOf('function positionCanvasMenu(');
const end = js.indexOf('\nfunction openCreateMenu', start);
assert.ok(start >= 0 && end > start, 'positionCanvasMenu should be extractable');

let bounds = {width:320, height:120};
const menu = {
  classList:{add() {}},
  offsetParent:null,
  style:{},
  getBoundingClientRect:() => bounds,
};
const context = {window:{innerWidth:800, innerHeight:600}};
vm.runInNewContext(
  `${js.slice(start, end)}\nthis.positionCanvasMenu = positionCanvasMenu;`,
  context,
  {filename:jsPath.pathname},
);

context.positionCanvasMenu(menu, 790, 590);
assert.equal(menu.style.left, '468px');
assert.equal(menu.style.top, '468px');

bounds = {width:18, height:18};
context.window.innerWidth = 28;
context.window.innerHeight = 28;
context.positionCanvasMenu(menu, 27, 27);
assert.equal(menu.style.left, '5px', 'horizontal margin should shrink to fit an extremely narrow viewport');
assert.equal(menu.style.top, '5px', 'vertical margin should shrink to fit an extremely short viewport');

const createMenuStart = html.indexOf('<div id="createMenu"');
const createMenuEnd = html.indexOf('<div id="linkCreateMenu"', createMenuStart);
assert.ok(createMenuStart >= 0 && createMenuEnd > createMenuStart, 'classic create menu should be extractable');
const createMenuTypes = [...html.slice(createMenuStart, createMenuEnd).matchAll(/menuAdd\('([^']+)'\)/g)]
  .map(match => match[1]);
const generatorIndex = createMenuTypes.indexOf('generator');
assert.ok(generatorIndex >= 0, 'classic create menu should include API generation');
assert.equal(
  createMenuTypes[generatorIndex + 1],
  'openshop-layered',
  'classic create menu should place layered editing directly below API generation',
);

const toolbarStart = html.indexOf('<div class="toolbar-items">');
const toolbarEnd = html.indexOf('<div class="toolbar-fixed">', toolbarStart);
assert.ok(toolbarStart >= 0 && toolbarEnd > toolbarStart, 'classic quick toolbar should be extractable');
const toolbarActions = [...html.slice(toolbarStart, toolbarEnd).matchAll(/onclick="([^"]+)"/g)]
  .map(match => match[1]);
const toolbarGeneratorIndex = toolbarActions.indexOf('addGeneratorNode()');
assert.ok(toolbarGeneratorIndex >= 0, 'classic quick toolbar should include API generation');
assert.equal(
  toolbarActions[toolbarGeneratorIndex + 1],
  'addOpenShopLayeredNode()',
  'classic quick toolbar should place layered editing directly below API generation',
);

const linkOptionsStart = js.indexOf('function linkCreateOptions(');
const linkOptionsEnd = js.indexOf('\nfunction openLinkCreateMenu', linkOptionsStart);
assert.ok(linkOptionsStart >= 0 && linkOptionsEnd > linkOptionsStart, 'link create options should be extractable');
const linkContext = {
  nodes: [
    {id:'source-image', type:'image'},
    {id:'source-prompt', type:'prompt'},
    {id:'target-generator', type:'generator'},
  ],
  tr: key => key,
  CANVAS_GENERATOR_TYPES: ['generator'],
};
vm.runInNewContext(
  `${js.slice(linkOptionsStart, linkOptionsEnd)}\nthis.linkCreateOptions = linkCreateOptions;`,
  linkContext,
  {filename:jsPath.pathname},
);
assert.deepEqual(
  Array.from(linkContext.linkCreateOptions({originId:'source-image', originKind:'out'}), option => option.type).slice(0, 2),
  ['generator', 'openshop-layered'],
  'link create menu should place layered editing directly below API generation',
);
assert.deepEqual(
  Array.from(linkContext.linkCreateOptions({originId:'source-prompt', originKind:'out'}), option => option.type).slice(0, 2),
  ['generator', 'openshop-layered'],
  'non-image link menus should also offer layered editing directly below API generation',
);
assert.deepEqual(
  Array.from(linkContext.linkCreateOptions({originId:'target-generator', originKind:'in'}), option => option.type).slice(0, 3),
  ['image', 'prompt', 'openshop-layered'],
  'generator input menu should place layered editing directly below prompt',
);

const generatorOutputStart = js.indexOf('function generatorNodeOutputOptions(');
const generatorOutputEnd = js.indexOf('\nfunction openGeneratorNodeMenu', generatorOutputStart);
assert.ok(generatorOutputStart >= 0 && generatorOutputEnd > generatorOutputStart, 'generator output options should be extractable');
const generatorOutputContext = {
  CANVAS_IMAGE_OUTPUT_TYPES: ['generator'],
  tr: key => key,
};
vm.runInNewContext(
  `${js.slice(generatorOutputStart, generatorOutputEnd)}\nthis.generatorNodeOutputOptions = generatorNodeOutputOptions;`,
  generatorOutputContext,
  {filename:jsPath.pathname},
);
assert.deepEqual(
  Array.from(generatorOutputContext.generatorNodeOutputOptions({type:'generator'}), option => option.type).slice(0, 3),
  ['output', 'generator', 'openshop-layered'],
  'generator output menu should include layered editing directly below API generation',
);

console.log('classic canvas create-menu viewport tests passed');
