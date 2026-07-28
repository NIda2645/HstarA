using System.Windows;

namespace Hstar.Desktop.Views;

public partial class ShutdownConfirmationWindow : Window
{
    public ShutdownConfirmationWindow()
    {
        InitializeComponent();
        Loaded += (_, _) => CancelButton.Focus();
    }

    private void CancelButton_OnClick(object sender, RoutedEventArgs e) =>
        DialogResult = false;

    private void CloseButton_OnClick(object sender, RoutedEventArgs e) =>
        DialogResult = true;
}
