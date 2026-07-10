import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const html = readFileSync(new URL('../../static/smart-canvas.html', import.meta.url), 'utf8');
const js = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/smart-canvas.css', import.meta.url), 'utf8');
const appVersion = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim().split(/\r?\n/)[0];
const smartJsCacheKey = `${appVersion}.${Math.floor(statSync(new URL('../../static/js/smart-canvas.js', import.meta.url)).mtimeMs / 1000)}`;
const smartCssCacheKey = `${appVersion}.${Math.floor(statSync(new URL('../../static/css/smart-canvas.css', import.meta.url)).mtimeMs / 1000)}`;

const modes = ['preview', 'marker', 'crop', 'outpaint', 'mask', 'brush', 'resize', 'grid'];
for (const mode of modes) {
  assert.match(html, new RegExp(`data-image-edit-mode="${mode}"`), `smart image editor should keep ${mode} mode`);
}

const previewIndex = html.indexOf('data-image-edit-mode="preview"');
const markerIndex = html.indexOf('data-image-edit-mode="marker"');
const cropIndex = html.indexOf('data-image-edit-mode="crop"');
assert.ok(previewIndex >= 0 && markerIndex > previewIndex && cropIndex > markerIndex, 'smart marker button should be placed between preview and crop');

assert.match(html, /smart-canvas\.js\?v=\d+/, 'smart canvas script should use a numeric cache version');
assert.match(html, new RegExp(`/static/js/smart-canvas\\.js\\?v=${smartJsCacheKey.replaceAll('.', '\\.')}`), 'smart canvas script cache key should match the current smart-canvas.js version');
assert.match(html, new RegExp(`/static/css/smart-canvas\\.css\\?v=${smartCssCacheKey.replaceAll('.', '\\.')}`), 'smart canvas stylesheet cache key should match the current smart-canvas.css version');
assert.match(html, /i18n\.js\?v=\d+/, 'smart canvas i18n loader should use a numeric cache version');
assert.match(js, /imageEditMode = \['preview','marker','crop','outpaint','mask','brush','resize','grid'\]/, 'smart image editor should register marker mode after preview');
const nodeToolbarPreviewIndex = js.indexOf("{key:'preview', icon:'eye', label:'预览'");
const nodeToolbarMarkerIndex = js.indexOf("{key:'marker', icon:'map-pin', label:'标记'");
const nodeToolbarCropIndex = js.indexOf("{key:'crop', icon:'crop', label:'裁剪'");
assert.ok(
  nodeToolbarPreviewIndex >= 0 && nodeToolbarMarkerIndex > nodeToolbarPreviewIndex && nodeToolbarCropIndex > nodeToolbarMarkerIndex,
  'smart node floating toolbar should place marker between preview and crop'
);
assert.match(js, /const modeMap = \{[^}]*marker:'marker'[^}]*\}/, 'smart node floating marker action should open marker edit mode');
assert.match(js, /function smartOriginalMediaUrl\(itemOrUrl\)/, 'pure smart media URL normalization should exist');
assert.match(js, /function restoreDynamicParamsScroll\(snapshot\)/, 'pure smart dynamic parameter scroll restore should exist');
assert.match(css, /\.crop-canvas\.brush-mode/, 'pure smart editor should style brush mode');
assert.match(css, /\.crop-canvas\.grid-mode/, 'pure smart editor should style grid mode');

assert.match(html, /id="imageMarkerTools"[\s\S]*id="imageMarkerPanel"[\s\S]*id="imageMarkerLayer"/, 'smart marker editor controls should be present');
assert.match(html, /id="markerResetBtn"[\s\S]*resetImageMarkers\(\)/, 'smart marker reset button should call resetImageMarkers');
assert.match(html, /id="markerProviderSelect" class="select-lite"/, 'smart marker provider select should use the HstarB compact select style');
assert.match(html, /id="markerModelSelect" class="select-lite"/, 'smart marker model select should use the HstarB compact select style');
assert.match(html, /id="markerResetBtn" class="image-edit-btn secondary image-marker-refresh-btn"[\s\S]*data-lucide="eraser"/, 'smart marker reset should use the HstarB compact eraser button');
assert.match(html, /id="markerRefreshBtn"[\s\S]*refreshAllImageMarkers\(\)/, 'smart marker refresh button should refresh all markers');
const markerToolsStart = html.indexOf('id="imageMarkerTools"');
const markerToolsEnd = html.indexOf('id="imageMaskTools"');
const markerPanelIndex = html.indexOf('id="imageMarkerPanel"');
assert.ok(markerToolsStart >= 0 && markerPanelIndex > markerToolsStart && markerPanelIndex < markerToolsEnd, 'smart marker panel should be nested inside the marker toolbar like HstarB');
for (const fn of ['currentMarkerImage', 'renderImageMarkers', 'addImageMarkerAt', 'deleteImageMarker', 'resetImageMarkers', 'identifyImageMarker', 'requestSmartImageMarkerIdentify', 'markerThumbnailAt', 'markerInputDisplayValue', 'normalizeMarkerObjectName', 'refreshAllImageMarkers', 'refreshImageMarkerById']) {
  assert.match(js, new RegExp(`function ${fn}\\(`), `smart marker logic should define ${fn}`);
}
assert.match(js, /fetch\('\/api\/image-marker\/identify'/, 'smart marker identify should call the shared marker endpoint');
assert.match(js, /IMAGE_MARKER_ICON_SVG/, 'smart marker pins should use the HstarB image marker icon');
assert.match(js, /data-marker-name/, 'smart marker rows should support inline marker name editing');
assert.match(js, /data-marker-refresh/, 'smart marker rows should support per-marker refresh');
assert.match(js, /data-marker-delete/, 'smart marker rows should support per-marker delete');
assert.match(css, /\.crop-canvas\.marker-mode[\s\S]*\.image-marker-layer/, 'smart marker mode should enable the marker layer');
assert.match(css, /\.image-marker-pin/, 'smart marker pins should be styled');
assert.match(css, /\.image-marker-row/, 'smart marker panel rows should be styled');
assert.match(css, /\.image-marker-panel\.active\s*\{\s*display:grid;[\s\S]*grid-template-columns:repeat\(7, minmax\(0, 1fr\)\)/, 'smart marker panel should use the HstarB seven-column card grid');
for (const cls of ['image-marker-thumb', 'image-marker-number', 'image-marker-name', 'image-marker-refresh-one', 'image-marker-delete-one']) {
  assert.match(css, new RegExp(`\\.${cls}`), `smart marker CSS should include ${cls}`);
}
assert.match(css, /\.prompt-inline-marker/, 'smart prompt marker chips should be styled');
assert.match(css, /\.prompt-marker-pill/, 'smart mention marker pills should be styled');
assert.doesNotMatch(`${html}\n${js}\n${css}`, /�|\?{3,}/, 'smart marker files should not contain replacement characters or placeholder question marks');

console.log('smart marker integration tests passed');
