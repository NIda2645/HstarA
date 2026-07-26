import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const main = readFileSync(resolve(root, 'main.py'), 'utf8');
const index = readFileSync(resolve(root, 'static/index.html'), 'utf8');

assert.match(main, /from hstar_runtime\.bootstrap import BootstrapStore/, 'backend must use the shared bootstrap store');
assert.match(main, /from hstar_runtime\.paths import [^\n]*build_runtime_paths/, 'backend must use the typed runtime path builder');
assert.match(main, /os\.environ\.get\("HSTAR_PROGRAM_DIR"\)/, 'backend must accept the packaged program root');
assert.match(main, /os\.environ\.get\("HSTAR_DATA_DIR"[^)]*\)/, 'backend must accept the selected data root');
assert.match(main, /os\.environ\.get\("HSTAR_EDITION"/, 'backend must isolate edition bootstrap state');
assert.doesNotMatch(main, /resolve_runtime_paths\(BASE_DIR,/, 'backend must not derive writable paths from the program directory');
assert.match(main, /LEGACY_API_ENV_FILE\s*=\s*os\.path\.join\(BASE_DIR,\s*"API",\s*"\.env"\)/, 'legacy API env may remain only as a migration source');
assert.match(main, /USER_WORKFLOW_DIR\s*=\s*str\(RUNTIME_PATHS\.user_workflow_dir\)/, 'user workflows must have a writable data-root directory');
assert.match(main, /class SoftwareStorageRequest\(BaseModel\):/, 'storage save request model must exist');
assert.match(main, /@app\.get\("\/api\/software-settings"\)/, 'software settings read endpoint must exist');
assert.match(main, /@app\.post\("\/api\/software-settings\/storage"\)/, 'software storage save endpoint must exist');
assert.match(main, /def migrate_runtime_data_to_storage\(/, 'storage migration helper must exist');
assert.match(main, /@app\.get\("\/api\/collaboration-link"\)/, 'collaboration link endpoint must exist');
assert.match(main, /@app\.post\("\/api\/collaboration-link\/refresh"\)/, 'collaboration link refresh endpoint must exist');
assert.match(main, /purpose\s*==\s*"storage"/, 'native choose-folder must support storage purpose without breaking output save purpose');

const launcher = readFileSync(resolve(root, 'run.bat'), 'utf8');
assert.match(launcher, /set "HSTAR_EDITION=development"/, 'engineering launcher must set the development edition');
assert.match(launcher, /set "HSTAR_DATA_DIR=%~dp0"/, 'engineering launcher must explicitly own its data root');
assert.match(launcher, /set "HSTAR_PROGRAM_DIR=%~dp0"/, 'engineering launcher must explicitly own its program root');
assert.match(launcher, /set "HSTAR_PORT=3000"/, 'engineering launcher must stay on port 3000');

assert.ok(existsSync(resolve(root, 'static/software-settings.html')), 'software settings page must exist');
assert.ok(existsSync(resolve(root, 'static/js/voice-settings-panel.js')), 'software settings must include the voice settings controller');
const settingsHtml = readFileSync(resolve(root, 'static/software-settings.html'), 'utf8');
assert.match(settingsHtml, /src="\/static\/js\/voice-settings-panel\.js\?v=[0-9.]+"/, 'software settings must load a versioned voice settings controller');
assert.match(index, /switchUI\(this, 'software-settings'\)/, 'sidebar must expose software settings entry');
assert.match(index, /id="frame-software-settings"/, 'stage must mount software settings iframe');
assert.match(index, /PAGE_IDS = \[[^\]]*'software-settings'/, 'software settings must be routable via PAGE_IDS');

console.log('software settings integration checks passed');
