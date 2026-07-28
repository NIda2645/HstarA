# Hstar Startup, Dark Title Bar, and Canvas Shutdown Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Subagents are prohibited for this repository session. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the Windows startup smoothness pass, apply a dark native title bar, and replace the Windows-style close confirmation with a reliable native dialog that matches the active Hstar canvas theme.

**Architecture:** Keep shutdown sequencing in `ShutdownCoordinator`, add small runtime helpers for DWM title-bar styling and structured canvas-theme parsing, and make `ShutdownConfirmationWindow` a full-owner borderless overlay. The startup path continues to use the native H.264 `MediaElement`; this pass removes duplicate initial playback work without changing the approved animation or five-second minimum.

**Tech Stack:** .NET 8, WPF, WebView2, Windows DWM API, xUnit

---

**Working-tree note:** `MainWindow.xaml.cs` already contains approved but uncommitted startup-animation work from the immediately preceding task. Do not stage that shared file in partially passing intermediate states. Complete Tasks 1-3, run their focused tests, and create one consolidated desktop-shell commit after Task 3.

## File Map

- Create `desktop/Hstar.Desktop/Properties/AssemblyInfo.cs`: expose focused internal helpers to the test project.
- Create `desktop/Hstar.Desktop/Runtime/CanvasTheme.cs`: define the light/dark theme enum, detection script, and structured WebView result parser.
- Create `desktop/Hstar.Desktop/Runtime/NativeWindowTheme.cs`: contain all DWM interop and non-fatal fallback behavior.
- Modify `desktop/Hstar.Desktop/MainWindow.xaml.cs`: apply title-bar theming, resolve the active canvas theme before user-close confirmation, and deduplicate native startup playback.
- Modify `desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml`: replace the system dialog frame with the approved canvas-style owner overlay.
- Modify `desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml.cs`: apply the selected palette, synchronize overlay bounds with the owner, and preserve close semantics.
- Create `desktop/Hstar.Desktop.Tests/CanvasThemeTests.cs`: test structured theme parsing and detection coverage.
- Create `desktop/Hstar.Desktop.Tests/NativeWindowThemeTests.cs`: test pure COLORREF conversion and harmless zero-handle fallback.
- Create `desktop/Hstar.Desktop.Tests/ShutdownConfirmationWindowContractTests.cs`: test the approved XAML and interaction contract without launching the app.
- Modify `desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs`: test title-bar initialization and single initial media playback.

### Task 1: Specify theme detection and native title-bar behavior

