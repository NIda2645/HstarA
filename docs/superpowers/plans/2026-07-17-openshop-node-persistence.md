# OpenShop Node-Scoped Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Store every OpenShop layered-editing node in its own durable canvas sidecar directory, eliminate cross-node OPFS recovery, and permanently delete only the selected node's data while preserving connected image-node assets.

**Architecture:** `OpenShopProjectStore` will derive project paths from the validated `(canvasType, canvasId, nodeId)` owner and lazily migrate legacy global project files. HstarA's embedded editor will use the existing debounced server autosave as the sole authority and will never initialize the shared OPFS recovery slot. Canvas PUT remains the authoritative deletion boundary because it persists surviving upstream/downstream nodes before deleting the removed OpenShop sidecar.

**Tech Stack:** Python 3, FastAPI/Pydantic, pathlib atomic file replacement, vanilla JavaScript, Vitest/JSDOM, Node harness tests, Playwright.

---

## File Map

- Modify `openshop_projects.py`: owner-derived sidecar paths, legacy migration, sidecar enumeration, clone ownership, node/canvas deletion.
- Modify `main.py`: construct the store with `CANVAS_DIR`, accept a clone source owner, and retain post-canvas-save cleanup ordering.
- Modify `static/js/openshop-host.js`: carry clone source-node ownership and release deleted-node sessions without deleting server data before the canvas graph is saved.
- Modify `static/js/canvas-openshop.js`: persist `cloneSourceNodeId` until the first successful clone load.
- Modify `static/js/smart-canvas-openshop.js`: mirror classic-canvas clone ownership behavior.
- Modify `integrations/openshop/index.html`: start OPFS recovery only for standalone top-level OpenShop.
- Modify `integrations/openshop/host/openshop-host-runtime.js`: mark validated HstarA sessions as embedded persistence mode.
- Modify `tools/tests/openshop-project-storage.test.mjs`: backend path, migration, ownership, clone, deletion, and asset-retention coverage.
- Modify `tools/tests/openshop-classic-node-session-flow.test.mjs`: classic clone source owner and local session disposal coverage.
- Modify `tools/tests/openshop-smart-node-session-flow.test.mjs`: smart clone source owner and local session disposal coverage.
- Modify `integrations/openshop/tests/hstar-openshop-host.test.js`: host clone request and deletion ordering tests.
- Modify `integrations/openshop/tests/hstar-host-runtime.test.js`: embedded persistence handshake test.
- Modify `integrations/openshop/tests/os-unit.test.js`: standalone-versus-embedded OPFS startup tests.
- Modify `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`: two-node restart isolation, no recovery prompt, exact layer restoration, and downstream-asset retention.

### Task 1: Lock The Sidecar Store Contract With Failing Tests

**Files:**
- Modify: `tools/tests/openshop-project-storage.test.mjs`
- Test: `tools/tests/openshop-project-storage.test.mjs`

- [ ] **Step 1: Make the harness use an explicit canvas directory**

Replace the first store setup in the Python harness with:

```python
with tempfile.TemporaryDirectory(prefix="hstara-openshop-store-") as data_dir:
    canvas_dir = Path(data_dir) / "canvases"
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)
    owner_a = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-a"}
    owner_b = {"canvasType": "classic", "canvasId": "canvas-a", "nodeId": "node-b"}
```

- [ ] **Step 2: Assert node-specific paths and independent full project data**

Immediately after saving projects A and B, add:

```python
    project_a_path = canvas_dir / "canvas-a.openshop" / "node-a" / "project.json"
    project_b_path = canvas_dir / "canvas-a.openshop" / "node-b" / "project.json"
    assert project_a_path.is_file()
    assert project_b_path.is_file()
    assert not (Path(data_dir) / "projects" / "project-a.json").exists()
    assert json.loads(project_a_path.read_text(encoding="utf-8"))["layers"][0]["name"] == "标题"
    assert json.loads(project_b_path.read_text(encoding="utf-8"))["layers"][0]["name"] == "副本标题"
```

- [ ] **Step 3: Add owner-checked clone and lazy migration cases**

Add this independent block before `api_lifecycle()`:

