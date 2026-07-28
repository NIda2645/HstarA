# Hstar Windows 11 Installer Preparation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. The user explicitly prohibits subagents, so execute every task inline and stop at the listed checkpoints.

**Goal:** Build the shared user-data foundation and a reproducible, offline, no-console Windows 11 Hstar installer without touching the existing stable installation or its data.

**Architecture:** Extract all writable paths from `main.py` into a typed runtime-path package, persist only a small bootstrap pointer under AppData, and move settings, secrets, projects, assets, outputs, history, caches, logs, models, and temporary files beneath the user-selected data root. Add a source-controlled .NET 8 WPF shell that performs first-run data selection, starts the packaged Python backend invisibly, and loads a fixed WebView2 runtime. Build the installer stage only from a clean validated revision with exact runtime locks and strict data/model/secret exclusions.

**Tech Stack:** Python 3.11 x64 embedded runtime, FastAPI, Pydantic, Windows DPAPI through `ctypes`, .NET 8 WPF, Microsoft.Web.WebView2, PowerShell build scripts, Inno Setup 6, Node contract tests, Python `unittest`, xUnit, Playwright.

---

## Scope Boundary

This plan implements the data foundation and Windows 11 edition only. The classic Windows 7/8.1/10 installer gets a separate implementation plan after the Windows 11 package passes isolated and current-machine verification. Do not modify, stop, upgrade, uninstall, inspect user files from, or reuse binaries from the existing stable port-5000 installation.

## File Map

### Runtime data package

- Create `hstar_runtime/atomic.py`: shared fsync-and-replace helpers for bytes and JSON.
- Create `hstar_runtime/paths.py`: immutable program/data path model and default-root selection.
- Create `hstar_runtime/bootstrap.py`: bootstrap schema, atomic reads/writes, and edition ownership.
- Create `hstar_runtime/migration.py`: resumable transactional migration and progress state.
- Create `hstar_runtime/credentials.py`: DPAPI-backed API credential storage with test injection.
- Create `hstar_runtime/api_merge.py`: official-provider merge preserving custom providers.
- Create `hstar_runtime/maintenance.py`: hidden maintenance commands used by the installer/shell.
- Create `hstar_runtime/__init__.py`: public runtime package exports only.
- Modify `main.py`: consume the package, remove install-root writes, add migration APIs, and support packaged host/port/token settings.
- Modify `run.bat`: explicitly declare the engineering data root and keep port 3000.

### Data UI and contracts

- Modify `static/software-settings.html`: asynchronous migration progress, restart handoff, and complete path status.
- Create `static/js/storage-settings-panel.js`: storage migration controller separated from page markup.
- Modify `tools/tests/software-settings-integration.test.mjs`: assert the new runtime contracts.
- Create `tools/tests/runtime-data-ownership.test.mjs`: reject program-directory writes and stale installer paths.
- Create `tools/tests/storage-settings-panel.test.mjs`: verify migration states and restart handoff.

### Python tests

- Create `tests/test_runtime_paths.py`.
- Create `tests/test_runtime_bootstrap.py`.
- Create `tests/test_runtime_migration.py`.
- Create `tests/test_runtime_credentials.py`.
- Create `tests/test_api_config_merge.py`.
- Create `tests/test_storage_migration_api.py`.

### Windows 11 desktop shell

- Create `desktop/Hstar.Desktop/Hstar.Desktop.csproj` and WPF application files.
- Create `desktop/Hstar.Desktop/Runtime/AppPaths.cs`.
- Create `desktop/Hstar.Desktop/Runtime/SingleInstance.cs`.
- Create `desktop/Hstar.Desktop/Runtime/PortAllocator.cs`.
- Create `desktop/Hstar.Desktop/Runtime/BackendProcess.cs`.
- Create `desktop/Hstar.Desktop/Runtime/StartupCoordinator.cs`.
- Create `desktop/Hstar.Desktop/Views/StorageSetupWindow.xaml` and code-behind.
- Create `desktop/Hstar.Desktop.Tests/` xUnit project and focused runtime tests.

### Reproducible packaging

- Create `build/runtime-locks/windows11-requirements.txt`.
- Create `build/runtime-locks/windows11-runtime.json` through the locking command in Task 13.
- Create `build/scripts/Lock-HstarRuntime.ps1`.
- Create `build/scripts/New-HstarWindows11Stage.ps1`.
- Create `build/scripts/Test-HstarSource.ps1`.
- Create `build/scripts/Test-HstarWindows11Stage.ps1`.
- Replace the stale generic installer entry with `build/installer/Hstar.Windows11.iss`.
- Update installer contract tests to read the Windows 11 script.
- Create `tools/tests/windows11-installer-contract.test.mjs`.
- Create `tools/tests/windows11-stage-contract.test.mjs`.
- Create `tools/tests/windows11-runtime-lock.test.mjs`.
- Create `tools/measure-windows11-startup.ps1`.

## Task 1: Introduce the Typed Runtime Path Model

**Files:**
- Create: `hstar_runtime/__init__.py`
- Create: `hstar_runtime/paths.py`
- Test: `tests/test_runtime_paths.py`

- [ ] **Step 1: Write the failing path tests**

```python
import os
import tempfile
import unittest
from pathlib import Path

from hstar_runtime.paths import build_runtime_paths, default_data_root


class RuntimePathTests(unittest.TestCase):
    def test_prefers_e_drive_and_creates_hstar_cache_name(self):
        root = default_data_root(
            drive_exists=lambda drive: drive == "E:\\",
            documents=Path("C:/Users/Test/Documents"),
        )
        self.assertEqual(root, Path("E:/Hstar缓存"))

    def test_falls_back_to_documents_without_e_drive(self):
        root = default_data_root(
            drive_exists=lambda _drive: False,
            documents=Path("C:/Users/Test/Documents"),
        )
        self.assertEqual(root, Path("C:/Users/Test/Documents/Hstar缓存"))

    def test_every_writable_path_stays_under_data_root(self):
        with tempfile.TemporaryDirectory() as program, tempfile.TemporaryDirectory() as data:
            paths = build_runtime_paths(Path(program), Path(data), "windows11")
            for path in paths.writable_paths():
                self.assertTrue(path.is_relative_to(Path(data).resolve()), path)
            self.assertEqual(paths.static_dir, Path(program).resolve() / "static")
            self.assertEqual(paths.user_workflow_dir, Path(data).resolve() / "config" / "workflows")


if __name__ == "__main__":
    unittest.main()
```

- [ ] **Step 2: Run the test and confirm the package is missing**

Run: `python\python.exe -m unittest tests.test_runtime_paths -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'hstar_runtime'`.

