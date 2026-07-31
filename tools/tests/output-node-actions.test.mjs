import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const html = readFileSync('static/canvas.html','utf8');
const js = readFileSync('static/js/canvas.js','utf8');
const smartJs = readFileSync('static/js/smart-canvas.js','utf8');
const css = readFileSync('static/css/canvas.css','utf8');
const py = readFileSync('main.py','utf8');

assert.match(html,/id="outputExternalMenu"/);
assert.match(html,/id="externalAppFallback"/);
assert.match(html,/id="outputDownloadAllBtn"/);
assert.match(css,/\.output-external-menu/);
assert.match(css,/\.external-app-fallback/);
assert.match(js,/function saveOutputAsNativeFile\(/);
assert.doesNotMatch(js,/showSaveFilePicker/, 'output downloads should use Hstar native save dialog, not the browser save picker');
assert.doesNotMatch(js,/fetch\('\/api\/native\/save-output-as'/, 'classic downloads must enter the desktop download channel');
assert.match(js,/async function chooseAndOpenExternalApp\(/);
assert.match(js,/function showExternalAppFallback\(/);
assert.match(js,/function openOutputExternalMenu\(/);
assert.match(js,/downloadOutputNodeImages\(out\.id\)/);
assert.match(py,/class ExternalAppSaveRequest\(BaseModel\)/);
assert.match(py,/class ExternalImageOpenRequest\(BaseModel\)/);
assert.doesNotMatch(py,/\/api\/native\/save-output-(?:as|batch)/, 'backend must not retain the legacy PowerShell save-dialog route');
assert.match(py,/@app\.post\("\/api\/open-external-image"\)/);
assert.match(py,/@app\.post\("\/api\/native\/choose-executable"\)/);
assert.match(smartJs,/function downloadPreviewImage\(/, 'pure smart canvas should keep its original preview download helper');
assert.match(smartJs,/function saveSmartOutputAsNativeFile\(/, 'smart canvas should include the unified download helper');
assert.doesNotMatch(smartJs,/\/api\/native\/save-output-(?:as|batch)/, 'smart downloads must enter the desktop download channel');

console.log('output node actions migration checks passed');
