import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/smart-canvas.css', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../static/smart-canvas.html', import.meta.url), 'utf8');
const version = readFileSync(new URL('../../VERSION', import.meta.url), 'utf8').trim().split(/\r?\n/)[0];
const jsCacheKey = `${version}.${Math.floor(statSync(new URL('../../static/js/smart-canvas.js', import.meta.url)).mtimeMs / 1000)}`;
const cssCacheKey = `${version}.${Math.floor(statSync(new URL('../../static/css/smart-canvas.css', import.meta.url)).mtimeMs / 1000)}`;

function functionSource(name){
    const start = js.lastIndexOf(`function ${name}(`);
    assert.ok(start >= 0, `expected function ${name}`);
    const remainder = js.slice(start + 1);
    const nextMatch = /\n(?:async\s+)?function\s+[A-Za-z0-9_$]+\s*\(/.exec(remainder);
    return js.slice(start, nextMatch ? start + 1 + nextMatch.index : js.length);
}

const gridIndex = js.indexOf("{key:'grid'");
const externalIndex = js.indexOf("{key:'externalOpen'");
const downloadIndex = js.indexOf("{key:'download'");

assert.ok(gridIndex >= 0, 'smart image toolbar should keep the grid action');
assert.ok(externalIndex > gridIndex, 'external open should follow the grid action');
assert.ok(downloadIndex > externalIndex, 'download should follow external open');
assert.match(js, /key:'externalOpen'[\s\S]{0,140}dropdown:true/, 'external open should render a dropdown caret');
assert.match(js, /data-smart-external-app="photoshop"[\s\S]*用 Photoshop 打开/, 'menu should include Photoshop');
assert.match(js, /data-smart-external-app="illustrator"[\s\S]*用 Illustrator 打开/, 'menu should include Illustrator');
assert.match(js, /data-smart-external-app="custom"[\s\S]*用自定义软件打开/, 'menu should include custom software');
assert.match(js, /fetch\('\/api\/open-external-image'/, 'smart canvas should use the established external-open route');
assert.match(js, /fetch\('\/api\/native\/choose-executable'/, 'smart canvas should use the native executable picker');
assert.match(js, /fetch\('\/api\/software-settings\/external-app'/, 'smart canvas should persist executable bindings');
assert.match(js, /body:JSON\.stringify\(\{url, app\}\)/, 'external-open payload should preserve the active image URL and app');
assert.match(js, /body:JSON\.stringify\(\{app, path\}\)/, 'binding payload should preserve app and executable path');
assert.match(js, /function positionSmartExternalOpenMenu\(\)/, 'menu should have world-space positioning');
const externalPositionSource = functionSource('positionSmartExternalOpenMenu');
assert.match(externalPositionSource, /const worldRect = world\.getBoundingClientRect\(\);/, 'menu positioning should read the currently rendered world transform');
assert.match(externalPositionSource, /const renderedScale = Math\.max\(0\.001,[\s\S]*worldRect\.width \/ world\.offsetWidth/, 'menu positioning should derive the rendered transition scale from the world bounds');
assert.match(externalPositionSource, /const buttonTop = \(rect\.top - worldRect\.top\) \/ renderedScale;/, 'menu positioning should keep button and menu in the same rendered world coordinate system');
assert.doesNotMatch(externalPositionSource, /viewport\.(?:x|y)/, 'menu positioning should not mix target viewport offsets with animated DOM bounds');
assert.match(js, /positionSmartExternalOpenMenu\(\);[\s\S]*positionSmartTextEditPanel\(\);/, 'viewport changes should reposition the menu');
assert.match(functionSource('moveNodeElementsDuringDrag'), /positionSmartExternalOpenMenu\(\);[\s\S]*positionSmartTextEditPanel\(\);/, 'node dragging should reposition the menu');
assert.match(functionSource('updateNodeElementDuringResize'), /positionSmartExternalOpenMenu\(\);[\s\S]*positionSmartTextEditPanel\(\);/, 'node resizing should reposition the menu');
assert.match(js, /closeSmartTextEditMenu\(\);[\s\S]{0,180}smartExternalOpenMenuState/, 'opening external menu should close text edit');
assert.match(js, /function openSmartTextEditMenu\([\s\S]{0,260}closeSmartExternalOpenMenu\(\);/, 'opening text edit should close external menu');
assert.match(js, /function render\(\)\{\s*closeSmartExternalOpenMenu\(\);/, 'rerendering nodes should discard stale menu state');
assert.match(js, /if\(!e\.target\.closest\('\.smart-text-edit-menu'\)\)\{[\s\S]{0,180}closeSmartExternalOpenMenu\(\);/, 'outside pointer input should close the menu');
assert.match(js, /event\.key === 'Escape'[\s\S]{0,260}closeSmartExternalOpenMenu\(\)/, 'Escape should close the menu');
assert.match(css, /\.smart-external-open-menu\s*\{[^}]*min-width:158px;/, 'menu should fit all labels without wrapping');
assert.match(html, new RegExp(`smart-canvas\\.css\\?v=${cssCacheKey.replaceAll('.', '\\.')}`), 'page should request the current stylesheet revision');
assert.match(html, new RegExp(`smart-canvas\\.js\\?v=${jsCacheKey.replaceAll('.', '\\.')}`), 'page should request the current script revision');

console.log('smart external open tests passed');
