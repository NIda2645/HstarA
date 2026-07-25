import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const py = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');
const apiSettings = readFileSync(new URL('../../static/js/api-settings.js', import.meta.url), 'utf8');
const qzzReferenceFunction = py.slice(
  py.indexOf('def qzz_compact_reference_data_url'),
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

const qzzProviderFunction = py.slice(
  py.indexOf('async def generate_qzz_provider_image'),
  py.indexOf('async def generate_baofu_provider_image')
);

assert.match(
  qzzProviderFunction,
  /edit_url = provider_endpoint_url\(provider, "image_edit_endpoint", "\/v1\/images\/edits"\)[\s\S]*files\.append\(\("image",[\s\S]*files\.append\(\("mask",[\s\S]*await client\.post\([\s\S]*edit_url,[\s\S]*data=data,[\s\S]*files=files/,
  'QZZ references should follow the configured OpenAI multipart image-edit protocol'
);

assert.match(
  qzzProviderFunction,
  /else:[\s\S]*response = await client\.post\([\s\S]*gen_url,[\s\S]*json=body/,
  'QZZ prompt-only generation should continue using the configured JSON generation endpoint'
);

assert.match(
  py,
  /def qzz_compact_reference_data_url\(value, max_size=384\):[\s\S]*convert\("RGBA"\)[\s\S]*Image\.new\("RGB"[\s\S]*data:image\/png;base64/,
  'QZZ should flatten transparent art references onto an opaque neutral matte before submission'
);

assert.match(
  py,
  /def qzz_image_error_detail\(response, size="", model=""\):[\s\S]*raw_reason[\s\S]*不会自动重试[\s\S]*if response\.status_code >= 400:[\s\S]*qzz_image_error_detail/,
  'QZZ failures should preserve the translated and raw upstream response without automatic retries'
);

assert.match(
  py,
  /def qzz_reference_image_value\(ref\):[\s\S]*if text\.startswith\("data:image\/"\):[\s\S]*qzz_compact_reference_data_url\(text\)[\s\S]*if text\.startswith\(\("http:\/\/", "https:\/\/"\)\):[\s\S]*return text[\s\S]*qzz_compact_reference_data_url\([\s\S]*reference_to_data_url\(\{"url": local_ref\}, max_size=384\)/,
  'QZZ should flatten and compact local or data-URL references before OpenAI-compatible image JSON submission'
);

assert.doesNotMatch(
  qzzReferenceFunction,
  /upload_image_for_apimart|upload_local_media_to_cloud/,
  'QZZ should not depend on APIMart or generic temporary upload endpoints'
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