```python
with tempfile.TemporaryDirectory(prefix="hstara-openshop-migration-") as data_dir:
    root = Path(data_dir)
    canvas_dir = root / "canvases"
    legacy_dir = root / "projects"
    legacy_dir.mkdir(parents=True)
    owner = {"canvasType": "classic", "canvasId": "canvas-migrate", "nodeId": "node-old"}
    wrong_owner = {**owner, "nodeId": "node-wrong"}
    legacy_project = {
        "schemaVersion": 1,
        "projectId": "project-old",
        "owner": owner,
        "document": {"width": 640, "height": 480, "resolution": 72, "colorSpace": "srgb"},
        "editor": {"objects": [{"type": "i-text", "text": "legacy marker"}]},
        "layers": [{"layerId": "legacy-layer", "name": "Legacy Layer"}],
        "sourceBindings": [],
        "fontRefs": [],
        "aiToolPreferences": {},
        "aiReferenceRecords": [],
        "aiTaskRecords": [],
        "aiPendingResults": [],
        "assetRefs": [],
        "previewAssetId": "",
        "autosaveVersion": 7,
        "exportRecords": [],
        "createdAt": 1000,
        "updatedAt": 2000,
    }
    legacy_path = legacy_dir / "project-old.json"
    legacy_path.write_text(json.dumps(legacy_project, ensure_ascii=False), encoding="utf-8")
    store = OpenShopProjectStore(data_dir, canvas_dir=canvas_dir)

    try:
        store.load("project-old", wrong_owner)
        raise AssertionError("legacy migration must reject a mismatched owner")
    except OpenShopOwnershipError:
        pass
    assert legacy_path.is_file()

    migrated = store.load("project-old", owner)
    sidecar = canvas_dir / "canvas-migrate.openshop" / "node-old" / "project.json"
    assert migrated["autosaveVersion"] == 7
    assert migrated["editor"]["objects"][0]["text"] == "legacy marker"
    assert sidecar.is_file()
    assert not legacy_path.exists()
    assert store.load("project-old", owner)["layers"][0]["name"] == "Legacy Layer"

    clone_owner = {**owner, "nodeId": "node-clone"}
    cloned = store.clone("project-old", owner, "project-clone", clone_owner)
    assert cloned["owner"] == clone_owner
    assert cloned["layers"][0]["name"] == "Legacy Layer"
    try:
        store.clone("project-old", wrong_owner, "project-forbidden", clone_owner)
        raise AssertionError("clone must validate the source owner")
    except OpenShopOwnershipError:
        pass
```

- [ ] **Step 4: Run the harness and verify it fails for the new constructor/path contract**

Run:

```powershell
node tools/tests/openshop-project-storage.test.mjs
```

Expected: FAIL because `OpenShopProjectStore.__init__()` does not accept `canvas_dir`, or because projects still appear under `data/openshop/projects`.

### Task 2: Implement Owner-Derived Sidecars And Legacy Migration

**Files:**
- Modify: `openshop_projects.py`
- Modify: `main.py`
- Test: `tools/tests/openshop-project-storage.test.mjs`

- [ ] **Step 1: Add the sidecar and legacy directory fields**

Replace `OpenShopProjectStore.__init__` with:

```python
def __init__(self, data_dir: str, canvas_dir: str | None = None):
    root = Path(data_dir).expanduser().resolve()
    self.root = root
    self.legacy_projects_dir = root / "projects"
    self.assets_dir = root / "assets"
    self.canvas_dir = Path(canvas_dir or (root / "canvases")).expanduser().resolve()
    self.legacy_projects_dir.mkdir(parents=True, exist_ok=True)
    self.assets_dir.mkdir(parents=True, exist_ok=True)
    self.canvas_dir.mkdir(parents=True, exist_ok=True)
    self._lock = threading.RLock()
```

Add `import shutil` beside the existing imports.

- [ ] **Step 2: Add exact owner-derived path and migration helpers**

Replace `_read_project` and `_project_path`, then add the iterator and migration helpers:

```python
def _project_directory(self, owner: dict) -> Path:
    normalized_owner = self._normalize_owner(owner)
    return (
        self.canvas_dir
        / f"{normalized_owner['canvasId']}.openshop"
        / normalized_owner["nodeId"]
    )

def _project_path(self, owner: dict) -> Path:
    return self._project_directory(owner) / "project.json"

def _legacy_project_path(self, project_id: str) -> Path:
    return self.legacy_projects_dir / f"{self._validate_id(project_id, 'projectId')}.json"

def _validate_project_manifest(self, project: dict, project_id: str, owner: dict) -> dict:
    if (
        project.get("schemaVersion") != self.SCHEMA_VERSION
        or project.get("projectId") != project_id
    ):
        raise OpenShopValidationError(f"Invalid OpenShop project manifest: {project_id}")
    self._assert_owner(project, owner)
    project.setdefault("aiReferenceRecords", [])
    project.setdefault("aiPendingResults", [])
    return project

def _migrate_legacy_project(self, project_id: str, owner: dict) -> Path:
    legacy_path = self._legacy_project_path(project_id)
    target_path = self._project_path(owner)
    if target_path.is_file() or not legacy_path.is_file():
        return target_path
    legacy = self._read_json(legacy_path, "legacy project")
    self._validate_project_manifest(legacy, project_id, owner)
    self._atomic_write_json(target_path, legacy)
    migrated = self._read_json(target_path, "project")
    self._validate_project_manifest(migrated, project_id, owner)
    legacy_path.unlink()
    return target_path

def _read_project(self, project_id: str, owner: dict) -> dict:
    normalized_project_id = self._validate_id(project_id, "projectId")
    normalized_owner = self._normalize_owner(owner)
    path = self._migrate_legacy_project(normalized_project_id, normalized_owner)
    if not path.is_file():
        raise OpenShopNotFound(f"OpenShop project not found: {normalized_project_id}")
    project = self._read_json(path, "project")
    return self._validate_project_manifest(project, normalized_project_id, normalized_owner)

def _iter_project_paths(self):
    yield from sorted(self.canvas_dir.glob("*.openshop/*/project.json"))
    yield from sorted(self.legacy_projects_dir.glob("*.json"))
```

- [ ] **Step 3: Route initialize, load, save, clone, and delete through owner paths**

Apply these signatures and path calls:

```python
def load(self, project_id: str, owner: dict) -> dict:
    project_id = self._validate_id(project_id, "projectId")
    normalized_owner = self._normalize_owner(owner)
    with self._lock:
        return copy.deepcopy(self._read_project(project_id, normalized_owner))

def clone(
    self,
    source_project_id: str,
    source_owner: dict,
    target_project_id: str,
    target_owner: dict,
) -> dict:
    source_project_id = self._validate_id(source_project_id, "sourceProjectId")
    target_project_id = self._validate_id(target_project_id, "targetProjectId")
    normalized_source_owner = self._normalize_owner(source_owner)
    normalized_target_owner = self._normalize_owner(target_owner)
    with self._lock:
        target_path = self._project_path(normalized_target_owner)
        if target_path.exists():
            existing = self._read_project(target_project_id, normalized_target_owner)
            return copy.deepcopy(existing)
        source = self._read_project(source_project_id, normalized_source_owner)
        clone = copy.deepcopy(source)
        timestamp = self._now()
        clone["projectId"] = target_project_id
        clone["owner"] = normalized_target_owner
        clone["autosaveVersion"] = 1
        clone["createdAt"] = timestamp
        clone["updatedAt"] = timestamp
        clone["aiTaskRecords"] = []
        clone["aiReferenceRecords"] = []
        clone["aiPendingResults"] = []
        self._atomic_write_json(target_path, clone)
        return copy.deepcopy(clone)

def delete(self, project_id: str, owner: dict | None = None) -> bool:
    project_id = self._validate_id(project_id, "projectId")
    if owner is None:
        raise OpenShopValidationError("OpenShop owner is required for deletion")
    normalized_owner = self._normalize_owner(owner)
    with self._lock:
        path = self._project_path(normalized_owner)
        if not path.exists():
            legacy_path = self._legacy_project_path(project_id)
            if not legacy_path.exists():
                return False
            project = self._read_json(legacy_path, "legacy project")
            self._validate_project_manifest(project, project_id, normalized_owner)
            legacy_path.unlink()
            return True
        project = self._read_json(path, "project")
        self._validate_project_manifest(project, project_id, normalized_owner)
        shutil.rmtree(self._project_directory(normalized_owner))
        canvas_sidecar = self._project_directory(normalized_owner).parent
        if canvas_sidecar.is_dir() and not any(canvas_sidecar.iterdir()):
            canvas_sidecar.rmdir()
        return True
```

In `initialize`, replace `path = self._project_path(project_id)` with:

```python
path = self._project_path(normalized_owner)
if path.exists() or self._legacy_project_path(project_id).exists():
    return self.load(project_id, normalized_owner)
```

In `save`, replace every `_read_project(project_id)` with `_read_project(project_id, normalized_owner)` and replace the final path with:

```python
self._atomic_write_json(self._project_path(normalized_owner), candidate)
```

