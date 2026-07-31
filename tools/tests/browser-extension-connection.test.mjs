import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {readFile} from 'node:fs/promises';

const require = createRequire(import.meta.url);
const {
  buildServerCandidates,
  discoverHstarServer,
  probeHstarServer,
} = require('../chrome-local-asset-importer/hstar-connection.js');

function response(status, body){
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    async text(){ return text; },
  };
}

assert.deepEqual(
  buildServerCandidates('127.0.0.1:5000'),
  ['http://127.0.0.1:5000', 'http://127.0.0.1:3000'],
  'the configured endpoint is tried first and duplicate defaults are removed',
);

{
  let requestOptions;
  const connected = await probeHstarServer(
    'http://127.0.0.1:5000',
    async (_url, options) => {
      requestOptions = options;
      return response(200, {providers: []});
    },
  );
  assert.equal(connected.ok, true);
  assert.deepEqual(requestOptions, {cache: 'no-store'});
}

{
  const calls = [];
  const result = await discoverHstarServer({
    configuredAddress: '127.0.0.1:5000',
    fetchImpl: async url => {
      calls.push(url);
      if(url === 'http://127.0.0.1:5000/api/providers'){
        return response(401, {detail: '请从 Hstar 桌面程序打开此页面'});
      }
      return response(200, {providers: [{id: 'modelscope'}]});
    },
  });

  assert.equal(result.base, 'http://127.0.0.1:3000');
  assert.deepEqual(result.providers, [{id: 'modelscope'}]);
  assert.deepEqual(calls, [
    'http://127.0.0.1:5000/api/providers',
    'http://127.0.0.1:3000/api/providers',
  ]);
  assert.equal(result.attempts[0].kind, 'unsupported');
}

{
  const result = await discoverHstarServer({
    configuredAddress: '127.0.0.1:5000',
    fetchImpl: async url => {
      if(url.includes(':5000/')) throw new TypeError('Failed to fetch');
      return response(200, {providers: []});
    },
  });
  assert.equal(result.base, 'http://127.0.0.1:3000');
  assert.equal(result.attempts[0].kind, 'unreachable');
}

{
  const missing = await probeHstarServer(
    'http://127.0.0.1:3000',
    async () => response(404, {detail: 'Not Found'}),
  );
  assert.equal(missing.ok, false);
  assert.equal(missing.kind, 'missing-api');
  assert.match(missing.message, /插件接口/);
}

{
  await assert.rejects(
    discoverHstarServer({
      configuredAddress: '127.0.0.1:5000',
      fetchImpl: async url => url.includes(':5000/')
        ? response(401, {detail: '请从 Hstar 桌面程序打开此页面'})
        : Promise.reject(new TypeError('Failed to fetch')),
    }),
    error => {
      assert.equal(error.code, 'HSTAR_SERVICE_NOT_FOUND');
      assert.match(error.message, /旧版 Hstar/);
      assert.match(error.message, /127\.0\.0\.1:3000/);
      return true;
    },
  );
}

const [popup, popupHtml, sidepanelHtml] = await Promise.all([
  readFile(new URL('../chrome-local-asset-importer/popup.js', import.meta.url), 'utf8'),
  readFile(new URL('../chrome-local-asset-importer/popup.html', import.meta.url), 'utf8'),
  readFile(new URL('../chrome-local-asset-importer/sidepanel.html', import.meta.url), 'utf8'),
]);

for(const [name, html] of [['popup', popupHtml], ['side panel', sidepanelHtml]]){
  assert.match(html, /<script src="hstar-connection\.js"><\/script>\s*<script src="popup\.js"><\/script>/, `${name} loads the connection helper first`);
}

assert.match(popup, /HstarExtensionConnection/, 'popup uses the tested discovery helper');
assert.match(popup, /resolveActiveServer\(\{forceProbe:\s*true\}\)/, 'imports revalidate the active Hstar service');
assert.match(popup, /fetch\(`\$\{serviceBase\}\/api\/local-assets\/import-urls`/, 'imports use the discovered active service');
assert.doesNotMatch(popup, /X-Hstar-Integration/i, 'the Chrome plugin remains independent of packaged-shell authentication');
assert.match(popup, /new URL\(url,\s*location\.href\)/, 'page-context imports identify same-origin authenticated resources');
assert.match(popup, /parsed\.origin\s*!==\s*location\.origin/, 'page-context imports skip cross-origin resources for backend fallback');
assert.match(popup, /blob:\|https\?:/i, 'imports attempt page-context reads for blob and HTTP resources');
assert.match(popup, /PAGE_INLINE_MAX_BYTES/, 'page-context reads enforce an explicit media size limit');
assert.match(popup, /if\(!res\.ok\s*\|\|\s*!data\.ok\)/, 'imports reject API responses that report zero successful items');

console.log('Browser extension Hstar connection discovery tests passed');
