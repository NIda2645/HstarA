import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

const root = resolve(process.cwd());
const main = readFileSync(resolve(root, 'main.py'), 'utf8');
const index = readFileSync(resolve(root, 'static/index.html'), 'utf8');

assert.match(main, /DEFAULT_APP_DATA_ROOT\s*=\s*os\.path\.join\(os\.environ\.get\("APPDATA"\)\s+or\s+BASE_DIR,\s*"Hstar"\)/, 'software settings must keep app data outside install dir by default');
assert.match(main, /def runtime_paths_for_storage_root\(/, 'software settings must define runtime path resolver');
assert.match(main, /class SoftwareStorageRequest\(BaseModel\):/, 'storage save request model must exist');
assert.match(main, /@app\.get\("\/api\/software-settings"\)/, 'software settings read endpoint must exist');
assert.match(main, /@app\.post\("\/api\/software-settings\/storage"\)/, 'software storage save endpoint must exist');
assert.match(main, /def migrate_runtime_data_to_storage\(/, 'storage migration helper must exist');
assert.match(main, /@app\.get\("\/api\/collaboration-link"\)/, 'collaboration link endpoint must exist');
assert.match(main, /@app\.post\("\/api\/collaboration-link\/refresh"\)/, 'collaboration link refresh endpoint must exist');
assert.match(main, /purpose\s*==\s*"storage"/, 'native choose-folder must support storage purpose without breaking output save purpose');

assert.ok(existsSync(resolve(root, 'static/software-settings.html')), 'software settings page must exist');
assert.match(index, /switchUI\(this, 'software-settings'\)/, 'sidebar must expose software settings entry');
assert.match(index, /id="frame-software-settings"/, 'stage must mount software settings iframe');
assert.match(index, /PAGE_IDS = \[[^\]]*'software-settings'/, 'software settings must be routable via PAGE_IDS');

console.log('software settings integration checks passed');