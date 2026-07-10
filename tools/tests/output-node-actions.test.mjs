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
assert.match(js,/async function saveOutputAsNativeFile\(/);
assert.doesNotMatch(js,/showSaveFilePicker/, 'output downloads should use Hstar native save dialog, not the browser save picker');
assert.match(js,/async function chooseAndOpenExternalApp\(/);
assert.match(js,/function showExternalAppFallback\(/);
assert.match(js,/function openOutputExternalMenu\(/);
assert.match(js,/downloadOutputNodeImages\(out\.id\)/);
assert.match(py,/class ExternalAppSaveRequest\(BaseModel\)/);
assert.match(py,/class ExternalImageOpenRequest\(BaseModel\)/);
assert.match(py,/class SaveOutputAsRequest\(BaseModel\)/);
assert.match(py,/@app\.post\("\/api\/open-external-image"\)/);
assert.match(py,/@app\.post\("\/api\/native\/save-output-as"\)/);
assert.match(py,/\$owner\.TopMost = \$true[\s\S]*\$owner\.BringToFront\(\)[\s\S]*\$dialog\.ShowDialog\(\$owner\)/, 'native save dialog should use a foreground topmost owner window');
assert.match(py,/@app\.post\("\/api\/native\/choose-executable"\)/);
assert.match(py,/@app\.get\("\/api\/output-download-folder"\)/);
assert.match(py,/FindWindow\(string lpClassName, string lpWindowName\)/, 'native save dialog centering should declare FindWindow');
assert.match(py,/GetWindowRect\(IntPtr hWnd, out HstarRect lpRect\)/, 'native save dialog centering should declare GetWindowRect');
assert.match(py,/SetWindowPos\(IntPtr hWnd, IntPtr hWndInsertAfter/, 'native save dialog centering should declare SetWindowPos');
assert.match(smartJs,/function downloadPreviewImage\(/, 'pure smart canvas should keep its original preview download helper');
assert.match(smartJs,/async function saveSmartOutputAsNativeFile\(/, 'smart canvas should include the fused native save helper');
assert.match(smartJs,/fetch\('\/api\/native\/save-output-as'/, 'smart canvas should call the native single-save endpoint');
assert.match(smartJs,/fetch\('\/api\/native\/save-output-batch'/, 'smart canvas should call the native batch-save endpoint');

console.log('output node actions migration checks passed');
