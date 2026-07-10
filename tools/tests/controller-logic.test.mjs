import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const match = source.match(/\/\/ CONTROLLER_LOGIC_START([\s\S]*?)\/\/ CONTROLLER_LOGIC_END/);
assert.ok(match, 'controller logic export block should exist');

const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(`${match[1]}\nthis.__exports = { defaultControllerState, ensureControllerState, controllerPrompt, controllerSourceFromNode, generationPromptWithControllerDirectives, controllerHasActiveEffects, materialMarkerTargetsForController, materialMarkerTargetsForControllerGraph, upstreamControllerPromptsForTarget, controllerDirectivesForNodeInput };`, sandbox);

const controller = {
  id: 'ctrl1',
  type: 'controller',
  controller: sandbox.__exports.defaultControllerState(),
};
controller.controller.enabled.camera = true;
controller.controller.enabled.material = true;
controller.controller.camera.body = 'leica-m11';
controller.controller.material.selected = ['oak'];
controller.controller.material.markerTarget = '图1标记1';

const image = {
  id: 'img1',
  type: 'image',
  url: '/assets/room.png',
  name: 'room.png',
  markers: [{ number: 1, x: 0.25, y: 0.5, objectName: '米色方抱枕', status: 'done' }],
};
const prompt = { id: 'prompt1', type: 'prompt', text: '替换标记1材质' };
const gen = { id: 'gen1', type: 'generator' };
const graph = {
  nodes: [controller, image, prompt, gen],
  connections: [
    { from: 'ctrl1', to: 'gen1' },
    { from: 'img1', to: 'gen1' },
    { from: 'prompt1', to: 'gen1' },
  ],
};

const promptText = sandbox.__exports.controllerPrompt(controller, graph);
assert.match(promptText, /Controller Directive/);
assert.match(promptText, /Leica M11/);
assert.match(promptText, /SELECTED MATERIAL: 橡木/);
assert.match(promptText, /MATERIAL TARGET LOCK: apply the selected material only to 图1标记1/);

const sourceObj = sandbox.__exports.controllerSourceFromNode(controller, graph);
assert.equal(sourceObj.type, 'controller');
assert.match(sourceObj.prompt, /Camera Controller/);

const finalPrompt = sandbox.__exports.generationPromptWithControllerDirectives([
  { id: 'prompt1', type: 'prompt', prompt: prompt.text, refs: [] },
  { id: 'img1', type: 'image', prompt: '', refs: [{ name: image.name, markers: image.markers }] },
  sourceObj,
], graph, gen);
assert.match(finalPrompt, /替换标记1材质/);
assert.match(finalPrompt, /图1标记1=米色方抱枕/);
assert.match(finalPrompt, /材质控制器可引用材料/);
assert.match(finalPrompt, /Camera Controller/);

const multiLinePrompt = sandbox.__exports.generationPromptWithControllerDirectives([
  { id: 'prompt-direct', type: 'prompt', prompt: 'multi input prompt instruction', refs: [] },
  { id: 'image-direct', type: 'image', prompt: '', refs: [{ url: '/assets/multi.png', name: 'multi.png', markers: [{ number: 2, x: 0.4, y: 0.6, objectName: 'multi marker', status: 'done' }] }] },
  sandbox.__exports.controllerSourceFromNode(controller, graph),
], graph, gen);
assert.match(multiLinePrompt, /multi input prompt instruction/, 'direct prompt input should be preserved in multi-line generation');
assert.match(multiLinePrompt, /multi marker/, 'direct image marker input should be preserved in multi-line generation');
assert.match(multiLinePrompt, /Camera Controller/, 'direct controller input should be preserved in multi-line generation');
assert.match(multiLinePrompt, /Material Controller/, 'material controller should be preserved in multi-line generation');

const targets = sandbox.__exports.materialMarkerTargetsForControllerGraph(graph, controller);
assert.equal(JSON.stringify(targets.map(item => item.value)), JSON.stringify(['图1标记1']));
Object.assign(sandbox, {nodes: graph.nodes, connections: graph.connections});
const panelTargets = sandbox.__exports.materialMarkerTargetsForController(controller);
assert.equal(panelTargets[0]?.label, '图1标记1 米色方抱枕');

