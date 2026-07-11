import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('static/index.html', 'utf8');
const common = readFileSync('static/js/i18n/common.js', 'utf8');
const i18n = readFileSync('static/js/i18n.js', 'utf8');
const apiSettings = readFileSync('static/js/api-settings.js', 'utf8');
const apiSettingsCss = readFileSync('static/css/api-settings.css', 'utf8');

assert.match(html, /<svg class="sidebar-logo-svg"[\s\S]*id="sidebar-logo-globe-gradient"[\s\S]*id="sidebar-logo-dot-map"/, 'sidebar should embed the HstarD logo SVG internally');
assert.doesNotMatch(html, /id="logo-dot"/, 'sidebar logo should not be the old dot placeholder');
assert.match(html, /<span class="side-pill-text">(?:更多设置|&#26356;&#22810;&#35774;&#32622;)<\/span>/, 'more settings should render stable Chinese text directly');
assert.doesNotMatch(html, /data-i18n="common\.moreSettings"/, 'more settings should not leak the i18n key when cached bundles are stale');
assert.match(common, /"common\.moreSettings"\s*:\s*\{\s*zh:\s*"更多设置"/, 'common.moreSettings must register Chinese text');
assert.match(common, /"common\.comfyuiSettings"\s*:\s*\{\s*zh:\s*"工作流设置"/, 'common.comfyuiSettings must register Chinese text');
assert.match(i18n, /VERSION = '2026\.07\.8\.1783745035'/, 'i18n cache version should be bumped after shell label fixes');
assert.match(apiSettings, /const VOLCENGINE_LOGO_SVG = `[\s\S]*volcengine-inline-brand[\s\S]*火山引擎[\s\S]*<svg/, 'Volcengine provider card should embed its HstarA logo and text inline');
assert.doesNotMatch(apiSettings, /volcengine-theme-(?:light|dark)\.svg/, 'Volcengine provider card should not depend on external SVG image files that can render as broken images');
assert.match(apiSettingsCss, /\.provider-card-banner \.volcengine-inline-brand\s*\{[\s\S]*height:24px[\s\S]*max-width:142px[\s\S]*font-size:16px[\s\S]*white-space:nowrap[\s\S]*\}/, 'Volcengine provider card should constrain the inline brand text like HstarB');
assert.match(apiSettingsCss, /\.provider-card-banner \.volcengine-inline-brand svg\s*\{[\s\S]*width:20px[\s\S]*height:20px[\s\S]*flex:0 0 auto[\s\S]*display:block[\s\S]*\}/, 'Volcengine provider card should constrain the embedded SVG icon like HstarB');

console.log('shell branding and settings i18n checks passed');


