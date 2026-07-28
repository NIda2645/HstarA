import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const htmlPath = new URL('../../static/gpt-chat.html', import.meta.url);
const html = readFileSync(htmlPath, 'utf8');
const helperStart = html.indexOf('function anchoredPickerTop(');
const helperEnd = html.indexOf('\n        function positionModelPicker', helperStart);

assert.ok(helperStart >= 0 && helperEnd > helperStart, 'the GPT picker anchor helper should be extractable');

const context = {};
vm.runInNewContext(
  `${html.slice(helperStart, helperEnd)}\nthis.anchoredPickerTop = anchoredPickerTop;`,
  context,
  { filename: htmlPath.pathname },
);

for (const [name, popupHeight] of [['model', 183], ['resolution', 149]]) {
  const buttonTop = 801.779;
  const scale = 0.903;
  const localTop = context.anchoredPickerTop(buttonTop, popupHeight, scale, 8, 12);
  const renderedBottom = (localTop + popupHeight) * scale;
  assert.ok(
    Math.abs(buttonTop - renderedBottom - 8) < 0.01,
    `${name} picker should sit 8px above its button at a scaled viewport`,
  );
}

const modelFunction = html.slice(
  html.indexOf('function positionModelPicker('),
  html.indexOf('function toggleResolutionPicker(', html.indexOf('function positionModelPicker(')),
);
const resolutionFunction = html.slice(
  html.indexOf('function positionResolutionPicker('),
  html.indexOf('function setModelPickerScope(', html.indexOf('function positionResolutionPicker(')),
);
const renderFunction = html.slice(
  html.indexOf('function renderModelPicker('),
  html.indexOf('async function loadConversations(', html.indexOf('function renderModelPicker(')),
);
assert.match(modelFunction, /anchoredPickerTop\(/, 'model picker uses the shared button anchor');
assert.match(resolutionFunction, /anchoredPickerTop\(/, 'resolution picker uses the shared button anchor');
assert.match(
  renderFunction,
  /picker\.classList\.contains\('open'\)[\s\S]*?requestAnimationFrame\(positionModelPicker\)/,
  'an open model picker is re-anchored after its dynamic lists change height',
);
assert.match(
  html,
  /addEventListener\('studio-ui-scale-change',[\s\S]*?positionModelPicker\(\)[\s\S]*?positionResolutionPicker\(\)/,
  'open GPT pickers are re-anchored after the shared UI scale settles',
);

console.log('GPT chat picker popover anchor contract passed');