const chainedGen = { id: 'gen2', type: 'generator' };
const chainedGraph = {
  nodes: [controller, image, prompt, gen, { id: 'out1', type: 'output', images: [{ url: '/assets/gen1.png' }] }, chainedGen],
  connections: [
    { from: 'ctrl1', to: 'gen1' },
    { from: 'img1', to: 'gen1' },
    { from: 'prompt1', to: 'gen1' },
    { from: 'gen1', to: 'out1' },
    { from: 'out1', to: 'gen2' },
  ],
};
const chainedPrompts = sandbox.__exports.upstreamControllerPromptsForTarget(chainedGen, [], chainedGraph);
assert.equal(chainedPrompts.length, 1, 'downstream generator should inherit controller directives through output links');
assert.match(chainedPrompts[0], /Camera Controller/);
const chainedFinalPrompt = sandbox.__exports.generationPromptWithControllerDirectives([
  { id: 'out1', type: 'outputImage', prompt: '', refs: [{ url: '/assets/gen1.png', name: 'gen1.png' }] },
], chainedGraph, chainedGen);
assert.match(chainedFinalPrompt, /Camera Controller/, 'final prompt should include upstream controller directives through the canvas chain');
assert.match(chainedFinalPrompt, /Material Controller/);

const materialOnlyController = {
  id: 'ctrl-material-only',
  type: 'controller',
  controller: sandbox.__exports.defaultControllerState(),
};
materialOnlyController.controller.enabled.material = true;
materialOnlyController.controller.material.selected = ['walnut'];
const materialOnlyPrompt = sandbox.__exports.controllerPrompt(materialOnlyController);
assert.match(materialOnlyPrompt, /Material Controller/, 'material-only controller should emit material directives');
assert.match(materialOnlyPrompt, /only the enabled material controller settings/, 'material-only constraints should name only material');
assert.match(materialOnlyPrompt, /realistic material response and detailed surface texture/, 'material-only constraints should keep material quality requirements');
assert.doesNotMatch(materialOnlyPrompt, /Camera Controller|Angle Controller|Lighting Controller/, 'material-only controller should not emit disabled controller sections');
assert.doesNotMatch(materialOnlyPrompt, /camera, angle, lighting, and material/, 'material-only constraints should not reuse the all-controller constraint');
assert.doesNotMatch(materialOnlyPrompt, /coherent lighting|coherent perspective/, 'material-only constraints should not introduce lighting or perspective requirements');
assert.doesNotMatch(materialOnlyPrompt, /Do not introduce requirements from disabled controllers\./, 'removed disabled-controller sentence should not be emitted');

const llm = { id: 'llm1', type: 'llm', outputText: 'refined prompt from llm' };
const llmGraph = {
  nodes: [controller, prompt, llm, chainedGen],
  connections: [
    { from: 'ctrl1', to: 'llm1' },
    { from: 'prompt1', to: 'llm1' },
    { from: 'llm1', to: 'gen2' },
  ],
};
const llmInputDirectives = sandbox.__exports.controllerDirectivesForNodeInput(llm, llmGraph);
assert.match(llmInputDirectives, /Camera Controller/, 'LLM input should receive upstream controller directives');
const llmFinalPrompt = sandbox.__exports.generationPromptWithControllerDirectives([
  { id: 'llm1', type: 'llm', prompt: llm.outputText, refs: [] },
], llmGraph, chainedGen);
assert.match(llmFinalPrompt, /Camera Controller/, 'generation after an LLM node should inherit upstream controller directives');

const strayImage = {
  id: 'img-stray',
  type: 'image',
  url: '/assets/stray.png',
  markers: [{ number: 1, x: 0.1, y: 0.1, objectName: 'unrelated marker', status: 'done' }],
};
const linkedImage = {
  id: 'img-linked',
  type: 'image',
  url: '/assets/linked.png',
  markers: [{ number: 1, x: 0.2, y: 0.3, objectName: 'linked marker', status: 'done' }],
};
const indirectTargetGraph = {
  nodes: [strayImage, controller, linkedImage, prompt, llm, chainedGen],
  connections: [
    { from: 'ctrl1', to: 'llm1' },
    { from: 'prompt1', to: 'llm1' },
    { from: 'llm1', to: 'gen2' },
    { from: 'img-linked', to: 'gen2' },
  ],
};
const indirectTargets = sandbox.__exports.materialMarkerTargetsForControllerGraph(indirectTargetGraph, controller);
assert.ok(indirectTargets.some(item => item.label.includes('linked marker')), 'material marker targets should be found through downstream canvas chains');
assert.ok(!indirectTargets.some(item => item.label.includes('unrelated marker')), 'material marker targets should ignore images outside the controller chain');

console.log('controller logic tests passed');
