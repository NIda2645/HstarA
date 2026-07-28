import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const main = readFileSync(resolve(root, 'main.py'), 'utf8');
const index = readFileSync(resolve(root, 'static/index.html'), 'utf8');
const settings = readFileSync(resolve(root, 'static/software-settings.html'), 'utf8');

assert.match(main, /DEFAULT_APP_DATA_ROOT\s*=\s*os\.path\.join\(os\.environ\.get\("APPDATA"\)\s+or\s+BASE_DIR,\s*"Hstar"\)/, 'software settings must keep app data outside install dir by default');
assert.match(main, /def runtime_paths_for_storage_root\(/, 'software settings must define runtime path resolver');
assert.match(main, /RUNTIME_PATHS\s*=\s*resolve_runtime_paths\(APP_DATA_ROOT,\s*APP_SOFTWARE_SETTINGS_FILE\)/, 'desktop HSTAR_DATA_DIR is the default runtime root');
assert.match(main, /class SoftwareStorageRequest\(BaseModel\):/, 'storage save request model must exist');
assert.match(main, /@app\.get\("\/api\/software-settings"\)/, 'software settings read endpoint must exist');
assert.match(main, /@app\.post\("\/api\/software-settings\/storage"\)/, 'software storage save endpoint must exist');
const storageEndpoint = main.match(/@app\.post\("\/api\/software-settings\/storage"\)([\s\S]*?)(?=\n@app\.)/)?.[1] ?? '';
assert.doesNotMatch(storageEndpoint, /migrate_runtime_data_to_storage\(/, 'changing storage must not migrate data');
assert.match(storageEndpoint, /restart_required/, 'storage response tells the shell whether restart is required');
assert.match(main, /@app\.get\("\/api\/collaboration-link"\)/, 'collaboration link endpoint must exist');
assert.match(main, /@app\.post\("\/api\/collaboration-link\/refresh"\)/, 'collaboration link refresh endpoint must exist');
assert.match(main, /purpose\s*==\s*"storage"/, 'native choose-folder must support storage purpose without breaking output save purpose');

const browseHandler = settings.match(/browseBtn\.onclick\s*=\s*async\s*\(\)\s*=>\s*\{([\s\S]*?)\n\s*\};/)?.[1] ?? '';
assert.doesNotMatch(browseHandler, /saveStorageRoot\(/, 'folder browsing only fills the pending path');
assert.doesNotMatch(settings, /正在迁移|已迁移并保存/, 'storage settings must not claim to migrate data');
assert.match(settings, /<dialog[^>]+id="storageRestartDialog"/, 'saving storage uses an explicit restart confirmation');
assert.match(settings, /await\s+confirmStorageRestart\(/, 'save waits for restart confirmation before persisting');
assert.match(settings, /storageInput\.value\s*=\s*activeStorageRoot/, 'cancel restores the active storage root');
assert.match(settings, /type:\s*['"]hstar-restart-with-data-root['"]/, 'confirmed storage change requests desktop restart');

assert.ok(existsSync(resolve(root, 'static/software-settings.html')), 'software settings page must exist');
assert.match(index, /switchUI\(this, 'software-settings'\)/, 'sidebar must expose software settings entry');
assert.match(index, /id="frame-software-settings"/, 'stage must mount software settings iframe');
assert.match(index, /PAGE_IDS = \[[^\]]*'software-settings'/, 'software settings must be routable via PAGE_IDS');

console.log('software settings integration checks passed');
