import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const html = readFileSync(resolve(testDir, '..', 'index.html'), 'utf8');
const manifestPath = resolve(testDir, '..', 'vendor', 'runtime-manifest.json');
const buildScript = readFileSync(resolve(testDir, '..', 'scripts', 'build-hstar.mjs'), 'utf8');

describe('Hstar OpenShop offline runtime', () => {
  it('uses only local browser runtime dependencies', () => {
    expect(html).toContain('./vendor/fabric-5.3.1.min.js');
    expect(html).toContain('./vendor/ag-psd-22.0.2.bundle.js');
    expect(html).toContain('./vendor/jspdf-4.2.1.umd.min.js');
    expect(html).toContain("_psdLibUrl: './vendor/ag-psd-22.0.2.bundle.js'");
    expect(html).toContain("_photonFilterUrl: './vendor/photon/photon_rs.js'");
    expect(html).toContain('new URL(this._photonFilterUrl, window.location.href).href');
    expect(html).toContain("'./vendor/gif/gif.js'");
    expect(html).toContain("workerScript: './vendor/gif/gif.worker.js'");
    expect(html).toContain("import('./vendor/transformers/transformers.web.min.js')");
    expect(html).toContain('<link rel="stylesheet" href="./host/openshop-text-properties.css">');
    expect(html).toContain('<script src="./host/openshop-text-properties.js"></script>');
    expect(html).toContain('HstarOpenShopTextProperties.createController');
    expect(buildScript).toContain("'host/openshop-text-properties.js'");
    expect(buildScript).toContain("'host/openshop-text-properties.css'");
    expect(html).toContain('_precacheRuntime()');
    expect(html).not.toMatch(/<script[^>]+https?:\/\//i);
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/i);
    expect(html).not.toMatch(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/i);
    expect(html).toMatch(/script-src 'self' 'unsafe-inline' blob:/);
  });

  it('records every shipped dependency with a digest and license', () => {
    const manifestExists = existsSync(manifestPath);
    expect(manifestExists).toBe(true);
    if (!manifestExists) return;

    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files.length).toBeGreaterThanOrEqual(9);
    expect(manifest.files.map((file) => file.path)).toEqual(expect.arrayContaining([
      'vendor/transformers/ort-wasm-simd-threaded.jsep.mjs',
      'vendor/transformers/ort-wasm-simd-threaded.jsep.wasm',
    ]));
    for (const file of manifest.files) {
      expect(file.path).toMatch(/^vendor\//);
      expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(file.version).toBeTruthy();
      expect(file.license).toBeTruthy();
    }
  });
});
