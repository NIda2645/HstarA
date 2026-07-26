using System.IO;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using Hstar.Desktop.Runtime;

namespace Hstar.Desktop;

public partial class MainWindow : Window
{
    private readonly StartupCoordinator _startupCoordinator;
    private readonly CancellationTokenSource _windowCancellation = new();
    private WebView2? _browser;
    private string? _preparedBrowserExecutableFolder;
    private string? _preparedUserDataFolder;
    private WebViewConfiguration? _configuration;
    private WebViewMessageRouter? _messageRouter;
    private int _restartInProgress;

    public MainWindow(AppPaths paths, StartupCoordinator startupCoordinator)
    {
        Paths = paths;
        _startupCoordinator = startupCoordinator;
        InitializeComponent();
        Closed += OnClosed;
    }

    public AppPaths Paths { get; private set; }

    public BackendSession? BackendSession { get; private set; }

    public async Task AttachBackendSessionAsync(
        BackendSession session,
        CancellationToken cancellationToken = default)
    {
        BackendSession = session;
        Paths = session.Paths;
        await PrepareBrowserAsync(cancellationToken);

        var browser = _browser
            ?? throw new InvalidOperationException("Hstar WebView 尚未完成初始化。");
        var core = browser.CoreWebView2
            ?? throw new InvalidOperationException("Hstar WebView 核心尚未完成初始化。");
        var configuration = WebViewConfiguration.Create(
            session.Paths,
            session.BaseUri,
            session.ShellToken);
        _configuration = configuration;
        _messageRouter = new WebViewMessageRouter(configuration, RestartWithDataRootAsync);

        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.WebMessageReceived += OnWebMessageReceived;
        await NavigateAsync(core, configuration.StartUri, cancellationToken);
        StartupOverlay.Visibility = Visibility.Collapsed;
    }

    public void SetStartupStatus(string status)
    {
        StartupStatusText.Text = status;
    }

