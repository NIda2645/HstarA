import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const start = source.indexOf('function generatedImageRefs(node)');
const end = source.indexOf('async function runGeneratorLegacy', start);
assert.ok(start >= 0 && end > start, 'runGenerator linkage block should be extractable');

const capturedPayloads = [];
const sandbox = {
  nodes: [],
  connections: [],
  loopContext: null,
  CANVAS_MEDIA_OUTPUT_TYPES: ['generator', 'msgen', 'comfy', 'rh', 'video', 'ltxDirector'],
  mediaKindForOutputItem: item => item?.kind || 'image',
  mediaKindForNode: node => node?.kind || 'image',
  outputUrlValue: item => typeof item === 'string' ? item : item?.url || '',
  outputImageName: url => String(url || '').split('/').pop() || '',
  imageRefWithMarkers: (node, extra = {}) => ({
    url: node.url,
    name: node.name || 'image',
    markers: node.markers || [],
    ...extra,
  }),
  controllerSourceFromNode: node => ({ id: node.id, type: 'controller', refs: [], prompt: node.prompt || 'controller directives' }),
  controllerGraph: () => ({}),
  generationPromptWithControllerDirectivesCompat: sources => sources.map(src => src.prompt || '').filter(Boolean).join('\n\n'),
  imageRefsOnly: refs => (refs || []).filter(ref => (ref.kind || 'image') === 'image'),
  tr: key => key,
  trf: (key, values = {}) => `${key}:${values.n ?? ''}`,
  renderLoopPrompt: node => node.prompt || '',
  loopInputImageRefs: () => [],
  loopCount: node => Number(node.count || 1),
  cascadeTargetIdFromOptions: () => '',
  outputForNode: () => null,
  runSnapshot: (gen, prompt, refs) => ({ genId: gen.id, prompt, refs }),
  resolveImageProviderId: value => value,
  resolveImageModel: value => value,
  generatorSizeForRun: async () => '4096x4096',
  normalizedImageQuality: value => value || '',
  nowMs: () => 1000,
  refreshRunNodes: () => {},
  setTimeout: fn => fn(),
  createCanvasImageTask: async payload => {
    capturedPayloads.push(payload);
    return { task_id: 'task-1' };
  },
  waitCanvasImageTaskResult: async () => ({ images: [{ url: '/output/result.png' }] }),
  mergeGeneratedOutputs: (gen, outputs) => { gen.generatedOutputs = outputs; },
  addGenerationLog: entry => { sandbox.generationLog = entry; },
  requestMetaFromResult: () => ({}),
  scheduleSave: () => {},
  saveCanvas: async () => {},
  showErrorModal: message => { throw new Error(message); },
  alert: message => { throw new Error(`unexpected alert: ${message}`); },
  isCascadeAbortError: () => false,
  cascadeAbortError: message => new Error(message),
  cascadeStopMessage: () => 'cascade stopped',
};

vm.createContext(sandbox);
vm.runInContext(`${source.slice(start, end)}\nthis.__exports = { runGenerator, generatorSources, orderedSources };`, sandbox);

const image = { id: 'img1', type: 'image', url: '/assets/source.png', name: 'source.png', markers: [{ number: 1, objectName: 'chair', status: 'done' }] };
const prompt = { id: 'prompt1', type: 'prompt', text: 'make a clean product render' };
const controller = { id: 'ctrl1', type: 'controller', prompt: 'camera locked' };
const api = { id: 'api1', type: 'generator', apiProvider: 'linapi', model: 'gpt-image-2', count: 1, inputs: [] };
sandbox.nodes = [image, prompt, controller, api];
sandbox.connections = [
  { from: 'img1', to: 'api1' },
  { from: 'prompt1', to: 'api1' },
  { from: 'ctrl1', to: 'api1' },
];

await sandbox.__exports.runGenerator('api1');

assert.equal(capturedPayloads.length, 1, 'generator should submit one canvas image task payload');
const payload = capturedPayloads[0];
assert.equal(payload.provider_id, 'linapi', 'API node provider should reach the canvas image task payload');
assert.equal(payload.model, 'gpt-image-2', 'API node model should reach the canvas image task payload');
assert.equal(payload.size, '4096x4096', 'resolved generator size should reach the canvas image task payload');
assert.match(payload.prompt, /make a clean product render/, 'connected prompt node text should reach the API payload');
assert.match(payload.prompt, /camera locked/, 'connected controller node directives should reach the API payload');
assert.deepEqual(payload.reference_images.map(ref => ref.url), ['/assets/source.png'], 'connected image node should reach the API payload as a reference image');
assert.deepEqual(payload.reference_images[0].markers, image.markers, 'image marker data should stay attached to the reference image payload');
assert.equal(JSON.stringify(api.generatedOutputs), JSON.stringify([{ url: '/output/result.png' }]), 'successful canvas task output should be merged back into the API node');

console.log('canvas API payload linkage tests passed');
