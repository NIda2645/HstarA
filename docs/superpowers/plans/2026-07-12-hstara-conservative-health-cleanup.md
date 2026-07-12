# HstarA Conservative Health Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove only approved regenerable caches from the active HstarA engineering repository and prove that application behavior, user data, and the stable installation remain unchanged.

**Architecture:** Perform an allowlist-only cleanup in the active repository because the targets are ignored local build caches that do not exist in a clean worktree. Resolve and validate every absolute target before deletion, preserve protected paths, then run the complete existing verification suite.

**Tech Stack:** PowerShell, Git, Node.js, embedded Python, FastAPI health endpoint, Vitest

---

### Task 1: Capture the pre-clean safety baseline

**Files:**
- Read: `API/.env`
- Read: `build/installer/stage/`
- Read: `integrations/storyai-3d-director-desk/node_modules/`
- Read: `integrations/` (all contents except the explicit cleanup allowlist are protected)
- Read: `python/`

- [ ] **Step 1: Confirm repository state and the engineering server**

Run:

```powershell
git status --short --branch
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess
Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess
```

Expected: the branch is `main`; port 3000 belongs to the engineering server; record any port-5000 PID without stopping or modifying it.

- [ ] **Step 2: Record protected-path and API configuration fingerprints**

Run:

```powershell
$protected = @(
  'API',
  'build/installer/stage',
  'integrations/storyai-3d-director-desk/node_modules',
  'python'
)
$protected | ForEach-Object {
  [pscustomobject]@{ Path = $_; Exists = Test-Path -LiteralPath $_ }
}
Get-FileHash -LiteralPath 'API/.env' -Algorithm SHA256
```

Expected: `API`, embedded Python, Director dependencies, and installer staging retain their current existence state; save the `API/.env` hash for the post-clean comparison.

- [ ] **Step 3: Resolve the cleanup allowlist and reject escaped paths**

Run:

```powershell
$repo = (Resolve-Path -LiteralPath '.').Path
$allowlist = @(
  (Join-Path $repo '__pycache__'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/tsconfig.node.tsbuildinfo'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/tsconfig.tsbuildinfo'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/vite.config.d.ts'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/vite.config.js')
)
$resolvedAllowlist = foreach ($candidate in $allowlist) {
  if (-not (Test-Path -LiteralPath $candidate)) { continue }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  if (-not $resolved.StartsWith($repo + [IO.Path]::DirectorySeparatorChar, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Cleanup target escaped repository root: $resolved"
  }
  $resolved
}
$resolvedAllowlist
```

Expected: every printed path is beneath the active HstarA repository and is one of the five explicit candidates.

### Task 2: Delete only the approved caches

**Files:**
- Delete: `__pycache__/`
- Delete: `integrations/storyai-3d-director-desk/tsconfig.node.tsbuildinfo`
- Delete: `integrations/storyai-3d-director-desk/tsconfig.tsbuildinfo`
- Delete: `integrations/storyai-3d-director-desk/vite.config.d.ts`
- Delete: `integrations/storyai-3d-director-desk/vite.config.js`

- [ ] **Step 1: Remove the previously validated allowlist**

Run in the same PowerShell session that created `$resolvedAllowlist`:

```powershell
foreach ($target in $resolvedAllowlist) {
  if ((Get-Item -LiteralPath $target).PSIsContainer) {
    Remove-Item -LiteralPath $target -Recurse -Force
  } else {
    Remove-Item -LiteralPath $target -Force
  }
}
```

Expected: only the approved regenerable paths are removed.

- [ ] **Step 2: Confirm cleanup targets are absent**

Run:

```powershell
$allowlist | ForEach-Object {
  [pscustomobject]@{ Path = $_; Exists = Test-Path -LiteralPath $_ }
}
```

Expected: all five entries report `Exists = False`.

- [ ] **Step 3: Confirm protected paths and API configuration are unchanged**

Run:

```powershell
$protected | ForEach-Object {
  [pscustomobject]@{ Path = $_; Exists = Test-Path -LiteralPath $_ }
}
Get-FileHash -LiteralPath 'API/.env' -Algorithm SHA256
git status --short --branch
```

Expected: protected-path existence matches Task 1, the `API/.env` hash is identical, and Git shows no cleanup-related source changes.

### Task 3: Run complete verification

**Files:**
- Test: `tools/tests/*.test.mjs`
- Test: `tools/tests/hstarc-health-check.mjs`
- Test: `integrations/storyai-3d-director-desk/src/**/*.test.*`
- Validate: all tracked `*.json`, `*.js`, `*.mjs`, and `*.py`

- [ ] **Step 1: Run every root Node test**

Run:

```powershell
$tests = Get-ChildItem -LiteralPath 'tools/tests' -Filter '*.test.mjs' | Sort-Object Name
foreach ($test in $tests) {
  node $test.FullName
  if ($LASTEXITCODE -ne 0) { throw "Root test failed: $($test.Name)" }
}
"Root tests passed: $($tests.Count)"
```

Expected: all 52 root test files pass.

- [ ] **Step 2: Run the complete 3D Director suite**

Run:

```powershell
npm test
```

Working directory: `integrations/storyai-3d-director-desk`

Expected: 322 tests pass. Known jsdom-only React Three Fiber warnings may appear, but no test may fail.

- [ ] **Step 3: Validate tracked JSON as UTF-8**

Run:

```powershell
@'
const fs = require('fs');
const cp = require('child_process');
const files = cp.execFileSync('git', ['ls-files', '*.json'], { encoding: 'utf8' })
  .split(/\r?\n/).filter(Boolean);
for (const file of files) {
  JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}
console.log(`Tracked JSON passed: ${files.length}`);
'@ | node -
```

Expected: all 16 tracked JSON files parse successfully.

- [ ] **Step 4: Run JavaScript and Python syntax checks without regenerating Python bytecode**

Run:

```powershell
$jsFiles = git ls-files '*.js' '*.mjs'
foreach ($file in $jsFiles) {
  node --check $file
  if ($LASTEXITCODE -ne 0) { throw "JavaScript syntax failed: $file" }
}
"JavaScript syntax passed: $($jsFiles.Count)"

@'
import ast
import pathlib
import subprocess

files = subprocess.check_output(['git', 'ls-files', '*.py'], text=True).splitlines()
for name in files:
    ast.parse(pathlib.Path(name).read_text(encoding='utf-8-sig'), filename=name)
print(f'Python syntax passed: {len(files)}')
'@ | .\python\python.exe -
```

Expected: all tracked JavaScript and Python files pass syntax validation, and root `__pycache__` remains absent.

- [ ] **Step 5: Run the live health check and verify port isolation**

Run:

```powershell
$env:HSTAR_HEALTH_URL = 'http://127.0.0.1:3000'
node tools/tests/hstarc-health-check.mjs
Remove-Item Env:HSTAR_HEALTH_URL
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess
Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort, OwningProcess
git status --short --branch
```

Expected: the live health check passes, port 3000 remains available, the recorded port-5000 state is unchanged, and the worktree contains no unintended changes.

- [ ] **Step 6: Report the cleanup result**

Report the exact removed paths, verification totals, retained protected paths, and any residual non-blocking warnings. Do not claim the cleanup complete if any command failed.
