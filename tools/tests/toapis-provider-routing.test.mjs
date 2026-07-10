import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const py = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');
const apiSettings = readFileSync(new URL('../../static/js/api-settings.js', import.meta.url), 'utf8');
const apiHtml = readFileSync(new URL('../../static/api-settings.html', import.meta.url), 'utf8');

assert.match(py, /SUPPORTED_PROVIDER_PROTOCOLS = \{[^}]*"toapis"/, 'backend should register the ToAPIs protocol');
assert.match(py, /def is_toapis_provider\(provider\):[\s\S]*protocol == "toapis"[\s\S]*"toapis\.com" in base_url/, 'ToAPIs should be recognized by protocol or documented base URL');
assert.match(py, /if is_toapis_provider\(provider\):\s*\n\s*return await generate_toapis_provider_image\(prompt, size, model, reference_images, provider\)/, 'global image generation should route ToAPIs through the dedicated adapter');
assert.match(py, /client\.post\(f"\{base_url\}\/v1\/images\/generations"[\s\S]*"resolution": resolution/, 'ToAPIs image generation should send documented size and resolution fields');
assert.match(py, /task_url = f"\{toapis_base_url\(provider\)\}\/v1\/images\/generations\/\{task_id\}"[\s\S]*client\.get\(task_url/, 'ToAPIs polling should query /v1/images/generations/{task_id}');
assert.match(py, /TOAPIS_4K_ASPECTS = \{[^}]*"16:9"[^}]*"9:16"[^}]*"21:9"/, 'ToAPIs 4K should be constrained to documented 4K aspect ratios');
assert.match(py, /def toapis_model_for_request\(model\):\s*\n\s*name = str\(model or ""\)\.strip\(\)[\s\S]*return name or "gpt-image-2"/, 'ToAPIs should preserve the user-selected image model, including gpt-image-2-high');
assert.match(py, /if provider_id == "toapis" or "toapis\.com" in base_url:[\s\S]*return "toapis"/, 'API validation should auto-detect ToAPIs base URLs');
assert.match(apiSettings, /'toapis'/, 'API settings protocol list should include ToAPIs');
assert.match(apiSettings, /toapis\.com[\s\S]*return 'toapis'/, 'API settings should detect ToAPIs documented base URLs');
assert.match(apiSettings, /function applyDetectedProtocolFromUrl\(\)[\s\S]*protocolInput\.value = detected[\s\S]*item\.protocol = detected/, 'API settings should apply detected protocols through a controlled path');
assert.match(apiHtml, /<option value="toapis">ToAPIs协议<\/option>/, 'protocol dropdown should show ToAPIs protocol');

console.log('ToAPIs provider routing tests passed');