**Files:**
- Create: `desktop/Hstar.Desktop.Tests/CanvasThemeTests.cs`
- Create: `desktop/Hstar.Desktop.Tests/NativeWindowThemeTests.cs`
- Modify: `desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs`
- Create: `desktop/Hstar.Desktop/Properties/AssemblyInfo.cs`
- Create: `desktop/Hstar.Desktop/Runtime/CanvasTheme.cs`
- Create: `desktop/Hstar.Desktop/Runtime/NativeWindowTheme.cs`
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`

- [ ] **Step 1: Write failing tests for structured theme parsing**

Create `CanvasThemeTests.cs` with these cases:

```csharp
using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class CanvasThemeTests
{
    [Theory]
    [InlineData("true", CanvasTheme.Dark)]
    [InlineData("false", CanvasTheme.Light)]
    [InlineData("null", CanvasTheme.Light)]
    [InlineData("\"true\"", CanvasTheme.Light)]
    [InlineData("invalid", CanvasTheme.Light)]
    public void ParseFallsBackToLightUnlessWebViewReturnsBooleanTrue(
        string json,
        CanvasTheme expected)
    {
        Assert.Equal(expected, CanvasThemeDetection.ParseResult(json));
    }

    [Fact]
    public void DetectionScriptRecognizesEveryCanvasDarkThemeClass()
    {
        Assert.Contains("theme-dark", CanvasThemeDetection.Script);
        Assert.Contains("studio-theme-dark", CanvasThemeDetection.Script);
        Assert.Contains("document.documentElement", CanvasThemeDetection.Script);
        Assert.Contains("document.body", CanvasThemeDetection.Script);
    }
}
```

- [ ] **Step 2: Write failing tests for safe native color conversion and shell hookup**

Create `NativeWindowThemeTests.cs`:

```csharp
using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class NativeWindowThemeTests
{
    [Fact]
    public void ToColorRefUsesWindowsBgrByteOrder()
    {
        Assert.Equal(0x00271811, NativeWindowTheme.ToColorRef(0x11, 0x18, 0x27));
    }

    [Fact]
    public void ZeroWindowHandleIsANonFatalNoOp()
    {
        NativeWindowTheme.TryApplyDarkTitleBar(nint.Zero);
    }
}
```

Add a contract assertion to `DesktopStartupShellContractTests.cs`:

```csharp
[Fact]
public void MainWindowAppliesNativeDarkTitleBarAfterHandleCreation()
{
    var source = File.ReadAllText(ProjectFile(
        "desktop", "Hstar.Desktop", "MainWindow.xaml.cs"));

    Assert.Contains("SourceInitialized += OnSourceInitialized;", source);
    Assert.Contains("NativeWindowTheme.TryApplyDarkTitleBar", source);
    Assert.Contains("SourceInitialized -= OnSourceInitialized;", source);
}
```

- [ ] **Step 3: Run the focused tests and confirm the new types are missing**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter "FullyQualifiedName~CanvasThemeTests|FullyQualifiedName~NativeWindowThemeTests|FullyQualifiedName~MainWindowAppliesNativeDarkTitleBar"
```

Expected: FAIL because `CanvasTheme`, `CanvasThemeDetection`, and `NativeWindowTheme` do not exist and `MainWindow` has no `SourceInitialized` hook.

- [ ] **Step 4: Add internal test visibility and the structured theme parser**

Create `Properties/AssemblyInfo.cs`:

```csharp
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Hstar.Desktop.Tests")]
```

Create `Runtime/CanvasTheme.cs`:

```csharp
using System.Text.Json;

namespace Hstar.Desktop.Runtime;

internal enum CanvasTheme
{
    Light,
    Dark,
}

internal static class CanvasThemeDetection
{
    internal const string Script = """
        (() => {
          const roots = [document.documentElement, document.body];
          return roots.some(root =>
            root?.classList?.contains('theme-dark')
            || root?.classList?.contains('studio-theme-dark'));
        })()
        """;

    internal static CanvasTheme ParseResult(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return CanvasTheme.Light;
        }

        try
        {
            return JsonSerializer.Deserialize<bool>(json)
                ? CanvasTheme.Dark
                : CanvasTheme.Light;
        }
        catch (JsonException)
        {
            return CanvasTheme.Light;
        }
    }
}
```

- [ ] **Step 5: Add the isolated DWM helper**

Create `Runtime/NativeWindowTheme.cs` with the implementation below. DWM errors are ignored and Win11-only color attributes are gated by OS version:

```csharp
using System.Runtime.InteropServices;

namespace Hstar.Desktop.Runtime;

internal static partial class NativeWindowTheme
{
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeBefore20H1 = 19;
    private const int DwmwaBorderColor = 34;
    private const int DwmwaCaptionColor = 35;
    private const int DwmwaTextColor = 36;

    internal static int ToColorRef(byte red, byte green, byte blue) =>
        red | (green << 8) | (blue << 16);

    internal static void TryApplyDarkTitleBar(nint windowHandle)
    {
        if (windowHandle == nint.Zero)
        {
            return;
        }

        try
        {
            var enabled = 1;
            var result = DwmSetWindowAttribute(
                windowHandle,
                DwmwaUseImmersiveDarkMode,
                ref enabled,
                sizeof(int));
            if (result < 0)
            {
                _ = DwmSetWindowAttribute(
                    windowHandle,
                    DwmwaUseImmersiveDarkModeBefore20H1,
                    ref enabled,
                    sizeof(int));
            }

            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
            {
                return;
            }

            SetColor(windowHandle, DwmwaBorderColor, 0x33, 0x41, 0x55);
            SetColor(windowHandle, DwmwaCaptionColor, 0x11, 0x18, 0x27);
            SetColor(windowHandle, DwmwaTextColor, 0xF8, 0xFA, 0xFC);
        }
        catch (DllNotFoundException)
        {
        }
        catch (EntryPointNotFoundException)
        {
        }
        catch (BadImageFormatException)
        {
        }
    }

    private static void SetColor(
        nint windowHandle,
        int attribute,
        byte red,
        byte green,
        byte blue)
    {
        var color = ToColorRef(red, green, blue);
        _ = DwmSetWindowAttribute(windowHandle, attribute, ref color, sizeof(int));
    }

    [LibraryImport("dwmapi.dll")]
    private static partial int DwmSetWindowAttribute(
        nint windowHandle,
        int attribute,
        ref int value,
        int valueSize);
}
```

- [ ] **Step 6: Hook title-bar theming after the main handle exists**

Add `using System.Windows.Interop;` to `MainWindow.xaml.cs`. In the constructor, add:

```csharp
SourceInitialized += OnSourceInitialized;
```

Add:

```csharp
private void OnSourceInitialized(object? sender, EventArgs eventArgs) =>
    NativeWindowTheme.TryApplyDarkTitleBar(new WindowInteropHelper(this).Handle);
```

In `OnClosed`, detach it:

```csharp
SourceInitialized -= OnSourceInitialized;
```

- [ ] **Step 7: Run the focused tests**

Run the command from Step 3.

Expected: all selected tests PASS.

- [ ] **Step 8: Leave the passing foundation ready for the consolidated shell commit**

Do not stage `MainWindow.xaml.cs` yet. Confirm `git diff --check` passes and continue directly to Task 2 so the shared shell file is committed only after all related behavior passes.

### Task 2: Replace the shutdown dialog with the approved canvas overlay

**Files:**
- Create: `desktop/Hstar.Desktop.Tests/ShutdownConfirmationWindowContractTests.cs`
- Modify: `desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml`
- Modify: `desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml.cs`
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`

- [ ] **Step 1: Write the failing shutdown-dialog contract tests**

Create `ShutdownConfirmationWindowContractTests.cs`:

```csharp
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class ShutdownConfirmationWindowContractTests
{
    [Fact]
    public void DialogUsesCanvasPanelAndHasNoSystemTitleBar()
    {
        var xaml = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml");

        Assert.Contains("WindowStyle=\"None\"", xaml);
        Assert.Contains("AllowsTransparency=\"True\"", xaml);
        Assert.Contains("CornerRadius=\"20\"", xaml);
        Assert.Contains("CornerRadius=\"999\"", xaml);
        Assert.Contains("当前正在运行的任务将停止", xaml);
        Assert.Contains("已保存的画布和软件数据不会受到影响。", xaml);
        Assert.DoesNotContain("Title=\"确认关闭 Hstar\"", xaml);
    }

    [Fact]
    public void CancelAndCloseIconPreserveSafeDialogSemantics()
    {
        var xaml = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml");
        var source = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml.cs");

        Assert.Contains("x:Name=\"CancelButton\"", xaml);
        Assert.Contains("IsCancel=\"True\"", xaml);
        Assert.DoesNotContain("IsDefault=\"True\"", xaml);
        Assert.Contains("CloseIconButton_OnClick", xaml);
        Assert.Contains("CancelButton.Focus();", source);
        Assert.Contains("DialogResult = false;", source);
        Assert.Contains("DialogResult = true;", source);
    }

    [Fact]
    public void DialogDefinesBothCanvasThemePalettes()
    {
        var source = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml.cs");

        Assert.Contains("CanvasTheme.Dark", source);
        Assert.Contains("#111827", source);
        Assert.Contains("#F8FAFC", source);
        Assert.Contains("#E8EDF3", source);
        Assert.Contains("#334155", source);
    }

    private static string ReadProjectFile(params string[] segments)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine([directory.FullName, .. segments]);
            if (File.Exists(candidate))
            {
                return File.ReadAllText(candidate);
            }
            directory = directory.Parent;
        }
        throw new FileNotFoundException(Path.Combine(segments));
    }
}
```

- [ ] **Step 2: Run the new tests and verify the current system dialog fails them**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter FullyQualifiedName~ShutdownConfirmationWindowContractTests
```

