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

function skipRegexLiteral(source, index, functionName) {
  let inCharacterClass = false;
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const char = source[cursor];
    if (char === '\\') {
      cursor += 1;
    } else if (char === '\n' || char === '\r') {
      assert.fail(`functionSource(${functionName}): unterminated regex literal`);
    } else if (char === '[') {
      inCharacterClass = true;
    } else if (char === ']' && inCharacterClass) {
      inCharacterClass = false;
    } else if (char === '/' && !inCharacterClass) {
      cursor += 1;
      while (/[A-Za-z]/.test(source[cursor] || '')) cursor += 1;
      return cursor;
    }
  }
  assert.fail(`functionSource(${functionName}): unterminated regex literal`);
}

function regexAllowedAfterIdentifier(identifier) {
  return new Set([
    'await', 'case', 'delete', 'do', 'else', 'in', 'instanceof', 'new',
    'of', 'return', 'throw', 'typeof', 'void', 'yield',
  ]).has(identifier);
}

function lexicalStep(source, index, canStartRegex, functionName) {
  const char = source[index];
  const next = source[index + 1];
  if (/\s/.test(char)) return { cursor: index + 1, canStartRegex, punctuator: '' };
  if (char === "'" || char === '"') {
    return { cursor: skipQuoted(source, index, char, functionName), canStartRegex: false, punctuator: '' };
  }
  if (char === '`') {
    return { cursor: skipTemplate(source, index, functionName), canStartRegex: false, punctuator: '' };
  }
  if (char === '/' && next === '/') {
    return { cursor: skipLineComment(source, index), canStartRegex, punctuator: '' };
  }
  if (char === '/' && next === '*') {
    return { cursor: skipBlockComment(source, index, functionName), canStartRegex, punctuator: '' };
  }
  if (char === '/' && next !== '=' && canStartRegex) {
    return { cursor: skipRegexLiteral(source, index, functionName), canStartRegex: false, punctuator: '' };
  }
  if (/[A-Za-z_$]/.test(char)) {
    let cursor = index + 1;
    while (/[A-Za-z0-9_$]/.test(source[cursor] || '')) cursor += 1;
    return {
      cursor,
      canStartRegex: regexAllowedAfterIdentifier(source.slice(index, cursor)),
      punctuator: '',
    };
  }
  if (/[0-9]/.test(char)) {
    let cursor = index + 1;
    while (/[A-Za-z0-9_.]/.test(source[cursor] || '')) cursor += 1;
    return { cursor, canStartRegex: false, punctuator: '' };
  }

  const expressionPrefix = '([{,;:?=!?&|+-*%~^<>/';
  return {
    cursor: index + 1,
    canStartRegex: expressionPrefix.includes(char),
    punctuator: char,
  };
}

function skipTemplateExpression(source, index, functionName) {
  let depth = 1;
  let cursor = index;
  let canStartRegex = true;
  while (cursor < source.length) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName);
    if (step.punctuator === '{') depth += 1;
    if (step.punctuator === '}') {
      depth -= 1;
      if (depth === 0) return step.cursor;
    }
    cursor = step.cursor;
    canStartRegex = step.canStartRegex;
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
  let canStartRegex = true;
  while (cursor < targetIndex) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName);
    if (step.cursor > targetIndex) return false;
    cursor = step.cursor;
    canStartRegex = step.canStartRegex;
  }
  return cursor === targetIndex;
}

function skipTrivia(source, index, functionName) {
  let cursor = index;
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) {
      cursor += 1;
    } else if (source[cursor] === '/' && source[cursor + 1] === '/') {
      cursor = skipLineComment(source, cursor);
    } else if (source[cursor] === '/' && source[cursor + 1] === '*') {
      cursor = skipBlockComment(source, cursor, functionName);
    } else {
      break;
    }
  }
  return cursor;
}

function readIdentifier(source, index) {
  if (!/[A-Za-z_$]/.test(source[index] || '')) return null;
  let cursor = index + 1;
  while (/[A-Za-z0-9_$]/.test(source[cursor] || '')) cursor += 1;
  return { value: source.slice(index, cursor), end: cursor };
}

function closingParameterIndex(source, openingParenthesis, functionName) {
  let depth = 1;
  let cursor = openingParenthesis + 1;
  let canStartRegex = true;
  while (cursor < source.length) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName);
    if (step.punctuator === '(') depth += 1;
    if (step.punctuator === ')') {
      depth -= 1;
      if (depth === 0) return step.cursor;
    }
    cursor = step.cursor;
    canStartRegex = step.canStartRegex;
  }
  assert.fail(`functionSource(${functionName}): parameter list is unbalanced`);
}

