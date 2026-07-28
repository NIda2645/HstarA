import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const auditScript = resolve('tools', 'audit-text-encoding.mjs');

function runFixtureAudit(file, contents) {
  const fixture = mkdtempSync(join(tmpdir(), 'hstara-encoding-scope-'));

  try {
    const badFile = join(fixture, file);
    mkdirSync(dirname(badFile), { recursive: true });
    writeFileSync(badFile, contents);
    const init = spawnSync('git', ['init', '--quiet'], { cwd: fixture, encoding: 'utf8' });
    assert.equal(init.status, 0, init.stderr);

    return spawnSync(process.execPath, [auditScript], {
      cwd: fixture,
      encoding: 'utf8',
    });
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

test('text encoding audit includes untracked static files', () => {
  const result = runFixtureAudit('static/new-page.html', '<p>\uFFFD</p>');
  assert.notEqual(result.status, 0, 'untracked static file must be audited');
  assert.match(result.stderr, /static[/\\]new-page\.html:1:replacement-character/);
});

test('text encoding audit includes untracked desktop shell files', () => {
  const result = runFixtureAudit('desktop/Hstar.Desktop/NewWindow.xaml', '<Window Title="\uFFFD" />');
  assert.notEqual(result.status, 0, 'untracked desktop shell file must be audited');
  assert.match(result.stderr, /desktop[/\\]Hstar\.Desktop[/\\]NewWindow\.xaml:1:replacement-character/);
});

test('text encoding audit includes root user-facing documents', () => {
  const result = runFixtureAudit('LICENSE', 'Hstar \uFFFD');
  assert.notEqual(result.status, 0, 'root user-facing documents must be audited');
  assert.match(result.stderr, /LICENSE:1:replacement-character/);
});

test('text encoding audit includes 3D Director source files', () => {
  const result = runFixtureAudit(
    'integrations/storyai-3d-director-desk/src/NewPanel.tsx',
    'export const title = "\uFFFD";',
  );
  assert.notEqual(result.status, 0, '3D Director source must be audited');
  assert.match(
    result.stderr,
    /integrations[/\\]storyai-3d-director-desk[/\\]src[/\\]NewPanel\.tsx:1:replacement-character/,
  );
});

test('text encoding audit ignores replacement-character regex literals in TypeScript', () => {
  const result = runFixtureAudit(
    'integrations/storyai-3d-director-desk/src/encoding.ts',
    'export const replacementCharacter = /\uFFFD/u;',
  );
  assert.equal(result.status, 0, result.stderr);
});
