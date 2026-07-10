import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const baseUrl = process.env.HSTAR_URL || 'http://127.0.0.1:3000';
const providerId = process.env.BAOFU_PROVIDER_ID || 'custom-api-12';
const model = process.env.BAOFU_MODEL || 'gpt-image-2';
const quality = process.env.BAOFU_QUALITY || 'high';
const exactProbe = process.env.BAOFU_EXACT_PROBE === '1' || process.argv.includes('--exact');
const timeoutMs = Number(process.env.BAOFU_TASK_TIMEOUT_MS || 35 * 60 * 1000);
const pollMs = Number(process.env.BAOFU_POLL_MS || 5000);
const storageRoot = process.env.HSTAR_STORAGE_ROOT || 'E:\\Hstar缓存';
const assetsRoot = path.join(storageRoot, 'assets');
const outputRoot = path.join(storageRoot, 'output');
const reportDir = path.join(process.cwd(), 'tools', 'reports');
const reportPath = path.join(reportDir, `baofu-4k-matrix-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);

const matrix = [
  ['1:1', '2560x2560'],
  ['2:3', '2048x3072'],
  ['3:2', '3520x2352'],
  ['3:4', '2400x3200'],
  ['4:3', '3312x2480'],
  ['9:16', '2160x3840'],
  ['16:9', '3840x2160'],
  ['21:9', '3840x1648'],
  ['9:21', '1632x3840'],
];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function parseArgs() {
  const args = process.argv.slice(2);
  const only = new Set();
  const sizes = new Map();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === '--only' && args[i + 1]) {
      for (const item of args[i + 1].split(',')) only.add(item.trim());
      i += 1;
    } else if (arg === '--size' && args[i + 1]) {
      const [ratio, size] = args[i + 1].split('=');
      if (ratio && size) sizes.set(ratio.trim(), size.trim());
      i += 1;
    }
  }
  return {only, sizes};
}

function imagePathFromUrl(url) {
  const clean = String(url || '').split('?', 1)[0].replace(/\\/g, '/');
  const decoded = decodeURIComponent(clean);
  if (decoded.startsWith('/assets/')) {
    return path.join(assetsRoot, decoded.slice('/assets/'.length));
  }
  if (decoded.startsWith('/output/')) {
    return path.join(outputRoot, decoded.slice('/output/'.length));
  }
  return '';
}

function pngSize(buffer) {
  if (buffer.length >= 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return {width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20), type: 'png'};
  }
  return null;
}

function jpegSize(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null;
  let offset = 2;
  while (offset + 9 < buffer.length) {
    if (buffer[offset] !== 0xff) return null;
    const marker = buffer[offset + 1];
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    const length = buffer.readUInt16BE(offset);
    if (length < 2) return null;
    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      return {height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5), type: 'jpeg'};
    }
    offset += length;
  }
  return null;
}

function webpSize(buffer) {
  if (buffer.length < 30 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WEBP') return null;
  const chunk = buffer.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    return {width: buffer.readUIntLE(24, 3) + 1, height: buffer.readUIntLE(27, 3) + 1, type: 'webp'};
  }
  return null;
}

function readImageSize(filePath) {
  const buffer = fs.readFileSync(filePath);
  const size = pngSize(buffer) || jpegSize(buffer) || webpSize(buffer);
  if (!size) throw new Error(`Unsupported image format: ${filePath}`);
  return {...size, bytes: buffer.length};
}

async function fetchJson(url, init = {}) {
  const response = await fetch(url, init);
  const text = await response.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    throw new Error(`Non-JSON response ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok) {
    const detail = json?.detail || json?.error || text;
    throw new Error(`HTTP ${response.status}: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
  }
  return json;
}

async function createTask(ratio, size) {
  const prompt = process.env.BAOFU_PROBE_PROMPT || `Abstract neutral geometric color blocks, clean composition, no people, no text. Aspect ratio ${ratio}, size ${size}.`;
  const requestSize = exactProbe ? `baofu-exact:${size}` : size;
  return fetchJson(`${baseUrl}/api/canvas-image-tasks`, {
    method: 'POST',
    headers: {'Content-Type': 'application/json'},
    body: JSON.stringify({prompt, provider_id: providerId, model, size: requestSize, quality, n: 1, reference_images: []}),
  });
}

async function waitTask(taskId) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const task = await fetchJson(`${baseUrl}/api/canvas-image-tasks/${encodeURIComponent(taskId)}`);
    if (task.status === 'succeeded') return task;
    if (task.status === 'failed') throw new Error(task.error || 'Task failed');
    await sleep(pollMs);
  }
  throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
}

async function runOne(ratio, size) {
  const started = Date.now();
  const created = await createTask(ratio, size);
  const taskId = created.task_id;
  console.log(`[${ratio}] submitted ${size} task=${taskId}`);
  const task = await waitTask(taskId);
  const images = task.result?.images || [];
  if (!images.length) throw new Error('Succeeded task did not include images');
  const imageUrl = images[0];
  const filePath = imagePathFromUrl(imageUrl);
  if (!filePath || !fs.existsSync(filePath)) throw new Error(`Returned file is missing: ${imageUrl} -> ${filePath}`);
  const actual = readImageSize(filePath);
  return {
    ratio,
    requested_size: size,
    task_id: taskId,
    status: 'succeeded',
    image_url: imageUrl,
    file_path: filePath,
    width: actual.width,
    height: actual.height,
    type: actual.type,
    bytes: actual.bytes,
    elapsed_ms: Date.now() - started,
    request: task.result?.params || null,
  };
}

async function main() {
  const {only, sizes} = parseArgs();
  fs.mkdirSync(reportDir, {recursive: true});
  const tests = matrix
    .filter(([ratio]) => only.size === 0 || only.has(ratio))
    .map(([ratio, size]) => [ratio, sizes.get(ratio) || size]);
  const report = {
    started_at: new Date().toISOString(),
    base_url: baseUrl,
    provider_id: providerId,
    model,
    quality,
    exact_probe: exactProbe,
    results: [],
  };
  for (const [ratio, size] of tests) {
    try {
      const result = await runOne(ratio, size);
      report.results.push(result);
      console.log(`[${ratio}] ok requested=${size} returned=${result.width}x${result.height} file=${result.file_path}`);
    } catch (error) {
      const result = {ratio, requested_size: size, status: 'failed', error: error?.message || String(error)};
      report.results.push(result);
      console.log(`[${ratio}] failed requested=${size} error=${result.error}`);
    }
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  }
  report.finished_at = new Date().toISOString();
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf8');
  console.log(`report=${reportPath}`);
  const failed = report.results.filter(item => item.status !== 'succeeded');
  if (failed.length) process.exitCode = 1;
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
