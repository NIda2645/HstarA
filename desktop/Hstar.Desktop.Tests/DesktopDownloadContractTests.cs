using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class DesktopDownloadContractTests
{
    [Fact]
    public void MainWebViewRoutesEveryDownloadThroughAnOwnedWindowsSaveDialog()
    {
        var mainWindow = File.ReadAllText(ProjectFile(
            "desktop", "Hstar.Desktop", "MainWindow.xaml.cs"));
        var dialog = File.ReadAllText(ProjectFile(
            "desktop", "Hstar.Desktop", "Runtime", "NativeDownloadDialog.cs"));
        var project = File.ReadAllText(ProjectFile(
            "desktop", "Hstar.Desktop", "Hstar.Desktop.csproj"));

        Assert.Contains("core.DownloadStarting += OnMainDownloadStarting;", mainWindow);
        Assert.Contains("DownloadStarting -= OnMainDownloadStarting;", mainWindow);
        Assert.Contains("core.PermissionRequested += OnMainPermissionRequested;", mainWindow);
        Assert.Contains("PermissionRequested -= OnMainPermissionRequested;", mainWindow);
        Assert.Contains("CoreWebView2PermissionKind.MultipleAutomaticDownloads", mainWindow);
        Assert.Contains("CoreWebView2PermissionState.Allow", mainWindow);
        Assert.Contains("eventArgs.SavesInProfile = false;", mainWindow);
        Assert.Contains("WebViewDownloadPermissionPolicy.ShouldAllow", mainWindow);
        Assert.Contains("eventArgs.Handled = true;", mainWindow);
        Assert.Contains("NativeDownloadDialog.TryChoosePath(", mainWindow);
        Assert.Contains("eventArgs.ResultFilePath = selectedPath;", mainWindow);
        Assert.Contains("eventArgs.Cancel = true;", mainWindow);
        Assert.Contains("TryUsePendingDownloadBatch", mainWindow);
        Assert.Contains("FindIndex(fileName =>", mainWindow);
        Assert.Contains("StringComparison.OrdinalIgnoreCase", mainWindow);
        Assert.Contains("batch.FileNames.RemoveAt(fileIndex);", mainWindow);
        Assert.Contains("PrepareDownloadBatchAsync", mainWindow);

        Assert.Contains("Microsoft.Win32", dialog);
        Assert.Contains("new SaveFileDialog", dialog);
        Assert.Contains("new OpenFolderDialog", dialog);
        Assert.Contains("dialog.ShowDialog(owner)", dialog);
        Assert.Contains("Title = \"保存到\"", dialog);
        Assert.Contains("Title = \"选择批量保存位置\"", dialog);
        Assert.DoesNotContain("powershell", dialog, StringComparison.OrdinalIgnoreCase);
        Assert.DoesNotContain("System.Windows.Forms", dialog);
        Assert.Contains("<ApplicationIcon>Branding\\Hstar.ico</ApplicationIcon>", project);
    }

    [Fact]
    public void DesktopMessageRouterAcceptsOnlyAValidatedPlainFileBatch()
    {
        var router = File.ReadAllText(ProjectFile(
            "desktop", "Hstar.Desktop", "Runtime", "WebViewConfiguration.cs"));
        var bridge = File.ReadAllText(ProjectFile(
            "static", "js", "desktop-shell-bridge.js"));

        Assert.Contains("hstar:download-batch", router);
        Assert.Contains("DownloadBatchRequest", router);
        Assert.Contains("fileNames", router);
        Assert.Contains("HstarDesktopDownloads", bridge);
        Assert.Contains("hstar:download-batch", bridge);
        Assert.Contains("saveBatch", bridge);
        Assert.DoesNotContain(".zip", bridge, StringComparison.OrdinalIgnoreCase);
    }

    [Fact]
    public void MainWebViewHandlesMicrophonePermissionForTheCurrentBackendOrigin()
    {
        var mainWindow = File.ReadAllText(ProjectFile(
            "desktop", "Hstar.Desktop", "MainWindow.xaml.cs"));

        Assert.Contains("CoreWebView2PermissionKind.Microphone", mainWindow);
        Assert.Contains("WebViewMicrophonePermissionPolicy.ShouldAllow", mainWindow);
        Assert.Contains("eventArgs.SavesInProfile = false;", mainWindow);
        Assert.Contains("eventArgs.Handled = true;", mainWindow);
    }

    private static string ProjectFile(params string[] segments)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine([directory.FullName, .. segments]);
            if (File.Exists(candidate))
            {
                return candidate;
            }
            directory = directory.Parent;
        }
        throw new FileNotFoundException($"Project file not found: {Path.Combine(segments)}");
    }
}
