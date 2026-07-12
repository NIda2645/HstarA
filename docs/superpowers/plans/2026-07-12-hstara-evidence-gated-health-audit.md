# HstarA Evidence-Gated Health Audit Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete a conservative HstarA engineering health audit that repairs proven cross-node leakage, locks task ownership and terminal behavior, validates QZZ 4K text-to-image and image-to-image requests, detects user-visible encoding defects, and removes only approved regenerable caches.

**Architecture:** Establish protected-data and repository baselines first. Enforce explicit graph ownership with focused regression tests, characterize task lifecycles and provider payloads without paid calls, then use at most 10 authorized 4K live requests to isolate transport versus local protocol behavior. Finish with allowlist-only cleanup and complete automated, syntax, health, and browser verification.

**Tech Stack:** Node.js test runner, JavaScript/HTML, Python AST and async provider adapters, FastAPI, httpx, PowerShell, Vitest, in-app browser

---

## File Structure

- Modify `static/js/canvas.js`: remove proven ordinary-canvas controller fallbacks that bypass graph ownership.
- Modify `static/js/smart-canvas.js`: apply the same ownership rule to smart-canvas controller logic.
- Modify `static/canvas.html`: refresh the ordinary-canvas script cache key after JavaScript changes.
- Modify `static/smart-canvas.html`: refresh the smart-canvas script cache key after JavaScript changes.
- Modify `tools/tests/controller-logic.test.mjs`: runtime regressions for connected, disabled, and unconnected controller behavior.
- Modify `tools/tests/smart-controller-integration.test.mjs`: smart-canvas structural ownership regression.
- Create `tools/tests/canvas-dataflow-ownership.test.mjs`: cross-feature graph ownership contract.
- Create `tools/tests/task-lifecycle-ownership.test.mjs`: terminal task and stale-node ownership contract.
- Create `tools/audit-text-encoding.mjs`: user-facing UTF-8 and structured-data audit.
- Create `tools/tests/text-encoding-health.test.mjs`: executable encoding-audit contract.
- Modify `tools/tests/qzz-image-provider-routing.test.mjs`: local 4K and reference-image payload contract.
- Verify `main.py`: change only if a failing local QZZ payload regression proves a defect.

### Task 1: Capture safety baseline and commit the controller isolation repair

**Files:**
- Modify: `static/js/canvas.js`
- Modify: `static/js/smart-canvas.js`
- Modify: `static/canvas.html`
- Modify: `static/smart-canvas.html`
- Modify: `tools/tests/controller-logic.test.mjs`
- Modify: `tools/tests/smart-controller-integration.test.mjs`
- Read: `API/.env`

- [ ] **Step 1: Record repository, port, protected-path, and API fingerprints**

Run:

```powershell
git status --short --branch
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
Get-FileHash -LiteralPath 'API/.env' -Algorithm SHA256
@('API','python','build/installer/stage','integrations/storyai-3d-director-desk/node_modules','static/3d-director/assets') | ForEach-Object {
  [pscustomobject]@{Path=$_; Exists=Test-Path -LiteralPath $_}
}
```

Expected: branch `main`; engineering service on port 3000; record port-5000 state without changing it; all protected-path states and the API hash are saved for final comparison.

- [ ] **Step 2: Re-run the controller red-green evidence**

Run the current regression tests and inspect the committed diff:

```powershell
node tools/tests/controller-logic.test.mjs
node tools/tests/smart-controller-integration.test.mjs
node tools/tests/controller-panel.test.mjs
git diff --check
git diff -- static/js/canvas.js static/js/smart-canvas.js tools/tests/controller-logic.test.mjs tools/tests/smart-controller-integration.test.mjs static/canvas.html static/smart-canvas.html
```

Expected: all three tests pass; the only production behavior removed is the canvas-wide single-controller fallback; cache keys match the two changed scripts.

- [ ] **Step 3: Commit the existing controller repair separately**

```powershell
git add static/js/canvas.js static/js/smart-canvas.js static/canvas.html static/smart-canvas.html tools/tests/controller-logic.test.mjs tools/tests/smart-controller-integration.test.mjs
git commit -m "fix: isolate canvas controller directives"
```

### Task 2: Remove the remaining unconnected material-controller fallback

**Files:**
- Modify: `tools/tests/controller-logic.test.mjs`
- Modify: `tools/tests/smart-controller-integration.test.mjs`
- Modify: `static/js/canvas.js`
- Modify: `static/js/smart-canvas.js`
- Modify: `static/canvas.html`
- Modify: `static/smart-canvas.html`

