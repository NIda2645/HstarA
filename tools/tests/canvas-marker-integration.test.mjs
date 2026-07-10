import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const html = readFileSync(new URL('../../static/canvas.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/canvas.css', import.meta.url), 'utf8');
const appVersion = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim().split(/\r?\n/)[0];
const canvasJsCacheKey = `${appVersion}.${Math.floor(statSync(new URL('../../static/js/canvas.js', import.meta.url)).mtimeMs / 1000)}`;
const canvasCssCacheKey = `${appVersion}.${Math.floor(statSync(new URL('../../static/css/canvas.css', import.meta.url)).mtimeMs / 1000)}`;

for (const mode of ['preview', 'marker', 'crop', 'outpaint', 'mask', 'brush', 'resize', 'grid']) {
  assert.match(html, new RegExp(`data-image-edit-mode="${mode}"`), `normal canvas image editor should keep ${mode} mode`);
}

const previewIndex = html.indexOf('data-image-edit-mode="preview"');
const markerIndex = html.indexOf('data-image-edit-mode="marker"');
const cropIndex = html.indexOf('data-image-edit-mode="crop"');
assert.ok(previewIndex >= 0 && markerIndex > previewIndex && cropIndex > markerIndex, 'normal canvas marker button should sit directly after preview and before crop');

assert.match(html, new RegExp(`/static/js/canvas\\.js\\?v=${canvasJsCacheKey.replaceAll('.', '\\.')}`), 'normal canvas script cache key should match current canvas.js');
assert.match(html, new RegExp(`/static/css/canvas\\.css\\?v=${canvasCssCacheKey.replaceAll('.', '\\.')}`), 'normal canvas stylesheet cache key should match current canvas.css');
assert.match(js, /imageEditMode = \['preview','marker','crop','outpaint','mask','brush','resize','grid'\]/, 'normal canvas image editor should register marker mode after preview');
assert.match(js, /if\(!\['preview','marker','crop','outpaint','mask','brush','resize','grid'\]\.includes\(initialMode\)\) initialMode = 'crop';/, 'normal canvas image editor opener should accept marker as an initial mode');
assert.match(js, /cropCanvasEl\.classList\.toggle\('marker-mode', imageEditMode === 'marker'\);/, 'normal canvas should toggle marker mode on the edit canvas');
assert.match(js, /document\.getElementById\('imageMarkerTools'\)\?\.classList\.toggle\('active', imageEditMode === 'marker'\);/, 'normal canvas should show marker tools only in marker mode');
assert.match(js, /document\.getElementById\('imageMarkerLayer'\)\?\.addEventListener\('pointerdown', beginImageMarkerPointer\);/, 'normal canvas marker layer should receive pointer events');

assert.match(html, /id="imageMarkerTools"[\s\S]*id="imageMarkerPanel"[\s\S]*id="imageMarkerLayer"/, 'normal canvas marker controls and marker layer should be present');
assert.match(html, /id="markerResetBtn"[\s\S]*resetImageMarkers\(\)/, 'normal canvas marker reset button should call resetImageMarkers');
assert.match(html, /id="markerRefreshBtn"[\s\S]*refreshAllImageMarkers\(\)/, 'normal canvas marker refresh button should refresh all markers');

for (const fn of ['currentMarkerImage', 'renderImageMarkers', 'addImageMarkerAt', 'deleteImageMarker', 'resetImageMarkers', 'identifyImageMarker', 'markerThumbnailAt', 'markerInputDisplayValue', 'normalizeMarkerObjectName', 'refreshAllImageMarkers', 'refreshImageMarkerById']) {
  assert.match(js, new RegExp(`function ${fn}\\(`), `normal canvas marker logic should define ${fn}`);
}
assert.match(js, /fetch\('\/api\/image-marker\/identify'/, 'normal canvas marker identify should call the shared marker endpoint');
assert.match(js, /IMAGE_MARKER_ICON_SVG/, 'normal canvas marker pins should use the HstarB image marker icon');
assert.match(js, /data-marker-name/, 'normal canvas marker rows should support inline marker name editing');
assert.match(js, /data-marker-refresh/, 'normal canvas marker rows should support per-marker refresh');
assert.match(js, /data-marker-delete/, 'normal canvas marker rows should support per-marker delete');
assert.match(css, /\.crop-canvas\.marker-mode[\s\S]*\.image-marker-layer/, 'normal canvas marker mode should enable the marker layer');
assert.match(css, /\.image-marker-pin/, 'normal canvas marker pins should be styled');
assert.match(css, /\.image-marker-panel\.active\s*\{\s*display:grid;[\s\S]*grid-template-columns:repeat\(7, minmax\(0, 1fr\)\)/, 'normal canvas marker panel should use the compact seven-column card grid');
for (const cls of ['image-marker-thumb', 'image-marker-number', 'image-marker-name', 'image-marker-refresh-one', 'image-marker-delete-one']) {
  assert.match(css, new RegExp(`\\.${cls}`), `normal canvas marker CSS should include ${cls}`);
}

assert.doesNotMatch(`${html}\n${js}\n${css}`, /�|\?{3,}/, 'normal canvas marker files should not contain replacement characters or placeholder question marks');

console.log('normal canvas marker integration tests passed');
