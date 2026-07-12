# Android Phase 1 Contract Baseline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Create a deterministic Android migration baseline that inventories HstarA's FastAPI routes, provider protocols, shell pages, and mobile feature strategies so later Android phases cannot silently omit existing behavior.

**Architecture:** A Python AST/HTML parser generates canonical JSON contracts from `main.py` and `static/index.html`. Human-reviewed feature parity metadata maps every shell page and native subsystem to its Android strategy, while Node tests enforce generated-contract freshness and complete page coverage.

**Tech Stack:** Python standard-library `ast` and `html.parser`, Node.js test runner, JSON contracts, Markdown parity documentation

---

## File Structure

- Create `tools/android/build_baseline.py`: deterministic source-to-contract generator.
- Create `tools/tests/android-contract-generator.test.mjs`: generated route/protocol/page contract tests.
- Create `tools/tests/android-feature-parity.test.mjs`: mobile strategy and shell-page coverage tests.
- Create `android/contracts/feature-parity.json`: reviewed Android migration strategies.
- Create `android/contracts/generated/routes.json`: generated FastAPI route inventory.
- Create `android/contracts/generated/provider-protocols.json`: generated provider protocol inventory.
- Create `android/contracts/generated/web-entrypoints.json`: generated shell page/iframe inventory.
- Create `docs/android/feature-parity-matrix.md`: readable Phase 1 migration baseline.

### Task 1: Add a failing generated-contract test

**Files:**
- Create: `tools/tests/android-contract-generator.test.mjs`
- Test: `main.py`
- Test: `static/index.html`

- [ ] **Step 1: Create the generator contract test**

Create `tools/tests/android-contract-generator.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const python = process.platform === 'win32'
  ? path.join(root, 'python', 'python.exe')
  : 'python3';
const generator = path.join(root, 'tools', 'android', 'build_baseline.py');
const generated = path.join(root, 'android', 'contracts', 'generated');

assert.ok(existsSync(generator), 'Android baseline generator exists');

const check = spawnSync(python, [generator, '--check'], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(check.status, 0, `generated Android contracts are current\n${check.stdout}\n${check.stderr}`);

const routes = JSON.parse(readFileSync(path.join(generated, 'routes.json'), 'utf8'));
const protocols = JSON.parse(readFileSync(path.join(generated, 'provider-protocols.json'), 'utf8'));
const entrypoints = JSON.parse(readFileSync(path.join(generated, 'web-entrypoints.json'), 'utf8'));

assert.equal(routes.schemaVersion, 1);
assert.ok(routes.routes.length >= 140, `expected at least 140 routes, received ${routes.routes.length}`);
assert.equal(
  new Set(routes.routes.map(route => `${route.method} ${route.path}`)).size,
  routes.routes.length,
  'route method/path pairs are unique'
);

for (const protocol of [
  'apimart', 'bananarouter', 'baofu', 'codex', 'gemini', 'gemini-cli',
  'grsai', 'jimeng', 'linapi', 'lingjing', 'moonly', 'openai', 'otuapi',
  'runninghub', 'toapis', 'volcengine',
]) {
  assert.ok(protocols.protocols.includes(protocol), `provider protocol is inventoried: ${protocol}`);
}

for (const page of [
  'zimage', 'enhance', 'klein', 'angle', 'online', 'gpt-chat', 'canvas',
  'director-desk', 'asset-manager', 'api-settings', 'software-settings',
  'comfyui-settings',
]) {
  assert.ok(entrypoints.pages.includes(page), `shell page is inventoried: ${page}`);
}

console.log('Android generated contract tests passed');
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node tools/tests/android-contract-generator.test.mjs
```

Expected: FAIL with `Android baseline generator exists` because `tools/android/build_baseline.py` does not exist.

- [ ] **Step 3: Commit the failing test**

```powershell
git add tools/tests/android-contract-generator.test.mjs
git commit -m "test: define Android contract baseline"
```

### Task 2: Generate canonical route, protocol, and page contracts

