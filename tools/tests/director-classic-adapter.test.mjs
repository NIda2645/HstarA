import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('static/canvas.html');
const canvas = read('static/js/canvas.js');

assert.match(html, /href=["']\/static\/css\/director-canvas\.css(?:\?[^"']*)?["']/, 'canvas.html loads director-canvas.css');
assert.match(html, /src=["']\/static\/js\/director-protocol\.js(?:\?[^"']*)?["']/, 'canvas.html loads director-protocol.js');
assert.match(html, /src=["']\/static\/js\/canvas-director\.js(?:\?[^"']*)?["']/, 'canvas.html loads canvas-director.js');

assert.match(canvas, /function\s+addDirector3DNode\s*\(/, 'classic canvas defines addDirector3DNode');
assert.match(canvas, /type\s*:\s*['"]director-3d['"]/, 'classic canvas persists director-3d node type');
assert.match(canvas, /createNodeByType[\s\S]*['"]director-3d['"][\s\S]*addDirector3DNode/, 'createNodeByType creates director-3d nodes');
assert.match(canvas, /menuAdd[\s\S]*['"]director-3d['"][\s\S]*addDirector3DNode/, 'create menu can add director-3d nodes');
assert.match(canvas, /3D\s*导演台/, 'classic canvas exposes the 3D导演台 label');
assert.match(canvas, /HstarClassicDirectorAdapter\??\.renderDirectorNode/, 'renderNode delegates director-3d body to adapter');
assert.match(canvas, /HstarClassicDirectorAdapter\??\.openDirectorNode/, 'classic canvas has an open Director action');
assert.match(canvas, /HstarClassicDirectorAdapter\??\.canConnect/, 'canConnect delegates director-3d connection rules to adapter');
assert.match(canvas, /HstarClassicDirectorAdapter\??\.importDirectorCaptures/, 'classic canvas exposes capture import flow');
assert.match(canvas, /function\s+drainDirectorStandaloneHandoffs\s*\(/, 'classic canvas drains standalone Director handoffs after canvas data loads');
assert.match(canvas, /openCanvas[\s\S]*drainDirectorStandaloneHandoffs\s*\(/, 'classic canvas imports queued Director screenshots after opening a canvas');

assert.ok(fs.existsSync(path.join(root, 'static/js/canvas-director.js')), 'canvas-director.js exists');
assert.ok(fs.existsSync(path.join(root, 'static/css/director-canvas.css')), 'director-canvas.css exists');

const adapter = read('static/js/canvas-director.js');
assert.match(adapter, /window\.HstarClassicDirectorAdapter/, 'adapter exports HstarClassicDirectorAdapter');
assert.match(adapter, /function\s+renderDirectorNode\s*\(/, 'adapter renders director node body');
assert.match(adapter, /function\s+resolveDirectorPanorama\s*\(/, 'adapter resolves one panorama input');
assert.match(adapter, /function\s+importDirectorCaptures\s*\(/, 'adapter imports returned captures');
assert.match(adapter, /if\(!captures\.length\)/, 'adapter rejects empty capture batches');

const sandbox = {
  window: { addEventListener() {} },
  console,
  alert(message){ throw new Error(message); },
  nodes: [],
  connections: [],
  selected: new Set(),
  uid(prefix='id'){
    sandbox.uidCounts[prefix] = (sandbox.uidCounts[prefix] || 0) + 1;
    return `${prefix}_${sandbox.uidCounts[prefix]}`;
  },
  uidCounts: {},
  pushUndo(){},
  render(){},
  scheduleSave(){},
  saveCanvas(){ return Promise.resolve(); },
};
vm.createContext(sandbox);
vm.runInContext(adapter, sandbox, {filename: 'canvas-director.js'});
const standaloneImage = await sandbox.window.HstarClassicDirectorAdapter.importDirectorCaptures({
  requestId: 'standalone-1',
  captures: [{url: '/director-one.png', name: 'one.png'}]
});
assert.equal(standaloneImage?.type, 'image', 'classic adapter imports one standalone capture as an image node');
assert.equal(standaloneImage.url, '/director-one.png', 'classic standalone image keeps the screenshot URL');
assert.equal(standaloneImage.directorRequestId, 'standalone-1', 'classic standalone image keeps director request metadata');
assert.equal(sandbox.nodes.filter(node => node.type === 'output').length, 0, 'classic standalone import does not create output nodes');

sandbox.nodes = [{id:'dir_1', type:'director-3d', x:120, y:80, w:320}];
sandbox.connections = [];
sandbox.selected = new Set();
sandbox.uidCounts = {};
const batchGroup = await sandbox.window.HstarClassicDirectorAdapter.importDirectorCaptures({
  requestId: 'node-batch-1',
  originNodeId: 'dir_1',
  captures: [
    {url: '/director-a.png', name: 'a.png'},
    {url: '/director-b.png', name: 'b.png'},
    {url: '/director-c.png', name: 'c.png'},
    {url: '/director-d.png', name: 'd.png'},
  ]
});
const groupedImages = sandbox.nodes.filter(node => node.type === 'image' && node.directorSourceNodeId === 'dir_1');
assert.equal(batchGroup?.type, 'group', 'classic adapter imports multiple captures as an image group');
assert.deepEqual(batchGroup.items, groupedImages.map(node => node.id), 'classic director group tracks every imported image node');
assert.equal(groupedImages.length, 4, 'classic director batch creates one image node per screenshot');
assert.ok(sandbox.connections.some(conn => conn.from === 'dir_1' && conn.to === batchGroup.id), 'classic director source connects to the imported image group');
assert.equal(sandbox.nodes.filter(node => node.type === 'output').length, 0, 'classic node import does not create output nodes');
