using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class DesktopStartupShellContractTests
{
    [Fact]
    public void MainWindowHostsDedicatedMainAndStartupWebViews()
    {
        var xaml = File.ReadAllText(ProjectFile("desktop", "Hstar.Desktop", "MainWindow.xaml"));

        Assert.Contains("x:Name=\"MainWebView\"", xaml);
        Assert.Contains("x:Name=\"StartupWebView\"", xaml);
        Assert.DoesNotContain("x:Name=\"StartupOverlay\"", xaml);
        Assert.DoesNotContain("<ProgressBar", xaml);
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
        Assert.Contains("SetVirtualHostNameToFolderMapping", source);
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
}
