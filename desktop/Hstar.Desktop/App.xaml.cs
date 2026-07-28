using System.Diagnostics;
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
        Task browserPreparation = Task.CompletedTask;
        var maintenanceExitCode = await MaintenanceMode.TryRunAsync(e.Args);
        if (maintenanceExitCode.HasValue)
        {
            Shutdown(maintenanceExitCode.Value);
            return;
        }
        ShellValidationOptions validationOptions;
        try
        {
            validationOptions = ShellValidationOptions.Parse(e.Args);
        }
        catch (ArgumentException error)
        {
            MessageBox.Show(error.Message, "Hstar", MessageBoxButton.OK, MessageBoxImage.Error);
            Shutdown(-1);
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
            var appDataRoot = validationOptions.AppDataRoot ?? AppPaths.ResolveAppDataRoot();
            var paths = AppPaths.TryLoad(programRoot, appDataRoot);
            if (paths is null)
            {
                var setup = new StorageSetupWindow(programRoot, appDataRoot);
                if (setup.ShowDialog() != true || setup.SelectedPaths is null)
                {
                    Shutdown();
                    return;
                }
                paths = setup.SelectedPaths;
            }

            _startupCoordinator = new StartupCoordinator(validationOptions.RequiredPort);
            var window = new MainWindow(paths, _startupCoordinator);
            MainWindow = window;
            ShutdownMode = ShutdownMode.OnMainWindowClose;
            window.Show();

            _startupCancellation = new CancellationTokenSource();
            browserPreparation = window.PrepareBrowserAsync(_startupCancellation.Token);
            var session = await _startupCoordinator.StartAsync(
                paths,
                _startupCancellation.Token);
            validationOptions.WriteBackendHealthyMarker(session.Paths.DataRoot, session.Backend.Port);
            await browserPreparation;
            if (!await window.AttachBackendSessionAsync(session, _startupCancellation.Token))
            {
                Shutdown();
                return;
            }
            validationOptions.WriteReadyMarker(session.Paths.DataRoot, session.Backend.Port);
        }
        catch (OperationCanceledException) when (_startupCancellation?.IsCancellationRequested == true)
        {
            await ObservePreparationAsync(browserPreparation);
            BeginSystemShutdown();
            Shutdown();
        }
        catch (Exception error)
        {
            _startupCancellation?.Cancel();
            await ObservePreparationAsync(browserPreparation);
            MessageBox.Show(
                $"Hstar 启动失败。\n\n{error.Message}",
                "Hstar",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
            BeginSystemShutdown();
            Shutdown(-1);
        }
    }

    private static async Task ObservePreparationAsync(Task preparation)
    {
        try
        {
            await preparation;
        }
        catch
        {
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
            await Dispatcher.InvokeAsync(() =>
            {
                BeginSystemShutdown();
                Shutdown();
            });
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
        }
    }

    private void BeginSystemShutdown()
    {
        if (MainWindow is Hstar.Desktop.MainWindow window)
        {
            window.BeginSystemShutdown();
        }
    }

    protected override void OnExit(ExitEventArgs e)
    {
        var restartRequested = MainWindow is Hstar.Desktop.MainWindow
        {
            RestartRequested: true,
        };
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
        if (restartRequested)
        {
            var executablePath = Environment.ProcessPath;
            if (!string.IsNullOrWhiteSpace(executablePath))
            {
                Process.Start(new ProcessStartInfo
                {
                    FileName = executablePath,
                    WorkingDirectory = AppContext.BaseDirectory,
                    UseShellExecute = true,
                });
            }
        }
        base.OnExit(e);
    }
}
