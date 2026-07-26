using System.Windows;
using Hstar.Desktop.Runtime;
using Hstar.Desktop.Views;

namespace Hstar.Desktop;

public partial class App : Application
{
    private SingleInstance? _singleInstance;

    protected override void OnStartup(StartupEventArgs e)
    {
        base.OnStartup(e);
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

        try
        {
            var programRoot = AppPaths.ResolveProgramRoot();
            var appDataRoot = AppPaths.ResolveAppDataRoot();
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

            var window = new MainWindow(paths);
            MainWindow = window;
            window.Show();
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

    protected override void OnExit(ExitEventArgs e)
    {
        _singleInstance?.Dispose();
        base.OnExit(e);
    }
}