In `store_image`, replace the project read and the output-role manifest write
with the same owner-derived path:

```python
project = self._read_project(project_id, normalized_owner)
```

```python
self._atomic_write_json(self._project_path(normalized_owner), project)
```

Run `rg -n "_read_project\\(|_project_path\\(|projects_dir" openshop_projects.py`
after these edits. Every project read/write must pass a normalized owner; the
only global project-directory reference that may remain is
`legacy_projects_dir` for migration.

- [ ] **Step 4: Enumerate sidecars for canvas deletion and asset garbage collection**

Replace `delete_canvas_projects` with:

```python
def delete_canvas_projects(self, canvas_type: str, canvas_id: str) -> list[str]:
    normalized_canvas_type = str(canvas_type or "").strip()
    if normalized_canvas_type not in {"classic", "smart"}:
        raise OpenShopValidationError("canvasType must be classic or smart")
    normalized_canvas_id = self._validate_id(canvas_id, "canvasId")
    canvas_sidecar = self.canvas_dir / f"{normalized_canvas_id}.openshop"
    with self._lock:
        removed = []
        if canvas_sidecar.is_dir():
            for path in sorted(canvas_sidecar.glob("*/project.json")):
                project = self._read_json(path, "project")
                owner = self._normalize_owner(project.get("owner"))
                if owner["canvasType"] != normalized_canvas_type or owner["canvasId"] != normalized_canvas_id:
                    raise OpenShopOwnershipError("OpenShop canvas sidecar owner mismatch")
                removed.append(self._validate_id(project.get("projectId"), "projectId"))
            shutil.rmtree(canvas_sidecar)
        for path in sorted(self.legacy_projects_dir.glob("*.json")):
            project = self._read_json(path, "legacy project")
            owner = self._normalize_owner(project.get("owner"))
            if owner["canvasType"] == normalized_canvas_type and owner["canvasId"] == normalized_canvas_id:
                path.unlink()
                removed.append(self._validate_id(project.get("projectId"), "projectId"))
        return sorted(set(removed))
```

In `collect_garbage`, replace `for path in sorted(self.projects_dir.glob("*.json")):` with:

```python
for path in self._iter_project_paths():
```

- [ ] **Step 5: Point the application store at the real canvas directory**

In `main.py`, replace the store construction with:

```python
OPENSHOP_STORE = OpenShopProjectStore(OPENSHOP_DATA_DIR, canvas_dir=CANVAS_DIR)
```

- [ ] **Step 6: Run the storage harness**

Run:

```powershell
node tools/tests/openshop-project-storage.test.mjs
```

Expected: PASS and output ending with `OpenShop project storage tests passed`.

- [ ] **Step 7: Commit the sidecar store**

```powershell
git add openshop_projects.py main.py tools/tests/openshop-project-storage.test.mjs
git commit -m "feat: persist OpenShop projects beside canvases"
```

### Task 3: Carry Explicit Source Ownership Through Project Cloning

**Files:**
- Modify: `main.py`
- Modify: `static/js/openshop-host.js`
- Modify: `static/js/canvas-openshop.js`
- Modify: `static/js/smart-canvas-openshop.js`
- Modify: `tools/tests/openshop-project-storage.test.mjs`
- Modify: `tools/tests/openshop-classic-node-session-flow.test.mjs`
- Modify: `tools/tests/openshop-smart-node-session-flow.test.mjs`
- Modify: `integrations/openshop/tests/hstar-openshop-host.test.js`

- [ ] **Step 1: Write failing adapter tests for `cloneSourceNodeId`**

In the classic Node session-flow test, add these assertions after
`adapter.prepareClone(node, clone)`:

```javascript
assert.equal(clone.cloneSourceNodeId, node.id);
nodes.push(clone);
assert.equal(adapter.openNode(clone.id), true);
assert.equal(openedSessions.at(-1).context.cloneSourceNodeId, node.id);
```

In the smart Node session-flow test, add these assertions after
`adapter.prepareClone(projectNode, clone)`:

```javascript
assert.equal(clone.cloneSourceNodeId, projectNode.id);
nodes.push(clone);
assert.equal(adapter.openNode(clone.id), true);
assert.equal(openedSessions.at(-1).context.cloneSourceNodeId, projectNode.id);
```

- [ ] **Step 2: Write a failing host request test**

In `hstar-openshop-host.test.js`, mock `fetch`, open a clone session, dispatch the iframe `READY` message, and assert the POST body:

```javascript
expect(JSON.parse(fetch.mock.calls.find(([url, options]) =>
  String(url).includes('/clone') && options?.method === 'POST'
)[1].body)).toEqual({
  source_project_id:'project-source',
  source_owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-source'},
  owner:{canvasType:'classic', canvasId:'canvas-1', nodeId:'node-clone'},
});
```

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
node tools/tests/openshop-classic-node-session-flow.test.mjs
node tools/tests/openshop-smart-node-session-flow.test.mjs
Set-Location integrations/openshop
npx vitest run tests/hstar-openshop-host.test.js
```

Expected: FAIL because clones do not retain a source node ID and the host sends no source owner.

- [ ] **Step 4: Add source ownership to the API contract**

In `main.py`, replace the clone request model with:

```python
class OpenShopProjectCloneRequest(BaseModel):
    source_project_id: str
    source_owner: Dict[str, Any]
    owner: Dict[str, Any]
```

Replace the store call in `clone_openshop_project` with:

```python
project = await asyncio.to_thread(
    OPENSHOP_STORE.clone,
    payload.source_project_id,
    payload.source_owner,
    project_id,
    payload.owner,
)
```

Update the API lifecycle clone request in `openshop-project-storage.test.mjs` to send:

```python
json={
    "source_project_id": "project-api",
    "source_owner": owner,
    "owner": clone_owner,
}
```

- [ ] **Step 5: Persist the source node ID in both canvas adapters**

Add `cloneSourceNodeId:''` beside `cloneSourceProjectId:''` in both `createNode` functions. In both `prepareClone` functions add:

```javascript
copy.cloneSourceNodeId = clean(source?.id);
```

In both `openNode` context objects add:

```javascript
cloneSourceNodeId:clean(node.cloneSourceNodeId),
```

In both metadata handlers, clear both one-time clone fields:

```javascript
node.cloneSourceProjectId = '';
node.cloneSourceNodeId = '';
```

- [ ] **Step 6: Send the validated source owner from the host**

In `static/js/openshop-host.js`, extend `normalizedContext` with:

```javascript
cloneSourceNodeId:clean(value.cloneSourceNodeId),
```

Replace the clone request body with:

```javascript
body:JSON.stringify({
    source_project_id:context.cloneSourceProjectId,
    source_owner:{
        canvasType:context.canvasType,
        canvasId:context.canvasId,
        nodeId:context.cloneSourceNodeId,
    },
    owner,
}),
```

Reject incomplete clone context before fetching:

```javascript
if(context.cloneSourceProjectId && !context.cloneSourceNodeId){
    throw new Error('OpenShop clone source owner is incomplete');
}
```

- [ ] **Step 7: Run focused storage and host tests**

Run:

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
node tools/tests/openshop-project-storage.test.mjs
node tools/tests/openshop-classic-node-session-flow.test.mjs
node tools/tests/openshop-smart-node-session-flow.test.mjs
Set-Location integrations/openshop
npx vitest run tests/hstar-openshop-host.test.js
```

Expected: all four commands PASS.

- [ ] **Step 8: Commit explicit clone ownership**

```powershell
git add main.py static/js/openshop-host.js static/js/canvas-openshop.js static/js/smart-canvas-openshop.js tools/tests/openshop-project-storage.test.mjs tools/tests/openshop-classic-node-session-flow.test.mjs tools/tests/openshop-smart-node-session-flow.test.mjs integrations/openshop/tests/hstar-openshop-host.test.js
git commit -m "fix: scope OpenShop clones to source nodes"
```

### Task 4: Disable Shared OPFS Recovery In Embedded HstarA

**Files:**
- Modify: `integrations/openshop/index.html`
- Modify: `integrations/openshop/host/openshop-host-runtime.js`
- Modify: `integrations/openshop/tests/os-unit.test.js`
- Modify: `integrations/openshop/tests/hstar-host-runtime.test.js`

- [ ] **Step 1: Add failing persistence-mode unit tests**

In `os-unit.test.js`, add:

```javascript
it('starts OPFS recovery only for standalone top-level OpenShop', () => {
  const init = vi.spyOn(OS, '_initAutoSave').mockResolvedValue();
  OS._persistenceMode = 'standalone';
  OS._startRecoveryForCurrentMode({topLevel:true});
  expect(init).toHaveBeenCalledTimes(1);
  init.mockClear();
  OS._persistenceMode = 'embedded-hstara';
  OS._startRecoveryForCurrentMode({topLevel:true});
  OS._startRecoveryForCurrentMode({topLevel:false});
  expect(init).not.toHaveBeenCalled();
});
```

