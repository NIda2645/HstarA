import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const servicePath = resolve(testDir, '..', 'host', 'openshop-export-service.js');
const buildPath = resolve(testDir, '..', 'scripts', 'build-hstar.mjs');
const indexPath = resolve(testDir, '..', 'index.html');
const projectRoot = resolve(testDir, '..', '..', '..');
const hostPath = resolve(projectRoot, 'static', 'js', 'openshop-host.js');
const shellPath = resolve(projectRoot, 'static', 'index.html');
const classicPath = resolve(projectRoot, 'static', 'canvas.html');
const smartPath = resolve(projectRoot, 'static', 'smart-canvas.html');
const serviceExists = existsSync(servicePath);

function loadService() {
  delete window.HstarOpenShopExportService;
  window.eval(readFileSync(servicePath, 'utf8'));
  return window.HstarOpenShopExportService;
}

describe('OpenShop export service availability', () => {
  it('provides a dedicated runtime module', () => {
    expect(serviceExists).toBe(true);
  });

  it('publishes the service in the approved runtime tree', () => {
    expect(readFileSync(buildPath, 'utf8')).toContain("'host/openshop-export-service.js'");
  });

  it('loads the export service before the host runtime', () => {
    const html = readFileSync(indexPath, 'utf8');
    const serviceIndex = html.indexOf('./host/openshop-export-service.js');
    const runtimeIndex = html.indexOf('./host/openshop-host-runtime.js');
    expect(serviceIndex).toBeGreaterThan(-1);
    expect(serviceIndex).toBeLessThan(runtimeIndex);
  });

  it('uses one cache revision across every OpenShop entry point', () => {
    const host = readFileSync(hostPath, 'utf8');
    const revision = host.match(/OPENSHOP_RUNTIME_REVISION\s*=\s*'([^']+)'/)?.[1];
    const shell = readFileSync(shellPath, 'utf8');
    const classic = readFileSync(classicPath, 'utf8');
    const smart = readFileSync(smartPath, 'utf8');
    const editor = readFileSync(indexPath, 'utf8');

    expect(revision).toMatch(/^\d{4}\.\d{2}\.\d{2}\.[0-9.]+$/);
    expect(shell).toContain(`/static/css/openshop-host.css?v=${revision}`);
    expect(shell).toContain(`/static/openshop/host/openshop-protocol.js?v=${revision}`);
    expect(shell).toContain(`/static/js/openshop-host.js?v=${revision}`);
    expect(classic).toContain(`/static/js/canvas-openshop.js?v=${revision}`);
    expect(smart).toContain(`/static/js/smart-canvas-openshop.js?v=${revision}`);
    expect(editor).toContain(`./host/openshop-protocol.js?v=${revision}`);
    expect(editor).toContain(`./host/openshop-project-adapter.js?v=${revision}`);
    expect(editor).toContain(`./host/openshop-export-service.js?v=${revision}`);
    expect(editor).toContain(`./host/openshop-host-runtime.js?v=${revision}`);
    expect(editor).toContain(`./host/openshop-font-catalog.js?v=${revision}`);
    expect(editor).toContain(`./host/openshop-writing-mode.css?v=${revision}`);
    expect(editor).toContain(`./host/openshop-writing-mode.js?v=${revision}`);
    expect(editor).toContain(`./host/openshop-text-tools.js?v=${revision}`);
  });
});

describe.skipIf(!serviceExists)('OpenShop export service', () => {
  beforeEach(() => {
    localStorage.clear();
    loadService();
  });

  it('downloads a generated artifact through the browser channel', async () => {
    const fetchImpl = vi.fn();
    const downloadImpl = vi.fn();
    const service = window.HstarOpenShopExportService.create({
      generators: {
        png: vi.fn(async () => ({
          blob: new Blob(['png']),
          filename: 'design.png',
          mimeType: 'image/png',
          format: 'png',
          width: 3840,
          height: 2160,
        })),
      },
      fetchImpl,
      downloadImpl,
      storage: localStorage,
    });

    const result = await service.saveFormat('png');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(downloadImpl).toHaveBeenCalledWith(expect.any(Blob), 'design.png');
    expect(result.filename).toBe('design.png');
    expect(result.cancelled).toBe(false);
  });

  it('does not consult the legacy output-folder setting for one file', async () => {
    const fetchImpl = vi.fn();
    const downloadImpl = vi.fn();
    const service = window.HstarOpenShopExportService.create({
      generators: {
        png: async () => ({
          blob: new Blob(['x']),
          filename: 'cached.png',
          mimeType: 'image/png',
          format: 'png',
          width: 1,
          height: 1,
        }),
      },
      fetchImpl,
      downloadImpl,
      storage: localStorage,
    });

    await service.saveFormat('png');

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(downloadImpl).toHaveBeenCalledOnce();
  });

  it('generates every artifact before making one batch request', async () => {
    const order = [];
    const fetchImpl = vi.fn();
    const downloadBatchImpl = vi.fn();
    const service = window.HstarOpenShopExportService.create({
      generators: {
        png: async () => {
          order.push('png');
          return {
            blob: new Blob(['png']), filename: 'x.png', mimeType: 'image/png',
            format: 'png', width: 10, height: 10,
          };
        },
        pdf: async () => {
          order.push('pdf');
          return {
            blob: new Blob(['pdf']), filename: 'x.pdf', mimeType: 'application/pdf',
            format: 'pdf', width: 10, height: 10,
          };
        },
      },
      fetchImpl,
      downloadBatchImpl,
      storage: localStorage,
    });

    await service.saveBatch(['png', 'pdf']);

    expect(order).toEqual(['png', 'pdf']);
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(downloadBatchImpl).toHaveBeenCalledOnce();
    expect(downloadBatchImpl.mock.calls[0][0].map(item => item.filename)).toEqual(['x.png', 'x.pdf']);
  });

  it('makes no request when any batch artifact fails', async () => {
    const fetchImpl = vi.fn();
    const service = window.HstarOpenShopExportService.create({
      generators: {
        png: async () => ({
          blob: new Blob(['png']), filename: 'x.png', mimeType: 'image/png',
          format: 'png', width: 10, height: 10,
        }),
        pdf: async () => { throw new Error('pdf failed'); },
      },
      fetchImpl,
      storage: localStorage,
    });

    await expect(service.saveBatch(['png', 'pdf'])).rejects.toThrow('pdf failed');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('rejects malformed artifacts and surfaces bounded API errors', async () => {
    const malformed = window.HstarOpenShopExportService.create({
      generators: { png: async () => ({ filename: 'missing.png' }) },
      fetchImpl: vi.fn(),
      storage: localStorage,
    });
    await expect(malformed.createArtifact('png')).rejects.toThrow('did not produce a Blob');

    const fetchImpl = vi.fn();
    const service = window.HstarOpenShopExportService.create({
      generators: {
        png: async () => ({
          blob: new Blob(['x']), filename: 'x.png', mimeType: 'image/png',
          format: 'png', width: 1, height: 1,
        }),
      },
      fetchImpl,
      downloadImpl:vi.fn(),
      downloadBatchImpl:vi.fn(async () => { throw new Error('folder failed'); }),
      storage: localStorage,
    });
    await expect(service.saveBatch(['png'])).rejects.toThrow('folder failed');
  });
});
