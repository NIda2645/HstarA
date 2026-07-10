import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const backend = readFileSync('main.py', 'utf8');

const source = readFileSync('static/js/api-settings.js', 'utf8');
const detectStart = source.indexOf('function detectProviderProtocolFromUrl');
const detectEnd = source.indexOf('function applyDetectedProtocolFromUrl', detectStart);
assert.ok(detectStart >= 0 && detectEnd > detectStart, 'detectProviderProtocolFromUrl block should be extractable');
const detectBlock = source.slice(detectStart, detectEnd);

assert.doesNotMatch(
  detectBlock,
  /protocolInput\.value\s*=/,
  'URL protocol detection must be pure; it may suggest LinAPI/OtuAPI/etc but must not overwrite a user-selected protocol'
);

assert.match(
  source,
  /function shouldAutoDetectProviderProtocol\(item\)/,
  'API settings should centralize when URL-based protocol suggestions are allowed'
);

assert.match(
  source,
  /protocol_manual:item\.protocol_manual === true/,
  'saving providers should persist that the user manually overrode URL-based protocol detection'
);

assert.match(
  backend,
  /class ApiProviderPayload\(BaseModel\):[\s\S]*protocol_manual: bool = False/,
  'backend provider payload should accept protocol_manual so manual protocol choices survive reloads'
);

assert.match(
  backend,
  /protocol_manual = bool\(item\.get\("protocol_manual", False\)\)[\s\S]*"protocol_manual": protocol_manual/,
  'provider normalization should preserve protocol_manual in stored and public provider records'
);

assert.match(
  backend,
  /def inferred_provider_protocol_from_base_url\(base_url\):[\s\S]*bananarouter\.com[\s\S]*return "bananarouter"/,
  'backend should infer dedicated protocol names from known upstream base URLs'
);

assert.match(
  backend,
  /if not protocol_manual and protocol in \{"", "openai"\}:[\s\S]*inferred_protocol = inferred_provider_protocol_from_base_url\(base_url\)[\s\S]*protocol = inferred_protocol/,
  'provider normalization should auto-upgrade non-manual OpenAI records to their dedicated URL protocol'
);

console.log('API settings protocol override tests passed');
