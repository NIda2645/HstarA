import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const testDir = dirname(fileURLToPath(import.meta.url));
const probePath = resolve(testDir, '..', 'scripts', 'psd-text-probe.mjs');

describe('OpenShop editable text PSD probe', () => {
  it('defines Chinese and English editable text layers', async () => {
    expect(existsSync(probePath), `${probePath} should exist`).toBe(true);
    const { createTextProbePsd } = await import(`${pathToFileURL(probePath).href}?test=${Date.now()}`);
    const psd = createTextProbePsd();

    expect(psd.width).toBe(1024);
    expect(psd.height).toBe(512);
    expect(psd.children).toHaveLength(2);
    expect(psd.children[0].text.text).toBe('经典奶茶');
    expect(psd.children[0].text.style.font.name).toBe('MicrosoftYaHei');
    expect(psd.children[0].text.style.fontSize).toBe(72);
    expect(psd.children[1].text.text).toBe('Classic Milk Tea');
    expect(psd.children[1].text.style.font.name).toBe('ArialMT');
    expect(psd.children[1].text.style.fontSize).toBe(58);
  });
});
