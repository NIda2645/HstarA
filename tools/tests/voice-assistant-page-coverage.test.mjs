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
const adapterVersions = new Set();

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
  assert.ok(
    html.indexOf('voice-input-adapter.js') < html.indexOf('</head>'),
    `${relative} installs the voice shortcut listener before visible inputs can receive focus`,
  );
  adapterVersions.add(html.match(/\/static\/js\/voice-input-adapter\.js\?v=([^"']+)/)?.[1]);
  assert.doesNotMatch(
    html,
    /voice-assistant-coordinator\.js/,
    `${relative} does not create a second coordinator`,
  );
}
assert.equal(adapterVersions.size, 1, 'every page uses one cache version of the voice target adapter');

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
assert.doesNotMatch(
  coordinator,
  /status\.runtime\?\.ready\s*===\s*false[\s\S]{0,240}_showFirstUse\(/,
  'an existing model never opens the model dialog only because runtime validation is stale',
);
assert.doesNotMatch(
  coordinator,
  /code\.includes\('RUNTIME_MISSING'\)\s*\|\|\s*code\.includes\('MODEL_MISSING'\)/,
  'runtime repair failures do not open the first-use model dialog',
);
assert.match(
  coordinator,
  /status\.runtime\?\.ready\s*===\s*false[\s\S]{0,160}await this\._startService\(signal\)/,
  'stale runtimes are validated before microphone capture starts',
);
assert.match(
  coordinator,
  /if \(missingModel\) this\._showFirstUse\(\)/,
  'only a missing model opens the first-use model dialog',
);

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
const smartCanvasHtml = read('static/smart-canvas.html');
assert.match(
  smartCanvasHtml,
  /id="promptInput"[^>]*data-voice-offset-y="42"/,
  'Smart Canvas composer keeps the microphone below its template button',
);
assert.match(
  smartCanvasJs,
  /prompt-node-text[^>]*data-voice-offset-y="42"/,
  'Smart Canvas prompt nodes keep the microphone below their delete button',
);
for (const [name, source] of [['canvas.js', canvasJs], ['smart-canvas.js', smartCanvasJs]]) {
  assert.match(source, /data-voice-input=["']on["'][^>]*data-voice-label=/, `${name} labels generated natural-language inputs`);
  assert.match(source, /data-voice-input=["']off["']/, `${name} excludes generated machine controls`);
}

const openshopSource = read('integrations/openshop/index.html');
const openshopBuilt = read('static/openshop/index.html');
for (const [name, html] of [['OpenShop source', openshopSource], ['OpenShop build', openshopBuilt]]) {
  assert.match(html, /\/static\/js\/voice-input-adapter\.js\?v=/, `${name} loads the adapter`);
}
const openshopBuildVersion = openshopBuilt.match(
  /\/static\/js\/voice-input-adapter\.js\?v=([^"']+)/,
)?.[1];
assert.equal(
  openshopBuildVersion,
  [...adapterVersions][0],
  'OpenShop runtime uses the current adapter cache version',
);
const generativeSource = read('integrations/openshop/host/openshop-generative-tools.js');
assert.match(generativeSource, /HstarVoiceInputAdapter\?\.register/, 'OpenShop registers its mention editor');
assert.match(generativeSource, /beginVoiceComposition/, 'OpenShop creates a voice composition span');
assert.match(generativeSource, /cancelVoiceComposition/, 'OpenShop can cancel uncommitted voice text');
assert.match(generativeSource, /data-generative-mention-token/, 'OpenShop keeps mention capsules distinct');

const directorSource = read('integrations/storyai-3d-director-desk/index.html');
const directorBuilt = read('static/3d-director/index.html');
assert.match(directorSource, /\/static\/js\/voice-input-adapter\.js\?v=/, '3D director source loads the shared adapter');
assert.match(
  directorSource,
  /<script\s+vite-ignore\s+src=["']\/static\/js\/voice-input-adapter\.js\?v=/,
  '3D director leaves the shared classic script outside the Vite module bundle',
);
assert.match(directorBuilt, /\/static\/js\/voice-input-adapter\.js\?v=/, '3D director build retains the shared adapter');

const realVoiceE2e = read('integrations/openshop/tests/hstar-voice-assistant-real.e2e.spec.js');
assert.match(
  realVoiceE2e,
  /HSTAR_REAL_VOICE_PYTHON/,
  'real browser acceptance can use the packaged Python ABI that owns the voice runtime',
);
assert.match(
  realVoiceE2e,
  /existsSync\(pythonExecutable\)/,
  'real browser acceptance rejects a missing Python override before starting',
);

console.log('voice assistant page coverage checks passed');
