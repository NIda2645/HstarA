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
        Assert.Contains("#A6C8FF", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("#5227FF", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("#FF9FFC", script, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("backgroundColor: '#0A29FF'", script);
        Assert.Contains("streakCount: 2", script);
        Assert.Contains("backgroundGlow: 0", script);
        Assert.Contains("mouseStrength: 0.2", script);
        Assert.Contains("window.hstarStartup", script);
        Assert.Contains("hstar-startup:visual-ready", script);
        Assert.Contains("requestAnimationFrame", script);
        Assert.Contains("renderer.render({ scene: mesh });", script);
        Assert.Contains("gl.finish();", script);
        Assert.Contains("onFirstFrame();", script);
        Assert.True(
            script.IndexOf("renderer.render({ scene: mesh });", StringComparison.Ordinal)
            < script.IndexOf("onFirstFrame();", StringComparison.Ordinal));
        Assert.DoesNotContain("setTimeout(markVisualReady, 0)", script);
        Assert.DoesNotContain(
            "requestAnimationFrame(() => postShellMessage('hstar-startup:visual-ready'))",
            script);
        Assert.Contains("background: #000018", css);
        Assert.DoesNotContain("background: #0a29ff", css, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("prefers-reduced-motion", css);
        Assert.Contains("startup-title", css);
        Assert.Contains("animation: title-shiny-sweep 2s linear infinite", css);
        Assert.Contains("class=\"startup-title-art\"", html);
        Assert.Contains("class=\"startup-title-clip-text\"", html);
        Assert.Contains("display: block", css);
        Assert.Contains("width: max-content", css);
        Assert.Contains("#b5b5b5", html);
        Assert.Contains("#ffffff", html);
        Assert.DoesNotContain("title-pulse", css);
        Assert.DoesNotContain("opacity: 0.72", css);
        Assert.DoesNotContain("title-mask", html);
    }

    [Fact]
    public void StartupTitleAndMarkUseOneContinuousLeftToRightShine()
    {
        var html = File.ReadAllText(Asset("index.html"));
        var css = File.ReadAllText(Asset("startup.css"));
        const string animation = "animation: title-shiny-sweep 2s linear infinite";

        Assert.Contains("id=\"startup-title-shape\"", html);
        Assert.Contains("<text class=\"startup-title-clip-text\"", html);
        Assert.Contains("clip-path=\"url(#startup-title-shape)\"", html);
        Assert.Contains("class=\"startup-title-highlight\"", html);
        Assert.Contains("id=\"startup-title-shine\"", html);
        Assert.Contains("x1=\"0%\"", html);
        Assert.Contains("y1=\"0%\"", html);
        Assert.Contains("x2=\"100%\"", html);
        Assert.Contains("y2=\"0%\"", html);
        Assert.DoesNotContain("gradientTransform=", html);
        Assert.DoesNotContain("class=\"startup-label\"", html);
        Assert.DoesNotContain("class=\"startup-mark-highlight\"", html);
        Assert.DoesNotContain("<animate", html);
        Assert.Contains(animation, css);
        Assert.Equal(
            css.IndexOf(animation, StringComparison.Ordinal),
            css.LastIndexOf(animation, StringComparison.Ordinal));
        Assert.Contains("transform-box: fill-box", css);
        Assert.Contains("transform: translateX(150%)", css);
        Assert.DoesNotContain("@keyframes mark-shiny-sweep", css);
        Assert.DoesNotContain("@keyframes shiny-sweep", css);
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
    public void StartupPageIncludesTheApprovedGlassToolbar()
    {
        var html = File.ReadAllText(Asset("index.html"));
        var css = File.ReadAllText(Asset("startup.css"));
        var logo = File.ReadAllText(Asset("hstar-logo.svg"));

        Assert.Contains("class=\"startup-toolbar\"", html);
        Assert.Contains("src=\"hstar-logo.svg\"", html);
        Assert.Contains("<svg", logo, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("viewBox=\"0 0 512 512\"", logo);
        Assert.DoesNotContain("<script", logo, StringComparison.OrdinalIgnoreCase);
        Assert.Contains("Infinite Canvas", html);
        Assert.Contains("创意", html);
        Assert.Contains("想法", html);
        Assert.Contains("无界", html);
        Assert.Contains("width: min(88%, 1120px)", css);
        Assert.Contains("height: 50px", css);
        Assert.Contains("top: 20px", css);
        Assert.Contains("backdrop-filter: blur(18px) saturate(130%)", css);
        Assert.Contains("@media (max-width: 980px)", css);
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
