using System.Diagnostics;
using System.Net;
using System.Net.Sockets;
using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class BackendProcessTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"hstar-backend-tests-{Guid.NewGuid():N}");

    [Fact]
    public void ProcessContractUsesPythonwWithoutShellOrConsole()
    {
        var paths = CreatePaths();
        const int port = 5007;
        const string token = "0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF0123456789ABCDEF";

        var startInfo = BackendProcess.CreateStartInfo(paths, port, token);

        Assert.Equal(Path.Combine(paths.ProgramRoot, "runtime", "python", "pythonw.exe"), startInfo.FileName);
        Assert.Equal(paths.ProgramRoot, startInfo.WorkingDirectory);
        Assert.False(startInfo.UseShellExecute);
        Assert.True(startInfo.CreateNoWindow);
        Assert.True(startInfo.RedirectStandardOutput);
        Assert.True(startInfo.RedirectStandardError);
        Assert.Equal(ProcessWindowStyle.Hidden, startInfo.WindowStyle);
        Assert.Equal([Path.Combine("app", "main.py")], startInfo.ArgumentList);
        Assert.Equal(paths.ProgramRoot, startInfo.Environment["HSTAR_PROGRAM_DIR"]);
        Assert.Equal(paths.DataRoot, startInfo.Environment["HSTAR_DATA_DIR"]);
        Assert.Equal(paths.AppDataRoot, startInfo.Environment["APPDATA"]);
        Assert.Equal("windows11", startInfo.Environment["HSTAR_EDITION"]);
        Assert.Equal("127.0.0.1", startInfo.Environment["HSTAR_HOST"]);
        Assert.Equal(port.ToString(), startInfo.Environment["HSTAR_PORT"]);
        Assert.Equal(token, startInfo.Environment["HSTAR_SHELL_TOKEN"]);
        Assert.Equal("1", startInfo.Environment["PYTHONUTF8"]);
        Assert.Equal("utf-8", startInfo.Environment["PYTHONIOENCODING"]);
        Assert.Equal("1", startInfo.Environment["PYTHONDONTWRITEBYTECODE"]);
    }

    [Fact]
    public void ShellTokenIsRandomUppercaseHexWithThirtyTwoBytes()
    {
        var first = BackendProcess.CreateShellToken();
        var second = BackendProcess.CreateShellToken();

        Assert.Matches("^[0-9A-F]{64}$", first);
        Assert.Matches("^[0-9A-F]{64}$", second);
        Assert.NotEqual(first, second);
    }

    [Fact]
    public void PortAllocatorSkipsBusyPreferredPortAndKeepsSelectionReserved()
    {
        TcpListener? occupied = null;
        try
        {
            occupied = new TcpListener(IPAddress.Loopback, PortAllocator.PreferredPort);
            occupied.Server.ExclusiveAddressUse = true;
            occupied.Start();
        }
        catch (SocketException)
        {
            occupied?.Dispose();
            occupied = null;
        }

        try
        {
            using var reservation = PortAllocator.Reserve();

            Assert.InRange(
                reservation.SelectedPort,
                PortAllocator.PreferredPort + 1,
                PortAllocator.LastFallbackPort);
            using var conflict = new TcpListener(IPAddress.Loopback, reservation.SelectedPort);
            conflict.Server.ExclusiveAddressUse = true;
            Assert.ThrowsAny<SocketException>(() => conflict.Start());
        }
        finally
        {
            occupied?.Dispose();
        }
    }

    [Fact]
    public void PortAllocatorReservesOnlyTheRequiredValidationPort()
    {
        using var candidate = new TcpListener(IPAddress.Loopback, 0);
        candidate.Start();
        var port = ((IPEndPoint)candidate.LocalEndpoint).Port;
        candidate.Stop();

        using var reservation = PortAllocator.Reserve(port);

        Assert.Equal(port, reservation.SelectedPort);
        using var conflict = new TcpListener(IPAddress.Loopback, port);
        conflict.Server.ExclusiveAddressUse = true;
        Assert.ThrowsAny<SocketException>(() => conflict.Start());
    }

    [Fact]
    public void RotatingLogKeepsTwoBoundedBackups()
    {
        var logPath = Path.Combine(_root, "logs", "backend.log");
        Directory.CreateDirectory(Path.GetDirectoryName(logPath)!);
        File.WriteAllText(logPath, new string('x', 64));
        File.WriteAllText(logPath + ".1", "older");

        BackendProcess.RotateLog(logPath, maxBytes: 32, backupCount: 2);

        Assert.False(File.Exists(logPath));
        Assert.Equal(64, new FileInfo(logPath + ".1").Length);
        Assert.Equal("older", File.ReadAllText(logPath + ".2"));
    }

    private AppPaths CreatePaths()
    {
        var programRoot = Path.Combine(_root, "Program");
        var dataRoot = Path.Combine(_root, "Data");
        return AppPaths.Create(programRoot, dataRoot, Path.Combine(_root, "AppData"));
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