**Files:**
- Create: `tools/android/build_baseline.py`
- Create: `android/contracts/generated/routes.json`
- Create: `android/contracts/generated/provider-protocols.json`
- Create: `android/contracts/generated/web-entrypoints.json`
- Test: `tools/tests/android-contract-generator.test.mjs`

- [ ] **Step 1: Implement the source parser and canonical writer**

Create `tools/android/build_baseline.py`:

```python
from __future__ import annotations

import argparse
import ast
import json
import re
import sys
from html.parser import HTMLParser
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = ROOT / "android" / "contracts" / "generated"
HTTP_METHODS = {"get", "post", "put", "patch", "delete"}


class StudioShellParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__()
        self.pages: set[str] = set()
        self.frames: list[dict[str, str]] = []

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        values = {key: value or "" for key, value in attrs}
        onclick = values.get("onclick", "")
        match = re.search(r"switchUI\(this,\s*'([^']+)'\)", onclick)
        if match:
            self.pages.add(match.group(1))
        if tag == "iframe" and values.get("id", "").startswith("frame-"):
            source = values.get("data-src") or values.get("src")
            if source:
                self.frames.append({
                    "id": values["id"],
                    "src": source.split("?", 1)[0],
                })


def classify_route(path: str) -> str:
    rules = [
        (("/api/providers", "/api/config", "/api/models"), "api-settings"),
        (("/api/canvases", "/api/projects", "/api/canvas-", "/api/smart-canvas"), "canvas"),
        (("/api/local-assets", "/api/asset-library", "/api/shared-folders", "/api/prompt-libraries"), "assets"),
        (("/api/history", "/api/online-image", "/api/image-task", "/api/generate", "/api/ms/", "/generate"), "generation"),
        (("/api/software-settings", "/api/native/", "/api/open-external", "/api/output-download", "/api/collaboration"), "android-native"),
        (("/api/runninghub", "/api/comfyui", "/api/workflows"), "workflows"),
        (("/api/conversations", "/api/chat", "/api/codex", "/api/gemini-cli", "/api/jimeng"), "assistant"),
        (("/api/update", "/api/check-update", "/api/app-info"), "app-lifecycle"),
    ]
    for prefixes, domain in rules:
        if path.startswith(prefixes):
            return domain
    return "core"


def route_contract(tree: ast.Module) -> dict[str, object]:
    routes: list[dict[str, str]] = []
    for node in tree.body:
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        for decorator in node.decorator_list:
            if not isinstance(decorator, ast.Call) or not decorator.args:
                continue
            function = decorator.func
            if not (
                isinstance(function, ast.Attribute)
                and isinstance(function.value, ast.Name)
                and function.value.id == "app"
                and function.attr in HTTP_METHODS
            ):
                continue
            path_value = decorator.args[0]
            if not isinstance(path_value, ast.Constant) or not isinstance(path_value.value, str):
                continue
            routes.append({
                "domain": classify_route(path_value.value),
                "handler": node.name,
                "method": function.attr.upper(),
                "path": path_value.value,
            })
    routes.sort(key=lambda item: (item["path"], item["method"], item["handler"]))
    return {"schemaVersion": 1, "source": "main.py", "routes": routes}


def protocol_contract(tree: ast.Module) -> dict[str, object]:
    protocols: list[str] = []
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        if not any(isinstance(target, ast.Name) and target.id == "SUPPORTED_PROVIDER_PROTOCOLS" for target in node.targets):
            continue
        if isinstance(node.value, (ast.Set, ast.List, ast.Tuple)):
            protocols = sorted(
                value.value
                for value in node.value.elts
                if isinstance(value, ast.Constant) and isinstance(value.value, str)
            )
        break
    if not protocols:
        raise RuntimeError("SUPPORTED_PROVIDER_PROTOCOLS was not found in main.py")
    return {
        "schemaVersion": 1,
        "source": "main.py:SUPPORTED_PROVIDER_PROTOCOLS",
        "protocols": protocols,
    }


def web_contract() -> dict[str, object]:
    parser = StudioShellParser()
    parser.feed((ROOT / "static" / "index.html").read_text(encoding="utf-8-sig"))
    parser.frames.sort(key=lambda item: item["id"])
    return {
        "schemaVersion": 1,
        "source": "static/index.html",
        "pages": sorted(parser.pages),
        "frames": parser.frames,
    }


def canonical_bytes(value: object) -> bytes:
    return (json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n").encode("utf-8")


def write_or_check(name: str, value: object, check: bool) -> bool:
    target = OUTPUT_DIR / name
    expected = canonical_bytes(value)
    if check:
        if not target.exists() or target.read_bytes() != expected:
            print(f"outdated Android contract: {target.relative_to(ROOT)}", file=sys.stderr)
            return False
        return True
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(expected)
    return True


def main() -> int:
    argument_parser = argparse.ArgumentParser()
    argument_parser.add_argument("--check", action="store_true")
    args = argument_parser.parse_args()
    tree = ast.parse((ROOT / "main.py").read_text(encoding="utf-8-sig"), filename="main.py")
    values = {
        "routes.json": route_contract(tree),
        "provider-protocols.json": protocol_contract(tree),
        "web-entrypoints.json": web_contract(),
    }
    valid = all(write_or_check(name, value, args.check) for name, value in values.items())
    if valid:
        action = "checked" if args.check else "generated"
        print(f"Android contracts {action}: {len(values)}")
        return 0
    return 1


if __name__ == "__main__":
    raise SystemExit(main())
```

