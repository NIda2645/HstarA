using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class EmbeddedStartupRuntimeTests
{
    public static TheoryData<string, string> ApprovedAssets => new()
    {
        { "index.html", "text/html; charset=utf-8" },
        { "startup.css", "text/css; charset=utf-8" },
        { "startup.js", "text/javascript; charset=utf-8" },
        { "ogl.mjs", "text/javascript; charset=utf-8" },
        { "ogl.LICENSE.txt", "text/plain; charset=utf-8" },
    };

    [Theory]
    [MemberData(nameof(ApprovedAssets))]
    public void ApprovedAssetsOpenFromTheDesktopAssembly(string path, string contentType)
    {
        var runtime = EmbeddedStartupRuntime.CreateApplicationRuntime();

        Assert.True(runtime.TryOpen(StartupUri(path), out var asset));
        Assert.NotNull(asset);
        Assert.Equal(contentType, asset.ContentType);
        Assert.True(asset.Content.CanRead);
        Assert.True(asset.Content.Length > 0);
        asset.Content.Dispose();
    }

    [Fact]
    public void ApplicationRuntimeContainsEveryRequiredResource()
    {
        var runtime = EmbeddedStartupRuntime.CreateApplicationRuntime();

        runtime.ValidateResources();
    }

    [Theory]
    [InlineData("http://hstar-startup.local/index.html")]
    [InlineData("https://example.invalid/index.html")]
    [InlineData("https://hstar-startup.local:444/index.html")]
    [InlineData("https://hstar-startup.local/INDEX.html")]
    [InlineData("https://hstar-startup.local/missing.js")]
    [InlineData("https://hstar-startup.local/../index.html")]
    [InlineData("https://hstar-startup.local/%2e%2e/index.html")]
    [InlineData("https://hstar-startup.local/%2findex.html")]
    [InlineData("https://hstar-startup.local/%5cindex.html")]
    [InlineData("https://hstar-startup.local/index.html?resource=startup.js")]
    [InlineData("https://hstar-startup.local/index.html#startup.js")]
    public void UnapprovedRequestsAreRejected(string uri)
    {
        var runtime = EmbeddedStartupRuntime.CreateApplicationRuntime();

        Assert.False(runtime.TryOpen(new Uri(uri, UriKind.Absolute), out var asset));
        Assert.Null(asset);
    }

    private static Uri StartupUri(string path) =>
        new($"https://hstar-startup.local/{path}", UriKind.Absolute);
}
