import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const htmlPath = new URL('../../static/gpt-chat.html', import.meta.url);
const html = readFileSync(htmlPath, 'utf8');

assert.match(
  html,
  /html\s*\{[^}]*height:\s*100%[^}]*overflow:\s*hidden[^}]*\}/s,
  'GPT chat must lock the iframe document to the viewport so wheel input cannot scroll the whole page',
);
assert.match(
  html,
  /\.messages\s*\{[^}]*overflow-y:\s*auto[^}]*\}/s,
  'the message list remains the only vertical scroll surface',
);
assert.match(
  html,
  /\.composer-wrap\s*\{[^}]*position:\s*sticky[^}]*bottom:\s*0[^}]*z-index:\s*(?:[1-9]\d*)[^}]*\}/s,
  'the composer is a raised bottom-docked grid item',
);

console.log('GPT chat composer dock contract passed');
