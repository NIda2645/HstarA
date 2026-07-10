import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/smart-canvas.css', import.meta.url), 'utf8');

for (const name of [
  'promptPlainText',
  'imageRefsOnly',
  'snapshotRunMeta',
  'attachRunMeta',
  'uniqueReferenceImages',
]) {
  assert.match(source, new RegExp(`function ${name}\\(`), `smart canvas should keep ${name}`);
}

assert.match(source, /function snapshotRunMeta\(prompt, sourceId, displayPrompt='', refs=\[\]\)[\s\S]*promptRefs:\(refs \|\| \[\]\)\.map/, 'smart canvas should snapshot prompt refs');
assert.match(source, /function attachRunMeta\(targetNode, meta\)[\s\S]*targetNode\.runInputRefs = \(meta\.inputRefs \|\| meta\.promptRefs \|\| \[\]\)\.map/, 'smart canvas should attach run input refs');
assert.match(source, /function uniqueReferenceImages\(images\)[\s\S]*seen\.has\(img\.url\)[\s\S]*seen\.add\(img\.url\)/, 'smart canvas should dedupe reference images by URL');

for (const name of ['cloneSmartMarkers', 'smartRefWithMarkers', 'compactSmartRef', 'smartPromptMarkerReferenceDirective', 'smartMarkerCandidatesForNode', 'promptMarkerDisplay', 'insertMarkerMentionToken']) {
  assert.match(source, new RegExp(`function ${name}\\(`), `smart canvas should define ${name}`);
}
assert.match(source, /function uniqueReferenceImages\(images\)[\s\S]*markers:cloneSmartMarkers\(img\.markers\)/, 'smart reference dedupe should preserve marker arrays');
assert.match(source, /function snapshotRunMeta\(prompt, sourceId, displayPrompt='', refs=\[\]\)[\s\S]*compactSmartRef\(ref\)/, 'smart run snapshots should preserve compact marker refs');
assert.match(source, /function attachRunMeta\(targetNode, meta\)[\s\S]*compactSmartRef\(ref\)/, 'smart run attach should preserve compact marker refs');
assert.match(source, /function buildPromptRequest\(node, overrideDefaultImages=null, consumeDefault=false, ctx=smartLoopContext\)[\s\S]*smartPromptMarkerReferenceDirective\(defaultRefs\)/, 'smart prompt requests should append marker directives for referenced images');
assert.match(source, /function mentionCandidateImages\(node, source=mentionSource\)\{[\s\S]*source === 'marker'[\s\S]*smartMarkerCandidatesForNode\(node\)/, 'smart @ picker should expose marker candidates as a selectable source');
assert.match(source, /data-mention-source="marker"[\s\S]*map-pin[\s\S]*标记/, 'smart @ picker should include the marker source tab');
assert.match(source, /mentionSource === 'marker'[\s\S]*mention-marker-list[\s\S]*prompt-marker-pill/, 'smart @ picker should render marker candidates as marker rows');
assert.match(source, /function insertMentionToken\(img\)\{[\s\S]*if\(img\?\.type === 'marker'\) return insertMarkerMentionToken\(img\)/, 'smart @ insertion should dispatch marker candidates to marker token insertion');
assert.match(source, /function insertMarkerMentionToken\(item\)[\s\S]*className = 'prompt-inline-marker'[\s\S]*dataset\.promptMarkerChip = '1'/, 'smart marker @ token should insert prompt-inline-marker chips');
assert.match(source, /function collectPromptParts\(\)[\s\S]*classList\?\.contains\('prompt-inline-marker'\)[\s\S]*parts\.push\(\{type:'text'/, 'smart marker @ chips should serialize back into prompt text');

assert.match(css, /\.mention-source-tabs\s*\{[^}]*grid-template-columns:1fr 1fr 1fr/, 'smart @ picker should reserve three tabs including markers');
for (const cls of ['mention-marker-list', 'mention-marker-option', 'prompt-marker-name']) {
  assert.match(css, new RegExp(`\\.${cls}`), `smart marker @ CSS should include ${cls}`);
}

console.log('smart marker linkage tests passed');
