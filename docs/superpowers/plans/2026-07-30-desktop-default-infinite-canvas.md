# Hstar Desktop Default Infinite Canvas Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make every new Hstar Windows desktop process open the Infinite Canvas list while preserving normal in-session navigation and browser-only last-page restoration.

**Architecture:** The desktop shell injects a trusted, non-persistent `canvas` startup hint beside the existing navigation generation before the studio document is created. The studio shell resolves its initial route by preferring a valid desktop hint, then the saved page, then the existing default, and removes its boot-hiding class only after that route is active.

**Tech Stack:** .NET 8 WPF, Microsoft WebView2, inline browser JavaScript, xUnit, Node.js contract tests, PowerShell release validation.

---

## File Map

- Modify `desktop/Hstar.Desktop/MainWindow.xaml.cs`: inject the desktop-only initial page hint before navigating the main WebView.
- Modify `static/index.html`: resolve the initial studio page with desktop hint precedence and keep all normal navigation persistence unchanged.
- Modify `desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs`: enforce the desktop startup hint contract.
- Create `tools/tests/desktop-default-infinite-canvas.test.mjs`: enforce route precedence, fallback, and canvas-list ownership in the studio shell.

### Task 1: Add Failing Startup Route Contracts

**Files:**
- Modify: `desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs`
- Create: `tools/tests/desktop-default-infinite-canvas.test.mjs`

- [ ] **Step 1: Add the failing desktop contract**

Add this test to `DesktopStartupShellContractTests`:

```csharp
[Fact]
public void DesktopStartupRequestsTheInfiniteCanvasList()
{
    var source = File.ReadAllText(ProjectFile(
        "desktop",
        "Hstar.Desktop",
        "MainWindow.xaml.cs"));

    Assert.Contains("private const string DesktopStartPageId = \"canvas\";", source);
    Assert.Contains("window.__HSTAR_START_PAGE__", source);
    Assert.Contains("serializedStartPageId", source);
}
```

- [ ] **Step 2: Add the failing studio-shell contract**

Create `tools/tests/desktop-default-infinite-canvas.test.mjs` with these assertions:

```js
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const index = readFileSync('static/index.html', 'utf8');
const desktop = readFileSync('desktop/Hstar.Desktop/MainWindow.xaml.cs', 'utf8');

assert.match(desktop, /DesktopStartPageId\s*=\s*"canvas"/);
assert.match(desktop, /window\.__HSTAR_START_PAGE__\s*=\s*\{serializedStartPageId\}/);
assert.match(index, /function resolveInitialPageId\(\)/);
assert.match(
  index,
  /PAGE_IDS\.includes\(desktopStartPageId\)[\s\S]*desktopStartPageId[\s\S]*localStorage\.getItem\(ACTIVE_PAGE_KEY\)/,
  'desktop startup hint must take precedence over the remembered page',
);
assert.match(index, /const id = resolveInitialPageId\(\)/);
assert.match(index, /id="frame-canvas"[^>]+data-src="\/static\/canvas-list\.html/);
```

- [ ] **Step 3: Run the tests and verify RED**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --no-restore --filter DesktopStartupRequestsTheInfiniteCanvasList
node tools/tests/desktop-default-infinite-canvas.test.mjs
```

Expected: both commands fail because the startup hint and route resolver do not exist yet.

- [ ] **Step 4: Commit the red contracts**

```powershell
git add desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs tools/tests/desktop-default-infinite-canvas.test.mjs
git commit -m "test: require infinite canvas desktop startup"
```

### Task 2: Implement the One-Time Desktop Startup Route

**Files:**
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`
- Modify: `static/index.html`

- [ ] **Step 1: Inject the desktop startup page before navigation**

Add the constant next to the other startup constants:

```csharp
private const string DesktopStartPageId = "canvas";
```

In `NavigateMainOnceAsync`, serialize it and extend the existing document-created script:

```csharp
var serializedNavigationId = JsonSerializer.Serialize(navigationId);
var serializedStartPageId = JsonSerializer.Serialize(DesktopStartPageId);
_navigationScriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(
    $"window.__HSTAR_NAVIGATION_ID__ = {serializedNavigationId}; "
    + $"window.__HSTAR_START_PAGE__ = {serializedStartPageId};");
```

- [ ] **Step 2: Resolve the initial studio page with explicit precedence**

Add this helper after `PAGE_IDS` is declared in `static/index.html`:

```js
function resolveInitialPageId() {
    const desktopStartPageId = typeof window.__HSTAR_START_PAGE__ === 'string'
        ? window.__HSTAR_START_PAGE__.trim()
        : '';
    if(PAGE_IDS.includes(desktopStartPageId)) return desktopStartPageId;
    const rememberedPageId = localStorage.getItem(ACTIVE_PAGE_KEY);
    return PAGE_IDS.includes(rememberedPageId) ? rememberedPageId : DEFAULT_PAGE_ID;
}
```

Use the desktop hint in the early sidebar active-state script:

```js
var pageId = window.__HSTAR_START_PAGE__ || localStorage.getItem('studio_active_page');
```

Replace the route selection inside `restoreActivePage()` with:

```js
const id = resolveInitialPageId();
```

Keep `switchUI(trigger, id, { skipRemember:true })` unchanged so startup does not persistently overwrite the user's stored page.

- [ ] **Step 3: Run targeted tests and verify GREEN**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --no-restore --filter DesktopStartupRequestsTheInfiniteCanvasList
node tools/tests/desktop-default-infinite-canvas.test.mjs
```

Expected: both commands exit `0`.

- [ ] **Step 4: Commit the implementation**

```powershell
git add desktop/Hstar.Desktop/MainWindow.xaml.cs static/index.html
git commit -m "feat: open infinite canvas on desktop startup"
```

### Task 3: Verify Desktop and Studio Regressions

**Files:**
- Verify: `desktop/Hstar.Desktop/`
- Verify: `static/index.html`

- [ ] **Step 1: Run the full desktop suite**

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --no-restore -c Release
```

Expected: all desktop tests pass with zero failures.

- [ ] **Step 2: Run adjacent studio contracts**

```powershell
node tools/tests/desktop-shell-bridge.test.mjs
node tools/tests/desktop-default-infinite-canvas.test.mjs
node tools/tests/static-cache-integrity.test.mjs
```

Expected: all commands exit `0`.

- [ ] **Step 3: Run source-quality gates**

```powershell
node tools/audit-text-encoding.mjs
git diff --check
```

Expected: no encoding failures and no whitespace errors.

- [ ] **Step 4: Build the desktop shell in Release**

```powershell
dotnet build desktop/Hstar.Desktop/Hstar.Desktop.csproj --no-restore -c Release
```

Expected: build exits `0` with zero errors.

### Task 4: Validate a Real Isolated Desktop Launch

**Files:**
- Rebuild: `build/installer/stage/windows11/`
- Verify: temporary validation roots under `E:/Claude专业组/tmp/`

- [ ] **Step 1: Recreate and validate the Windows 11 stage without compiling an installer**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/New-HstarWindows11Stage.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/Test-HstarWindows11Stage.ps1
```

Expected: stage build and dependency validation exit `0`; no installer executable is produced.

- [ ] **Step 2: Launch once with isolated state and a non-5000 port**

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File tools/measure-windows11-startup.ps1 `
  -InstallRoot 'E:\Claude专业组\HstarA\build\installer\stage\windows11' `
  -DataRoot 'E:\Claude专业组\tmp\hstar-default-canvas-validation\data' `
  -AppDataRoot 'E:\Claude专业组\tmp\hstar-default-canvas-validation\appdata' `
  -ApprovedTempRoot 'E:\Claude专业组' `
  -ColdRuns 1 `
  -WarmRuns 1 `
  -PortStart 56420 `
  -OutputPath 'E:\Claude专业组\tmp\hstar-default-canvas-validation\startup-report.json' `
  -StartupTimeoutSeconds 60
```

Expected: both runs write non-null `readyUtc`, exit through maintenance shutdown, leave no Hstar/backend process, and leave no listener on the test ports.

- [ ] **Step 3: Verify final repository state**

```powershell
$validationRoot = [IO.Path]::GetFullPath('E:\Claude专业组\tmp\hstar-default-canvas-validation')
$approvedRoot = [IO.Path]::GetFullPath('E:\Claude专业组\tmp')
if (-not $validationRoot.StartsWith($approvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw "Validation root escaped the approved temporary directory: $validationRoot"
}
if (Test-Path -LiteralPath $validationRoot) {
    [IO.Directory]::Delete($validationRoot, $true)
}
git status --short --branch
git log -3 --oneline
```

Expected: only deliberate commits are present, the worktree is clean, and no package artifact was created for this change.
