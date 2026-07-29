using System.Windows;
using System.Windows.Media;
using Hstar.Desktop.Runtime;

namespace Hstar.Desktop.Views;

public partial class ShutdownConfirmationWindow : Window
{
    internal ShutdownConfirmationWindow(CanvasTheme theme)
    {
        InitializeComponent();
        ApplyTheme(theme);
        Loaded += OnLoaded;
    }

    private void OnLoaded(object sender, RoutedEventArgs eventArgs)
    {
        Loaded -= OnLoaded;
        CancelButton.Focus();
    }

    private void ApplyTheme(CanvasTheme theme)
    {
        var dark = theme == CanvasTheme.Dark;
        SetBrush("ShutdownBackdropBrush", "#00000000");
        SetBrush("ShutdownPanelBrush", dark ? "#111827" : "#FFFFFF");
        SetBrush("ShutdownPanelBorderBrush", dark ? "#334155" : "#E8EDF3");
        SetBrush("ShutdownTextBrush", dark ? "#F8FAFC" : "#111827");
        SetBrush("ShutdownMutedTextBrush", dark ? "#94A3B8" : "#64748B");
        SetBrush("ShutdownSoftBrush", dark ? "#1E293B" : "#F8FAFC");
        SetBrush("ShutdownSecondaryBrush", dark ? "#1E293B" : "#F8FAFC");
        SetBrush("ShutdownSecondaryBorderBrush", dark ? "#334155" : "#EDF2F7");
        SetBrush("ShutdownStrongBrush", dark ? "#D8DEE9" : "#111827");
        SetBrush("ShutdownStrongTextBrush", dark ? "#0F172A" : "#FFFFFF");
        SetBrush("ShutdownIconHoverBrush", dark ? "#263449" : "#F1F5F9");
        SetBrush("ShutdownFocusBrush", dark ? "#475569" : "#CBD5E1");
    }

    private void SetBrush(string key, string colorValue)
    {
        var color = (Color)ColorConverter.ConvertFromString(colorValue);
        var brush = new SolidColorBrush(color);
        brush.Freeze();
        Resources[key] = brush;
    }

    private void CloseIconButton_OnClick(object sender, RoutedEventArgs e) =>
        DialogResult = false;

    private void CancelButton_OnClick(object sender, RoutedEventArgs e) =>
        DialogResult = false;

    private void CloseButton_OnClick(object sender, RoutedEventArgs e) =>
        DialogResult = true;
}
