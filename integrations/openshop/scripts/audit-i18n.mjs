import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const indexPath = resolve(packageRoot, 'index.html');
const localePath = resolve(packageRoot, 'locales', 'zh-CN.js');
const glossaryPath = resolve(packageRoot, 'locales', 'photoshop-zh-CN-glossary.json');
const runtimePath = resolve(packageRoot, 'host', 'openshop-i18n.js');
const indexSource = readFileSync(indexPath, 'utf8');
const localeSource = readFileSync(localePath, 'utf8');
const glossary = JSON.parse(readFileSync(glossaryPath, 'utf8'));

const registrations = new Map();
const context = vm.createContext({
  window: {
    HstarOpenShopI18n: {
      register(locale, messages) {
        registrations.set(locale, { ...messages });
        return true;
      },
    },
  },
});
vm.runInContext(localeSource, context, { filename: localePath });
const dictionary = registrations.get('zh-CN');
if (!dictionary) throw new Error('zh-CN.js did not register a zh-CN dictionary');

const failures = [];
const messageKeys = new Set();

function lineNumberAt(source, offset) {
  return source.slice(0, offset).split('\n').length;
}

function collectMatches(source, pattern, keyGroup) {
  for (const match of source.matchAll(pattern)) {
    if (match[keyGroup]) messageKeys.add(match[keyGroup]);
  }
}

collectMatches(indexSource, /\b_t\(\s*(['"])([^'"\r\n]+)\1/g, 2);
for (const match of indexSource.matchAll(/data-i18n(?:-[a-z-]+)?\s*=\s*(['"])(.*?)\1/g)) {
  messageKeys.add(match[2]
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&amp;', '&'));
}

const literalEntries = new Map();
const entryPattern = /^\s*"((?:\\.|[^"\\])*)"\s*:\s*"((?:\\.|[^"\\])*)"\s*,?\s*$/gm;
for (const match of localeSource.matchAll(entryPattern)) {
  const key = JSON.parse(`"${match[1]}"`);
  const value = JSON.parse(`"${match[2]}"`);
  if (literalEntries.has(key) && literalEntries.get(key) !== value) {
    failures.push(`Conflicting duplicate translation: ${key}`);
  }
  literalEntries.set(key, value);
}
if (literalEntries.size !== Object.keys(dictionary).length) {
  failures.push(
    `Locale entries must use one double-quoted literal pair per line: parsed ${literalEntries.size}, registered ${Object.keys(dictionary).length}`,
  );
}

for (const key of messageKeys) {
  if (typeof dictionary[key] !== 'string' || dictionary[key].trim() === '') {
    failures.push(`Missing translation: ${key}`);
  }
}

for (const [key, expected] of Object.entries(glossary)) {
  if (dictionary[key] !== expected) {
    failures.push(`Glossary mismatch: ${key} => expected "${expected}", received "${dictionary[key] || ''}"`);
  }
}

const shippedUiFiles = [
  ['index.html', indexSource],
  ['host/openshop-i18n.js', readFileSync(runtimePath, 'utf8')],
  ['locales/zh-CN.js', localeSource],
];
const mojibakePatterns = ['锟斤拷', '鐢', '鍥', '绗', 'Ã', 'â€'];
for (const [name, source] of shippedUiFiles) {
  for (const pattern of mojibakePatterns) {
    const offset = source.indexOf(pattern);
    if (offset >= 0) {
      failures.push(`Mojibake in ${name}:${lineNumberAt(source, offset)}: ${pattern}`);
    }
  }
}

const directLiteralPatterns = [
  {
    label: 'toast',
    pattern: /(?:\bthis\.)?\btoast\(\s*(['"`])([^\r\n]*?)\1/g,
  },
  {
    label: 'alert/confirm',
    pattern: /(?:\bwindow\.)?\b(?:alert|confirm)\(\s*(['"`])([^\r\n]*?)\1/g,
  },
  {
    label: 'modal heading',
    pattern: /<h[23](?![^>]*data-i18n)[^>]*>\s*([^<\r\n$][^<\r\n]*)<\/h[23]>/g,
  },
  {
    label: 'modal title',
    pattern: /\btitle\.textContent\s*=\s*(['"`])([^\r\n]*?)\1/g,
  },
];
for (const { label, pattern } of directLiteralPatterns) {
  for (const match of indexSource.matchAll(pattern)) {
    failures.push(
      `Direct ${label} literal at index.html:${lineNumberAt(indexSource, match.index)}: ${match[2] || match[1]}`,
    );
  }
}

const uniqueFailures = [...new Set(failures)].sort((left, right) => left.localeCompare(right, 'en'));
console.log(
  `OpenShop i18n audit: ${messageKeys.size} keys, ${messageKeys.size - uniqueFailures.filter((failure) => failure.startsWith('Missing translation:')).length} translated, ${Object.keys(glossary).length} glossary entries.`,
);
if (uniqueFailures.length > 0) {
  for (const failure of uniqueFailures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log('OpenShop i18n audit passed.');
}
