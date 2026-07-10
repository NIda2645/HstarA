import assert from 'node:assert/strict';
import fs from 'node:fs';

const py = fs.readFileSync('main.py', 'utf8');
const apiSettings = fs.readFileSync('static/js/api-settings.js', 'utf8');
const apiHtml = fs.readFileSync('static/api-settings.html', 'utf8');

assert.match(py, /SUPPORTED_PROVIDER_PROTOCOLS = \{[^}]*"moonly"/, 'backend should register the MoonlyAI protocol');
assert.doesNotMatch(py, /MOONLY_IMAGE_MODELS\s*=\s*\[[\s\S]*?\]/, 'MoonlyAI should not inject built-in models; users should fetch and choose upstream models');
assert.match(py, /def is_moonly_provider\(provider\):[\s\S]*protocol == "moonly"[\s\S]*"relay\.moonlyai\.com" in base_url/, 'MoonlyAI should be recognized by protocol or documented base URL');
assert.match(py, /if provider_id == "moonly" or "relay\.moonlyai\.com" in base_url:[\s\S]*return "moonly"/, 'API validation should auto-detect MoonlyAI base URLs');
assert.match(py, /if is_moonly_provider\(provider\):\s*\n\s*return await generate_moonly_provider_image\(prompt, size, model, reference_images, provider, quality=quality\)/, 'MoonlyAI routing should pass the canvas quality setting into the provider adapter');
assert.match(py, /async def generate_moonly_provider_image\(prompt, size, model, reference_images=None, provider=None, quality=""\):/, 'MoonlyAI adapter should accept the canvas quality setting');
assert.match(py, /client\.post\(f"\{moonly_base_url\(provider\)\}\/v1\/images\/generations"[\s\S]*"resolution": resolution/, 'MoonlyAI generation should send documented size and resolution fields');
assert.match(py, /quality_value = str\(quality or ""\)\.strip\(\)\.lower\(\)[\s\S]*body\["quality"\] = quality_value/, 'MoonlyAI generation should send the user-selected quality when it is low/medium/high');
assert.match(py, /task_url = f"\{moonly_base_url\(provider\)\}\/v1\/images\/generations\/\{task_id\}"[\s\S]*client\.get\(task_url/, 'MoonlyAI polling should query /v1/images/generations/{task_id}');
assert.match(py, /def image_task_url_for_provider\(provider, task_id\):[\s\S]*if is_moonly_provider\(provider\):[\s\S]*\/v1\/images\/generations\/\{task_id\}/, 'MoonlyAI task queries should use /v1/images/generations/{task_id} instead of the generic /v1/images/tasks path');
assert.match(py, /httpx\.AsyncClient\(timeout=timeout, follow_redirects=True, trust_env=not is_moonly_provider\(provider\)\)/, 'MoonlyAI task queries should bypass system proxy settings');
assert.match(py, /httpx\.AsyncClient\(timeout=timeout, trust_env=False\)/, 'MoonlyAI generation and polling should bypass system proxy settings so local proxies cannot synthesize 429 responses');
assert.doesNotMatch(py, /async def wait_for_moonly_image_task[\s\S]*\/v1\/images\/tasks/, 'MoonlyAI adapter must not use the generic /v1/images/tasks polling path');
assert.doesNotMatch(py, /if protocol == "moonly":[\s\S]{0,500}moonly_default_model_payload/, 'MoonlyAI validation/fetch should not short-circuit to built-in models');
assert.match(apiSettings, /'moonly'/, 'API settings protocol list should include MoonlyAI');
assert.match(apiSettings, /relay\.moonlyai\.com[\s\S]*return 'moonly'/, 'API settings should detect MoonlyAI documented base URLs');
assert.match(apiSettings, /function applyDetectedProtocolFromUrl\(\)[\s\S]*protocolInput\.value = detected[\s\S]*item\.protocol = detected/, 'API settings should apply detected protocols through a controlled path');
assert.match(apiHtml, /<option value="moonly">MoonlyAI协议<\/option>/, 'protocol dropdown should show MoonlyAI protocol');

console.log('MoonlyAI provider routing tests passed');
