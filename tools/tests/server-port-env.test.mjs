import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const main = readFileSync('main.py', 'utf8');

assert.match(main, /def\s+resolve_server_port\(/, 'main.py should centralize server port resolution');
assert.match(main, /for\s+env_name\s+in\s+\("HSTAR_PORT",\s*"PORT"\)/, 'server port should honor HSTAR_PORT before PORT');
assert.match(main, /return\s+3000/, 'HstarB source default port should remain 3000');
assert.match(main, /def\s+resolve_server_host\(/, 'main.py should centralize packaged host resolution');
assert.match(main, /HSTAR_HOST/, 'packaged host resolution should honor HSTAR_HOST');
assert.match(main, /return\s*["']0\.0\.0\.0["']\s*if\s*EDITION\s*==\s*["']development["']\s*else\s*["']127\.0\.0\.1["']/, 'development may bind all interfaces while packaged editions default to loopback');
assert.match(main, /host=resolve_server_host\(\)/, 'Uvicorn should use the resolved server host');
assert.match(main, /port=resolve_server_port\(\)/, 'Uvicorn should use the resolved server port');
assert.match(main, /HSTAR_SHELL_TOKEN/, 'packaged requests should support shell-token authorization');
assert.match(main, /@app\.get\(["']\/api\/health["']\)/, 'the shell should have a backend readiness endpoint');

const runBat = readFileSync('run.bat', 'utf8');
assert.doesNotMatch(runBat, /HSTAR_PORT=5000/, 'development run.bat should not force installed-app port 5000');

const requirements = readFileSync('requirements.txt', 'utf8');
assert.match(requirements, /^websockets\b/m, 'server dependencies should include WebSocket protocol support for Uvicorn');

console.log('server port environment tests passed');
