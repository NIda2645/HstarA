using System.IO;

namespace Hstar.Desktop.Runtime;

public sealed record BackendSession(
    AppPaths Paths,
    BackendProcess Backend,
    Uri BaseUri,
    string ShellToken);

public sealed class StartupCoordinator : IAsyncDisposable
{
    private readonly SemaphoreSlim _lifecycle = new(1, 1);
    private readonly int? _requiredPort;
    private bool _disposed;

    public StartupCoordinator(int? requiredPort = null)
    {
        _requiredPort = requiredPort;
    }

    public BackendSession? Current { get; private set; }

    public async Task<BackendSession> StartAsync(
        AppPaths paths,
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

            var session = await StartBackendAsync(paths, _requiredPort, cancellationToken).ConfigureAwait(false);
            try
            {
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

    public async Task<BackendSession> RestartWithDataRootAsync(
        string dataRoot,
        CancellationToken cancellationToken = default)
    {
        await _lifecycle.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            ThrowIfDisposed();
            var previous = Current
                ?? throw new InvalidOperationException("Hstar 后端尚未启动，无法切换数据目录。");
            var nextPaths = PrepareRestartPaths(previous.Paths, dataRoot);
            Current = null;
            await previous.Backend.DisposeAsync().ConfigureAwait(false);
            var replacement = await StartBackendAsync(nextPaths, _requiredPort, cancellationToken).ConfigureAwait(false);
            Current = replacement;
            return replacement;
        }
        finally
        {
            _lifecycle.Release();
        }
    }

    public static AppPaths PrepareRestartPaths(AppPaths current, string dataRoot)
    {
        ArgumentNullException.ThrowIfNull(current);
        if (!Path.IsPathFullyQualified(dataRoot))
        {
            throw new InvalidOperationException("新的 Hstar 数据目录必须是绝对路径。");
        }
        var normalizedRoot = Path.GetFullPath(dataRoot);
        AppPaths.ValidateDataRoot(normalizedRoot, current.ProgramRoot);
        var next = AppPaths.Create(
            current.ProgramRoot,
            normalizedRoot,
            current.AppDataRoot,
            current.Edition);
        next.SaveBootstrap(lastStartedVersion: current.Bootstrap.LastStartedVersion);
        return next;
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

    public async Task StopAsync(CancellationToken cancellationToken = default)
    {
        await _lifecycle.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (Current is null)
            {
                return;
            }
            var current = Current;
            Current = null;
            await current.Backend.DisposeAsync().ConfigureAwait(false);
        }
        finally
        {
            _lifecycle.Release();
        }
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
        int? requiredPort,
        CancellationToken cancellationToken)
    {
        using var reservation = PortAllocator.Reserve(requiredPort);
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

    private void ThrowIfDisposed()
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
    }
}
