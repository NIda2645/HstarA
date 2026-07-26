using System.IO;
using System.Net.Http;
using System.Net.Http.Json;
using System.Text.Json;

namespace Hstar.Desktop.Runtime;

public sealed record BackendSession(
    AppPaths Paths,
    BackendProcess Backend,
    Uri BaseUri,
    string ShellToken);

public sealed class StartupCoordinator : IAsyncDisposable
{
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private bool _disposed;

    public BackendSession? Current { get; private set; }

    public async Task<BackendSession> StartAsync(
        AppPaths paths,
        string pendingMigrationTarget = "",
        CancellationToken cancellationToken = default)
    {
        await _lifecycle.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            if (Current is not null)
            {
                throw new InvalidOperationException("Hstar 后端已经由当前外壳启动。");
            }

            var session = await StartBackendAsync(paths, cancellationToken).ConfigureAwait(false);
            try
            {
                if (!string.IsNullOrWhiteSpace(pendingMigrationTarget))
                {
                    await MigrateDataAsync(session.Backend, pendingMigrationTarget, cancellationToken).ConfigureAwait(false);
                    await session.Backend.DisposeAsync().ConfigureAwait(false);
                    var migratedPaths = LoadRestartPaths(paths, pendingMigrationTarget);
                    session = await StartBackendAsync(migratedPaths, cancellationToken).ConfigureAwait(false);
                }

                Current = session;
                return session;
            }
            catch
            {
                await session.Backend.DisposeAsync().ConfigureAwait(false);
                throw;
            }
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    public async Task<BackendSession> RestartAfterMigrationAsync(
        string expectedDataRoot,
        CancellationToken cancellationToken = default)
    {
        await _lifecycle.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            var previous = Current
                ?? throw new InvalidOperationException("Hstar 后端尚未启动，无法切换数据目录。");
            var migratedPaths = LoadRestartPaths(previous.Paths, expectedDataRoot);
            Current = null;
            await previous.Backend.DisposeAsync().ConfigureAwait(false);
            var replacement = await StartBackendAsync(migratedPaths, cancellationToken).ConfigureAwait(false);
            Current = replacement;
            return replacement;
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    public static AppPaths LoadRestartPaths(AppPaths current, string expectedDataRoot)
    {
        ArgumentNullException.ThrowIfNull(current);
        if (!Path.IsPathFullyQualified(expectedDataRoot))
        {
            throw new InvalidOperationException("新的 Hstar 数据目录必须是绝对路径。");
        }
        var normalizedExpected = Path.GetFullPath(expectedDataRoot);
        AppPaths.ValidateDataRoot(normalizedExpected, current.ProgramRoot);
        var migrated = AppPaths.TryLoad(
            current.ProgramRoot,
            current.AppDataRoot,
            current.Edition)
            ?? throw new InvalidOperationException("数据迁移完成，但新的启动配置无法读取。");
        if (!string.Equals(
            migrated.DataRoot,
            normalizedExpected,
            StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("网页请求的数据目录与已验证的迁移结果不一致。");
        }
        return migrated;
    }

    public async ValueTask DisposeAsync()
    {
        await _lifecycle.WaitAsync().ConfigureAwait(false);
        try
        {
            if (_disposed)
            {
                return;
            }
            _disposed = true;
            if (Current is not null)
            {
                await Current.Backend.DisposeAsync().ConfigureAwait(false);
                Current = null;
            }
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    private static async Task<BackendSession> StartBackendAsync(
        AppPaths paths,
        CancellationToken cancellationToken)
    {
        using var reservation = PortAllocator.Reserve();
        var backend = new BackendProcess(paths, reservation.SelectedPort);
        reservation.Release();
        try
        {
            backend.Start();
            await backend.WaitUntilHealthyAsync(TimeSpan.FromSeconds(60), cancellationToken).ConfigureAwait(false);
            return new BackendSession(paths, backend, backend.BaseUri, backend.ShellToken);
        }
        catch
        {
            await backend.DisposeAsync().ConfigureAwait(false);
            throw;
        }
    }

    private static async Task MigrateDataAsync(
        BackendProcess backend,
        string target,
        CancellationToken cancellationToken)
    {
        using var createRequest = new HttpRequestMessage(HttpMethod.Post, "api/storage-migrations")
        {
            Content = JsonContent.Create(new { storage_root = target }),
        };
        using var createResponse = await backend.SendAuthorizedAsync(createRequest, cancellationToken).ConfigureAwait(false);
        var createBody = await createResponse.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
        if (!createResponse.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"Hstar 数据迁移启动失败：{createBody}");
        }

        using var createJson = JsonDocument.Parse(createBody);
        var taskId = createJson.RootElement.GetProperty("task").GetProperty("id").GetString();
        if (string.IsNullOrWhiteSpace(taskId))
        {
            throw new InvalidOperationException("Hstar 数据迁移没有返回任务编号。");
        }

        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            using var statusRequest = new HttpRequestMessage(
                HttpMethod.Get,
                $"api/storage-migrations/{Uri.EscapeDataString(taskId)}");
            using var statusResponse = await backend.SendAuthorizedAsync(statusRequest, cancellationToken).ConfigureAwait(false);
            var statusBody = await statusResponse.Content.ReadAsStringAsync(cancellationToken).ConfigureAwait(false);
            if (!statusResponse.IsSuccessStatusCode)
            {
                throw new InvalidOperationException($"Hstar 数据迁移状态读取失败：{statusBody}");
            }
            using var statusJson = JsonDocument.Parse(statusBody);
            var task = statusJson.RootElement.GetProperty("task");
            var status = task.GetProperty("status").GetString() ?? string.Empty;
            if (status == "completed")
            {
                return;
            }
            if (status is "failed" or "cancelled")
            {
                var error = task.TryGetProperty("error", out var errorElement)
                    ? errorElement.GetString()
                    : string.Empty;
                throw new InvalidOperationException($"Hstar 数据迁移未完成：{error ?? status}");
            }
            await Task.Delay(250, cancellationToken).ConfigureAwait(false);
        }
    }

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }
}
