import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const bridgePath = resolve(root, 'static/js/desktop-shell-bridge.js');
assert.ok(existsSync(bridgePath), 'desktop readiness bridge exists');

const bridge = readFileSync(bridgePath, 'utf8');
const index = readFileSync(resolve(root, 'static/index.html'), 'utf8');

assert.match(index, /desktop-shell-bridge\.js/, 'studio shell loads the desktop bridge');
assert.match(bridge, /window\.chrome\?\.webview/, 'ordinary browsers are a no-op');
assert.match(bridge, /studio-route-booting/, 'bridge waits for route restoration');
assert.match(bridge, /requestAnimationFrame/, 'bridge waits for a painted frame');
assert.match(bridge, /type:\s*['"]hstar:interactive['"]/, 'bridge sends the interactive protocol message');
assert.match(bridge, /schemaVersion:\s*1/, 'bridge pins schema version 1');
assert.match(bridge, /__HSTAR_NAVIGATION_ID__/, 'bridge echoes the injected navigation generation');
assert.match(bridge, /sent\s*=\s*true/, 'bridge is one-shot per document');

console.log('desktop shell bridge contract passed');
