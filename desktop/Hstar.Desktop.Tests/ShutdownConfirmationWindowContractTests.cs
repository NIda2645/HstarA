using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class ShutdownConfirmationWindowContractTests
{
    [Fact]
    public void DialogUsesCanvasPanelAndHasNoSystemTitleBar()
    {
        var xaml = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml");

        Assert.Contains("WindowStyle=\"None\"", xaml);
        Assert.Contains("AllowsTransparency=\"True\"", xaml);
        Assert.Contains("CornerRadius=\"20\"", xaml);
        Assert.Contains("CornerRadius=\"999\"", xaml);
        Assert.Contains("当前正在运行的任务将停止", xaml);
        Assert.Contains("已保存的画布和软件数据不会受到影响。", xaml);
        Assert.DoesNotContain("Title=\"确认关闭 Hstar\"", xaml);
    }

    [Fact]
    public void CancelAndCloseIconPreserveSafeDialogSemantics()
    {
        var xaml = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml");
        var source = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml.cs");

        Assert.Contains("x:Name=\"CancelButton\"", xaml);
        Assert.Contains("IsCancel=\"True\"", xaml);
        Assert.DoesNotContain("IsDefault=\"True\"", xaml);
        Assert.Contains("CloseIconButton_OnClick", xaml);
        Assert.Contains("CancelButton.Focus();", source);
        Assert.Contains("DialogResult = false;", source);
        Assert.Contains("DialogResult = true;", source);
    }

    [Fact]
    public void DialogDefinesBothCanvasThemePalettes()
    {
        var source = ReadProjectFile(
            "desktop", "Hstar.Desktop", "Views", "ShutdownConfirmationWindow.xaml.cs");

        Assert.Contains("CanvasTheme.Dark", source);
        Assert.Contains("#111827", source);
        Assert.Contains("#F8FAFC", source);
        Assert.Contains("#E8EDF3", source);
        Assert.Contains("#334155", source);
    }

    private static string ReadProjectFile(params string[] segments)
    {
        var directory = new DirectoryInfo(AppContext.BaseDirectory);
        while (directory is not null)
        {
            var candidate = Path.Combine([directory.FullName, .. segments]);
            if (File.Exists(candidate))
            {
                return File.ReadAllText(candidate);
            }
            directory = directory.Parent;
        }
        throw new FileNotFoundException(Path.Combine(segments));
    }
}