function functionDeclaration(source, functionName) {
  const candidatePattern = new RegExp(
    `^[\\t ]*(?:async[\\t ]+)?function\\s+${escapeRegExp(functionName)}\\b`,
    'gm',
  );
  for (let candidate = candidatePattern.exec(source); candidate; candidate = candidatePattern.exec(source)) {
    if (!isCodePosition(source, candidate.index, functionName)) continue;

    let cursor = skipTrivia(source, candidate.index, functionName);
    let identifier = readIdentifier(source, cursor);
    if (identifier?.value === 'async') {
      cursor = skipTrivia(source, identifier.end, functionName);
      identifier = readIdentifier(source, cursor);
    }
    if (identifier?.value !== 'function') continue;

    cursor = skipTrivia(source, identifier.end, functionName);
    if (source[cursor] === '*') cursor = skipTrivia(source, cursor + 1, functionName);
    identifier = readIdentifier(source, cursor);
    if (identifier?.value !== functionName) continue;

    cursor = skipTrivia(source, identifier.end, functionName);
    if (source[cursor] !== '(') continue;
    cursor = skipTrivia(source, closingParameterIndex(source, cursor, functionName), functionName);
    if (source[cursor] === '{') return { start: candidate.index, openingBrace: cursor };
  }
  assert.fail(`functionSource(${functionName}): declaration not found`);
}

function functionSource(source, functionName) {
  const declaration = functionDeclaration(source, functionName);

  let depth = 1;
  let cursor = declaration.openingBrace + 1;
  let canStartRegex = true;
  while (cursor < source.length) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName);
    if (step.punctuator === '{') depth += 1;
    if (step.punctuator === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(declaration.start, step.cursor);
    }
    cursor = step.cursor;
    canStartRegex = step.canStartRegex;
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

assert.throws(
  () => functionSource('const value = 1;', 'missingFixture'),
  /functionSource\(missingFixture\): declaration not found/,
  'functionSource should identify a missing function in its diagnostic',
);
assert.throws(
  () => functionSource('function unbalancedFixture() { if (true) { return 1; }', 'unbalancedFixture'),
  /functionSource\(unbalancedFixture\): balanced closing brace not found/,
  'functionSource should identify an unbalanced function body in its diagnostic',
);

const extractionFixture = [
  'const quotedDecoy = "function extractionTarget() { return \'quoted decoy\'; }";',
  'const templateDecoy = `',
  "function extractionTarget() { return 'template decoy'; }",
  '`;',
  '/*',
  "function extractionTarget() { return 'comment decoy'; }",
  '*/',
  'function extractionTarget(',
  '  project = (value) => ({ value }),',
  ') {',
  '  const quoted = "function extractionTail() { ignored }";',
  '  const template = `function extractionTail() { ${"ignored"} }`;',
  '  const closingBrace = /}/;',
  '  // function extractionTail() { ignored }',
  '  /* function extractionTail() { ignored } */',
  "  return quoted.length > 0 && template.length > 0 && closingBrace.test('}') ? project('complete').value : 'incomplete';",
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

const disconnectedStates = ['selected', 'active', 'running'];
for (const state of disconnectedStates) {
  const disconnectedGenerator = { id: `disconnected-${state}-generator`, type: 'generator' };
  const unrelatedStatefulNode = {
    id: `unrelated-${state}-prompt`,
    type: 'prompt',
    text: `unrelated ${state} prompt`,
    [state]: true,
  };
  const disconnectedGeneratorSources = exportedFunction(
    ordinaryGeneratorSource,
    'generatorSources',
    {
      nodes: [unrelatedStatefulNode, disconnectedGenerator],
      connections: [{ from: unrelatedStatefulNode.id, to: `other-${state}-target` }],
      CANVAS_MEDIA_OUTPUT_TYPES: [],
    },
  ).fn;
  const disconnectedGeneratorSourceIds = Array.from(
    disconnectedGeneratorSources(disconnectedGenerator),
    item => item.id,
  );
  assert.deepEqual(
    disconnectedGeneratorSourceIds,
    [],
    `ordinary generatorSources must not leak an unrelated ${state} node into a zero-inbound target`,
  );
}

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

for (const state of disconnectedStates) {
  const disconnectedSmartTarget = { id: `smart-disconnected-${state}-target`, type: 'smart-image' };
  const unrelatedStatefulNode = {
    id: `smart-unrelated-${state}-prompt`,
    type: 'smart-prompt',
    [state]: true,
  };
  const disconnectedSmartUpstream = exportedFunction(
    functionSource(smartCanvasSource, 'upstreamNodesForKinds'),
    'upstreamNodesForKinds',
    {
      canvas: {
        connections: [{ from: unrelatedStatefulNode.id, to: `smart-other-${state}-target`, kind: 'input' }],
      },
      canvasUsesConnections: true,
      nodes: [unrelatedStatefulNode, disconnectedSmartTarget],
    },
  ).fn;
  const disconnectedSmartUpstreamIds = Array.from(
    disconnectedSmartUpstream(disconnectedSmartTarget, ['input']),
    node => node.id,
  );
  assert.deepEqual(
    disconnectedSmartUpstreamIds,
    [],
    `smart upstream traversal must not leak an unrelated ${state} node into a zero-inbound target`,
  );
}

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