- [ ] **Step 2: Generate the three contract files**

Run:

```powershell
.\python\python.exe tools\android\build_baseline.py
```

Expected: `Android contracts generated: 3` and the three canonical JSON files appear under `android/contracts/generated/`.

- [ ] **Step 3: Run the generated-contract test and verify GREEN**

Run:

```powershell
node tools/tests/android-contract-generator.test.mjs
```

Expected: `Android generated contract tests passed`.

- [ ] **Step 4: Commit the generator and generated contracts**

```powershell
git add tools/android/build_baseline.py android/contracts/generated tools/tests/android-contract-generator.test.mjs
git commit -m "feat: add Android source contract baseline"
```

### Task 3: Add the reviewed feature-parity matrix

**Files:**
- Create: `android/contracts/feature-parity.json`
- Create: `tools/tests/android-feature-parity.test.mjs`
- Create: `docs/android/feature-parity-matrix.md`

- [ ] **Step 1: Write a failing parity coverage test**

Create `tools/tests/android-feature-parity.test.mjs`:

```javascript
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const readJson = file => JSON.parse(readFileSync(file, 'utf8'));
const entrypoints = readJson('android/contracts/generated/web-entrypoints.json');
const parity = readJson('android/contracts/feature-parity.json');

assert.equal(parity.schemaVersion, 1);
const areaIds = new Set(parity.areas.map(area => area.id));
for (const required of [
  'studio-shell', 'ordinary-canvas', 'smart-canvas', 'director-desk',
  'api-settings', 'task-engine', 'data-media', 'android-integration',
]) {
  assert.ok(areaIds.has(required), `required Android parity area exists: ${required}`);
}

const coveredPages = new Set(parity.areas.flatMap(area => area.shellPages));
assert.deepEqual(
  [...coveredPages].sort(),
  [...entrypoints.pages].sort(),
  'every Hstar shell page has exactly one Android migration area'
);

for (const area of parity.areas) {
  assert.ok(['web-reuse', 'kotlin-port', 'android-native', 'hybrid'].includes(area.strategy), `valid strategy: ${area.id}`);
  assert.ok(area.acceptance.length > 0, `acceptance criteria exist: ${area.id}`);
}

console.log('Android feature parity tests passed');
```

- [ ] **Step 2: Run the parity test and verify RED**

Run:

```powershell
node tools/tests/android-feature-parity.test.mjs
```

Expected: FAIL because `android/contracts/feature-parity.json` does not exist.

- [ ] **Step 3: Create the reviewed feature strategy manifest**