- [ ] **Step 1: Add the ordinary-canvas failing marker/material regression**

Append a case after the isolated controller test in `tools/tests/controller-logic.test.mjs` that calls the non-compatibility signature with an unrelated marked image:

```javascript
Object.assign(sandbox, {
  nodes: isolatedControllerGraph.nodes,
  connections: isolatedControllerGraph.connections,
});
const isolatedMarkedPrompt = sandbox.__exports.generationPromptWithControllerDirectives(
  isolatedGen,
  [{
    id: 'image-isolated',
    type: 'image',
    prompt: '',
    refs: [{
      url: '/assets/unrelated.png',
      markers: [{number: 1, xPct: 20, yPct: 30, label: 'unrelated object'}],
    }],
  }],
);
assert.doesNotMatch(
  isolatedMarkedPrompt,
  /oak wood texture|Material Controller|MATERIAL TARGET LOCK/,
  'marker metadata must not adopt material settings from an unconnected controller',
);
```

- [ ] **Step 2: Add the smart-canvas structural regression**

Extend the controller selection slice in `tools/tests/smart-controller-integration.test.mjs`:

```javascript
const materialStart = js.indexOf('function activeMaterialDirectiveForMarkers');
const materialEnd = js.indexOf('function markerReferenceDirective', materialStart);
assert.ok(materialStart >= 0 && materialEnd > materialStart);
assert.doesNotMatch(
  js.slice(materialStart, materialEnd),
  /:\s*nodes\.find\(/,
  'smart material marker directives must not fall back to an unconnected canvas-wide controller',
);
```

- [ ] **Step 3: Run both tests and verify RED**

```powershell
node tools/tests/controller-logic.test.mjs
node tools/tests/smart-controller-integration.test.mjs
```

Expected: ordinary test exposes the unconnected oak material directive; smart test exposes `nodes.find(...)` as the no-direct-source fallback.

- [ ] **Step 4: Apply the minimal ownership fix**

In both controller blocks replace the global fallback:

```javascript
const ctrl = direct ? nodes.find(n => n.id === direct.id) : null;
```

Do not alter direct-controller behavior or upstream traversal.

- [ ] **Step 5: Refresh cache keys and verify GREEN**

```powershell
node -e "const fs=require('fs');const v=fs.readFileSync('VERSION','utf8').trim().split(/\r?\n/)[0];for(const f of ['static/js/canvas.js','static/js/smart-canvas.js'])console.log(f+'='+v+'.'+Math.floor(fs.statSync(f).mtimeMs/1000))"
node tools/tests/controller-logic.test.mjs
node tools/tests/smart-controller-integration.test.mjs
node tools/tests/static-cache-integrity.test.mjs
```

Update only the corresponding `canvas.js?v=` and `smart-canvas.js?v=` values printed by the command.

- [ ] **Step 6: Commit the material ownership repair**

```powershell
git add static/js/canvas.js static/js/smart-canvas.js static/canvas.html static/smart-canvas.html tools/tests/controller-logic.test.mjs tools/tests/smart-controller-integration.test.mjs
git commit -m "fix: isolate controller marker materials"
```

### Task 3: Add a cross-feature canvas ownership contract

**Files:**
- Create: `tools/tests/canvas-dataflow-ownership.test.mjs`
- Test: `static/js/canvas.js`
- Test: `static/js/smart-canvas.js`

- [ ] **Step 1: Create the ownership test**

Create `tools/tests/canvas-dataflow-ownership.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ordinary = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const smart = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section exists: ${start}`);
  return source.slice(from, to);
}

