import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync('main.py', 'utf8');

assert.match(main, /def\s+resolve_server_port\(/, 'main.py should centralize server port resolution');
assert.match(main, /for\s+env_name\s+in\s+\("HSTAR_PORT",\s*"PORT"\)/, 'server port should honor HSTAR_PORT before PORT');
assert.match(main, /return\s+3000/, 'HstarB source default port should remain 3000');
assert.match(main, /uvicorn\.run\(app,[\s\S]*port=resolve_server_port\(\)/, 'uvicorn should use the resolved server port');

const runBat = readFileSync('run.bat', 'utf8');
assert.doesNotMatch(runBat, /HSTAR_PORT=5000/, 'development run.bat should not force installed-app port 5000');

console.log('server port environment tests passed');
