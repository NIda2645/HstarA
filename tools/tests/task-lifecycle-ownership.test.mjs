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
  const sources = `${ordinaryPollSource}\n${functionSource(canvasSource, 'completeCanvasImageTask')}`;
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