Expected: FAIL because the current dialog has a system title bar, no theme palette, and mojibake text.

- [ ] **Step 3: Replace the XAML with a full-owner canvas overlay**

Set the window shell to:

```xml
<Window x:Class="Hstar.Desktop.Views.ShutdownConfirmationWindow"
        xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        WindowStyle="None"
        AllowsTransparency="True"
        ResizeMode="NoResize"
        ShowInTaskbar="False"
        WindowStartupLocation="Manual"
        Background="Transparent"
        FontFamily="Inter, Segoe UI, Microsoft YaHei UI">
```

The root is a full-window `Border` using `{DynamicResource ShutdownBackdropBrush}`. Its centered child panel is 440 px wide, padded by 18 px, and uses `CornerRadius="20"`, `{DynamicResource ShutdownPanelBrush}`, and `{DynamicResource ShutdownPanelBorderBrush}`. The content must include:

```xml
<TextBlock Text="确认关闭 Hstar" FontSize="13" FontWeight="Black" />
<Button x:Name="CloseIconButton"
        Width="30" Height="30"
        Content="×"
        Click="CloseIconButton_OnClick" />
<Border Padding="14,13" CornerRadius="14">
    <StackPanel>
        <TextBlock Text="当前正在运行的任务将停止"
                   FontSize="12" FontWeight="ExtraBold" />
        <TextBlock Margin="0,5,0,0"
                   Text="已保存的画布和软件数据不会受到影响。"
                   FontSize="11" FontWeight="SemiBold" />
    </StackPanel>
</Border>
<Button x:Name="CancelButton"
        Content="取消"
        IsCancel="True"
        Click="CancelButton_OnClick" />
<Button Content="关闭 Hstar" Click="CloseButton_OnClick" />
```

Use one shared button template with a 38 px height and `CornerRadius="999"`. Bind all panel, text, border, hover, secondary, strong, and strong-text colors through dynamic resource keys so code-behind can switch palettes without duplicating layout.

- [ ] **Step 4: Apply the canvas palette and owner bounds in code-behind**

Change the constructor to accept `CanvasTheme` and apply frozen brushes:

```csharp
internal ShutdownConfirmationWindow(CanvasTheme theme)
{
    InitializeComponent();
    ApplyTheme(theme);
    Loaded += OnLoaded;
}
```

Implement `OnLoaded` so the transparent overlay exactly covers its owner and then focuses cancel:

```csharp
private void OnLoaded(object sender, RoutedEventArgs eventArgs)
{
    if (Owner is not null)
    {
        Left = Owner.Left;
        Top = Owner.Top;
        Width = Owner.ActualWidth;
        Height = Owner.ActualHeight;
    }
    CancelButton.Focus();
}
```

Use `BrushConverter` once per palette entry, freeze each `SolidColorBrush`, and assign these exact canvas values:

```text
Light: backdrop #6BF8FAFC, panel #FFFFFF, border #E8EDF3,
       text #111827, muted #64748B, soft #F8FAFC,
       strong #111827, strong-text #FFFFFF.
Dark:  backdrop #B8020617, panel #111827, border #334155,
       text #F8FAFC, muted #94A3B8, soft #1E293B,
       strong #D8DEE9, strong-text #0F172A.
```

Both `CancelButton_OnClick` and `CloseIconButton_OnClick` set `DialogResult = false`; only `CloseButton_OnClick` sets `DialogResult = true`.

