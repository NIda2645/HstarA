import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import {encodingIssueKind} from './text-encoding-rules.mjs';

const NULL = String.fromCharCode(0);
const scanPathspecs = [
  ':(glob)*.py',
  ':(exclude)get-pip.py',
  ':(glob)hstar_runtime/**/*.py',
  ':(glob)voice_assistant/**/*.py',
  ':(glob)desktop/**/*.cs',
  ':(glob)desktop/**/*.xaml',
  ':(exclude)desktop/**/bin/**',
  ':(exclude)desktop/**/obj/**',
  ':(glob)build/**/*.ps1',
  ':(glob)build/**/*.iss',
  ':(exclude)build/installer/stage/**',
  'LICENSE',
  'README.md',
  'MAC-使用说明.md',
  '运行说明.txt',
  '新手运行与使用教程.md',
  ':(glob)static/**/*.html',
  ':(glob)static/**/*.js',
  ':(glob)static/**/*.css',
  ':(glob)static/**/*.json',
  ':(exclude)static/vendor/**',
  ':(glob)integrations/openshop/**/*.html',
  ':(glob)integrations/openshop/host/**/*.js',
  ':(glob)integrations/openshop/host/**/*.css',
  ':(glob)integrations/openshop/locales/**/*.js',
  ':(exclude)integrations/openshop/vendor/**',
  ':(glob)integrations/storyai-3d-director-desk/src/**/*.ts',
  ':(glob)integrations/storyai-3d-director-desk/src/**/*.tsx',
  ':(glob)integrations/storyai-3d-director-desk/src/**/*.css',
];

const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', ...scanPathspecs], {
  encoding: 'utf8',
})
  .split(NULL)
  .filter((file) => file && fs.existsSync(file));

const utf8Latin1Pattern = /(?:[\u00c2\u00c3][\u0080-\u00bf]|(?:[\u00e0-\u00e6]|[\u00e8-\u00ef])[\u0080-\u00bf]|â(?:€|™|œ|ž|“|”|–|—|…|[\u0080-\u00bf])|ð[\u0080-\u017f])+/g;
const chineseMojibakePattern = /锟斤拷|鎼滅储|銆|脳|鐏|寮€|鏉愯川|璐村浘|绮楃硻|閲嶇置|宸插|鍏抽棴|楂樺害|姘村钩|鑹叉俟|闃村奖|杩斿洖|瀹屾垚|鐐瑰嚮|璁|娴|澶|鎻|鐢|鍙|杈|绋|鏂|涓|浼|鍏|鍔|瀹|瑙|姝|姣|鏈|閫|闂|锛|ï¼/g;
const findings = [];

function lineNumberAt(text, position) {
  return text.slice(0, position).split(/\r?\n/).length;
}

function regexLiteralRanges(line) {
  const ranges = [];
  let quote = null;
  let escaped = false;
  let comment = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (comment) break;
    if (quote) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === '`') {
      quote = char;
      continue;
    }
    if (char === '/' && line[index + 1] === '/') break;
    if (char !== '/' || line[index + 1] === '*') continue;

    let cursor = index + 1;
    let inClass = false;
    let closed = false;
    for (; cursor < line.length; cursor += 1) {
      const current = line[cursor];
      if (current === '\\') {
        cursor += 1;
        continue;
      }
      if (current === '[') inClass = true;
      else if (current === ']') inClass = false;
      else if (current === '/' && !inClass) {
        cursor += 1;
        while (/[dgimsuvy]/.test(line[cursor] || '')) cursor += 1;
        ranges.push([index, cursor]);
        index = cursor - 1;
        closed = true;
        break;
      }
    }
    if (!closed) continue;
  }
  return ranges;
}

function isInRange(position, ranges) {
  return ranges.some(([start, end]) => position >= start && position < end);
}

function reportMatches(file, text, pattern, kind, suppressRegexLiterals) {
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, line] of lines.entries()) {
    pattern.lastIndex = 0;
    const ranges = suppressRegexLiterals ? regexLiteralRanges(line) : [];
    let match;
    while ((match = pattern.exec(line))) {
      if (!isInRange(match.index, ranges)) {
        findings.push({file, line: lineIndex + 1, kind});
        break;
      }
      if (match[0].length === 0) pattern.lastIndex += 1;
    }
  }
}

function reportJsonParseFailure(file, text, error) {
  const position = Number(error.message.match(/position (\d+)/i)?.[1] ?? 0);
  findings.push({file, line: lineNumberAt(text, position), kind: 'invalid-json'});
}

function reportRuleIssues(file, text) {
  for(const [lineIndex, line] of text.split(/\r?\n/).entries()) {
    const kind = encodingIssueKind(line);
    if(kind && !findings.some(item => item.file === file && item.line === lineIndex + 1 && item.kind === kind)) {
      findings.push({file, line:lineIndex + 1, kind});
    }
  }
}

for (const file of files) {
  const text = fs.readFileSync(file).toString('utf8').replace(/^\uFEFF/, '');
  const isJavaScript = /\.(?:js|mjs|ts|tsx)$/i.test(file);

  if (file.toLowerCase().endsWith('.json')) {
    try {
      JSON.parse(text);
    } catch (error) {
      reportJsonParseFailure(file, text, error);
    }
  }

  reportMatches(file, text, /\uFFFD/g, 'replacement-character', isJavaScript);
  reportMatches(file, text, utf8Latin1Pattern, 'utf8-as-latin1-mojibake', isJavaScript);
  reportMatches(file, text, chineseMojibakePattern, 'chinese-mojibake', isJavaScript);
  reportRuleIssues(file, text);
}

if (findings.length > 0) {
  for (const finding of findings) {
    console.error(`${finding.file}:${finding.line}:${finding.kind}`);
  }
  process.exitCode = 1;
} else {
  console.log(`User-facing text encoding passed: ${files.length}`);
}
