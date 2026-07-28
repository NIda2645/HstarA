# Hstar Embedded Startup Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are forbidden for this repository session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Compile the complete Hstar Lightfall startup experience into `Hstar.exe` and serve it to the startup WebView directly from assembly memory without publishing standalone web files.

**Architecture:** Add a focused `EmbeddedStartupRuntime` service that owns the approved URI-to-resource map, MIME metadata, assembly resource validation, and in-memory streams. `MainWindow` registers a WebView2 request filter for the existing trusted startup origin and delegates responses to this service. Build and installer contracts assert that embedded resources exist while `Assets/startup` is absent from the staged filesystem.

**Tech Stack:** .NET 8 WPF, Microsoft WebView2, manifest resources, xUnit, PowerShell release gates, Node contract tests, Inno Setup

---

### Task 1: Embedded startup resource catalog

**Files:**
- Create: `desktop/Hstar.Desktop/Runtime/EmbeddedStartupRuntime.cs`
- Create: `desktop/Hstar.Desktop.Tests/EmbeddedStartupRuntimeTests.cs`
- Modify: `desktop/Hstar.Desktop/Hstar.Desktop.csproj`

- [ ] **Step 1: Write failing tests for the approved resource map**

Create tests that instantiate `EmbeddedStartupRuntime` with the Hstar desktop assembly and assert that `/index.html`, `/startup.css`, `/startup.js`, `/ogl.mjs`, and `/ogl.LICENSE.txt` resolve with the required MIME types and non-empty streams. Assert that HTTP, a foreign host, `..`, encoded separators, backslashes, unknown paths, query-path impersonation, and case changes are rejected.

- [ ] **Step 2: Run the focused tests and verify they fail**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter EmbeddedStartupRuntimeTests`

Expected: FAIL because `EmbeddedStartupRuntime` does not exist and the startup files are not embedded resources.

- [ ] **Step 3: Embed the five startup files**

Replace the startup `Content` item with explicit `EmbeddedResource` items using stable logical names beneath `Hstar.Desktop.StartupAssets.*`. Do not set `CopyToOutputDirectory` or `CopyToPublishDirectory`.

- [ ] **Step 4: Implement the minimal catalog**

Implement an immutable ordinal URI map, exact HTTPS host validation, traversal and encoded separator rejection, `TryOpen(Uri, out EmbeddedStartupAsset)`, and `ValidateResources()`. Each successful open returns a fresh read-only memory stream copied from the assembly resource and the exact MIME type.

- [ ] **Step 5: Run the focused tests and verify they pass**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter EmbeddedStartupRuntimeTests`

Expected: PASS with every accepted and rejected URI case covered.

### Task 2: WebView2 in-memory request handling

**Files:**
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`
- Modify: `desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs`
- Modify: `desktop/Hstar.Desktop.Tests/StartupAssetTests.cs`

- [ ] **Step 1: Write failing startup-shell contract tests**

Require `MainWindow` to call `AddWebResourceRequestedFilter`, attach `WebResourceRequested`, delegate to `EmbeddedStartupRuntime`, create `200` or `404` responses with `Cache-Control: no-store`, and detach the event both after startup disposal and during window closure. Reject the previous `SetVirtualHostNameToFolderMapping` and disk existence checks.

- [ ] **Step 2: Run the startup desktop tests and verify they fail**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --filter "DesktopStartupShellContractTests|StartupAssetTests"`

Expected: FAIL because `MainWindow` still maps `Assets/startup` from disk.

- [ ] **Step 3: Connect the embedded runtime to StartupWebView**

Construct and validate the catalog before navigation. Register `https://hstar-startup.local/*`, return in-memory WebView2 responses, keep the existing startup URI and source checks, and remove the folder mapping and disk resource validation. Preserve parallel browser preparation, retry/exit messages, 220 ms fade, and startup disposal behavior.

- [ ] **Step 4: Update source-level asset tests**

Read startup source files from the repository for visual/CSP assertions, and separately inspect the built desktop assembly resource names for packaging assertions. Keep every existing Lightfall, metallic title, stars, reduced-motion, failure UI, and message protocol check.

- [ ] **Step 5: Run all desktop tests**

Run: `dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj --configuration Release`

Expected: all desktop tests pass with no external startup-file dependency.

### Task 3: Windows stage and installer contracts

**Files:**
- Modify: `build/scripts/Test-HstarWindows11Stage.ps1`
- Modify: `tools/tests/windows11-stage-contract.test.mjs`
- Modify: `tools/tests/windows11-package-smoke-contract.test.mjs`
- Modify: `tools/tests/windows11-installer-contract.test.mjs` if its startup payload assertion references external files

- [ ] **Step 1: Write failing release-contract assertions**

Require the stage to contain `Hstar.exe` but no `Assets/startup` directory and no standalone startup `.html`, `.css`, `.js`, or `.mjs` payload. Require desktop tests to inspect the published EXE for all five embedded logical resource names.

- [ ] **Step 2: Run focused contract tests and verify they fail**

Run: `node --test tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs tools/tests/windows11-installer-contract.test.mjs`

Expected: FAIL because existing contracts still require `Assets/startup/index.html` and companion files.

- [ ] **Step 3: Update the stage validator and package contracts**

Delete external startup files from `$requiredFiles`, add an explicit rejection for `Assets/startup`, retain rejection of user-data asset directories, and keep GUI subsystem, fixed WebView2, Python, SBOM, file manifest, API overwrite checkbox, install directory page, and icon assertions unchanged.

- [ ] **Step 4: Run focused release contracts**

Run: `node --test tools/tests/windows11-stage-contract.test.mjs tools/tests/windows11-package-smoke-contract.test.mjs tools/tests/windows11-installer-contract.test.mjs`

Expected: all focused contracts pass.

### Task 4: Release verification and packaging

**Files:**
- Generated, ignored: `build/installer/stage/windows11/**`
- Output: `E:/Claude专业组/Hstar_Windows11_Setup_2026.07.28.2.exe`

- [ ] **Step 1: Synchronize deterministic checked-in runtime mirrors**

Run the official OpenShop and 3D Director build commands. Normalize only tracked generated artifacts required by the clean source gate; do not touch user data, stable installations, or port 3000.

- [ ] **Step 2: Run the complete clean source gate**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/Test-HstarSource.ps1`

Expected: exit 0 without dirty-test relaxations.

- [ ] **Step 3: Commit and push the implementation**

Run `git diff --check`, confirm no unresolved files, commit the implementation and generated source mirrors if required, then `git push origin main` without force.

- [ ] **Step 4: Build and validate the formal Windows 11 stage**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/New-HstarWindows11Stage.ps1`

Expected: `qualification=release`, `sourceTreeClean=true`, version `2026.07.28.2`, and source commit equal to pushed `HEAD`.

- [ ] **Step 5: Build the final installer**

Run: `powershell.exe -NoProfile -ExecutionPolicy Bypass -File build/scripts/New-HstarWindows11Installer.ps1 -OutputDirectory 'E:/Claude专业组'`

Expected: `E:/Claude专业组/Hstar_Windows11_Setup_2026.07.28.2.exe`; existing `_R2.exe` remains unchanged.

- [ ] **Step 6: Verify final artifact metadata and behavior contracts**

Compute SHA-256 and size, inspect version metadata and icon, verify install directory selection, API overwrite checkbox, no console window, fixed WebView2 runtime, embedded startup resources, close confirmation, storage setup/restart contracts, voice runtime contracts, and absence of `Assets/startup` in the installer payload.
