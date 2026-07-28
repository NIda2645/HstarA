using System.Diagnostics;
using System.IO;

namespace Hstar.Desktop.Runtime;

public enum MaintenanceCommand
{
    None = 0,
    Shutdown,
    UpdateApiConfig,
}

public static class MaintenanceMode
{
    public const string ShutdownEventName = @"Local\Hstar.Windows11.Shutdown";

    public static bool TryParse(IReadOnlyList<string> arguments, out MaintenanceCommand command)
    {
        command = MaintenanceCommand.None;
        if (arguments.Count != 1)
        {
            return false;
        }

        command = arguments[0] switch
        {
            "--maintenance=shutdown" => MaintenanceCommand.Shutdown,
            "--maintenance=update-api-config" => MaintenanceCommand.UpdateApiConfig,
            _ => MaintenanceCommand.None,
        };
        return command != MaintenanceCommand.None;
    }

    public static async Task<int?> TryRunAsync(IReadOnlyList<string> arguments)
    {
        if (!TryParse(arguments, out var command))
        {
            return null;
        }

        if (command == MaintenanceCommand.Shutdown)
        {
            SignalShutdown();
            return 0;
        }

        var programRoot = AppPaths.ResolveProgramRoot();
        var appDataRoot = AppPaths.ResolveAppDataRoot();
        var paths = AppPaths.TryLoad(programRoot, appDataRoot);
        if (paths is null)
        {
            return 0;
        }

        return await RunApiUpdateAsync(paths).ConfigureAwait(false);
    }

    public static EventWaitHandle CreateShutdownListener(string eventName = ShutdownEventName)
    {
        return new EventWaitHandle(
            initialState: false,
            EventResetMode.AutoReset,
            ValidateEventName(eventName));
    }

    public static bool SignalShutdown(string eventName = ShutdownEventName)
    {
        try
        {
            using var shutdownEvent = EventWaitHandle.OpenExisting(ValidateEventName(eventName));
            return shutdownEvent.Set();
        }
        catch (WaitHandleCannotBeOpenedException)
        {
            return false;
        }
    }

    public static ProcessStartInfo CreateApiUpdateStartInfo(AppPaths paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(paths.ProgramRoot, "runtime", "python", "python.exe"),
            WorkingDirectory = paths.ProgramRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        foreach (var argument in new[]
        {
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
        })
        {
            startInfo.ArgumentList.Add(argument);
        }
        startInfo.Environment["HSTAR_PROGRAM_DIR"] = paths.ProgramRoot;
        startInfo.Environment["HSTAR_DATA_DIR"] = paths.DataRoot;
        startInfo.Environment["APPDATA"] = paths.AppDataRoot;
        startInfo.Environment["HSTAR_EDITION"] = AppPaths.Windows11Edition;
        startInfo.Environment["PYTHONUTF8"] = "1";
        startInfo.Environment["PYTHONIOENCODING"] = "utf-8";
        startInfo.Environment["PYTHONDONTWRITEBYTECODE"] = "1";
        return startInfo;
    }

    private static async Task<int> RunApiUpdateAsync(AppPaths paths)
    {
        var startInfo = CreateApiUpdateStartInfo(paths);
        if (!File.Exists(startInfo.FileName))
        {
            return 2;
        }

        using var process = new Process { StartInfo = startInfo };
        try
        {
            if (!process.Start())
            {
                return 3;
            }
            var standardOutput = process.StandardOutput.ReadToEndAsync();
            var standardError = process.StandardError.ReadToEndAsync();
            await process.WaitForExitAsync().ConfigureAwait(false);
            await Task.WhenAll(standardOutput, standardError).ConfigureAwait(false);
            return process.ExitCode;
        }
        catch (Exception error) when (error is IOException or InvalidOperationException)
        {
            return 3;
        }
    }

    private static string ValidateEventName(string eventName)
    {
        if (string.IsNullOrWhiteSpace(eventName)
            || !eventName.StartsWith(@"Local\Hstar.Windows11", StringComparison.Ordinal))
        {
            throw new ArgumentException("维护事件名称无效。", nameof(eventName));
        }
        return eventName;
    }
}