    public async Task PrepareBrowserAsync(CancellationToken cancellationToken = default)
    {
        SetStartupStatus("正在准备 Hstar 界面");
        StartupOverlay.Visibility = Visibility.Visible;
        var browserExecutableFolder = Path.Combine(
            Paths.ProgramRoot,
            "runtime",
            "browser",
            "WebView2");
        var userDataFolder = Paths.WebViewCacheRoot;
        if (_browser?.CoreWebView2 is not null
            && string.Equals(
                _preparedBrowserExecutableFolder,
                browserExecutableFolder,
                StringComparison.OrdinalIgnoreCase)
            && string.Equals(
                _preparedUserDataFolder,
                userDataFolder,
                StringComparison.OrdinalIgnoreCase))
        {
            return;
        }
        if (!Directory.Exists(browserExecutableFolder))
        {
            throw new DirectoryNotFoundException(
                $"Hstar 固定 WebView2 运行时不存在：{browserExecutableFolder}");
        }
        Directory.CreateDirectory(userDataFolder);

        DisposeBrowser();
        var browser = new WebView2();
        BrowserHost.Children.Add(browser);
        _browser = browser;

        try
        {
            var environment = await CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: browserExecutableFolder,
                userDataFolder: userDataFolder);
            await browser.EnsureCoreWebView2Async(environment);
            cancellationToken.ThrowIfCancellationRequested();
            _windowCancellation.Token.ThrowIfCancellationRequested();
            _preparedBrowserExecutableFolder = browserExecutableFolder;
            _preparedUserDataFolder = userDataFolder;
        }
        catch
        {
            if (ReferenceEquals(_browser, browser))
            {
                DisposeBrowser();
            }
            throw;
        }
    }

    private async Task RestartWithDataRootAsync(
        string dataRoot,
        CancellationToken cancellationToken)
    {
        SetStartupStatus("正在切换数据目录");
        StartupOverlay.Visibility = Visibility.Visible;
        await ReleaseBrowserSessionsAsync();
        DisposeBrowser();

        using var linkedCancellation = CancellationTokenSource.CreateLinkedTokenSource(
            cancellationToken,
            _windowCancellation.Token);
        var session = await _startupCoordinator.RestartAfterMigrationAsync(
            dataRoot,
            linkedCancellation.Token);
        BackendSession = session;
        Paths = session.Paths;
        await AttachBackendSessionAsync(session, linkedCancellation.Token);
    }

    private async Task ReleaseBrowserSessionsAsync()
    {
        var core = _browser?.CoreWebView2;
        if (core is null)
        {
            return;
        }
        try
        {
            await core.ExecuteScriptAsync("""
                (async () => {
                  try { await window.HstarVoiceAssistant?.stop?.('storage-restart'); } catch {}
                  try { window.dispatchEvent(new Event('hstar-before-backend-restart')); } catch {}
                })();
                """);
        }
        catch (InvalidOperationException)
        {
        }
    }

    private void OnNavigationStarting(
        object? sender,
        CoreWebView2NavigationStartingEventArgs eventArgs)
    {
        if (!Uri.TryCreate(eventArgs.Uri, UriKind.Absolute, out var target)
            || _configuration?.IsAllowedNavigation(target) != true)
        {
            eventArgs.Cancel = true;
        }
    }

    private void OnNewWindowRequested(
        object? sender,
        CoreWebView2NewWindowRequestedEventArgs eventArgs)
    {
        eventArgs.Handled = true;
        if (!Uri.TryCreate(eventArgs.Uri, UriKind.Absolute, out var target)
            || _configuration is null)
        {
            return;
        }

        switch (_configuration.ClassifyPopup(target))
        {
            case WebPopupDisposition.NavigateSameView:
                _browser?.CoreWebView2.Navigate(target.AbsoluteUri);
                break;
            case WebPopupDisposition.OpenExternalBrowser:
                ExternalBrowserPolicy.TryOpen(target);
                break;
        }
    }

    private async void OnWebMessageReceived(
        object? sender,
        CoreWebView2WebMessageReceivedEventArgs eventArgs)
    {
        if (_messageRouter is null
            || Interlocked.Exchange(ref _restartInProgress, 1) != 0)
        {
            return;
        }

        try
        {
            await _messageRouter.TryHandleAsync(
                eventArgs.Source,
                eventArgs.WebMessageAsJson,
                _windowCancellation.Token);
        }
        catch (OperationCanceledException) when (_windowCancellation.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            SetStartupStatus("数据目录切换失败");
            MessageBox.Show(
                $"Hstar 无法切换数据目录。\n\n{error.Message}",
                "Hstar",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        finally
        {
            Interlocked.Exchange(ref _restartInProgress, 0);
        }
    }

    private static async Task NavigateAsync(
        CoreWebView2 core,
        Uri target,
        CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        void OnCompleted(object? _, CoreWebView2NavigationCompletedEventArgs eventArgs)
        {
            if (eventArgs.IsSuccess)
            {
                completion.TrySetResult();
            }
            else
            {
                completion.TrySetException(new InvalidOperationException(
                    $"Hstar 页面加载失败：{eventArgs.WebErrorStatus}"));
            }
        }

        core.NavigationCompleted += OnCompleted;
        try
        {
            core.Navigate(target.AbsoluteUri);
            await completion.Task.WaitAsync(cancellationToken);
        }
        finally
        {
            core.NavigationCompleted -= OnCompleted;
        }
    }

    private void DisposeBrowser()
    {
        var browser = _browser;
        if (browser is null)
        {
            return;
        }
        if (browser.CoreWebView2 is not null)
        {
            browser.CoreWebView2.NavigationStarting -= OnNavigationStarting;
            browser.CoreWebView2.NewWindowRequested -= OnNewWindowRequested;
            browser.CoreWebView2.WebMessageReceived -= OnWebMessageReceived;
        }
        BrowserHost.Children.Remove(browser);
        browser.Dispose();
        _browser = null;
        _preparedBrowserExecutableFolder = null;
        _preparedUserDataFolder = null;
        _configuration = null;
        _messageRouter = null;
    }

    private void OnClosed(object? sender, EventArgs eventArgs)
    {
        _windowCancellation.Cancel();
        DisposeBrowser();
    }
}
