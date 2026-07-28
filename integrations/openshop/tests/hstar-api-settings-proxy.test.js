import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(testDir, '..', '..', '..');

describe('Hstar global API proxy preference', () => {
  it('renders, restores and saves a provider-specific system proxy toggle', () => {
    const html = readFileSync(resolve(rootDir, 'static', 'api-settings.html'), 'utf8');
    const script = readFileSync(resolve(rootDir, 'static', 'js', 'api-settings.js'), 'utf8');

    expect(html).toContain('id="systemProxyInput"');
    expect(script).toContain("const systemProxyInput = document.getElementById('systemProxyInput')");
    expect(script).toContain('systemProxyInput.checked = item.use_system_proxy !== false');
    expect(script).toContain('item.use_system_proxy = systemProxyInput.checked');
    expect(script).toContain('use_system_proxy:item.use_system_proxy !== false');
  });
});
