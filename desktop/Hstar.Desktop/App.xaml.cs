using System.Windows;
using Hstar.Desktop.Runtime;
using Hstar.Desktop.Views;

namespace Hstar.Desktop;

public partial class App : Application
{
    private SingleInstance? _singleInstance;
    private StartupCoordinator? _startupCoordinator;
    private CancellationTokenSource? _startupCancellation;
    private CancellationTokenSource? _maintenanceShutdownCancellation;
    private Task? _maintenanceShutdownTask;
    private volatile bool _maintenanceShutdownRequested;

    protected override async void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
        var maintenanceExitCode = await MaintenanceMode.TryRunAsync(e.Args);
        if (maintenanceExitCode.HasValue)
        {
            Shutdown(maintenanceExitCode.Value);
            return;
        }

        _singleInstance = SingleInstance.Acquire();
        if (!_singleInstance.IsPrimary)
        {
            MessageBox.Show(
                "Hstar 已经在运行。",
                "Hstar",
                MessageBoxButton.OK,
                MessageBoxImage.Information);
            Shutdown();
            return;
        }
        _maintenanceShutdownCancellation = new CancellationTokenSource();
        _maintenanceShutdownTask = WatchForMaintenanceShutdownAsync(
            _singleInstance,
            _maintenanceShutdownCancellation.Token);

        try
        {
            var programRoot = AppPaths.ResolveProgramRoot();
            var appDataRoot = AppPaths.ResolveAppDataRoot();
            var paths = AppPaths.TryLoad(programRoot, appDataRoot);
            var pendingMigrationTarget = string.Empty;
            if (paths is null)
            {
                var setup = new StorageSetupWindow(programRoot, appDataRoot);
                if (setup.ShowDialog() != true || setup.SelectedPaths is null)
                {
                    Shutdown();
                    return;
                }
                paths = setup.SelectedPaths;
                pendingMigrationTarget = setup.PendingMigrationTarget;
            }

            _startupCoordinator = new StartupCoordinator();
            var window = new MainWindow(paths, _startupCoordinator);
            MainWindow = window;
            ShutdownMode = ShutdownMode.OnMainWindowClose;
            window.Show();

            window.SetStartupStatus(
                string.IsNullOrWhiteSpace(pendingMigrationTarget)
                    ? "正在启动本地服务"
                    : "正在安全复制已有数据");
            _startupCancellation = new CancellationTokenSource();
            var session = await _startupCoordinator.StartAsync(
                paths,
                pendingMigrationTarget,
                _startupCancellation.Token);
            await window.AttachBackendSessionAsync(session, _startupCancellation.Token);
            window.SetStartupStatus("本地服务已就绪");
        }
        catch (OperationCanceledException) when (_startupCancellation?.IsCancellationRequested == true)
        {
            Shutdown();
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Hstar 启动失败。\n\n{error.Message}",
                "Hstar",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            Shutdown(-1);
        }
    }

    private async Task WatchForMaintenanceShutdownAsync(
        SingleInstance instance,
        CancellationToken cancellationToken)
    {
        try
        {
            await instance.WaitForShutdownAsync(cancellationToken).ConfigureAwait(false);
            _maintenanceShutdownRequested = true;
            await Dispatcher.InvokeAsync(Shutdown);
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        _maintenanceShutdownCancellation?.Cancel();
        if (!_maintenanceShutdownRequested && _maintenanceShutdownTask is not null)
        {
            try
            {
                _maintenanceShutdownTask.GetAwaiter().GetResult();
            }
            catch (OperationCanceledException)
            {
            }
        }
        _startupCancellation?.Cancel();
        if (_startupCoordinator is not null)
        {
            try
            {
                _startupCoordinator.DisposeAsync().AsTask().GetAwaiter().GetResult();
            }
            catch
            {
            }
        }
        _startupCancellation?.Dispose();
        _maintenanceShutdownCancellation?.Dispose();
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
