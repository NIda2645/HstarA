import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync('static/js/canvas-director.js', 'utf8');
const lucideBundle = readFileSync('static/vendor/js/lucide.js', 'utf8');

function toPascalCase(iconName) {
  return iconName.split('-').map((part) => part[0].toUpperCase() + part.slice(1)).join('');
}

test('canvas director panorama icons exist in the bundled Lucide runtime', () => {
  const iconExpression = source.match(/panorama\s*\?\s*'([^']+)'\s*:\s*'([^']+)'/);
  assert.ok(iconExpression, 'director panorama icon expression must remain discoverable');

  for (const iconName of iconExpression.slice(1)) {
    assert.ok(
      lucideBundle.includes(toPascalCase(iconName)),
      `bundled Lucide runtime does not provide ${iconName}`,
    );
  }
});
