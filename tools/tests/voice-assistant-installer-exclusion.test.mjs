import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {existsSync, readFileSync, readdirSync, statSync} from 'node:fs';
import {relative, resolve, sep} from 'node:path';

const root = resolve(process.cwd());
const ignore = readFileSync(resolve(root, '.gitignore'), 'utf8');
const installer = readFileSync(resolve(root, 'build/installer/Hstar.iss'), 'utf8');
const stageRoot = resolve(root, 'build/installer/stage');
const largeBinaryThreshold = 100 * 1024 * 1024;

assert.match(ignore, /\*\*\/\.hstar-voice\//, 'voice runtime directories are ignored');
assert.match(
  ignore,
  /\/FunAudioLLM\/Fun-ASR-Nano-2512\//,
  'repository-local Fun-ASR model data is ignored',
);
assert.match(ignore, /\/voice-assistant-data\//, 'voice data staging roots are ignored');
assert.match(ignore, /\*\*\/\.cache\/modelscope\//, 'repository-local ModelScope caches are ignored');

assert.match(installer, /\.hstar-voice\\\*/, 'installer excludes the optional voice runtime');
assert.match(
  installer,
  /FunAudioLLM\\Fun-ASR-Nano-2512\\\*/,
  'installer excludes Fun-ASR model weights',
);
assert.match(installer, /voice-assistant-data\\\*/, 'installer excludes voice data staging roots');
assert.match(installer, /\.cache\\modelscope\\\*/, 'installer excludes ModelScope caches');
assert.match(installer, /real-smoke-\*\.json/, 'installer excludes real voice diagnostic reports');
assert.match(installer, /fake-microphone\.wav/, 'installer excludes generated microphone fixtures');

const staged = execFileSync('git', ['diff', '--cached', '--name-only'], {
  cwd: root,
  encoding: 'utf8',
});
assert.doesNotMatch(
  staged,
  /(?:model\.pt|\.safetensors|(?:^|\/)\.hstar-voice\/|FunAudioLLM\/Fun-ASR-Nano-2512\/|(?:^|\/)voice-assistant-data\/|real-smoke-.*\.json|\.(?:wav|pcm|raw|webm|ogg|m4a)$)/im,
  'staged changes must not contain optional voice runtime, model, report, or recording data',
);

const forbiddenStageFiles = [];
function walk(folder) {
  for (const entry of readdirSync(folder, {withFileTypes: true})) {
    const fullPath = resolve(folder, entry.name);
    const stagePath = relative(stageRoot, fullPath).split(sep).join('/');
    const normalized = `/${stagePath.toLowerCase()}`;
    if (entry.isDirectory()) {
      if (
        normalized.includes('/.hstar-voice')
        || normalized.includes('/funaudiollm/fun-asr-nano-2512')
        || normalized.includes('/voice-assistant-data')
        || normalized.includes('/.cache/modelscope')
        || normalized.includes('/.modelscope')
      ) {
        forbiddenStageFiles.push(`${stagePath}/`);
        continue;
      }
      walk(fullPath);
      continue;
    }

    const size = statSync(fullPath).size;
    const forbiddenExtension = /\.(?:pt|safetensors|wav|pcm|raw|webm|ogg|m4a)$/i.test(entry.name);
    const oversizedBinary = /\.bin$/i.test(entry.name) && size > largeBinaryThreshold;
    const voiceReport = /(?:real-smoke-.*\.json|voice.*diagnostic.*\.json)$/i.test(entry.name);
    if (forbiddenExtension || oversizedBinary || voiceReport) {
      forbiddenStageFiles.push(stagePath);
    }
  }
}

if (existsSync(stageRoot)) walk(stageRoot);
assert.deepEqual(
  forbiddenStageFiles,
  [],
  'installer stage must not contain voice model, runtime, cache, report, or recording data',
);

console.log('voice assistant installer exclusion checks passed');
