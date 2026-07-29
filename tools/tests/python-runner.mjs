import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const explicitPython = process.env.HSTAR_TEST_PYTHON || process.env.PYTHON;
const localPython = resolve(process.cwd(), 'python', 'python.exe');

const pythonCandidates = explicitPython
  ? [{ command: explicitPython, args: [] }]
  : [
      ...(existsSync(localPython) ? [{ command: localPython, args: [] }] : []),
      { command: 'python3', args: [] },
      { command: 'python', args: [] },
      { command: 'py', args: ['-3'] },
    ];

export function execPythonSync(script, options = {}) {
  const failures = [];
  const testRoot = mkdtempSync(join(tmpdir(), 'hstar-python-test-'));
  const environment = {
    ...process.env,
    APPDATA: join(testRoot, 'appdata'),
    LOCALAPPDATA: join(testRoot, 'localappdata'),
    HSTAR_PROGRAM_DIR: process.cwd(),
    HSTAR_DATA_DIR: join(testRoot, 'data'),
    HSTAR_EDITION: 'development',
    HSTAR_DISABLE_AUTO_UPDATE: '1',
    ...options.env,
  };

  try {
    for (const candidate of pythonCandidates) {
      try {
        return execFileSync(
          candidate.command,
          [...candidate.args, '-X', 'utf8', '-c', script],
          { encoding: 'utf8', ...options, env: environment },
        );
      } catch (error) {
        if (explicitPython || typeof error.status === 'number') {
          throw error;
        }
        failures.push(candidate.command + ': ' + (error.code || error.message));
      }
    }

    throw new Error('Unable to start Python for test helper. Tried: ' + failures.join('; '));
  } finally {
    rmSync(testRoot, { recursive: true, force: true });
  }
}
