import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
assert.match(source, /if\(n\.type === 'image' && n\.url\)[\s\S]*?refs:\[imageRefWithMarkers\(n/, 'image generator sources should preserve marker metadata');
assert.match(source, /items\.filter\(x => x\.type === 'image' && x\.url\)[\s\S]*?refs:\[imageRefWithMarkers\(img/, 'group image generator sources should preserve marker metadata');
assert.match(source, /function promptRichHtmlFromText\(text='', promptNode=null\)\{[\s\S]*if\(!exactMarkers\.length\) return escapeHtml\(text \|\| ''\)\.replace/, 'prompt rich renderer should not auto-chip stale marker text when no live marker candidates exist');
const match = source.match(/\/\/ PROMPT_MARKER_LOGIC_START([\s\S]*?)\/\/ PROMPT_MARKER_LOGIC_END/);
assert.ok(match, 'prompt marker logic export block should exist');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${match[1]}\nthis.__exports = { promptMarkerCandidatesFromGraph, promptMarkerReferenceDirectiveForSources };`, sandbox);

const image = {
  id: 'img1',
  type: 'image',
  url: '/assets/sofa.png',
  name: 'room.png',
  markers: [
    { number: 1, x: 0.25, y: 0.5, objectName: '米色方抱枕', status: 'done' },
    { number: 2, x: 0.72, y: 0.34, objectName: '红色落地灯', status: 'manual' },
    { number: 3, x: 0.1, y: 0.2, objectName: '', status: 'identifying' },
  ],
};
const prompt = { id: 'prompt1', type: 'prompt', text: '' };
const gen = { id: 'gen1', type: 'generator', inputs: ['img1', 'prompt1'] };
const graph = {
  nodes: [image, prompt, gen],
  connections: [
    { from: 'img1', to: 'gen1' },
    { from: 'prompt1', to: 'gen1' },
  ],
  generatorTypes: ['generator'],
};

const candidates = sandbox.__exports.promptMarkerCandidatesFromGraph(graph, prompt);
assert.equal(JSON.stringify(candidates.map(item => item.insert)), JSON.stringify(['图1标记1的米色方抱枕', '图1标记2的红色落地灯']));
assert.equal(candidates[0].search.includes('抱枕'), true);

const disconnectedGraph = {
  ...graph,
  connections: [
    { from: 'prompt1', to: 'gen1' },
  ],
};
assert.equal(sandbox.__exports.promptMarkerCandidatesFromGraph(disconnectedGraph, prompt).length, 0, 'prompt marker candidates should disappear when the sibling image is disconnected from the shared generator');

const staleInputGraph = {
  ...disconnectedGraph,
  nodes: [image, prompt, {...gen, inputs:['img1','prompt1']}],
};
assert.equal(sandbox.__exports.promptMarkerCandidatesFromGraph(staleInputGraph, prompt).length, 0, 'prompt marker candidates should use live connections, not stale generator input order');

const directive = sandbox.__exports.promptMarkerReferenceDirectiveForSources([
  { refs: [{ name: 'room.png', markers: image.markers }] },
]);
assert.match(directive, /图1标记1=米色方抱枕/);
assert.match(directive, /位置25%,50%/);
assert.match(directive, /图1标记2=红色落地灯/);
assert.doesNotMatch(directive, /标记3/);

console.log('prompt marker logic tests passed');
