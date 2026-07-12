import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const canvasSource = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const smartCanvasSource = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function skipQuoted(source, index, quote, functionName) {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === '\\') {
      cursor += 1;
    } else if (source[cursor] === quote) {
      return cursor + 1;
    }
  }
  assert.fail(`functionSource(${functionName}): unterminated quoted string`);
}

function skipLineComment(source, index) {
  const newline = source.indexOf('\n', index + 2);
  return newline < 0 ? source.length : newline + 1;
}

function skipBlockComment(source, index, functionName) {
  const close = source.indexOf('*/', index + 2);
  if (close < 0) assert.fail(`functionSource(${functionName}): unterminated block comment`);
  return close + 2;
}

function skipTemplateExpression(source, index, functionName) {
  let depth = 1;
  let cursor = index;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === "'" || char === '"') {
      cursor = skipQuoted(source, cursor, char, functionName);
    } else if (char === '`') {
      cursor = skipTemplate(source, cursor, functionName);
    } else if (char === '/' && next === '/') {
      cursor = skipLineComment(source, cursor);
    } else if (char === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor, functionName);
    } else {
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) return cursor + 1;
      }
      cursor += 1;
    }
  }
  assert.fail(`functionSource(${functionName}): unterminated template expression`);
}

function skipTemplate(source, index, functionName) {
  let cursor = index + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === '\\') {
      cursor += 2;
    } else if (char === '`') {
      return cursor + 1;
    } else if (char === '$' && next === '{') {
      cursor = skipTemplateExpression(source, cursor + 2, functionName);
    } else {
      cursor += 1;
    }
  }
  assert.fail(`functionSource(${functionName}): unterminated template literal`);
}

function isCodePosition(source, targetIndex, functionName) {
  let cursor = 0;
  while (cursor < targetIndex) {
    const char = source[cursor];
    const next = source[cursor + 1];
    let nextCursor = cursor + 1;
    if (char === "'" || char === '"') {
      nextCursor = skipQuoted(source, cursor, char, functionName);
    } else if (char === '`') {
      nextCursor = skipTemplate(source, cursor, functionName);
    } else if (char === '/' && next === '/') {
      nextCursor = skipLineComment(source, cursor);
    } else if (char === '/' && next === '*') {
      nextCursor = skipBlockComment(source, cursor, functionName);
    }
    if (nextCursor > targetIndex) return false;
    cursor = nextCursor;
  }
  return cursor === targetIndex;
}

function functionSource(source, functionName) {
  const declarationPattern = new RegExp(
    `^[\\t ]*(?:async[\\t ]+)?function[\\t ]+${escapeRegExp(functionName)}[\\t ]*\\([^\\r\\n]*\\)[\\t ]*\\{`,
    'gm',
  );
  let declaration = null;
  for (let candidate = declarationPattern.exec(source); candidate; candidate = declarationPattern.exec(source)) {
    if (isCodePosition(source, candidate.index, functionName)) {
      declaration = candidate;
      break;
    }
  }
  assert.ok(declaration, `functionSource(${functionName}): declaration not found`);

  const openingBrace = declaration.index + declaration[0].lastIndexOf('{');
  let depth = 1;
  let cursor = openingBrace + 1;
  while (cursor < source.length) {
    const char = source[cursor];
    const next = source[cursor + 1];
    if (char === "'" || char === '"') {
      cursor = skipQuoted(source, cursor, char, functionName);
    } else if (char === '`') {
      cursor = skipTemplate(source, cursor, functionName);
    } else if (char === '/' && next === '/') {
      cursor = skipLineComment(source, cursor);
    } else if (char === '/' && next === '*') {
      cursor = skipBlockComment(source, cursor, functionName);
    } else {
      if (char === '{') depth += 1;
      if (char === '}') {
        depth -= 1;
        if (depth === 0) return source.slice(declaration.index, cursor + 1);
      }
      cursor += 1;
    }
  }

  assert.fail(`functionSource(${functionName}): balanced closing brace not found`);
}

