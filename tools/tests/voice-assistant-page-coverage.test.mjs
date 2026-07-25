import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const entryPages = [
  'zimage.html', 'enhance.html', 'klein.html', 'angle.html', 'online.html',
  'gpt-chat.html', 'asset-manager.html', 'canvas-list.html', 'canvas.html',
  'smart-canvas.html', 'api-settings.html', 'comfyui-settings.html',
  'software-settings.html', 'openshop/index.html', '3d-director/index.html',
];

function read(relative) {
  return readFileSync(resolve(root, relative), 'utf8');
}

for (const relative of entryPages) {
  const html = read(`static/${relative}`);
  assert.match(
    html,
    /\/static\/js\/voice-input-adapter\.js\?v=[^"']+/,
    `${relative} loads the shared voice target adapter`,
  );
  assert.doesNotMatch(
    html,
    /voice-assistant-coordinator\.js/,
    `${relative} does not create a second coordinator`,
  );
}

const shell = read('static/index.html');
assert.match(shell, /\/static\/css\/voice-assistant\.css\?v=/, 'main shell owns global voice styles');
assert.match(shell, /\/static\/js\/voice-input-adapter\.js\?v=/, 'main shell loads the target adapter first');
assert.match(shell, /\/static\/js\/voice-assistant-coordinator\.js\?v=/, 'main shell owns the one global voice coordinator');
assert.match(shell, /HstarVoiceAssistantCoordinator\.create\(/, 'main shell creates one coordinator');
assert.match(shell, /HstarVoiceAssistant\?\.attachFrame\(f\)/, 'iframe load hooks attach child target adapters');
assert.ok(
  shell.indexOf('voice-input-adapter.js') < shell.indexOf('voice-assistant-coordinator.js'),
  'the adapter loads before the coordinator',
);

const adapter = read('static/js/voice-input-adapter.js');
assert.match(adapter, /hstar-voice-target-active/, 'adapter reports active targets');
assert.match(adapter, /framePath/, 'adapter relays nested iframe target routes');

const coordinator = read('static/js/voice-assistant-coordinator.js');
assert.match(coordinator, /attachFrame\(/, 'coordinator attaches direct child frames');
assert.match(coordinator, /getTargetById/, 'coordinator resolves child target handles');

const sensitivePattern = /(api.?key|secret|token|endpoint|base.?url|model.?id|file.?path|folder|directory|output.?path|shortcut|accelerator|width|height|port)/i;
const excludedTypes = new Set(['password', 'number', 'range', 'color', 'date', 'datetime-local', 'hidden', 'file', 'checkbox', 'radio']);
for (const relative of entryPages.filter(page => !page.startsWith('openshop/') && !page.startsWith('3d-director/'))) {
  const html = read(`static/${relative}`);
  for (const match of html.matchAll(/<(input|textarea)\b[^>]*>/gi)) {
    const tag = match[0];
    const type = /type=["']([^"']+)/i.exec(tag)?.[1]?.toLowerCase() || (match[1].toLowerCase() === 'textarea' ? 'textarea' : 'text');
    if (!sensitivePattern.test(tag) || excludedTypes.has(type) || /\b(readonly|disabled)\b/i.test(tag)) continue;
    assert.match(tag, /data-voice-input=["']off["']/i, `${relative} excludes machine field ${tag.slice(0, 140)}`);
  }
}

const canvasJs = read('static/js/canvas.js');
const smartCanvasJs = read('static/js/smart-canvas.js');
for (const [name, source] of [['canvas.js', canvasJs], ['smart-canvas.js', smartCanvasJs]]) {
  assert.match(source, /data-voice-input=["']on["'][^>]*data-voice-label=/, `${name} labels generated natural-language inputs`);
  assert.match(source, /data-voice-input=["']off["']/, `${name} excludes generated machine controls`);
}

const openshopSource = read('integrations/openshop/index.html');
const openshopBuilt = read('static/openshop/index.html');
for (const [name, html] of [['OpenShop source', openshopSource], ['OpenShop build', openshopBuilt]]) {
  assert.match(html, /\/static\/js\/voice-input-adapter\.js\?v=/, `${name} loads the adapter`);
}
const generativeSource = read('integrations/openshop/host/openshop-generative-tools.js');
assert.match(generativeSource, /HstarVoiceInputAdapter\?\.register/, 'OpenShop registers its mention editor');
assert.match(generativeSource, /beginVoiceComposition/, 'OpenShop creates a voice composition span');
assert.match(generativeSource, /cancelVoiceComposition/, 'OpenShop can cancel uncommitted voice text');
assert.match(generativeSource, /data-generative-mention-token/, 'OpenShop keeps mention capsules distinct');

const directorSource = read('integrations/storyai-3d-director-desk/index.html');
const directorBuilt = read('static/3d-director/index.html');
assert.match(directorSource, /\/static\/js\/voice-input-adapter\.js\?v=/, '3D director source loads the shared adapter');
assert.match(directorBuilt, /\/static\/js\/voice-input-adapter\.js\?v=/, '3D director build retains the shared adapter');

console.log('voice assistant page coverage checks passed');
