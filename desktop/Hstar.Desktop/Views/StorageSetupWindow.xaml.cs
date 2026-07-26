using System.IO;
using System.Windows;
using System.Windows.Controls;
using Hstar.Desktop.Runtime;
using Microsoft.Win32;

namespace Hstar.Desktop.Views;

public partial class StorageSetupWindow : Window
{
    private readonly string _programRoot;
    private readonly string _appDataRoot;

    public StorageSetupWindow(string programRoot, string appDataRoot)
    {
        _programRoot = Path.GetFullPath(programRoot);
        _appDataRoot = Path.GetFullPath(appDataRoot);
        InitializeComponent();
        DataPathTextBox.Text = AppPaths.SelectDefaultDataRoot();
        DataPathTextBox.CaretIndex = DataPathTextBox.Text.Length;
        RefreshPathStatus();
    }

    public AppPaths? SelectedPaths { get; private set; }

    public string PendingMigrationTarget { get; private set; } = string.Empty;

    private void BrowseButton_OnClick(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择 Hstar 数据目录",
            Multiselect = false,
            InitialDirectory = NearestExistingDirectory(DataPathTextBox.Text),
        };
        if (dialog.ShowDialog(this) == true)
        {
            DataPathTextBox.Text = dialog.FolderName;
            DataPathTextBox.CaretIndex = DataPathTextBox.Text.Length;
        }
    }

    private void DataPathTextBox_OnTextChanged(object sender, TextChangedEventArgs e)
    {
        if (PathStatusText is not null)
        {
            RefreshPathStatus();
        }
    }

    private void ExistingDataChoice_OnChanged(object sender, RoutedEventArgs e)
    {
        if (CopyTargetPanel is null)
        {
            return;
        }

        CopyTargetPanel.Visibility = CopyExistingRadio.IsChecked == true
            ? Visibility.Visible
            : Visibility.Collapsed;
        if (CopyExistingRadio.IsChecked == true && string.IsNullOrWhiteSpace(CopyTargetTextBox.Text))
        {
            CopyTargetTextBox.Text = AppPaths.SelectDefaultDataRoot();
        }
    }

    private void BrowseCopyTargetButton_OnClick(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择新的 Hstar 数据目录",
            Multiselect = false,
            InitialDirectory = NearestExistingDirectory(CopyTargetTextBox.Text),
        };
        if (dialog.ShowDialog(this) == true)
        {
            CopyTargetTextBox.Text = dialog.FolderName;
            CopyTargetTextBox.CaretIndex = CopyTargetTextBox.Text.Length;
        }
    }

    private void RefreshPathStatus()
    {
        HideValidation();
        var rawPath = DataPathTextBox.Text.Trim();
        if (rawPath.Length == 0)
        {
            PathStatusText.Text = "请输入或选择目录";
            FreeSpaceText.Text = string.Empty;
            ExistingDataPanel.Visibility = Visibility.Collapsed;
            return;
        }

        try
        {
            var path = Path.GetFullPath(Environment.ExpandEnvironmentVariables(rawPath));
            AppPaths.ValidateDataRoot(path, _programRoot);
            var exists = Directory.Exists(path);
            PathStatusText.Text = exists ? "目录已存在" : "确认后将自动创建";
            FreeSpaceText.Text = $"可用 {FormatBytes(AppPaths.GetAvailableBytes(path))}";
            ExistingDataPanel.Visibility = File.Exists(Path.Combine(path, "data-manifest.json"))
                ? Visibility.Visible
                : Visibility.Collapsed;
            if (ExistingDataPanel.Visibility != Visibility.Visible)
            {
                ContinueExistingRadio.IsChecked = true;
            }
        }
        catch (Exception error) when (error is ArgumentException
            or IOException
            or UnauthorizedAccessException
            or NotSupportedException)
        {
            PathStatusText.Text = "目录不可用";
            FreeSpaceText.Text = string.Empty;
            ExistingDataPanel.Visibility = Visibility.Collapsed;
        }
    }

    private void ConfirmButton_OnClick(object sender, RoutedEventArgs e)
    {
        try
        {
            var dataRoot = Path.GetFullPath(
                Environment.ExpandEnvironmentVariables(DataPathTextBox.Text.Trim()));
            AppPaths.ValidateDataRoot(dataRoot, _programRoot);
            var availableBytes = AppPaths.GetAvailableBytes(dataRoot);
            if (availableBytes < AppPaths.MinimumDataRootFreeBytes)
            {
                throw new InvalidOperationException("所选磁盘可用空间不足 2 GB，请选择其他位置。");
            }

            Directory.CreateDirectory(dataRoot);
            var paths = AppPaths.Create(_programRoot, dataRoot, _appDataRoot);
            var hasExistingData = File.Exists(Path.Combine(dataRoot, "data-manifest.json"));
            if (hasExistingData && CopyExistingRadio.IsChecked == true)
            {
                var target = ValidateMigrationTarget(dataRoot, CopyTargetTextBox.Text);
                Directory.CreateDirectory(target);
                paths.SaveBootstrap(migrationStatus: "pending");
                PendingMigrationTarget = target;
            }
            else
            {
                paths.SaveBootstrap();
                PendingMigrationTarget = string.Empty;
            }
            SelectedPaths = paths;
            DialogResult = true;
        }
        catch (Exception error) when (error is ArgumentException
            or IOException
            or UnauthorizedAccessException
            or InvalidOperationException
            or NotSupportedException)
        {
            ShowValidation(error.Message);
        }
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e)
    {
        DialogResult = false;
    }

    private void ShowValidation(string message)
    {
        ValidationText.Text = message;
        ValidationText.Visibility = Visibility.Visible;
    }

    private void HideValidation()
    {
        ValidationText.Text = string.Empty;
        ValidationText.Visibility = Visibility.Collapsed;
    }

    private static string NearestExistingDirectory(string path)
    {
        try
        {
            var current = Path.GetFullPath(Environment.ExpandEnvironmentVariables(path.Trim()));
            while (!Directory.Exists(current))
            {
                var parent = Directory.GetParent(current);
                if (parent is null)
                {
                    return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
                }
                current = parent.FullName;
            }
            return current;
        }
        catch
        {
            return Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        }
    }

    private static string FormatBytes(long bytes)
    {
        var value = (double)Math.Max(0, bytes);
        string[] units = ["B", "KB", "MB", "GB", "TB"];
        var index = 0;
        while (value >= 1024 && index < units.Length - 1)
        {
            value /= 1024;
            index++;
        }
        return $"{value:0.#} {units[index]}";
    }

    private string ValidateMigrationTarget(string source, string rawTarget)
    {
        if (string.IsNullOrWhiteSpace(rawTarget))
        {
            throw new InvalidOperationException("请选择新的数据目录。");
        }

        var target = Path.GetFullPath(Environment.ExpandEnvironmentVariables(rawTarget.Trim()));
        AppPaths.ValidateDataRoot(target, _programRoot);
        var sourceWithSeparator = Path.TrimEndingDirectorySeparator(source) + Path.DirectorySeparatorChar;
        var targetWithSeparator = Path.TrimEndingDirectorySeparator(target) + Path.DirectorySeparatorChar;
        if (sourceWithSeparator.StartsWith(targetWithSeparator, StringComparison.OrdinalIgnoreCase)
            || targetWithSeparator.StartsWith(sourceWithSeparator, StringComparison.OrdinalIgnoreCase))
        {
            throw new InvalidOperationException("新旧数据目录不能相同或互相包含。");
        }
        if (Directory.Exists(target) && Directory.EnumerateFileSystemEntries(target).Any())
        {
            throw new InvalidOperationException("新的数据目录必须为空。");
        }
        if (AppPaths.GetAvailableBytes(target) < AppPaths.MinimumDataRootFreeBytes)
        {
            throw new InvalidOperationException("新位置可用空间不足 2 GB，请选择其他位置。");
        }

        return target;
    }
}
