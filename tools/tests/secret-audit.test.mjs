import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import test from 'node:test';

const auditScript = resolve('tools', 'audit-secrets.mjs');

function runFixture(files) {
  const fixture = mkdtempSync(join(tmpdir(), 'hstara-secret-audit-'));
  try {
    for (const [file, contents] of Object.entries(files)) {
      const target = join(fixture, file);
      mkdirSync(dirname(target), {recursive:true});
      writeFileSync(target, contents, 'utf8');
    }
    const init = spawnSync('git', ['init', '--quiet'], {cwd:fixture, encoding:'utf8'});
    assert.equal(init.status, 0, init.stderr);
    return spawnSync(process.execPath, [auditScript], {cwd:fixture, encoding:'utf8'});
  } finally {
    rmSync(fixture, {recursive:true, force:true});
  }
}

test('secret audit rejects standard private key and provider token formats', () => {
  const privateKeyHeader = ['-----BEGIN', 'PRIVATE KEY-----'].join(' ');
  const result = runFixture({
    'src/private.pem': `${privateKeyHeader}\nnot-real\n-----END PRIVATE KEY-----`,
    'src/config.js': `export const token = '${'ghp_' + 'A'.repeat(40)}';`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src[/\\]private\.pem:1:private-key/);
  assert.match(result.stderr, /src[/\\]config\.js:1:github-token/);
});

test('secret audit accepts placeholders and ignores binary files', () => {
  const result = runFixture({
    'src/config.js': 'export const apiKey = "YOUR_API_KEY";',
    'assets/image.bin': Buffer.from([0, 1, 2, 3]),
  });
  assert.equal(result.status, 0, result.stderr);
});

test('secret audit rejects fine-grained GitHub tokens', () => {
  const result = runFixture({
    'src/config.js': `export const token = '${'github_pat_' + 'A'.repeat(24)}';`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src[/\\]config\.js:1:github-fine-grained-token/);
});

test('secret audit scans text files larger than two MiB', () => {
  const result = runFixture({
    'src/large.js': `${'x'.repeat(2 * 1024 * 1024 + 1)}\n${'ghp_' + 'B'.repeat(40)}`,
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /src[/\\]large\.js:2:github-token/);
});