Create `android/contracts/feature-parity.json` with this complete area set:

```json
{
  "schemaVersion": 1,
  "areas": [
    {"id":"studio-shell","shellPages":[],"strategy":"android-native","acceptance":"Compose shell owns lifecycle, responsive navigation, permissions, themes, and secure WebView hosting."},
    {"id":"text-to-image","shellPages":["zimage"],"strategy":"hybrid","acceptance":"Existing UI runs unchanged while Kotlin executes ModelScope and configured generation protocols."},
    {"id":"detail-enhance","shellPages":["enhance"],"strategy":"hybrid","acceptance":"Enhancement inputs, parameters, tasks, progress, cancellation, and outputs remain functional."},
    {"id":"image-editor","shellPages":["klein"],"strategy":"hybrid","acceptance":"Image editing accepts private or picked media and writes results to private storage or the gallery."},
    {"id":"angle-control","shellPages":["angle"],"strategy":"hybrid","acceptance":"Angle controls, references, tasks, history, and output actions preserve Windows behavior."},
    {"id":"online-generation","shellPages":["online"],"strategy":"hybrid","acceptance":"All provider choices, references, pagination, archive management, and generation results work on Android."},
    {"id":"assistant-chat","shellPages":["gpt-chat"],"strategy":"hybrid","acceptance":"Conversations, attachments, text models, image generation, streaming, and persistence work without a PC."},
    {"id":"ordinary-canvas","shellPages":["canvas"],"strategy":"hybrid","acceptance":"Projects, nodes, links, markers, controller, gestures, shortcuts, tasks, recycle bin, and gallery export are end-to-end functional."},
    {"id":"director-desk","shellPages":["director-desk"],"strategy":"web-reuse","acceptance":"3D scenes, models, cameras, captures, batch send, reset, persistence, portrait panels, and landscape workspace pass device tests."},
    {"id":"asset-manager","shellPages":["asset-manager"],"strategy":"hybrid","acceptance":"Private assets, folders, captions, classification, imports, references, deletion, and gallery export remain functional."},
    {"id":"api-settings","shellPages":["api-settings"],"strategy":"hybrid","acceptance":"All providers, protocols, models, endpoint overrides, encrypted keys, probes, and redacted errors work."},
    {"id":"software-settings","shellPages":["software-settings"],"strategy":"android-native","acceptance":"Storage, appearance, touch preferences, data cleanup, diagnostics, intents, and update settings use Android-native behavior."},
    {"id":"workflow-settings","shellPages":["comfyui-settings"],"strategy":"hybrid","acceptance":"ComfyUI instances, workflows, imports, configuration, execution, and results work over LAN or public URLs."},
    {"id":"smart-canvas","shellPages":[],"strategy":"hybrid","acceptance":"Smart workflows, markers, controller, text edit/removal, downstream generation, assets, logs, and Director nodes are fully connected."},
    {"id":"task-engine","shellPages":[],"strategy":"kotlin-port","acceptance":"Typed persistent tasks support progress, foreground notifications, cancellation, bounded polling, recovery, and terminal failure."},
    {"id":"data-media","shellPages":[],"strategy":"kotlin-port","acceptance":"Room, private media, reference counts, 30-day recycle bin, cleanup, gallery copies, and uninstall behavior match the design."},
    {"id":"android-integration","shellPages":[],"strategy":"android-native","acceptance":"Photo picker, MediaStore, Keystore, VPN-aware networking, sharing intents, external keyboard, notifications, and APK updates work."}
  ]
}
```

- [ ] **Step 4: Create the readable parity matrix**

Create `docs/android/feature-parity-matrix.md`:

