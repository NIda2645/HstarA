using System.Windows;
using Hstar.Desktop.Runtime;

namespace Hstar.Desktop;

public partial class MainWindow : Window
{
    public MainWindow(AppPaths paths)
    {
        Paths = paths;
        InitializeComponent();
    }

    public AppPaths Paths { get; }

    public BackendSession? BackendSession { get; private set; }

    public void AttachBackendSession(BackendSession session)
    {
        BackendSession = session;
    }

    public void SetStartupStatus(string status)
    {
        StartupStatusText.Text = status;
    }
}
