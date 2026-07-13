import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const healthCheck = resolve('tools', 'tests', 'hstarc-health-check.mjs');

test('health check ignores nested Git worktrees', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hstara-health-worktree-'));

  try {
    const indexPath = join(fixture, 'static', 'index.html');
    const staleFile = join(fixture, '.worktrees', 'paused', 'static', 'bad.js');
    mkdirSync(dirname(indexPath), { recursive: true });
    mkdirSync(dirname(staleFile), { recursive: true });
    writeFileSync(
      indexPath,
      '<script>__hstarSafeMutationObserverObserve</script><script src="/static/vendor/js/tailwindcss-cdn.js"></script>',
    );
    writeFileSync(staleFile, '\u0001');

    const result = spawnSync(process.execPath, [healthCheck], {
      cwd: fixture,
      encoding: 'utf8',
    });

    assert.equal(result.status, 0, result.stderr || result.stdout);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
