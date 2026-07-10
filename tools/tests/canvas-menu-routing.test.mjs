import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';

const canvasHtml = readFileSync('static/canvas.html', 'utf8');
const canvasJs = readFileSync('static/js/canvas.js', 'utf8');
const indexHtml = readFileSync('static/index.html', 'utf8');
const appVersion = readFileSync('VERSION', 'utf8').trim().split(/\r?\n/)[0];
const canvasJsCacheKey = `${appVersion}.${Math.floor(statSync('static/js/canvas.js').mtimeMs / 1000)}`;

assert.match(
  indexHtml,
  /id="frame-canvas"\s+data-src="\/static\/canvas-list\.html\?v=/,
  'sidebar Infinite Canvas entry should open the standalone canvas-list workspace, not the editor page'
);

assert.doesNotMatch(
  canvasHtml,
  /id="canvasGate"|id="gateCanvasList"|id="gateCreateBtn"|id="gateBackBtn"/,
  'canvas editor HTML should not embed the HstarA-style canvas selection gate because HstarB uses static/canvas-list.html for that menu page'
);

assert.match(
  canvasHtml,
  /选画布 gate 已拆分到独立页面 static\/canvas-list\.html|static\/canvas-list\.html/,
  'canvas editor should document that selection is owned by the standalone canvas list page'
);

assert.match(
  canvasHtml,
  new RegExp(`/static/js/canvas\\.js\\?v=${canvasJsCacheKey.replaceAll('.', '\\.')}`),
  'canvas editor should use the cache key produced by startup static HTML version sync'
);

assert.match(
  canvasJs,
  /const openId = new URLSearchParams\(window\.location\.search\)\.get\('id'\);[\s\S]*if\(openId\)\{[\s\S]*await openCanvas\(openId\);[\s\S]*\} else \{[\s\S]*window\.location\.replace\(canvasListUrlForProject\(rememberedCanvasListProject\(\)\)\);/,
  'canvas editor should redirect to canvas-list.html when opened without a canvas id'
);

assert.match(canvasJs, /function refreshGateViewControls\(\)\{\s*if\(!canvasGate\) return;/, 'gate refresh must be safe when editor page has no gate DOM');
assert.match(canvasJs, /function renderCanvasList\(\)\{\s*if\(!gateCanvasList\) return;/, 'gate list rendering must be safe when editor page has no gate DOM');
assert.match(canvasJs, /gateCreateBtn\?\.addEventListener\('click'/, 'gate create binding should be optional');
assert.match(canvasJs, /gateBackBtn\?\.addEventListener\('click'/, 'gate back binding should be optional');
assert.match(canvasJs, /gateRefreshBtn\?\.addEventListener\('click'/, 'gate refresh binding should be optional');
assert.match(canvasJs, /gateConfirmBtn\?\.addEventListener\('click'/, 'gate confirm binding should be optional');
assert.match(canvasJs, /gateTitleInput\?\.addEventListener\('keydown'/, 'gate title input binding should be optional');

assert.match(
  canvasJs,
  /if\(CANVAS_GENERATOR_TYPES\.includes\(node\.type\) \|\| node\.type === 'llm'\)\{[\s\S]*\{type:'image', label:tr\('canvas\.imageCard'\), icon:'image-plus'\}[\s\S]*\{type:'prompt', label:tr\('canvas\.prompt'\), icon:'text-cursor-input'\}[\s\S]*\{type:'controller', label:'综合控制器', icon:'sliders-horizontal'\}[\s\S]*\{type:'loop', label:tr\('canvas\.loopNode'\), icon:'repeat-2'\}/,
  'generator and LLM input menus should offer a controller node shortcut'
);

assert.match(
  canvasJs,
  /if\(state\.originKind === 'out'\)\{[\s\S]*\['image','prompt','controller','loop','group','promptGroup','llm','output'\]\.includes\(node\.type\)[\s\S]*\{type:'generator', label:tr\('canvas\.apiGenerate'\), icon:'wand-sparkles'\}[\s\S]*\{type:'msgen', label:tr\('canvas\.modelscopeGenerate'\), icon:'cloud-lightning'\}[\s\S]*\{type:'comfy', label:tr\('canvas\.comfyGenerate'\), icon:'workflow'\}[\s\S]*\{type:'rh', label:tr\('canvas\.rhGenerate'\), icon:'workflow'\}[\s\S]*\{type:'ltxDirector', label:tr\('canvas\.ltxDirector'\), icon:'film'\}[\s\S]*\{type:'video', label:tr\('canvas\.videoGenerateNode'\), icon:'clapperboard'\}[\s\S]*\{type:'llm', label:'LLM', icon:'message-square-text'\}/,
  'controller output drag menu should offer downstream generation and LLM shortcuts'
);

console.log('canvas menu routing tests passed');
