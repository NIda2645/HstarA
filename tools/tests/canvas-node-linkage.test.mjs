import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
assert.match(source, /const canOutput = \[[^\]]*'controller'[^\]]*\]\.includes\(node\.type\)/, 'controller nodes should render an output port for downstream directive links');
assert.match(source, /if\(from\.type === 'controller'\) return CANVAS_GENERATOR_TYPES\.includes\(to\.type\) \|\| to\.type === 'llm';/, 'controller nodes should connect to generation and LLM nodes as directive sources');

const start = source.indexOf('const CANVAS_GENERATOR_TYPES');
const end = source.indexOf('function syncGeneratorInputs()', start);
assert.ok(start >= 0 && end > start, 'canvas node linkage block should be discoverable');

const block = source.slice(start, end);
const sandbox = {
  nodes: [],
  connections: [],
  loopContext: null,
  outputUrlValue: item => typeof item === 'string' ? item : item?.url || '',
  outputImageName: url => String(url || '').split('/').pop() || '',
  mediaKindForOutputItem: item => item?.kind || 'image',
  mediaKindForNode: node => node?.mediaKind || 'image',
  imageRefWithMarkers: (node, extra = {}) => ({
    url: node.url,
    name: node.name || 'image',
    markers: node.markers || [],
    ...extra,
  }),
  controllerSourceFromNode: node => ({ id: node.id, type: 'controller', refs: [], prompt: node.prompt || 'controller directives' }),
  controllerGraph: () => ({}),
  tr: key => key,
  trf: (key, values = {}) => `${key}:${values.n ?? ''}`,
  renderLoopPrompt: node => node.prompt || '',
  loopInputImageRefs: () => [],
  loopCount: node => Number(node.count || 1),
};
vm.createContext(sandbox);
vm.runInContext(`${block}\nthis.__exports = { generatorSources, orderedSources };`, sandbox);

const workflowStart = source.indexOf('function canvasRunTypes()');
const workflowEnd = source.indexOf('async function runCanvasGenerate', workflowStart);
assert.ok(workflowStart >= 0 && workflowEnd > workflowStart, 'canvas workflow order block should be discoverable');
vm.runInContext(`${source.slice(workflowStart, workflowEnd)}\nthis.__workflowExports = { canvasWorkflowEdges, computeConnectedWorkflowOrder };`, sandbox);

const image = { id: 'img1', type: 'image', url: '/assets/source.png', name: 'source.png', markers: [{ number: 1, objectName: 'chair', status: 'done' }] };
const prompt = { id: 'prompt1', type: 'prompt', text: 'make a clean product render' };
const controller = { id: 'ctrl1', type: 'controller', prompt: 'camera locked' };
const api = { id: 'api1', type: 'generator', inputs: [] };
sandbox.nodes = [image, prompt, controller, api];
sandbox.connections = [
  { from: 'img1', to: 'api1' },
  { from: 'prompt1', to: 'api1' },
  { from: 'ctrl1', to: 'api1' },
];

const directSources = sandbox.__exports.orderedSources(api, sandbox.__exports.generatorSources(api));
assert.equal(directSources.length, 3, 'image, prompt, and controller should all feed the API node together');
assert.equal(directSources.filter(src => src.refs?.length).length, 1, 'image input should remain available as reference media');
assert.equal(directSources.find(src => src.type === 'prompt')?.prompt, prompt.text, 'prompt input should remain available as text');
assert.equal(directSources.find(src => src.type === 'controller')?.prompt, controller.prompt, 'controller input should remain available as directives');

const output = {
  id: 'out1',
  type: 'output',
  images: [
    { url: '/assets/generated-a.png', kind: 'image' },
    { url: '/assets/generated-b.png', kind: 'image' },
  ],
};
const downstream = { id: 'api2', type: 'generator', inputs: [] };
sandbox.nodes = [output, downstream];
sandbox.connections = [{ from: 'out1', to: 'api2' }];

const outputSources = sandbox.__exports.orderedSources(downstream, sandbox.__exports.generatorSources(downstream));
const outputRefs = outputSources.flatMap(src => src.refs || []);
assert.deepEqual(
  outputRefs.map(ref => ref.url),
  ['/assets/generated-b.png'],
  'output node handoff should keep the native default latest-output behavior'
);

const layered = {
  id: 'openshop1',
  type: 'openshop-layered',
  projectName: '图文分层项目',
  previewUrl: '/assets/openshop-preview.png',
};
const layeredTarget = { id: 'api-openshop', type: 'generator', inputs: [] };
sandbox.nodes = [layered, layeredTarget];
sandbox.connections = [{ from: layered.id, to: layeredTarget.id }];
const layeredSources = sandbox.__exports.orderedSources(
  layeredTarget,
  sandbox.__exports.generatorSources(layeredTarget),
);
assert.deepEqual(
  layeredSources.flatMap(src => src.refs || []).map(ref => ref.url),
  ['/assets/openshop-preview.png'],
  'OpenShop preview should reach a connected generation node as image reference media',
);

const upstreamGen = { id: 'gen1', type: 'generator' };
const bridgeOutput = { id: 'out-bridge', type: 'output', images: [{ url: '/assets/bridge.png', kind: 'image' }] };
const downstreamGen = { id: 'gen2', type: 'generator' };
sandbox.nodes = [upstreamGen, bridgeOutput, downstreamGen];
sandbox.connections = [
  { from: 'gen1', to: 'out-bridge' },
  { from: 'out-bridge', to: 'gen2' },
];
assert.equal(JSON.stringify(sandbox.__workflowExports.canvasWorkflowEdges()), JSON.stringify([['gen1', 'gen2']]), 'output should bridge generator workflow order');
assert.equal(JSON.stringify(sandbox.__workflowExports.computeConnectedWorkflowOrder('gen2')), JSON.stringify(['gen1', 'gen2']), 'cascade should run upstream generator before downstream generator through output');

console.log('canvas node linkage tests passed');
