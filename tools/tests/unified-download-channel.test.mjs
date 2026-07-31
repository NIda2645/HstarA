import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const [canvas, smartCanvas, online, assetManager, openShopExport, backend, browserExtension] = await Promise.all([
  readFile(new URL('../../static/js/canvas.js', import.meta.url), 'utf8'),
  readFile(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8'),
  readFile(new URL('../../static/online.html', import.meta.url), 'utf8'),
  readFile(new URL('../../static/js/asset-manager.js', import.meta.url), 'utf8'),
  readFile(new URL('../../integrations/openshop/host/openshop-export-service.js', import.meta.url), 'utf8'),
  readFile(new URL('../../main.py', import.meta.url), 'utf8'),
  readFile(new URL('../chrome-local-asset-importer/popup.js', import.meta.url), 'utf8'),
]);

for (const [name, source] of [
  ['classic canvas', canvas],
  ['smart canvas', smartCanvas],
  ['OpenShop', openShopExport],
]) {
  assert.doesNotMatch(
    source,
    /\/api\/native\/save-output-(?:as|batch)/,
    `${name} downloads must enter the desktop WebView2 download channel`,
  );
}

assert.match(canvas, /\/api\/download-output\?url=/, 'classic single downloads use an attachment response');
assert.match(smartCanvas, /\/api\/download-output\?url=/, 'smart single downloads use an attachment response');
assert.match(online, /\/api\/download-output\?url=/, 'online detail downloads use an attachment response');
assert.match(assetManager, /\/api\/download-output\?url=/, 'asset downloads use an attachment response');
assert.match(openShopExport, /URL\.createObjectURL/, 'OpenShop artifacts enter the browser download event');

for (const [name, source] of [
  ['classic canvas', canvas],
  ['smart canvas', smartCanvas],
  ['asset manager', assetManager],
  ['OpenShop', openShopExport],
]) {
  assert.match(source, /HstarDesktopDownloads/, `${name} batch downloads use the desktop folder bridge`);
}

assert.doesNotMatch(smartCanvas, /filename[^\n]*\.zip/, 'smart batch downloads must preserve separate files');
assert.doesNotMatch(openShopExport, /openshop-exports\.zip/, 'OpenShop batch exports must preserve separate files');
assert.doesNotMatch(
  backend,
  /\/api\/(?:native\/save-output-(?:as|batch)|canvas-assets\/download)/,
  'legacy backend save and media-archive routes must not bypass the owned download channel',
);
assert.doesNotMatch(browserExtension, /buildZipBlob|application\/zip/, 'browser extension batches must preserve separate files');
assert.match(browserExtension, /for\s*\(let index = 0; index < picked\.length; index\+\+\)/, 'browser extension downloads every selected item');

console.log('Unified desktop download channel contract passed');
