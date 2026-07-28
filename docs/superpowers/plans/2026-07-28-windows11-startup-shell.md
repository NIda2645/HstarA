# Hstar Windows 11 Startup Shell Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are prohibited for this work. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restore a maintainable Windows 11 desktop shell with the approved full-window Lightfall startup experience, a first-run data-directory wizard, explicit interactive readiness, close confirmation, direct storage switching, controlled restart, and a complete independently installable package.

**Architecture:** Recover the already tested WPF/WebView2 shell baseline from repository history, then evolve it into a two-WebView startup architecture sharing one `CoreWebView2Environment`. A native bootstrap pointer under `%LocalAppData%` selects the active data root before Python starts, while the Python application remains authoritative for business data and reports explicit health and browser-interactive readiness. Shutdown and restart use one explicit state machine so ordinary closes are confirmed and controlled restarts bypass duplicate prompts.

**Tech Stack:** .NET 8 WPF, Microsoft WebView2, Python/FastAPI, local OGL/WebGL startup assets, xUnit, Node test contracts, pytest, Playwright, PowerShell, Inno Setup 6.

---

## File Map

- `desktop/Hstar.sln`: Windows 11 desktop solution.
- `desktop/Hstar.Desktop/Hstar.Desktop.csproj`: self-contained `win-x64` WPF shell and embedded startup assets.
- `desktop/Hstar.Desktop/MainWindow.xaml`: permanent main browser host plus temporary top startup browser host.
- `desktop/Hstar.Desktop/MainWindow.xaml.cs`: shared WebView environment, readiness handshake, startup failure UI, and window lifecycle.
- `desktop/Hstar.Desktop/Bootstrap/BootstrapSettings.cs`: schema-versioned atomic bootstrap pointer.
- `desktop/Hstar.Desktop/Bootstrap/StorageRootResolver.cs`: E/D/Documents defaults and non-destructive path validation.
- `desktop/Hstar.Desktop/Runtime/BackendProcess.cs`: hidden Python backend process and bounded shutdown.
- `desktop/Hstar.Desktop/Runtime/StartupCoordinator.cs`: startup phase state machine and timeout ownership.
- `desktop/Hstar.Desktop/Runtime/ShutdownCoordinator.cs`: ordinary close versus controlled restart state machine.
- `desktop/Hstar.Desktop/Runtime/WebViewConfiguration.cs`: trusted origins, navigation generation, and message validation.
- `desktop/Hstar.Desktop/Views/StorageSetupWindow.xaml(.cs)`: focused first-run storage wizard.
- `desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml(.cs)`: close confirmation with cancel as default.
- `desktop/Hstar.Desktop/Assets/startup/*`: fully local Lightfall/OGL page, gray-metallic three-star title, and failure state.
- `desktop/Hstar.Desktop.Tests/*`: path, state-machine, bridge, backend, and shutdown unit tests.
- `main.py`: shell health endpoint and direct storage selection API.
- `static/js/desktop-shell-bridge.js`: one-shot `hstar:interactive` message after the studio is usable.
- `static/index.html`: loads the desktop bridge without changing page routing.
- `static/software-settings.html`: select, save, confirm restart, or roll back without migration.
- `tools/tests/*`: static integration contracts for storage, startup bridge, and installer contents.
- `build/installer/Hstar.Windows11.iss`: independent Windows 11 installer with install-directory page, icon, and API overwrite option.
- `build/scripts/New-HstarWindows11Installer.ps1`: complete runtime staging and package build.
- `tools/validate-windows11-package.ps1`: isolated package validation.

### Task 1: Recover The Version-Controlled Desktop Baseline

**Files:**
- Create: `desktop/Hstar.sln`
- Create: `desktop/Hstar.Desktop/**`
- Create: `desktop/Hstar.Desktop.Tests/**`
- Create: `build/installer/Hstar.Windows11.iss`
- Create: `build/scripts/New-HstarWindows11Installer.ps1`
- Create: `tools/measure-windows11-startup.ps1`
- Modify: `.gitignore`

