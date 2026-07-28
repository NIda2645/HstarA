import assert from 'node:assert/strict';
import {encodingIssueKind} from '../text-encoding-rules.mjs';

const broken = [
  '鑷姩',
  '濂虫€х編濡?',
  '`鍥?{index + 1}`',
  '<div>缁煎悎鎺у埗鍣?/div>',
  '浜虹墿宸?5掳',
];

for(const sample of broken) {
  assert.equal(encodingIssueKind(sample), 'chinese-mojibake', `should reject ${sample}`);
}

for(const sample of ['自动', '女性美妆', '`图${index + 1}`', '<div>综合控制器</div>', '人物左45°']) {
  assert.equal(encodingIssueKind(sample), '', `should accept ${sample}`);
}

console.log('Text encoding rule tests passed');
