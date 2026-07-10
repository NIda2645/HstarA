import assert from 'node:assert/strict';
import fs from 'node:fs';

const py = fs.readFileSync('main.py', 'utf8');
const apiSettings = fs.readFileSync('static/js/api-settings.js', 'utf8');
const apiHtml = fs.readFileSync('static/api-settings.html', 'utf8');
const bananaFunction = py.slice(
  py.indexOf('async def generate_bananarouter_provider_image'),
  py.indexOf('MOONLY_BASE_RATIOS'),
);

assert.match(py, /SUPPORTED_PROVIDER_PROTOCOLS = \{[^}]*"bananarouter"/, 'backend should register the BananaRouter protocol');
assert.match(py, /def is_bananarouter_provider\(provider\):[\s\S]*"bananarouter\.com" in base_url[\s\S]*pid == "bananarouter"/, 'BananaRouter should be recognized by base URL, protocol, id, or name');
assert.match(py, /if provider_id == "bananarouter" or "bananarouter\.com" in base_url:[\s\S]*return "bananarouter"/, 'API validation should auto-detect BananaRouter base URLs');
assert.match(py, /if is_bananarouter_provider\(provider\):\s*\n\s*return await generate_bananarouter_provider_image\(prompt, size, model, reference_images, provider, quality=quality\)/, 'global image generation should route BananaRouter through its adapter');
assert.match(bananaFunction, /gen_url = provider_endpoint_url\(provider, "image_generation_endpoint", "\/v1\/images\/generations"\)/, 'BananaRouter text-to-image should use the generations endpoint');
assert.match(bananaFunction, /edit_url = provider_endpoint_url\(provider, "image_edit_endpoint", "\/v1\/images\/edits"\)/, 'BananaRouter image inputs should use the edits endpoint');
assert.match(bananaFunction, /request_size = normalize_gpt_image_2_size\(size\)[\s\S]*"size": request_size/, 'BananaRouter should clamp requested sizes to GPT-Image-2 pixel constraints from its docs');
assert.match(bananaFunction, /image_payloads = require_converted_image_refs\(refs\[:4\], \[reference_to_data_url\(ref, max_size=1536\) for ref in refs\[:4\]\], "BananaRouter 图生图"\)[\s\S]*body\["images"\] = image_payloads[\s\S]*target_url = edit_url if refs else gen_url[\s\S]*client\.post\(target_url/, 'BananaRouter image inputs should be converted and sent as JSON images on edits');
assert.doesNotMatch(bananaFunction, /image_urls|post_openai_edits|files=|multipart|json_body=False/, 'BananaRouter should not use image_urls or multipart edits');
assert.match(apiSettings, /'bananarouter'/, 'API settings protocol list should include BananaRouter');
assert.match(apiSettings, /url\.includes\('bananarouter\.com'\)[\s\S]*return 'bananarouter'/, 'API settings should detect BananaRouter base URLs');
assert.match(apiHtml, /<option value="bananarouter">/, 'protocol dropdown should show BananaRouter protocol');

console.log('BananaRouter provider routing tests passed');