- [ ] **Step 1: Record the dirty-worktree boundary**

Run: `git status --short > "$env:TEMP\hstar-startup-shell-status-before.txt"`

Expected: existing canvas/OpenShop edits are recorded; no command changes user files.

- [ ] **Step 2: Recover the focused shell history**

Run these commits in order, resolving only current-file conflicts and preserving unrelated user edits:

```powershell
git cherry-pick 1a3d042
git cherry-pick 83ede5d
git cherry-pick 61e8b3c
git cherry-pick 3acbc6f
git cherry-pick f24338a
git cherry-pick 68d4bc8
git cherry-pick 4974bac
```

Expected: `desktop/Hstar.sln` and the Windows 11 installer source are tracked; no `desktop/**/bin`, `desktop/**/obj`, or staged installer payload is committed.

- [ ] **Step 3: Run the recovered unit tests**

Run: `dotnet test desktop/Hstar.sln -c Release --no-restore`

Expected: all recovered xUnit tests pass. If restore metadata is absent, run `dotnet restore desktop/Hstar.sln` once and rerun.

- [ ] **Step 4: Run baseline installer contracts**

Run: `node --test tools/tests/windows11-installer-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs tools/tests/windows11-startup-measurement-contract.test.mjs`

Expected: all selected Node contract tests pass.

### Task 2: Make Storage Selection Direct And Non-Destructive

**Files:**
- Create: `desktop/Hstar.Desktop/Bootstrap/BootstrapSettings.cs`
- Create: `desktop/Hstar.Desktop/Bootstrap/StorageRootResolver.cs`
- Create: `desktop/Hstar.Desktop.Tests/BootstrapSettingsTests.cs`
- Create: `desktop/Hstar.Desktop.Tests/StorageRootResolverTests.cs`
- Modify: `desktop/Hstar.Desktop/Runtime/AppPaths.cs`
- Modify: `desktop/Hstar.Desktop/Runtime/StartupCoordinator.cs`
- Modify: `main.py`
- Modify: `static/software-settings.html`
- Modify: `tools/tests/software-settings-integration.test.mjs`
- Test: `tests/test_storage_migration_api.py`

- [ ] **Step 1: Write failing C# path and bootstrap tests**

```csharp
[Theory]
[InlineData(true, true, @"E:\Hstar缓存")]
[InlineData(false, true, @"D:\Hstar缓存")]
public void DefaultRootUsesFirstAvailableDrive(bool hasE, bool hasD, string expected)
{
    var actual = StorageRootResolver.SelectDefaultRoot(
        drive => drive == @"E:\" ? hasE : drive == @"D:\" && hasD,
        @"C:\Users\tester\Documents");
    Assert.Equal(Path.GetFullPath(expected), actual);
}

[Fact]
public void SavingNewRootDoesNotReadCopyMoveOrDeleteOldRoot()
{
    var fileSystem = new RecordingBootstrapFileSystem();
    BootstrapSettings.SaveAtomic(fileSystem, _bootstrap, @"X:\Hstar缓存");
    Assert.DoesNotContain(fileSystem.Operations, item => item.StartsWith("copy:"));
    Assert.DoesNotContain(fileSystem.Operations, item => item.StartsWith("delete:"));
}
```

- [ ] **Step 2: Run the C# tests and verify failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter "StorageRootResolverTests|BootstrapSettingsTests"`

Expected: FAIL because the two focused bootstrap types do not yet exist.

- [ ] **Step 3: Implement the bootstrap pointer and fallback order**

```csharp
public static string SelectDefaultRoot(Func<string, bool> driveExists, string documents)
{
    if (driveExists(@"E:\")) return Path.GetFullPath(@"E:\Hstar缓存");
    if (driveExists(@"D:\")) return Path.GetFullPath(@"D:\Hstar缓存");
    return Path.GetFullPath(Path.Combine(documents, "Hstar缓存"));
}

public sealed record BootstrapSettings(int SchemaVersion, string Edition, string DataRoot)
{
    public const int CurrentSchemaVersion = 1;
}
```

