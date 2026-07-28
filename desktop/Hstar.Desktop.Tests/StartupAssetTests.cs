using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class StartupAssetTests
{
    [Fact]
    public void StartupAssetsAreLocalAndUseApprovedLightfallConfiguration()
    {
        var html = File.ReadAllText(Asset("index.html"));
        var css = File.ReadAllText(Asset("startup.css"));
        var script = File.ReadAllText(Asset("startup.js"));

        Assert.DoesNotContain("http://", html, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("https://", html, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Hstar 正在启动中", html);
        Assert.Contains("#8eb6f9", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("#644f9a", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("#1d1717", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("backgroundColor: '#0A29FF'", script);
        Assert.Contains("streakCount: 2", script);
        Assert.Contains("backgroundGlow: 0", script);
        Assert.Contains("mouseStrength: 0.2", script);
        Assert.Contains("window.hstarStartup", script);
        Assert.Contains("prefers-reduced-motion", css);
        Assert.Contains("startup-title", css);
        Assert.Contains("title-mask", html);
    }

    [Fact]
    public void StartupPageUsesStrictLocalContentSecurityPolicy()
    {
        var html = File.ReadAllText(Asset("index.html"));

        Assert.Contains("default-src 'none'", html);
        Assert.Contains("script-src 'self'", html);
        Assert.Contains("style-src 'self'", html);
        Assert.Contains("connect-src 'none'", html);
    }

    [Fact]
    public void StartupPageExposesRetryAndExitOnlyWhenStartupFails()
    {
        var html = File.ReadAllText(Asset("index.html"));
        var css = File.ReadAllText(Asset("startup.css"));
        var script = File.ReadAllText(Asset("startup.js"));

        Assert.Contains("id=\"startup-failure\"", html);
        Assert.Contains("id=\"startup-retry\"", html);
        Assert.Contains("id=\"startup-exit\"", html);
        Assert.Contains("hstar-startup:retry", script);
        Assert.Contains("hstar-startup:exit", script);
        Assert.Contains("showFailure", script);
        Assert.Contains("[hidden]", css);
    }

    private static string Asset(string name)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine(
                directory.FullName,
                "desktop",
                "Hstar.Desktop",
                "Assets",
                "startup",
                name);
            if (File.Exists(candidate))
            {
                return candidate;
            }
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"Startup asset not found: {name}");
    }
}
