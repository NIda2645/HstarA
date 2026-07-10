import assert from 'node:assert/strict';
import fs from 'node:fs';

const py = fs.readFileSync('main.py', 'utf8');
const apiSettings = fs.readFileSync('static/js/api-settings.js', 'utf8');
const apiHtml = fs.readFileSync('static/api-settings.html', 'utf8');

const protocolStart = py.indexOf('def protocol_from_payload(payload):');
const protocolEnd = py.indexOf('def api_key_from_payload', protocolStart);
assert.notEqual(protocolStart, -1, 'backend should define protocol_from_payload');
assert.notEqual(protocolEnd, -1, 'backend should define api_key_from_payload after protocol_from_payload');
const protocolBody = py.slice(protocolStart, protocolEnd);

const baseAssignment = protocolBody.indexOf('base_url = str(getattr(payload, "base_url"');
const firstBaseUse = protocolBody.indexOf(' in base_url');
assert(baseAssignment !== -1, 'protocol_from_payload should normalize base_url');
assert(firstBaseUse !== -1, 'protocol_from_payload should inspect provider base URLs');
assert(baseAssignment < firstBaseUse, 'protocol_from_payload must define base_url before any provider URL checks');

for (const protocol of ['linapi', 'otuapi', 'grsai', 'toapis', 'baofu', 'bananarouter', 'moonly']) {
  assert.match(protocolBody, new RegExp(`return "${protocol}"`), `protocol_from_payload should keep ${protocol} auto-detection`);
}
assert.match(protocolBody, /runninghub\.cn[\s\S]*return "runninghub"/, 'protocol_from_payload should keep RunningHub URL auto-detection');

assert.match(apiSettings, /async function readApiJsonResponse\(/, 'API settings should parse JSON, text, and HTML errors through one safe helper');
assert.match(apiSettings, /fetch\('\/api\/providers\/fetch-models'[\s\S]*readApiJsonResponse\(r,[\s\S]*api\.urlInvalid[\s\S]*拉取失败/, 'fetchModels should use safe response parsing');
assert.match(apiSettings, /fetch\('\/api\/providers\/test-connection'[\s\S]*readApiJsonResponse\(r,[\s\S]*验证失败/, 'provider test should use safe response parsing');
assert.doesNotMatch(apiSettings, /fetch\('\/api\/providers\/fetch-models'[\s\S]{0,800}await r\.json\(\)\)\.detail/, 'fetchModels should not parse error HTML with r.json()');

assert.match(apiSettings, /let lastFetchedModelProtocols = \{\};/, 'API settings should keep fetched model protocol hints from HstarB');
assert.match(apiSettings, /function syncFetchedModelProtocols\(data\)/, 'API settings should sync fetched model protocols');
assert.match(apiSettings, /function implicitModelProtocol\(item, model\)/, 'API settings should infer per-model protocols');
assert.match(apiSettings, /applyImplicitModelProtocols\(item, image\)/, 'model picker should apply inferred protocols when importing image models');
assert.match(apiSettings, /const CLI_PROVIDER_PRESETS = \{[\s\S]*codex[\s\S]*gemini-cli/, 'latest clean CLI provider presets should be preserved');
assert.match(apiHtml, /OpenAI CLI 账户[\s\S]*Antigravity CLI 账户/, 'latest clean CLI settings panels should be preserved');

console.log('API settings provider fusion tests passed');
