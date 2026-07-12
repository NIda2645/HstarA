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

function lexicalStep(source, index, canStartRegex, functionName, state) {
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
    const identifier = source.slice(index, cursor);
    state.pendingControl = new Set(['catch', 'for', 'if', 'switch', 'while', 'with']).has(identifier);
    return {
      cursor,
      canStartRegex: regexAllowedAfterIdentifier(identifier),
      punctuator: '',
    };
  }
  if (/[0-9]/.test(char)) {
    let cursor = index + 1;
    while (/[A-Za-z0-9_.]/.test(source[cursor] || '')) cursor += 1;
    return { cursor, canStartRegex: false, punctuator: '' };
  }

  const expressionPrefix = '([{,;:?=!?&|+-*%~^<>/';
  let nextCanStartRegex = expressionPrefix.includes(char);
  if (char === '(') {
    state.parentheses.push(state.pendingControl ? 'control' : 'expression');
    state.pendingControl = false;
  } else if (char === ')') {
    nextCanStartRegex = state.parentheses.pop() === 'control';
    state.pendingControl = false;
  } else {
    state.pendingControl = false;
  }
  return {
    cursor: index + 1,
    canStartRegex: nextCanStartRegex,
    punctuator: char,
  };
}

function lexicalState() {
  return { parentheses: [], pendingControl: false };
}

