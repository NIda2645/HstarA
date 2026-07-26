using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Net.Http;
using System.Security.Cryptography;
using System.Text;

namespace Hstar.Desktop.Runtime;

public sealed class BackendProcess : IAsyncDisposable
{
    public const string ShellTokenHeader = "X-Hstar-Shell-Token";
    private const long DefaultLogLimit = 8L * 1024 * 1024;
    private const int DefaultLogBackups = 2;

    private readonly object _logLock = new();
    private readonly HttpClient _client;
    private Process? _process;
    private StreamWriter? _outputLog;
    private StreamWriter? _errorLog;

    public BackendProcess(AppPaths paths, int port, string? shellToken = null)
    {
        Paths = paths;
        Port = port;
        ShellToken = string.IsNullOrWhiteSpace(shellToken) ? CreateShellToken() : shellToken;
        BaseUri = new Uri($"http://127.0.0.1:{port}/", UriKind.Absolute);
        _client = new HttpClient
        {
            BaseAddress = BaseUri,
            Timeout = TimeSpan.FromSeconds(10),
        };
    }

    public AppPaths Paths { get; }

    public int Port { get; }

    public string ShellToken { get; }

    public Uri BaseUri { get; }

    public bool IsRunning => _process is { HasExited: false };

    public static string CreateShellToken() => Convert.ToHexString(RandomNumberGenerator.GetBytes(32));

    public static ProcessStartInfo CreateStartInfo(AppPaths paths, int port, string shellToken)
    {
        if (port is < 1 or > 65535)
        {
            throw new ArgumentOutOfRangeException(nameof(port));
        }
        if (string.IsNullOrWhiteSpace(shellToken))
        {
            throw new ArgumentException("Shell token 不能为空。", nameof(shellToken));
        }

        var startInfo = new ProcessStartInfo
        {
            FileName = Path.Combine(paths.ProgramRoot, "runtime", "python", "pythonw.exe"),
            WorkingDirectory = paths.ProgramRoot,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            WindowStyle = ProcessWindowStyle.Hidden,
        };
        startInfo.ArgumentList.Add(Path.Combine("app", "main.py"));
        startInfo.Environment["HSTAR_PROGRAM_DIR"] = paths.ProgramRoot;
        startInfo.Environment["HSTAR_DATA_DIR"] = paths.DataRoot;
        startInfo.Environment["HSTAR_EDITION"] = AppPaths.Windows11Edition;
        startInfo.Environment["HSTAR_HOST"] = "127.0.0.1";
        startInfo.Environment["HSTAR_PORT"] = port.ToString(CultureInfo.InvariantCulture);
        startInfo.Environment["HSTAR_SHELL_TOKEN"] = shellToken;
        startInfo.Environment["PYTHONUTF8"] = "1";
        startInfo.Environment["PYTHONIOENCODING"] = "utf-8";
        startInfo.Environment["PYTHONUNBUFFERED"] = "1";
        return startInfo;
    }

    public void Start()
    {
        if (_process is not null)
        {
            throw new InvalidOperationException("Hstar 后端进程已经启动。");
        }

        Paths.EnsureDataDirectories();
        var startInfo = CreateStartInfo(Paths, Port, ShellToken);
        if (!File.Exists(startInfo.FileName))
        {
            throw new FileNotFoundException("Hstar 内置 Python 运行时不存在。", startInfo.FileName);
        }
        var mainScript = Path.Combine(Paths.ProgramRoot, "app", "main.py");
        if (!File.Exists(mainScript))
        {
            throw new FileNotFoundException("Hstar 后端程序不存在。", mainScript);
        }

        var outputLogPath = Path.Combine(Paths.LogRoot, "backend.log");
        var errorLogPath = Path.Combine(Paths.LogRoot, "backend-error.log");
        RotateLog(outputLogPath, DefaultLogLimit, DefaultLogBackups);
        RotateLog(errorLogPath, DefaultLogLimit, DefaultLogBackups);
        _outputLog = OpenLog(outputLogPath);
        _errorLog = OpenLog(errorLogPath);

        var process = new Process
        {
            StartInfo = startInfo,
            EnableRaisingEvents = true,
        };
        process.OutputDataReceived += (_, eventArgs) => WriteLog(_outputLog, eventArgs.Data);
        process.ErrorDataReceived += (_, eventArgs) => WriteLog(_errorLog, eventArgs.Data);
        try
        {
            if (!process.Start())
            {
                throw new InvalidOperationException("Hstar 后端进程未能启动。");
            }
            _process = process;
            process.BeginOutputReadLine();
            process.BeginErrorReadLine();
        }
        catch
        {
            process.Dispose();
            CloseLogs();
            throw;
        }
    }

