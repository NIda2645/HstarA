import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';

const source = await readFile(
  new URL('../capture-startup-first-frame.mjs', import.meta.url),
  'utf8',
);

assert.match(
  source,
  /viewport:\s*\{width:\s*1920,\s*height:\s*1080\}/,
  'capture viewport must render a 1920x1080 CSS surface',
);
assert.match(
  source,
  /deviceScaleFactor:\s*2/,
  'capture must use DPR 2 to produce an exact 3840x2160 PNG',
);
assert.ok(
  source.includes('page.addInitScript'),
  'capture must install the WebView readiness bridge before navigation',
);
assert.ok(
  source.includes('hstar-startup:visual-ready'),
  'capture must observe the same visual-ready event as the desktop shell',
);
assert.ok(
  source.includes("message?.type === 'hstar-startup:visual-ready'"),
  'capture bridge must read the structured startup message envelope',
);
assert.ok(
  source.includes('page.waitForFunction'),
  'capture must wait for startup visual readiness instead of inferring it from DOM timing',
);
assert.match(
  source,
  /page\.waitForFunction\([\s\S]*?undefined,\s*\{timeout:\s*15_000\}/,
  'waitForFunction timeout options must use the Playwright options argument',
);
assert.match(
  source,
  /let browser;[\s\S]*?try\s*\{[\s\S]*?chromium\.launch[\s\S]*?finally\s*\{/,
  'browser launch must be inside guarded teardown',
);
assert.ok(
  source.includes('await closeServer(server);'),
  'HTTP server shutdown must be awaited',
);

console.log('startup first-frame capture contract passed');
