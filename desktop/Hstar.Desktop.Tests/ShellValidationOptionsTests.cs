using System.Text.Json;
using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class ShellValidationOptionsTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"hstar-shell-validation-{Guid.NewGuid():N}");

    [Fact]
    public void NoValidationArgumentsPreserveProductionDefaults()
    {
        var options = ShellValidationOptions.Parse([]);

        Assert.False(options.IsEnabled);
        Assert.Null(options.AppDataRoot);
        Assert.Null(options.RequiredPort);
        Assert.Null(options.ReadyFile);
    }

    [Fact]
    public void ValidationArgumentsRequireAnIsolatedNonProductionProfile()
    {
        var appDataRoot = Path.Combine(_root, "App Data");
        var readyFile = Path.Combine(_root, "状态", "ready.json");

        var options = ShellValidationOptions.Parse([
            $"--validation-appdata-root={appDataRoot}",
            "--validation-port=55123",
            $"--validation-ready-file={readyFile}",
        ]);

        Assert.True(options.IsEnabled);
        Assert.Equal(Path.GetFullPath(appDataRoot), options.AppDataRoot);
        Assert.Equal(55123, options.RequiredPort);
        Assert.Equal(Path.GetFullPath(readyFile), options.ReadyFile);
        Assert.Throws<ArgumentException>(() => ShellValidationOptions.Parse([
            $"--validation-appdata-root={appDataRoot}",
            "--validation-port=5000",
            $"--validation-ready-file={readyFile}",
        ]));
        Assert.Throws<ArgumentException>(() => ShellValidationOptions.Parse([
            $"--validation-appdata-root={appDataRoot}",
        ]));
    }

    [Fact]
    public void ReadyMarkerIsWrittenAtomicallyAfterInteractiveStartup()
    {
        var appDataRoot = Path.Combine(_root, "AppData");
        var readyFile = Path.Combine(_root, "ready", "shell-ready.json");
        var dataRoot = Path.Combine(_root, "用户数据");
        var options = ShellValidationOptions.Parse([
            $"--validation-appdata-root={appDataRoot}",
            "--validation-port=55124",
            $"--validation-ready-file={readyFile}",
        ]);

        options.WriteBackendHealthyMarker(dataRoot, 55124);

        using (var healthDocument = JsonDocument.Parse(File.ReadAllText(readyFile)))
        {
            var healthMarker = healthDocument.RootElement;
            Assert.True(healthMarker.GetProperty("backendHealthyUtc").GetDateTimeOffset() <= DateTimeOffset.UtcNow);
            Assert.Equal(JsonValueKind.Null, healthMarker.GetProperty("readyUtc").ValueKind);
        }

        options.WriteReadyMarker(dataRoot, 55124);

        Assert.True(File.Exists(readyFile));
        Assert.Empty(Directory.GetFiles(Path.GetDirectoryName(readyFile)!, "*.tmp-*"));
        using var document = JsonDocument.Parse(File.ReadAllText(readyFile));
        var marker = document.RootElement;
        Assert.Equal(1, marker.GetProperty("schemaVersion").GetInt32());
        Assert.Equal(Environment.ProcessId, marker.GetProperty("shellProcessId").GetInt32());
        Assert.Equal(55124, marker.GetProperty("backendPort").GetInt32());
        Assert.Equal(Path.GetFullPath(dataRoot), marker.GetProperty("dataRoot").GetString());
        Assert.True(marker.GetProperty("backendHealthyUtc").GetDateTimeOffset() <= DateTimeOffset.UtcNow);
        Assert.True(marker.GetProperty("readyUtc").GetDateTimeOffset() <= DateTimeOffset.UtcNow);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