`SaveAtomic` must create only the selected root and bootstrap parent, write UTF-8 JSON to a sibling temporary file with `WriteThrough`, flush it, and replace `bootstrap.json`. It must not enumerate or mutate the previous data root.

- [ ] **Step 4: Write the failing Python direct-switch test**

```python
def test_storage_selection_updates_pointer_without_migrating(client, monkeypatch, tmp_path):
    target = tmp_path / "X"
    monkeypatch.setattr(main, "migrate_runtime_data_to_storage", lambda *_: pytest.fail("migration called"))
    response = client.post("/api/software-settings/storage", json={"storage_root": str(target)})
    assert response.status_code == 200
    assert response.json()["settings"]["storage_root"] == str(target.resolve())
    assert "migration" not in response.json()["settings"]
```

- [ ] **Step 5: Run the Python test and verify failure**

Run: `python -m pytest tests/test_storage_migration_api.py -q`

Expected: FAIL because `/api/software-settings/storage` still calls `migrate_runtime_data_to_storage`.

- [ ] **Step 6: Remove migration from the storage API**

```python
@app.post("/api/software-settings/storage")
def save_software_storage(payload: SoftwareStorageRequest):
    settings = load_software_settings()
    storage_root = normalize_storage_root(payload.storage_root)
    settings["storage_root"] = storage_root
    save_software_settings(settings)
    return {"settings": {**settings, "restart_required": storage_root != STORAGE_ROOT}}
```

Keep old cache readers intact. Do not delete legacy migration helpers unless an existing runtime endpoint still needs them; only the active selection endpoint must stop invoking migration.

- [ ] **Step 7: Update software settings behavior**

Folder browsing only fills `storageInput`. Saving opens a confirmation dialog. Cancel restores the original path and does not call the API. Confirm posts once, then asks the desktop shell to perform a controlled restart:

```js
const accepted = await confirmStorageRestart(originalRoot, nextRoot);
if (!accepted) {
  storageInput.value = originalRoot;
  return;
}
const saved = await saveStorageRoot(nextRoot);
window.chrome?.webview?.postMessage({
  type: 'hstar:restart-with-data-root',
  schemaVersion: 1,
  dataRoot: saved.storage_root
});
```

- [ ] **Step 8: Run focused storage tests**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter "StorageRootResolverTests|BootstrapSettingsTests|AppPathsTests"
python -m pytest tests/test_storage_migration_api.py -q
node --test tools/tests/software-settings-integration.test.mjs
```

Expected: PASS, and test paths are under isolated temp roots only.

- [ ] **Step 9: Commit direct switching**

```powershell
git add desktop/Hstar.Desktop/Bootstrap desktop/Hstar.Desktop/Runtime/AppPaths.cs desktop/Hstar.Desktop/Runtime/StartupCoordinator.cs desktop/Hstar.Desktop.Tests main.py static/software-settings.html tools/tests/software-settings-integration.test.mjs tests/test_storage_migration_api.py
git commit -m "fix: switch Hstar data roots without migration"
```

### Task 3: Add Shell Health And Interactive Handshake

**Files:**
- Create: `static/js/desktop-shell-bridge.js`
- Create: `tools/tests/desktop-shell-bridge.test.mjs`
- Modify: `static/index.html`
- Modify: `main.py`
- Modify: `tests/test_startup_event.py`
- Modify: `desktop/Hstar.Desktop/Runtime/WebViewConfiguration.cs`
- Modify: `desktop/Hstar.Desktop.Tests/WebViewConfigurationTests.cs`

- [ ] **Step 1: Write failing backend health tests**

```python
def test_shell_health_requires_token(client, monkeypatch):
    monkeypatch.setattr(main, "SHELL_TOKEN", "test-token")
    assert client.get("/api/shell/health").status_code == 403
    response = client.get("/api/shell/health", headers={"X-Hstar-Shell-Token": "test-token"})
    assert response.status_code == 200
    assert response.json()["ready"] is True
