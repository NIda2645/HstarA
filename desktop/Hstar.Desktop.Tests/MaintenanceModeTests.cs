using System.Diagnostics;
using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class MaintenanceModeTests
{
    [Theory]
    [InlineData("--maintenance=shutdown", MaintenanceCommand.Shutdown)]
    [InlineData("--maintenance=update-api-config", MaintenanceCommand.UpdateApiConfig)]
    public void ParsesOnlyExplicitMaintenanceCommands(string argument, MaintenanceCommand expected)
    {
        Assert.True(MaintenanceMode.TryParse([argument], out var command));
        Assert.Equal(expected, command);
        Assert.False(MaintenanceMode.TryParse([], out _));
        Assert.False(MaintenanceMode.TryParse([argument, "extra"], out _));
        Assert.False(MaintenanceMode.TryParse(["--maintenance=unknown"], out _));
    }

    [Fact]
    public void ApiUpdateUsesHiddenPackagedPythonAndExplicitDataRoots()
    {
        var root = Path.Combine(Path.GetTempPath(), $"hstar-maintenance-{Guid.NewGuid():N}");
        var paths = AppPaths.Create(
            Path.Combine(root, "Program"),
            Path.Combine(root, "Data"),
            Path.Combine(root, "AppData"));

        var startInfo = MaintenanceMode.CreateApiUpdateStartInfo(paths);

        Assert.Equal(Path.Combine(paths.ProgramRoot, "runtime", "python", "python.exe"), startInfo.FileName);
        Assert.Equal(paths.ProgramRoot, startInfo.WorkingDirectory);
        Assert.False(startInfo.UseShellExecute);
        Assert.True(startInfo.CreateNoWindow);
        Assert.True(startInfo.RedirectStandardOutput);
        Assert.True(startInfo.RedirectStandardError);
        Assert.Equal(ProcessWindowStyle.Hidden, startInfo.WindowStyle);
        Assert.Equal(
            [
                "-I",
                "-B",
                "-m",
                "hstar_runtime.maintenance",
                "update-api-config",
                "--program-root",
                paths.ProgramRoot,
                "--data-root",
                paths.DataRoot,
                "--edition",
                AppPaths.Windows11Edition,
            ],
            startInfo.ArgumentList);
        Assert.Equal(paths.ProgramRoot, startInfo.Environment["HSTAR_PROGRAM_DIR"]);
        Assert.Equal(paths.DataRoot, startInfo.Environment["HSTAR_DATA_DIR"]);
        Assert.Equal(paths.AppDataRoot, startInfo.Environment["APPDATA"]);
        Assert.Equal(AppPaths.Windows11Edition, startInfo.Environment["HSTAR_EDITION"]);
        Assert.Equal("1", startInfo.Environment["PYTHONUTF8"]);
        Assert.Equal("utf-8", startInfo.Environment["PYTHONIOENCODING"]);
    }

    [Fact]
    public void ShutdownSignalTargetsOnlyTheNamedEditionEvent()
    {
        var eventName = $@"Local\Hstar.Windows11.Tests.{Guid.NewGuid():N}";
        using var listener = MaintenanceMode.CreateShutdownListener(eventName);

        Assert.True(MaintenanceMode.SignalShutdown(eventName));
        Assert.True(listener.WaitOne(TimeSpan.FromSeconds(1)));
    }
}