In `hstar-host-runtime.test.js`, open a validated session and assert:

```javascript
expect(editor._setPersistenceMode).toHaveBeenCalledWith('embedded-hstara');
```

Add `_setPersistenceMode:vi.fn()` to that test's editor fixture.

- [ ] **Step 2: Run focused tests and verify failure**

Run:

```powershell
Set-Location integrations/openshop
npx vitest run tests/os-unit.test.js tests/hstar-host-runtime.test.js
```

Expected: FAIL because the persistence-mode methods do not exist.

- [ ] **Step 3: Add explicit recovery startup policy to `OS`**

Replace the unconditional `this._initAutoSave();` call in `OS.init()` with:

```javascript
this._persistenceMode = window.self === window.top ? 'standalone' : 'embedded-pending';
this._startRecoveryForCurrentMode({topLevel:window.self === window.top});
```

Add these methods beside the auto-save fields:

```javascript
_persistenceMode: 'standalone',
_startRecoveryForCurrentMode({topLevel = window.self === window.top} = {}) {
    if (!topLevel || this._persistenceMode !== 'standalone') return false;
    void this._initAutoSave();
    return true;
},
_setPersistenceMode(mode) {
    const normalized = mode === 'embedded-hstara' ? 'embedded-hstara' : 'standalone';
    this._persistenceMode = normalized;
    if (normalized === 'embedded-hstara') {
        if (this._autoSaveTimer) clearInterval(this._autoSaveTimer);
        this._autoSaveTimer = null;
        this._autoSaveDirty = false;
        this._recoveryData = null;
        document.querySelectorAll('.modal-overlay [data-recovery-discard], .modal-overlay [data-recovery-restore]')
            .forEach(button => button.closest('.modal-overlay')?.remove());
    }
    return normalized;
},
```

Do not call `_discardRecovery()` in embedded mode because deleting the shared OPFS file would mutate standalone recovery data.

- [ ] **Step 4: Apply embedded mode only after a validated host message**

At the start of `openSession(envelope)` in `openshop-host-runtime.js`, add:

```javascript
state.editor._setPersistenceMode?.('embedded-hstara');
```

The runtime already validates `event.origin`, `event.source`, protocol version, and the complete session context before calling `openSession`.

- [ ] **Step 5: Run focused tests**

Run:

```powershell
npx vitest run tests/os-unit.test.js tests/hstar-host-runtime.test.js
```

Expected: PASS, including the existing standalone recovery-manager tests.

- [ ] **Step 6: Commit embedded persistence mode**

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
git add integrations/openshop/index.html integrations/openshop/host/openshop-host-runtime.js integrations/openshop/tests/os-unit.test.js integrations/openshop/tests/hstar-host-runtime.test.js
git commit -m "fix: disable shared recovery for embedded OpenShop"
```

### Task 5: Make Node Deletion Permanent But Asset-Safe

**Files:**
- Modify: `static/js/openshop-host.js`
- Modify: `tools/tests/openshop-project-storage.test.mjs`
- Modify: `integrations/openshop/tests/hstar-openshop-host.test.js`
- Modify: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`

- [ ] **Step 1: Extend the existing backend deletion/asset-retention test with sidecar assertions**

The API lifecycle harness already creates `output_asset`, saves `output-api` as a
downstream image node, removes only `node-api` through canvas PUT, verifies
`project-api` returns 404, and verifies the output asset remains readable. Add
the sidecar assertions directly around that existing deletion:

```python
node_sidecar = Path(main.CANVAS_DIR) / f"{canvas['id']}.openshop" / "node-api"
assert node_sidecar.is_dir()
```

Place that block immediately before the existing
`detached = await client.put(...)` line. Place this block immediately after the
existing PUT:

```python
assert not node_sidecar.exists()

missing_project = await client.get(
    "/api/openshop/projects/project-api",
    params={"canvas_type": "classic", "canvas_id": canvas["id"], "node_id": "node-api"},
)
assert missing_project.status_code == 404
assert (await client.get(output_asset["url"])).status_code == 200
saved_canvas = (await client.get(f"/api/canvases/{canvas['id']}")).json()["canvas"]
assert [node["id"] for node in saved_canvas["nodes"]] == ["output-api"]
```

Keep the existing source-asset 404 assertion and final output-node removal test.
Also assert `project-soft` remains under its smart-canvas sidecar after soft
delete and that the complete `<smartCanvasId>.openshop` directory is absent
after permanent purge.