function controllerLogicSource(source, label) {
  const startMarker = /^[\t ]*\/\/[\t ]*CONTROLLER_LOGIC_START[\t ]*\r?$/m.exec(source);
  if (startMarker) {
    const contentStart = startMarker.index + startMarker[0].length;
    const endMarker = /^[\t ]*\/\/[\t ]*CONTROLLER_LOGIC_END[\t ]*\r?$/m.exec(source.slice(contentStart));
    assert.ok(endMarker, `${label} controller logic: CONTROLLER_LOGIC_END not found`);
    return source.slice(contentStart, contentStart + endMarker.index);
  }

  // smart-canvas.js mirrors the controller block but does not carry the marker comments.
  const blockStart = /^[\t ]*const[\t ]+CONTROLLER_TABS[\t ]*=/m.exec(source);
  assert.ok(blockStart, `${label} controller logic: CONTROLLER_LOGIC_START or CONTROLLER_TABS not found`);
  const finalFunction = functionSource(source, 'generationPromptWithControllerDirectivesCompat');
  const finalStart = source.indexOf(finalFunction, blockStart.index);
  assert.ok(finalStart >= blockStart.index, `${label} controller logic: final function not found after block start`);
  return source.slice(blockStart.index, finalStart + finalFunction.length);
}

function exportedFunction(source, functionName, globals) {
  const context = { ...globals };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__exportedFunction = ${functionName};`, context);
  return { context, fn: context.__exportedFunction };
}

const extractionFixture = [
  '/*',
  "function extractionTarget() { return 'comment decoy'; }",
  '*/',
  'function extractionTarget() {',
  '  const quoted = "function extractionTail() { ignored }";',
  '  const template = `function extractionTail() { ${"ignored"} }`;',
  '  // function extractionTail() { ignored }',
  '  /* function extractionTail() { ignored } */',
  "  return quoted.length > 0 && template.length > 0 ? 'complete' : 'incomplete';",
  '}',
  "function extractionTail() { return 'wrong function'; }",
].join('\n');
const extractedFixture = functionSource(extractionFixture, 'extractionTarget');
assert.equal(
  vm.runInNewContext(`${extractedFixture}\nextractionTarget();`),
  'complete',
  'functionSource should ignore function-like text in strings, templates, and comments',
);

function runControllerMatrix(source, label, controllerType, targetType) {
  const context = { nodes: [], connections: [] };
  vm.createContext(context);
  vm.runInContext(
    `${controllerLogicSource(source, label)}\nthis.__exports = { defaultControllerState, controllerSourceFromNode, generationPromptWithControllerDirectives };`,
    context,
  );

  const controller = {
    id: `${label}-controller`,
    type: controllerType,
    controller: context.__exports.defaultControllerState(),
  };
  controller.controller.enabled.camera = true;
  const promptNode = { id: `${label}-prompt`, type: 'prompt' };
  const targetNode = { id: `${label}-target`, type: targetType };
  const promptSource = {
    id: promptNode.id,
    type: 'prompt',
    refs: [],
    prompt: `${label} connected prompt`,
  };

  context.nodes = [controller, promptNode, targetNode];
  context.connections = [{ from: promptNode.id, to: targetNode.id }];
  const unconnectedPrompt = context.__exports.generationPromptWithControllerDirectives(targetNode, [promptSource]);
  assert.match(unconnectedPrompt, new RegExp(`${label} connected prompt`), `${label} should preserve its connected prompt`);
  assert.doesNotMatch(unconnectedPrompt, /Controller Directive/, `${label} must exclude an active unconnected controller`);

  context.connections = [
    { from: promptNode.id, to: targetNode.id },
    { from: controller.id, to: targetNode.id },
  ];
  const controllerSource = context.__exports.controllerSourceFromNode(controller);
  const connectedPrompt = context.__exports.generationPromptWithControllerDirectives(
    targetNode,
    [promptSource, controllerSource],
  );
  assert.match(connectedPrompt, /Controller Directive/, `${label} should include a directly connected enabled controller`);
}

runControllerMatrix(canvasSource, 'ordinary', 'controller', 'generator');
runControllerMatrix(smartCanvasSource, 'smart', 'smart-controller', 'smart-image');

const generatorFixture = {
  strayPrompt: { id: 'stray-prompt', type: 'prompt', text: 'stray prompt' },
  linkedPrompt: { id: 'linked-prompt', type: 'prompt', text: 'linked prompt' },
  generator: { id: 'generator', type: 'generator' },
};
const generatorGlobals = {
  nodes: [generatorFixture.strayPrompt, generatorFixture.linkedPrompt, generatorFixture.generator],
  connections: [
    { from: generatorFixture.linkedPrompt.id, to: generatorFixture.generator.id },
    { from: 'missing-node', to: generatorFixture.generator.id },
  ],
  CANVAS_MEDIA_OUTPUT_TYPES: [],
};
const ordinaryGeneratorSource = functionSource(canvasSource, 'generatorSources');
const ordinaryGenerator = exportedFunction(ordinaryGeneratorSource, 'generatorSources', generatorGlobals).fn;
const generatorSourceIds = Array.from(ordinaryGenerator(generatorFixture.generator), item => item.id);
assert.deepEqual(
  generatorSourceIds,
  [generatorFixture.linkedPrompt.id],
  'ordinary generatorSources should return exactly the linked prompt source',
);

const mutatedGeneratorSource = ordinaryGeneratorSource.replace(
  'nodes.find(n => n.id === c.from)',
  '(nodes.find(n => n.id === c.from) || nodes[0])',
);
assert.notEqual(mutatedGeneratorSource, ordinaryGeneratorSource, 'generatorSources mutation should be applied');
const mutatedGenerator = exportedFunction(mutatedGeneratorSource, 'generatorSources', generatorGlobals).fn;
const mutatedGeneratorIds = Array.from(mutatedGenerator(generatorFixture.generator), item => item.id);
assert.throws(
  () => assert.deepEqual(mutatedGeneratorIds, [generatorFixture.linkedPrompt.id]),
  { name: 'AssertionError' },
  'the exact linked-source fixture should reject a nodes[0] fallback',
);

const smartNodes = [
  { id: 'smart-stray', type: 'smart-prompt' },
  { id: 'smart-linked', type: 'smart-prompt' },
  { id: 'smart-target', type: 'smart-image' },
];
const smartConnections = [
  { from: 'smart-linked', to: 'smart-target', kind: 'input' },
  { from: 'smart-stray', to: 'another-target', kind: 'input' },
];
const smartUpstream = exportedFunction(
  functionSource(smartCanvasSource, 'upstreamNodesForKinds'),
  'upstreamNodesForKinds',
  {
    canvas: { connections: smartConnections },
    canvasUsesConnections: true,
    nodes: smartNodes,
  },
).fn;
const smartUpstreamIds = Array.from(smartUpstream(smartNodes[2], ['input']), node => node.id);
assert.deepEqual(smartUpstreamIds, ['smart-linked'], 'smart upstream traversal should return exactly the linked node');

const clearContext = {
  canvas: { connections: smartConnections },
  canvasUsesConnections: true,
  nodes: smartNodes,
};
const clearDetachedRunInputRefs = exportedFunction(
  functionSource(smartCanvasSource, 'clearDetachedRunInputRefs'),
  'clearDetachedRunInputRefs',
  clearContext,
).fn;

const detachedNode = {
  id: 'smart-detached',
  runInputRefs: [{ url: '/detached-input.png' }],
  runPromptRefs: [{ url: '/detached-prompt.png' }],
  sourceNodeId: 'detached-source',
};
clearDetachedRunInputRefs(detachedNode);
assert.equal('runInputRefs' in detachedNode, false, 'detached node should lose runInputRefs');
assert.equal('runPromptRefs' in detachedNode, false, 'detached node should lose runPromptRefs');
assert.equal('sourceNodeId' in detachedNode, false, 'detached node should lose sourceNodeId');

const connectedRunInputRefs = [{ url: '/connected-input.png' }];
const connectedRunPromptRefs = [{ url: '/connected-prompt.png' }];
const connectedNode = {
  id: 'smart-target',
  runInputRefs: connectedRunInputRefs,
  runPromptRefs: connectedRunPromptRefs,
  sourceNodeId: 'smart-linked',
};
clearDetachedRunInputRefs(connectedNode);
assert.strictEqual(connectedNode.runInputRefs, connectedRunInputRefs, 'connected node should retain runInputRefs');
assert.strictEqual(connectedNode.runPromptRefs, connectedRunPromptRefs, 'connected node should retain runPromptRefs');
assert.equal(connectedNode.sourceNodeId, 'smart-linked', 'connected node should retain sourceNodeId');

console.log('Canvas dataflow ownership tests passed');