```markdown
# Android Feature Parity Matrix

Generated route, protocol, and shell-page inventories under `android/contracts/generated/` are authoritative and are checked by `tools/tests/android-contract-generator.test.mjs`. This matrix records the reviewed Android migration strategy and delivery phase for every feature area.

| Area | Shell page | Strategy | Delivery phase |
|---|---|---|---|
| `studio-shell` | - | Android native | 2 |
| `text-to-image` | `zimage` | Hybrid | 4 |
| `detail-enhance` | `enhance` | Hybrid | 4 |
| `image-editor` | `klein` | Hybrid | 4 |
| `angle-control` | `angle` | Hybrid | 4 |
| `online-generation` | `online` | Hybrid | 8 |
| `assistant-chat` | `gpt-chat` | Hybrid | 8 |
| `ordinary-canvas` | `canvas` | Hybrid | 5 |
| `director-desk` | `director-desk` | Web reuse | 7 |
| `asset-manager` | `asset-manager` | Hybrid | 8 |
| `api-settings` | `api-settings` | Hybrid | 4 |
| `software-settings` | `software-settings` | Android native | 8 |
| `workflow-settings` | `comfyui-settings` | Hybrid | 8 |
| `smart-canvas` | - | Hybrid | 6 |
| `task-engine` | - | Kotlin port | 4 |
| `data-media` | - | Kotlin port | 3 |
| `android-integration` | - | Android native | 2-9 |

## Acceptance Source

The machine-readable acceptance statements are stored in `android/contracts/feature-parity.json`. A feature is complete only when its real data flow, persistence, cancellation, failure handling, and output behavior pass Android tests; UI presence alone is insufficient.
```

- [ ] **Step 5: Run the parity test and verify GREEN**

Run:

```powershell
node tools/tests/android-feature-parity.test.mjs
```

Expected: `Android feature parity tests passed`.

- [ ] **Step 6: Commit the reviewed parity baseline**

```powershell
git add android/contracts/feature-parity.json tools/tests/android-feature-parity.test.mjs docs/android/feature-parity-matrix.md
git commit -m "docs: baseline Android feature parity"
```

### Task 4: Verify Phase 1 and guard against drift

**Files:**
- Verify: `tools/android/build_baseline.py`
- Verify: `android/contracts/`
- Verify: `tools/tests/*.test.mjs`
- Verify: `integrations/storyai-3d-director-desk/src/**/*.test.*`

- [ ] **Step 1: Prove generated contracts are deterministic**

Run:

```powershell
.\python\python.exe tools\android\build_baseline.py --check
.\python\python.exe tools\android\build_baseline.py
git diff --exit-code -- android/contracts/generated
```

Expected: check passes, regeneration creates no diff, and Git exits `0`.

- [ ] **Step 2: Run both Android baseline tests**

```powershell
node tools/tests/android-contract-generator.test.mjs
node tools/tests/android-feature-parity.test.mjs
```

Expected: both tests pass.

- [ ] **Step 3: Run all root tests**

```powershell
$tests = Get-ChildItem -LiteralPath 'tools/tests' -Filter '*.test.mjs' | Sort-Object Name
foreach ($test in $tests) {
  node $test.FullName
  if ($LASTEXITCODE -ne 0) { throw "Root test failed: $($test.Name)" }
}
"Root tests passed: $($tests.Count)"
```

Expected: all existing 52 tests plus the two Android baseline tests pass.

- [ ] **Step 4: Run the complete 3D Director test suite**

```powershell
npm.cmd test
```

Working directory: `integrations/storyai-3d-director-desk`

Expected: 36 files and 322 tests pass.

- [ ] **Step 5: Run syntax and repository checks**

```powershell
@'
import ast
from pathlib import Path
path = Path('tools/android/build_baseline.py')
ast.parse(path.read_text(encoding='utf-8-sig'), filename=str(path))
print('Android baseline Python syntax passed')
'@ | .\python\python.exe -
node --check tools/tests/android-contract-generator.test.mjs
node --check tools/tests/android-feature-parity.test.mjs
git diff --check
git status --short --branch
```

Expected: syntax checks pass and the worktree contains only the intentional Phase 1 commits.

- [ ] **Step 6: Report Phase 1 completion**

Report the exact route count, protocol count, shell page count, parity area count, root test count, and Director test totals. Phase 2 must not begin until the generated baseline is current and every shell page is covered.
