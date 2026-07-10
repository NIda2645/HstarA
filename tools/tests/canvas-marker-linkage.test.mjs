import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/canvas.css', import.meta.url), 'utf8');

assert.match(source, /let promptMarkerMenuState = null;/, 'canvas should keep marker @ menu state');
assert.match(source, /class="prompt-rich-input" contenteditable="true"[\s\S]*promptRichHtmlFromText\(node\.text \|\| '', node\)/, 'prompt nodes should render as rich editable inputs');
assert.match(source, /bindPromptMarkerAutocomplete\(editor, node\)/, 'prompt rich editor should bind marker @ autocomplete');
assert.match(source, /node\.text = promptRichPlainText\(editor\)/, 'prompt rich editor should serialize marker chips back to prompt text');

for (const name of [
  'setCaretAfterNode',
  'promptMarkerQuery',
  'ensurePromptMarkerMenu',
  'closePromptMarkerMenu',
  'refreshOpenPromptMarkerMenu',
  'closePromptMarkerMenuOnOutsidePointer',
  'promptMarkerAnchorRect',
  'renderPromptMarkerMenu',
  'insertPromptMarkerCandidate',
  'bindPromptMarkerAutocomplete',
]) {
  assert.match(source, new RegExp(`function ${name}\\(`), `canvas should define ${name}`);
}

assert.match(source, /function promptMarkerQuery\(editor\)[\s\S]*before\.match\([^;]*@/, 'marker @ query should trigger from @ text before the caret');
assert.match(source, /function renderPromptMarkerMenu\(editor, node, anchorEl=null\)[\s\S]*promptMarkerCandidates\(node\)[\s\S]*prompt-marker-option[\s\S]*prompt-marker-pill/, 'marker @ menu should list prompt marker candidates');
assert.match(source, /function insertPromptMarkerCandidate\(index=0\)[\s\S]*className = 'prompt-inline-marker'[\s\S]*dataset\.promptMarkerChip = '1'[\s\S]*editor\.dispatchEvent\(new Event\('input'/, 'marker @ insertion should create prompt-inline-marker chips and update prompt text');
assert.match(source, /document\.addEventListener\('mousedown', e => \{[\s\S]*closePromptMarkerMenuOnOutsidePointer\(e\)/, 'outside pointer should close marker @ menu');
assert.match(source, /refreshOpenPromptMarkerMenu\(\)/, 'canvas graph changes should refresh open marker @ menu');

for (const cls of ['prompt-rich-input', 'prompt-marker-menu', 'prompt-marker-option', 'prompt-marker-pill', 'prompt-inline-marker']) {
  assert.match(css, new RegExp(`\\.${cls}`), `canvas marker @ CSS should include ${cls}`);
}
assert.match(css, /\.prompt-node textarea,\s*\.prompt-rich-input/, 'prompt rich input should share prompt textarea sizing');
assert.match(css, /\.node\.sized\.prompt-node textarea,\s*\.node\.sized\.prompt-node \.prompt-rich-input/, 'sized prompt rich input should fill resized prompt nodes');

console.log('canvas marker linkage tests passed');
