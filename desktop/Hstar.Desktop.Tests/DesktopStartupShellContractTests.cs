using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class DesktopStartupShellContractTests
{
    [Fact]
    public void MainWindowUsesTheBundledHtmlStartupSurfaceInsteadOfNativeVideo()
    {
        var xaml = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "MainWindow.xaml"));
        var source = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "MainWindow.xaml.cs"));

        Assert.Contains("Background=\"#000018\"", xaml);
        Assert.DoesNotContain("#0A29FF", xaml, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("x:Name=\"NativeStartupSurface\"", xaml);
        Assert.DoesNotContain("<MediaElement", xaml);
        Assert.Contains("<Rectangle x:Name=\"StartupFirstFrame\"", xaml);
        Assert.Contains("startup-first-frame.png", xaml);
        Assert.Contains("<ImageBrush", xaml);
        Assert.Contains("AlignmentX=\"Center\"", xaml);
        Assert.Contains("AlignmentY=\"Center\"", xaml);
        Assert.Contains("RenderOptions.BitmapScalingMode=\"HighQuality\"", xaml);
        Assert.DoesNotContain("Opacity=\"0.01\"", xaml);
        Assert.DoesNotContain("x:Name=\"StartupBootstrapSurface\"", xaml);
        Assert.DoesNotContain("BootstrapStreak", xaml);
        Assert.Contains("x:Name=\"MainWebView\"", xaml);
        Assert.Contains("x:Name=\"MainWebView\"\n                     Width=\"1\"", xaml);
        Assert.Contains("x:Name=\"StartupWebView\"", xaml);
        Assert.Contains("<wv2:WebView2CompositionControl x:Name=\"StartupWebView\"", xaml);
        Assert.DoesNotContain("x:Name=\"StartupWebView\"\n                          Width=\"1\"", xaml);
        Assert.DoesNotContain("Visibility=\"Hidden\"", xaml);
        Assert.Contains("DefaultBackgroundColor=\"#000018\"", xaml);
        Assert.Contains("await StartupWebView.EnsureCoreWebView2Async(environment)", source);
        Assert.Contains("await MainWebView.EnsureCoreWebView2Async(environment)", source);
        Assert.DoesNotContain("Task.WhenAll(", source);
        Assert.Contains("case \"hstar-startup:visual-ready\":", source);
        Assert.Contains("RevealInitialFrame();", source);
        Assert.DoesNotContain("PositionOutsideVirtualDesktop();", source);
        Assert.DoesNotContain("SystemParameters.VirtualScreenLeft", source);
        Assert.Contains("StartupFirstFrame.BeginAnimation(OpacityProperty, animation);", source);
        Assert.Contains("StartupFirstFrame.Visibility = Visibility.Collapsed;", source);
        Assert.Contains("MinimumStartupDisplay = TimeSpan.FromSeconds(5)", source);
        Assert.Contains("WaitForMinimumStartupDisplayAsync", source);
        Assert.DoesNotContain("NativeStartupMedia", source);
        Assert.DoesNotContain("NativeStartupPoster", source);
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
    public void DesktopProjectEmbedsTheHtmlRuntimeWithoutPublishingStartupVideo()
    {
        var project = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "Hstar.Desktop.csproj"));

        Assert.Contains("EmbeddedResource Include=\"Assets\\startup\\index.html\"", project);
        Assert.Contains("EmbeddedResource Include=\"Assets\\startup\\startup.css\"", project);
        Assert.Contains("EmbeddedResource Include=\"Assets\\startup\\startup.js\"", project);
        Assert.Contains("EmbeddedResource Include=\"Assets\\startup\\ogl.mjs\"", project);
        Assert.Contains("EmbeddedResource Include=\"Assets\\startup\\hstar-logo.svg\"", project);
        Assert.Contains("Resource Include=\"Assets\\startup\\startup-first-frame.png\"", project);
        Assert.DoesNotContain("EmbeddedResource Include=\"Branding\\Hstar.svg\"", project);
        Assert.DoesNotContain("startup-lightfall.mp4", project);
        Assert.DoesNotContain("startup-lightfall-poster.jpg", project);
    }

    [Fact]
    public void DesktopTargetsTheWindowsApiBaselineRequiredByCompositionWebView()
    {
        var project = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "Hstar.Desktop.csproj"));

        Assert.Contains(
            "<TargetFramework>net8.0-windows10.0.17763.0</TargetFramework>",
            project);
    }

    [Fact]
    public void MainBrowserControllerIsPreparedBeforeTheCompositionStartupController()
    {
        var source = File.ReadAllText(ProjectFile(
            "desktop",
            "Hstar.Desktop",
            "MainWindow.xaml.cs"));
        var preparation = SourceMethod(
            source,
            "private async Task PrepareBrowserCoreAsync()",
            "public async Task<bool> AttachBackendSessionAsync");

        var mainBrowser = preparation.IndexOf(
            "await MainWebView.EnsureCoreWebView2Async(environment)",
            StringComparison.Ordinal);
        var startupBrowser = preparation.IndexOf(
            "await StartupWebView.EnsureCoreWebView2Async(environment)",
            StringComparison.Ordinal);
        var visualReady = preparation.IndexOf(
            "await _startupBrowserVisualReady.Task",
            StringComparison.Ordinal);
        Assert.True(mainBrowser >= 0);
        Assert.True(startupBrowser >= 0);
        Assert.True(startupBrowser > mainBrowser);
        Assert.True(visualReady > startupBrowser);
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
    public void ApplicationShowsTheBundledFirstFrameWhileTheHtmlCompositionRenders()
    {
        var source = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "App.xaml.cs"));
        var xaml = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "MainWindow.xaml"));

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
        Assert.Contains("x:Name=\"StartupFirstFrame\"", xaml);
        Assert.DoesNotContain("Opacity=\"0.01\"", xaml);
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
        Assert.Contains("FF000018", factory);
        Assert.DoesNotContain("FF0A29FF", factory);
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
