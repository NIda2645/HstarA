using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class CanvasThemeTests
{
    [Theory]
    [InlineData("true", true)]
    [InlineData("false", false)]
    [InlineData("null", false)]
    [InlineData("\"true\"", false)]
    [InlineData("invalid", false)]
    public void ParseFallsBackToLightUnlessWebViewReturnsBooleanTrue(
        string json,
        bool expectedDark)
    {
        var expected = expectedDark ? CanvasTheme.Dark : CanvasTheme.Light;
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
