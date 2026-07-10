import assert from 'node:assert/strict';
import fs from 'node:fs';

const py = fs.readFileSync('main.py', 'utf8');
const apiSettings = fs.readFileSync('static/js/api-settings.js', 'utf8');
const apiHtml = fs.readFileSync('static/api-settings.html', 'utf8');
const liveMatrixTool = fs.readFileSync('tools/test-baofu-4k-matrix.mjs', 'utf8');
const baofuFunction = py.slice(
  py.indexOf('async def generate_baofu_provider_image'),
  py.indexOf('MOONLY_BASE_RATIOS'),
);

assert.match(py, /SUPPORTED_PROVIDER_PROTOCOLS = \{[^}]*"baofu"/, 'backend should register the Baofu protocol');
assert.match(py, /def is_baofu_provider\(provider\):[\s\S]*protocol == "baofu"[\s\S]*"baofu" in base_url[\s\S]*pid == "baofu"/, 'Baofu should be recognized by protocol, id/name, or generic Baofu base URLs');
assert.match(py, /if provider_id == "baofu" or "baofu" in base_url:[\s\S]*return "baofu"/, 'API validation should auto-detect generic Baofu base URLs');
assert.match(py, /if is_baofu_provider\(provider\):\s*\n\s*return await generate_baofu_provider_image\(prompt, size, model, reference_images, provider\)/, 'global image generation should route Baofu through its adapter');
assert.match(py, /def baofu_model_for_request\(model\):[\s\S]*return "gpt-image-2"/, 'Baofu should send compatibility aliases as the upstream model gpt-image-2');
assert.match(py, /def baofu_size_for_request\(size\):[\s\S]*return f"\{width\}x\{height\}"/, 'Baofu should send explicit pixel sizes for 2K/4K requests');
assert.match(py, /baofu-exact:[\s\S]*return exact_size/, 'Baofu should allow explicit probe sizes without 4K matrix normalization');
assert.match(py, /BAOFU_FOUR_K_SIZES = \{[\s\S]*"1:1": "4096x4096"[\s\S]*"2:3": "3120x4680"[\s\S]*"3:2": "4530x3020"[\s\S]*"3:4": "3861x5148"[\s\S]*"4:3": "4960x3720"[\s\S]*"9:16": "3096x5504"[\s\S]*"16:9": "5488x3087"[\s\S]*"21:9": "6006x2574"[\s\S]*"9:21": "2574x6006"/, 'Baofu should use the verified 4K size matrix per aspect ratio');
assert.match(py, /def baofu_four_k_size_for_dimensions\(width, height\):[\s\S]*math\.log\(request_ratio \/ target_ratio\)[\s\S]*return BAOFU_FOUR_K_SIZES\[best_key\]/, 'Baofu should choose the nearest verified 4K size for the requested aspect ratio');
assert.match(py, /max\(width, height\) >= 3000[\s\S]*return baofu_four_k_size_for_dimensions\(width, height\)/, 'Baofu should map frontend 4K presets through the verified aspect-ratio matrix');
assert.match(py, /request_size = baofu_size_for_request\(size\)[\s\S]*"size": request_size/, 'Baofu generations should normalize sizes through the Baofu adapter only');
assert.match(py, /def output_file_from_url\(url\):[\s\S]*urllib\.parse\.urlparse\(url\)[\s\S]*127\.0\.0\.1[\s\S]*url = parsed\.path/, 'local absolute asset URLs should resolve to local files before Baofu reference conversion');
assert.match(baofuFunction, /image_urls = require_converted_image_refs\(refs\[:4\], \[reference_to_data_url\(ref, max_size=1536\) for ref in refs\[:4\]\], "Baofu 图生图"\)[\s\S]*body\["image_urls"\] = image_urls[\s\S]*client\.post\(gen_url/, 'Baofu should send converted reference images through the verified generations endpoint as image_urls');
assert.doesNotMatch(baofuFunction, /client\.post\(\s*edit_url/, 'Baofu should not use the unstable edits endpoint for canvas image inputs');
assert.match(py, /BAOFU_IMAGE_MODELS = \["gpt-image-2"\]/, 'Baofu built-in fallback must not invent gpt-image-2-4k as a model');
assert.match(py, /def extract_image\(data\):[\s\S]*flexible = extract_image_flexible\(data\)[\s\S]*if flexible:[\s\S]*return flexible/, 'Baofu image responses should use flexible extraction before reporting missing image data');
assert.match(py, /async def save_ai_image_to_output\(image_data[\s\S]*value\.startswith\("data:image\/"\)[\s\S]*base64\.b64decode\(encoded\)[\s\S]*return output_url_for\(filename, category\)/, 'data URL image results should be saved locally instead of being fetched as remote URLs');
assert.match(py, /return \{"ok": True, "protocol": protocol, "status": resp\.status_code/, 'successful provider validation should return the detected protocol');
assert.match(apiSettings, /'baofu'/, 'API settings protocol list should include Baofu');
assert.match(apiSettings, /url\.includes\('baofu'\)[\s\S]*return 'baofu'/, 'API settings should detect generic Baofu base URLs');
assert.match(apiSettings, /function applyDetectedProtocolFromUrl\(\)[\s\S]*protocolInput\.value = detected[\s\S]*item\.protocol = detected/, 'API settings should apply detected protocols through a controlled path');
assert.match(apiHtml, /<option value="baofu">/, 'protocol dropdown should show Baofu protocol');
assert.match(liveMatrixTool, /api\/canvas-image-tasks/, 'Baofu live matrix tool should exercise the same canvas task endpoint as the UI');
assert.match(liveMatrixTool, /readImageSize\(filePath\)/, 'Baofu live matrix tool should verify returned local image dimensions');
assert.match(liveMatrixTool, /baofu-exact:\$\{size\}/, 'Baofu live matrix tool should request exact candidate sizes during probing');

console.log('Baofu provider routing tests passed');