```

- [ ] **Step 2: Run and verify health test failure**

Run: `python -m pytest tests/test_startup_event.py -q`

Expected: FAIL with `404` for `/api/shell/health`.

- [ ] **Step 3: Add the bounded shell health endpoint**

```python
@app.get("/api/shell/health")
def shell_health(x_hstar_shell_token: str = Header(default="")):
    if SHELL_TOKEN and not secrets.compare_digest(x_hstar_shell_token, SHELL_TOKEN):
        raise HTTPException(status_code=403, detail="Invalid shell token")
    return {"ready": True, "edition": os.environ.get("HSTAR_EDITION", "development")}
```

- [ ] **Step 4: Write failing desktop-message tests**

```csharp
[Fact]
public void InteractiveMessageRequiresSchemaOriginAndCurrentNavigation()
{
    var config = CreateConfiguration(navigationId: "nav-current");
    Assert.True(config.TryAcceptInteractiveMessage(config.StartUri, "nav-current", 1));
    Assert.False(config.TryAcceptInteractiveMessage(new Uri("https://example.com"), "nav-current", 1));
    Assert.False(config.TryAcceptInteractiveMessage(config.StartUri, "nav-old", 1));
    Assert.False(config.TryAcceptInteractiveMessage(config.StartUri, "nav-current", 2));
}
```

- [ ] **Step 5: Implement browser one-shot readiness**

`desktop-shell-bridge.js` waits for `DOMContentLoaded`, one animation frame, restored active route, bound sidebar controls, and absence of a blocking error overlay, then posts:

```js
window.chrome.webview.postMessage({
  type: 'hstar:interactive',
  schemaVersion: 1,
  navigationId: window.__HSTAR_NAVIGATION_ID__
});
```

The bridge must no-op in ordinary browsers and send at most once per navigation.

- [ ] **Step 6: Run handshake tests**

Run:

```powershell
python -m pytest tests/test_startup_event.py -q
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter WebViewConfigurationTests
node --test tools/tests/desktop-shell-bridge.test.mjs
```

Expected: PASS.

- [ ] **Step 7: Commit readiness protocol**

```powershell
git add main.py tests/test_startup_event.py static/index.html static/js/desktop-shell-bridge.js tools/tests/desktop-shell-bridge.test.mjs desktop/Hstar.Desktop/Runtime/WebViewConfiguration.cs desktop/Hstar.Desktop.Tests/WebViewConfigurationTests.cs
git commit -m "feat: signal when Hstar is interactive"
```

### Task 4: Build The Local Lightfall Startup Page

**Files:**
- Create: `desktop/Hstar.Desktop/Assets/startup/index.html`
- Create: `desktop/Hstar.Desktop/Assets/startup/startup.css`
- Create: `desktop/Hstar.Desktop/Assets/startup/startup.js`
- Create: `desktop/Hstar.Desktop/Assets/startup/ogl.mjs`
- Create: `desktop/Hstar.Desktop.Tests/StartupAssetTests.cs`
- Modify: `desktop/Hstar.Desktop/Hstar.Desktop.csproj`

- [ ] **Step 1: Write failing asset contract tests**

```csharp
[Fact]
public void StartupAssetsAreLocalAndUseApprovedConfiguration()
{
    var html = File.ReadAllText(Asset("index.html"));
    var js = File.ReadAllText(Asset("startup.js"));
    Assert.DoesNotContain("http://", html);
    Assert.DoesNotContain("https://", html);
    Assert.Contains("#8eb6f9", js);
    Assert.Contains("#644f9a", js);
    Assert.Contains("#1d1717", js);
    Assert.Contains("Hstar 正在启动中", html);
}
```

- [ ] **Step 2: Run and verify asset test failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter StartupAssetTests`

Expected: FAIL because `Assets/startup` does not exist.

- [ ] **Step 3: Add the local OGL implementation and approved shader parameters**

Adapt the supplied React Bits `Lightfall` shader to a plain ES module, preserving the algorithm and these defaults:

```js
const config = Object.freeze({
  colors: ['#8eb6f9', '#644f9a', '#1d1717'],
  backgroundColor: '#0A29FF', speed: 0.5,
  streakCount: 2, streakWidth: 1, streakLength: 1,
  glow: 1, density: 0.6, twinkle: 1, zoom: 3,
  backgroundGlow: 0, opacity: 1,
  mouseInteraction: true, mouseStrength: 0.2, mouseRadius: 1
});
```

Use `requestAnimationFrame`, resize the renderer with device-pixel-ratio bounds, and expose `window.hstarStartup.dispose()` to cancel frames, remove listeners, lose the WebGL context, and clear the canvas.

- [ ] **Step 4: Add centered gray-metallic title and synchronized stars**

```html
<div class="startup-title" aria-label="Hstar 正在启动中">
  <span class="stars" aria-hidden="true"><i></i><i></i><i></i></span>
  <strong>Hstar 正在启动中</strong>
</div>
```

The title group is centered as one unit. CSS uses a steel-gray base and a right-to-left cold-silver sweep shared by text and stars through one animated custom property. `prefers-reduced-motion` freezes Lightfall and removes the sweep.

- [ ] **Step 5: Embed startup assets in publish output**

```xml
<ItemGroup>
  <Content Include="Assets\startup\**\*">
    <CopyToOutputDirectory>PreserveNewest</CopyToOutputDirectory>
    <CopyToPublishDirectory>PreserveNewest</CopyToPublishDirectory>
  </Content>
</ItemGroup>
```

- [ ] **Step 6: Run asset tests**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter StartupAssetTests`

Expected: PASS.

- [ ] **Step 7: Commit startup assets**

```powershell
git add desktop/Hstar.Desktop/Assets/startup desktop/Hstar.Desktop/Hstar.Desktop.csproj desktop/Hstar.Desktop.Tests/StartupAssetTests.cs
git commit -m "feat: add local Lightfall startup visual"
```

### Task 5: Use Two Shared-Environment WebViews Until Interactive

**Files:**
- Create: `desktop/Hstar.Desktop/Runtime/WebViewEnvironmentFactory.cs`
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml`
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`
- Modify: `desktop/Hstar.Desktop/Runtime/StartupCoordinator.cs`
- Create: `desktop/Hstar.Desktop.Tests/StartupCoordinatorTests.cs`

- [ ] **Step 1: Write failing startup state-machine tests**

```csharp
[Fact]
public void OverlayCanExitOnlyAfterCurrentNavigationIsInteractive()
{
    var state = new StartupStateMachine();
    state.VisualReady();
    state.BackendReady();
    state.MainNavigated("nav-1");
    Assert.False(state.AcceptInteractive("nav-old"));
    Assert.True(state.AcceptInteractive("nav-1"));
    Assert.Equal(StartupPhase.MainInteractive, state.Phase);
}
```

- [ ] **Step 2: Run and verify state-machine failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter StartupCoordinatorTests`

Expected: FAIL because the explicit phases and navigation check are not implemented.

- [ ] **Step 3: Implement shared environment creation**

```csharp
public Task<CoreWebView2Environment> GetAsync(AppPaths paths) =>
    _environment ??= CoreWebView2Environment.CreateAsync(
        browserExecutableFolder: paths.FixedWebViewRuntime,
        userDataFolder: paths.WebViewCacheRoot);
```

Both `StartupWebView` and `MainWebView` call `EnsureCoreWebView2Async` with this same instance.

- [ ] **Step 4: Replace the WPF progress overlay with two browser hosts**

```xml
<Grid Background="#071022">
  <wv2:WebView2 x:Name="MainWebView" />
  <wv2:WebView2 x:Name="StartupWebView" Panel.ZIndex="20" />
</Grid>
```

Show the window immediately with an opaque dark background, navigate the top WebView to the local startup asset, and initialize backend plus main WebView in parallel.

- [ ] **Step 5: Dispose the startup WebView only after valid readiness**

```csharp
await StartupWebView.CoreWebView2.ExecuteScriptAsync("window.hstarStartup?.dispose?.()");
await FadeOutAsync(StartupWebView, TimeSpan.FromMilliseconds(220));
StartupWebView.Dispose();
```