- [ ] **Step 5: Query the active WebView theme before showing the dialog**

Add to `MainWindow.xaml.cs`:

```csharp
private async Task<CanvasTheme> ResolveCanvasThemeAsync(
    CancellationToken cancellationToken)
{
    var core = MainWebView.CoreWebView2;
    if (core is null)
    {
        return CanvasTheme.Light;
    }

    try
    {
        var result = await core.ExecuteScriptAsync(CanvasThemeDetection.Script)
            .WaitAsync(cancellationToken);
        return CanvasThemeDetection.ParseResult(result);
    }
    catch (InvalidOperationException)
    {
        return CanvasTheme.Light;
    }
    catch (System.Runtime.InteropServices.COMException)
    {
        return CanvasTheme.Light;
    }
}
```

Update confirmation flow:

```csharp
private async Task<bool> ConfirmUserCloseAsync(CancellationToken cancellationToken)
{
    cancellationToken.ThrowIfCancellationRequested();
    var theme = await ResolveCanvasThemeAsync(cancellationToken);
    if (!Dispatcher.CheckAccess())
    {
        return await Dispatcher.InvokeAsync(() => ShowCloseConfirmation(theme));
    }
    return ShowCloseConfirmation(theme);
}

private bool ShowCloseConfirmation(CanvasTheme theme)
{
    var dialog = new ShutdownConfirmationWindow(theme) { Owner = this };
    return dialog.ShowDialog() == true;
}
```

- [ ] **Step 6: Run dialog and shutdown regression tests**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter "FullyQualifiedName~ShutdownConfirmationWindowContractTests|FullyQualifiedName~ShutdownCoordinatorTests|FullyQualifiedName~CanvasThemeTests"
```

Expected: all selected tests PASS.

- [ ] **Step 7: Leave the passing dialog ready for the consolidated shell commit**

Confirm `git diff --check` passes and continue directly to Task 3. The dialog, title-bar, and startup lifecycle changes form one desktop-shell update because they share `MainWindow.xaml.cs`.

### Task 3: Deduplicate initial startup media work

**Files:**
- Modify: `desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs`
- Modify: `desktop/Hstar.Desktop/MainWindow.xaml.cs`

- [ ] **Step 1: Add a failing single-start lifecycle test**

Add to `DesktopStartupShellContractTests.cs`:

```csharp
[Fact]
public void NativeStartupBeginsPlaybackOnlyFromTheLoadedLifecycle()
{
    var source = File.ReadAllText(ProjectFile(
        "desktop", "Hstar.Desktop", "MainWindow.xaml.cs"));
    var opened = SourceMethod(
        source,
        "private async void OnNativeStartupMediaOpened",
        "private void OnNativeStartupMediaEnded");

    Assert.Contains("StartNativeStartupMedia();", source);
    Assert.Contains("_nativePlaybackStarted", source);
    Assert.DoesNotContain("NativeStartupMedia.Play();", opened);
}
```

- [ ] **Step 2: Run the focused test and confirm duplicate playback is detected**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter FullyQualifiedName~NativeStartupBeginsPlaybackOnlyFromTheLoadedLifecycle
```

Expected: FAIL because `OnNativeStartupSurfaceLoaded` and `OnNativeStartupMediaOpened` both call `Play()` and no lifecycle guard exists.

- [ ] **Step 3: Add a one-time initial playback guard**

Add a `_nativePlaybackStarted` field and method:

```csharp
private bool _nativePlaybackStarted;

private void StartNativeStartupMedia()
{
    if (_nativePlaybackStarted || _nativeStartupFailed || _startupDisposed)
    {
        return;
    }

    _nativePlaybackStarted = true;
    NativeStartupMedia.Play();
}
```

Call `StartNativeStartupMedia()` from `OnNativeStartupSurfaceLoaded`. Remove the second `NativeStartupMedia.Play()` from `OnNativeStartupMediaOpened`; that handler should only fade the already-loaded poster. Keep `OnNativeStartupMediaEnded` responsible for looping the successfully playing video.

