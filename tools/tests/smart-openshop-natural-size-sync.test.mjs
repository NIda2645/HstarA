import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const canvasPath = 'static/js/smart-canvas.js';
const adapterPath = 'static/js/smart-canvas-openshop.js';
const canvasSource = fs.readFileSync(canvasPath, 'utf8');
const adapterSource = fs.readFileSync(adapterPath, 'utf8');

const sourceImage = {
  url:'/original.png',
  natural_w:2048,
  natural_h:1152,
  layout_w:520,
  layout_h:293,
};
const layeredNode = {
  id:'openshop-natural-size',
  type:'openshop-layered',
  projectId:'project-natural-size',
  documentWidth:520,
  documentHeight:293,
  layerCount:0,
  saveState:'new',
};

const sandbox = {
  console,
  window:{
    location:{origin:'http://127.0.0.1:3000'},
    frameElement:{id:'frame-smart-canvas'},
    parent:{},
    crypto:{randomUUID:() => 'project-natural-size'},
    HstarSmartCanvasOpenShopHooks:{
      uid:() => 'openshop-natural-size',
      getCanvasId:() => 'canvas-natural-size',
      getNode:id => id === layeredNode.id ? layeredNode : null,
      getConnections:() => [{id:'edge-natural-size', from:'image-source', to:layeredNode.id, kind:'input'}],
      inputImagesForNode:() => [{...sourceImage, nodeId:'image-source', sourceNodeId:'image-source', imageIndex:0}],
      displayMediaUrl:url => url,
      render() {},
      scheduleSave() {},
      t:key => key,
      toast() {},
    },
    addEventListener() {},
  },
  document:{createElement:() => ({className:'', innerHTML:'', querySelector:() => null})},
};
vm.createContext(sandbox);
vm.runInContext(adapterSource, sandbox, {filename:adapterPath});

const html = sandbox.window.HstarSmartOpenShopAdapter.renderNode(layeredNode);
assert.match(html, /2048\s*x\s*1152/, 'OpenShop node metadata must show original image pixels');
assert.doesNotMatch(html, /520\s*x\s*293/, 'OpenShop node metadata must not show canvas layout pixels');

assert.match(canvasSource, /function\s+mediaNaturalSize\s*\(/);
assert.match(canvasSource, /function\s+ensureOpenShopLayeredInputNaturalSizes\s*\(/);
assert.match(canvasSource, /mediaNaturalSize\(sourceImage\)\s*\|\|\s*mediaNaturalSize\(ref\)/);
assert.match(canvasSource, /ensureOpenShopLayeredInputNaturalSizes\(to\)/, 'connecting an upstream image must start natural-size synchronization');
assert.doesNotMatch(
  canvasSource.match(/function\s+openShopLayeredInputSize\s*\([^]*?\n\}/)?.[0] || '',
  /mediaLayoutSize\(/,
  'OpenShop document dimensions must not fall back to node layout size',
);

new vm.Script(canvasSource, {filename:canvasPath});

console.log('Smart OpenShop natural-size synchronization tests passed');
