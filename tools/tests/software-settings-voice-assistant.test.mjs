import assert from 'node:assert/strict';
import {existsSync, readFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(process.cwd());
const htmlPath = resolve(root, 'static/software-settings.html');
const scriptPath = resolve(root, 'static/js/voice-settings-panel.js');

assert.ok(existsSync(htmlPath), 'software settings page exists');
assert.ok(existsSync(scriptPath), 'voice settings controller exists');

const html = readFileSync(htmlPath, 'utf8');
const js = readFileSync(scriptPath, 'utf8');

assert.match(html, /id="voiceAssistantCard"/, 'settings exposes voice assistant card');
assert.match(html, /id="voiceStorageMode"/, 'settings exposes inherit/custom storage mode');
assert.match(html, /id="voiceStorageInput"[^>]*data-voice-input="off"/, 'voice data path is not a dictation target');
assert.match(html, /id="voiceDownloadBtn"/, 'settings exposes download action');
assert.match(html, /id="voiceDetectBtn"/, 'settings exposes existing-model detection');
assert.match(html, /id="voiceRepairBtn"/, 'settings exposes runtime repair');
assert.match(html, /id="voiceMigrateBtn"/, 'settings exposes storage migration');
assert.match(html, /id="voiceUpdateBtn"/, 'settings exposes model update');
assert.match(html, /id="voiceUninstallBtn"/, 'settings exposes uninstall');
assert.match(html, /id="voiceCancelBtn"/, 'settings exposes active-task cancellation');
assert.match(html, /id="voiceProgress"[^>]*role="progressbar"/, 'download progress is accessible');
assert.match(html, /id="voiceShortcut"[^>]*data-voice-input="off"/, 'shortcut capture is excluded from voice input');
assert.match(html, /id="voiceConfirmDialog"/, 'destructive operations use an in-app dialog');
assert.match(html, /id="voiceConfirmPath"/, 'confirmation shows the affected path');
assert.match(html, /id="voiceConfirmOwnership"/, 'confirmation shows model ownership');
assert.match(html, /src="\/static\/js\/voice-settings-panel\.js\?v=[0-9.]+"/, 'settings loads the versioned voice controller');

assert.match(js, /\/api\/voice-assistant\/status/, 'panel reads authoritative status');
assert.match(js, /\/api\/voice-assistant\/choose-folder/, 'panel uses the voice folder picker');
assert.match(js, /\/api\/voice-assistant\/detect-model/, 'panel detects existing models');
assert.match(js, /\/api\/voice-assistant\/install/, 'panel installs the optional runtime and model');
assert.match(js, /\/api\/voice-assistant\/install\/cancel/, 'panel cancels active installs');
assert.match(js, /\/api\/voice-assistant\/repair/, 'panel repairs the optional runtime');
assert.match(js, /\/api\/voice-assistant\/migrate/, 'panel migrates managed voice data');
assert.match(js, /\/api\/voice-assistant\/uninstall/, 'panel uninstalls managed voice data');
assert.match(js, /750/, 'active task polling uses the planned 750ms interval');
assert.match(js, /Shift\+Q/, 'panel exposes approved default shortcut');
assert.match(js, /removeAttribute\(['"]aria-valuenow['"]\)/, 'unknown totals stay indeterminate');
assert.doesNotMatch(js, /total_bytes\s*\|\|\s*100/, 'unknown totals never invent a percentage');
assert.doesNotMatch(html, /type="password"[^>]*data-voice-input="on"/, 'secrets never opt into voice');

console.log('software settings voice assistant checks passed');