- [ ] **Step 4: Run startup shell tests**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release --filter FullyQualifiedName~DesktopStartupShellContractTests
```

Expected: all startup shell contract tests PASS.

- [ ] **Step 5: Commit the complete desktop-shell update**

```powershell
git add desktop/Hstar.Desktop/Properties/AssemblyInfo.cs desktop/Hstar.Desktop/Runtime/CanvasTheme.cs desktop/Hstar.Desktop/Runtime/NativeWindowTheme.cs desktop/Hstar.Desktop/MainWindow.xaml desktop/Hstar.Desktop/MainWindow.xaml.cs desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml desktop/Hstar.Desktop/Views/ShutdownConfirmationWindow.xaml.cs desktop/Hstar.Desktop/Assets/startup desktop/Hstar.Desktop/Hstar.Desktop.csproj desktop/Hstar.Desktop/Runtime/EmbeddedStartupRuntime.cs desktop/Hstar.Desktop.Tests/CanvasThemeTests.cs desktop/Hstar.Desktop.Tests/NativeWindowThemeTests.cs desktop/Hstar.Desktop.Tests/ShutdownConfirmationWindowContractTests.cs desktop/Hstar.Desktop.Tests/DesktopStartupShellContractTests.cs desktop/Hstar.Desktop.Tests/EmbeddedStartupRuntimeTests.cs desktop/Hstar.Desktop.Tests/StartupAssetTests.cs
git commit -m "feat: polish Windows startup and shutdown shell"
```

### Task 4: Full regression and isolated desktop verification

**Files:**
- Modify only if a verified defect is found in a file already listed above.

- [ ] **Step 1: Check all touched source for encoding damage**

Run:

```powershell
rg -n "纭|鍏|璇|鏃|妗|杞|闂|锛|銆|鈥" desktop/Hstar.Desktop desktop/Hstar.Desktop.Tests
```

Expected: no matches in touched files. Replace any confirmed mojibake in touched user-visible strings with valid UTF-8 Chinese before continuing.

- [ ] **Step 2: Run the complete desktop test project**

Run:

```powershell
dotnet test desktop/Hstar.Desktop.Tests/Hstar.Desktop.Tests.csproj -c Release
```

Expected: all tests PASS with zero failures.

- [ ] **Step 3: Build the desktop application without packaging**

Run:

```powershell
dotnet build desktop/Hstar.Desktop/Hstar.Desktop.csproj -c Release --no-restore
```

Expected: build succeeds with zero errors. This is not an installer build.

- [ ] **Step 4: Launch against an isolated temporary data root and random port**

Use the repository's existing desktop integration launcher or startup test harness, configured with a new directory under `tmp` and an OS-assigned/random port. Do not use `E:\Hstar缓存`, `D:\Hstar`, or port `3000`.

Expected observations:

- The approved Lightfall motion appears immediately with no black, blue, or unrelated multicolor flash.
- Initial motion is smooth and does not perform a visible restart when media opens.
- The startup visual remains for at least five seconds.
- The main Windows title bar is dark before the application becomes interactive.
- Light canvas theme produces the approved light shutdown overlay.
- Dark canvas theme produces the approved dark shutdown overlay.
- Close icon, `Esc`, and `取消` return to the running application.
- Only `关闭 Hstar` performs shutdown.

- [ ] **Step 5: Inspect the final diff and confirm packaging exclusions**

Run:

```powershell
git diff --check
git status --short
```

Expected: no whitespace errors, no installer artifacts, and no changes under `E:\Hstar缓存` or `D:\Hstar`.

- [ ] **Step 6: Commit any verification-only correction**

Only when Step 1-5 exposed a real defect, stage the exact corrected source and matching test, then commit:

```powershell
git commit -m "fix: harden desktop shell polish"
```

If no correction was required, do not create an empty commit.
