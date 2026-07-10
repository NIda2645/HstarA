import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const source = readFileSync('main.py', 'utf8');

assert.match(
  source,
  /SUPPORTED_PROVIDER_PROTOCOLS = \{[^}]*"linapi"/,
  'backend should register the LinAPI protocol'
);

assert.match(
  source,
  /def is_linapi_provider\(provider\):[\s\S]*"linapi\.net" in base_url/,
  'LinAPI should still be detected from https://api.linapi.net'
);

assert.doesNotMatch(
  source,
  /if effective_protocol\(provider, model\) in \{"gemini", "linapi"\}:\s*\n\s*return await generate_gemini_provider_image/,
  'LinAPI must not be routed through the Gemini generateContent image endpoint'
);

const generateAiImageStart = source.indexOf('async def generate_ai_image');
const linapiRouteIndex = source.indexOf('if is_linapi_provider(provider):', generateAiImageStart);
const geminiProtocolRouteIndex = source.indexOf('if effective_protocol(provider, model) == "gemini":', generateAiImageStart);
assert.ok(
  linapiRouteIndex !== -1 && geminiProtocolRouteIndex !== -1 && linapiRouteIndex < geminiProtocolRouteIndex,
  'LinAPI model split should run before generic Gemini protocol routing so gpt-image-2 on a Gemini-default LinAPI provider still uses OpenAI Images'
);

assert.match(
  source,
  /async def generate_linapi_provider_image\(prompt, size, model, reference_images=None, provider=None, quality=""\):/,
  'LinAPI should use a dedicated gpt-image-2 adapter instead of the generic OpenAI branch'
);

assert.match(
  source,
  /async def generate_linapi_provider_image[\s\S]*gen_url = provider_endpoint_url\(provider, "image_generation_endpoint", "\/v1\/images\/generations"\)[\s\S]*edit_url = provider_endpoint_url\(provider, "image_edit_endpoint", "\/v1\/images\/edits"\)/,
  'LinAPI gpt-image-2 text-to-image and image edit should use the documented OpenAI image endpoints'
);

assert.match(
  source,
  /async def generate_linapi_provider_image[\s\S]*client\.post\(gen_url,[\s\S]*json=body/,
  'LinAPI gpt-image-2 text-to-image should submit JSON to /v1/images/generations'
);

assert.match(
  source,
  /async def generate_linapi_provider_image[\s\S]*files\.append\(\("image", \(os\.path\.basename\(path\), fh, content_type_for_path\(path\)\)\)\)[\s\S]*client\.post\(edit_url,[\s\S]*data=data,[\s\S]*files=files/,
  'LinAPI gpt-image-2 image edit should submit multipart image files to /v1/images/edits'
);

assert.match(
  source,
  /def is_linapi_gpt_image_model\(model\):[\s\S]*is_gpt_image_2_model\(model\)/,
  'LinAPI should explicitly classify gpt-image-2 models for the OpenAI Images adapter'
);

assert.match(
  source,
  /def is_linapi_gemini_image_model\(model\):[\s\S]*image-preview/,
  'LinAPI should explicitly classify Gemini image preview models for generateContent'
);

assert.match(
  source,
  /if is_linapi_provider\(provider\):\s*\n\s*if is_linapi_gemini_image_model\(model\):\s*\n\s*return await generate_gemini_provider_image\(prompt, size, model, reference_images, provider\)\s*\n\s*return await generate_linapi_provider_image\(prompt, size, model, reference_images, provider, quality=quality\)/,
  'global image generation should split LinAPI by model: Gemini preview to generateContent, gpt-image-2 to OpenAI Images'
);

assert.match(
  source,
  /async def generate_gemini_provider_image[\s\S]*if is_linapi_provider\(provider\):[\s\S]*"generationConfig": \{"imageConfig": gemini_image_config\(size\)\}/,
  'LinAPI Gemini requests should use the documented imageConfig generateContent body'
);

assert.match(
  source,
  /async def generate_gemini_provider_image[\s\S]*if is_linapi_provider\(provider\):\s*\n\s*client_kwargs\["trust_env"\] = False/,
  'LinAPI Gemini requests should bypass system proxy settings that disconnect :generateContent requests'
);

assert.match(
  source,
  /def markdown_image_data_url\(value\):[\s\S]*data:image\/[^;\\s\)]+;base64/,
  'image extraction should understand Markdown data URLs returned by LinAPI Gemini text parts'
);

assert.match(
  source,
  /markdown_url = markdown_image_data_url\(part\.get\("text"\)\)/,
  'Gemini candidate parts should scan text for Markdown-embedded image data URLs'
);

assert.match(
  source,
  /def api_headers[\s\S]*effective_protocol\(provider, model\) == "gemini" and not is_linapi_provider\(provider\)[\s\S]*x-goog-api-key[\s\S]*"Authorization": bearer_auth_value\(api_key\)/,
  'LinAPI Gemini requests should keep Bearer auth rather than Google x-goog-api-key auth'
);

const mergeDefaultsStart = source.indexOf('def merge_default_api_providers');
const mergeDefaultsEnd = source.indexOf('def normalize_model_list', mergeDefaultsStart);
const mergeDefaultsBody = source.slice(mergeDefaultsStart, mergeDefaultsEnd);
assert.doesNotMatch(
  mergeDefaultsBody,
  /LINAPI_IMAGE_MODELS/,
  'loading saved LinAPI providers must not append built-in upstream models the user did not select'
);

assert.doesNotMatch(
  source,
  /if protocol == "linapi":[\s\S]{0,180}return linapi_default_model_payload/,
  'fetching LinAPI models must not bypass upstream with a built-in model list'
);

assert.doesNotMatch(
  source,
  /if protocol == "linapi":[\s\S]{0,200}\/v1beta\/models/,
  'LinAPI model validation should not use the old Gemini /v1beta/models endpoint'
);

assert.match(
  source,
  /if protocol == "linapi":[\s\S]{0,200}\/v1\/models/,
  'LinAPI model validation should use the OpenAI-compatible /v1/models endpoint'
);

console.log('LinAPI provider routing tests passed');
