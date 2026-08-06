using System.Text.Json;
using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class WebViewConfigurationTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"hstar-webview-tests-{Guid.NewGuid():N}");

    [Fact]
    public void RuntimeAndProfileStayInTheirOwnedRoots()
    {
        var paths = CreatePaths();
        var configuration = WebViewConfiguration.Create(
            paths,
            new Uri("http://127.0.0.1:5007/"),
            new string('A', 64));

        Assert.Equal(
            Path.Combine(paths.ProgramRoot, "runtime", "browser", "WebView2"),
            configuration.BrowserExecutableFolder);
        Assert.Equal(
            Path.Combine(paths.DataRoot, "cache", "webview2"),
            configuration.UserDataFolder);
        Assert.Equal("http", configuration.StartUri.Scheme);
        Assert.Equal("127.0.0.1", configuration.StartUri.Host);
        Assert.Equal(5007, configuration.StartUri.Port);
        Assert.Equal(new string('A', 64), GetQueryValue(configuration.StartUri, "hstar_shell_token"));
    }

    [Fact]
    public void TopLevelNavigationIsRestrictedToTheBackendOrigin()
    {
        var configuration = CreateConfiguration();

        Assert.True(configuration.IsAllowedNavigation(new Uri("http://127.0.0.1:5007/")));
        Assert.True(configuration.IsAllowedNavigation(new Uri("http://127.0.0.1:5007/static/index.html")));
        Assert.False(configuration.IsAllowedNavigation(new Uri("http://127.0.0.1:5008/")));
        Assert.False(configuration.IsAllowedNavigation(new Uri("http://localhost:5007/")));
        Assert.False(configuration.IsAllowedNavigation(new Uri("https://example.com/")));
        Assert.False(configuration.IsAllowedNavigation(new Uri("file:///C:/Windows/System32/notepad.exe")));
    }

    [Fact]
    public void PopupsUseSameViewOrExternalBrowserPolicyAndNeverCreateWebViews()
    {
        var configuration = CreateConfiguration();

        Assert.Equal(
            WebPopupDisposition.NavigateSameView,
            configuration.ClassifyPopup(new Uri("http://127.0.0.1:5007/static/index.html")));
        Assert.Equal(
            WebPopupDisposition.OpenExternalBrowser,
            configuration.ClassifyPopup(new Uri("https://www.modelscope.cn/models/FunAudioLLM/Fun-ASR-Nano-2512")));
        Assert.Equal(
            WebPopupDisposition.Deny,
            configuration.ClassifyPopup(new Uri("http://127.0.0.1:5008/")));
        Assert.Equal(
            WebPopupDisposition.Deny,
            configuration.ClassifyPopup(new Uri("file:///C:/Windows/System32/notepad.exe")));
        Assert.Equal(
            WebPopupDisposition.Deny,
            configuration.ClassifyPopup(new Uri("javascript:alert(1)")));
    }

    [Fact]
    public async Task ValidStorageRestartMessageInvokesControlledRestart()
    {
        var paths = CreatePaths();
        var configuration = CreateConfiguration(paths);
        var requests = new List<string>();
        var router = new WebViewMessageRouter(
            configuration,
            (dataRoot, _) =>
            {
                requests.Add(dataRoot);
                return Task.CompletedTask;
            });
        var target = Path.Combine(_root, "新的数据目录");
        var json = JsonSerializer.Serialize(new
        {
            type = "hstar:restart-with-data-root",
            schemaVersion = 1,
            dataRoot = target,
        });

        var handled = await router.TryHandleAsync(
            "http://127.0.0.1:5007/settings",
            json);

        Assert.True(handled);
        Assert.Equal([Path.GetFullPath(target)], requests);
    }

    [Fact]
    public async Task StorageRestartRejectsForeignOriginsAndUnsafeDataRoots()
    {
        var paths = CreatePaths();
        var configuration = CreateConfiguration(paths);
        var restartCount = 0;
        var router = new WebViewMessageRouter(
            configuration,
            (_, _) =>
            {
                restartCount += 1;
                return Task.CompletedTask;
            });
        var validMessage = JsonSerializer.Serialize(new
        {
            type = "hstar:restart-with-data-root",
            schemaVersion = 1,
            dataRoot = Path.Combine(_root, "Data2"),
        });
        var unsafeMessage = JsonSerializer.Serialize(new
        {
            type = "hstar:restart-with-data-root",
            schemaVersion = 1,
            dataRoot = Path.Combine(paths.ProgramRoot, "data"),
        });
        var unsupportedSchema = JsonSerializer.Serialize(new
        {
            type = "hstar:restart-with-data-root",
            schemaVersion = 2,
            dataRoot = Path.Combine(_root, "Data2"),
        });

        Assert.False(await router.TryHandleAsync("https://example.com/", validMessage));
        Assert.False(await router.TryHandleAsync("http://127.0.0.1:5007/", unsafeMessage));
        Assert.False(await router.TryHandleAsync("http://127.0.0.1:5007/", unsupportedSchema));
        Assert.False(await router.TryHandleAsync("http://127.0.0.1:5007/", "{not-json"));
        Assert.Equal(0, restartCount);
    }

    [Fact]
    public async Task InteractiveMessageRequiresCurrentNavigationSchemaAndOrigin()
    {
        var configuration = CreateConfiguration(navigationId: "nav-current");
        var accepted = new List<string>();
        var router = new WebViewMessageRouter(
            configuration,
            (_, _) => Task.CompletedTask,
            (navigationId, _) =>
            {
                accepted.Add(navigationId);
                return Task.CompletedTask;
            });
        string Message(string navigationId, int schemaVersion) => JsonSerializer.Serialize(new
        {
            type = "hstar:interactive",
            schemaVersion,
            navigationId,
        });

        Assert.False(await router.TryHandleAsync(
            "https://example.com/",
            Message("nav-current", 1)));
        Assert.False(await router.TryHandleAsync(
            "http://127.0.0.1:5007/",
            Message("nav-old", 1)));
        Assert.False(await router.TryHandleAsync(
            "http://127.0.0.1:5007/",
            Message("nav-current", 2)));
        Assert.True(await router.TryHandleAsync(
            "http://127.0.0.1:5007/",
            Message("nav-current", 1)));

        Assert.Equal(["nav-current"], accepted);
    }

    [Fact]
    public async Task DownloadBatchMessageRequiresPlainFileNamesAndTheCurrentOrigin()
    {
        var configuration = CreateConfiguration();
        var accepted = new List<DownloadBatchRequest>();
        var router = new WebViewMessageRouter(
            configuration,
            (_, _) => Task.CompletedTask,
            (_, _) => Task.CompletedTask,
            (request, _) =>
            {
                accepted.Add(request);
                return Task.CompletedTask;
            });
        string Message(params string[] fileNames) => JsonSerializer.Serialize(new
        {
            type = "hstar:download-batch",
            schemaVersion = 1,
            requestId = Guid.NewGuid(),
            fileNames,
        });

        Assert.True(await router.TryHandleAsync(
            "http://127.0.0.1:5007/static/canvas.html",
            Message("第一张.png", "second.webp")));
        Assert.False(await router.TryHandleAsync(
            "https://example.com/",
            Message("foreign.png")));
        Assert.False(await router.TryHandleAsync(
            "http://127.0.0.1:5007/",
            Message("..")));
        Assert.False(await router.TryHandleAsync(
            "http://127.0.0.1:5007/",
            Message("folder/escape.png")));

        Assert.Single(accepted);
        Assert.Equal(["第一张.png", "second.webp"], accepted[0].FileNames);
    }

    [Fact]
    public void MultipleAutomaticDownloadsRequireAPendingBatchFromTheCurrentBackendOrigin()
    {
        var configuration = CreateConfiguration();

        Assert.True(WebViewDownloadPermissionPolicy.ShouldAllow(
            new Uri("http://127.0.0.1:5007/static/canvas.html"),
            configuration,
            hasPendingBatch: true));
        Assert.False(WebViewDownloadPermissionPolicy.ShouldAllow(
            new Uri("http://127.0.0.1:5007/static/canvas.html"),
            configuration,
            hasPendingBatch: false));
        Assert.False(WebViewDownloadPermissionPolicy.ShouldAllow(
            new Uri("http://127.0.0.1:5008/static/canvas.html"),
            configuration,
            hasPendingBatch: true));
        Assert.False(WebViewDownloadPermissionPolicy.ShouldAllow(
            new Uri("https://example.com/download"),
            configuration,
            hasPendingBatch: true));
    }

    [Fact]
    public void MicrophonePermissionAllowsEveryLoopbackHstarOrigin()
    {
        var configuration = CreateConfiguration();

        Assert.True(WebViewMicrophonePermissionPolicy.ShouldAllow(
            new Uri("http://127.0.0.1:5007/static/canvas.html"),
            configuration));
        Assert.True(WebViewMicrophonePermissionPolicy.ShouldAllow(
            new Uri("http://127.0.0.1:5008/static/canvas.html"),
            configuration));
        Assert.True(WebViewMicrophonePermissionPolicy.ShouldAllow(
            new Uri("http://localhost:5007/static/canvas.html"),
            configuration));
        Assert.False(WebViewMicrophonePermissionPolicy.ShouldAllow(
            new Uri("https://example.com/voice"),
            configuration));
        Assert.False(WebViewMicrophonePermissionPolicy.ShouldAllow(
            null,
            configuration));
    }

    [Fact]
    public void RestartPathsMustMatchThePersistedMigrationResult()
    {
        var current = CreatePaths();
        var migratedRoot = Path.Combine(_root, "MigratedData");
        var migrated = AppPaths.Create(
            current.ProgramRoot,
            migratedRoot,
            current.AppDataRoot);
        migrated.SaveBootstrap(previousDataRoot: current.DataRoot);

        var loaded = StartupCoordinator.LoadRestartPaths(current, migratedRoot);

        Assert.Equal(Path.GetFullPath(migratedRoot), loaded.DataRoot);
        Assert.Throws<InvalidOperationException>(() =>
            StartupCoordinator.LoadRestartPaths(current, Path.Combine(_root, "OtherData")));
    }

    private WebViewConfiguration CreateConfiguration(
        AppPaths? paths = null,
        string navigationId = "nav-test") =>
        WebViewConfiguration.Create(
            paths ?? CreatePaths(),
            new Uri("http://127.0.0.1:5007/"),
            new string('A', 64),
            navigationId);

    private AppPaths CreatePaths() => AppPaths.Create(
        Path.Combine(_root, "Program"),
        Path.Combine(_root, "Data"),
        Path.Combine(_root, "AppData"));

    private static string? GetQueryValue(Uri uri, string key)
    {
        foreach (var part in uri.Query.TrimStart('?').Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var pair = part.Split('=', 2);
            if (Uri.UnescapeDataString(pair[0]) == key)
            {
                return pair.Length == 2 ? Uri.UnescapeDataString(pair[1]) : string.Empty;
            }
        }
        return null;
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
