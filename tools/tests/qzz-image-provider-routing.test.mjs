import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const py = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');
const apiSettings = readFileSync(new URL('../../static/js/api-settings.js', import.meta.url), 'utf8');
const qzzReferenceFunction = py.slice(
  py.indexOf('async def qzz_reference_image_value'),
  py.indexOf('async def generate_qzz_provider_image')
);

assert.match(
  py,
  /def inferred_provider_protocol_from_base_url\(base_url\):[\s\S]*if is_qzz_base_url\(url\):[\s\S]*return "apimart"/,
  'img.688.qzz.io should remain auto-detected for existing API settings compatibility'
);

assert.match(
  py,
  /def is_qzz_base_url\(base_url\):[\s\S]*"img\.688\.qzz\.io" in/,
  'QZZ should use a shared base URL detector across routing and API settings validation'
);

assert.match(
  py,
  /def is_qzz_image_provider\(provider\):[\s\S]*return is_qzz_base_url\(base_url\)/,
  'runtime routing should identify img.688.qzz.io as its own image-edit adapter'
);

assert.match(
  py,
  /if is_qzz_image_provider\(provider\):\s*\n\s*return await generate_qzz_provider_image\(prompt, size, model, reference_images, provider, quality=quality\)[\s\S]*if is_baofu_provider\(provider\):/,
  'QZZ routing should run before Baofu/APIMart fallbacks so saved older protocols do not force image_urls'
);

assert.match(
  py,
  /async def generate_qzz_provider_image\(prompt, size, model, reference_images=None, provider=None, quality=""\):[\s\S]*image_payload = require_converted_image_refs\([\s\S]*\[qzz_reference_image_value\(ref\) for ref in image_refs\[:1\]\][\s\S]*body\["image"\] = image_payload[\s\S]*response = await client\.post\(gen_url/,
  'QZZ image edits should send the first source image through OpenAI-compatible image JSON on generations'
);

assert.match(
  py,
  /def qzz_reference_image_value\(ref\):[\s\S]*if text\.startswith\(\("http:\/\/", "https:\/\/"\)\):[\s\S]*return text[\s\S]*return reference_to_data_url\(\{"url": local_ref\}, max_size=384\)/,
  'QZZ should convert local canvas references to compact data URLs for OpenAI-compatible image JSON'
);

assert.doesNotMatch(
  qzzReferenceFunction,
  /upload_image_for_apimart|upload_local_media_to_cloud/,
  'QZZ should not depend on APIMart or generic temporary upload endpoints'
);

assert.doesNotMatch(
  qzzReferenceFunction,
  /reference_image/,
  'QZZ should not use the old reference_image field for local image-to-image requests'
);

assert.match(
  py,
  /if is_qzz_base_url\(base_url\):[\s\S]*baofu_default_model_payload\([\s\S]*models_error[\s\S]*gpt-image-2/,
  'QZZ model-list 403 responses should fall back to the known gpt-image-2 model instead of breaking API settings'
);

assert.match(
  apiSettings,
  /if\(url\.includes\('img\.688\.qzz\.io'\)\) return 'apimart';/,
  'API settings should auto-detect img.688.qzz.io for saved provider compatibility'
);

console.log('QZZ image provider routing tests passed');
