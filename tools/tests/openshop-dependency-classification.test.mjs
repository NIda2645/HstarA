import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const packagePath = path.resolve('integrations/openshop/package.json');
const packageJson = JSON.parse(fs.readFileSync(packagePath, 'utf8'));

test('OpenShop browser runtime builders stay out of production dependencies', () => {
  const buildOnlyPackages = [
    '@huggingface/transformers',
    '@silvia-odwyer/photon',
    'ag-psd',
    'gif.js',
    'jspdf',
  ];

  for (const packageName of buildOnlyPackages) {
    assert.equal(
      packageJson.dependencies?.[packageName],
      undefined,
      `${packageName} is build/vendor-only and must not be a production dependency`,
    );
    assert.ok(
      packageJson.devDependencies?.[packageName],
      `${packageName} must remain available to the deterministic vendor build`,
    );
  }
});

console.log('OpenShop dependency classification tests passed');