const ordinaryController = section(ordinary, 'function activeControllerPromptsForGeneration', 'function activeMaterialDirectiveForMarkers');
assert.match(ordinaryController, /upstreamControllerPromptsForTarget\(targetNode, sources, graph\)/);
assert.doesNotMatch(ordinaryController, /nodes\.(?:find|filter)\(/);

const ordinaryMaterial = section(ordinary, 'function activeMaterialDirectiveForMarkers', 'function markerReferenceDirective');
assert.doesNotMatch(ordinaryMaterial, /:\s*nodes\.find\(/);

const ordinarySources = section(ordinary, 'function generatorSources', 'function orderedSources');
assert.match(ordinarySources, /connections\.filter\(c => c\.to === gen\.id\)/);
assert.doesNotMatch(ordinarySources, /nodes\.filter\([^\n]*(?:selected|active|running)/);

const smartController = section(smart, 'function activeControllerPromptsForGeneration', 'function activeMaterialDirectiveForMarkers');
assert.match(smartController, /upstreamControllerPromptsForTarget\(targetNode, sources, graph\)/);
assert.doesNotMatch(smartController, /nodes\.(?:find|filter)\(/);

const smartInputs = section(smart, 'function upstreamNodesForKinds', 'function clearDetachedRunInputRefs');
assert.match(smartInputs, /conn\.to === node\.id/);
assert.match(smartInputs, /return \[\.\.\.ids\]\.map\(id => nodes\.find/);
assert.doesNotMatch(smartInputs, /selectedNode\(\)|nodes\.filter\([^\n]*(?:active|running)/);

const detachedRefs = section(smart, 'function clearDetachedRunInputRefs', 'function cleanupDetachedRunInputRefs');
for (const field of ['runInputRefs', 'runPromptRefs', 'sourceNodeId']) {
  assert.match(detachedRefs, new RegExp(`delete node\\.${field}`));
}

console.log('Canvas dataflow ownership tests passed');
```

- [ ] **Step 2: Run the ownership contract**

```powershell
node tools/tests/canvas-dataflow-ownership.test.mjs
```

Expected: PASS after Tasks 1-2. A failure identifies a concrete function for a separate red-green repair; do not weaken the invariant to make the test pass.

- [ ] **Step 3: Commit the ownership contract**

```powershell
git add tools/tests/canvas-dataflow-ownership.test.mjs
git commit -m "test: guard canvas dataflow ownership"
```

### Task 4: Lock task terminal and stale-node behavior

**Files:**
- Create: `tools/tests/task-lifecycle-ownership.test.mjs`
- Test: `static/js/canvas.js`
- Test: `static/js/smart-canvas.js`
- Test: `tools/tests/smart-canvas-sync-merge.test.mjs`
- Test: `tools/tests/director-node-scene-storage-cleanup.test.mjs`
- Test: `tools/tests/smart-text-edit-integration.test.mjs`

- [ ] **Step 1: Create the lifecycle contract**

Create `tools/tests/task-lifecycle-ownership.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const ordinary = readFileSync(new URL('../../static/js/canvas.js', import.meta.url), 'utf8');
const smart = readFileSync(new URL('../../static/js/smart-canvas.js', import.meta.url), 'utf8');

function section(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `section exists: ${start}`);
  return source.slice(from, to);
}

const ordinaryPoll = section(ordinary, 'async function pollCanvasImageTask', 'async function waitCanvasImageTaskResult');
assert.match(ordinaryPoll, /const found = findPendingTask\(taskId\)/);
assert.match(ordinaryPoll, /if\(!found\) return 'missing'/);
assert.match(ordinaryPoll, /if\(data\.status === 'failed'\)[\s\S]*failCanvasImageTask/);
assert.match(ordinaryPoll, /finally[\s\S]*activeCanvasTaskPolls\.delete\(taskId\)/);

const ordinaryFail = section(ordinary, 'function failCanvasImageTask', 'function resumeCanvasImageTasks');
assert.match(ordinaryFail, /gen\.runStatus = 'failed'/);
assert.match(ordinaryFail, /gen\.running = false/);
assert.match(ordinaryFail, /addGenerationLog\(\{run, outputs:\[\], runMs, error:/);

const smartPoll = section(smart, 'async function pollSmartCanvasTask', 'function finalizeSmartPendingTask');
assert.match(smartPoll, /if\(task\.status === 'failed'\)/);
assert.match(smartPoll, /finally[\s\S]*activeSmartTaskPolls\.delete\(taskId\)/);

const smartResume = section(smart, 'async function resumeSmartPendingNode', 'function resumeSmartPendingNodes');
assert.match(smartResume, /node\.pendingTasks = smartPendingTasks\(node\)\.filter/);
assert.match(smartResume, /node\.running = false/);
assert.match(smartResume, /logTaskFailure/);

const recognition = section(smart, 'function cancelSmartTextRecognition', 'async function openSmartTextModifyPanel');
assert.match(recognition, /recognitionRequestId = \(state\.recognitionRequestId \|\| 0\) \+ 1/);
assert.match(recognition, /recognitionAbortController\?\.abort\(\)/);
assert.match(recognition, /recognitionRequestId !== requestId/);

console.log('Task lifecycle ownership tests passed');
```

- [ ] **Step 2: Run lifecycle and stale-data tests**

```powershell
node tools/tests/task-lifecycle-ownership.test.mjs
node tools/tests/smart-canvas-sync-merge.test.mjs
node tools/tests/smart-text-edit-integration.test.mjs
node tools/tests/director-node-scene-storage-cleanup.test.mjs
node tools/tests/director-node-session-message-flow.test.mjs
node tools/tests/director-smart-node-session-message-flow.test.mjs
```

Expected: all pass. The suite proves deleted smart nodes do not resurrect, OCR cancellation invalidates late responses, Director node state is deleted with its node, and failed generation tasks enter a terminal state.

- [ ] **Step 3: Commit the lifecycle contract**

```powershell
git add tools/tests/task-lifecycle-ownership.test.mjs
git commit -m "test: guard canvas task lifecycles"
```

### Task 5: Add the user-facing encoding health audit

**Files:**
- Create: `tools/audit-text-encoding.mjs`
- Create: `tools/tests/text-encoding-health.test.mjs`

- [ ] **Step 1: Create the encoding auditor**

Create `tools/audit-text-encoding.mjs`:

```javascript
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const files = execFileSync('git', ['ls-files', '-z'], {encoding:'utf8'})
  .split('\0')
  .filter(Boolean)
  .filter(file => /^(?:main\.py|static\/.*\.(?:html|js|css|json))$/i.test(file))
  .filter(file => !file.includes('/vendor/'));

const suspicious = [
  {name:'replacement character', pattern:/\uFFFD/g},
  {name:'common UTF-8 mojibake', pattern:/(?:\u951f\u65a4\u62f7|\u00c3.|\u00c2.|\u00e2\u20ac|\u00e6[\u0080-\u00bf])/g},
];
const findings = [];

for (const file of files) {
  const text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  if (file.endsWith('.json')) JSON.parse(text);
  const lines = text.split(/\r?\n/);
  for (const {name, pattern} of suspicious) {
    lines.forEach((line, index) => {
      pattern.lastIndex = 0;
      if (pattern.test(line)) findings.push({file, line:index + 1, kind:name});
    });
  }
}

if (findings.length) {
  console.error(JSON.stringify(findings, null, 2));
  process.exit(1);
}
console.log(`User-facing text encoding passed: ${files.length}`);
```

- [ ] **Step 2: Create the executable test**

Create `tools/tests/text-encoding-health.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

const result = spawnSync(process.execPath, ['tools/audit-text-encoding.mjs'], {encoding:'utf8'});
assert.equal(result.status, 0, [result.error?.message, result.stdout, result.stderr].filter(Boolean).join('\n'));
assert.match(result.stdout, /User-facing text encoding passed:/);
console.log('Text encoding health tests passed');
```

- [ ] **Step 3: Run the auditor and test**

```powershell
node tools/audit-text-encoding.mjs
node tools/tests/text-encoding-health.test.mjs
```

Expected: user-facing `main.py` and non-vendor static files contain no replacement-character or known mojibake signatures, and all scanned JSON parses. Regex fixtures under `tools/tests` and third-party `get-pip.py` are intentionally outside this user-facing scan.

- [ ] **Step 4: Commit the encoding audit**

```powershell
git add tools/audit-text-encoding.mjs tools/tests/text-encoding-health.test.mjs
git commit -m "test: audit user-facing text encoding"
```

### Task 6: Validate QZZ 4K protocol locally and with authorized live requests

**Files:**
- Modify: `tools/tests/qzz-image-provider-routing.test.mjs`
- Verify or conditionally modify: `main.py`
- Temporary output only: `$env:TEMP/HstarA-qzz-audit/`

- [ ] **Step 1: Extend the local QZZ contract**

Add assertions to `tools/tests/qzz-image-provider-routing.test.mjs`:

```javascript
assert.match(
  py,
  /async def generate_qzz_provider_image[\s\S]*request_size = normalize_gpt_image_2_size\(size\)[\s\S]*body = \{"model": model_name, "prompt": prompt, "size": request_size, "response_format": "url", "n": 1\}/,
  'QZZ should preserve the requested GPT Image 2 size and request exactly one URL result',
);
assert.match(
  py,
  /if image_refs:[\s\S]*require_converted_image_refs[\s\S]*body\["image"\] = image_payload[\s\S]*client\.post\(gen_url/,
  'QZZ image-to-image should post the converted source image in the same generation request',
);
assert.match(
  py,
  /def normalize_gpt_image_2_size[\s\S]*3840x2160/,
  'GPT Image 2 size normalization should retain a 4K landscape request',
);
```

Run:

```powershell
node tools/tests/qzz-image-provider-routing.test.mjs
node tools/tests/image-error-messages.test.mjs
```

Expected: local protocol tests pass before any paid request. If a new assertion fails, fix only the demonstrated size or image-payload defect in `main.py`, then rerun both tests.

- [ ] **Step 2: Prepare an ephemeral live-audit environment**

Set the user-authorized key only in the current PowerShell process. Do not echo it:

```powershell
$env:HSTAR_AUDIT_API_KEY = Read-Host 'QZZ audit API key'
$env:HSTAR_AUDIT_BASE_URL = 'https://img.688.qzz.io'
$auditDir = Join-Path $env:TEMP 'HstarA-qzz-audit'
New-Item -ItemType Directory -Force -Path $auditDir | Out-Null
```

Expected: no repository file changes and no key output.

- [ ] **Step 3: Run the 4K text-to-image call**

Run an embedded-Python call through the production adapter:

```powershell
@'
import asyncio, json, os
import main

provider = {
    'id': 'health-qzz',
    'name': 'HstarA health QZZ',
    'base_url': os.environ['HSTAR_AUDIT_BASE_URL'],
    'api_key': os.environ['HSTAR_AUDIT_API_KEY'],
    'protocol': 'apimart',
    'image_generation_endpoint': '/v1/images/generations',
}

async def run():
    url, raw = await main.generate_qzz_provider_image(
        'A clean black poster with the exact white text HSTAR centered, minimal layout, no other text.',
        '3840x2160', 'gpt-image-2', [], provider, quality='high'
    )
    print(json.dumps({'ok': bool(url), 'url': url, 'request_count': 1}, ensure_ascii=True))

asyncio.run(run())
'@ | .\python\python.exe - | Tee-Object -FilePath (Join-Path $auditDir 'text-to-image.json')
```

Expected: one 4K request returns an image URL. The output contains no key.

- [ ] **Step 4: Run 4K image-to-image, text-modification, and text-removal calls**

Read the returned URL from the temporary result and use it as the reference image. Each request uses `3840x2160`, `gpt-image-2`, high quality, and one output. Prompts are:

```text
1. Preserve the poster layout, colors, typography style, and all visual details. Change only HSTAR to HSTAR A.
2. Preserve the poster layout, colors, spacing, and all non-text visual details. Remove every visible text character and leave a clean text-free poster.
```

Use the same `main.generate_qzz_provider_image(...)` adapter and pass:

```python
reference_images=[{'url': source_url, 'name': 'qzz-4k-source.png', 'kind': 'image'}]
```

Expected: the adapter sends a non-empty `image` field and returns one URL for each call. Count calls explicitly in the temporary report. Stop before request 11 under every condition.

- [ ] **Step 5: Classify failures before changing code**

For any failure, record only status, endpoint path, requested size, model, whether the `image` field was present, elapsed time, and redacted error. Classify it as one of:

```text
vpn-or-dns
transport
upstream-auth-or-quota
upstream-4k-unsupported
local-size-payload
local-reference-payload
upstream-service
```

A local classification requires a failing regression in `qzz-image-provider-routing.test.mjs` before modifying `main.py`. VPN, transport, quota, unsupported-4K, or upstream-service failures must not trigger protocol rewrites.

- [ ] **Step 6: Clear the key and commit local contract changes**

```powershell
Remove-Item Env:HSTAR_AUDIT_API_KEY -ErrorAction SilentlyContinue
Remove-Item Env:HSTAR_AUDIT_BASE_URL -ErrorAction SilentlyContinue
git add tools/tests/qzz-image-provider-routing.test.mjs
git add main.py 2>$null
git commit -m "test: lock QZZ 4K image payloads"
```

Do not add the temporary audit directory or generated image URLs to Git.

### Task 7: Allowlist cleanup and complete verification

**Files:**
- Delete if present: `__pycache__/`
- Delete if present: `integrations/storyai-3d-director-desk/tsconfig.node.tsbuildinfo`
- Delete if present: `integrations/storyai-3d-director-desk/tsconfig.tsbuildinfo`
- Delete if present: `integrations/storyai-3d-director-desk/vite.config.d.ts`
- Delete if present: `integrations/storyai-3d-director-desk/vite.config.js`
- Verify: all tracked source, tests, protected paths, and live pages

- [ ] **Step 1: Resolve and validate cleanup targets**

```powershell
$repo = (Resolve-Path -LiteralPath '.').Path
$allowlist = @(
  (Join-Path $repo '__pycache__'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/tsconfig.node.tsbuildinfo'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/tsconfig.tsbuildinfo'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/vite.config.d.ts'),
  (Join-Path $repo 'integrations/storyai-3d-director-desk/vite.config.js')
)
$resolvedAllowlist = foreach($candidate in $allowlist){
  if(-not (Test-Path -LiteralPath $candidate)){ continue }
  $resolved = (Resolve-Path -LiteralPath $candidate).Path
  if(-not $resolved.StartsWith($repo + [IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){
    throw "Cleanup target escaped repository: $resolved"
  }
  $resolved
}
$resolvedAllowlist
```

Expected: every printed path is one of the five approved repository-local artifacts.

- [ ] **Step 2: Remove only validated artifacts**

```powershell
foreach($target in $resolvedAllowlist){
  if((Get-Item -LiteralPath $target).PSIsContainer){ Remove-Item -LiteralPath $target -Recurse -Force }
  else { Remove-Item -LiteralPath $target -Force }
}
```

Expected: no tracked source or protected path is removed.

- [ ] **Step 3: Run every root test**

```powershell
$tests = Get-ChildItem -LiteralPath 'tools/tests' -Filter '*.test.mjs' | Sort-Object Name
foreach($test in $tests){
  node $test.FullName
  if($LASTEXITCODE -ne 0){ throw "Root test failed: $($test.Name)" }
}
"Root tests passed: $($tests.Count)"
```

Expected: all existing tests plus the three new health contracts pass.

- [ ] **Step 4: Run the complete Director suite**

```powershell
npm.cmd test
```

Working directory: `integrations/storyai-3d-director-desk`

Expected: 36 files and 322 tests pass.

- [ ] **Step 5: Validate tracked syntax and JSON without leaving bytecode**

```powershell
$jsFiles = git ls-files '*.js' '*.mjs'
foreach($file in $jsFiles){ node --check $file; if($LASTEXITCODE -ne 0){ throw "JavaScript syntax failed: $file" } }
@'
import ast, pathlib, subprocess
for name in subprocess.check_output(['git','ls-files','*.py'], text=True).splitlines():
    ast.parse(pathlib.Path(name).read_text(encoding='utf-8-sig'), filename=name)
print('Python syntax passed')
'@ | .\python\python.exe -
@'
const fs=require('fs'), cp=require('child_process');
const files=cp.execFileSync('git',['ls-files','*.json'],{encoding:'utf8'}).split(/\r?\n/).filter(Boolean);
for(const file of files) JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
console.log(`Tracked JSON passed: ${files.length}`);
'@ | node -
```

- [ ] **Step 6: Run live health and browser verification**

```powershell
$env:HSTAR_HEALTH_URL='http://127.0.0.1:3000'
node tools/tests/hstarc-health-check.mjs
Remove-Item Env:HSTAR_HEALTH_URL
```

Reload the engineering shell and verify ordinary canvas, smart canvas, API settings, online archive, and Director entry pages load their current cache keys with no page error. Do not run paid generation through the browser after Task 6.

- [ ] **Step 7: Recheck protected state and repository scope**

```powershell
Get-FileHash -LiteralPath 'API/.env' -Algorithm SHA256
@('API','python','build/installer/stage','integrations/storyai-3d-director-desk/node_modules','static/3d-director/assets') | ForEach-Object {
  [pscustomobject]@{Path=$_; Exists=Test-Path -LiteralPath $_}
}
Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
Get-NetTCPConnection -LocalPort 5000 -State Listen -ErrorAction SilentlyContinue | Select-Object LocalPort,OwningProcess
git diff --check
git status --short --branch
```

Expected: API hash and protected-path states equal Task 1, port 5000 is unchanged, port 3000 remains healthy, and Git contains only intentional audit commits.

- [ ] **Step 8: Report exact evidence**

Report:

- confirmed defects and repairs;
- ownership and lifecycle contracts added;
- QZZ live request count and redacted outcome for text-to-image, image-to-image, text modification, and text removal;
- exact cleanup paths removed;
- root and Director test totals;
- syntax, JSON, encoding, health, browser, protected-path, and port results;
- residual risks or upstream limitations.

