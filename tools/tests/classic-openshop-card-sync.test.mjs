import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const adapterPath = 'static/js/canvas-openshop.js';
const canvasPath = 'static/js/canvas.js';
const cssPath = 'static/css/canvas.css';
const adapterSource = fs.readFileSync(adapterPath, 'utf8');
const canvasSource = fs.readFileSync(canvasPath, 'utf8');
const cssSource = fs.readFileSync(cssPath, 'utf8');
const canvasHtml = fs.readFileSync('static/canvas.html', 'utf8');

const sourceNode = {
  id:'classic-source',
  type:'image',
  url:'/original.png',
  natural_w:2048,
  natural_h:1152,
  w:520,
  h:293,
};
const layeredNode = {
  id:'classic-openshop',
  type:'openshop-layered',
  projectId:'classic-project',
  projectName:'图文分层项目',
  documentWidth:520,
  documentHeight:293,
  layerCount:0,
  saveState:'new',
  w:340,
  h:260,
};
let connections = [{id:'classic-edge', from:sourceNode.id, to:layeredNode.id}];

const sandbox = {
  console,
  document:{
    createElement:() => ({className:'', innerHTML:'', querySelector:() => null}),
  },
  window:{
    location:{origin:'http://127.0.0.1:3000'},
    frameElement:{id:'frame-canvas'},
    parent:{},
    crypto:{randomUUID:() => 'classic-project'},
    HstarClassicOpenShopHooks:{
      getNodes:() => [sourceNode, layeredNode],
      getConnections:() => connections,
      mediaRefsFromNode:node => node?.url ? [{url:node.url, name:'原图.png', kind:'image'}] : [],
      mediaKindForRef:ref => ref.kind || 'image',
      sourceSizeForNode:() => ({width:sourceNode.natural_w, height:sourceNode.natural_h}),
      displayMediaUrl:url => url,
      t:key => key,
    },
    addEventListener() {},
  },
};
vm.createContext(sandbox);
vm.runInContext(adapterSource, sandbox, {filename:adapterPath});

const adapter = sandbox.window.HstarClassicOpenShopAdapter;
const createdNode = adapter.createNode({x:12, y:34});
assert.deepEqual(
  {...adapter.layoutForNode(createdNode)},
  {width:260, height:417, previewWidth:260, previewHeight:347, aspectRatio:3 / 4},
  'new classic OpenShop cards must start with a 3:4 preview',
);
const sourceLayout = adapter.layoutForNode(layeredNode);
assert.deepEqual(
  {...sourceLayout},
  {width:340, height:261, previewWidth:340, previewHeight:191, aspectRatio:16 / 9},
  'classic OpenShop card must follow the first upstream image aspect ratio',
);

const rendered = adapter.renderNode(layeredNode);
assert.match(rendered.innerHTML, /2048\s*x\s*1152/, 'metadata must show original image pixels');
assert.doesNotMatch(rendered.innerHTML, /520\s*x\s*293/, 'metadata must not show canvas layout pixels');

sourceNode.natural_w = 1000;
sourceNode.natural_h = 2500;
const portraitLayout = adapter.layoutForNode(layeredNode);
assert.deepEqual(
  {...portraitLayout},
  {width:340, height:920, previewWidth:340, previewHeight:850, aspectRatio:2 / 5},
  'the first upstream image must drive the exact card aspect ratio without preset clamping',
);
assert.match(adapter.renderNode(layeredNode).innerHTML, /1000\s*x\s*2500/);

connections = [];
const emptyLayout = adapter.layoutForNode({...layeredNode, previewUrl:'', layerCount:0});
assert.deepEqual(
  {...emptyLayout},
  {width:260, height:417, previewWidth:260, previewHeight:347, aspectRatio:3 / 4},
  'empty classic OpenShop cards must default to a 3:4 preview',
);
const emptyRendered = adapter.renderNode({...layeredNode, previewUrl:'', layerCount:0});
assert.match(emptyRendered.innerHTML, /520\s*x\s*293/, 'disconnected cards must use their own document dimensions');
assert.doesNotMatch(emptyRendered.innerHTML, /2048\s*x\s*1152/, 'disconnected cards must not retain stale upstream dimensions');

assert.match(canvasSource, /function\s+ensureOpenShopLayeredInputNaturalSizes\s*\(/);
assert.match(canvasSource, /ensureOpenShopLayeredInputNaturalSizes\(to\)/, 'connecting an image must start natural-size synchronization');
assert.match(canvasSource, /HstarClassicOpenShopAdapter\?\.layoutForNode\?\.\(node\)/, 'classic render must use the adaptive OpenShop layout');
assert.doesNotMatch(cssSource, /\.openshop-layered-node\s*\{[^}]*width:\s*340px[^}]*height:\s*260px/s);
assert.match(cssSource, /\.openshop-layered-node[^\{]*\{[^}]*min-width:\s*240px/s);
assert.match(cssSource, /\.openshop-layered-node\s+\.node-delete[^\{]*\{[^}]*background:/s);
assert.ok(
  canvasHtml.indexOf('/static/js/canvas-openshop.js') < canvasHtml.indexOf('/static/js/canvas.js'),
  'the classic OpenShop adapter must be ready before the canvas performs its initial render',
);

new vm.Script(canvasSource, {filename:canvasPath});
console.log('Classic OpenShop card synchronization tests passed');
