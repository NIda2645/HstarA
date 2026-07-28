using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class DesktopStartupShellContractTests
{
    [Fact]
    public void MainWindowKeepsUnreadyBrowsersBehindAnImmediateNativeStartupSurface()
    {
        var xaml = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "MainWindow.xaml"));
        var source = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "MainWindow.xaml.cs"));

        Assert.Contains("x:Name=\"NativeStartupSurface\"", xaml);
        Assert.DoesNotContain("Background=\"#0A29FF\"", xaml);
        Assert.Contains("<MediaElement x:Name=\"NativeStartupMedia\"", xaml);
        Assert.Contains("LoadedBehavior=\"Manual\"", xaml);
        Assert.Contains("IsMuted=\"True\"", xaml);
        Assert.Contains("<Image x:Name=\"NativeStartupPoster\"", xaml);
        Assert.Contains("Stretch=\"UniformToFill\"", xaml);
        Assert.Contains("x:Name=\"MainWebView\"", xaml);
        Assert.Contains("x:Name=\"MainWebView\"\n                          Width=\"1\"", xaml);
        Assert.Contains("x:Name=\"StartupWebView\"\n                          Width=\"1\"", xaml);
        Assert.DoesNotContain("Visibility=\"Hidden\"", xaml);
        Assert.Contains("await MainWebView.EnsureCoreWebView2Async(environment)", source);
        Assert.Contains("EnsureStartupBrowserReadyAsync", source);
        Assert.DoesNotContain("await StartupWebView.EnsureCoreWebView2Async(environment)",
            SourceMethod(
                source,
                "private async Task PrepareBrowserCoreAsync()",
                "private Task EnsureStartupBrowserReadyAsync"));
        Assert.DoesNotContain("Task.WhenAll(", source);
        Assert.Contains("case \"hstar-startup:visual-ready\":", source);
        Assert.Contains("_startupBrowserReady = true;", source);
        Assert.Contains("if (_nativeStartupFailed)", source);
        Assert.Contains("RevealStartupBrowser();", source);
        Assert.Contains("MinimumStartupDisplay = TimeSpan.FromSeconds(5)", source);
        Assert.Contains("WaitForMinimumStartupDisplayAsync", source);
        Assert.Contains("InitializeNativeStartupMedia();", source);
        Assert.Contains("NativeStartupMedia.MediaOpened += OnNativeStartupMediaOpened;", source);
        Assert.Contains("NativeStartupMedia.MediaEnded += OnNativeStartupMediaEnded;", source);
        Assert.Contains("NativeStartupMedia.MediaFailed += OnNativeStartupMediaFailed;", source);
        Assert.Contains("StopNativeStartupMedia();", source);
        Assert.Contains("NativeStartupSurface.Visibility = Visibility.Collapsed;", source);
        Assert.Contains("RevealMainBrowser();", source);
        Assert.True(
            source.IndexOf("RevealMainBrowser();", StringComparison.Ordinal)
            < source.IndexOf("StartupWebView.Visibility = Visibility.Collapsed;", StringComparison.Ordinal));
        Assert.Contains(
            "await _interactiveCompletion.Task.WaitAsync(InteractiveTimeout, cancellationToken);",
            source);
        Assert.DoesNotContain("x:Name=\"StartupOverlay\"", xaml);
        Assert.DoesNotContain("<ProgressBar", xaml);
    }

    [Fact]
    public void DesktopProjectPublishesTheNativeLightfallVideoAndPoster()
    {
        var project = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "Hstar.Desktop.csproj"));

        Assert.Contains("Assets\\startup\\startup-lightfall.mp4", project);
        Assert.Contains("Assets\\startup\\startup-lightfall-poster.jpg", project);
        Assert.Contains("CopyToOutputDirectory=\"PreserveNewest\"", project);

        var video = ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "Assets",
            "startup",
            "startup-lightfall.mp4");
        var poster = ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "Assets",
            "startup",
            "startup-lightfall-poster.jpg");
        Assert.True(new FileInfo(video).Length > 100_000);
        Assert.True(new FileInfo(poster).Length > 10_000);
    }

    [Fact]
    public void NativeStartupUsesTheSystemMediaPipelineInsteadOfUiThreadFrameSwaps()
    {
        var source = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "MainWindow.xaml.cs"));

        Assert.Contains("BitmapCacheOption.OnLoad", source);
        Assert.Contains("NativeStartupMedia.Play();", source);
        Assert.Contains("NativeStartupMedia.Position = TimeSpan.Zero;", source);
        Assert.DoesNotContain("StartupFrameSequence", source);
        Assert.DoesNotContain("Channel<BitmapImage>", source);
    }

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

    [Fact]
    public void MainWindowAppliesNativeDarkTitleBarAfterHandleCreation()
    {
        var source = File.ReadAllText(ProjectFile(
            "desktop", "Hstar.Desktop", "MainWindow.xaml.cs"));

        Assert.Contains("SourceInitialized += OnSourceInitialized;", source);
        Assert.Contains("NativeWindowTheme.TryApplyDarkTitleBar", source);
        Assert.Contains("SourceInitialized -= OnSourceInitialized;", source);
    }

    [Fact]
    public void ApplicationRendersTheNativeStartupFrameBeforeStartingHeavyWork()
    {
        var source = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "App.xaml.cs"));

        var show = source.IndexOf("window.Show();", StringComparison.Ordinal);
        var firstFrame = source.IndexOf(
            "await global::System.Windows.Threading.Dispatcher.Yield(DispatcherPriority.Render);",
            StringComparison.Ordinal);
        var browserPreparation = source.IndexOf(
            "browserPreparation = window.PrepareBrowserAsync",
            StringComparison.Ordinal);

        Assert.True(show >= 0);
        Assert.True(firstFrame > show);
        Assert.True(browserPreparation > firstFrame);
    }

    [Fact]
    public void StartupShellUsesSharedEnvironmentAndBoundedReadiness()
    {
        var source = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "MainWindow.xaml.cs"));
        var factory = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "Runtime",
            "WebViewEnvironmentFactory.cs"));

        Assert.Contains("WebViewEnvironmentFactory", source);
        Assert.Contains("EnsureCoreWebView2Async(environment)", source);
        Assert.Contains("AddWebResourceRequestedFilter", source);
        Assert.Contains("WebResourceRequested += OnStartupWebResourceRequested", source);
        Assert.Contains("CreateWebResourceResponse", source);
        Assert.Contains("Cache-Control: no-store", source);
        Assert.Contains("WebResourceRequested -= OnStartupWebResourceRequested", source);
        Assert.Contains("EmbeddedStartupRuntime", source);
        Assert.DoesNotContain("SetVirtualHostNameToFolderMapping", source);
        Assert.DoesNotContain("startupAssetDirectory", source);
        Assert.Contains("InteractiveTimeout", source);
        Assert.Contains("CoreWebView2Environment.CreateAsync", factory);
        Assert.Contains("WEBVIEW2_DEFAULT_BACKGROUND_COLOR", factory);
        Assert.Contains("FF0A29FF", factory);
    }

    [Fact]
    public void ApplicationMarksInternalShutdownsBeforeClosingTheMainWindow()
    {
        var app = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "App.xaml.cs"));
        var window = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "MainWindow.xaml.cs"));

        Assert.Contains("BeginSystemShutdown", app);
        Assert.Contains("public void BeginSystemShutdown()", window);
        Assert.Contains("ShutdownIntent.SystemShutdown", window);
    }

    private static string ProjectFile(params string[] segments)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine([directory.FullName, .. segments]);
            if (File.Exists(candidate))
            {
                return candidate;
            }
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"Project file not found: {Path.Combine(segments)}");
    }

    private static string SourceMethod(string source, string startMarker, string endMarker)
    {
        var start = source.IndexOf(startMarker, StringComparison.Ordinal);
        var end = source.IndexOf(endMarker, start + startMarker.Length, StringComparison.Ordinal);
        Assert.True(start >= 0 && end > start);
        return source[start..end];
    }
}