- [ ] **Step 3: Implement the immutable model**

Implement `RuntimePaths` as a frozen dataclass. `build_runtime_paths()` must define program-owned `static_dir`, `builtin_workflow_dir`, and `api_defaults_dir`, plus data-owned config, secret, project, asset, output, history, model, cache, log, backup, and temp paths. Its `writable_paths()` method must return only paths below `data_root`.

```python
@dataclass(frozen=True)
class RuntimePaths:
    program_root: Path
    data_root: Path
    edition: str
    static_dir: Path
    builtin_workflow_dir: Path
    api_defaults_dir: Path
    config_dir: Path
    secrets_dir: Path
    project_dir: Path
    canvas_dir: Path
    openshop_dir: Path
    director_dir: Path
    asset_dir: Path
    output_dir: Path
    history_dir: Path
    model_dir: Path
    cache_dir: Path
    log_dir: Path
    backup_dir: Path
    temp_dir: Path
    user_workflow_dir: Path

    def writable_paths(self) -> tuple[Path, ...]:
        return tuple(
            value for name, value in vars(self).items()
            if name not in {"program_root", "edition", "static_dir", "builtin_workflow_dir", "api_defaults_dir"}
            and isinstance(value, Path)
        )
```

`default_data_root()` must use an injected drive predicate for tests, `Path("E:/Hstar缓存")` when E exists, and the injected Documents directory otherwise.

- [ ] **Step 4: Run the focused tests**