Reject stale navigation IDs, subframes, unexpected origins, and unknown schema versions. Apply 15-second WebView environment, 45-second backend health, and 30-second post-navigation readiness timeouts. On failure keep the same window and show `重试启动` and `退出 Hstar`.

- [ ] **Step 6: Run unit and publish tests**

Run:

```powershell
dotnet test desktop/Hstar.sln -c Release
dotnet publish desktop/Hstar.Desktop/Hstar.Desktop.csproj -c Release -r win-x64 --self-contained true -o "$env:TEMP\hstar-shell-publish"
Test-Path "$env:TEMP\hstar-shell-publish\Assets\startup\index.html"
```

Expected: tests PASS and final command prints `True`.

- [ ] **Step 7: Commit the dual-WebView lifecycle**

```powershell
git add desktop/Hstar.Desktop desktop/Hstar.Desktop.Tests
git commit -m "feat: keep startup visual until Hstar is interactive"
```

### Task 6: Restore Close Confirmation And Controlled Restart

**Files:**
- Create: `desktop/Hstar.Desktop/Runtime/ShutdownCoordinator.cs`
- Create: `desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml`
- Create: `desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml.cs`
- Create: `desktop/Hstar.Desktop.Tests/ShutdownCoordinatorTests.cs`
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`
- Modify: `desktop/Hstar.Desktop/App.xaml.cs`

- [ ] **Step 1: Write failing shutdown-state tests**

```csharp
[Fact]
public async Task CancelledUserCloseLeavesBackendRunning()
{
    var backend = new FakeBackend();
    var coordinator = new ShutdownCoordinator(backend, _ => Task.FromResult(false));
    Assert.False(await coordinator.RequestAsync(ShutdownIntent.UserClose));
    Assert.Equal(0, backend.StopCalls);
}

[Fact]
public async Task ControlledRestartBypassesClosePromptOnce()
{
    var prompts = 0;
    var coordinator = new ShutdownCoordinator(new FakeBackend(), _ => { prompts++; return Task.FromResult(true); });
    Assert.True(await coordinator.RequestAsync(ShutdownIntent.ControlledRestart));
    Assert.Equal(0, prompts);
}
```

- [ ] **Step 2: Run and verify shutdown test failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter ShutdownCoordinatorTests`

Expected: FAIL because shutdown types do not exist.

- [ ] **Step 3: Implement explicit shutdown states**

```csharp
public enum ShutdownIntent { None, UserClose, ControlledRestart, SystemShutdown }
public enum ShutdownPhase { Running, Confirming, StoppingBackend, Relaunching, Closing }
```

Only one confirmation may be open. `Esc` and `取消` return to `Running`. `关闭 Hstar` requests graceful backend shutdown, waits at most five seconds, then kills only the owned process tree.

- [ ] **Step 4: Build the confirmation window**

Display title `确认关闭 Hstar`, body `关闭后，正在运行的任务将停止。`, and buttons `取消` and `关闭 Hstar`. Set cancel as the default focus and `Esc` behavior; style for both Windows light and dark modes.

- [ ] **Step 5: Wire every close source through one handler**

Handle WPF `Closing`; this covers the title-bar X, Alt+F4, and taskbar close. Cancel the first event, await `ShutdownCoordinator`, and close only after it enters `Closing`. A storage restart writes bootstrap atomically, starts the same executable with `UseShellExecute=true`, then exits without reopening the confirmation.

