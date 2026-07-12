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

function exportedFunction(source, functionName, globals) {
  const context = { ...globals };
  vm.createContext(context);
  vm.runInContext(`${source}\nthis.__exportedFunction = ${functionName};`, context);
  return context.__exportedFunction;
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
  const failures = [];
  const taskData = { status: 'failed', error: 'ordinary API failed' };
  const pollCanvasImageTask = exportedFunction(ordinaryPollSource, 'pollCanvasImageTask', {
    activeCanvasTaskPolls,
    findPendingTask: () => ({ pending: {}, out: {} }),
    ensureCascadeActive() {},
    cascadeFetch: async () => ({ ok: true, json: async () => taskData }),
    completeCanvasImageTask() {},
    failCanvasImageTask: (...args) => failures.push(args),
    sleep: async () => {},
    tr: key => key,
  });

  const status = await pollCanvasImageTask('ordinary-failed');
  assert.equal(status, 'failed', 'ordinary polling must return failed for a failed API task');
  assert.equal(failures.length, 1, 'ordinary polling must delegate failed API tasks to failCanvasImageTask');
  assert.equal(failures[0][0], 'ordinary-failed', 'ordinary failure handling should retain the task ID');
  assert.equal(failures[0][1], taskData.error, 'ordinary failure handling should retain the API error');
  assert.strictEqual(failures[0][2], taskData, 'ordinary failure handling should pass through API task metadata');
  assert.equal(activeCanvasTaskPolls.has('ordinary-failed'), false, 'failed ordinary tasks must release active poll ownership');
}

{
  const activeCanvasTaskPolls = new Set();
  const completions = [];
  const result = { images: [{ url: '/generated.png' }] };
  const pollCanvasImageTask = exportedFunction(ordinaryPollSource, 'pollCanvasImageTask', {
    activeCanvasTaskPolls,
    findPendingTask: () => ({ pending: {}, out: {} }),
    ensureCascadeActive() {},
    cascadeFetch: async () => ({ ok: true, json: async () => ({ status: 'succeeded', result }) }),
    completeCanvasImageTask: (...args) => completions.push(args),
    failCanvasImageTask() {},
    sleep: async () => {},
    tr: key => key,
  });

  const status = await pollCanvasImageTask('ordinary-succeeded');
  assert.equal(status, 'succeeded', 'ordinary polling must return succeeded for a successful API task');
  assert.equal(completions.length, 1, 'ordinary polling must delegate successful API tasks to completeCanvasImageTask');
  assert.equal(completions[0][0], 'ordinary-succeeded', 'ordinary completion should retain the task ID');
  assert.strictEqual(completions[0][1], result, 'ordinary completion should pass through the API result');
  assert.equal(activeCanvasTaskPolls.has('ordinary-succeeded'), false, 'successful ordinary tasks must release active poll ownership');
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

function smartPollFixture(taskData) {
  const activeSmartTaskPolls = new Map();
  let fetchCalls = 0;
  class JimengPendingSignal extends Error {}
  class ImageTaskRecoverSignal extends Error {}
  const pollSmartCanvasTask = exportedFunction(smartPollSource, 'pollSmartCanvasTask', {
    activeSmartTaskPolls,
    setTimeout: resolve => {
      resolve();
      return 0;
    },
    fetch: async () => {
      fetchCalls += 1;
      return {
        ok: true,
        json: async () => taskData,
        text: async () => '',
      };
    },
    tr: key => key,
    extractUpstreamTaskId: () => '',
    JimengPendingSignal,
    ImageTaskRecoverSignal,
  });
  return { activeSmartTaskPolls, fetchCalls: () => fetchCalls, pollSmartCanvasTask };
}

{
  const fixture = smartPollFixture({ status: 'failed', error: 'smart API failed' });
  await assert.rejects(
    fixture.pollSmartCanvasTask('smart-failed'),
    /smart API failed/,
    'smart polling must reject with the failed API task error',
  );
  assert.equal(fixture.fetchCalls(), 1, 'smart failed polling should fetch the API task once');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-failed'), false, 'failed smart tasks must release active poll ownership');
}

{
  const result = { images: ['/smart-generated.png'] };
  const fixture = smartPollFixture({ status: 'succeeded', result });
  const actual = await fixture.pollSmartCanvasTask('smart-succeeded');
  assert.strictEqual(actual, result, 'smart polling must resolve the successful API task result');
  assert.equal(fixture.fetchCalls(), 1, 'smart successful polling should fetch the API task once');
  assert.equal(fixture.activeSmartTaskPolls.has('smart-succeeded'), false, 'successful smart tasks must release active poll ownership');
}

const smartResumeSource = functionSource(smartCanvasSource, 'resumeSmartPendingNode');

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

{
  let abortCalls = 0;
  const state = {
    status: 'loading',
    recognitionRequestId: 4,
    recognitionAbortController: { abort: () => { abortCalls += 1; } },
  };
  const cancelSmartTextRecognition = exportedFunction(
    functionSource(smartCanvasSource, 'cancelSmartTextRecognition'),
    'cancelSmartTextRecognition',
    {
      smartTextEditPanelState: state,
      saveSmartTextPanelStateToNode() {},
      renderSmartTextModifyPanel() {},
    },
  );

  cancelSmartTextRecognition();
  assert.equal(state.recognitionRequestId, 5, 'cancelSmartTextRecognition must invalidate the active OCR request ID');
  assert.equal(abortCalls, 1, 'cancelSmartTextRecognition must abort the active OCR controller');
}

const reloadRecognitionSource = functionSource(smartCanvasSource, 'reloadSmartTextRecognition');
const resolvedAwait = requiredIndex(
  reloadRecognitionSource,
  'const texts = await recognizeSmartImageText',
  'reloadSmartTextRecognition must await the OCR response',
);
const resolvedMutation = requiredIndex(
  reloadRecognitionSource,
  'smartTextEditPanelState.texts = texts;',
  'reloadSmartTextRecognition must store a current OCR response',
  resolvedAwait,
);
assert.ok(
  reloadRecognitionSource.slice(resolvedAwait, resolvedMutation).includes('smartTextEditPanelState.recognitionRequestId !== requestId'),
  'late successful OCR responses must be rejected by a request ID mismatch guard before mutating state',
);

const rejectedResponse = requiredIndex(
  reloadRecognitionSource,
  'catch(err)',
  'reloadSmartTextRecognition must handle rejected OCR responses',
  resolvedMutation,
);
const rejectedMutation = requiredIndex(
  reloadRecognitionSource,
  'smartTextEditPanelState.recognitionAbortController = null;',
  'reloadSmartTextRecognition must clear the current OCR controller after a current rejection',
  rejectedResponse,
);
assert.ok(
  reloadRecognitionSource.slice(rejectedResponse, rejectedMutation).includes('smartTextEditPanelState.recognitionRequestId !== requestId'),
  'late rejected OCR responses must be rejected by a request ID mismatch guard before mutating state',
);

console.log('Task lifecycle ownership tests passed');
