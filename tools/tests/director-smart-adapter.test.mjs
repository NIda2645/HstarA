import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';

const root = process.cwd();
const read = file => fs.readFileSync(path.join(root, file), 'utf8');

const html = read('static/smart-canvas.html');
const smart = read('static/js/smart-canvas.js');
const directorCss = read('static/css/director-canvas.css');

assert.match(html, /href=["']\/static\/css\/director-canvas\.css(?:\?[^"']*)?["']/, 'smart-canvas.html loads director-canvas.css');
assert.match(html, /src=["']\/static\/js\/director-protocol\.js(?:\?[^"']*)?["']/, 'smart-canvas.html loads director-protocol.js');
assert.match(html, /src=["']\/static\/js\/smart-canvas-director\.js(?:\?[^"']*)?["']/, 'smart-canvas.html loads smart-canvas-director.js');

assert.match(smart, /function\s+createDirector3DNode\s*\(/, 'smart canvas defines createDirector3DNode');
assert.match(smart, /type\s*:\s*['"]director-3d['"]/, 'smart canvas persists director-3d node type');
assert.match(smart, /createNodeFromMenu[\s\S]*['"]director-3d['"][\s\S]*createDirector3DNode/, 'create menu can add director-3d nodes');
assert.match(smart, /3D\s*导演台/, 'smart canvas exposes the 3D导演台 label');
assert.match(smart, /HstarSmartDirectorAdapter\.renderDirectorNode/, 'renderer delegates director-3d body to smart adapter');
assert.match(smart, /function\s+addConnection\s*\([\s\S]*director-3d[\s\S]*HstarSmartDirectorAdapter\.canConnect/, 'addConnection has explicit director-3d handling');
assert.match(smart, /function\s+connectInputNode\s*\([\s\S]*director-3d[\s\S]*HstarSmartDirectorAdapter\.canConnect/, 'connectInputNode has explicit director-3d handling');
assert.match(smart, /HstarSmartDirectorAdapter\.importDirectorCaptures/, 'smart canvas exposes capture import flow');
assert.match(smart, /function\s+drainDirectorStandaloneHandoffs\s*\(/, 'smart canvas drains standalone Director handoffs after canvas data loads');
assert.match(smart, /loadCanvas[\s\S]*drainDirectorStandaloneHandoffs\s*\(/, 'smart canvas imports queued Director screenshots after loading a canvas');
assert.doesNotMatch(smart, /if\(!originNodeId\)\s*return\s+true/, 'smart standalone Director imports are not discarded when origin node is absent');
assert.match(smart, /smartGroupImageRefs|smartGroupBodyHtml/, 'smart canvas keeps grouped image structures available');
assert.match(smart, /saveCanvas\(\)/, 'smart canvas can persist imported Director outputs');

assert.ok(fs.existsSync(path.join(root, 'static/js/smart-canvas-director.js')), 'smart-canvas-director.js exists');
assert.match(directorCss, /\.smart-director-node-card\b[\s\S]*background:\s*var\(--panel\)/, 'smart director node card has a visible panel background');
assert.match(directorCss, /\.smart-director-node-card\b[\s\S]*box-shadow:\s*0 20px 56px var\(--shadow\)/, 'smart director node card matches smart node depth');
assert.match(directorCss, /\.smart-director-node-card\s+\.director-node-status\b[\s\S]*border:\s*1px solid var\(--line\)/, 'smart director status is rendered as an inner card');
assert.match(directorCss, /\.smart-director-node-card\s+\.director-node-open\b[\s\S]*background:\s*var\(--card\)/, 'smart director open action is styled as a button');
assert.match(directorCss, /\.image-node\.director-3d-node\b[\s\S]*background:\s*transparent/, 'smart director node shell stays compatible with smart canvas positioning');

const adapterSrc = read('static/js/smart-canvas-director.js');
const sandbox = {window: {}, console};
vm.createContext(sandbox);
vm.runInContext(adapterSrc, sandbox, {filename: 'smart-canvas-director.js'});

const adapter = sandbox.window.HstarSmartDirectorAdapter;
assert.equal(typeof adapter?.renderDirectorNode, 'function', 'adapter exports renderDirectorNode');
assert.equal(typeof adapter?.resolveDirectorPanorama, 'function', 'adapter exports resolveDirectorPanorama');
assert.equal(typeof adapter?.importDirectorCaptures, 'function', 'adapter exports importDirectorCaptures');
assert.equal(typeof adapter?.canConnect, 'function', 'adapter exports canConnect');

const rendered = adapter.renderDirectorNode({id: 'director-1', type: 'director-3d'});
assert.match(rendered, /data-director-open/, 'adapter render includes open action');
assert.match(rendered, /3D\s*导演台/, 'adapter render includes user-facing label');
assert.match(rendered, /全景|panorama/i, 'adapter render includes panorama status');

assert.equal(adapter.canConnect({type: 'smart-image', images: [{url: '/a.png'}]}, {type: 'director-3d'}), true, 'image-ish input can connect to Director');
assert.equal(adapter.canConnect({type: 'director-3d'}, {type: 'smart-image'}), true, 'Director can connect to grouped output');

let saved = false;
let importArgs = null;
sandbox.window.HstarSmartCanvasDirectorHooks = {
  inputImagesForNode: () => [{url: '/panorama.png', name: 'panorama.png'}],
  importDirectorCapturesAsGroup: args => {
    importArgs = args;
    saved = true;
    return {id: 'smart-output', type: 'smart-image', images: args.captures};
  }
};

assert.equal(adapter.resolveDirectorPanorama({id: 'director-1'})?.url, '/panorama.png', 'adapter resolves one connected panorama image');
const imported = await adapter.importDirectorCaptures({
  originNodeId: 'director-1',
  requestId: 'request-1',
  captures: [
    {url: '/one.png', name: 'one.png'},
    {url: '/two.png', name: 'two.png'},
    {url: '/three.png', name: 'three.png'},
    {url: '/four.png', name: 'four.png'},
    {url: '/five.png', name: 'five.png'}
  ]
});
assert.equal(imported?.id, 'smart-output', 'adapter creates one grouped output node');
assert.equal(importArgs.captures.length, 5, 'adapter forwards arbitrary multi-capture batches as one group');
assert.equal(saved, true, 'adapter delegates to save-capable smart canvas hook');
