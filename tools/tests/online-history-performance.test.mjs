import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const onlineHtml = readFileSync(join(repoRoot, 'static', 'online.html'), 'utf8');

assert.match(onlineHtml, /const PAGE_SIZE = 16;/);
assert.ok(
  onlineHtml.includes('`/api/history?type=online&paged=1&offset=${historyOffset}&limit=${PAGE_SIZE}`'),
  'online history must request one bounded backend page',
);
assert.match(onlineHtml, /historyOffset = page\.next_offset/);
assert.match(onlineHtml, /historyHasMore = Boolean\(page\.has_more\)/);
assert.doesNotMatch(onlineHtml, /new\s+IntersectionObserver\s*\(/);
assert.match(
  onlineHtml,
  /document\.getElementById\('loadMoreTrigger'\)\.onclick = \(\) => loadHistory\(false\)/,
);

const pythonEnv = {
  ...process.env,
  PYTHONIOENCODING: 'utf-8',
  PYTHONUTF8: '1',
};

const bundledCandidates = process.platform === 'win32'
  ? [join(repoRoot, 'python', 'python.exe')]
  : [join(repoRoot, 'python', 'bin', 'python3'), join(repoRoot, 'python', 'bin', 'python')];
const fallbackCandidates = process.platform === 'win32'
  ? [{ command: 'py', args: ['-3'] }, { command: 'python', args: [] }]
  : [{ command: 'python3', args: [] }, { command: 'python', args: [] }];
const pythonCandidates = [
  ...bundledCandidates.filter(existsSync).map((command) => ({ command, args: [] })),
  ...fallbackCandidates,
];

const python = pythonCandidates.find(({ command, args }) => {
  const probe = spawnSync(
    command,
    [...args, '-X', 'utf8', '-c', 'import fastapi, httpx, PIL, pydantic, requests'],
    { cwd: repoRoot, encoding: 'utf8', env: pythonEnv },
  );
  return !probe.error && probe.status === 0;
});

assert.ok(python, 'No usable Python interpreter could import the application dependencies');

const tempDir = mkdtempSync(join(tmpdir(), 'hstar-online-history-'));
const historyFile = join(tempDir, 'history.json');

const records = [
  { timestamp: 1, type: 'online', images: ['/output/1.png'] },
  { timestamp: 4, type: 'online', images: ['/output/4.png'] },
  { timestamp: 3, type: 'angle', images: ['/output/3.png'] },
  { timestamp: 2, type: 'online', images: ['/output/2.png'] },
  { timestamp: 5, type: 'online', images: [] },
];

writeFileSync(historyFile, JSON.stringify(records), 'utf8');

const pythonScript = String.raw`
import asyncio
import json
import os
import sys

sys.path.insert(0, os.getcwd())
import main

main.HISTORY_FILE = sys.argv[1]

async def run():
    legacy = await main.get_history_api(type="online")
    first = await main.get_history_api(type="online", paged=True, offset=0, limit=2)
    second = await main.get_history_api(type="online", paged=True, offset=2, limit=2)
    clamped = await main.get_history_api(type="online", paged=True, offset=-9, limit=999)
    with open(main.HISTORY_FILE, "w", encoding="utf-8") as file:
        json.dump({"unexpected": "shape"}, file)
    invalid_legacy = await main.get_history_api(type="online")
    print(json.dumps({
        "legacy": legacy,
        "first": first,
        "second": second,
        "clamped": clamped,
        "invalid_legacy": invalid_legacy,
    }))

asyncio.run(run())
`;

try {
  const result = spawnSync(python.command, [...python.args, '-X', 'utf8', '-c', pythonScript, historyFile], {
    cwd: repoRoot,
    encoding: 'utf8',
    env: pythonEnv,
  });

  assert.ok(!result.error, `Failed to launch Python interpreter: ${result.error?.message}`);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const output = JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));

  assert.deepEqual(output.legacy.map((item) => item.timestamp), [4, 2, 1]);
  assert.ok(Array.isArray(output.legacy), 'legacy mode must return a plain array');

  assert.deepEqual(output.first.items.map((item) => item.timestamp), [4, 2]);
  assert.deepEqual(
    {
      total: output.first.total,
      offset: output.first.offset,
      next_offset: output.first.next_offset,
      has_more: output.first.has_more,
    },
    { total: 3, offset: 0, next_offset: 2, has_more: true },
  );

  assert.deepEqual(output.second.items.map((item) => item.timestamp), [1]);
  assert.deepEqual(
    {
      total: output.second.total,
      offset: output.second.offset,
      next_offset: output.second.next_offset,
      has_more: output.second.has_more,
    },
    { total: 3, offset: 2, next_offset: null, has_more: false },
  );

  assert.deepEqual(output.clamped.items.map((item) => item.timestamp), [4, 2, 1]);
  assert.deepEqual(
    {
      total: output.clamped.total,
      offset: output.clamped.offset,
      next_offset: output.clamped.next_offset,
      has_more: output.clamped.has_more,
    },
    { total: 3, offset: 0, next_offset: null, has_more: false },
  );
  assert.deepEqual(output.invalid_legacy, [], 'legacy read failures must still return an empty array');

  console.log('online history pagination tests passed');
} finally {
  rmSync(tempDir, { recursive: true, force: true });
}
