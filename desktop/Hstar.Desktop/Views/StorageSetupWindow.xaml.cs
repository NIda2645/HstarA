using System.IO;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using Hstar.Desktop.Runtime;
using Microsoft.Win32;

namespace Hstar.Desktop.Views;

public partial class StorageSetupWindow : Window
{
    private static readonly Brush AvailableBrush = new SolidColorBrush(Color.FromRgb(22, 135, 82));
    private static readonly Brush UnavailableBrush = new SolidColorBrush(Color.FromRgb(180, 35, 24));
    private static readonly Brush NeutralBrush = new SolidColorBrush(Color.FromRgb(123, 132, 144));
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

    private void BrowseButton_OnClick(object sender, RoutedEventArgs e)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择 Hstar 数据位置",
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

    private void RefreshPathStatus()
    {
        ValidationText.Visibility = Visibility.Collapsed;
        var status = StorageSetupModel.Inspect(DataPathTextBox.Text, _programRoot);
        PathStatusText.Text = status.Message;
        FreeSpaceText.Text = status.AvailableBytes > 0
            ? $"可用 {FormatBytes(status.AvailableBytes)}"
            : string.Empty;
        ConfirmButton.IsEnabled = status.CanContinue;
        PathStatusDot.Fill = string.IsNullOrWhiteSpace(DataPathTextBox.Text)
            ? NeutralBrush
            : status.CanContinue ? AvailableBrush : UnavailableBrush;
        if (!status.CanContinue && !string.IsNullOrWhiteSpace(status.Error))
        {
            ValidationText.Text = status.Error;
            ValidationText.Visibility = Visibility.Visible;
        }
    }

    private void ConfirmButton_OnClick(object sender, RoutedEventArgs e)
    {
        var status = StorageSetupModel.Inspect(DataPathTextBox.Text, _programRoot);
        if (!status.CanContinue)
        {
            ValidationText.Text = status.Error.Length > 0 ? status.Error : status.Message;
            ValidationText.Visibility = Visibility.Visible;
            return;
        }

        try
        {
            Directory.CreateDirectory(status.NormalizedPath);
            var paths = AppPaths.Create(_programRoot, status.NormalizedPath, _appDataRoot);
            paths.SaveBootstrap();
            SelectedPaths = paths;
            DialogResult = true;
        }
        catch (Exception error) when (error is ArgumentException
            or IOException
            or UnauthorizedAccessException
            or InvalidOperationException
            or NotSupportedException)
        {
            ValidationText.Text = error.Message;
            ValidationText.Visibility = Visibility.Visible;
        }
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e) =>
        DialogResult = false;

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
                    break;
                }
                current = parent.FullName;
            }
            return Directory.Exists(current)
                ? current
                : Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
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
}