- [ ] **Step 6: Run shutdown tests**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter ShutdownCoordinatorTests`

Expected: PASS.

- [ ] **Step 7: Commit shutdown lifecycle**

```powershell
git add desktop/Hstar.Desktop desktop/Hstar.Desktop.Tests
git commit -m "feat: confirm Hstar shutdown and control restarts"
```

### Task 7: Redesign The First-Run Storage Wizard

**Files:**
- Modify: `desktop/Hstar.Desktop/Views/StorageSetupWindow.xaml`
- Modify: `desktop/Hstar.Desktop/Views/StorageSetupWindow.xaml.cs`
- Create: `desktop/Hstar.Desktop.Tests/StorageSetupViewModelTests.cs`

- [ ] **Step 1: Write failing wizard behavior tests**

```csharp
[Fact]
public void ExistingNonEmptyDirectoryIsAllowedWithoutMigrationChoice()
{
    Directory.CreateDirectory(_target);
    File.WriteAllText(Path.Combine(_target, "existing.txt"), "keep");
    var result = StorageSetupViewModel.Validate(_target, _programRoot);
    Assert.True(result.CanContinue);
    Assert.True(result.ContainsExistingData);
    Assert.False(result.RequiresMigration);
}
```

- [ ] **Step 2: Run and verify wizard test failure**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter StorageSetupViewModelTests`

Expected: FAIL because the non-migrating view model does not exist.

- [ ] **Step 3: Implement the focused one-page layout**

Use a stable 680x500 responsive window with: Hstar/`首次设置`, title `选择 Hstar 数据位置`, path field, folder icon button, inline availability state, `退出`, and primary `开始使用 Hstar`. Do not nest cards and do not display migration or copy options.

- [ ] **Step 4: Implement validation and commit semantics**

Typing and browsing validate without creating the directory. Clicking `开始使用 Hstar` creates the selected folder if needed, confirms writability with a disposable probe inside a newly created Hstar metadata subdirectory, atomically saves bootstrap, closes the wizard, restores Lightfall, and continues normal startup. Existing files are never modified.

- [ ] **Step 5: Run wizard and all desktop tests**

Run: `dotnet test desktop/Hstar.sln -c Release`

Expected: PASS.

- [ ] **Step 6: Commit the wizard**

```powershell
git add desktop/Hstar.Desktop/Views desktop/Hstar.Desktop.Tests/StorageSetupViewModelTests.cs
git commit -m "feat: redesign first-run data directory setup"
```

### Task 8: Preserve Complete Runtime And Installer Behavior

**Files:**
- Modify: `build/installer/Hstar.Windows11.iss`
- Modify: `build/scripts/New-HstarWindows11Installer.ps1`
- Modify: `tools/tests/windows11-installer-contract.test.mjs`
- Modify: `tools/tests/windows11-stage-contract.test.mjs`
- Modify: `tools/validate-windows11-package.ps1`

- [ ] **Step 1: Add failing installer contracts**

```js
assert.match(iss, /DisableDirPage\s*=\s*no/i);
assert.match(iss, /SetupIconFile=.*Hstar\.ico/i);
assert.match(iss, /Name:\s*"overwriteapidata"/i);
assert.doesNotMatch(buildScript, /Trimmed\s*=\s*true|PublishSingleFile\s*=\s*true/i);
assert.match(buildScript, /--self-contained\s+true/i);
```

Also assert that Python, fixed WebView2, voice assistant, OpenShop, 3D director assets, startup assets, and native runtime manifests are staged.

- [ ] **Step 2: Run and verify contract failure**

Run: `node --test tools/tests/windows11-installer-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs`

Expected: at least one new completeness assertion fails before script changes.

- [ ] **Step 3: Update package policy**

Publish untrimmed self-contained `win-x64`; copy all verified application and native dependencies; retain the install-directory page, Hstar icon, desktop shortcut, and unchecked API overwrite task. Preserve bootstrap under `%LocalAppData%` and never include, delete, or overwrite the selected data root. Use a new version and output name without replacing the R2 package.

- [ ] **Step 4: Run source and installer contracts**

Run:

```powershell
dotnet test desktop/Hstar.sln -c Release
node --test tools/tests/windows11-installer-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs
```

Expected: PASS.

- [ ] **Step 5: Commit installer policy**

```powershell
git add build/installer/Hstar.Windows11.iss build/scripts/New-HstarWindows11Installer.ps1 tools/tests/windows11-installer-contract.test.mjs tools/tests/windows11-stage-contract.test.mjs tools/validate-windows11-package.ps1
git commit -m "build: package complete Hstar Windows 11 runtime"
```

