import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync('static/index.html', 'utf8');
const desktop = readFileSync('desktop/Hstar.Desktop/MainWindow.xaml.cs', 'utf8');

assert.match(desktop, /DesktopStartPageId\s*=\s*"canvas"/);
assert.match(desktop, /window\.__HSTAR_START_PAGE__\s*=\s*\{serializedStartPageId\}/);
assert.match(index, /function resolveInitialPageId\(\)/);
assert.match(
  index,
  /PAGE_IDS\.includes\(desktopStartPageId\)[\s\S]*desktopStartPageId[\s\S]*localStorage\.getItem\(ACTIVE_PAGE_KEY\)/,
  'desktop startup hint must take precedence over the remembered page',
);
assert.match(index, /const id = resolveInitialPageId\(\)/);
assert.match(index, /id="frame-canvas"[^>]+data-src="\/static\/canvas-list\.html/);
