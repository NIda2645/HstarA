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
    public BackendSession? Current { get; private set; }

    public async Task<BackendSession> StartAsync(
        AppPaths paths,
        string pendingMigrationTarget = "",
        CancellationToken cancellationToken = default)
    {
        if (Current is not null)
        {
            throw new InvalidOperationException("Hstar 后端已经由当前外壳启动。");
        }

        var session = await StartBackendAsync(paths, cancellationToken);
        try
        {
            if (!string.IsNullOrWhiteSpace(pendingMigrationTarget))
            {
                await MigrateDataAsync(session.Backend, pendingMigrationTarget, cancellationToken);
                await session.Backend.DisposeAsync();
                var migratedPaths = AppPaths.TryLoad(paths.ProgramRoot, paths.AppDataRoot)
                    ?? throw new InvalidOperationException("数据迁移完成，但新的启动配置无法读取。");
                session = await StartBackendAsync(migratedPaths, cancellationToken);
            }

            Current = session;
            return session;
        }
        catch
        {
            await session.Backend.DisposeAsync();
            throw;
        }
    }

    public async ValueTask DisposeAsync()
    {
        if (Current is null)
        {
            return;
        }

        await Current.Backend.DisposeAsync();
        Current = null;
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
            await backend.WaitUntilHealthyAsync(TimeSpan.FromSeconds(60), cancellationToken);
            return new BackendSession(paths, backend, backend.BaseUri, backend.ShellToken);
        }
        catch
        {
            await backend.DisposeAsync();
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
        using var createResponse = await backend.SendAuthorizedAsync(createRequest, cancellationToken);
        var createBody = await createResponse.Content.ReadAsStringAsync(cancellationToken);
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
            using var statusResponse = await backend.SendAuthorizedAsync(statusRequest, cancellationToken);
            var statusBody = await statusResponse.Content.ReadAsStringAsync(cancellationToken);
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
            await Task.Delay(250, cancellationToken);
        }
    }
}
