import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync('static/index.html', 'utf8');
const host = fs.readFileSync('static/js/director-host.js', 'utf8');

const canvasNavIndex = index.indexOf("switchUI(this, 'canvas')");
const directorNavIndex = index.indexOf("switchUI(this, 'director-desk')");
const assetNavIndex = index.indexOf("switchUI(this, 'asset-manager')");

assert.ok(canvasNavIndex > 0, 'infinite canvas nav item should exist');
assert.ok(directorNavIndex > canvasNavIndex, '3D director nav item should be after infinite canvas');
assert.ok(assetNavIndex > directorNavIndex, '3D director nav item should be before asset manager');
assert.match(index, /data-i18n="nav\.directorDesk"[^>]*>3D导演台/);

const pageIdsMatch = index.match(/const PAGE_IDS = \[([^\]]+)\]/);
assert.ok(pageIdsMatch, 'PAGE_IDS should be declared');
assert.ok(pageIdsMatch[1].includes("'director-desk'"), 'PAGE_IDS should include director-desk');

assert.match(index, /id="frame-director-desk"/);
assert.match(index, /data-src="\/static\/3d-director\/index\.html(?:\?[^"]*)?"/);
assert.match(index, /\/static\/css\/director-host\.css/);
assert.match(index, /\/static\/js\/director-protocol\.js/);
assert.match(index, /\/static\/js\/director-host\.js/);

assert.match(host, /function\s+normalizeApiList\s*\(/, 'director host normalizes wrapped API lists');
assert.match(host, /normalizeApiList\(canvasesJson,\s*['"]canvases['"]\)/, 'director host reads {canvases:[...]} API responses');
assert.doesNotMatch(host, /�|\?{3,}|鏃|鍔|鏂|鏅|鐢|诲|竷|瀵|兼|紨|馃/, 'director host target picker should not contain mojibake');
assert.match(host, /发送到画布/, 'target picker keeps readable send-to-canvas title');
assert.match(host, /新建画布名称/, 'target picker keeps readable new canvas placeholder');
assert.match(host, /暂无已有画布/, 'target picker explains when no existing canvases are available');
assert.match(host, /普通画布/, 'target picker offers classic canvas target type');
assert.match(host, /智能画布/, 'target picker offers smart canvas target type');
assert.match(host, /id="director-target-create"/, 'target picker has a new canvas button');
assert.match(host, /createStandaloneTargetCanvas/, 'new canvas button creates a target canvas');
assert.match(host, /method:\s*['"]POST['"]/, 'new target creation uses POST');
assert.match(host, /\/api\/canvases/, 'new target creation uses canvas API');
assert.match(host, /const sessionContext = state\.activeSession\?\.context \|\| envelope\.context \|\| \{\}/, 'standalone capture import keeps envelope context as fallback');
assert.match(host, /!state\.activeSession \|\| sessionContext\.mode === ['"]standalone['"]/, 'standalone capture import opens picker even if host session state is missing');
assert.match(host, /openCanvasTarget/, 'standalone import opens the selected canvas target');
assert.match(host, /hstar-director-standalone-captures/, 'standalone imports are forwarded to canvas adapters');
