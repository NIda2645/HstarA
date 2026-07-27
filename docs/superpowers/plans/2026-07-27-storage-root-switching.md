# Storage Root Switching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace software-settings data migration with a direct, reversible storage-root switch that accepts any directory and never copies or removes data from the previous root.

**Architecture:** Keep the existing asynchronous task, storage write barrier, bootstrap store, polling, and controlled desktop restart. Add a `switch_storage` operation to `MigrationManager`; the software-settings API always invokes that operation after resolving, creating, and write-probing the exact selected directory. Retain the generic migration implementation for non-UI maintenance uses, but remove all migration semantics from the software-settings UI.

**Tech Stack:** Python 3.12, FastAPI, `unittest`, vanilla JavaScript, Node.js contract tests, PowerShell source gate.

---

### Task 1: Lock the direct-switch backend contract

**Files:**
- Modify: `tests/test_runtime_migration.py`
- Modify: `tests/test_storage_migration_api.py`

- [ ] **Step 1: Write failing manager tests**

Add tests that call the desired `switch_storage(source, target)` API and assert that the task reports `operation == "switch_storage"`, updates only bootstrap state, does not copy the source canvas into the target, preserves arbitrary target files byte-for-byte and mtime-for-mtime, and can switch back with a fresh manager representing the restarted process.

```python
task = manager.switch_storage(self.source, self.target)
state = manager.wait(task.id, timeout=5)
self.assertEqual(state.operation, "switch_storage")
self.assertEqual(state.total_bytes, 0)
self.assertFalse((self.target / "projects" / "canvas.json").exists())
self.assertEqual(self.bootstrap.require().data_root, str(self.target.resolve()))
```

- [ ] **Step 2: Write failing API tests**

Change the empty-target and existing-Hstar-target tests to expect `switch_storage` and no copied files. Replace the rejection test for an arbitrary nonempty target with a success test that records the ordinary file bytes and `st_mtime_ns`, switches, and verifies both remain unchanged.

```python
ordinary = self.target / "notes.txt"
ordinary.write_text("keep", encoding="utf-8")
before = ordinary.stat()
response = await self.client.post("/api/storage-migrations", json={"storage_root": str(self.target)})
task = await self.wait_for_terminal_state(response.json()["task"]["id"])
self.assertEqual(task["operation"], "switch_storage")
self.assertEqual(ordinary.read_text(encoding="utf-8"), "keep")
self.assertEqual(ordinary.stat().st_mtime_ns, before.st_mtime_ns)
```

- [ ] **Step 3: Run tests and verify RED**

Run:

```powershell
.\python\python.exe -m unittest tests.test_runtime_migration tests.test_storage_migration_api
```

Expected: FAIL because `MigrationManager.switch_storage` does not exist and the API still rejects arbitrary nonempty targets or invokes `migrate`.

### Task 2: Implement the direct storage switch

**Files:**
- Modify: `hstar_runtime/migration.py`
- Modify: `main.py`

- [ ] **Step 1: Add the manager operation**

Add a public method and route it through `_run`:

```python
def switch_storage(self, source: Path, target: Path) -> MigrationState:
    return self._start(source, target, operation="switch_storage")
```

Use the existing switch-only implementation to validate source/target boundaries, enter `switch_guard`, atomically save the bootstrap target, and complete without manifest creation, hashing, copying, verification, or transaction directories. Keep `activate_existing` as a compatibility wrapper if tests or maintenance callers still use it.

- [ ] **Step 2: Make the software-settings endpoint always switch**

Resolve and boundary-check X before creation, call `normalize_storage_root` for every accepted path so nonexistent directories are created and all directories are write-probed, then invoke only `STORAGE_MIGRATIONS.switch_storage(source, target)`.

```python
target = Path(resolve_storage_root(payload.storage_root))
validate_storage_migration_target(source, target)
target = Path(normalize_storage_root(str(target)))
task = STORAGE_MIGRATIONS.switch_storage(source, target)
```

