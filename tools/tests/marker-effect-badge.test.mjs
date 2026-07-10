import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const canvasJs = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const canvasCss = readFileSync(new URL('../../static/css/canvas.css', import.meta.url), 'utf8');
const smartJs = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const smartCss = readFileSync(new URL('../../static/css/smart-canvas.css', import.meta.url), 'utf8');
const markerEffectiveText = '\u6807\u8bb0\u5df2\u751f\u6548';

assert.match(canvasJs, /function generatorHasActiveMarkers\(gen\)/, 'normal canvas should detect usable upstream markers for generator nodes');
assert.match(canvasJs, /function refreshMarkerEffectBadges\(\)/, 'normal canvas should refresh marker effect badges');
assert.ok(canvasJs.includes(markerEffectiveText), 'normal canvas generator badge should show the requested marker effective text');
assert.match(canvasJs, /\.node-head[\s\S]*node-marker-effect-badge/, 'normal canvas marker badge should be placed in the node header/right corner');
assert.match(canvasJs, /function render\(\)[\s\S]*refreshControllerEffectBadges\(\);\s*refreshMarkerEffectBadges\(\);/, 'normal canvas full render should restore marker badges');
assert.match(canvasJs, /function refreshNodes\(ids=\[\]\)[\s\S]*refreshControllerEffectBadges\(\);\s*refreshMarkerEffectBadges\(\);/, 'normal canvas partial refresh should restore marker badges');
assert.match(canvasCss, /\.marker-effect-badge/, 'normal canvas should style marker effect badges');

assert.doesNotMatch(smartJs, /function smartNodeHasActiveMarkers\(node\)/, 'pure smart canvas baseline should not contain the old fused marker badge logic');
assert.doesNotMatch(smartJs, /function markerEffectBadgeHtml\(node\)/, 'pure smart canvas baseline should not render old marker effect badges');
assert.doesNotMatch(smartCss, /\.marker-effect-badge/, 'pure smart canvas baseline should not keep unused marker effect badge styles');

console.log('marker effect badge tests passed');
