import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const html = readFileSync(new URL('../../static/smart-canvas.html', import.meta.url), 'utf8');
const css = readFileSync(new URL('../../static/css/smart-canvas.css', import.meta.url), 'utf8');

for (const type of ['image', 'group', 'prompt', 'loop', 'controller']) {
  assert.match(html, new RegExp(`data-create-type="${type}"`), `smart canvas should keep ${type} create card`);
}

assert.match(html, /id="controllerPanel"\s+class="controller-panel"/, 'smart canvas should include floating controller panel container');
assert.match(js, /const controllerPanel = document\.getElementById\('controllerPanel'\)/, 'smart controller panel host should be wired');

for (const name of [
  'defaultControllerState',
  'ensureControllerState',
  'controllerPrompt',
  'smartControllerPrompt',
  'smartControllerGraph',
  'smartControllerDirectivesForNodeInput',
  'createControllerNode',
  'smartControllerBodyHtml',
  'openControllerPanelForNode',
  'renderControllerPanel',
  'bindControllerPanel',
  'bindSmartControllerNodeControls',
  'bindAngleCubeDrag'
]) {
  assert.match(js, new RegExp(`function ${name}\\(`), `smart controller should define ${name}`);
}

assert.match(js, /const CONTROLLER_TABS = \['camera', 'angle', 'lighting', 'material'\]/, 'smart controller should keep four HstarB controller tabs');
assert.match(js, /type:'smart-controller'[\s\S]*w:290[\s\S]*h:218/, 'new smart controller nodes should use the compact smart-controller node shape');
assert.match(js, /if\(node\?\.type === 'smart-controller'\)[\s\S]*width:Math\.round\(Number\(node\.w\) \|\| 290\)[\s\S]*height:Math\.round\(Math\.min\(Number\(node\.h\) \|\| 218, 218\)\)/, 'smart controller layout should clamp the default node height to avoid extra blank space');
assert.match(js, /if\(type === 'controller'\)|else if\(type === 'controller'\)/, 'create menu should route controller cards');
assert.match(js, /created = createControllerNode\(p\.x - 150, p\.y - 113\)/, 'create menu should create smart controller nodes');
assert.match(js, /node\.type === 'smart-controller' \? '.*?'/, 'render should title smart controller nodes');
assert.match(js, /isController \? 'controller-node smart-controller-node' : ''/, 'render should attach smart controller node classes');
assert.match(js, /if\(nodeForControls\?\.type === 'smart-controller'\) bindSmartControllerNodeControls/, 'smart controller node controls should be bound');
assert.match(js, /if\(to\.type === 'smart-controller'\) return false/, 'smart controller should not accept input links');
assert.match(js, /if\(from\.type === 'smart-controller'\)[\s\S]*addConnection\(from\.id, to\.id, 'input'\)/, 'smart controller should feed downstream nodes as input directives');
assert.match(js, /if\(node\.type === 'smart-controller'\) return smartControllerPrompt\(node\)/, 'smart controller text should resolve to controller directives');
assert.match(js, /input\?\.type === 'smart-controller'/, 'smart controller should be accepted as prompt input');
assert.match(js, /smartControllerDirectivesForNodeInput\(node, smartControllerGraph\(\)\)/, 'build prompt should inject upstream smart controller directives');
assert.match(js, /if\(controllerPanel\?\.classList\.contains\('open'\)/, 'outside click should close the smart controller panel');
assert.match(js, /node\.type === 'smart-controller' \? 260 : 48/, 'resize should use smart controller minimum width');
assert.match(js, /function controllerWheelDirection\(/, 'smart controller panel should centralize wheel direction mapping');
assert.match(js, /return Number\(event\?\.deltaY \|\| 0\) > 0 \? 1 : -1;/, 'smart controller wheel direction should map scroll down to the next option');
assert.match(js, /const CONTROLLER_WHEEL_CYCLE_ZONES = new Set\(\[[\s\S]*'body'[\s\S]*'category'[\s\S]*'focal'[\s\S]*'vibe'[\s\S]*'shot'[\s\S]*'aperture'[\s\S]*'motion'[\s\S]*'angle-preset'[\s\S]*'subject-group'[\s\S]*'light-type'[\s\S]*'light-direction'[\s\S]*\]\);/, 'smart controller wheel cycling should be limited to camera, angle, and lighting zones');
assert.doesNotMatch(js, /CONTROLLER_WHEEL_CYCLE_ZONES[\s\S]*'material-/, 'smart material controller zones must not participate in wheel option cycling');
assert.match(js, /controllerPanel\.onwheel = e => \{/, 'smart controller panel wheel handler should be overwritten on render instead of accumulating listeners');
assert.doesNotMatch(js, /controllerPanel\.addEventListener\('wheel'/, 'smart controller panel should not add stacked wheel listeners on every render');

for (const cls of [
  'smart-controller-node',
  'controller-panel.open',
  'controller-panel.collapsed',
  'controller-panel-tabs',
  'camera-stage',
  'angle-cube-stage',
  'light-3d-stage',
  'material-hsl-panel',
  'material-detail-form'
]) {
  assert.match(css, new RegExp(`\\.${cls.replace('.', '\\.')}`), `smart controller CSS should include ${cls}`);
}

assert.match(css, /\.image-node\.smart-controller-node\.controller-node\s*\{[\s\S]*width:290px !important[\s\S]*max-width:290px !important[\s\S]*min-width:290px !important/, 'smart controller node should lock to the HstarB compact width after generic controller CSS');
assert.match(css, /\.image-node\.smart-controller-node\.controller-node\s*\{[\s\S]*height:218px !important[\s\S]*min-height:218px !important[\s\S]*max-height:218px !important/, 'smart controller node should keep a compact height without blank space under the summary');
assert.match(css, /\.image-node\.smart-controller-node\.controller-node \.floating-node-actions\s*\{[\s\S]*right:12px !important[\s\S]*top:12px !important/, 'smart controller delete action should sit inside the compact panel next to the floating panel button');
assert.match(css, /\.image-node\.smart-controller-node\.controller-node \.controller-tabs > \.controller-tab\s*\{[\s\S]*height:46px !important[\s\S]*grid-template-columns:minmax\(0, 1fr\) 40px !important/, 'smart controller tab cards should keep the compact HstarB switch layout');
assert.match(css, /\.image-node\.smart-controller-node\.controller-node\s*\{[\s\S]*background:var\(--panel\) !important[\s\S]*border:1px solid var\(--line\) !important[\s\S]*box-shadow:0 20px 56px var\(--shadow\) !important/, 'smart controller node should use the same visible panel card surface as canvas nodes');
assert.match(css, /\.image-node\.smart-controller-node\.controller-node \.controller-tabs > \.controller-tab\s*\{[\s\S]*background:var\(--card\) !important[\s\S]*border:1px solid var\(--line\) !important[\s\S]*box-shadow:0 8px 22px rgba\(15,23,42,\.08\) !important/, 'smart controller switch cards should stay visually separated from the node background');
assert.match(css, /\.ctrl-slider\.temperature-slider \.ctrl-slider-fill\s*\{[^}]*linear-gradient\(90deg,\s*#ff8a3d 0%,\s*#ffd08a 34%,\s*#fff3cf 50%,\s*#d7ecff 72%,\s*#8fbfff 100%\)[^}]*clip-path:inset\(0 calc\(100% - var\(--slider-fill,\s*0%\)\) 0 0\)/s, 'smart temperature slider fill should show a warm-to-cool gradient clipped by the real Kelvin position');
assert.match(js, /style="--slider-fill:\$\{\(fill\*100\)\.toFixed\(2\)\}%;"/, 'smart controller slider should expose the initial fill percentage as a CSS variable');
assert.match(js, /slider\.style\.setProperty\('--slider-fill',\s*\(fill\*100\)\.toFixed\(2\)\s*\+\s*'%'\);/, 'smart controller slider should keep the fill CSS variable synced while dragging');

assert.doesNotMatch(`${html}\n${js}\n${css}`, /�|\?{3,}/, 'smart controller files should not contain replacement characters or placeholder question marks');

assert.match(css, /\.image-node\.smart-controller-node\.controller-node \.controller-node-summary\s*\{[\s\S]*padding-right:34px !important/, 'smart controller floating panel button should leave right-side room for the external delete action');

console.log('smart controller integration tests passed');
