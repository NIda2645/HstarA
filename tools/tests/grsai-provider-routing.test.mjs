import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const py = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');
const apiSettings = readFileSync(new URL('../../static/js/api-settings.js', import.meta.url), 'utf8');
const apiHtml = readFileSync(new URL('../../static/api-settings.html', import.meta.url), 'utf8');

assert.match(py, /SUPPORTED_PROVIDER_PROTOCOLS = \{[^}]*"grsai"/, 'backend should register the Grsai protocol');
assert.match(py, /GRSAI_IMAGE_MODELS = \[[\s\S]*"nano-banana-pro-4k-vip"[\s\S]*"gpt-image-2-vip"/, 'Grsai built-in models should include 4K nano-banana and GPT image VIP models');
assert.match(py, /def is_grsai_provider\(provider\):[\s\S]*"grsai\.dakka\.com\.cn" in base_url[\s\S]*"grsaiapi\.com" in base_url/, 'Grsai providers should be recognized by documented base URLs');
assert.match(py, /if provider_id == "grsai" or "grsai\.dakka\.com\.cn" in base_url or "grsaiapi\.com" in base_url:[\s\S]*return "grsai"/, 'Grsai base URLs should auto-detect to the Grsai protocol');
assert.match(py, /client\.post\(f"\{grsai_base_url\(provider\)\}\/v1\/api\/generate"/, 'Grsai image generation should submit to /v1/api/generate');
assert.match(py, /client\.get\(result_url,[\s\S]*params=\{"id": task_id\}/, 'Grsai async result polling should query /v1/api/result?id=...');
assert.match(py, /def grsai_task_id\(raw\):[\s\S]*for key in \("id", "task_id", "taskId"\):[\s\S]*return str\(value\)/, 'Grsai should accept documented task ids such as 15-uuid, not only task-prefixed ids');
assert.match(py, /task_id = grsai_task_id\(raw\)/, 'Grsai generation should use the Grsai-specific task id extractor before polling');
assert.match(py, /body\["imageSize"\] = grsai_resolution_from_size\(size\)/, 'Grsai nano-banana requests should send imageSize for 2K/4K control');
assert.match(py, /def grsai_model_for_size\(model, size\):\s*\n\s*return str\(model or ""\)\.strip\(\) or "nano-banana-pro"/, 'Grsai should use the exact user-selected model without auto-upgrading to VIP variants');
assert.doesNotMatch(py, /return "nano-banana-pro-4k-vip"|return "nano-banana-2-4k-cl"|return "gpt-image-2-vip"/, 'Grsai should not auto-map user-selected models to higher-priced variants');
assert.match(py, /if is_grsai_provider\(provider\):\s*\n\s*return await generate_grsai_provider_image\(prompt, size, model, reference_images, provider\)/, 'global image generation should route Grsai providers through the Grsai adapter');
assert.match(apiSettings, /'grsai'/, 'API settings protocol list should include Grsai');
assert.match(apiSettings, /grsai\.dakka\.com\.cn[\s\S]*grsaiapi\.com[\s\S]*return 'grsai'/, 'API settings should detect Grsai documented base URLs');
assert.match(apiSettings, /function applyDetectedProtocolFromUrl\(\)[\s\S]*protocolInput\.value = detected[\s\S]*item\.protocol = detected/, 'API settings should apply detected protocols through a controlled path');
assert.match(apiHtml, /<option value="grsai">Grsai协议<\/option>/, 'protocol dropdown should show Grsai protocol');

console.log('Grsai provider routing tests passed');