```python
soft_sidecar = Path(main.CANVAS_DIR) / f"{smart_canvas['id']}.openshop"
assert (soft_sidecar / "node-soft" / "project.json").is_file()
soft_deleted = await client.delete(f"/api/canvases/{smart_canvas['id']}")
assert soft_deleted.status_code == 200
assert (soft_sidecar / "node-soft" / "project.json").is_file()

purged = await client.delete(f"/api/canvases/{smart_canvas['id']}/purge")
assert purged.status_code == 200
assert not soft_sidecar.exists()
```

- [ ] **Step 2: Add a failing host test that remote deletion is not sent before canvas save**

In `hstar-openshop-host.test.js`, create a session, call `host.disposeProject`, and assert:

```javascript
expect(fetch.mock.calls.some(([, options]) => options?.method === 'DELETE')).toBe(false);
expect(host.getState().sessionCount).toBe(0);
```

This protects an unsaved downstream image node from losing its asset before the canvas PUT records the surviving reference.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
node tools/tests/openshop-project-storage.test.mjs
Set-Location integrations/openshop
npx vitest run tests/hstar-openshop-host.test.js
```

Expected: FAIL because the host currently sends DELETE before the canvas save and the old store does not remove the sidecar directory.

- [ ] **Step 4: Make host disposal local-only**

Replace `disposeProject` in `static/js/openshop-host.js` with:

```javascript
async function disposeProject(projectId, contextValue){
    const context = normalizedContext({...contextValue, projectId:clean(projectId) || contextValue?.projectId});
    const scope = Protocol.createProjectScope(context);
    const session = state.sessions.get(scope);
    if(!session) return false;
    const wasActive = state.activeScope === scope;
    releaseSession(session, 'project-node-deleted');
    if(wasActive) hideOverlay();
    return true;
}
```

The canvas PUT endpoint remains the authoritative remote deletion trigger. It already writes the surviving graph before calling `remove_openshop_projects`, which then runs asset garbage collection against the newly saved canvas JSON.

- [ ] **Step 5: Extend the classic E2E deletion case**

In the existing `classic canvas preserves isolated projects...` test:

1. Send an output from clone `openshop-c` to create a downstream image node.
2. Record the output node ID, URL, and asset ID.
3. Delete only `openshop-c` and its attached graph edges.
4. Keep the downstream image node in the canvas node array.
5. Assert the clone project returns 404, node A and node B still return 200, the downstream node remains in the canvas, and GET on the output URL returns 200.

Use these exact assertions after deletion:

```javascript
expect((await projectRecord(request, {
  canvasType:'classic', canvasId:classic.id, nodeId:'openshop-c', projectId:cloneInfo.projectId,
})).response.status()).toBe(404);
const afterDelete = await canvasRecord(request, classic.id);
expect(afterDelete.nodes.some(node => node.id === cloneOutput.id)).toBe(true);
expect(afterDelete.nodes.some(node => node.id === 'openshop-c')).toBe(false);
expect((await request.get(`${baseUrl}${cloneOutput.url}`)).status()).toBe(200);
```

- [ ] **Step 6: Run focused unit and E2E tests**

Run:

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
node tools/tests/openshop-project-storage.test.mjs
Set-Location integrations/openshop
npx vitest run tests/hstar-openshop-host.test.js
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npx playwright test tests/hstar-canvas-integration.e2e.spec.js --grep "classic canvas preserves isolated projects"
```

Expected: PASS. The E2E cleanup helper must purge the test canvas after the test and must refuse to run if storage is outside the engineering worktree.

- [ ] **Step 7: Commit deletion safety**

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
git add static/js/openshop-host.js tools/tests/openshop-project-storage.test.mjs integrations/openshop/tests/hstar-openshop-host.test.js integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js
git commit -m "fix: delete OpenShop nodes without removing connected assets"
```

### Task 6: Prove Exact Multi-Node Restart Restoration

**Files:**
- Modify: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`
- Test: `integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js`

- [ ] **Step 1: Strengthen the existing two-node restart test**

Before saving marker A and marker B, record each editor's complete serializable layer summary:

