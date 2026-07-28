using System.IO;
using System.Text;
using System.Text.Json;

namespace Hstar.Desktop.Runtime;

public sealed class ShellValidationOptions
{
    private const string AppDataPrefix = "--validation-appdata-root=";
    private const string PortPrefix = "--validation-port=";
    private const string ReadyFilePrefix = "--validation-ready-file=";
    private DateTimeOffset? _backendHealthyUtc;

    private ShellValidationOptions(
        string? appDataRoot = null,
        int? requiredPort = null,
        string? readyFile = null)
    {
        AppDataRoot = appDataRoot;
        RequiredPort = requiredPort;
        ReadyFile = readyFile;
    }

    public bool IsEnabled => RequiredPort.HasValue;

    public string? AppDataRoot { get; }

    public int? RequiredPort { get; }

    public string? ReadyFile { get; }

    public static ShellValidationOptions Parse(IReadOnlyList<string> arguments)
    {
        string? appDataRoot = null;
        string? portValue = null;
        string? readyFile = null;
        var validationArgumentCount = 0;

        foreach (var argument in arguments)
        {
            if (TryRead(argument, AppDataPrefix, ref appDataRoot)
                || TryRead(argument, PortPrefix, ref portValue)
                || TryRead(argument, ReadyFilePrefix, ref readyFile))
            {
                validationArgumentCount++;
            }
        }

        if (validationArgumentCount == 0)
        {
            return new ShellValidationOptions();
        }
        if (validationArgumentCount != 3
            || string.IsNullOrWhiteSpace(appDataRoot)
            || string.IsNullOrWhiteSpace(portValue)
            || string.IsNullOrWhiteSpace(readyFile))
        {
            throw new ArgumentException("Shell validation requires app-data, port, and ready-file arguments.");
        }
        if (!Path.IsPathFullyQualified(appDataRoot) || !Path.IsPathFullyQualified(readyFile))
        {
            throw new ArgumentException("Shell validation paths must be absolute.");
        }
        if (!int.TryParse(portValue, out var requiredPort)
            || requiredPort is < 1024 or > 65535
            || requiredPort == PortAllocator.PreferredPort)
        {
            throw new ArgumentException("Shell validation requires a non-5000 port from 1024 through 65535.");
        }

        return new ShellValidationOptions(
            Path.GetFullPath(appDataRoot),
            requiredPort,
            Path.GetFullPath(readyFile));
    }

    public void WriteBackendHealthyMarker(string dataRoot, int backendPort)
    {
        if (!IsEnabled)
        {
            return;
        }
        ValidateMarkerInput(backendPort);
        _backendHealthyUtc = DateTimeOffset.UtcNow;
        WriteMarker(dataRoot, backendPort, readyUtc: null);
    }

    public void WriteReadyMarker(string dataRoot, int backendPort)
    {
        if (!IsEnabled)
        {
            return;
        }
        ValidateMarkerInput(backendPort);
        if (!_backendHealthyUtc.HasValue)
        {
            throw new InvalidOperationException("Shell validation backend health was not recorded.");
        }
        WriteMarker(dataRoot, backendPort, DateTimeOffset.UtcNow);
    }

    private void WriteMarker(string dataRoot, int backendPort, DateTimeOffset? readyUtc)
    {
        var readyFile = ReadyFile!;
        var parent = Path.GetDirectoryName(readyFile)
            ?? throw new InvalidOperationException("Shell validation ready-file has no parent directory.");
        Directory.CreateDirectory(parent);
        var temporary = $"{readyFile}.tmp-{Guid.NewGuid():N}";
        var json = JsonSerializer.Serialize(new
        {
            schemaVersion = 1,
            shellProcessId = Environment.ProcessId,
            backendPort,
            dataRoot = Path.GetFullPath(dataRoot),
            backendHealthyUtc = _backendHealthyUtc,
            readyUtc,
        }, new JsonSerializerOptions { WriteIndented = true });

        try
        {
            File.WriteAllText(temporary, json + Environment.NewLine, new UTF8Encoding(false));
            File.Move(temporary, readyFile, overwrite: true);
        }
        finally
        {
            File.Delete(temporary);
        }
    }

    private void ValidateMarkerInput(int backendPort)
    {
        if (backendPort != RequiredPort)
        {
            throw new InvalidOperationException("Shell validation started on an unexpected backend port.");
        }
    }

    private static bool TryRead(string argument, string prefix, ref string? value)
    {
        if (!argument.StartsWith(prefix, StringComparison.Ordinal))
        {
            return false;
        }
        if (value is not null)
        {
            throw new ArgumentException($"Duplicate shell validation argument: {prefix}");
        }
        value = argument[prefix.Length..];
        return true;
    }
}
