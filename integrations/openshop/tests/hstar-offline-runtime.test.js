import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(testDir, '..', 'index.html'), 'utf8');
const manifestPath = resolve(testDir, '..', 'vendor', 'runtime-manifest.json');

describe('Hstar OpenShop offline runtime', () => {
  it('uses only local browser runtime dependencies', () => {
    expect(html).toContain('./vendor/fabric-5.3.1.min.js');
    expect(html).toContain('./vendor/ag-psd-22.0.2.bundle.js');
    expect(html).toContain('./vendor/jspdf-4.2.1.umd.min.js');
    expect(html).not.toMatch(/<script[^>]+https?:\/\//i);
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/i);
  });

  it('records every shipped dependency with a digest and license', () => {
    const manifestExists = existsSync(manifestPath);
    expect(manifestExists).toBe(true);
    if (!manifestExists) return;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.length).toBeGreaterThanOrEqual(9);
    for (const file of manifest.files) {
      expect(file.path).toMatch(/^vendor\//);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.version).toBeTruthy();
      expect(file.license).toBeTruthy();
    }
  });
});