### Task 9: Perform Isolated Visual, DPI, Performance, And Installer Validation

**Files:**
- Modify: `tools/measure-windows11-startup.ps1`
- Modify: `tools/validate-windows11-package.ps1`
- Create: `docs/validation/2026-07-28-windows11-startup-shell.md`

- [ ] **Step 1: Run encoding and focused regression checks**

Run:

```powershell
node tools/audit-text-encoding.mjs
python -m pytest tests/test_startup_event.py tests/test_storage_migration_api.py -q
dotnet test desktop/Hstar.sln -c Release
```

Expected: PASS with no newly introduced mojibake.

- [ ] **Step 2: Publish into an isolated temp root**

Run:

```powershell
$root = 'E:\Claude专业组\tmp\hstar-startup-shell-validation'
dotnet publish desktop/Hstar.Desktop/Hstar.Desktop.csproj -c Release -r win-x64 --self-contained true -o "$root\publish"
```

Expected: publish succeeds without reading or writing `E:\Hstar缓存`, `D:\Hstar`, or port 3000.

- [ ] **Step 3: Run desktop visual checks**

Launch with isolated `LOCALAPPDATA`, `APPDATA`, and data root. Capture 1920x1080, 2560x1440, and 3840x2160 at 100%, 125%, 150%, and 200% scaling. Verify nonblank changing WebGL pixels, centered title group, no overlap, reduced-motion static rendering, no console window, startup overlay blocking input, and overlay release after the interactive message.

- [ ] **Step 4: Run cold and warm startup measurements**

Run: `powershell -ExecutionPolicy Bypass -File tools/measure-windows11-startup.ps1 -ExecutablePath "$root\publish\Hstar.exe" -Runs 5 -OutputPath "$root\startup.json"`

Expected: cold median <= 5000 ms and warm median <= 3000 ms, with timing ending at `hstar:interactive`.

- [ ] **Step 5: Build a new installer into the workspace parent**

Run: `powershell -ExecutionPolicy Bypass -File build/scripts/New-HstarWindows11Installer.ps1 -OutputDirectory 'E:\Claude专业组'`

Expected: a newly versioned `Hstar_Windows11_Setup_*.exe` is created beside, not over, the R2 package.

- [ ] **Step 6: Validate install, cancel-close, close, and first run**

Install silently only into `E:\Claude专业组\tmp\hstar-win11-install-test` while using isolated AppData. Verify install directory choice is visible in normal mode, icon is correct, API overwrite remains opt-in, first run defaults to E then D then Documents, non-empty roots work, cancel-close leaves the app usable, confirmed close removes the owned backend, and controlled storage restart relaunches automatically.

- [ ] **Step 7: Record hashes and results**

Document the installer name, size, SHA-256, test commands, startup medians, viewports, DPI values, and any residual risks in `docs/validation/2026-07-28-windows11-startup-shell.md`.

- [ ] **Step 8: Final focused commit**

```powershell
git add tools/measure-windows11-startup.ps1 tools/validate-windows11-package.ps1 docs/validation/2026-07-28-windows11-startup-shell.md
git commit -m "test: validate Windows 11 startup shell release"
```

## Self-Review

- Spec coverage: startup first frame, local Lightfall, metallic synchronized title, current-navigation readiness, failure retry, first-run E/D/Documents selection, non-empty roots, no migration, controlled restart, close confirmation, hidden backend, complete installer, icon, install directory, API overwrite, isolation, visual/DPI, and performance checks are each assigned to a task.
- Placeholder scan: no `TBD`, `TODO`, `implement later`, or unspecified error-handling steps remain.
- Type consistency: browser message types are `hstar:interactive` and `hstar:restart-with-data-root`; bootstrap schema is version 1; shutdown intents and phases use one explicit enum set; storage APIs consistently use `storage_root` over HTTP and `dataRoot` in desktop messages.
- Safety boundary: all destructive or installation tests are confined to `E:\Claude专业组\tmp`; no step mutates `E:\Hstar缓存`, `D:\Hstar`, existing canvases, or the development server on port 3000.