    public async Task WaitUntilHealthyAsync(
        TimeSpan timeout,
        CancellationToken cancellationToken = default)
    {
        var deadline = DateTimeOffset.UtcNow + timeout;
        Exception? lastError = null;
        while (DateTimeOffset.UtcNow < deadline)
        {
            cancellationToken.ThrowIfCancellationRequested();
            if (_process is { HasExited: true })
            {
                throw new InvalidOperationException(
                    $"Hstar 后端提前退出，退出代码 {_process.ExitCode}。请查看 backend-error.log。");
            }

            try
            {
                using var request = CreateAuthorizedRequest(HttpMethod.Get, "api/health");
                using var response = await _client.SendAsync(request, cancellationToken);
                if (response.IsSuccessStatusCode)
                {
                    return;
                }
                lastError = new HttpRequestException($"健康检查返回 HTTP {(int)response.StatusCode}。");
            }
            catch (Exception error) when (error is HttpRequestException or TaskCanceledException)
            {
                lastError = error;
            }

            await Task.Delay(150, cancellationToken);
        }

        throw new TimeoutException(
            $"Hstar 后端在 {timeout.TotalSeconds:0} 秒内未就绪。",
            lastError);
    }

    public async Task<HttpResponseMessage> SendAuthorizedAsync(
        HttpRequestMessage request,
        CancellationToken cancellationToken = default)
    {
        request.Headers.Remove(ShellTokenHeader);
        request.Headers.TryAddWithoutValidation(ShellTokenHeader, ShellToken);
        return await _client.SendAsync(request, cancellationToken);
    }

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        var process = _process;
        if (process is null)
        {
            CloseLogs();
            return;
        }

        if (!process.HasExited)
        {
            try
            {
                using var request = CreateAuthorizedRequest(HttpMethod.Post, "api/shell/shutdown");
                using var response = await _client.SendAsync(request, cancellationToken);
            }
            catch (Exception error) when (error is HttpRequestException
                or TaskCanceledException
                or InvalidOperationException)
            {
            }

            using var gracefulTimeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
            gracefulTimeout.CancelAfter(TimeSpan.FromSeconds(5));
            try
            {
                await process.WaitForExitAsync(gracefulTimeout.Token);
            }
            catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
            {
                if (!process.HasExited)
                {
                    process.Kill(entireProcessTree: true);
                    await process.WaitForExitAsync(CancellationToken.None);
                }
            }
        }

        process.Dispose();
        _process = null;
        CloseLogs();
    }

    public static void RotateLog(string path, long maxBytes, int backupCount)
    {
        if (maxBytes <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxBytes));
        }
        if (backupCount < 1)
        {
            throw new ArgumentOutOfRangeException(nameof(backupCount));
        }
        if (!File.Exists(path) || new FileInfo(path).Length <= maxBytes)
        {
            return;
        }

        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        File.Delete($"{path}.{backupCount}");
        for (var index = backupCount - 1; index >= 1; index--)
        {
            var source = $"{path}.{index}";
            if (File.Exists(source))
            {
                File.Move(source, $"{path}.{index + 1}", overwrite: true);
            }
        }
        File.Move(path, $"{path}.1", overwrite: true);
    }

    public async ValueTask DisposeAsync()
    {
        await StopAsync(CancellationToken.None);
        _client.Dispose();
    }

    private HttpRequestMessage CreateAuthorizedRequest(HttpMethod method, string relativeUri)
    {
        var request = new HttpRequestMessage(method, relativeUri);
        request.Headers.TryAddWithoutValidation(ShellTokenHeader, ShellToken);
        return request;
    }

    private static StreamWriter OpenLog(string path)
    {
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        return new StreamWriter(
            new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite),
            new UTF8Encoding(encoderShouldEmitUTF8Identifier: false))
        {
            AutoFlush = true,
        };
    }

    private void WriteLog(StreamWriter? writer, string? message)
    {
        if (writer is null || message is null)
        {
            return;
        }
        lock (_logLock)
        {
            writer.WriteLine($"[{DateTimeOffset.Now:yyyy-MM-dd HH:mm:ss.fff zzz}] {message}");
        }
    }

    private void CloseLogs()
    {
        lock (_logLock)
        {
            _outputLog?.Dispose();
            _errorLog?.Dispose();
            _outputLog = null;
            _errorLog = null;
        }
    }
}