Remove `existing_hstar_storage_target` and the now-unused `has_existing_hstar_storage` import from `main.py`. Do not alter the generic migration manager or voice model migration routes.

- [ ] **Step 3: Run backend tests and verify GREEN**

Run:

```powershell
.\python\python.exe -m unittest tests.test_runtime_migration tests.test_storage_migration_api
```

Expected: all tests pass; the old source remains present and no source payload appears under a newly selected target.

### Task 3: Remove migration semantics from software settings

**Files:**
- Modify: `static/js/storage-settings-panel.js`
- Modify: `static/software-settings.html`
- Modify: `tools/tests/storage-settings-panel.test.mjs`
- Modify: `tools/tests/software-settings-integration.test.mjs`

- [ ] **Step 1: Write failing UI contract tests**

Make the panel test render a `switch_storage` task and assert:

```javascript
assert.equal(elements.storageProgressStage.textContent, '正在应用存储位置');
assert.equal(elements.storageProgress.hidden, true);
assert.equal(elements.storageProgressBytes.hidden, true);
assert.equal(elements.status.textContent, '正在应用存储位置');
```

Assert the completion path always says `存储位置已切换` and the storage card no longer labels its progress element `数据迁移进度` or its button `取消迁移`.

- [ ] **Step 2: Run UI tests and verify RED**

Run:

```powershell
node tools/tests/storage-settings-panel.test.mjs
node tools/tests/software-settings-integration.test.mjs
```

Expected: FAIL because `switch_storage` is not labeled and migration-specific controls remain visible.

- [ ] **Step 3: Implement switch-only presentation**

Add `switch_storage` labels for `preflight`, `switching`, `cancelling`, `completed`, `cancelled`, and `failed`. Hide byte progress for `switch_storage`, change the accessible progress label to `存储位置应用状态`, change the command to `取消应用`, and use switch wording for desktop and browser completion. Leave generic migration rendering available only for non-software-settings callers.

- [ ] **Step 4: Synchronize static cache keys**

Compute the version contract from `VERSION` plus each referenced file's integer mtime and update:

```text
static/software-settings.html -> /static/js/storage-settings-panel.js?v=<VERSION>.<mtime>
static/index.html -> /static/software-settings.html?v=<VERSION>.<mtime>
```

- [ ] **Step 5: Run UI tests and verify GREEN**

Run:

```powershell
node tools/tests/storage-settings-panel.test.mjs
node tools/tests/software-settings-integration.test.mjs
node --test tools/tests/static-cache-integrity.test.mjs
```

Expected: all tests pass.

### Task 4: Verify isolation and the complete source tree

**Files:**
- No production edits expected
- Use only temporary directories outside `E:\Hstar缓存`

- [ ] **Step 1: Run formatting and targeted regression checks**

```powershell
git diff --check
.\python\python.exe -m unittest tests.test_runtime_migration tests.test_storage_migration_api
node tools/tests/storage-settings-panel.test.mjs
```

Expected: PASS with no whitespace errors.

- [ ] **Step 2: Run the complete source gate**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\build\scripts\Test-HstarSource.ps1
```

Expected: encoding audit, secret audit, Python tests, Node tests, and cache integrity all pass.

- [ ] **Step 3: Run an isolated HTTP smoke test**

Start HstarA on port 3000 with `HSTAR_DATA_DIR` set to an isolated temporary Y. Create an unrelated file in temporary X, request the storage switch, poll to completion, and verify by SHA-256, size, and mtime that Y and X's unrelated file are unchanged. Never use `E:\Hstar缓存`, port 5000, or the user's previous migration target for this test.

- [ ] **Step 4: Restore the development server**

Start the bundled Python backend hidden on port 3000 with:

```powershell
HSTAR_DATA_DIR=E:\Hstar缓存
HSTAR_EDITION=development
```

Open `http://127.0.0.1:3000/` and confirm the health endpoint responds. Do not modify existing Hstar cache data during startup validation.
