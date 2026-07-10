import assert from 'node:assert/strict';
import fs from 'node:fs';

const settingsHtml = fs.readFileSync('static/software-settings.html', 'utf8');

assert.match(settingsHtml, /undo\s*:\s*\{\s*label\s*:\s*['"]撤销['"]\s*,\s*accelerator\s*:\s*['"]Ctrl\+Z['"]\s*\}/u, 'software settings should expose undo as Ctrl+Z');
assert.match(settingsHtml, /redo\s*:\s*\{\s*label\s*:\s*['"]重做['"]\s*,\s*accelerator\s*:\s*['"]Ctrl\+Shift\+Z['"]\s*\}/u, 'software settings should expose redo as Ctrl+Shift+Z');
assert.doesNotMatch(settingsHtml, /delete next\.undo/u, 'software settings should keep the undo shortcut instead of filtering it out');
assert.match(settingsHtml, /api\.saveShortcuts\(sanitizeShortcuts\(shortcutState\)\)/u, 'software settings should save sanitized shortcuts through the desktop API');
assert.match(settingsHtml, /function persistShortcutsLocal\(shortcuts\)[\s\S]*localStorage\.setItem\(SHORTCUT_STORAGE_KEY, JSON\.stringify\(sanitizeShortcuts\(shortcuts\)\)\)/u, 'software settings should mirror saved shortcuts to same-origin storage for canvas pages');
assert.match(settingsHtml, /renderShortcuts\(await api\.saveShortcuts\(sanitizeShortcuts\(shortcutState\)\)\);[\s\S]*persistShortcutsLocal\(shortcutState\)/u, 'desktop shortcut saves should still update canvas-visible local storage');

console.log('Software shortcut settings tests passed');