Run: `python\python.exe -m unittest tests.test_runtime_paths -v`
Expected: all three tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add hstar_runtime/__init__.py hstar_runtime/paths.py tests/test_runtime_paths.py
git commit -m "feat: define Hstar runtime data paths"
```

## Task 2: Add Atomic Bootstrap Configuration

**Files:**
- Create: `hstar_runtime/atomic.py`
- Create: `hstar_runtime/bootstrap.py`
- Test: `tests/test_runtime_bootstrap.py`

- [ ] **Step 1: Write failing bootstrap tests**

Cover a missing bootstrap, an edition mismatch, an invalid program-relative data root, atomic save/reload, and a truncated JSON file. Use a temporary AppData root and a frozen UTC clock; assert corrupt files are renamed with `.corrupt-20260726-163000` before returning an unconfigured state.

```python
config = BootstrapConfig(schema_version=1, edition="windows11", data_root=str(data_root))
store.save(config)
self.assertEqual(store.load().data_root, str(data_root.resolve()))
```

- [ ] **Step 2: Run the tests and confirm failure**

Run: `python\python.exe -m unittest tests.test_runtime_bootstrap -v`
Expected: FAIL because `hstar_runtime.bootstrap` does not exist.

- [ ] **Step 3: Implement schema and atomic storage**

Put the shared write primitive in `hstar_runtime/atomic.py` so bootstrap, credentials, migration state, and API configuration use one implementation:

```python
def atomic_write_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{uuid4().hex}.tmp")
    try:
        with temporary.open("wb") as stream:
            stream.write(payload)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def atomic_write_json(path: Path, document: Mapping[str, object]) -> None:
    payload = (json.dumps(document, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
    atomic_write_bytes(path, payload)
```

```python
@dataclass(frozen=True)
class BootstrapConfig:
    schema_version: int
    edition: str
    data_root: str
    last_started_version: str = ""
    migration_id: str = ""
    migration_status: str = ""
    previous_data_root: str = ""

    def resolved_data_root(self) -> Path:
        return Path(self.data_root).expanduser().resolve()


class BootstrapStore:
    def __init__(self, appdata_root: Path, edition: str, program_root: Path):
        self.path = appdata_root / "Hstar" / edition / "bootstrap.json"
        self.edition = edition
        self.program_root = program_root.resolve()

    def save(self, config: BootstrapConfig) -> None:
        target = config.resolved_data_root()
        if target == self.program_root or self.program_root in target.parents:
            raise ValueError("数据目录不能位于 Hstar 程序目录内")
        document = {
            "schemaVersion": config.schema_version,
            "edition": config.edition,
            "dataRoot": str(target),
            "lastStartedVersion": config.last_started_version,
            "migration": {
                "id": config.migration_id,
                "status": config.migration_status,
                "previousDataRoot": config.previous_data_root,
            },
        }
        atomic_write_json(self.path, document)
```

`load() -> BootstrapConfig | None` must map the camel-case JSON fields above back to the snake-case dataclass fields, validate `schemaVersion == 1`, the exact edition, an absolute data root, and containment rules. It must return the three migration fields from the nested `migration` object and never use the program root as fallback. `require() -> BootstrapConfig` returns the validated object or raises `RuntimeError("尚未配置 Hstar 数据目录")`. The C# shell in Task 10 must read and write this exact JSON schema.

- [ ] **Step 4: Run focused tests**

Run: `python\python.exe -m unittest tests.test_runtime_bootstrap -v`
Expected: all bootstrap tests PASS.

- [ ] **Step 5: Commit**

```powershell
git add hstar_runtime/atomic.py hstar_runtime/bootstrap.py tests/test_runtime_bootstrap.py
git commit -m "feat: persist Hstar data bootstrap atomically"
```

## Task 3: Wire Runtime Paths into the Backend

**Files:**
- Modify: `main.py:308-394`
- Modify: `main.py:620-648`
- Modify: `main.py:1451-1615`
- Modify: `run.bat`
- Modify: `tools/tests/software-settings-integration.test.mjs`
- Test: `tests/test_runtime_paths.py`

- [ ] **Step 1: Extend source-contract tests**

Replace the old regex that accepts `resolve_runtime_paths(BASE_DIR, ...)` with assertions that `main.py` imports `build_runtime_paths` and reads `HSTAR_PROGRAM_DIR`, `HSTAR_DATA_DIR`, and `HSTAR_EDITION`. Permit the legacy `PROGRAM_ROOT / "API" / ".env"` path only as a read-only source passed to the one-time credential importer from Task 7; reject writable `API_ENV_FILE` paths in packaged mode. Assert `run.bat` sets `HSTAR_DATA_DIR=%~dp0` for engineering use.

- [ ] **Step 2: Run the contract test and confirm failure**

Run: `node --test tools/tests/software-settings-integration.test.mjs`
Expected: FAIL on the new runtime-path import and development environment assertions.

- [ ] **Step 3: Replace the global path block**

Use this initialization contract:

```python
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
PROGRAM_ROOT = Path(os.environ.get("HSTAR_PROGRAM_DIR") or BASE_DIR).resolve()
EDITION = os.environ.get("HSTAR_EDITION", "development").strip().lower()
APPDATA_ROOT = Path(os.environ.get("APPDATA") or Path.home() / "AppData" / "Roaming")
BOOTSTRAP = BootstrapStore(APPDATA_ROOT, EDITION, PROGRAM_ROOT)
EXPLICIT_DATA_ROOT = os.environ.get("HSTAR_DATA_DIR", "").strip()
DATA_ROOT = Path(EXPLICIT_DATA_ROOT).resolve() if EXPLICIT_DATA_ROOT else BOOTSTRAP.require().resolved_data_root()
RUNTIME_PATHS = build_runtime_paths(PROGRAM_ROOT, DATA_ROOT, EDITION)
```

Map existing constants to the new object. Move `software_settings.json` to `config/`, canvases/OpenShop/director to `projects/`, API user config to `config/`, credentials to `secrets/`, and caches/logs/temp to their named roots. Keep static assets and built-in workflow defaults in the program root.

- [ ] **Step 4: Split built-in and user workflow resolution**

`list_workflows()` must merge the read-only built-in directory and writable user directory. Saves and deletes must target only `user_workflow_dir`; a built-in workflow can be shadowed by a user copy but never overwritten or deleted from the program tree.

- [ ] **Step 5: Make engineering startup explicit**

Add to `run.bat` before launching Python:

```bat
set "HSTAR_EDITION=development"
set "HSTAR_DATA_DIR=%~dp0"
set "HSTAR_PROGRAM_DIR=%~dp0"
set "HSTAR_PORT=3000"
```

Do not add port 5000 to the engineering launcher.

- [ ] **Step 6: Run focused and existing storage tests**

Run:

```powershell
python\python.exe -m unittest tests.test_runtime_paths tests.test_voice_settings -v
node --test tools/tests/software-settings-integration.test.mjs tools/tests/openshop-project-storage.test.mjs tools/tests/director-node-scene-storage-cleanup.test.mjs tools/tests/server-port-env.test.mjs
```

Expected: all tests PASS and no test writes outside its temporary root.

- [ ] **Step 7: Commit**

```powershell
git add main.py run.bat tools/tests/software-settings-integration.test.mjs tests/test_runtime_paths.py
git commit -m "refactor: route Hstar writes through user data root"
```

## Task 4: Build the Transactional Migration Engine

**Files:**
- Create: `hstar_runtime/migration.py`
- Test: `tests/test_runtime_migration.py`

- [ ] **Step 1: Write failing transaction tests**

Test preflight overlap rejection, insufficient space, resumable copy, source preservation, SHA-256 verification, cancellation, corrupt destination rollback, and atomic bootstrap switch. Freeze timestamps and inject disk-space/hash functions so tests are deterministic.

```python
task = manager.start(source, target)
state = manager.wait(task.id, timeout=5)
self.assertEqual(state.status, "completed")
self.assertTrue((source / "projects" / "canvas.json").exists())
self.assertEqual(bootstrap.load().data_root, str(target.resolve()))
```

- [ ] **Step 2: Run and confirm failure**

Run: `python\python.exe -m unittest tests.test_runtime_migration -v`
Expected: FAIL because the migration manager is missing.

- [ ] **Step 3: Implement migration state and manifest**

Define `MigrationState` with `id`, `status`, `source`, `target`, `total_bytes`, `copied_bytes`, `current_path`, `error`, `started_at`, and `completed_at`. Allowed status values are `preflight`, `copying`, `verifying`, `switching`, `completed`, `cancelled`, and `failed`. `MigrationManager.start(source, target) -> MigrationState` creates the background task; `status(task_id)`, `wait(task_id, timeout)`, `cancel(task_id)`, and `resume(task_id)` each return the latest `MigrationState`. Persist task `task_id` under `source / "backups" / "migrations" / f"{task_id}.json"`. Copy into `target / f".hstar-migration-{task_id}"`, verify relative path/size/hash entries, then move verified children into the final target and update bootstrap last.

- [ ] **Step 4: Implement cancellation and recovery**

Cancellation must leave source untouched and preserve the transaction directory for resume. `resume(task_id)` must skip files whose recorded size and SHA-256 still match. A failed validation must restore the previous bootstrap file and never remove the old root.

- [ ] **Step 5: Run migration tests**

Run: `python\python.exe -m unittest tests.test_runtime_migration -v`
Expected: all migration tests PASS.

- [ ] **Step 6: Commit**

```powershell
git add hstar_runtime/migration.py tests/test_runtime_migration.py
git commit -m "feat: add resumable Hstar data migration"
```

## Task 5: Expose Non-Blocking Storage Migration APIs

**Files:**
- Modify: `main.py:2939-2975`
- Modify: `main.py:12520-12620`
- Modify: `main.py:12977-12990`
- Create: `tests/test_storage_migration_api.py`

- [ ] **Step 1: Write failing API tests**

Create the app with temporary `HSTAR_PROGRAM_DIR`, `HSTAR_DATA_DIR`, `APPDATA`, and edition. Assert:

- `POST /api/storage-migrations` returns `202` and a task ID;
- `GET /api/storage-migrations/{id}` exposes byte progress;
- overlapping paths return localized `400`;
- cancellation is idempotent;
- successful completion reports `restart_required: true`;
- the old `/api/software-settings/storage` route returns `410` with the new endpoint path instead of performing a blocking copy.

- [ ] **Step 2: Run and confirm failure**

Run: `python\python.exe -m unittest tests.test_storage_migration_api -v`
Expected: FAIL because the new routes do not exist.

- [ ] **Step 3: Add request models and routes**

```python
class StorageMigrationRequest(BaseModel):
    storage_root: str = Field(min_length=1, max_length=1024)


@app.post("/api/storage-migrations", status_code=202)
def start_storage_migration(payload: StorageMigrationRequest):
    target = normalize_storage_root(payload.storage_root)
    task = STORAGE_MIGRATIONS.start(Path(STORAGE_ROOT), Path(target))
    return {"ok": True, "task": task.as_dict()}


@app.get("/api/storage-migrations/{task_id}")
def storage_migration_status(task_id: str):
    return {"ok": True, "task": STORAGE_MIGRATIONS.status(task_id).as_dict()}
```

Add a cancel route and localized mapping for unknown task, invalid path, low disk, verification failure, and cancellation. Do not expose absolute source paths to non-loopback collaboration clients.

- [ ] **Step 4: Run API and migration tests**

Run: `python\python.exe -m unittest tests.test_storage_migration_api tests.test_runtime_migration -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add main.py tests/test_storage_migration_api.py
git commit -m "feat: expose asynchronous storage migration"
```

## Task 6: Upgrade the Software Settings Storage UI

**Files:**
- Create: `static/js/storage-settings-panel.js`
- Modify: `static/software-settings.html`
- Create: `tools/tests/storage-settings-panel.test.mjs`
- Modify: `tools/tests/software-settings-integration.test.mjs`

- [ ] **Step 1: Write failing UI contract tests**

Assert that the page loads a versioned `storage-settings-panel.js`, displays determinate/indeterminate progress, offers cancellation, posts to `/api/storage-migrations`, polls the task endpoint, and sends this shell message after completion:

```javascript
window.chrome?.webview?.postMessage({
  type: 'hstar-restart-with-data-root',
  dataRoot: task.target,
});
```

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tools/tests/storage-settings-panel.test.mjs tools/tests/software-settings-integration.test.mjs`
Expected: FAIL because the controller and progress UI are absent.

- [ ] **Step 3: Extract the controller and add progress UI**

The controller must disable browse/save while active, poll every 500 ms, use actual `copied_bytes / total_bytes`, keep unknown totals indeterminate, show the current relative file without exposing the old absolute root, and leave the UI recoverable after failure or cancellation.

- [ ] **Step 4: Handle browser-only engineering mode**

When WebView messaging is unavailable, show `迁移完成，请重新启动 Hstar 以使用新位置。` Do not reload into a backend that still owns the old global paths.

- [ ] **Step 5: Run UI tests and encoding audit**

Run:

```powershell
node --test tools/tests/storage-settings-panel.test.mjs tools/tests/software-settings-integration.test.mjs
node tools/audit-text-encoding.mjs
```

Expected: tests PASS and encoding audit exits 0.

- [ ] **Step 6: Commit**

```powershell
git add static/software-settings.html static/js/storage-settings-panel.js tools/tests/storage-settings-panel.test.mjs tools/tests/software-settings-integration.test.mjs
git commit -m "feat: show storage migration progress"
```

## Task 7: Move API Secrets into a DPAPI Credential Store

**Files:**
- Create: `hstar_runtime/credentials.py`
- Modify: `main.py:620-648`
- Modify: `main.py:763-850`
- Modify: `main.py:1570-1600`
- Test: `tests/test_runtime_credentials.py`

- [ ] **Step 1: Write failing credential tests**

Inject a reversible fake protector and assert secrets are never present in the stored binary, updates preserve unrelated keys, legacy `.env` imports only when the store is empty, backups land under `backups/api/`, and a failed write leaves the original `.env` untouched.

- [ ] **Step 2: Run and confirm failure**

Run: `python\python.exe -m unittest tests.test_runtime_credentials -v`
Expected: FAIL because `CredentialStore` is missing.

- [ ] **Step 3: Implement the store**

Use Windows `CryptProtectData` and `CryptUnprotectData` through `ctypes`. Keep the crypto backend injectable so tests do not depend on the machine account.

```python
class SecretProtector(Protocol):
    def protect(self, payload: bytes) -> bytes: ...
    def unprotect(self, payload: bytes) -> bytes: ...


class CredentialStore:
    def __init__(self, path: Path, protector: SecretProtector):
        self.path = path
        self.protector = protector

    def save(self, values: Mapping[str, str]) -> None:
        payload = json.dumps(dict(values), ensure_ascii=False, sort_keys=True).encode("utf-8")
        encrypted = self.protector.protect(payload)
        atomic_write_bytes(self.path, encrypted)

    def load(self) -> dict[str, str]:
        if not self.path.exists():
            return {}
        return json.loads(self.protector.unprotect(self.path.read_bytes()).decode("utf-8"))
```

Import `atomic_write_bytes` from `hstar_runtime.atomic`. Use DPAPI optional entropy `b"Hstar.credentials.v1"` and the current-user scope. On non-Windows engineering hosts, retain the existing `.env` behavior behind an explicit backend adapter; never call it in Windows installer mode.

- [ ] **Step 4: Replace direct `.env` writes**

`provider_env_key_value()` and `update_env_values()` must read/write the credential store, then update process environment values for backward-compatible provider code. Legacy import must back up the old file, verify the encrypted store can be reopened, then remove the install-root `.env`.

- [ ] **Step 5: Run API and credential tests**

Run:

```powershell
python\python.exe -m unittest tests.test_runtime_credentials -v
node --test tools/tests/api-settings-provider-fusion.test.mjs tools/tests/api-settings-protocol-override.test.mjs
```

Expected: PASS and no plaintext test key appears under the program-root fixture.

- [ ] **Step 6: Commit**

```powershell
git add hstar_runtime/credentials.py main.py tests/test_runtime_credentials.py
git commit -m "feat: protect API credentials with DPAPI"
```

## Task 8: Implement Safe API Default Updates and Maintenance Mode

**Files:**
- Create: `hstar_runtime/api_merge.py`
- Create: `hstar_runtime/maintenance.py`
- Test: `tests/test_api_config_merge.py`
- Modify: `main.py`

- [ ] **Step 1: Write failing merge tests**

Use built-in provider `volcengine`, a user-modified official provider, and custom provider `my-lab`. Assert official protocol/model/icon fields update, enabled/primary user choices remain, custom providers remain byte-equivalent after normalization, and credentials are not part of provider JSON.

- [ ] **Step 2: Run and confirm failure**

Run: `python\python.exe -m unittest tests.test_api_config_merge -v`
Expected: FAIL because `merge_api_defaults()` does not exist.

- [ ] **Step 3: Implement deterministic merge and backup**

```python
def merge_api_defaults(current: list[dict], defaults: list[dict]) -> list[dict]:
    current_by_id = {str(item.get("id")): deepcopy(item) for item in current}
    result = []
    for default in defaults:
        existing = current_by_id.pop(default["id"], {})
        merged = {**existing, **default}
        for key in ("enabled", "primary", "use_system_proxy"):
            if key in existing:
                merged[key] = existing[key]
        result.append(merged)
    result.extend(current_by_id.values())
    return result
```

Before writing, calculate `timestamp = now.astimezone(timezone.utc).strftime("%Y%m%d-%H%M%S")` from an injected clock and create `backup_dir / "api" / f"api-providers-{timestamp}.json"`; write the merged result atomically and validate it can be loaded.

- [ ] **Step 4: Add hidden maintenance command**

`python -m hstar_runtime.maintenance update-api-config --program-root ... --data-root ... --edition windows11` must return exit code 0 on success, 2 on invalid arguments, and 3 on merge failure. It must print only a localized summary and never print credentials.

- [ ] **Step 5: Run tests**

Run: `python\python.exe -m unittest tests.test_api_config_merge -v`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add hstar_runtime/api_merge.py hstar_runtime/maintenance.py tests/test_api_config_merge.py main.py
git commit -m "feat: safely update packaged API defaults"
```

## Task 9: Add the Program-Directory Write Audit

**Files:**
- Create: `tools/tests/runtime-data-ownership.test.mjs`
- Modify: `tools/tests/text-encoding-health.test.mjs` only if the new Python package is outside its audit scope
- Fix: user-facing mojibake found by `node tools/audit-text-encoding.mjs`

- [ ] **Step 1: Write the failing ownership test**

Parse `main.py` and `hstar_runtime/**/*.py`; reject direct writable constructions rooted at `BASE_DIR`, `PROGRAM_ROOT`, `STATIC_DIR`, or built-in workflows. Allow only reads from those roots and the legacy credential importer. Also create a temporary read-only program tree, initialize the backend with a separate data root, and assert created files all remain beneath data root.

- [ ] **Step 2: Run and confirm any remaining violations**

Run: `node --test tools/tests/runtime-data-ownership.test.mjs`
Expected: FAIL with a list of remaining program-root writes until all are routed through `RuntimePaths`.

- [ ] **Step 3: Remove every reported write**

Do not silence the test with broad regex exclusions. Convert each write site to a named runtime path. Preserve read-only bundled assets, API defaults, and workflows.

- [ ] **Step 4: Run ownership and encoding checks**

Run:

```powershell
node --test tools/tests/runtime-data-ownership.test.mjs
node tools/audit-text-encoding.mjs
node --test tools/tests/text-encoding-health.test.mjs
```

Expected: all commands exit 0; no user-facing mojibake remains.

- [ ] **Step 5: Commit**

```powershell
git add tools/tests/runtime-data-ownership.test.mjs tools/tests/text-encoding-health.test.mjs main.py hstar_runtime static
git commit -m "test: enforce Hstar data ownership boundaries"
```

## Checkpoint A: Data Foundation

Run the full Python and root Node suites before starting desktop work:

```powershell
python\python.exe -m unittest discover -s tests -v
$tests = Get-ChildItem -LiteralPath 'tools/tests' -Filter '*.test.mjs' | Sort-Object Name
foreach($test in $tests){ node --test $test.FullName; if($LASTEXITCODE){ exit $LASTEXITCODE } }
```

Expected: all suites PASS. Record the port-5000 listener before and after without stopping it. The current port-3000 service may be restarted only from the active worktree and must use its existing engineering data root.

## Task 10: Create the Source-Controlled Windows 11 Desktop Shell

**Files:**
- Create: `desktop/Hstar.Desktop/Hstar.Desktop.csproj`
- Create: `desktop/Hstar.Desktop/App.xaml`
- Create: `desktop/Hstar.Desktop/App.xaml.cs`
- Create: `desktop/Hstar.Desktop/MainWindow.xaml`
- Create: `desktop/Hstar.Desktop/MainWindow.xaml.cs`
- Create: `desktop/Hstar.Desktop/Runtime/AppPaths.cs`
- Create: `desktop/Hstar.Desktop/Runtime/SingleInstance.cs`
- Create: `desktop/Hstar.Desktop/Views/StorageSetupWindow.xaml`
- Create: `desktop/Hstar.Desktop/Views/StorageSetupWindow.xaml.cs`
- Create: `desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj`
- Create: `desktop/Hstar.Desktop.Tests/AppPathsTests.cs`

- [ ] **Step 1: Create the solution and failing AppPaths tests**

Target `net8.0-windows`, `win-x64`, WPF, and `OutputType=WinExe`. Reference `Microsoft.Web.WebView2` version `1.0.4078.44`. Test E-drive preference, Documents fallback, bootstrap edition isolation, program-root rejection, and Unicode paths.

- [ ] **Step 2: Run and confirm failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release`
Expected: FAIL because `AppPaths` and bootstrap persistence are not implemented.

- [ ] **Step 3: Implement AppPaths and single-instance ownership**

Use mutex name `Local\Hstar.Windows11`. `AppPaths` must resolve program root from `AppContext.BaseDirectory`, bootstrap from `Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "Hstar", "windows11", "bootstrap.json")`, and WebView cache from `Path.Combine(DataRoot, "cache", "webview2")`. It must use the exact bootstrap JSON field names defined in Task 2.

- [ ] **Step 4: Implement the first-run storage window**

The WPF window must preselect `E:\Hstar缓存` when E exists, otherwise `%USERPROFILE%\Documents\Hstar缓存`; show available space and the directory's purpose; offer a standard folder picker; validate free space and containment; create the directory; write bootstrap atomically; and only then open `MainWindow`. If the user-selected directory already contains `data-manifest.json`, offer “继续使用此位置” or “复制到新位置” and invoke the Task 4 migration contract. Candidate discovery is limited to the current edition bootstrap and folders explicitly selected by the user; it must not scan, open, or hash the installed stable port-5000 application's data directories.

- [ ] **Step 5: Run shell tests**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release`
Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add desktop
git commit -m "feat: add maintainable Windows 11 shell"
```

## Task 11: Start the Backend Invisibly and Securely

**Files:**
- Create: `desktop/Hstar.Desktop/Runtime/PortAllocator.cs`
- Create: `desktop/Hstar.Desktop/Runtime/BackendProcess.cs`
- Create: `desktop/Hstar.Desktop/Runtime/StartupCoordinator.cs`
- Create: `desktop/Hstar.Desktop.Tests/BackendProcessTests.cs`
- Modify: `main.py:21931-21950`

- [ ] **Step 1: Write failing process-contract tests**

Assert `ProcessStartInfo.UseShellExecute == false`, `CreateNoWindow == true`, stdout/stderr redirection, working directory equals program root, and environment contains:

```text
HSTAR_PROGRAM_DIR={paths.ProgramRoot}
HSTAR_DATA_DIR={paths.DataRoot}
HSTAR_EDITION=windows11
HSTAR_HOST=127.0.0.1
HSTAR_PORT={portAllocator.SelectedPort}
HSTAR_SHELL_TOKEN={Convert.ToHexString(RandomNumberGenerator.GetBytes(32))}
PYTHONUTF8=1
PYTHONIOENCODING=utf-8
```

- [ ] **Step 2: Run and confirm failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter BackendProcessTests`
Expected: FAIL because backend process construction is missing.

- [ ] **Step 3: Implement port and process lifecycle**

Prefer port 5000, then scan 5001-5099 on loopback only. Start `runtime/python/pythonw.exe` with `app/main.py`; rotate `logs/backend.log` and `logs/backend-error.log`; poll `/api/health` with the shell token; terminate the child on shell exit after a five-second graceful shutdown window.

- [ ] **Step 4: Restrict packaged binding and local session access**

Change `main.py` to resolve `HSTAR_HOST`, defaulting to `0.0.0.0` only in development and `127.0.0.1` for packaged editions. Add middleware that accepts the shell token through an HttpOnly loopback cookie established by a one-time query value; do not require it for static assets before the initial navigation, health checks carrying the header, or authorized collaboration sessions.

- [ ] **Step 5: Run process and server-port tests**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release
node --test tools/tests/server-port-env.test.mjs
```

Expected: PASS; tests do not open a visible console.

- [ ] **Step 6: Commit**

```powershell
git add desktop main.py tools/tests/server-port-env.test.mjs
git commit -m "feat: launch packaged backend without console"
```

## Task 12: Integrate the Fixed WebView2 Runtime

**Files:**
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml`
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`
- Create: `desktop/Hstar.Desktop.Tests/WebViewConfigurationTests.cs`

- [ ] **Step 1: Write failing WebView configuration tests**

Assert the browser executable folder resolves to `Path.Combine(paths.ProgramRoot, "runtime", "browser", "WebView2")`, user data resolves to `Path.Combine(paths.DataRoot, "cache", "webview2")`, navigation is loopback-only, popup navigation is denied unless routed through Hstar's external-browser policy, and `hstar-restart-with-data-root` triggers a controlled backend restart.

- [ ] **Step 2: Run and confirm failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter WebViewConfigurationTests`
Expected: FAIL until the WebView environment factory is implemented.

- [ ] **Step 3: Initialize the fixed runtime**

Use:

```csharp
var environment = await CoreWebView2Environment.CreateAsync(
    browserExecutableFolder: paths.FixedWebViewRuntime,
    userDataFolder: paths.WebViewUserData);
await Browser.EnsureCoreWebView2Async(environment);
```

Display a restrained startup state while the backend becomes healthy. Navigate only after health succeeds. Preserve normal clipboard, file upload, microphone permission, downloads, and theme behavior.

- [ ] **Step 4: Handle storage restart and shutdown**

Validate the message origin and `dataRoot`, close active WebSocket/voice sessions, stop backend, reload bootstrap, start backend with the new root, and navigate only after the new health check succeeds.

- [ ] **Step 5: Run tests and publish the shell locally**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release
dotnet publish desktop/Hstar.Desktop/Hstar.Desktop.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=false
```

Expected: tests PASS and publish output contains `Hstar.exe`, .NET runtime files, WebView2 managed assemblies, and no console host executable.

- [ ] **Step 6: Commit**

```powershell
git add desktop
git commit -m "feat: host Hstar in fixed WebView2 runtime"
```

## Task 13: Lock Windows 11 Runtime Inputs

**Files:**
- Create: `build/runtime-locks/windows11-requirements.txt`
- Create: `build/scripts/Lock-HstarRuntime.ps1`
- Generate: `build/runtime-locks/windows11-runtime.json`
- Create: `tools/tests/windows11-runtime-lock.test.mjs`
- Modify: `voice_assistant/runtime_manifest.json`

- [ ] **Step 1: Write the failing lock contract**

Require exact versions, HTTPS URLs, lowercase 64-character SHA-256 values, x64 architecture, Python ABI `cp311`, WebView2 fixed runtime, and a complete wheel list. Reject `latest`, version ranges, unhashed files, model weights, voice runtime site-packages, and external image URLs.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tools/tests/windows11-runtime-lock.test.mjs`
Expected: FAIL because the Windows 11 lock file is absent.

- [ ] **Step 3: Add exact direct dependencies**

Create `windows11-requirements.txt` with these direct pins:

```text
fastapi==0.139.2
uvicorn==0.51.0
requests==2.34.2
pydantic==2.13.4
python-multipart==0.0.32
httpx==0.28.1
pillow==12.3.0
websockets==16.1.1
fonttools==4.63.0
```

- [ ] **Step 4: Implement the runtime locker**

The script must download Python 3.11.9 x64 embedded from `https://www.python.org/ftp/python/3.11.9/python-3.11.9-embed-amd64.zip`, the official WebView2 Fixed Version 150.0.4078.99 x64 CAB from `https://msedge.sf.dl.delivery.mp.microsoft.com/filestreamingservice/files/1c394b0d-2689-4d8b-af57-2f2018abccf6/Microsoft.WebView2.FixedVersionRuntime.150.0.4078.99.x64.cab`, and cp311/win_amd64 wheels for all pinned/transitive packages. It computes SHA-256 after download and writes the exact resolved filenames and hashes to `windows11-runtime.json`.

The script must refuse to overwrite an existing lock unless `-Refresh` is supplied and must never execute downloaded code while locking.

- [ ] **Step 5: Generate and validate the lock**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build/scripts/Lock-HstarRuntime.ps1 -Edition windows11 -Refresh
node --test tools/tests/windows11-runtime-lock.test.mjs
```

Expected: the lock test PASSes and every artifact has a recorded SHA-256. Record total download size in the lock.

- [ ] **Step 6: Qualify voice runtime under Python 3.11**

Update `voice_assistant/runtime_manifest.json` from Python 3.10 to 3.11 only after unit tests and the authorized real Fun-ASR smoke test pass with the new packaged interpreter. Keep model weights excluded.

- [ ] **Step 7: Commit**

```powershell
git add build/runtime-locks build/scripts/Lock-HstarRuntime.ps1 tools/tests/windows11-runtime-lock.test.mjs voice_assistant/runtime_manifest.json
git commit -m "build: lock Windows 11 runtime inputs"
```

## Task 14: Build a Clean Windows 11 Stage

**Files:**
- Create: `build/scripts/New-HstarWindows11Stage.ps1`
- Create: `build/scripts/Test-HstarSource.ps1`
- Create: `build/scripts/Test-HstarWindows11Stage.ps1`
- Create: `tools/tests/windows11-stage-contract.test.mjs`
- Modify: `tools/tests/director-installer-payload.test.mjs`
- Modify: `tools/tests/voice-assistant-installer-exclusion.test.mjs`

- [ ] **Step 1: Write failing stage contract tests**

Require Hstar shell, fixed browser runtime, embedded Python, app source/runtime files, static OpenShop, static 3D Director, defaults, workflows, version, licenses, dependency lock, and file hashes. Reject `.git`, `node_modules`, source tests, logs, caches, output, assets library/user uploads, API `.env`, user provider config, user projects, model weights, recordings, and prior stage residue.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tools/tests/windows11-stage-contract.test.mjs`
Expected: FAIL because no deterministic Windows 11 stage builder exists.

- [ ] **Step 3: Implement clean stage assembly**

The script must:

1. require a clean Git worktree unless `-AllowDirtyForTest` is explicitly passed;
2. run `build/scripts/Test-HstarSource.ps1`, which executes the encoding audit, Python suite, every root Node test, OpenShop tests/build, 3D Director tests/build, desktop tests, and the existing Playwright canvas smoke suite; the official stage command has no skip switch;
3. remove and recreate only the resolved `build/installer/stage/windows11` path;
4. copy the already verified OpenShop and 3D Director production outputs;
5. publish the WPF shell self-contained;
6. verify and expand locked Python and WebView2 artifacts;
7. install wheels with `--no-index --find-links` into embedded Python;
8. copy program files from an explicit whitelist;
9. create empty default directory markers without user content;
10. generate `manifests/files.sha256`, release metadata, licenses, and `manifests/sbom.spdx.json` from the runtime lock and packaged file inventory.

The SPDX JSON must identify Hstar, the desktop runtime, embedded Python, fixed WebView2, every Python package, and bundled native component with exact version, license expression or `NOASSERTION`, download location, and SHA-256. The stage contract rejects a missing component, missing checksum, or model-weight entry.

- [ ] **Step 4: Make embedded Python deterministic**

Enable `import site` in `python311._pth`, place packages under `runtime/python/Lib/site-packages`, and run this stage-local check:

```powershell
build\installer\stage\windows11\runtime\python\python.exe -I -c "import fastapi,uvicorn,PIL,httpx,websockets,fontTools; print('runtime-ok')"
```

Expected: `runtime-ok`.

- [ ] **Step 5: Build and validate the stage**

Run:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File build/scripts/New-HstarWindows11Stage.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File build/scripts/Test-HstarWindows11Stage.ps1
node --test tools/tests/windows11-stage-contract.test.mjs tools/tests/director-installer-payload.test.mjs tools/tests/voice-assistant-installer-exclusion.test.mjs
```

Expected: all source and stage checks PASS; `manifests/sbom.spdx.json` validates; stage remains ignored by Git.

- [ ] **Step 6: Commit**

```powershell
git add build/scripts tools/tests/windows11-stage-contract.test.mjs tools/tests/director-installer-payload.test.mjs tools/tests/voice-assistant-installer-exclusion.test.mjs
git commit -m "build: assemble clean Windows 11 stage"
```

## Task 15: Create the Independent Windows 11 Inno Installer

**Files:**
- Create: `build/installer/Hstar.Windows11.iss`
- Retire or convert: `build/installer/Hstar.iss`
- Create: `tools/tests/windows11-installer-contract.test.mjs`
- Modify: installer tests that currently read `build/installer/Hstar.iss`

- [ ] **Step 1: Write the failing installer contract**

Assert a Windows 11-only AppId, `MinVersion=10.0.22000`, x64-only architecture, per-user default directory `%LOCALAPPDATA%\Programs\Hstar`, Windows 11 stage source, independent output name, API update task, hidden maintenance execution, no user data deletion, no model inclusion, and no `run.bat` shortcut.

- [ ] **Step 2: Run and confirm failure**

Run: `node --test tools/tests/windows11-installer-contract.test.mjs`
Expected: FAIL because the edition-specific installer is missing.

- [ ] **Step 3: Implement the installer contract**

Use this core configuration:

```ini
#define MyAppName "Hstar"
#define MyEdition "Windows11"
#define MyAppExeName "Hstar.exe"
#define SourceRoot "stage\windows11"
#ifndef MyAppVersion
  #error MyAppVersion must be passed by the build command from the repository VERSION file
#endif

[Setup]
AppId={{7D2E8423-5B6B-48EC-A986-5E8B57EE3A11}
DefaultDirName={localappdata}\Programs\Hstar
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.22000
OutputDir=..\release\windows11
OutputBaseFilename=Hstar_Windows11_Setup_{#MyAppVersion}
Compression=lzma2/ultra64
SolidCompression=yes

[Tasks]
Name: "desktopicon"; Description: "创建桌面快捷方式"; Flags: checkedonce
Name: "updateapiconfig"; Description: "更新 API 配置（保留已有密钥和自定义服务商）"; Flags: unchecked
```

`[Files]` must copy only the validated stage. `[Run]` must launch the GUI executable without shell commands. When `updateapiconfig` is selected, run `Hstar.exe --maintenance=update-api-config` hidden and wait for completion before optional post-install launch.

- [ ] **Step 4: Preserve data on upgrade and uninstall**

Do not add `[InstallDelete]` entries beneath AppData or the selected data root. Stop only the Windows 11 edition process through its mutex/maintenance shutdown contract. Recreate desktop and Start Menu shortcuts on every upgrade.

- [ ] **Step 5: Install Inno Setup compiler if absent and compile**

Current machine check shows `ISCC.exe` is absent. Install Inno Setup 6 from its official distribution, then run:

```powershell
winget install --id JRSoftware.InnoSetup -e --source winget --accept-package-agreements --accept-source-agreements
$isccCandidates = @(
    'C:\Program Files (x86)\Inno Setup 6\ISCC.exe',
    'C:\Program Files\Inno Setup 6\ISCC.exe'
)
$iscc = $isccCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $iscc) { throw '未找到 Inno Setup 6 编译器 ISCC.exe' }
$version = (Get-Content -Raw -Encoding UTF8 'VERSION').Trim()
& $iscc "/DMyAppVersion=$version" 'build\installer\Hstar.Windows11.iss'
if ($LASTEXITCODE) { exit $LASTEXITCODE }
$installer = Join-Path (Resolve-Path 'build\release\windows11') "Hstar_Windows11_Setup_$version.exe"
if (-not (Test-Path -LiteralPath $installer)) { throw "安装包未生成：$installer" }
```

Expected: `build\release\windows11\Hstar_Windows11_Setup_$version.exe` exists. Record the resolved Inno version and installer SHA-256 in the release manifest; code signing remains optional.

- [ ] **Step 6: Run installer contracts**

Run:

```powershell
node --test tools/tests/windows11-installer-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/voice-assistant-installer-exclusion.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add build/installer tools/tests/windows11-installer-contract.test.mjs tools/tests/voice-assistant-installer-exclusion.test.mjs
git commit -m "build: add independent Windows 11 installer"
```

## Task 16: Perform Isolated Installer and Performance Validation

**Files:**
- Create: `tools/measure-windows11-startup.ps1`
- Create: the dated validation report path generated by `Join-Path 'docs/validation' "$(Get-Date -Format yyyy-MM-dd)-hstar-windows11-installer-validation.md"`

- [ ] **Step 1: Record protected runtime state**

Record the owner/PID of ports 3000 and 5000 and hashes of protected engineering data manifests. Do not stop or query stable user-data endpoints.

- [ ] **Step 2: Install into an isolated program directory**

Use an isolated install directory and data root, with a non-5000 test port supplied through the shell smoke-test option. Do not install over the current stable application.

```powershell
$version = (Get-Content -Raw -Encoding UTF8 'VERSION').Trim()
$installer = (Resolve-Path "build\release\windows11\Hstar_Windows11_Setup_$version.exe").Path
$testInstallRoot = 'E:\Claude专业组\tmp\hstar-win11-install-test'
& $installer /VERYSILENT /SUPPRESSMSGBOXES /NORESTART "/DIR=$testInstallRoot"
if ($LASTEXITCODE) { exit $LASTEXITCODE }
```

Record `$installer`, `$testInstallRoot`, the exact `VERSION` value, and the install process exit code in the dated validation report.

- [ ] **Step 3: Validate first-run storage behavior**

With E available, confirm the wizard proposes `E:\Hstar缓存` without touching an existing real directory by overriding the smoke-test candidate root. Repeat with a simulated missing E drive and confirm Documents fallback. Exercise Unicode and space-containing paths.

- [ ] **Step 4: Validate no-console and process cleanup**

Use `Get-Process`, main-window handles, and shell logs to confirm no visible `cmd.exe`, `powershell.exe`, `python.exe`, or console host window appears during startup, storage selection, API maintenance, file selection, and shutdown. `pythonw.exe` may run only as the shell-owned backend and must exit after Hstar closes.

- [ ] **Step 5: Measure startup and lazy loading**

`measure-windows11-startup.ps1` must run five cold and five warm starts against the isolated data root, record time to shell window, backend health, and interactive main page, and confirm voice/OpenShop/3D processes or heavyweight assets do not block main-page readiness. The acceptance gate on the current computer is median warm main-page readiness at or below 3 seconds and median cold readiness at or below 5 seconds.

- [ ] **Step 6: Run packaged feature smoke tests**

On an isolated port, run Playwright coverage for main navigation, classic/smart canvas save-reload, OpenShop open-save-close, 3D Director open-close, software settings, storage migration, API provider persistence, and voice status without downloading model data. Use real API requests only with separate user authorization.

- [ ] **Step 7: Run the real voice-assistant acceptance test**

Point the isolated data root at the separately downloaded, user-authorized Fun-ASR-Nano-2512 model directory without copying it into the program directory or stage. Verify first activation, microphone permission persistence, live partial text replacement at the active caret, punctuation stabilization, silence/noise rejection, `Shift+Q`, 10-second no-speech auto-submit, OpenShop text fields, and clean service/device release. Record cold/warm voice-service readiness, first partial latency, finalization latency, peak working set, and GPU/CPU mode; the installer fails acceptance if packaged voice cannot complete a real transcription.

- [ ] **Step 8: Verify upgrade and data preservation**

Install the same package twice, then install a version-bumped test package. Confirm program files change while selected data-root hashes remain unchanged except for expected schema/version metadata. Select API update on one upgrade and confirm official defaults update while custom provider and credentials remain.

- [ ] **Step 9: Validate a clean Windows 11 x64 system**

Install the same artifact in a clean Windows 11 23H2-or-newer x64 virtual machine with networking disabled after artifact transfer and no preinstalled Python, Node.js, .NET desktop runtime, or WebView2 Evergreen dependency. Verify first launch, data-root wizard, main canvas, OpenShop, 3D Director, save/restart, uninstall, and retained user data. Record the VM build number and evidence in the report.

- [ ] **Step 10: Write the validation report**

Record source commit, runtime lock hashes, SBOM hash, stage size, installer size/SHA-256, Inno version, signing state, install path, isolated data root, clean-system build, test results, startup measurements, voice measurements, no-console evidence, and any untested paid/provider workflow.

- [ ] **Step 11: Reconfirm protected state**

The original port-5000 listener/PID and protected data hashes must match the pre-validation record. Stop only temporary test processes and remove only the resolved temporary install/data roots after validating their paths remain inside `E:\Claude专业组\tmp`.

- [ ] **Step 12: Commit validation tooling and report**

```powershell
git add tools/measure-windows11-startup.ps1 docs/validation
git commit -m "test: validate Windows 11 installer release"
```

## Task 17: Run the Full Release Gate

**Files:**
- Modify only files required by failures directly caused by this implementation

- [ ] **Step 1: Run backend and root suites**

```powershell
python\python.exe -m unittest discover -s tests -v
$tests = Get-ChildItem -LiteralPath 'tools/tests' -Filter '*.test.mjs' | Sort-Object Name
foreach($test in $tests){ node --test $test.FullName; if($LASTEXITCODE){ exit $LASTEXITCODE } }
```

Expected: all tests PASS.

- [ ] **Step 2: Run OpenShop and 3D suites/builds**

```powershell
npm.cmd test --prefix integrations/openshop
npm.cmd run build:hstar --prefix integrations/openshop
npm.cmd test --prefix integrations/storyai-3d-director-desk
npm.cmd run build --prefix integrations/storyai-3d-director-desk
```

Expected: all tests and both production builds PASS.

- [ ] **Step 3: Run desktop and package suites**

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release
powershell -NoProfile -ExecutionPolicy Bypass -File build/scripts/Test-HstarWindows11Stage.ps1
node --test tools/tests/windows11-runtime-lock.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-installer-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 4: Run encoding, syntax, and diff checks**

```powershell
node tools/audit-text-encoding.mjs
python\python.exe -m compileall -q main.py hstar_runtime voice_assistant
git diff --check
git status --short --branch
```

Expected: encoding and syntax checks exit 0; Git shows only intentional implementation commits and no stage, model, secret, log, cache, or user-data files.

- [ ] **Step 5: Final checkpoint before real installation**

Present the installer path, SHA-256, validation report, startup metrics, and known limitations to the user. Do not overwrite the currently installed stable Hstar until the user explicitly authorizes that exact installation action.

## Deferred Classic Edition Plan

After Windows 11 acceptance, write a separate plan that covers Python 3.8 source compatibility, a Chromium 109-compatible desktop shell, Win7 SHA-2/TLS prerequisites, classic dependency locks, low-end WebGL fallbacks, removal of voice UI, Windows 7/8.1/10 clean-system tests, and the user's old laptop. Do not implement those items opportunistically inside this plan.
