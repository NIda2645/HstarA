import assert from 'node:assert/strict';
import fs from 'node:fs';

const index = fs.readFileSync('static/index.html', 'utf8');

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
assert.match(index, /data-src="\/static\/3d-director\/index\.html"/);
assert.match(index, /\/static\/css\/director-host\.css/);
assert.match(index, /\/static\/js\/director-protocol\.js/);
assert.match(index, /\/static\/js\/director-host\.js/);
