import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {basename, relative, resolve} from 'node:path';

const NULL = String.fromCharCode(0);
const MAX_TEXT_BYTES = 64 * 1024 * 1024;
const excludedPath = /(?:^|\/)(?:\.git|node_modules|python|tmp|runtime-cache|build\/installer\/stage|static\/openshop\/vendor|integrations\/openshop\/vendor)(?:\/|$)/i;
const binaryExtension = /\.(?:7z|avi|bin|bmp|dll|docx?|exe|fbx|gif|glb|gz|ico|jpe?g|m4a|mkv|mov|mp3|mp4|obj|onnx|pdf|png|pptx?|pyc|safetensors|so|tar|tiff?|wav|webm|webp|wasm|woff2?|xlsx?|zip)$/i;
const patterns = [
  ['private-key', /-----BEGIN (?:[A-Z0-9 ]+ )?PRIVATE KEY-----/],
  ['github-token', /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/],
  ['github-fine-grained-token', /\bgithub_pat_[A-Za-z0-9_]{20,255}\b/],
  ['aws-access-key', /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/],
  ['google-api-key', /\bAIza[0-9A-Za-z_-]{35}\b/],
  ['openai-token', /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/],
  ['anthropic-token', /\bsk-ant-[A-Za-z0-9_-]{20,}\b/],
];

const inventoriedFiles = execFileSync(
  'git',
  ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
  {encoding:'utf8'},
).split(NULL).filter(Boolean);
const entries = inventoriedFiles.map((file) => ({absolute:resolve(file), display:file}));
const extraRoots = [];
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] !== '--extra' || !process.argv[index + 1]) {
    throw new Error(`Unknown or incomplete secret-audit argument: ${process.argv[index] || ''}`);
  }
  extraRoots.push(resolve(process.argv[index + 1]));
  index += 1;
}

function collectExtraFiles(root, directory=root) {
  for (const entry of fs.readdirSync(directory, {withFileTypes:true})) {
    const absolute = resolve(directory, entry.name);
    if (entry.isDirectory()) collectExtraFiles(root, absolute);
    else if (entry.isFile()) {
      const suffix = relative(root, absolute).replaceAll('\\', '/');
      entries.push({absolute, display:`extra:${basename(root)}/${suffix}`});
    }
  }
}

for (const root of extraRoots) {
  if (!fs.statSync(root).isDirectory()) throw new Error(`Secret-audit extra path is not a directory: ${root}`);
  collectExtraFiles(root);
}
const findings = [];
let scannedFiles = 0;

for (const entry of entries) {
  const file = entry.absolute;
  const normalized = entry.display.replaceAll('\\', '/');
  if (excludedPath.test(normalized) || binaryExtension.test(normalized)) continue;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    continue;
  }
  if (!stat.isFile()) continue;
  if (stat.size > MAX_TEXT_BYTES) {
    findings.push({file:entry.display, line:0, kind:'unscanned-large-text'});
    continue;
  }
  const content = fs.readFileSync(file);
  if (content.includes(0)) continue;
  scannedFiles += 1;
  const lines = content.toString('utf8').replace(/^\uFEFF/, '').split(/\r?\n/);
  for (const [index, line] of lines.entries()) {
    for (const [kind, pattern] of patterns) {
      if (pattern.test(line)) findings.push({file:entry.display, line:index + 1, kind});
    }
  }
}

if (findings.length) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.kind}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Current-tree secret audit passed: ${scannedFiles} scanned files (${inventoriedFiles.length} inventoried)`);
}
