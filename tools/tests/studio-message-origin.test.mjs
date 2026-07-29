import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [shell, theme, apiSettings, comfySettings] = await Promise.all([
  readFile(new URL('../../static/index.html', import.meta.url), 'utf8'),
  readFile(new URL('../../static/js/theme.js', import.meta.url), 'utf8'),
  readFile(new URL('../../static/js/api-settings.js', import.meta.url), 'utf8'),
  readFile(new URL('../../static/js/comfyui-settings.js', import.meta.url), 'utf8'),
]);

for (const [name, source] of [
  ['Studio shell', shell],
  ['theme controller', theme],
  ['API settings', apiSettings],
  ['ComfyUI settings', comfySettings],
]) {
  assert.doesNotMatch(
    source,
    /postMessage\([^\n]*,\s*['"]\*['"]\)/,
    `${name} must target its same-origin Hstar peer explicitly`,
  );
}

for (const [name, source] of [
  ['Studio shell', shell],
  ['theme controller', theme],
  ['API settings', apiSettings],
  ['ComfyUI settings', comfySettings],
]) {
  assert.match(
    source,
    /addEventListener\('message',\s*event\s*=>\s*\{\s*if\s*\(event\.origin\s*!==\s*window\.location\.origin\)\s*return;/,
    `${name} must reject non-Hstar message origins`,
  );
}

console.log('Studio message origin contract passed');
