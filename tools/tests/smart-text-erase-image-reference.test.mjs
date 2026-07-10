import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const js = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');
const main = readFileSync(new URL('../../main.py', import.meta.url), 'utf8');

assert.match(
  js,
  /const sourceRef = smartRefWithMarkers\(imageForDisplay\(item\), \{name:item\.name \|\| 'source-image', kind:'image', nodeId:node\.id, imageIndex:index, role:'image_1'\}\);[\s\S]*const refs = uniqueReferenceImages\(\[sourceRef\]\)\.filter\(ref => ref\?\.url\);/,
  'smart text image generation should carry the source image through the same reference wrapper as normal image nodes'
);

assert.match(
  js,
  /const imageRefs = imageRefsOnly\(refs\)\.slice\(0, SMART_REFERENCE_IMAGE_MAX\);[\s\S]*const payload = \{prompt, provider_id:runSettings\.provider_id, model:runSettings\.model, size:sizeForRun\(runSettings\), quality:runSettings\.quality \|\| 'auto', n:1, reference_images:imageRefs\};/,
  'smart canvas API generation payload should include filtered image references'
);

assert.match(
  main,
  /refs = \[ref\.dict\(\) for ref in payload\.reference_images if ref\.url\][\s\S]*image_refs = image_references\(refs\)[\s\S]*generate_ai_image\(payload\.prompt, payload\.size, payload\.quality, model, image_refs, provider\["id"\]\)/,
  'canvas image tasks should pass image references through to provider generation'
);

assert.match(
  main,
  /async def generate_linapi_provider_image[\s\S]*path, created = await codex_prepare_local_media\(ref\.get\("url", ""\)\)[\s\S]*temp_paths\.extend\(created\)[\s\S]*if not files:[\s\S]*LinAPI 图生图需要可读取的参考图片文件/,
  'LinAPI image edit should convert non-local references to multipart files and reject empty image submissions'
);

assert.match(
  main,
  /async def generate_ai_image[\s\S]*elif image_refs:[\s\S]*path, created = await codex_prepare_local_media\(ref\.get\("url", ""\)\)[\s\S]*temp_paths\.extend\(created\)[\s\S]*if not files:[\s\S]*图生图需要可读取的参考图片文件/,
  'generic OpenAI-compatible image edit should convert non-local references to multipart files and reject empty image submissions'
);

assert.match(
  main,
  /def reference_to_data_url\(ref, max_size=None\):[\s\S]*if raw_url\.startswith\(\("blob:", "file:\/\/"\)\):[\s\S]*return ""[\s\S]*if raw_url\.startswith\(\("\/output\/", "\/assets\/"\)\):[\s\S]*return ""/,
  'JSON provider reference conversion should reject browser-only blob URLs and missing local asset paths'
);

assert.match(
  main,
  /def require_converted_image_refs\(source_refs, converted_values, label\):[\s\S]*if source_count and not values:[\s\S]*raise HTTPException\(status_code=400/,
  'all provider adapters should have a shared guard against silently dropping supplied reference images'
);

for (const [label, pattern] of [
  ['Baofu', /image_urls = require_converted_image_refs\(refs\[:4\],[\s\S]*"Baofu 图生图"\)[\s\S]*body\["image_urls"\] = image_urls/],
  ['BananaRouter', /image_payloads = require_converted_image_refs\(refs\[:4\],[\s\S]*"BananaRouter 图生图"\)[\s\S]*body\["images"\] = image_payloads/],
  ['MoonlyAI', /refs = require_converted_image_refs\(source_refs, refs, "MoonlyAI 图生图"\)[\s\S]*body\["image_urls"\] = refs/],
  ['ToAPIs', /refs = require_converted_image_refs\(source_refs, \[otuapi_reference_url\(ref\) for ref in source_refs\], "ToAPIs 图生图"\)[\s\S]*body\["image_urls"\] = refs/],
  ['OtuAPI', /refs = require_converted_image_refs\(source_refs, \[otuapi_reference_url\(ref\) for ref in source_refs\], "OtuAPI 图生图"\)[\s\S]*(?:body = \{[\s\S]*"metadata": \{"aspect_ratio": otuapi_aspect_ratio\(size\), "urls": refs\}[\s\S]*body\["image"\] = refs)/],
  ['Grsai', /refs = require_converted_image_refs\(source_refs, \[reference_to_data_url\(ref, max_size=1536\) for ref in source_refs\], "Grsai 图生图"\)[\s\S]*"images": refs/],
  ['Gemini', /image_parts = \[\][\s\S]*require_converted_image_refs\(source_refs, image_parts, "Gemini 图生图"\)[\s\S]*parts\.extend\(image_parts\)/],
  ['Volcengine', /images = require_converted_image_refs\(source_refs, \[volcengine_image_payload\(ref\) for ref in source_refs\], "火山引擎图生图"\)[\s\S]*body\["image"\] = images/],
  ['RunningHub', /image_urls = require_converted_image_refs\(source_refs, image_urls, "RunningHub 图生图"\)[\s\S]*body\[key\] = image_urls/],
]) {
  assert.match(main, pattern, `${label} should preserve its provider-specific image input field while guarding against dropped references`);
}

console.log('smart text erase image reference tests passed');
