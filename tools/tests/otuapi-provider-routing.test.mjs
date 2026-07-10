import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');

assert.match(source, /def is_otuapi_provider\(provider\):[\s\S]*protocol == "otuapi"[\s\S]*"otuapi\.com" in base_url[\s\S]*pid == "otuapi"/, 'OtuAPI providers should be recognized by protocol, base URL, name, or provider id');
assert.match(source, /async def generate_otuapi_provider_image\(/, 'OtuAPI image generator should exist');
assert.match(source, /if is_otuapi_provider\(provider\):\s*\n\s*return await generate_otuapi_provider_image\(prompt, size, model, reference_images, provider\)/, 'global image generation should route OtuAPI providers through the OtuAPI adapter');
assert.match(source, /client\.post\(f"\{base_url\}\/v1\/videos"/, 'OtuAPI nano-banana models should submit to /v1/videos');
assert.doesNotMatch(source, /if is_otuapi_provider\(provider\):[\s\S]{0,160}\/v1\/images\/generations/, 'OtuAPI providers should not fall through to the OpenAI image generation endpoint');
assert.match(source, /isinstance\(data, dict\) and isinstance\(data\.get\("url"\), str\)/, 'image extraction should accept OtuAPI async completed responses with a top-level url');
assert.match(source, /image_url = part\.get\("image_url"\) or part\.get\("imageUrl"\)/, 'image extraction should accept OtuAPI Gemini responses with candidates[].content.parts[].image_url.url');

console.log('OtuAPI provider routing tests passed');
