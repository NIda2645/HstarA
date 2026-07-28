using System.Text.Json;
using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class AppPathsTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"hstar-desktop-tests-{Guid.NewGuid():N}");

    [Fact]
    public void DefaultDataRootPrefersEDrive()
    {
        var documents = Path.Combine(_root, "Documents");

        var selected = AppPaths.SelectDefaultDataRoot(
            drive => drive == @"E:\",
            documents);

        Assert.Equal(Path.GetFullPath(@"E:\Hstar缓存"), selected);
    }

    [Fact]
    public void DefaultDataRootFallsBackToDocuments()
    {
        var documents = Path.Combine(_root, "用户文档");

        var selected = AppPaths.SelectDefaultDataRoot(_ => false, documents);

        Assert.Equal(Path.GetFullPath(Path.Combine(documents, "Hstar缓存")), selected);
    }

    [Fact]
    public void BootstrapPathsAreIsolatedByEdition()
    {
        var appData = Path.Combine(_root, "AppData");

        var windows11 = AppPaths.GetBootstrapPath(appData, AppPaths.Windows11Edition);
        var classic = AppPaths.GetBootstrapPath(appData, "classic");

        Assert.NotEqual(windows11, classic);
        Assert.Equal(
            Path.Combine(appData, "Hstar", "windows11", "bootstrap.json"),
            windows11);
    }

    [Fact]
    public void DataRootInsideProgramRootIsRejected()
    {
        var programRoot = Path.Combine(_root, "Program");
        var invalidDataRoot = Path.Combine(programRoot, "data");

        var error = Assert.Throws<ArgumentException>(() => AppPaths.Create(
            programRoot,
            invalidDataRoot,
            Path.Combine(_root, "AppData")));

        Assert.Contains("程序目录", error.Message);
    }

    [Fact]
    public void BootstrapRoundTripsUnicodePathsAndExactSchema()
    {
        var programRoot = Path.Combine(_root, "程序", "Hstar");
        var dataRoot = Path.Combine(_root, "用户数据", "Hstar缓存");
        var appData = Path.Combine(_root, "漫游数据");
        var paths = AppPaths.Create(programRoot, dataRoot, appData);

        paths.SaveBootstrap(lastStartedVersion: "2026.07.26");

        var loaded = AppPaths.TryLoad(programRoot, appData);
        Assert.NotNull(loaded);
        Assert.Equal(Path.GetFullPath(dataRoot), loaded.DataRoot);
        Assert.Equal(Path.Combine(Path.GetFullPath(dataRoot), "cache", "webview2"), loaded.WebViewCacheRoot);

        using var document = JsonDocument.Parse(File.ReadAllText(paths.BootstrapPath));
        var root = document.RootElement;
        Assert.Equal(1, root.GetProperty("schemaVersion").GetInt32());
        Assert.Equal("windows11", root.GetProperty("edition").GetString());
        Assert.Equal(Path.GetFullPath(dataRoot), root.GetProperty("dataRoot").GetString());
        Assert.Equal("2026.07.26", root.GetProperty("lastStartedVersion").GetString());
        var migration = root.GetProperty("migration");
        Assert.Equal(string.Empty, migration.GetProperty("id").GetString());
        Assert.Equal(string.Empty, migration.GetProperty("status").GetString());
        Assert.Equal(string.Empty, migration.GetProperty("previousDataRoot").GetString());
    }

    [Fact]
    public void WrongEditionBootstrapIsRejectedWithoutReadingAnotherEdition()
    {
        var programRoot = Path.Combine(_root, "Program");
        var appData = Path.Combine(_root, "AppData");
        var bootstrapPath = AppPaths.GetBootstrapPath(appData, AppPaths.Windows11Edition);
        Directory.CreateDirectory(Path.GetDirectoryName(bootstrapPath)!);
        File.WriteAllText(bootstrapPath, """
            {
              "schemaVersion": 1,
              "edition": "classic",
              "dataRoot": "D:\\HstarData",
              "lastStartedVersion": "",
              "migration": { "id": "", "status": "", "previousDataRoot": "" }
            }
            """);

        Assert.Null(AppPaths.TryLoad(programRoot, appData));
        Assert.False(File.Exists(bootstrapPath));
        Assert.Single(Directory.GetFiles(
            Path.GetDirectoryName(bootstrapPath)!,
            "bootstrap.json.corrupt-*"));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