```javascript
const exactLayerSummary = editor => editor.evaluate(() => OS.layers.map((layer, layerIndex) => ({
  layerIndex,
  name:layer.name,
  type:layer.type || 'normal',
  visible:Boolean(layer.visible),
  opacity:Number(layer.opacity),
  blend:layer.blend || 'source-over',
  locked:Boolean(layer.locked),
  objects:layer.objects.map(object => ({
    type:object.type,
    name:object.name || '',
    text:object.text || '',
    left:Number(object.left),
    top:Number(object.top),
    scaleX:Number(object.scaleX),
    scaleY:Number(object.scaleY),
    angle:Number(object.angle),
  })),
})));
```

After each marker save, capture `nodeASummary` and `nodeBSummary`. After page reload, assert node A exactly equals `nodeASummary`, does not contain B's marker, and node B exactly equals `nodeBSummary`, does not contain A's marker.

- [ ] **Step 2: Assert the embedded recovery UI never appears**

After each `openNode` call, add:

```javascript
await expect(editor.locator('[data-recovery-restore]')).toHaveCount(0);
await expect(editor.locator('[data-recovery-discard]')).toHaveCount(0);
```

Also assert the embedded session has disabled OPFS activity without deleting any
pre-existing standalone recovery file:

```javascript
expect(await editor.evaluate(() => ({
  mode:OS._persistenceMode,
  timerActive:Boolean(OS._autoSaveTimer),
  dirty:Boolean(OS._autoSaveDirty),
}))).toEqual({mode:'embedded-hstara', timerActive:false, dirty:false});
```

- [ ] **Step 3: Run the restart isolation E2E**

Run:

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing\integrations\openshop
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npx playwright test tests/hstar-canvas-integration.e2e.spec.js --grep "classic canvas preserves isolated projects"
```

Expected: PASS with exact layer summaries restored independently, no recovery UI,
and no embedded OPFS timer or dirty state.

- [ ] **Step 4: Commit the restart regression test**

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
git add integrations/openshop/tests/hstar-canvas-integration.e2e.spec.js
git commit -m "test: verify OpenShop node restart isolation"
```

### Task 7: Full Verification And Engineering Data Cleanup

**Files:**
- Verify: `openshop_projects.py`
- Verify: `main.py`
- Verify: `static/js/openshop-host.js`
- Verify: `static/js/canvas-openshop.js`
- Verify: `static/js/smart-canvas-openshop.js`
- Verify: `integrations/openshop/index.html`
- Verify: `integrations/openshop/host/openshop-host-runtime.js`

- [ ] **Step 1: Run all Node integration harnesses touched by the change**

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
node tools/tests/openshop-project-storage.test.mjs
node tools/tests/openshop-host-session-flow.test.mjs
node tools/tests/openshop-classic-node-session-flow.test.mjs
node tools/tests/openshop-smart-node-session-flow.test.mjs
```

Expected: all commands PASS.

- [ ] **Step 2: Run the complete OpenShop unit suite and localization audit**

```powershell
Set-Location integrations/openshop
npm test
npm run audit:i18n
```

Expected: all Vitest tests PASS and the i18n audit reports zero missing or invalid keys.

- [ ] **Step 3: Run Python tests**

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
python -m pytest -q
```

Expected: all Python tests PASS.

- [ ] **Step 4: Run the complete OpenShop canvas integration E2E**

Verify the engineering server uses the current worktree storage root before running:

```powershell
Invoke-RestMethod http://127.0.0.1:3000/api/software-settings | ConvertTo-Json -Depth 8
```

The returned `active_storage_root` must resolve inside
`E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing`.

Then run:

```powershell
Set-Location integrations/openshop
$env:HSTAR_BASE_URL='http://127.0.0.1:3000'
npm run test:hstar:canvas-integration
```

Expected: all canvas integration tests PASS. `hstar-test-canvas-cleanup.js` purges every tracked engineering canvas in `afterEach`.

- [ ] **Step 5: Verify no test canvas or temporary project remains**

```powershell
Set-Location E:\Claude专业组\HstarA\.worktrees\openshop-inline-generative-editing
git status --short
Get-ChildItem -Recurse -Filter '*.tmp' 'E:\Hstar缓存\data\canvases'
```

Expected: no `.tmp` files. Do not delete or inspect the stable installed HstarA storage location; only the engineering storage verified in Step 4 is in scope.

- [ ] **Step 6: Review the final diff for scope and accidental generated files**

```powershell
git diff --check
git diff --stat 70e96ce..HEAD
git status --short
```

Expected: no whitespace errors. Only the planned persistence code, tests, and design/plan documents are included in commits; pre-existing runtime-generated working-tree changes remain untouched.