function skipTemplateExpression(source, index, functionName) {
  let depth = 1;
  let cursor = index;
  let canStartRegex = true;
  const state = lexicalState();
  while (cursor < source.length) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName, state);
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
  const state = lexicalState();
  while (cursor < targetIndex) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName, state);
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
  const state = lexicalState();
  while (cursor < source.length) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName, state);
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
  const state = lexicalState();
  while (cursor < source.length) {
    const step = lexicalStep(source, cursor, canStartRegex, functionName, state);
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

function exportedFunction(source, functionName, globals) {
  return evaluatedFunctions(source, [functionName], globals).exports[functionName];
}

function evaluatedFunctions(source, functionNames, globals) {
  const context = { ...globals };
  vm.createContext(context);
  vm.runInContext(
    `${source}\nthis.__exportedFunctions = { ${functionNames.join(', ')} };`,
    context,
  );
  return { context, exports: context.__exportedFunctions };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function requiredIndex(source, fragment, diagnostic, fromIndex = 0) {
  const index = source.indexOf(fragment, fromIndex);
  assert.ok(index >= 0, diagnostic);
  return index;
}

const extractionFixture = [
  'const quotedDecoy = "function extractionTarget() { return 0; }";',
  'const templateDecoy = `function extractionTarget() { return 0; }`;',
  '/* function extractionTarget() { return 0; } */',
  'function extractionTarget(value = { nested: true }) {',
  '  if (value.nested) /[}]/.test("}");',
  '  const brace = /}/;',
  '  return brace.test("}") ? value.nested : false;',
  '}',
].join('\n');
assert.equal(
  vm.runInNewContext(`${functionSource(extractionFixture, 'extractionTarget')}\nextractionTarget();`),
  true,
  'functionSource should ignore function decoys and braces inside regex literals',
);

const ordinaryPollSource = functionSource(canvasSource, 'pollCanvasImageTask');
const pendingRunCompletionSource = functionSource(canvasSource, 'hasRemainingPendingTasksForRun');

{
  const generator = { id: 'deleted-generator' };
  const out = { id: 'deleted-output' };
  const nodes = [generator, out];
  const settlement = deferred();
  const mutations = [];
  const canvasRunOwnerIsCurrent = exportedFunction(
    functionSource(canvasSource, 'canvasRunOwnerIsCurrent'),
    'canvasRunOwnerIsCurrent',
    { nodes },
  );
  const catchSettlement = settlement.promise.catch(() => {
    if (!canvasRunOwnerIsCurrent(generator, out)) return;
    mutations.push('log', 'save', 'refresh', 'modal');
  });
  nodes.length = 0;
  settlement.reject(new Error('late ordinary poll failure'));
  await catchSettlement;
  assert.deepEqual(mutations, [], 'deleted classic run owners must reject late failures before any mutation-side effect');
}

{
  const generator = { id: 'deferred-deleted-generator', count: 1, running: false };
  const out = { id: 'deferred-deleted-output', _pending: [], images: [] };
  const nodes = [generator, out];
  const pollSettlement = deferred();
  const counters = { log: 0, modal: 0, refresh: 0, save: 0 };
  const alerts = [];
  const modalErrors = [];
  let pollStarted = false;
  const runGenerator = exportedFunction(functionSource(canvasSource, 'runGenerator'), 'runGenerator', {
    nodes,
    cascadeTargetIdFromOptions: () => '',
    orderedSources: (_target, sources) => sources,
    generatorSources: () => [],
    generationPromptWithMarkerDirectives: () => 'deferred prompt',
    imageRefsOnly: refs => refs,
    alert: message => alerts.push(message),
    outputForNode: () => out,
    runSnapshot: () => ({ node: { id: generator.id } }),
    resolveImageProviderId: value => value,
    resolveImageModel: value => value,
    generatorSizeForRun: async () => '1024x1024',
    normalizedImageQuality: () => '',
    nowMs: () => 1000,
    setTimeout: () => 0,
    createCanvasImageTask: async () => ({ task_id: 'deferred-task' }),
    uid: () => 'deferred-pending',
    makePendingForRun: id => ({ id, canvasTaskId: 'deferred-task' }),
    refreshRunNodes: () => { counters.refresh += 1; },
    scheduleSave: () => { counters.save += 1; },
    saveCanvas: async () => {},
    pollCanvasImageTask: () => {
      pollStarted = true;
      return pollSettlement.promise;
    },
    cascadeAbortError: message => new Error(message),
    cascadeStopMessage: () => 'stopped',
    tr: key => key,
    canvasRunOwnerIsCurrent: (node, owner) => nodes.includes(node) && nodes.includes(owner),
    pendingById: (owner, id) => owner?._pending?.find(item => item.id === id),
    collectRunMetas: () => [],
    addGenerationLog: () => { counters.log += 1; },
    isCascadeAbortError: () => false,
    showErrorModal: message => {
      counters.modal += 1;
      modalErrors.push(message);
    },
  });

  const run = runGenerator(generator.id);
  for (let index = 0; index < 10 && !pollStarted; index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(pollStarted, true, `classic stale-owner integration fixture must reach deferred polling: alerts=${alerts.join('; ')} modals=${modalErrors.join('; ')}`);
  nodes.length = 0;
  const baseline = {
    counters: { ...counters },
    generator: JSON.stringify(generator),
    out: JSON.stringify(out),
  };
  pollSettlement.resolve('failed');
  await run;
  assert.deepEqual({
    counters: { ...counters },
    generator: JSON.stringify(generator),
    out: JSON.stringify(out),
  }, baseline, 'runGenerator must perform no catch-path side effect after generator/output deletion');
  assert.equal(nodes.length, 0, 'runGenerator late failure must not resurrect deleted owners');
}

for (const [functionName, ownerName] of [['runRhModelNode', 'node'], ['runGenerator', 'gen']]) {
  const runSource = functionSource(canvasSource, functionName);
  const catchStart = requiredIndex(runSource, '} catch(err) {', `${functionName} must define its lifecycle catch path`);
  const firstCatchMutation = requiredIndex(runSource, 'const remainingPending', `${functionName} must inspect pending state after its ownership guard`, catchStart);
  assert.ok(
    runSource.slice(catchStart, firstCatchMutation).includes(`if(!canvasRunOwnerIsCurrent(${ownerName}, out)) return;`),
    `${functionName} must reject a detached generator/output before catch-path mutation`,
  );
}

{
  const taskStates = [
    { status: 'queued' },
    { status: 'running' },
    { status: 'jimeng_pending', submit_id: 'jimeng-no-output', kind: 'image', message: 'queued remotely' },
  ];
  let fetchCalls = 0;
  const waitCanvasImageTaskResult = exportedFunction(
    functionSource(canvasSource, 'waitCanvasImageTaskResult'),
    'waitCanvasImageTaskResult',
    {
      cascadeTargetIdFromOptions: () => '',
      ensureCascadeActive() {},
      cascadeFetch: async () => {
        fetchCalls += 1;
        const task = taskStates.shift();
        if (!task) throw new Error('no-output waiter fetched after permanent jimeng_pending');
        return { ok: true, json: async () => task };
      },
      canvasJimengPendingError: task => Object.assign(new Error(task.message), {
        jimengPending: true,
        submitId: task.submit_id,
        kind: task.kind,
      }),
      sleep: async () => {},
      tr: key => key,
    },
  );

  await assert.rejects(
    waitCanvasImageTaskResult('ordinary-no-output'),
    error => error.jimengPending === true && error.submitId === 'jimeng-no-output' && error.kind === 'image',
    'the shared no-output waiter must terminalize permanent jimeng_pending with its submit metadata',
  );
  assert.equal(fetchCalls, 3, 'the shared no-output waiter must stop after queued and running reach jimeng_pending');
}

{
  const generator = { id: 'classic-no-output-owner', x: 20, y: 30, running: true, runStatus: 'running' };
  const nodes = [generator];
  const connections = [];
  let uidIndex = 0;
  let saveCalls = 0;
  const source = [
    functionSource(canvasSource, 'handoffCanvasJimengTask'),
    functionSource(canvasSource, 'handoffCanvasNoOutputJimengTask'),
  ].join('\n');
  const handoffCanvasNoOutputJimengTask = exportedFunction(source, 'handoffCanvasNoOutputJimengTask', {
    nodes,
    connections,
    uid: prefix => `${prefix}-${++uidIndex}`,
    makePendingForRun: (id, run, node, options, taskOptions) => ({ id, run, ...options, ...taskOptions }),
    findPendingTask: taskId => {
      for (const out of nodes.filter(node => node.type === 'output')) {
        const pending = (out._pending || []).find(item => item.canvasTaskId === taskId);
        if (pending) return { out, pending };
      }
      return null;
    },
    tr: key => key,
    refreshRunNodes() {},
    scheduleSave: () => { saveCalls += 1; },
  });
  const error = Object.assign(new Error('queued remotely'), {
    jimengPending: true,
    submitId: 'jimeng-no-output-durable',
    kind: 'image',
    canvasTaskId: 'canvas-no-output-durable',
    taskData: {
      status: 'jimeng_pending',
      submit_id: 'jimeng-no-output-durable',
      kind: 'image',
      message: 'queued remotely',
    },
  });

  assert.equal(handoffCanvasNoOutputJimengTask(generator, { node: { id: generator.id } }, error, {
    refs: [],
    requestSize: '1024x1024',
    providerId: 'runninghub',
    model: 'rh-model',
    dx: 500,
  }), true, 'classic no-output Jimeng must create a durable recovery owner');
  const out = nodes.find(node => node.type === 'output');
  assert.ok(out, 'classic no-output Jimeng must create an output node for recovery UI ownership');
  assert.equal(connections.some(connection => connection.from === generator.id && connection.to === out.id), true, 'classic no-output recovery output must remain connected to its generator');
  assert.equal(out._pending.length, 1, 'classic no-output recovery output must own one pending record');
  assert.equal(out._pending[0].recoverTaskId, 'jimeng-no-output-durable', 'classic no-output recovery must persist the Jimeng submit ID');
  assert.equal(out._pending[0].canvasTaskStatus, 'jimeng_pending', 'classic no-output recovery must retain Jimeng status');
  assert.equal(generator.runStatus, 'queued', 'classic no-output recovery must leave its generator queued');
  assert.equal(saveCalls, 1, 'classic no-output recovery must persist the new output and pending record');
}

function noOutputClassicRunFixture(functionName) {
  const isRh = functionName === 'runRhModelNode';
  const node = { id: `${functionName}-owner`, type: isRh ? 'rh' : 'generator', x: 10, y: 20, count: 1, running: false };
  const nodes = [node];
  const waitSettlement = deferred();
  const timerCallbacks = [];
  const counters = { handoff: 0, log: 0, merge: 0, modal: 0, refresh: 0, save: 0 };
  let waitStarted = false;
  const globals = {
    nodes,
    cascadeTargetIdFromOptions: () => '',
    imageRefsOnly: refs => refs,
    outputForNode: () => null,
    runSnapshot: () => ({ node: { id: node.id } }),
    generatorSizeForRun: async () => '1024x1024',
    normalizedImageQuality: () => '',
    nowMs: () => 1000,
    setTimeout: callback => {
      timerCallbacks.push(callback);
      return timerCallbacks.length;
    },
    createCanvasImageTask: async () => ({ task_id: `${functionName}-canvas-task` }),
    waitCanvasImageTaskResult: () => {
      waitStarted = true;
      return waitSettlement.promise;
    },
    requestMetaFromResult: () => ({}),
    mergeGeneratedOutputs: () => { counters.merge += 1; },
    addGenerationLog: () => { counters.log += 1; },
    refreshRunNodes: () => { counters.refresh += 1; },
    scheduleSave: () => { counters.save += 1; },
    handoffCanvasNoOutputJimengTask: (...args) => {
      counters.handoff += 1;
      counters.handoffArgs = args;
      return true;
    },
    canvasRunOwnerIsCurrent: owner => nodes.includes(owner),
    pendingById: () => null,
    collectRunMetas: () => [],
    isCascadeAbortError: () => false,
    tr: key => key,
    showErrorModal: () => { counters.modal += 1; },
    saveCanvas: async () => {},
    pollCanvasImageTask: async () => 'missing',
    cascadeAbortError: message => new Error(message),
    cascadeStopMessage: () => 'stopped',
  };
  if (isRh) {
    Object.assign(globals, {
      rhSelectedEntryRef: () => ({ id: 'rh-model' }),
      rhMediaSources: () => ({ prompt: 'rh prompt', refs: [] }),
      alert() {},
    });
  } else {
    Object.assign(globals, {
      orderedSources: (_owner, sources) => sources,
      generatorSources: () => [],
      generationPromptWithMarkerDirectives: () => 'generator prompt',
      alert() {},
      resolveImageProviderId: value => value,
      resolveImageModel: value => value,
    });
  }
  const runFunction = exportedFunction(functionSource(canvasSource, functionName), functionName, globals);
  const run = isRh ? runFunction(node) : runFunction(node.id);
  return {
    counters,
    node,
    nodes,
    run,
    snapshot: () => ({ counters: { ...counters }, node: JSON.stringify(node) }),
    timerCallbacks,
    waitSettlement,
    waitStarted: () => waitStarted,
  };
}

for (const functionName of ['runGenerator', 'runRhModelNode']) {
  const fixture = noOutputClassicRunFixture(functionName);
  for (let index = 0; index < 10 && !fixture.waitStarted(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(fixture.waitStarted(), true, `${functionName} no-output fixture must reach its deferred waiter`);
  fixture.waitSettlement.reject(Object.assign(new Error('queued remotely'), {
    jimengPending: true,
    submitId: `${functionName}-submit`,
    kind: 'image',
    canvasTaskId: `${functionName}-canvas-task`,
    taskData: { status: 'jimeng_pending', submit_id: `${functionName}-submit`, kind: 'image', message: 'queued remotely' },
  }));
  await fixture.run;
  assert.equal(fixture.counters.handoff, 1, `${functionName} must hand no-output Jimeng into durable recovery state`);
  assert.equal(fixture.counters.log, 0, `${functionName} no-output Jimeng must not add a generic failure log`);
  assert.equal(fixture.counters.modal, 0, `${functionName} no-output Jimeng must not show a generic failure modal`);
}

for (const functionName of ['runGenerator', 'runRhModelNode']) {
  const fixture = noOutputClassicRunFixture(functionName);
  for (let index = 0; index < 10 && !fixture.waitStarted(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(fixture.waitStarted(), true, `${functionName} stale-success fixture must reach its deferred waiter`);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  fixture.waitSettlement.resolve({ images: [`/${functionName}-late-success.png`] });
  await fixture.run;
  assert.deepEqual(fixture.snapshot(), baseline, `${functionName} must ignore late no-output success after exact owner deletion`);
  assert.equal(fixture.nodes.length, 0, `${functionName} late no-output success must not resurrect its owner`);
}

for (const functionName of ['runGenerator', 'runRhModelNode']) {
  const fixture = noOutputClassicRunFixture(functionName);
  for (let index = 0; index < 10 && !fixture.waitStarted(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(fixture.timerCallbacks.length, 1, `${functionName} must register one delayed running-state release`);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  fixture.timerCallbacks[0]();
  assert.deepEqual(fixture.snapshot(), baseline, `${functionName} delayed running-state release must ignore a deleted exact owner`);
  fixture.waitSettlement.reject(new Error('cleanup after stale timeout probe'));
  await fixture.run;
}

async function runMixedNoOutputClassicFixture(functionName) {
  const isRh = functionName === 'runRhModelNode';
  const node = { id: `${functionName}-mixed-owner`, type: isRh ? 'rh' : 'generator', x: 10, y: 20, count: 3, running: false };
  const nodes = [node];
  const connections = [];
  const taskIds = ['mixed-task-1', 'mixed-task-2', 'mixed-task-3'];
  const settlements = new Map(taskIds.map(taskId => [taskId, deferred()]));
  const waitCalls = [];
  const pollCalls = [];
  let createIndex = 0;
  let uidIndex = 0;
  let saveCalls = 0;
  const source = [
    functionSource(canvasSource, 'handoffCanvasJimengTask'),
    functionSource(canvasSource, 'handoffCanvasNoOutputJimengTask'),
    functionSource(canvasSource, functionName),
  ].join('\n');
  const globals = {
    nodes,
    connections,
    cascadeTargetIdFromOptions: () => '',
    imageRefsOnly: refs => refs,
    outputForNode: () => null,
    runSnapshot: () => ({ node: { id: node.id }, refs: [] }),
    generatorSizeForRun: async () => '1024x1024',
    normalizedImageQuality: () => '',
    nowMs: () => 1200,
    setTimeout: () => 0,
    createCanvasImageTask: async () => ({ task_id: taskIds[createIndex++] }),
    waitCanvasImageTaskResult: taskId => {
      waitCalls.push(taskId);
      return settlements.get(taskId).promise;
    },
    requestMetaFromResult: result => ({ marker: result.marker || '' }),
    uid: prefix => `${prefix}-mixed-${++uidIndex}`,
    makePendingForRun: (id, run, owner, options, taskOptions) => ({ id, run, ...options, ...taskOptions }),
    findPendingTask: taskId => {
      for (const out of nodes.filter(item => item.type === 'output')) {
        const pending = (out._pending || []).find(item => item.canvasTaskId === taskId);
        if (pending) return { out, pending };
      }
      return null;
    },
    appendOutputImages: (out, images) => { out.images = [...(out.images || []), ...images]; },
    mergeGeneratedOutputs: (owner, outputs, append) => {
      owner.generatedOutputs = append ? [...(owner.generatedOutputs || []), ...outputs] : outputs.slice();
    },
    addGenerationLog() {},
    refreshRunNodes() {},
    scheduleSave: () => { saveCalls += 1; },
    saveCanvas: async () => {},
    pollCanvasImageTask: taskId => {
      pollCalls.push(taskId);
      return Promise.resolve('running');
    },
    canvasRunOwnerIsCurrent: (owner, out) => nodes.includes(owner) && (!out || nodes.includes(out)),
    pendingById: (out, id) => out?._pending?.find(item => item.id === id),
    collectRunMetas: () => [],
    isCascadeAbortError: () => false,
    tr: key => key,
    showErrorModal() {},
    cascadeAbortError: message => new Error(message),
    cascadeStopMessage: () => 'stopped',
  };
  if (isRh) {
    Object.assign(globals, {
      rhSelectedEntryRef: () => ({ id: 'rh-model' }),
      rhMediaSources: () => ({ prompt: 'rh mixed prompt', refs: [] }),
      alert() {},
    });
  } else {
    Object.assign(globals, {
      orderedSources: (_owner, sources) => sources,
      generatorSources: () => [],
      generationPromptWithMarkerDirectives: () => 'generator mixed prompt',
      alert() {},
      resolveImageProviderId: value => value,
      resolveImageModel: value => value,
    });
  }
  const runFunction = exportedFunction(source, functionName, globals);
  const run = isRh ? runFunction(node) : runFunction(node.id);
  for (let index = 0; index < 10 && !waitCalls.includes(taskIds[0]); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  settlements.get(taskIds[0]).resolve({ images: ['/mixed-completed.png'], marker: 'completed' });
  for (let index = 0; index < 10 && !waitCalls.includes(taskIds[1]); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  settlements.get(taskIds[1]).reject(Object.assign(new Error('mixed task queued remotely'), {
    jimengPending: true,
    submitId: 'mixed-submit-2',
    kind: 'image',
    canvasTaskId: taskIds[1],
    taskData: { status: 'jimeng_pending', submit_id: 'mixed-submit-2', kind: 'image', message: 'mixed task queued remotely' },
  }));
  await run;
  return { connections, node, nodes, pollCalls, saveCalls, taskIds, waitCalls };
}

for (const functionName of ['runGenerator', 'runRhModelNode']) {
  const fixture = await runMixedNoOutputClassicFixture(functionName);
  const out = fixture.nodes.find(node => node.type === 'output');
  assert.ok(out, `${functionName} mixed Jimeng handoff must create a durable output owner`);
  assert.deepEqual(out.images, ['/mixed-completed.png'], `${functionName} mixed Jimeng handoff must preserve completed outputs`);
  assert.deepEqual(Array.from(out._pending, task => task.canvasTaskId), fixture.taskIds.slice(1), `${functionName} mixed Jimeng handoff must persist every unfinished canvas task ID`);
  assert.equal(out._pending[0].recoverTaskId, 'mixed-submit-2', `${functionName} mixed Jimeng handoff must retain the Jimeng submit ID`);
  assert.equal(out._pending[1].failed, undefined, `${functionName} mixed Jimeng handoff must keep the remaining task pollable`);
  assert.deepEqual(Array.from(fixture.node.generatedOutputs || []), ['/mixed-completed.png'], `${functionName} mixed Jimeng handoff must preserve completed generator outputs`);
  assert.deepEqual(fixture.waitCalls, fixture.taskIds.slice(0, 2), `${functionName} mixed Jimeng handoff must not wait the remaining task twice`);
  assert.deepEqual(fixture.pollCalls, [fixture.taskIds[2]], `${functionName} mixed Jimeng handoff must start the remaining task exactly once`);
  assert.equal(fixture.connections.some(connection => connection.from === fixture.node.id && connection.to === out.id), true, `${functionName} mixed Jimeng handoff must connect its durable output owner`);
  assert.ok(fixture.saveCalls >= 1, `${functionName} mixed Jimeng handoff must schedule durable persistence`);
}

{
  const run = { node: { id: 'mixed-completion-generator' }, refs: [] };
  const recoverable = {
    id: 'mixed-recoverable-pending',
    canvasTaskId: 'mixed-recoverable-task',
    failed: true,
    recoverTaskId: 'mixed-recoverable-submit',
    canvasTaskStatus: 'jimeng_pending',
    startedAt: 900,
    run,
  };
  const later = {
    id: 'mixed-later-pending',
    canvasTaskId: 'mixed-later-task',
    appendGenerated: true,
    startedAt: 900,
    run,
  };
  const out = { id: 'mixed-completion-output', type: 'output', _pending: [recoverable, later], images: [] };
  const generator = { id: 'mixed-completion-generator', running: false, runStatus: 'queued', runError: '' };
  const nodes = [generator, out];
  const counters = { append: 0, log: 0, merge: 0, refresh: 0, save: 0 };
  const source = [
    pendingRunCompletionSource,
    functionSource(canvasSource, 'completeRecoverPendingOutput'),
    functionSource(canvasSource, 'completeCanvasImageTask'),
  ].join('\n');
  const completed = evaluatedFunctions(source, ['completeRecoverPendingOutput', 'completeCanvasImageTask'], {
    nodes,
    findPendingTask: taskId => {
      const pending = out._pending.find(item => item.canvasTaskId === taskId);
      return pending ? { out, pending } : null;
    },
    nowMs: () => 1200,
    requestMetaFromResult: () => ({}),
    appendOutputImages: () => { counters.append += 1; },
    mergeGeneratedOutputs: () => { counters.merge += 1; },
    addGenerationLog: () => { counters.log += 1; },
    refreshRunNodes: () => { counters.refresh += 1; },
    scheduleSave: () => { counters.save += 1; },
  }).exports;

  completed.completeCanvasImageTask(later.canvasTaskId, { images: ['/mixed-later-success.png'] });
  assert.equal(generator.runStatus, 'queued', 'later task success must not mark the generator done while a recoverable task remains');
  assert.equal(generator.running, false, 'later task success must preserve the queued generator running state');
  assert.deepEqual(out._pending, [recoverable], 'later task success must retain the recoverable pending owner');
  assert.deepEqual(counters, { append: 1, log: 1, merge: 1, refresh: 1, save: 1 }, 'later task success must append, merge, log, refresh, and save exactly once');

  completed.completeCanvasImageTask(later.canvasTaskId, { images: ['/duplicate-later-success.png'] });
  assert.deepEqual(counters, { append: 1, log: 1, merge: 1, refresh: 1, save: 1 }, 'duplicate later completion must not duplicate output or logs');

  completed.completeRecoverPendingOutput(out, recoverable, { images: ['/mixed-recovered-success.png'] });
  assert.equal(generator.runStatus, 'done', 'the generator may become done after the final recoverable task completes');
  assert.equal(generator.running, false, 'final completion must leave the generator stopped');
  assert.equal(out._pending.length, 0, 'final recovery completion must release the last pending owner');
  assert.deepEqual(counters, { append: 2, log: 2, merge: 2, refresh: 2, save: 2 }, 'each distinct task completion must produce exactly one output and log');
}

{
  const run = { node: { id: 'single-completion-generator' }, refs: [] };
  const pending = { id: 'single-completion-pending', canvasTaskId: 'single-completion-task', startedAt: 900, run };
  const out = { id: 'single-completion-output', type: 'output', _pending: [pending], images: [] };
  const generator = { id: 'single-completion-generator', running: true, runStatus: 'running', runError: 'old error' };
  const nodes = [generator, out];
  let logCalls = 0;
  const completeCanvasImageTask = exportedFunction(`${pendingRunCompletionSource}\n${functionSource(canvasSource, 'completeCanvasImageTask')}`, 'completeCanvasImageTask', {
    nodes,
    findPendingTask: () => ({ out, pending }),
    nowMs: () => 1200,
    requestMetaFromResult: () => ({}),
    appendOutputImages() {},
    mergeGeneratedOutputs() {},
    addGenerationLog: () => { logCalls += 1; },
    refreshRunNodes() {},
    scheduleSave() {},
  });

  completeCanvasImageTask(pending.canvasTaskId, { images: ['/single-success.png'] });
  assert.equal(generator.runStatus, 'done', 'single-task completion must preserve existing done behavior');
  assert.equal(generator.runError, '', 'single-task completion must clear its previous error');
  assert.equal(generator.running, false, 'single-task completion must stop the generator');
  assert.equal(out._pending.length, 0, 'single-task completion must release pending ownership');
  assert.equal(logCalls, 1, 'single-task completion must log exactly once');
}

{
  const firstRun = JSON.parse(JSON.stringify({ runId: 'overlap-run-a', node: { id: 'overlap-generator' }, refs: [] }));
  const secondRun = JSON.parse(JSON.stringify({ runId: 'overlap-run-b', node: { id: 'overlap-generator' }, refs: [] }));
  const firstPending = {
    id: 'overlap-pending-a',
    canvasTaskId: 'overlap-task-a',
    startedAt: 900,
    run: firstRun,
  };
  const secondPending = {
    id: 'overlap-pending-b',
    canvasTaskId: 'overlap-task-b',
    canvasTaskStatus: 'queued',
    startedAt: 900,
    run: secondRun,
  };
  const firstOut = { id: 'overlap-output-a', type: 'output', _pending: [firstPending], images: [] };
  const secondOut = { id: 'overlap-output-b', type: 'output', _pending: [secondPending], images: [] };
  const generator = { id: 'overlap-generator', running: false, runStatus: 'queued', runError: '' };
  const nodes = [generator, firstOut, secondOut];
  const counters = { append: 0, log: 0, merge: 0, refresh: 0, save: 0 };
  const completeCanvasImageTask = exportedFunction(`${pendingRunCompletionSource}\n${functionSource(canvasSource, 'completeCanvasImageTask')}`, 'completeCanvasImageTask', {
    nodes,
    findPendingTask: taskId => {
      for (const out of [firstOut, secondOut]) {
        const pending = out._pending.find(item => item.canvasTaskId === taskId);
        if (pending) return { out, pending };
      }
      return null;
    },
    nowMs: () => 1200,
    requestMetaFromResult: () => ({}),
    appendOutputImages: () => { counters.append += 1; },
    mergeGeneratedOutputs: () => { counters.merge += 1; },
    addGenerationLog: () => { counters.log += 1; },
    refreshRunNodes: () => { counters.refresh += 1; },
    scheduleSave: () => { counters.save += 1; },
  });

  completeCanvasImageTask(firstPending.canvasTaskId, { images: ['/overlap-a.png'] });
  assert.equal(generator.runStatus, 'done', 'a run must become done when its own final task resolves despite another run on the generator');
  assert.equal(firstOut._pending.length, 0, 'the completed run must release its pending owner');
  assert.deepEqual(secondOut._pending, [secondPending], 'completion must preserve the distinct queued run');
  assert.equal(secondPending.canvasTaskStatus, 'queued', 'the distinct run must remain queued until its own completion');
  assert.deepEqual(counters, { append: 1, log: 1, merge: 1, refresh: 1, save: 1 }, 'the first overlapping run must complete exactly once');

  completeCanvasImageTask(firstPending.canvasTaskId, { images: ['/overlap-a-duplicate.png'] });
  assert.deepEqual(counters, { append: 1, log: 1, merge: 1, refresh: 1, save: 1 }, 'duplicate overlapping completion must not duplicate output or logs');

  generator.runStatus = 'queued';
  completeCanvasImageTask(secondPending.canvasTaskId, { images: ['/overlap-b.png'] });
  assert.equal(generator.runStatus, 'done', 'the second run must become done after its own final task completes');
  assert.equal(secondOut._pending.length, 0, 'the second run must release its pending owner');
  assert.deepEqual(counters, { append: 2, log: 2, merge: 2, refresh: 2, save: 2 }, 'each overlapping run must complete exactly once');
}

{
  let runSequence = 0;
  const source = [
    functionSource(canvasSource, 'runSnapshot'),
    functionSource(canvasSource, 'makePending'),
  ].join('\n');
  const created = evaluatedFunctions(source, ['runSnapshot', 'makePending'], {
    uid: prefix => `${prefix}_${++runSequence}`,
    nowMs: () => 1200,
  }).exports;

  const firstRun = created.runSnapshot({ id: 'run-id-generator', type: 'generator' }, 'first prompt');
  const secondRun = created.runSnapshot({ id: 'run-id-generator', type: 'generator' }, 'second prompt');
  assert.equal(firstRun.runId, 'run_1', 'runSnapshot must assign a durable run identity');
  assert.equal(secondRun.runId, 'run_2', 'overlapping snapshots must receive distinct run identities');

  const suppliedRun = { node: { id: 'run-id-generator' }, refs: [] };
  const firstPending = created.makePending('pending-created-a', suppliedRun);
  const secondPending = created.makePending('pending-created-b', suppliedRun);
  assert.equal(suppliedRun.runId, 'run_3', 'pending creation must backfill a stable run identity when callers do not supply one');
  assert.equal(firstPending.run.runId, suppliedRun.runId, 'the first pending record must persist the backfilled run identity');
  assert.equal(secondPending.run.runId, suppliedRun.runId, 'pending records from the same run object must share its identity');

  const existingRun = { runId: 'existing-run-id', node: { id: 'run-id-generator' }, refs: [] };
  created.makePending('pending-existing-id', existingRun);
  assert.equal(existingRun.runId, 'existing-run-id', 'pending creation must preserve an existing run identity');
}

async function legacyOverlapFixture({ currentRunId = '', persistedRunId = '', resume = false } = {}) {
  const generator = {
    id: 'legacy-overlap-generator',
    type: 'generator',
    count: 1,
    running: false,
    runStatus: 'queued',
    runError: '',
  };
  const currentRun = { node: { id: generator.id }, refs: [] };
  if (currentRunId) currentRun.runId = currentRunId;
  const persistedRun = { node: { id: generator.id }, refs: [] };
  if (persistedRunId) persistedRun.runId = persistedRunId;
  const persistedPending = JSON.parse(JSON.stringify({
    id: 'legacy-persisted-pending',
    canvasTaskId: 'legacy-persisted-task',
    canvasTaskType: 'online-image',
    canvasTaskStatus: 'queued',
    startedAt: 800,
    run: persistedRun,
  }));
  const out = { id: 'legacy-overlap-output', type: 'output', _pending: [persistedPending], images: [] };
  const nodes = [generator, out];
  const resumedTaskIds = [];
  if (resume) {
    const resumeCanvasImageTasks = exportedFunction(
      functionSource(canvasSource, 'resumeCanvasImageTasks'),
      'resumeCanvasImageTasks',
      {
        nodes,
        pollCanvasImageTask: taskId => resumedTaskIds.push(taskId),
      },
    );
    resumeCanvasImageTasks();
  }
  const counters = { append: 0, log: 0, merge: 0, refresh: 0, save: 0 };
  const source = [
    pendingRunCompletionSource,
    functionSource(canvasSource, 'runGeneratorLegacy'),
  ].join('\n');
  const runGeneratorLegacy = exportedFunction(source, 'runGeneratorLegacy', {
    nodes,
    canvasRunOwnerIsCurrent: (owner, output) => nodes.includes(owner) && (!output || nodes.includes(output)),
    orderedSources: () => [{ prompt: 'legacy prompt', refs: [] }],
    generatorSources: () => [],
    generationPromptWithMarkerDirectives: () => 'legacy prompt',
    imageRefsOnly: refs => refs,
    tr: key => key,
    outputForNode: () => out,
    uid: prefix => `${prefix}_legacy_current`,
    runSnapshot: () => currentRun,
    generatorSizeForRun: async () => '1024x1024',
    makePendingForRun: (id, run) => ({ id, startedAt: 900, run }),
    refreshRunNodes: () => { counters.refresh += 1; },
    setTimeout: () => 1,
    resolveImageProviderId: value => value,
    resolveImageModel: value => value,
    normalizedImageQuality: () => '',
    fetch: async () => ({ ok: true, json: async () => ({ images: ['/legacy-current.png'] }) }),
    responseErrorMessage: async () => 'legacy failed',
    collectRunMetas: () => [{ runMs: 300, run: currentRun }],
    requestMetaFromResult: () => ({}),
    appendOutputImages: () => { counters.append += 1; },
    mergeGeneratedOutputs: () => { counters.merge += 1; },
    addGenerationLog: () => { counters.log += 1; },
    scheduleSave: () => { counters.save += 1; },
    showErrorModal() {},
  });

  await runGeneratorLegacy(generator.id);
  return { counters, generator, out, persistedPending, resumedTaskIds };
}

{
  const fixture = await legacyOverlapFixture({ currentRunId: 'legacy-shared-run', persistedRunId: 'legacy-shared-run' });
  assert.equal(fixture.generator.runStatus, 'queued', 'runGeneratorLegacy must not mark done while its own run still has a pending task');
  assert.deepEqual(Array.from(fixture.out._pending), [fixture.persistedPending], 'runGeneratorLegacy must preserve the overlapping pending owner');
  assert.deepEqual(fixture.counters, { append: 1, log: 1, merge: 1, refresh: 2, save: 1 }, 'runGeneratorLegacy must process its completed output exactly once');
}

{
  const fixture = await legacyOverlapFixture({ currentRunId: 'legacy-current-run', persistedRunId: 'legacy-resumed-run', resume: true });
  assert.deepEqual(fixture.resumedTaskIds, ['legacy-persisted-task'], 'persisted distinct-run tasks must remain resumable');
  assert.equal(fixture.persistedPending.run.runId, 'legacy-resumed-run', 'resume must preserve the persisted run identity');
  assert.equal(fixture.generator.runStatus, 'done', 'a persisted distinct run must not block runGeneratorLegacy completion');
  assert.deepEqual(Array.from(fixture.out._pending), [fixture.persistedPending], 'distinct resumed pending ownership must remain intact');
}

{
  const fixture = await legacyOverlapFixture();
  assert.equal(fixture.generator.runStatus, 'queued', 'id-less legacy pending records must retain conservative same-generator blocking');
  assert.deepEqual(Array.from(fixture.out._pending), [fixture.persistedPending], 'id-less legacy overlap must preserve its pending owner');
}

{
  const fixture = await legacyOverlapFixture({ currentRunId: 'legacy-current-with-id' });
  assert.equal(fixture.generator.runStatus, 'queued', 'an id-less persisted pending record must conservatively block a current identified run');
  assert.deepEqual(Array.from(fixture.out._pending), [fixture.persistedPending], 'mixed-version overlap must preserve the id-less pending owner');
}

function classicPendingSettlementFixture(functionName) {
  const typeByFunction = {
    runMsGenNode: 'msgen',
    runRhNode: 'rh',
    runGeneratorLegacy: 'generator',
    runVideoNode: 'video',
    runLTXDirectorNode: 'ltxDirector',
    runComfyNode: 'comfy',
  };
  const node = {
    id: `${functionName}-stale-owner`,
    type: typeByFunction[functionName],
    count: 1,
    running: false,
    runStatus: 'running',
    runError: '',
    model: 'test-model',
    webappId: 'test-webapp',
    mode: 'text',
    width: 1024,
    height: 1024,
  };
  const out = { id: `${functionName}-stale-output`, type: 'output', _pending: [], images: [] };
  const nodes = [node, out];
  const settlement = deferred();
  const run = { runId: `${functionName}-run`, node: { id: node.id }, refs: [] };
  const counters = { alert: 0, append: 0, log: 0, merge: 0, modal: 0, refresh: 0, save: 0 };
  let settlementStarted = false;
  let uidSequence = 0;
  const globals = {
    nodes,
    cascadeTargetIdFromOptions: () => '',
    generatorSources: () => [{ prompt: 'stale owner prompt', refs: [] }],
    orderedSources: (_owner, sources) => sources,
    generationPromptWithMarkerDirectives: () => 'stale owner prompt',
    imageRefsOnly: refs => refs,
    videoRefsOnly: () => [],
    audioRefsOnly: () => [],
    outputForNode: () => out,
    uid: prefix => `${prefix}_${++uidSequence}`,
    runSnapshot: () => run,
    makePendingForRun: id => ({ id, startedAt: 900, run }),
    generatorSizeForRun: async () => '1024x1024',
    normalizedImageQuality: () => '',
    nowMs: () => 1200,
    setTimeout: () => 1,
    requestMetaFromResult: () => ({}),
    collectRunMetas: (_owner, ids) => ids.map(() => ({ runMs: 300, run })),
    collectRunMeta: () => ({ runMs: 300, run }),
    appendOutputImages: () => { counters.append += 1; },
    mergeGeneratedOutputs: () => { counters.merge += 1; },
    addGenerationLog: () => { counters.log += 1; },
    refreshRunNodes: () => { counters.refresh += 1; },
    scheduleSave: () => { counters.save += 1; },
    hasRemainingPendingTasksForRun: () => false,
    canvasRunOwnerIsCurrent: (owner, output) => nodes.includes(owner) && (!output || nodes.includes(output)),
    isCascadeAbortError: () => false,
    responseErrorMessage: async () => 'stale owner failed',
    tr: key => key,
    showErrorModal: () => { counters.modal += 1; },
    setStatus() {},
    alert: () => { counters.alert += 1; },
    resolveImageProviderId: value => value,
    resolveImageModel: value => value,
    resolveVideoProviderId: value => value,
    resultMediaUrls: result => result?.urls || result?.images || [],
    outputUrlValue: item => typeof item === 'string' ? item : item?.url || '',
    mediaKindForOutputItem: () => 'image',
    isVideoUrl: () => false,
    CLIENT_ID: 'classic-stale-client',
  };
  let successValue;

  if (functionName === 'runMsGenNode') {
    Object.assign(globals, {
      MS_GEN_MODELS: { zimage: { supportsImage: false, acceptsImage: false, endpoint: '/api/ms-stale', modelId: 'ms-test' } },
      currentMsModelId: () => 'ms-test',
      modelscopeLorasForModel: () => [],
      apiImageSize: () => '1024x1024',
      parseSizeValue: () => ({ width: 1024, height: 1024 }),
      cascadeFetch: () => { settlementStarted = true; return settlement.promise; },
      urlToBase64: async value => value,
    });
    successValue = { ok: true, json: async () => ({ url: '/late-ms.png' }) };
  } else if (functionName === 'runRhNode') {
    let submitComplete = false;
    Object.assign(globals, {
      ensureRhNodeSelection() {},
      rhCurrentKind: () => 'app',
      rhCurrentEntry: () => ({}),
      rhActiveFields: () => [{}],
      rhMediaSources: () => ({ prompt: 'rh stale prompt', refs: [] }),
      rhBuildNodeInfoList: async () => [],
      rhBuildWorkflowRequestExtras: async () => ({}),
      rhUseWallet: () => false,
      sleep: async () => {},
      cascadeFetch: url => {
        if (!submitComplete) {
          submitComplete = true;
          return Promise.resolve({ ok: true, json: async () => ({ success: true, data: { taskId: 'rh-stale-task' } }) });
        }
        assert.match(url, /runninghub\/query/, 'RunningHub fixture must defer its query settlement');
        settlementStarted = true;
        return settlement.promise;
      },
    });
    successValue = { ok: true, json: async () => ({ success: true, data: { status: 'SUCCESS', urls: ['/late-rh.png'] } }) };
  } else if (functionName === 'runGeneratorLegacy') {
    Object.assign(globals, {
      fetch: () => { settlementStarted = true; return settlement.promise; },
    });
    successValue = { ok: true, json: async () => ({ images: ['/late-legacy.png'] }) };
  } else if (functionName === 'runVideoNode') {
    Object.assign(globals, {
      applyUploadedUrlToRefs: refs => refs,
      mediaKindForRef: () => 'image',
      manualVideoUrlForNode: () => '',
      tempShUploadedUrlForNode: (_owner, value) => value,
      cascadeFetch: () => { settlementStarted = true; return settlement.promise; },
    });
    successValue = { ok: true, json: async () => ({ urls: ['/late-video.mp4'] }) };
  } else if (functionName === 'runLTXDirectorNode') {
    Object.assign(globals, {
      clearStuckGeneratorRunning() {},
      ltxFlushTimelineToNode() {},
      ltxDirectorTimelineSegments: () => [{ type: 'text', prompt: 'segment', duration: 1 }],
      ltxDirectorSyncSeconds() {},
      ltxDirectorBuildTimelinePayload: async () => ({}),
      runQueuedComfyGenerate: () => { settlementStarted = true; return settlement.promise; },
      comfyResultOutputs: result => result.images || [],
      LTX_DIRECTOR_WF_NODE: 'wf',
      LTX_DIRECTOR_SEED_NODE: 'seed',
      LTX_DIRECTOR_WORKFLOW: 'workflow.json',
    });
    successValue = { images: ['/late-ltx.png'] };
  } else {
    Object.assign(globals, {
      comfyFields: () => [],
      comfyRunLabel: () => 'ComfyUI',
      runQueuedComfyGenerate: () => { settlementStarted = true; return settlement.promise; },
      comfyResultOutputs: result => result.images || [],
      actionFailed: key => key,
      noReturnedImage: key => key,
    });
    successValue = { images: ['/late-comfy.png'] };
  }

  const runFunction = exportedFunction(functionSource(canvasSource, functionName), functionName, globals);
  const invocation = functionName === 'runRhNode' ? runFunction(node.id) : runFunction(node.id);
  let earlyError = null;
  invocation.catch(error => { earlyError = error; });
  return {
    counters,
    invocation,
    nodes,
    node,
    out,
    settlement,
    settlementStarted: () => settlementStarted,
    earlyError: () => earlyError,
    successValue,
    snapshot: () => ({ counters: { ...counters }, node: JSON.stringify(node), out: JSON.stringify(out) }),
  };
}

for (const functionName of ['runMsGenNode', 'runRhNode', 'runGeneratorLegacy', 'runVideoNode', 'runLTXDirectorNode', 'runComfyNode']) {
  for (const settlement of ['resolve', 'reject']) {
    const fixture = classicPendingSettlementFixture(functionName);
    for (let index = 0; index < 20 && !fixture.settlementStarted(); index += 1) await flushMicrotasks();
    assert.equal(fixture.settlementStarted(), true, `${functionName} ${settlement} fixture must reach deferred settlement: ${fixture.earlyError()?.stack || 'no early error'}`);
    fixture.nodes.length = 0;
    const baseline = fixture.snapshot();
    if (settlement === 'resolve') fixture.settlement.resolve(fixture.successValue);
    else fixture.settlement.reject(new Error(`late ${functionName} failure`));
    await fixture.invocation.catch(() => {});
    assert.deepEqual(fixture.snapshot(), baseline, `${functionName} late ${settlement} must not mutate captured owners or produce side effects after deletion`);
  }
}

for (const settlement of ['resolve', 'reject']) {
  const response = deferred();
  const node = { id: `classic-llm-${settlement}`, type: 'llm', running: false, outputText: '', userInput: 'prompt' };
  const nodes = [node];
  const counters = { alert: 0, refresh: 0, save: 0 };
  const runLLMNode = exportedFunction(functionSource(canvasSource, 'runLLMNode'), 'runLLMNode', {
    nodes,
    cascadeTargetIdFromOptions: () => '',
    llmInputText: () => 'prompt',
    refreshNodes: () => { counters.refresh += 1; },
    callCanvasLLM: () => response.promise,
    canvasRunOwnerIsCurrent: owner => nodes.includes(owner),
    isCascadeAbortError: () => false,
    scheduleSave: () => { counters.save += 1; },
    tr: key => key,
    alert: () => { counters.alert += 1; },
  });
  const run = runLLMNode(node.id);
  await flushMicrotasks();
  nodes.length = 0;
  const baseline = { counters: { ...counters }, node: JSON.stringify(node) };
  if (settlement === 'resolve') response.resolve('late LLM text');
  else response.reject(new Error('late classic LLM failure'));
  await run.catch(() => {});
  assert.deepEqual({ counters, node: JSON.stringify(node) }, baseline, `classic LLM late ${settlement} must ignore deleted owner settlement`);
}

for (const settlement of ['resolve', 'reject']) {
  const deferredRun = deferred();
  const node = { id: `cascade-pass-${settlement}`, type: 'generator', runStatus: '' };
  const nodes = [node];
  const counters = { refresh: 0 };
  let started = false;
  const runOneCascadePass = exportedFunction(functionSource(canvasSource, 'runOneCascadePass'), 'runOneCascadePass', {
    nodes,
    cascadeTargetIdFromOptions: () => 'cascade-owner',
    refreshNodes: () => { counters.refresh += 1; },
    ensureCascadeActive() {},
    cascadeContextFor: () => null,
    runGenerator: () => {
      started = true;
      return deferredRun.promise;
    },
    canvasRunOwnerIsCurrent: owner => nodes.includes(owner),
  });
  const run = runOneCascadePass([node.id], { cascadeTargetId: 'cascade-owner' });
  for (let index = 0; index < 10 && !started; index += 1) await flushMicrotasks();
  assert.equal(started, true, `runOneCascadePass ${settlement} fixture must reach deferred leaf runner`);
  nodes.length = 0;
  const baseline = { counters: { ...counters }, node: JSON.stringify(node) };
  if (settlement === 'resolve') deferredRun.resolve();
  else deferredRun.reject(new Error('late cascade pass failure'));
  await run;
  assert.deepEqual(
    { counters, node: JSON.stringify(node) },
    baseline,
    `runOneCascadePass late ${settlement} must not mutate or refresh a deleted leaf owner`,
  );
}

for (const mode of ['serial', 'parallel']) {
  for (const settlement of ['resolve', 'reject']) {
    const deferredRun = deferred();
    const target = { id: `node-cascade-${mode}-${settlement}`, type: 'generator', running: false, runStatus: '' };
    const loop = { id: `node-cascade-loop-${mode}-${settlement}`, type: 'loop', mode, count: 2 };
    const nodes = mode === 'parallel' ? [target, loop] : [target];
    const counters = { finalize: 0, refresh: 0 };
    let started = false;
    const runNodeCascade = exportedFunction(functionSource(canvasSource, 'runNodeCascade'), 'runNodeCascade', {
      nodes,
      alert() {},
      computeCascadeOrder: () => [target.id],
      resolveCascadeLoop: () => (mode === 'parallel' ? { node: loop, count: 2, mode: 'parallel' } : null),
      loopCount: () => 2,
      beginCascade: () => ({ message: '', currentNodeId: '', currentRoundLabel: '' }),
      refreshNodes: () => { counters.refresh += 1; },
      cascadeUiNodeIds: () => [target.id],
      cascadeParallelLimit: () => 1,
      runLimitedCascadeRounds: async (rounds, _limit, worker) => Promise.allSettled([worker(rounds[0])]),
      ensureCascadeActive() {},
      runCascadeNodeWithLoopContext: () => {
        started = true;
        return deferredRun.promise;
      },
      finalizeCascade: () => { counters.finalize += 1; },
      isCascadeAbortError: () => false,
      canvasRunOwnerIsCurrent: owner => nodes.includes(owner),
      tr: key => key,
      loopContext: null,
    });
    const run = runNodeCascade(target.id);
    for (let index = 0; index < 10 && !started; index += 1) await flushMicrotasks();
    assert.equal(started, true, `runNodeCascade ${mode} ${settlement} fixture must reach deferred leaf runner`);
    nodes.length = 0;
    const baseline = { counters: { ...counters }, target: JSON.stringify(target) };
    if (settlement === 'resolve') deferredRun.resolve();
    else deferredRun.reject(new Error('late node cascade failure'));
    await run;
    assert.deepEqual(
      { counters, target: JSON.stringify(target) },
      baseline,
      `runNodeCascade ${mode} late ${settlement} must not mutate, refresh, or finalize after exact owner deletion`,
    );
  }
}

for (const settlement of ['resolve', 'reject']) {
  const deferredPass = deferred();
  const target = { id: `retry-cascade-${settlement}`, type: 'generator', runStatus: '' };
  const nodes = [target];
  const counters = { finalize: 0 };
  let started = false;
  const retryNodeAndDownstream = exportedFunction(functionSource(canvasSource, 'retryNodeAndDownstream'), 'retryNodeAndDownstream', {
    nodes,
    isCascadeActive: () => false,
    computeCascadeOrder: () => [target.id],
    beginCascade() {},
    runOneCascadePass: () => {
      started = true;
      return deferredPass.promise;
    },
    finalizeCascade: () => { counters.finalize += 1; },
    isCascadeAbortError: () => false,
    canvasRunOwnerIsCurrent: owner => nodes.includes(owner),
  });
  const run = retryNodeAndDownstream(target.id);
  for (let index = 0; index < 10 && !started; index += 1) await flushMicrotasks();
  assert.equal(started, true, `retryNodeAndDownstream ${settlement} fixture must reach deferred cascade pass`);
  nodes.length = 0;
  const baseline = { counters: { ...counters }, target: JSON.stringify(target) };
  if (settlement === 'resolve') deferredPass.resolve();
  else deferredPass.reject(new Error('late retry cascade failure'));
  await run;
  assert.deepEqual(
    { counters, target: JSON.stringify(target) },
    baseline,
    `retryNodeAndDownstream late ${settlement} must not finalize a deleted cascade owner`,
  );
}

{
  const target = { id: 'retry-cascade-incomplete', type: 'generator', runStatus: 'running' };
  const nodes = [target];
  let finalizeCalls = 0;
  const retryNodeAndDownstream = exportedFunction(functionSource(canvasSource, 'retryNodeAndDownstream'), 'retryNodeAndDownstream', {
    nodes,
    isCascadeActive: () => false,
    computeCascadeOrder: () => [target.id, 'deleted-downstream'],
    beginCascade() {},
    runOneCascadePass: async () => false,
    finalizeCascade: () => { finalizeCalls += 1; },
    isCascadeAbortError: () => false,
    canvasRunOwnerIsCurrent: owner => nodes.includes(owner),
  });

  await retryNodeAndDownstream(target.id);
  assert.equal(finalizeCalls, 0, 'retry must not finalize done when its cascade pass reports stale downstream ownership');
}

for (const settlement of ['resolve', 'reject']) {
  const deferredRun = deferred();
  const node = { id: `cascade-loop-context-${settlement}`, type: 'generator' };
  const nodes = [node];
  let started = false;
  const runCascadeNodeWithLoopContext = exportedFunction(
    functionSource(canvasSource, 'runCascadeNodeWithLoopContext'),
    'runCascadeNodeWithLoopContext',
    {
      nodes,
      loopContext: null,
      runCascadeNodeByType: () => {
        started = true;
        return deferredRun.promise;
      },
      canvasRunOwnerIsCurrent: owner => nodes.includes(owner),
    },
  );
  const run = runCascadeNodeWithLoopContext(node, { index: 1 }, {});
  for (let index = 0; index < 10 && !started; index += 1) await flushMicrotasks();
  assert.equal(started, true, `runCascadeNodeWithLoopContext ${settlement} fixture must reach deferred runner`);
  nodes.length = 0;
  const baseline = JSON.stringify(node);
  if (settlement === 'resolve') deferredRun.resolve();
  else deferredRun.reject(new Error('late loop context failure'));
  await run.catch(() => {});
  assert.equal(JSON.stringify(node), baseline, `runCascadeNodeWithLoopContext late ${settlement} must not clean up a deleted owner`);
}

for (const [functionName, runArgument] of [
  ['runMsGenNode', 'run'],
  ['runRhNode', 'run'],
  ['runGeneratorLegacy', 'run'],
  ['runVideoNode', 'run'],
  ['runLTXDirectorNode', 'run'],
  ['runComfyNode', 'run'],
  ['completeRecoverPendingOutput', 'pending'],
  ['completeCanvasImageTask', 'pending'],
]) {
  const source = functionSource(canvasSource, functionName);
  assert.ok(
    source.includes(`hasRemainingPendingTasksForRun(${runArgument})`),
    `${functionName} must gate done state through run-scoped pending ownership`,
  );
}

assert.equal(
  /runStatus\s*=\s*['"]done['"]/.test(smartCanvasSource),
  false,
  'smart canvas must not contain an unaudited runStatus done-setting path',
);

{
  const activeCanvasTaskPolls = new Set();
  let fetchCalls = 0;
  const pollCanvasImageTask = exportedFunction(ordinaryPollSource, 'pollCanvasImageTask', {
    activeCanvasTaskPolls,
    findPendingTask: () => null,
    ensureCascadeActive() {},
    cascadeFetch: async () => {
      fetchCalls += 1;
      return { ok: true, json: async () => ({ status: 'succeeded' }) };
    },
    completeCanvasImageTask() {},
    failCanvasImageTask() {},
    sleep: async () => {},
    tr: key => key,
  });

  const status = await pollCanvasImageTask('ordinary-missing');
  assert.equal(status, 'missing', 'ordinary polling should return missing when no pending owner exists');
  assert.equal(fetchCalls, 0, 'ordinary polling must check pending ownership before fetching');
  assert.equal(activeCanvasTaskPolls.has('ordinary-missing'), false, 'missing ordinary tasks must release active poll ownership');
}

{
  const activeCanvasTaskPolls = new Set();
  const response = deferred();
  const failures = [];
  const completions = [];
  let fetchCalls = 0;
  const pollCanvasImageTask = exportedFunction(ordinaryPollSource, 'pollCanvasImageTask', {
    activeCanvasTaskPolls,
    findPendingTask: () => ({ pending: {}, out: {} }),
    ensureCascadeActive() {},
    cascadeFetch: () => {
      fetchCalls += 1;
      return response.promise;
    },
    completeCanvasImageTask: (...args) => completions.push(args),
    failCanvasImageTask: (...args) => failures.push(args),
    sleep: async () => {},
    tr: key => key,
  });

  const firstPoll = pollCanvasImageTask('ordinary-succeeded');
  assert.equal(activeCanvasTaskPolls.has('ordinary-succeeded'), true, 'ordinary polling must claim active ownership before awaiting fetch');
  assert.equal(await pollCanvasImageTask('ordinary-succeeded'), 'running', 'a duplicate ordinary poll must report the existing active owner');
  assert.equal(fetchCalls, 1, 'a duplicate ordinary poll must not start another fetch');

  const result = { images: [{ url: '/generated.png' }] };
  response.resolve({ ok: true, json: async () => ({ status: 'succeeded', result }) });
  assert.equal(await firstPoll, 'succeeded', 'ordinary polling must return succeeded for a successful API task');
  assert.equal(completions.length, 1, 'ordinary polling must delegate successful API tasks to completeCanvasImageTask');
  assert.strictEqual(completions[0][1], result, 'ordinary completion should pass through the API result');
  assert.equal(failures.length, 0, 'ordinary success must not invoke failure handling');
  assert.equal(activeCanvasTaskPolls.has('ordinary-succeeded'), false, 'successful ordinary tasks must release active poll ownership');
}

{
  const activeCanvasTaskPolls = new Set();
  const response = deferred();
  const failures = [];
  const pollCanvasImageTask = exportedFunction(ordinaryPollSource, 'pollCanvasImageTask', {
    activeCanvasTaskPolls,
    findPendingTask: () => ({ pending: {}, out: {} }),
    ensureCascadeActive() {},
    cascadeFetch: () => response.promise,
    completeCanvasImageTask() {},
    failCanvasImageTask: (...args) => failures.push(args),
    sleep: async () => {},
    tr: key => key,
    normalizeCanvasTaskError: error => error.message,
    isCascadeAbortError: () => false,
  });

  const poll = pollCanvasImageTask('ordinary-rejected');
  assert.equal(activeCanvasTaskPolls.has('ordinary-rejected'), true, 'ordinary polling must retain ownership while fetch is pending');
  response.reject(new Error('ordinary transport failed'));
  assert.equal(await poll, 'failed', 'ordinary polling must return failed after a rejected fetch');
  assert.equal(failures.length, 1, 'ordinary rejected fetches must invoke failure handling once');
  assert.equal(failures[0][1], 'ordinary transport failed', 'ordinary rejected fetches must retain the transport error');
  assert.equal(activeCanvasTaskPolls.has('ordinary-rejected'), false, 'rejected ordinary tasks must release active poll ownership');
}

{
  const activeCanvasTaskPolls = new Set();
  const response = deferred();
  const failures = [];
  const taskData = { status: 'failed', error: 'ordinary API failed' };
  const pollCanvasImageTask = exportedFunction(ordinaryPollSource, 'pollCanvasImageTask', {
    activeCanvasTaskPolls,
    findPendingTask: () => ({ pending: {}, out: {} }),
    ensureCascadeActive() {},
    cascadeFetch: () => response.promise,
    completeCanvasImageTask() {},
    failCanvasImageTask: (...args) => failures.push(args),
    sleep: async () => {},
    tr: key => key,
  });

  const poll = pollCanvasImageTask('ordinary-failed');
  assert.equal(activeCanvasTaskPolls.has('ordinary-failed'), true, 'ordinary failed API tasks must retain ownership while fetch is pending');
  response.resolve({ ok: true, json: async () => taskData });
  assert.equal(await poll, 'failed', 'ordinary polling must return failed for a failed API task');
  assert.equal(failures.length, 1, 'ordinary polling must delegate failed API tasks to failCanvasImageTask');
  assert.equal(failures[0][0], 'ordinary-failed', 'ordinary API failure handling must retain the task ID');
  assert.equal(failures[0][1], taskData.error, 'ordinary API failure handling must retain the API error');
  assert.strictEqual(failures[0][2], taskData, 'ordinary API failure handling must pass through API task metadata');
  assert.equal(activeCanvasTaskPolls.has('ordinary-failed'), false, 'failed ordinary API tasks must release active poll ownership');
}

{
  const taskStates = [
    { status: 'queued' },
    { status: 'running' },
    { status: 'jimeng_pending', submit_id: 'jimeng-submit-1', kind: 'image', message: 'queued remotely' },
  ];
  const handoffs = [];
  let fetchCalls = 0;
  const pollCanvasImageTask = exportedFunction(ordinaryPollSource, 'pollCanvasImageTask', {
    activeCanvasTaskPolls: new Set(),
    findPendingTask: () => ({ pending: {}, out: {} }),
    ensureCascadeActive() {},
    cascadeFetch: async () => {
      fetchCalls += 1;
      const task = taskStates.shift();
      if (!task) throw new Error('ordinary polling fetched after permanent jimeng_pending');
      return { ok: true, json: async () => task };
    },
    completeCanvasImageTask() {},
    failCanvasImageTask() {},
    handoffCanvasJimengTask: (...args) => {
      handoffs.push(args);
      return true;
    },
    sleep: async () => {},
    tr: key => key,
    normalizeCanvasTaskError: error => error.message,
    isCascadeAbortError: () => false,
  });

  const status = await pollCanvasImageTask('ordinary-jimeng');
  assert.equal(status, 'jimeng_pending', 'ordinary polling must terminate by handing off a permanent jimeng_pending task');
  assert.equal(fetchCalls, 3, 'ordinary polling should traverse queued and running states before jimeng handoff');
  assert.equal(handoffs.length, 1, 'ordinary polling must hand jimeng_pending ownership to durable pending state exactly once');
  assert.equal(handoffs[0][0], 'ordinary-jimeng', 'ordinary jimeng handoff must retain the canvas task ID');
  assert.equal(handoffs[0][1].submit_id, 'jimeng-submit-1', 'ordinary jimeng handoff must retain the upstream submit ID');
}

{
  const pending = {
    id: 'pending-jimeng',
    run: { node: { id: 'generator-jimeng' } },
  };
  const out = { id: 'output-jimeng', _pending: [pending] };
  const generator = { id: 'generator-jimeng', running: true, runStatus: 'running', runError: 'old error' };
  let saveCalls = 0;
  const handoffCanvasJimengTask = exportedFunction(
    functionSource(canvasSource, 'handoffCanvasJimengTask'),
    'handoffCanvasJimengTask',
    {
      findPendingTask: () => ({ out, pending }),
      nodes: [generator],
      tr: key => key,
      refreshRunNodes() {},
      scheduleSave: () => { saveCalls += 1; },
    },
  );

  assert.equal(handoffCanvasJimengTask('ordinary-jimeng', {
    status: 'jimeng_pending',
    submit_id: 'jimeng-submit-1',
    kind: 'image',
    queue_info: { queue_idx: 2, queue_length: 8 },
    message: 'queued remotely',
  }), true, 'classic jimeng handoff must claim a still-owned pending task');
  assert.equal(pending.failed, true, 'classic jimeng handoff must render through durable recoverable pending state');
  assert.equal(pending.recoverTaskId, 'jimeng-submit-1', 'classic jimeng handoff must persist the submit ID');
  assert.equal(pending.canvasTaskStatus, 'jimeng_pending', 'classic jimeng handoff must retain its distinct terminal poll status');
  assert.equal(pending.jimengKind, 'image', 'classic jimeng handoff must retain the media kind for manual query');
  assert.equal(generator.runStatus, 'queued', 'classic jimeng handoff must leave the generator queued instead of failed');
  assert.equal(generator.running, false, 'classic jimeng handoff must clear the generator running flag');
  assert.equal(saveCalls, 1, 'classic jimeng handoff must persist the durable pending record');
}

{
  const pending = {
    id: 'pending-jimeng-query',
    failed: true,
    recoverTaskId: 'jimeng-submit-query',
    canvasTaskStatus: 'jimeng_pending',
    jimengKind: 'image',
  };
  const out = { id: 'output-jimeng-query', _pending: [pending] };
  const requests = [];
  const completions = [];
  const queryRecoverPendingOutput = exportedFunction(
    [
      functionSource(canvasSource, 'currentRecoverPendingOutput'),
      functionSource(canvasSource, 'queryRecoverPendingOutput'),
    ].join('\n'),
    'queryRecoverPendingOutput',
    {
      findOutputByPendingId: () => out,
      pendingById: (owner, pendingId) => owner?._pending?.find(item => item.id === pendingId),
      extractUpstreamTaskId: () => '',
      refreshNodes() {},
      fetch: async (url, options) => {
        requests.push({ url, options });
        return { ok: true, json: async () => ({ status: 'succeeded', urls: ['/jimeng-result.png'], kind: 'image' }) };
      },
      providerIdForPending: () => 'jimeng',
      completeRecoverPendingOutput: (...args) => completions.push(args),
      failRecoverPendingOutput() {},
      responseErrorMessage: async () => 'query failed',
      tr: key => key,
      showErrorModal() {},
      setStatus() {},
      scheduleSave() {},
    },
  );

  await queryRecoverPendingOutput(pending.id);
  assert.equal(requests[0].url, '/api/jimeng/query-media', 'classic jimeng recovery must use the Jimeng query endpoint');
  assert.deepEqual(
    JSON.parse(requests[0].options.body),
    { submit_id: 'jimeng-submit-query', kind: 'image' },
    'classic jimeng recovery must query with its persisted submit ID and media kind',
  );
  assert.deepEqual(completions[0][2].images, ['/jimeng-result.png'], 'classic jimeng recovery must adapt returned URLs into classic output images');
}

function recoveryQueryFixture() {
  const response = deferred();
  const pending = {
    id: 'pending-recovery-settlement',
    failed: true,
    querying: false,
    recoverTaskId: 'jimeng-recovery-settlement',
    canvasTaskStatus: 'jimeng_pending',
    jimengKind: 'image',
    startedAt: 900,
    run: { node: { id: 'generator-recovery-settlement' } },
  };
  const out = { id: 'output-recovery-settlement', _pending: [pending], images: [] };
  const generator = { id: 'generator-recovery-settlement', runStatus: 'queued', running: false };
  const nodes = [out, generator];
  let ownerPresent = true;
  const counters = {
    append: 0,
    fetch: 0,
    log: 0,
    modal: 0,
    refresh: 0,
    refreshRun: 0,
    save: 0,
    status: 0,
  };
  const source = [
    functionSource(canvasSource, 'currentRecoverPendingOutput'),
    pendingRunCompletionSource,
    functionSource(canvasSource, 'completeRecoverPendingOutput'),
    functionSource(canvasSource, 'failRecoverPendingOutput'),
    functionSource(canvasSource, 'queryRecoverPendingOutput'),
  ].join('\n');
  const queryRecoverPendingOutput = exportedFunction(source, 'queryRecoverPendingOutput', {
    findOutputByPendingId: () => (ownerPresent ? out : null),
    pendingById: (owner, pendingId) => owner?._pending?.find(item => item.id === pendingId),
    extractUpstreamTaskId: () => '',
    refreshNodes: () => { counters.refresh += 1; },
    fetch: () => {
      counters.fetch += 1;
      return response.promise;
    },
    providerIdForPending: () => 'jimeng',
    responseErrorMessage: async () => 'query failed',
    tr: key => key,
    showErrorModal: () => { counters.modal += 1; },
    setStatus: () => { counters.status += 1; },
    scheduleSave: () => { counters.save += 1; },
    nowMs: () => 1000,
    requestMetaFromResult: () => ({}),
    appendOutputImages: () => { counters.append += 1; },
    nodes,
    mergeGeneratedOutputs() {},
    addGenerationLog: () => { counters.log += 1; },
    refreshRunNodes: () => { counters.refreshRun += 1; },
  });
  return {
    counters,
    deleteOwner() {
      ownerPresent = false;
      nodes.length = 0;
    },
    generator,
    nodes,
    out,
    pending,
    queryRecoverPendingOutput,
    response,
    snapshot() {
      return {
        counters: { ...counters },
        pending: JSON.stringify(pending),
      };
    },
  };
}

{
  const fixture = recoveryQueryFixture();
  const query = fixture.queryRecoverPendingOutput(fixture.pending.id);
  fixture.response.resolve({
    ok: true,
    json: async () => ({ status: 'failed', error: 'jimeng terminal failure' }),
  });
  await query;
  assert.equal(fixture.out._pending.length, 0, 'failed Jimeng recovery must remove its recoverable pending record');
  assert.equal(fixture.pending.canvasTaskStatus, 'failed', 'failed Jimeng recovery must enter terminal failed status');
  assert.equal(fixture.pending.recoverTaskId, '', 'failed Jimeng recovery must clear its repeatedly queryable task ID');
  assert.equal(fixture.generator.runStatus, 'failed', 'failed Jimeng recovery must mark the generator failed');
  assert.equal(fixture.generator.running, false, 'failed Jimeng recovery must leave the generator stopped');
  assert.equal(fixture.counters.log, 1, 'failed Jimeng recovery must add one terminal generation log');
  assert.equal(fixture.counters.modal, 1, 'failed Jimeng recovery may report its terminal error while ownership is current');
  await fixture.queryRecoverPendingOutput(fixture.pending.id);
  assert.equal(fixture.counters.fetch, 1, 'failed Jimeng recovery must not be queryable again after terminalization');
}

{
  const fixture = recoveryQueryFixture();
  const query = fixture.queryRecoverPendingOutput(fixture.pending.id);
  fixture.deleteOwner();
  const baseline = fixture.snapshot();
  fixture.response.resolve({
    ok: true,
    json: async () => ({ status: 'succeeded', urls: ['/late-recovery.png'], kind: 'image' }),
  });
  await query;
  assert.deepEqual(fixture.snapshot(), baseline, 'late recovery success after owner deletion must not mutate, refresh, save, log, or show a modal');
  assert.equal(fixture.nodes.length, 0, 'late recovery success must not resurrect deleted owners');
}

{
  const fixture = recoveryQueryFixture();
  const query = fixture.queryRecoverPendingOutput(fixture.pending.id);
  fixture.deleteOwner();
  const baseline = fixture.snapshot();
  fixture.response.reject(new Error('late recovery transport failure'));
  await query;
  assert.deepEqual(fixture.snapshot(), baseline, 'late recovery rejection after owner deletion must not mutate, refresh, save, log, or show a modal');
  assert.equal(fixture.nodes.length, 0, 'late recovery rejection must not resurrect deleted owners');
}

{
  const activeCanvasTaskPolls = new Set();
  const response = deferred();
  const pending = { id: 'pending-deleted', run: { node: { id: 'generator-deleted' } } };
  const out = { id: 'output-deleted', _pending: [pending], images: [] };
  const nodes = [out, { id: 'generator-deleted', type: 'generator' }];
  let ownerPresent = true;
  let appendCalls = 0;
  let logCalls = 0;
  let saveCalls = 0;
  const sources = `${ordinaryPollSource}\n${pendingRunCompletionSource}\n${functionSource(canvasSource, 'completeCanvasImageTask')}`;
  const { pollCanvasImageTask } = evaluatedFunctions(
    sources,
    ['pollCanvasImageTask', 'completeCanvasImageTask'],
    {
      activeCanvasTaskPolls,
      findPendingTask: () => (ownerPresent ? { out, pending } : null),
      ensureCascadeActive() {},
      cascadeFetch: () => response.promise,
      failCanvasImageTask() {},
      sleep: async () => {},
      tr: key => key,
      nowMs: () => 1000,
      requestMetaFromResult: () => ({}),
      appendOutputImages: () => { appendCalls += 1; },
      nodes,
      mergeGeneratedOutputs() {},
      addGenerationLog: () => { logCalls += 1; },
      refreshRunNodes() {},
      scheduleSave: () => { saveCalls += 1; },
    },
  ).exports;

  const poll = pollCanvasImageTask('ordinary-owner-deleted');
  assert.equal(activeCanvasTaskPolls.has('ordinary-owner-deleted'), true, 'classic stale-owner fixture must begin with active poll ownership');
  ownerPresent = false;
  nodes.length = 0;
  response.resolve({
    ok: true,
    json: async () => ({ status: 'succeeded', result: { images: ['/must-not-resurrect.png'] } }),
  });
  assert.equal(await poll, 'succeeded', 'classic transport may settle successfully after its pending output is deleted');
  assert.equal(appendCalls, 0, 'classic owner deletion must prevent late output mutation');
  assert.equal(logCalls, 0, 'classic owner deletion must prevent late generation logging');
  assert.equal(saveCalls, 0, 'classic owner deletion must prevent late saves');
  assert.equal(nodes.length, 0, 'classic owner deletion must not resurrect deleted nodes');
  assert.equal(activeCanvasTaskPolls.has('ordinary-owner-deleted'), false, 'classic stale-owner settlement must release poll ownership');
}

{
  const pending = {
    id: 'pending-terminal',
    startedAt: 900,
    run: { node: { id: 'generator-terminal' } },
  };
  const out = { _pending: [pending] };
  const generator = { id: 'generator-terminal', running: true, runStatus: 'running' };
  const generationLogs = [];
  const failCanvasImageTask = exportedFunction(
    functionSource(canvasSource, 'failCanvasImageTask'),
    'failCanvasImageTask',
    {
      findPendingTask: () => ({ out, pending }),
      nowMs: () => 1000,
      extractUpstreamTaskId: () => '',
      nodes: [generator],
      tr: key => key,
      addGenerationLog: entry => generationLogs.push(entry),
      refreshRunNodes() {},
      scheduleSave() {},
    },
  );

  failCanvasImageTask('ordinary-terminal', 'terminal generation failure');
  assert.equal(generator.runStatus, 'failed', 'failCanvasImageTask must mark the generator run as failed');
  assert.equal(generator.running, false, 'failCanvasImageTask must clear the generator running flag');
  assert.equal(generationLogs.length, 1, 'failCanvasImageTask must add a generation log entry');
  assert.equal(generationLogs[0].error, 'terminal generation failure', 'the generation log must retain the terminal error');
}

{
  const resumedTaskIds = [];
  const resumeCanvasImageTasks = exportedFunction(
    functionSource(canvasSource, 'resumeCanvasImageTasks'),
    'resumeCanvasImageTasks',
    {
      nodes: [{
        type: 'output',
        _pending: [
          { canvasTaskType: 'online-image', canvasTaskId: 'failed-pending', failed: true },
          { canvasTaskType: 'online-image', canvasTaskId: 'live-pending', cascadeTargetId: 'cascade-live' },
        ],
      }],
      pollCanvasImageTask: taskId => resumedTaskIds.push(taskId),
    },
  );

  resumeCanvasImageTasks();
  assert.deepEqual(resumedTaskIds, ['live-pending'], 'resumeCanvasImageTasks must skip pending records already marked failed');
}

{
  const run = { runId: 'classic-empty-success-run', node: { id: 'classic-empty-success-generator' }, refs: [] };
  const pending = {
    id: 'classic-empty-success-pending',
    recoverTaskId: 'classic-empty-success-task',
    canvasTaskStatus: 'jimeng_pending',
    querying: true,
    startedAt: 900,
    run,
  };
  const out = { id: 'classic-empty-success-output', type: 'output', _pending: [pending], images: [] };
  const generator = { id: 'classic-empty-success-generator', type: 'generator', running: false, runStatus: 'queued', runError: '' };
  const nodes = [generator, out];
  const logs = [];
  const source = [
    functionSource(canvasSource, 'currentRecoverPendingOutput'),
    functionSource(canvasSource, 'failRecoverPendingOutput'),
    functionSource(canvasSource, 'completeRecoverPendingOutput'),
  ].join('\n');
  const completeRecoverPendingOutput = exportedFunction(source, 'completeRecoverPendingOutput', {
    nodes,
    findOutputByPendingId: pendingId => nodes.find(node => node.type === 'output' && node._pending?.some(item => item.id === pendingId)),
    pendingById: (owner, pendingId) => owner?._pending?.find(item => item.id === pendingId) || null,
    nowMs: () => 1200,
    requestMetaFromResult: () => ({}),
    appendOutputImages() {},
    mergeGeneratedOutputs() {},
    hasRemainingPendingTasksForRun: () => false,
    addGenerationLog: entry => logs.push(entry),
    refreshRunNodes() {},
    scheduleSave() {},
    tr: key => key,
  });

  completeRecoverPendingOutput(out, pending, { status: 'succeeded', images: [] });
  assert.equal(out._pending.length, 0, 'classic empty recovery success must release pending ownership');
  assert.equal(pending.recoverTaskId, '', 'classic empty recovery success must clear the recoverable task identity');
  assert.equal(pending.querying, false, 'classic empty recovery success must release query ownership');
  assert.equal(generator.runStatus, 'failed', 'classic empty recovery success must become terminal failure');
  assert.equal(logs.length, 1, 'classic empty recovery success must log terminal failure once');

  completeRecoverPendingOutput(out, pending, { status: 'succeeded', images: [] });
  assert.equal(logs.length, 1, 'classic empty recovery success must not terminalize or log twice');
}

{
  const node = {
    id: 'smart-empty-jimeng-owner',
    type: 'smart-image',
    images: [],
    running: false,
    pending: 0,
    runStatus: 'queued',
    runStartedAt: 900,
    runSettings: { engine: 'api', provider_id: 'jimeng' },
    runPrompt: 'smart empty Jimeng prompt',
    jimengPending: { submitId: 'smart-empty-jimeng-task', kind: 'image', querying: true, startedAt: 900 },
  };
  const nodes = [node];
  const counters = { log: 0, render: 0, save: 0, toast: 0 };
  const source = [
    functionSource(smartCanvasSource, 'finalizeJimengPending'),
    functionSource(smartCanvasSource, 'terminalizeSmartJimengPending'),
    functionSource(smartCanvasSource, 'applyJimengQueryResult'),
  ].join('\n');
  const applyJimengQueryResult = exportedFunction(source, 'applyJimengQueryResult', {
    nodes,
    stripImageGenerationMeta: value => value,
    copyMediaSizeFields: (_item, value) => value,
    replaceOutputsToNodeWithHistory() {},
    nowMs: () => 1200,
    addSmartGenerationLog: () => { counters.log += 1; },
    toast: () => { counters.toast += 1; },
    render: () => { counters.render += 1; },
    scheduleSave: () => { counters.save += 1; },
    tr: key => key,
  });

  assert.equal(applyJimengQueryResult(node, { status: 'succeeded', urls: [], kind: 'image' }), true, 'smart empty Jimeng success must terminalize');
  assert.equal('jimengPending' in node, false, 'smart empty Jimeng success must clear pending ownership');
  assert.equal(node.runStatus, 'failed', 'smart empty Jimeng success must become terminal failure');
  assert.equal(counters.log, 1, 'smart empty Jimeng success must log terminal failure once');
  assert.equal(counters.toast, 1, 'smart empty Jimeng success must report terminal failure once');
  const terminalCounters = { ...counters };
  assert.equal(applyJimengQueryResult(node, { status: 'succeeded', urls: [], kind: 'image' }), false, 'smart empty Jimeng success must not terminalize twice');
  assert.deepEqual(counters, terminalCounters, 'smart empty Jimeng repeat must have no side effects');
}

const smartPollSource = functionSource(smartCanvasSource, 'pollSmartCanvasTask');

function smartPollFixture() {
  const activeSmartTaskPolls = new Map();
  const fetchResponse = deferred();
  const timers = [];
  let fetchCalls = 0;
  class JimengPendingSignal extends Error {}
  class ImageTaskRecoverSignal extends Error {}
  const pollSmartCanvasTask = exportedFunction(smartPollSource, 'pollSmartCanvasTask', {
    activeSmartTaskPolls,
    setTimeout: resolve => {
      timers.push(resolve);
      return timers.length;
    },
    fetch: async () => {
      fetchCalls += 1;
      return fetchResponse.promise;
    },
    tr: key => key,
    extractUpstreamTaskId: () => '',
    JimengPendingSignal,
    ImageTaskRecoverSignal,
  });
  return {
    activeSmartTaskPolls,
    fetchCalls: () => fetchCalls,
    fetchResponse,
    pollSmartCanvasTask,
    releaseTimer() {
      const resolve = timers.shift();
      assert.ok(resolve, 'smart poll fixture should have a deferred timer to release');
      resolve();
    },
    timerCount: () => timers.length,
  };
}

{
  const fixture = smartPollFixture();
  const firstPoll = fixture.pollSmartCanvasTask('smart-succeeded');
  const duplicatePoll = fixture.pollSmartCanvasTask('smart-succeeded');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-succeeded'), true, 'smart polling must publish active ownership before its timer settles');
  assert.equal(fixture.timerCount(), 1, 'a duplicate smart poll must share the existing timer');
  fixture.releaseTimer();
  await flushMicrotasks();
  assert.equal(fixture.fetchCalls(), 1, 'a duplicate smart poll must share the existing fetch');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-succeeded'), true, 'smart polling must retain ownership while fetch is pending');

  const result = { images: ['/smart-generated.png'] };
  fixture.fetchResponse.resolve({ ok: true, json: async () => ({ status: 'succeeded', result }), text: async () => '' });
  assert.strictEqual(await firstPoll, result, 'smart polling must resolve the successful API task result');
  assert.strictEqual(await duplicatePoll, result, 'a duplicate smart poll must resolve the shared API task result');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-succeeded'), false, 'successful smart tasks must release active poll ownership');
}

{
  const fixture = smartPollFixture();
  const poll = fixture.pollSmartCanvasTask('smart-failed');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-failed'), true, 'smart polling must retain ownership while its timer is pending');
  fixture.releaseTimer();
  await flushMicrotasks();
  fixture.fetchResponse.resolve({
    ok: true,
    json: async () => ({ status: 'failed', error: 'smart API failed' }),
    text: async () => '',
  });
  await assert.rejects(poll, /smart API failed/, 'smart polling must reject with the failed API task error');
  assert.equal(fixture.fetchCalls(), 1, 'smart failed polling should fetch the API task once');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-failed'), false, 'failed smart tasks must release active poll ownership');
}

{
  const fixture = smartPollFixture();
  const poll = fixture.pollSmartCanvasTask('smart-rejected');
  fixture.releaseTimer();
  await flushMicrotasks();
  assert.equal(fixture.activeSmartTaskPolls.has('smart-rejected'), true, 'smart polling must retain ownership while fetch is pending');
  fixture.fetchResponse.reject(new Error('smart transport failed'));
  await assert.rejects(poll, /smart transport failed/, 'smart polling must reject with the transport error');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-rejected'), false, 'rejected smart tasks must release active poll ownership');
}

function smartDirectGenerationFixture() {
  const generation = deferred();
  const node = { id: 'smart-direct-owner', type: 'smart-image', images: [], running: false };
  const nodes = [node];
  const counters = { log: 0, render: 0, save: 0, toast: 0 };
  let generationStarted = false;
  const settings = { engine: 'api', apiKind: 'image', count: 1, provider_id: 'provider-a', model: 'model-a' };
  const runGeneration = exportedFunction([
    functionSource(smartCanvasSource, 'smartRunOwnersAreCurrent'),
    functionSource(smartCanvasSource, 'smartDirectRunOwnerIsCurrent'),
    functionSource(smartCanvasSource, 'runGeneration'),
  ].join('\n'), 'runGeneration', {
    nodes,
    selectedNode: () => node,
    buildPromptRequest: () => ({ prompt: 'smart direct prompt', refs: [], displayPrompt: 'smart direct prompt' }),
    smartLoopContext: null,
    smartNodeInFlight: () => false,
    settings,
    cloneSmartSettings: value => ({ ...(value || {}) }),
    smartSettingsForNode: () => null,
    smartRunNeedsPrompt: () => true,
    toast: () => { counters.toast += 1; },
    tr: key => key,
    snapshotRunMeta: () => ({ sourceNodeId: node.id, settings: { ...settings }, createdAt: 1000 }),
    smartRunSnapshot: () => ({ nodeId: node.id, nodeType: node.type, kind: 'image', settings: { ...settings }, prompt: 'smart direct prompt', refs: [] }),
    rememberRecentSmartSettings() {},
    nowMs: () => 1000,
    isApiLikeEngine: engine => engine === 'api',
    isSmartGroupNode: () => false,
    isSmartImageNode: () => true,
    imagesForNode: target => target.images || [],
    smartImageUsesWorkflowInput: () => false,
    pushUndo() {},
    undoSuppressed: false,
    stripRunInputMeta: value => value,
    createPendingOutputFromSource: () => null,
    pendingBoxSize: () => ({ w: 240, h: 180 }),
    attachRunMeta() {},
    coolNodeRunningState() {},
    syncRunButtonState() {},
    render: () => { counters.render += 1; },
    runApiGeneration: () => {
      generationStarted = true;
      return generation.promise;
    },
    runningHubSelectedModel: () => null,
    runningHubModelApiSettings: value => value,
    runRunningHubGeneration: async () => [],
    runModelscopeGeneration: async () => [],
    scheduleSave: () => { counters.save += 1; },
    saveCanvas: async () => {},
    resumeSmartPendingNode: async () => {},
    smartRecoverableImageTask: () => null,
    restoreSourceVisualState() {},
    clearPromptInput() {},
    addSmartGenerationLog: () => { counters.log += 1; },
    finalizePendingNode() {},
    handleJimengPendingSignal: () => false,
    trackSmartDeletedNodeIds() {},
    canvas: { connections: [] },
    selectedId: node.id,
    restoreFromExtraction() {},
    clearNodeRunningState() {},
  });
  return {
    counters,
    generation,
    generationStarted: () => generationStarted,
    node,
    nodes,
    runGeneration,
    snapshot() {
      return { counters: { ...counters }, node: JSON.stringify(node) };
    },
  };
}

for (const settlement of ['resolve', 'reject']) {
  const fixture = smartDirectGenerationFixture();
  const run = fixture.runGeneration();
  for (let index = 0; index < 10 && !fixture.generationStarted(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(fixture.generationStarted(), true, `smart direct ${settlement} fixture must reach deferred generation`);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  if (settlement === 'resolve') {
    fixture.generation.resolve({ taskIds: ['smart-direct-task'], providerId: 'provider-a', model: 'model-a' });
  } else {
    fixture.generation.reject(new Error('late smart direct failure'));
  }
  await run;
  assert.deepEqual(fixture.snapshot(), baseline, `smart direct late ${settlement} must not mutate, log, save, render, or toast after deletion`);
  assert.equal(fixture.nodes.length, 0, `smart direct late ${settlement} must not resurrect its node`);
}

function smartTextGenerationOwnershipFixture() {
  const generation = deferred();
  const sourceNode = { id: 'smart-text-source', type: 'smart-image', images: [{ url: '/source.png', name: 'source.png' }] };
  const outputNode = { id: 'smart-text-output', type: 'smart-image', images: [], pending: 1, running: false };
  const nodes = [sourceNode, outputNode];
  const counters = { log: 0, replace: 0, render: 0, save: 0, toast: 0, track: 0 };
  let generationStarted = false;
  const source = [
    functionSource(smartCanvasSource, 'smartRunOwnersAreCurrent'),
    functionSource(smartCanvasSource, 'smartDirectRunOwnerIsCurrent'),
    functionSource(smartCanvasSource, 'runSmartImageTextGeneration'),
  ].join('\n');
  const runSmartImageTextGeneration = exportedFunction(source, 'runSmartImageTextGeneration', {
    nodes,
    smartTextEditSubject: () => ({ node: sourceNode, index: 0, item: sourceNode.images[0] }),
    smartTextImageRunSettings: () => ({ engine: 'api', count: 1 }),
    smartRefWithMarkers: (url, meta) => ({ ...(meta || {}), url }),
    imageForDisplay: value => value.url,
    uniqueReferenceImages: refs => refs,
    smartRunSnapshot: () => ({ nodeId: sourceNode.id, nodeType: sourceNode.type, kind: 'image' }),
    cloneSmartSettings: value => ({ ...(value || {}) }),
    sizeForRun: () => '1024x1024',
    nowMs: () => 1200,
    pushUndo() {},
    createPendingOutputFromSource: () => outputNode,
    settingsForStorage: value => value,
    render: () => { counters.render += 1; },
    generateUrlsForCurrentSettings: () => {
      generationStarted = true;
      return generation.promise;
    },
    stripImageGenerationMeta: value => value,
    copyMediaSizeFields: (_item, value) => value,
    replaceOutputsToNodeWithHistory: () => { counters.replace += 1; },
    addSmartGenerationLog: () => { counters.log += 1; },
    toast: () => { counters.toast += 1; },
    scheduleSave: () => { counters.save += 1; },
    trackSmartDeletedNodeIds: () => { counters.track += 1; },
    canvas: { connections: [] },
    selectedId: sourceNode.id,
  });
  return {
    counters,
    generation,
    generationStarted: () => generationStarted,
    nodes,
    outputNode,
    run: runSmartImageTextGeneration(sourceNode.id, 0, 'replace text'),
    snapshot: () => ({ counters: { ...counters }, outputNode: JSON.stringify(outputNode) }),
  };
}

for (const settlement of ['resolve', 'reject']) {
  const fixture = smartTextGenerationOwnershipFixture();
  for (let index = 0; index < 10 && !fixture.generationStarted(); index += 1) await flushMicrotasks();
  assert.equal(fixture.generationStarted(), true, `smart text ${settlement} fixture must reach deferred generation`);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  if (settlement === 'resolve') fixture.generation.resolve({ urls: ['/late-text.png'], kind: 'image' });
  else fixture.generation.reject(new Error('late smart text failure'));
  await fixture.run;
  assert.deepEqual(fixture.snapshot(), baseline, `smart text late ${settlement} must have no mutation, log, save, render, toast, or cleanup after deletion`);
}

function smartCascadeStepOwnershipFixture() {
  const generation = deferred();
  const sourceNode = { id: 'smart-cascade-source', type: 'smart-prompt', text: 'cascade prompt' };
  const outputNode = { id: 'smart-cascade-output', type: 'smart-image', images: [], running: false };
  const nodes = [sourceNode, outputNode];
  const counters = { append: 0, jimeng: 0, log: 0, render: 0, replace: 0 };
  let generationStarted = false;
  const runCascadeStepIntoNode = exportedFunction([
    functionSource(smartCanvasSource, 'smartRunOwnersAreCurrent'),
    functionSource(smartCanvasSource, 'runCascadeStepIntoNode'),
  ].join('\n'), 'runCascadeStepIntoNode', {
    nodes,
    smartLoopContext: null,
    settings: { engine: 'api', apiKind: 'image' },
    cloneSmartSettings: value => ({ ...(value || {}) }),
    smartLoopRoundSettings: value => value,
    smartSettingsForNode: () => ({ engine: 'api', apiKind: 'image' }),
    validOutpaintSize: () => null,
    selfReferenceImagesForNode: () => [],
    defaultReferenceImagesFor: () => [],
    buildPromptRequestForNode: () => ({ prompt: 'cascade prompt', displayPrompt: 'cascade prompt', refs: [] }),
    smartRunNeedsPrompt: () => true,
    isApiLikeEngine: () => true,
    smartRunSnapshot: () => ({ nodeId: sourceNode.id, nodeType: sourceNode.type, kind: 'image' }),
    nowMs: () => 1200,
    rememberRecentSmartSettings() {},
    render: () => { counters.render += 1; },
    generateUrlsForCurrentSettings: () => {
      generationStarted = true;
      return generation.promise;
    },
    tr: key => key,
    addSmartGenerationLog: () => { counters.log += 1; },
    stripImageGenerationMeta: value => value,
    copyMediaSizeFields: (_item, value) => value,
    appendLoopOutputsToNode: () => { counters.append += 1; },
    replaceOutputsToNodeWithHistory: () => { counters.replace += 1; },
    handleJimengPendingSignal: () => { counters.jimeng += 1; return false; },
    rememberRoundOutputs: () => [],
  });
  return {
    counters,
    generation,
    generationStarted: () => generationStarted,
    nodes,
    outputNode,
    run: runCascadeStepIntoNode(sourceNode, outputNode, []),
    snapshot: () => ({ counters: { ...counters }, outputNode: JSON.stringify(outputNode) }),
  };
}

for (const settlement of ['resolve', 'reject']) {
  const fixture = smartCascadeStepOwnershipFixture();
  for (let index = 0; index < 10 && !fixture.generationStarted(); index += 1) await flushMicrotasks();
  assert.equal(fixture.generationStarted(), true, `smart cascade ${settlement} fixture must reach deferred generation`);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  if (settlement === 'resolve') fixture.generation.resolve({ urls: ['/late-cascade.png'], kind: 'image' });
  else fixture.generation.reject(new Error('late smart cascade failure'));
  await fixture.run;
  assert.deepEqual(fixture.snapshot(), baseline, `smart cascade late ${settlement} must have no mutation, log, render, or Jimeng handling after deletion`);
}

{
  const generation = deferred();
  const loopNode = { id: 'smart-loop-stale', type: 'smart-loop' };
  const rootNode = { id: 'smart-loop-root', type: 'smart-image' };
  const outputSlot = { id: 'smart-loop-output', type: 'smart-image', images: [], running: false };
  const nodes = [loopNode, rootNode, outputSlot];
  const counters = { jimeng: 0, render: 0 };
  let generationStarted = false;
  const runLoopRoundIntoSlot = exportedFunction([
    functionSource(smartCanvasSource, 'smartRunOwnersAreCurrent'),
    functionSource(smartCanvasSource, 'runLoopRoundIntoSlot'),
  ].join('\n'), 'runLoopRoundIntoSlot', {
    nodes,
    settings: { engine: 'comfy', apiKind: 'image' },
    cloneSmartSettings: value => ({ ...(value || {}) }),
    smartLoopRoundSettings: value => value,
    smartSettingsForNode: () => ({ engine: 'comfy', apiKind: 'image' }),
    outputImagesForNode: () => [],
    buildPromptRequestForNode: () => ({ prompt: 'loop prompt', displayPrompt: 'loop prompt', refs: [] }),
    smartRunNeedsPrompt: () => true,
    isApiLikeEngine: () => false,
    smartRunSnapshot: () => ({ nodeId: rootNode.id, nodeType: rootNode.type, kind: 'image' }),
    nowMs: () => 1200,
    smartCascadePathForCtx: () => null,
    render: () => { counters.render += 1; },
    generateUrlsForCurrentSettings: () => {
      generationStarted = true;
      return generation.promise;
    },
    handleJimengPendingSignal: () => { counters.jimeng += 1; return false; },
  });
  const run = runLoopRoundIntoSlot(loopNode, rootNode, outputSlot, 0, {});
  for (let index = 0; index < 10 && !generationStarted; index += 1) await flushMicrotasks();
  assert.equal(generationStarted, true, 'smart loop fixture must reach deferred generation');
  nodes.length = 0;
  const baseline = { counters: { ...counters }, outputSlot: JSON.stringify(outputSlot) };
  generation.reject(new Error('late smart loop failure'));
  await run;
  assert.deepEqual(
    { counters, outputSlot: JSON.stringify(outputSlot) },
    baseline,
    'smart loop late rejection must settle inertly without mutation, render, Jimeng handling, or error propagation after deletion',
  );
}

for (const settlement of ['resolve', 'reject']) {
  const response = deferred();
  const node = { id: `smart-prompt-llm-${settlement}`, type: 'smart-prompt', text: 'prompt', running: false };
  const nodes = [node];
  const counters = { render: 0, save: 0, toast: 0 };
  const runPromptLLMNode = exportedFunction([
    functionSource(smartCanvasSource, 'smartRunOwnersAreCurrent'),
    functionSource(smartCanvasSource, 'runPromptLLMNode'),
  ].join('\n'), 'runPromptLLMNode', {
    nodes,
    promptNodeLLMInputText: () => 'prompt',
    toast: () => { counters.toast += 1; },
    tr: key => key,
    render: () => { counters.render += 1; },
    resolveChatProviderId: value => value || 'provider',
    resolveChatModel: value => value || 'model',
    promptNodeInputMediaForLLM: () => [],
    imageRefsOnly: () => [],
    videoRefsOnly: () => [],
    fetch: () => response.promise,
    scheduleSave: () => { counters.save += 1; },
  });
  const run = runPromptLLMNode(node.id);
  await flushMicrotasks();
  nodes.length = 0;
  const baseline = { counters: { ...counters }, node: JSON.stringify(node) };
  if (settlement === 'resolve') response.resolve({ ok: true, json: async () => ({ text: 'late smart LLM text' }) });
  else response.reject(new Error('late smart prompt LLM failure'));
  await run.catch(() => {});
  assert.deepEqual({ counters, node: JSON.stringify(node) }, baseline, `smart prompt LLM late ${settlement} must ignore deleted owner settlement`);
}

function smartComfyLateSuccessFixture(functionName, result) {
  const generation = deferred();
  const node = { id: `${functionName}-owner`, type: 'smart-image', images: [], pending: 1, running: true };
  const nodes = [node];
  const counters = { clear: 0, connect: 0, create: 0, finalize: 0, queue: 0, save: 0 };
  let generationStarted = false;
  const globals = {
    nodes,
    settings: { comfyMode: 'text', width: 1024, height: 1024, enhanceStrength: 0.5 },
    smartClientId: 'smart-comfy-client',
    runQueuedSmartComfyGenerate: () => {
      counters.queue += 1;
      generationStarted = true;
      return generation.promise;
    },
    comfyNameForRef: async () => 'uploaded-ref.png',
    tr: key => key,
    finalizePendingNode: () => { counters.finalize += 1; },
    createNode: () => {
      counters.create += 1;
      return { id: 'created-after-delete' };
    },
    nodeRect: () => ({ width: 240 }),
    attachRunMeta() {},
    addConnection: () => { counters.connect += 1; },
    clearPromptInput: () => { counters.clear += 1; },
    scheduleSave: () => { counters.save += 1; },
  };
  const helper = exportedFunction([
    functionSource(smartCanvasSource, 'smartComfyRunOwnerIsCurrent'),
    functionSource(smartCanvasSource, functionName),
  ].join('\n'), functionName, globals);
  const run = functionName === 'runComfyText'
    ? helper(node, 'late comfy text', node, { sourceNodeId: node.id })
    : functionName === 'runComfyEnhance'
      ? helper(node, [{ url: '/ref.png' }], node, { sourceNodeId: node.id })
      : helper(node, 'late comfy edit', [{ url: '/ref.png' }], node, { sourceNodeId: node.id });
  return {
    counters,
    generation,
    generationStarted: () => generationStarted,
    node,
    nodes,
    result,
    run,
    snapshot: () => ({ counters: { ...counters }, node: JSON.stringify(node) }),
  };
}

for (const functionName of ['runComfyText', 'runComfyEnhance', 'runComfyEdit']) {
  const fixture = smartComfyLateSuccessFixture(functionName, { outputs: [`/${functionName}-late.png`] });
  for (let index = 0; index < 10 && !fixture.generationStarted(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(fixture.generationStarted(), true, `${functionName} deletion probe must reach deferred Comfy generation`);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  fixture.generation.resolve(fixture.result);
  await fixture.run;
  assert.deepEqual(fixture.snapshot(), baseline, `${functionName} must not finalize, create, connect, clear, or save after late success deletion`);
}

function smartCustomComfyLateSuccessFixture(result) {
  const generation = deferred();
  const node = { id: 'runComfyGeneration-custom-owner', type: 'smart-image', images: [], pending: 1, running: true };
  const nodes = [node];
  const counters = { clear: 0, connect: 0, create: 0, finalize: 0, queue: 0, save: 0 };
  let generationStarted = false;
  const runComfyGeneration = exportedFunction([
    functionSource(smartCanvasSource, 'smartComfyRunOwnerIsCurrent'),
    functionSource(smartCanvasSource, 'runComfyGeneration'),
  ].join('\n'), 'runComfyGeneration', {
    nodes,
    settings: { comfyMode: 'custom', comfyWorkflow: 'mixed-media-workflow', comfyParams: {} },
    comfyWorkflows: [],
    smartClientId: 'smart-comfy-client',
    imageRefsOnly: refs => refs.filter(ref => ref.kind === 'image'),
    videoRefsOnly: refs => refs.filter(ref => ref.kind === 'video'),
    audioRefsOnly: refs => refs.filter(ref => ref.kind === 'audio'),
    fetch: async () => ({ ok: true, json: async () => ({ config: { fields: [] } }), text: async () => '' }),
    comfyFieldKind: field => field.kind,
    smartComfyRandomActive: () => false,
    smartComfyRandomValue: () => 0,
    comfyParamsFromWorkflowValues: () => ({}),
    runQueuedSmartComfyGenerate: () => {
      counters.queue += 1;
      generationStarted = true;
      return generation.promise;
    },
    resultMediaUrls: data => data.images || data.videos || data.audios || data.texts || [],
    mediaKindForUrls: (_urls, fallback) => fallback,
    tr: key => key,
    finalizePendingNode: () => { counters.finalize += 1; },
    createNode: () => {
      counters.create += 1;
      return { id: 'created-after-delete' };
    },
    nodeRect: () => ({ width: 240 }),
    attachRunMeta() {},
    addConnection: () => { counters.connect += 1; },
    clearPromptInput: () => { counters.clear += 1; },
    scheduleSave: () => { counters.save += 1; },
    comfyNameForRef: async () => 'unused.png',
  });
  const run = runComfyGeneration(node, 'late custom comfy', [], node, { sourceNodeId: node.id });
  return {
    counters,
    generation,
    generationStarted: () => generationStarted,
    node,
    nodes,
    result,
    run,
    snapshot: () => ({ counters: { ...counters }, node: JSON.stringify(node) }),
  };
}

for (const result of [
  { images: ['/late-custom-image.png'] },
  { videos: ['/late-custom-video.mp4'] },
  { audios: ['/late-custom-audio.mp3'] },
]) {
  const fixture = smartCustomComfyLateSuccessFixture(result);
  for (let index = 0; index < 10 && !fixture.generationStarted(); index += 1) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
  assert.equal(fixture.generationStarted(), true, 'custom Comfy deletion probe must reach deferred generation');
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  fixture.generation.resolve(fixture.result);
  await fixture.run;
  assert.deepEqual(fixture.snapshot(), baseline, 'custom Comfy image/video/audio success must have no side effects after exact owner deletion');
}

{
  const deletedNode = { id: 'deleted-live-smart-node' };
  const liveSmartNode = exportedFunction(functionSource(smartCanvasSource, 'liveSmartNode'), 'liveSmartNode', { nodes: [] });
  assert.equal(liveSmartNode(deletedNode), null, 'liveSmartNode must not fall back to a deleted object when no exact current node exists');
}

function smartJimengManualQueryFixture() {
  const response = deferred();
  const node = {
    id: 'smart-jimeng-query-owner',
    jimengPending: { submitId: 'smart-jimeng-submit', kind: 'image', querying: false },
  };
  const nodes = [node];
  const counters = { apply: 0, render: 0, save: 0, toast: 0 };
  const queryJimengNow = exportedFunction(functionSource(smartCanvasSource, 'queryJimengNow'), 'queryJimengNow', {
    nodes,
    fetchJimengQuery: () => response.promise,
    currentSmartJimengQueryOwner: (nodeId, owner, submitId) => {
      const current = nodes.find(item => item.id === nodeId);
      return current === owner && current?.jimengPending?.submitId === submitId ? current : null;
    },
    applyJimengQueryResult: (owner, data) => {
      counters.apply += 1;
      owner.lastResult = data.status;
    },
    toast: () => { counters.toast += 1; },
    render: () => { counters.render += 1; },
  });
  return {
    counters,
    node,
    nodes,
    queryJimengNow,
    response,
    snapshot: () => ({ counters: { ...counters }, node: JSON.stringify(node) }),
  };
}

for (const settlement of ['succeeded', 'pending', 'failed', 'rejected']) {
  const fixture = smartJimengManualQueryFixture();
  const query = fixture.queryJimengNow(fixture.node.id);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  if (settlement === 'rejected') fixture.response.reject(new Error('late Jimeng query rejection'));
  else fixture.response.resolve({ status: settlement, urls: ['/late.png'], error: 'late failure' });
  await query;
  assert.deepEqual(fixture.snapshot(), baseline, `deleted Jimeng query owner must ignore late ${settlement} settlement`);
  assert.equal(fixture.nodes.length, 0, `late Jimeng ${settlement} must not resurrect its owner`);
}

{
  const response = deferred();
  const node = {
    id: 'smart-background-jimeng-owner',
    jimengPending: { submitId: 'smart-background-jimeng-task', kind: 'image', querying: false },
  };
  const nodes = [node];
  const activeJimengPolls = new Set();
  const timers = [];
  let applyCalls = 0;
  let fetchStarted = false;
  const startJimengPoll = exportedFunction(functionSource(smartCanvasSource, 'startJimengPoll'), 'startJimengPoll', {
    nodes,
    activeJimengPolls,
    JIMENG_POLL_MAX: 1,
    JIMENG_POLL_INTERVAL: 1,
    setTimeout: resolve => { timers.push(resolve); return timers.length; },
    fetchJimengQuery: () => {
      fetchStarted = true;
      return response.promise;
    },
    currentSmartJimengQueryOwner: (nodeId, owner, submitId) => {
      const current = nodes.find(item => item.id === nodeId);
      return current === owner && current?.jimengPending?.submitId === submitId ? current : null;
    },
    applyJimengQueryResult: () => { applyCalls += 1; return true; },
  });

  startJimengPoll(node);
  assert.equal(activeJimengPolls.has(node.jimengPending.submitId), true, 'background Jimeng poll must claim active ownership');
  assert.equal(timers.length, 1, 'background Jimeng poll must wait for its polling interval');
  timers.shift()();
  for (let index = 0; index < 10 && !fetchStarted; index += 1) await flushMicrotasks();
  assert.equal(fetchStarted, true, 'background Jimeng fixture must reach deferred query');
  nodes.length = 0;
  response.resolve({ status: 'succeeded', urls: ['/late-background.png'] });
  await flushMicrotasks();
  await flushMicrotasks();
  assert.equal(applyCalls, 0, 'background Jimeng poll must reject late success after exact owner deletion');
  assert.equal(activeJimengPolls.size, 0, 'background Jimeng poll must release active ownership after stale settlement');
}

{
  const response = deferred();
  const node = {
    id: 'smart-background-jimeng-replaced',
    jimengPending: { submitId: 'smart-background-jimeng-replaced-task', kind: 'image', querying: false },
  };
  const replacement = {
    id: node.id,
    jimengPending: { ...node.jimengPending },
  };
  const nodes = [node];
  const activeJimengPolls = new Set();
  const timers = [];
  let applyCalls = 0;
  let fetchStarted = false;
  const startJimengPoll = exportedFunction(functionSource(smartCanvasSource, 'startJimengPoll'), 'startJimengPoll', {
    nodes,
    activeJimengPolls,
    JIMENG_POLL_MAX: 1,
    JIMENG_POLL_INTERVAL: 1,
    setTimeout: resolve => { timers.push(resolve); return timers.length; },
    fetchJimengQuery: () => {
      fetchStarted = true;
      return response.promise;
    },
    currentSmartJimengQueryOwner: (nodeId, owner, submitId) => {
      const current = nodes.find(item => item.id === nodeId);
      return current === owner && current?.jimengPending?.submitId === submitId ? current : null;
    },
    applyJimengQueryResult: () => { applyCalls += 1; return true; },
  });

  startJimengPoll(node);
  nodes.splice(0, 1, replacement);
  timers.shift()();
  for (let index = 0; index < 10 && !fetchStarted; index += 1) await flushMicrotasks();
  assert.equal(fetchStarted, false, 'background Jimeng poll must not query for a same-ID replacement owner after its timer await');
  await flushMicrotasks();
  assert.equal(applyCalls, 0, 'background Jimeng poll must reject late success after exact owner replacement');
  assert.deepEqual(replacement.jimengPending, node.jimengPending, 'stale background poll must not mutate same-ID replacement ownership');
  assert.equal(activeJimengPolls.size, 0, 'replaced background Jimeng poll must release active ownership after stale settlement');
}

function smartOrdinaryManualQueryFixture() {
  const response = deferred();
  const task = {
    taskId: 'smart-local-recovery-task',
    recoverTaskId: 'smart-upstream-recovery-task',
    failed: true,
    querying: false,
    kind: 'image',
  };
  const node = { id: 'smart-recovery-query-owner', pendingTasks: [task], pending: 1, running: false, images: [] };
  const nodes = [node];
  const counters = { finalize: 0, render: 0, save: 0, terminal: 0, toast: 0, log: 0, fetch: 0 };
  const querySmartImageTaskNow = exportedFunction(functionSource(smartCanvasSource, 'querySmartImageTaskNow'), 'querySmartImageTaskNow', {
    nodes,
    smartPendingTasks: owner => (Array.isArray(owner?.pendingTasks) ? owner.pendingTasks : []),
    smartRecoverableImageTask: owner => owner?.pendingTasks?.find(item => item.failed && item.recoverTaskId) || null,
    extractUpstreamTaskId: () => '',
    toast: () => { counters.toast += 1; },
    render: () => { counters.render += 1; },
    fetchImageTaskQuery: () => {
      counters.fetch = (counters.fetch || 0) + 1;
      return response.promise;
    },
    providerIdForSmartTask: () => 'provider-a',
    currentSmartImageQueryOwner: (nodeId, owner, localTaskId, ownerTask) => {
      const current = nodes.find(item => item.id === nodeId);
      const currentTask = current?.pendingTasks?.find(item => item.taskId === localTaskId);
      return current === owner && currentTask === ownerTask ? { node: current, task: currentTask } : null;
    },
    finalizeSmartPendingTask: () => { counters.finalize += 1; },
    resultMediaUrls: value => value,
    terminalizeSmartRecoveryTask: (owner, ownerTask, message) => {
      counters.terminal += 1;
      ownerTask.failed = true;
      ownerTask.querying = false;
      ownerTask.recoverTaskId = '';
      ownerTask.error = message;
      owner.pendingTasks = owner.pendingTasks.filter(item => item !== ownerTask);
      owner.pending = 0;
      return true;
    },
    addSmartGenerationLog: () => { counters.log += 1; },
    nowMs: () => 1000,
    tr: key => key,
    scheduleSave: () => { counters.save += 1; },
  });
  return {
    counters,
    node,
    nodes,
    querySmartImageTaskNow,
    response,
    snapshot: () => ({ counters: { ...counters }, node: JSON.stringify(node), task: JSON.stringify(task) }),
    task,
  };
}

for (const settlement of ['succeeded', 'pending', 'failed', 'rejected']) {
  const fixture = smartOrdinaryManualQueryFixture();
  const query = fixture.querySmartImageTaskNow(fixture.node.id, fixture.task.taskId);
  fixture.nodes.length = 0;
  const baseline = fixture.snapshot();
  if (settlement === 'rejected') fixture.response.reject(new Error('late ordinary recovery rejection'));
  else fixture.response.resolve({ status: settlement, images: ['/late.png'], error: 'late failure', message: 'still pending' });
  await query;
  assert.deepEqual(fixture.snapshot(), baseline, `deleted ordinary recovery owner must ignore late ${settlement} settlement`);
  assert.equal(fixture.nodes.length, 0, `late ordinary recovery ${settlement} must not resurrect its owner`);
}

{
  const fixture = smartOrdinaryManualQueryFixture();
  fixture.response.resolve({ status: 'failed', error: 'terminal smart recovery failure' });
  await fixture.querySmartImageTaskNow(fixture.node.id, fixture.task.taskId);
  assert.equal(fixture.counters.terminal, 1, 'terminal smart recovery must be finalized exactly once');
  assert.equal(fixture.counters.log, 1, 'terminal smart recovery must add one terminal generation log');
  assert.equal(fixture.counters.toast, 1, 'terminal smart recovery must report its failure once');
  assert.equal(fixture.task.recoverTaskId, '', 'terminal smart recovery must clear its upstream task ID');
  assert.equal(fixture.task.querying, false, 'terminal smart recovery must clear query ownership');
  assert.equal(fixture.node.pendingTasks.length, 0, 'terminal smart recovery must remove its pending task');
  assert.equal(fixture.node.pending, 0, 'terminal smart recovery must release pending ownership');
  const fetchCalls = fixture.counters.fetch || 0;
  await fixture.querySmartImageTaskNow(fixture.node.id, fixture.task.taskId);
  assert.equal(fixture.counters.fetch || 0, fetchCalls, 'terminal smart recovery must not be queryable again');
}

{
  const fixture = smartOrdinaryManualQueryFixture();
  fixture.response.resolve({ status: 'succeeded', images: [] });
  await fixture.querySmartImageTaskNow(fixture.node.id, fixture.task.taskId);
  assert.equal(fixture.counters.finalize, 0, 'empty smart recovery success must not finalize as successful output');
  assert.equal(fixture.counters.terminal, 1, 'empty smart recovery success must terminalize exactly once');
  assert.equal(fixture.counters.log, 1, 'empty smart recovery success must log terminal failure once');
  assert.equal(fixture.task.recoverTaskId, '', 'empty smart recovery success must clear recovery identity');
  assert.equal(fixture.node.pendingTasks.length, 0, 'empty smart recovery success must remove pending ownership');
  const fetchCalls = fixture.counters.fetch || 0;
  await fixture.querySmartImageTaskNow(fixture.node.id, fixture.task.taskId);
  assert.equal(fixture.counters.fetch || 0, fetchCalls, 'empty smart recovery success must not be queryable again');
}

{
  const response = Promise.resolve({ status: 'failed', error: 'production terminal recovery failure' });
  const task = { taskId: 'production-terminal-task', recoverTaskId: 'production-upstream-task', failed: true, querying: false, kind: 'image' };
  const node = { id: 'production-terminal-owner', type: 'smart-image', pendingTasks: [task], pending: 1, running: false, images: [] };
  const nodes = [node];
  let logCalls = 0;
  const source = [
    functionSource(smartCanvasSource, 'smartPendingTasks'),
    functionSource(smartCanvasSource, 'currentSmartImageQueryOwner'),
    functionSource(smartCanvasSource, 'terminalizeSmartRecoveryTask'),
    functionSource(smartCanvasSource, 'querySmartImageTaskNow'),
  ].join('\n');
  const querySmartImageTaskNow = exportedFunction(source, 'querySmartImageTaskNow', {
    nodes,
    smartRecoverableImageTask: owner => owner?.pendingTasks?.find(item => item.failed && item.recoverTaskId) || null,
    extractUpstreamTaskId: () => '',
    fetchImageTaskQuery: () => response,
    providerIdForSmartTask: () => 'provider-a',
    resultMediaUrls: value => value,
    addSmartGenerationLog: () => { logCalls += 1; },
    nowMs: () => 1200,
    toast() {},
    render() {},
    tr: key => key,
    scheduleSave() {},
  });

  await querySmartImageTaskNow(node.id, task.taskId);
  assert.equal('pendingTasks' in node, false, 'the production smart terminalizer must remove the failed recovery task');
  assert.equal(task.recoverTaskId, '', 'the production smart terminalizer must clear the recovery ID');
  assert.equal(task.querying, false, 'the production smart terminalizer must clear query ownership');
  assert.equal(node.pending, 0, 'the production smart terminalizer must clear pending count');
  assert.equal(node.running, false, 'the production smart terminalizer must stop the node');
  assert.equal(node.runStatus, 'failed', 'the production smart terminalizer must mark the node failed');
  assert.equal(logCalls, 1, 'the production smart terminalizer path must log the terminal failure once');
}

const smartResumeSource = [
  functionSource(smartCanvasSource, 'smartNodeOwnsPendingTask'),
  functionSource(smartCanvasSource, 'resumeSmartPendingNode'),
].join('\n');

function smartStaleOwnerFixture() {
  const settlement = deferred();
  const generationLogs = [];
  const node = {
    id: 'smart-stale-owner',
    pendingTasks: [{ taskId: 'smart-stale-task', kind: 'image' }],
    pending: 1,
    running: true,
    images: [],
  };
  const nodes = [node];
  let finalizeCalls = 0;
  let renderCalls = 0;
  let saveCalls = 0;
  const resumeSmartPendingNode = exportedFunction(smartResumeSource, 'resumeSmartPendingNode', {
    nodes,
    smartPendingTasks: target => (Array.isArray(target?.pendingTasks) ? target.pendingTasks : []),
    nowMs: () => 1200,
    addSmartGenerationLog: entry => generationLogs.push(entry),
    render: () => { renderCalls += 1; },
    pollSmartCanvasTask: () => settlement.promise,
    resultMediaUrls: value => value,
    finalizeSmartPendingTask: (target, taskId, images) => {
      finalizeCalls += 1;
      target.images = images;
      target.pendingTasks = target.pendingTasks.filter(task => task.taskId !== taskId);
    },
    setNodeJimengPending() {},
    providerIdForSmartTask: () => '',
    tr: key => key,
    toast() {},
    scheduleSave: () => { saveCalls += 1; },
  });
  return {
    baseline: () => ({ renderCalls, saveCalls }),
    finalizeCalls: () => finalizeCalls,
    generationLogs,
    node,
    nodes,
    resumeSmartPendingNode,
    settlement,
  };
}

{
  const fixture = smartStaleOwnerFixture();
  const resume = fixture.resumeSmartPendingNode(fixture.node, { run: { node: { id: 'smart-generator' } }, runLogStart: 1000 });
  fixture.nodes.length = 0;
  const baseline = fixture.baseline();
  fixture.settlement.resolve({ images: ['/must-not-resurrect-smart.png'] });
  await resume;
  assert.equal(fixture.finalizeCalls(), 0, 'a deleted smart node must not finalize a late successful task');
  assert.deepEqual(fixture.node.images, [], 'a deleted smart node must not receive late output');
  assert.equal(fixture.generationLogs.length, 0, 'a deleted smart node must not add a late success log');
  assert.deepEqual(fixture.baseline(), baseline, 'a deleted smart node must not render or save after late success');
  assert.equal(fixture.nodes.length, 0, 'late smart success must not resurrect the deleted node');
}

{
  const fixture = smartStaleOwnerFixture();
  const resume = fixture.resumeSmartPendingNode(fixture.node, { run: { node: { id: 'smart-generator' } }, runLogStart: 1000 });
  fixture.nodes.length = 0;
  const baseline = fixture.baseline();
  fixture.settlement.reject(new Error('late smart failure'));
  await resume;
  assert.equal(fixture.finalizeCalls(), 0, 'a deleted smart node must not finalize a late rejected task');
  assert.equal(fixture.generationLogs.length, 0, 'a deleted smart node must not add a late failure log');
  assert.deepEqual(fixture.baseline(), baseline, 'a deleted smart node must not render or save after late rejection');
  assert.equal(fixture.nodes.length, 0, 'late smart rejection must not resurrect the deleted node');
}

{
  const terminalError = new Error('smart terminal failure');
  const generationLogs = [];
  const node = {
    pendingTasks: [{ taskId: 'smart-terminal', kind: 'image', failed: true }],
    pending: 1,
    running: true,
    images: [],
  };
  const resumeSmartPendingNode = exportedFunction(smartResumeSource, 'resumeSmartPendingNode', {
    nodes: [node],
    smartPendingTasks: target => (Array.isArray(target?.pendingTasks) ? target.pendingTasks : []),
    nowMs: () => 1200,
    addSmartGenerationLog: entry => generationLogs.push(entry),
    render() {},
    pollSmartCanvasTask: async () => {
      throw terminalError;
    },
    resultMediaUrls: value => value,
    finalizeSmartPendingTask() {},
    setNodeJimengPending() {},
    providerIdForSmartTask: () => '',
    tr: key => key,
    toast() {},
    scheduleSave() {},
  });

  await assert.rejects(
    resumeSmartPendingNode(node, { run: { node: { id: 'smart-generator' } }, runLogStart: 1000 }),
    error => error === terminalError,
    'resumeSmartPendingNode must surface a failed terminal task when the node has no outputs',
  );
  assert.equal('pendingTasks' in node, false, 'failed terminal smart tasks without recovery IDs must be removed');
  assert.equal(node.pending, 0, 'failed terminal smart tasks must release pending ownership');
  assert.equal(node.running, false, 'a terminal smart node must clear its running flag');
  assert.equal(generationLogs.length, 1, 'failed terminal smart tasks must add a generation log entry');
  assert.equal(generationLogs[0].error, terminalError.message, 'the smart generation log must retain the terminal error');
}

const terminalBranchStart = requiredIndex(
  smartResumeSource,
  'if(!node.pending && smartPendingTasks(node).length === 0){',
  'resumeSmartPendingNode must define a zero-pending terminal branch',
);
const terminalBranchEnd = requiredIndex(
  smartResumeSource,
  'failures.push(e);',
  'resumeSmartPendingNode must collect terminal failures after clearing task ownership',
  terminalBranchStart,
);
assert.ok(
  smartResumeSource.slice(terminalBranchStart, terminalBranchEnd).includes('node.running = false;'),
  'resumeSmartPendingNode must clear running inside its zero-pending terminal branch',
);

const recognitionLifecycleSource = [
  functionSource(smartCanvasSource, 'cancelSmartTextRecognition'),
  functionSource(smartCanvasSource, 'reloadSmartTextRecognition'),
].join('\n');

function recognitionLifecycleFixture() {
  const requests = [];
  const controllers = [];
  const state = {
    nodeId: 'smart-text-node',
    imageIndex: 0,
    textProvider: 'provider-a',
    textModel: 'model-a',
    texts: [{ text: 'original', next: 'original', index: 0 }],
    status: 'idle',
    error: '',
    recognitionRequestId: 0,
  };
  let renderCalls = 0;
  let saveCalls = 0;
  class FakeAbortController {
    constructor() {
      this.aborted = false;
      this.signal = { controller: this };
      controllers.push(this);
    }

    abort() {
      this.aborted = true;
    }
  }
  const evaluated = evaluatedFunctions(
    recognitionLifecycleSource,
    ['cancelSmartTextRecognition', 'reloadSmartTextRecognition'],
    {
      smartTextEditPanelState: state,
      resolveChatProviderId: value => value,
      resolveChatModel: value => value,
      AbortController: FakeAbortController,
      recognizeSmartImageText: (...args) => {
        const result = deferred();
        requests.push({ args, result });
        return result.promise;
      },
      saveSmartTextPanelStateToNode: () => { saveCalls += 1; },
      renderSmartTextModifyPanel: () => { renderCalls += 1; },
    },
  );
  return {
    ...evaluated.exports,
    baseline: () => ({ renderCalls, saveCalls }),
    context: evaluated.context,
    controllers,
    requests,
    state,
  };
}

{
  const fixture = recognitionLifecycleFixture();
  const reload = fixture.reloadSmartTextRecognition();
  assert.equal(fixture.requests.length, 1, 'OCR reload must create one deferred recognition request');
  assert.equal(fixture.state.status, 'loading', 'OCR reload must enter loading state while the response is pending');
  fixture.cancelSmartTextRecognition();
  assert.equal(fixture.state.recognitionRequestId, 2, 'OCR cancellation must invalidate the in-flight request ID');
  assert.equal(fixture.controllers[0].aborted, true, 'OCR cancellation must abort the in-flight controller');
  const baseline = fixture.baseline();
  fixture.requests[0].result.resolve([{ text: 'late', next: 'late', index: 0 }]);
  await reload;
  assert.equal(fixture.state.status, 'idle', 'a canceled OCR response must not replace the idle state');
  assert.equal(fixture.state.texts[0].text, 'original', 'a canceled OCR response must not replace recognized text');
  assert.deepEqual(fixture.baseline(), baseline, 'a canceled late OCR response must not save or render current state');
}

{
  const fixture = recognitionLifecycleFixture();
  const firstReload = fixture.reloadSmartTextRecognition();
  const secondReload = fixture.reloadSmartTextRecognition();
  assert.equal(fixture.requests.length, 2, 'superseding OCR must create a distinct current request');
  assert.equal(fixture.controllers[0].aborted, true, 'superseding OCR must abort the previous controller');
  assert.equal(fixture.state.recognitionRequestId, 2, 'superseding OCR must advance the current request ID');
  const currentController = fixture.controllers[1];
  const baseline = fixture.baseline();
  fixture.requests[0].result.reject(new Error('late superseded failure'));
  await firstReload;
  assert.equal(fixture.state.status, 'loading', 'a superseded OCR rejection must not replace the newer loading state');
  assert.strictEqual(fixture.state.recognitionAbortController, currentController, 'a superseded OCR rejection must not clear the current controller');
  assert.equal(fixture.state.error, '', 'a superseded OCR rejection must not publish a stale error');
  assert.deepEqual(fixture.baseline(), baseline, 'a superseded OCR rejection must not save or render current state');

  fixture.requests[1].result.resolve([{ text: 'current', next: 'current', index: 0 }]);
  await secondReload;
  assert.equal(fixture.state.status, 'ready', 'the current OCR response must still complete normally');
  assert.equal(fixture.state.texts[0].text, 'current', 'the current OCR response must own recognized text');
  assert.equal(fixture.state.recognitionAbortController, null, 'the current OCR response must clear its controller');
}

console.log('Task lifecycle ownership tests passed');
