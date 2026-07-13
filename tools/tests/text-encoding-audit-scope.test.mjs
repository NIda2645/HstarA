import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const auditScript = resolve('tools', 'audit-text-encoding.mjs');

test('text encoding audit includes untracked static files', () => {
  const fixture = mkdtempSync(join(tmpdir(), 'hstara-encoding-scope-'));

  try {
    const badFile = join(fixture, 'static', 'new-page.html');
    mkdirSync(dirname(badFile), { recursive: true });
    writeFileSync(badFile, '<p>\uFFFD</p>');
    const init = spawnSync('git', ['init', '--quiet'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);

    const result = spawnSync(process.execPath, [auditScript], {
      cwd: fixture,
      encoding: 'utf8',
    });

    assert.notEqual(result.status, 0, 'untracked static file must be audited');
    assert.match(result.stderr, /static[/\\]new-page\.html:1:replacement-character/);
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
});
