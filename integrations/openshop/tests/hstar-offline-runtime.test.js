import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const integrationRoot = resolve(testDir, '..');
const projectRoot = resolve(integrationRoot, '..', '..');
const staticRoot = resolve(projectRoot, 'static', 'openshop');
const html = readFileSync(resolve(integrationRoot, 'index.html'), 'utf8');
const backendSource = readFileSync(resolve(projectRoot, 'main.py'), 'utf8');
const openShopRuntimeRevision = backendSource.match(/OPENSHOP_RUNTIME_REVISION\s*=\s*["']([^"']+)["']/)?.[1];
const manifestPath = resolve(integrationRoot, 'vendor', 'runtime-manifest.json');
const buildScript = readFileSync(resolve(integrationRoot, 'scripts', 'build-hstar.mjs'), 'utf8');

describe('Hstar OpenShop offline runtime', () => {
  it('uses one cache revision for every mutable local runtime asset', () => {
    const runtimeRevision = html.match(/openshop-text-tools\.js\?v=([0-9.]+)/)?.[1];
    const mutableRefs = [...html.matchAll(/(?:src|href)="(\.\/(?:host|locales)\/[^"?]+)(?:\?v=([^"?]+))?"/g)];

    expect(runtimeRevision).toBeTruthy();
    expect(mutableRefs.length).toBeGreaterThan(20);
    mutableRefs.forEach(([, asset, revision]) => {
      expect(revision, `${asset} should use the OpenShop runtime revision`).toBe(runtimeRevision);
    });
  });

  it('ships every mutable local runtime asset referenced by the editor', () => {
    const runtimeAssets = [...html.matchAll(/(?:src|href)="\.\/((?:host|locales)\/[^"?]+)(?:\?v=[^"?]+)?"/g)]
      .map(([, asset]) => asset);

    expect(runtimeAssets.length).toBeGreaterThan(20);
    runtimeAssets.forEach((asset) => {
      expect(buildScript, `${asset} should be included in the approved runtime tree`)
        .toContain(`'${asset}'`);
    });
  });

  it('uses only local browser runtime dependencies', () => {
    const runtimeRevision = html.match(/openshop-text-tools\.js\?v=([0-9.]+)/)?.[1];
    expect(runtimeRevision).toBeTruthy();
    expect(html).toContain('./vendor/fabric-5.3.1.min.js');
    expect(html).toContain('./vendor/ag-psd-22.0.2.bundle.js');
    expect(html).toContain('./vendor/jspdf-4.2.1.umd.min.js');
    expect(html).toContain("_psdLibUrl: './vendor/ag-psd-22.0.2.bundle.js'");
    expect(html).toContain("_photonFilterUrl: './vendor/photon/photon_rs.js'");
    expect(html).toContain('new URL(this._photonFilterUrl, window.location.href).href');
    expect(html).toContain("'./vendor/gif/gif.js'");
    expect(html).toContain("workerScript: './vendor/gif/gif.worker.js'");
    expect(html).toContain("import('./vendor/transformers/transformers.web.min.js')");
    expect(html).toContain(`<link rel="stylesheet" href="./host/openshop-text-properties.css?v=${runtimeRevision}">`);
    expect(html).toContain(`<script src="./host/openshop-text-properties.js?v=${runtimeRevision}"></script>`);
    expect(html).toContain('HstarOpenShopTextProperties.createController');
    expect(html).toContain(`<link rel="stylesheet" href="./host/openshop-writing-mode.css?v=${runtimeRevision}">`);
    expect(html).toContain(`<script src="./host/openshop-writing-mode.js?v=${runtimeRevision}"></script>`);
    expect(html.indexOf('./host/openshop-writing-mode.js'))
      .toBeLessThan(html.indexOf('./host/openshop-text-tools.js'));
    expect(html).toContain(`<script src="./host/openshop-canvas-sampler.js?v=${runtimeRevision}"></script>`);
    expect(html).toContain(`<script src="./host/openshop-update-scheduler.js?v=${runtimeRevision}"></script>`);
    expect(buildScript).toContain("'host/openshop-text-properties.js'");
    expect(buildScript).toContain("'host/openshop-text-properties.css'");
    expect(buildScript).toContain("'host/openshop-writing-mode.js'");
    expect(buildScript).toContain("'host/openshop-writing-mode.css'");
    expect(buildScript).toContain("'host/openshop-canvas-sampler.js'");
    expect(buildScript).toContain("'host/openshop-update-scheduler.js'");
    expect(html).not.toContain('_precacheRuntime()');
    expect(html).not.toMatch(/<script[^>]+https?:\/\//i);
    expect(html).not.toMatch(/fonts\.googleapis\.com|fonts\.gstatic\.com/i);
    expect(html).not.toMatch(/cdn\.jsdelivr\.net|cdnjs\.cloudflare\.com/i);
    expect(html).toMatch(/script-src 'self' 'unsafe-inline' blob:/);
  });

  it('does not create an unused Cache Storage copy without a service worker', () => {
    expect(html).not.toMatch(/caches\.(?:open|keys|delete)\(/);
    expect(html).not.toMatch(/serviceWorker\.register\(/);
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

  it('keeps the checked-in static writing-mode runtime synchronized', () => {
    const files = [
      'host/openshop-selection-engine.js',
      'host/openshop-writing-mode.js',
      'host/openshop-writing-mode.css',
      'host/openshop-text-tools.js',
      'host/openshop-font-catalog.js',
    ];
    const available = files.every(file => {
      const exists = existsSync(resolve(staticRoot, file));
      expect(exists, `${file} should exist in static/openshop`).toBe(true);
      return exists;
    });
    if(!available) return;

    const staticHtml = readFileSync(resolve(staticRoot, 'index.html'), 'utf8');
    const staticRuntimeRevision = staticHtml.match(/openshop-text-tools\.js\?v=([0-9.]+)/)?.[1];
    expect(openShopRuntimeRevision).toBeTruthy();
    expect(staticRuntimeRevision).toBe(openShopRuntimeRevision);
    expect(staticHtml).toContain(`<link rel="stylesheet" href="./host/openshop-writing-mode.css?v=${staticRuntimeRevision}">`);
    expect(staticHtml).toContain(`<script src="./host/openshop-writing-mode.js?v=${staticRuntimeRevision}"></script>`);
    expect(staticHtml.indexOf('./host/openshop-writing-mode.js'))
      .toBeLessThan(staticHtml.indexOf('./host/openshop-text-tools.js'));
    files.forEach(file => {
      expect(readFileSync(resolve(staticRoot, file)))
        .toEqual(readFileSync(resolve(integrationRoot, file)));
    });
    expect(readFileSync(resolve(staticRoot, 'host/openshop-selection-engine.js'), 'utf8'))
      .toContain('maskRegions');
  });
});
