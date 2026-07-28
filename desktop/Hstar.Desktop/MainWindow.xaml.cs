using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Windows;
using System.Windows.Interop;
using System.Windows.Media.Animation;
using System.Windows.Media.Imaging;
using Hstar.Desktop.Runtime;
using Hstar.Desktop.Views;
using Microsoft.Web.WebView2.Core;

namespace Hstar.Desktop;

public partial class MainWindow : Window
{
    private const string StartupHostName = EmbeddedStartupRuntime.HostName;
    private const string StartupFilter = "https://hstar-startup.local/*";
    private static readonly Uri StartupUri = new(
        $"https://{StartupHostName}/index.html",
        UriKind.Absolute);
    private static readonly TimeSpan EnvironmentTimeout = TimeSpan.FromSeconds(15);
    private static readonly TimeSpan InteractiveTimeout = TimeSpan.FromSeconds(30);
    private static readonly TimeSpan StartupFadeDuration = TimeSpan.FromMilliseconds(220);
    private static readonly TimeSpan PosterFadeDelay = TimeSpan.FromMilliseconds(120);
    private static readonly TimeSpan PosterFadeDuration = TimeSpan.FromMilliseconds(120);
    private static readonly TimeSpan MinimumStartupDisplay = TimeSpan.FromSeconds(5);

    private readonly StartupCoordinator _startupCoordinator;
    private readonly StartupStateMachine _startupState = new();
    private readonly EmbeddedStartupRuntime _embeddedStartupRuntime =
        EmbeddedStartupRuntime.CreateApplicationRuntime();
    private readonly WebViewEnvironmentFactory _environmentFactory = new();
    private readonly CancellationTokenSource _windowCancellation = new();
    private readonly SemaphoreSlim _messageGate = new(1, 1);
    private readonly ShutdownCoordinator _shutdownCoordinator;
    private readonly Stopwatch _startupDisplayClock = new();
    private readonly TaskCompletionSource<bool> _startupBrowserVisualReady = new(
        TaskCreationOptions.RunContinuationsAsynchronously);
    private WebViewConfiguration? _configuration;
    private WebViewMessageRouter? _messageRouter;
    private TaskCompletionSource<bool>? _interactiveCompletion;
    private TaskCompletionSource<StartupFailureAction>? _failureAction;
    private Task? _browserPreparationTask;
    private Task? _startupBrowserPreparationTask;
    private CoreWebView2Environment? _browserEnvironment;
    private string? _navigationScriptId;
    private bool _browsersPrepared;
    private bool _mainEventsAttached;
    private bool _startupResourceEventsAttached;
    private bool _startupBrowserReady;
    private bool _startupBrowserRevealed;
    private bool _nativeStartupFailed;
    private bool _nativeMediaOpened;
    private bool _nativePlaybackStarted;
    private bool _startupDisposed;
    private bool _allowClose;
    private bool _systemShutdownRequested;
    private int _closeRequestActive;

    public MainWindow(AppPaths paths, StartupCoordinator startupCoordinator)
    {
        Paths = paths;
        _startupCoordinator = startupCoordinator;
        InitializeComponent();
        NativeStartupMedia.MediaOpened += OnNativeStartupMediaOpened;
        NativeStartupMedia.MediaEnded += OnNativeStartupMediaEnded;
        NativeStartupMedia.MediaFailed += OnNativeStartupMediaFailed;
        NativeStartupSurface.Loaded += OnNativeStartupSurfaceLoaded;
        SourceInitialized += OnSourceInitialized;
        InitializeNativeStartupMedia();
        _shutdownCoordinator = new ShutdownCoordinator(
            StopOwnedBackendAsync,
            ConfirmUserCloseAsync);
        Closing += OnClosing;
        Closed += OnClosed;
    }

    public AppPaths Paths { get; private set; }

    public BackendSession? BackendSession { get; private set; }

    public bool RestartRequested { get; private set; }

    public void BeginSystemShutdown()
    {
        _systemShutdownRequested = true;
    }

    private void OnSourceInitialized(object? sender, EventArgs eventArgs) =>
        NativeWindowTheme.TryApplyDarkTitleBar(new WindowInteropHelper(this).Handle);

    private void InitializeNativeStartupMedia()
    {
        var startupRoot = Path.Combine(Paths.ProgramRoot, "Assets", "startup");
        var posterPath = Path.Combine(startupRoot, "startup-lightfall-poster.jpg");
        var videoPath = Path.Combine(startupRoot, "startup-lightfall.mp4");
        if (!File.Exists(posterPath) || !File.Exists(videoPath))
        {
            throw new FileNotFoundException(
                "Hstar native startup media is incomplete.",
                !File.Exists(posterPath) ? posterPath : videoPath);
        }

        using var posterStream = new FileStream(
            posterPath,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            bufferSize: 64 * 1024,
            FileOptions.SequentialScan);
        var poster = new BitmapImage();
        poster.BeginInit();
        poster.CacheOption = BitmapCacheOption.OnLoad;
        poster.StreamSource = posterStream;
        poster.EndInit();
        poster.Freeze();

        NativeStartupPoster.Source = poster;
        NativeStartupMedia.Source = new Uri(videoPath, UriKind.Absolute);
        _startupState.MarkVisualReady();
    }

    private void OnNativeStartupSurfaceLoaded(object sender, RoutedEventArgs eventArgs)
    {
        if (!_startupDisplayClock.IsRunning)
        {
            _startupDisplayClock.Start();
        }
        if (!_nativeStartupFailed)
        {
            StartNativeStartupMedia();
        }
    }

    private void StartNativeStartupMedia()
    {
        if (_nativePlaybackStarted || _nativeStartupFailed || _startupDisposed)
        {
            return;
        }

        _nativePlaybackStarted = true;
        NativeStartupMedia.Play();
    }

    private async void OnNativeStartupMediaOpened(object sender, RoutedEventArgs eventArgs)
    {
        if (_nativeMediaOpened || _nativeStartupFailed || _startupDisposed)
        {
            return;
        }

        _nativeMediaOpened = true;
        try
        {
            await Task.Delay(PosterFadeDelay, _windowCancellation.Token);
        }
        catch (OperationCanceledException) when (_windowCancellation.IsCancellationRequested)
        {
            return;
        }
        if (_nativeStartupFailed || _startupDisposed)
        {
            return;
        }

        var animation = new DoubleAnimation
        {
            From = 1,
            To = 0,
            Duration = new Duration(PosterFadeDuration),
            FillBehavior = FillBehavior.HoldEnd,
        };
        NativeStartupPoster.BeginAnimation(OpacityProperty, animation);
    }

    private void OnNativeStartupMediaEnded(object sender, RoutedEventArgs eventArgs)
    {
        if (_nativeStartupFailed || _startupDisposed)
        {
            return;
        }
        NativeStartupMedia.Position = TimeSpan.Zero;
        NativeStartupMedia.Play();
    }

    private async void OnNativeStartupMediaFailed(
        object? sender,
        ExceptionRoutedEventArgs eventArgs)
    {
        if (_nativeStartupFailed || _startupDisposed)
        {
            return;
        }

        _nativeStartupFailed = true;
        Debug.WriteLine($"Hstar native startup media failed: {eventArgs.ErrorException}");
        StopNativeStartupMedia();
        try
        {
            await EnsureStartupBrowserReadyAsync(_windowCancellation.Token);
            RevealStartupBrowser();
        }
        catch (OperationCanceledException) when (_windowCancellation.IsCancellationRequested)
        {
        }
        catch (Exception error)
        {
            Debug.WriteLine($"Hstar startup browser fallback failed: {error}");
        }
    }

    private void StopNativeStartupMedia()
    {
        try
        {
            NativeStartupMedia.Stop();
        }
        catch (InvalidOperationException)
        {
        }
    }

    public Task PrepareBrowserAsync(CancellationToken cancellationToken = default)
    {
        _browserPreparationTask ??= PrepareBrowserCoreAsync();
        return _browserPreparationTask.WaitAsync(cancellationToken);
    }

    private async Task PrepareBrowserCoreAsync()
    {
        if (_browsersPrepared)
        {
            return;
        }

        var browserExecutableFolder = Path.Combine(
            Paths.ProgramRoot,
            "runtime",
            "browser",
            "WebView2");
        if (!Directory.Exists(browserExecutableFolder))
        {
            throw new DirectoryNotFoundException(
                $"Hstar 固定 WebView2 运行时不存在：{browserExecutableFolder}");
        }
        _embeddedStartupRuntime.ValidateResources();
        Directory.CreateDirectory(Paths.WebViewCacheRoot);

        var environment = await _environmentFactory
            .GetAsync(Paths)
            .WaitAsync(EnvironmentTimeout, _windowCancellation.Token);
        _browserEnvironment = environment;
        await MainWebView.EnsureCoreWebView2Async(environment)
            .WaitAsync(EnvironmentTimeout, _windowCancellation.Token);
        ConfigureBrowserSettings(MainWebView.CoreWebView2);
        _browsersPrepared = true;
    }

    private Task EnsureStartupBrowserReadyAsync(CancellationToken cancellationToken)
    {
        _startupBrowserPreparationTask ??= PrepareStartupBrowserCoreAsync();
        return _startupBrowserPreparationTask.WaitAsync(cancellationToken);
    }

    private async Task PrepareStartupBrowserCoreAsync()
    {
        await PrepareBrowserAsync(_windowCancellation.Token);
        var environment = _browserEnvironment
            ?? throw new InvalidOperationException("Hstar startup browser environment is unavailable.");
        await StartupWebView.EnsureCoreWebView2Async(environment)
            .WaitAsync(EnvironmentTimeout, _windowCancellation.Token);

        ConfigureBrowserSettings(StartupWebView.CoreWebView2);
        StartupWebView.CoreWebView2.AddWebResourceRequestedFilter(
            StartupFilter,
            CoreWebView2WebResourceContext.All);
        StartupWebView.CoreWebView2.WebResourceRequested += OnStartupWebResourceRequested;
        _startupResourceEventsAttached = true;
        StartupWebView.CoreWebView2.WebMessageReceived += OnStartupWebMessageReceived;
        await NavigateAsync(
            StartupWebView.CoreWebView2,
            StartupUri,
            _windowCancellation.Token);
        await _startupBrowserVisualReady.Task
            .WaitAsync(EnvironmentTimeout, _windowCancellation.Token);
        _startupState.MarkVisualReady();
    }

    public async Task<bool> AttachBackendSessionAsync(
        BackendSession session,
        CancellationToken cancellationToken = default)
    {
        ArgumentNullException.ThrowIfNull(session);
        if (!_browsersPrepared)
        {
            await PrepareBrowserAsync(cancellationToken);
        }

        BackendSession = session;
        Paths = session.Paths;
        _startupState.MarkBackendReady();
        AttachMainBrowserEvents();

        var retry = false;
        while (true)
        {
            cancellationToken.ThrowIfCancellationRequested();
            _windowCancellation.Token.ThrowIfCancellationRequested();
            try
            {
                await NavigateMainOnceAsync(session, retry, cancellationToken);
                await DismissStartupVisualAsync();
                return true;
            }
            catch (OperationCanceledException) when (
                cancellationToken.IsCancellationRequested
                || _windowCancellation.IsCancellationRequested)
            {
                throw;
            }
            catch (Exception error)
            {
                _startupState.Fail(error.Message);
                var action = await ShowStartupFailureAsync(error.Message, cancellationToken);
                if (action == StartupFailureAction.Exit)
                {
                    _systemShutdownRequested = true;
                    return false;
                }
                retry = true;
            }
        }
    }

    private async Task NavigateMainOnceAsync(
        BackendSession session,
        bool retry,
        CancellationToken cancellationToken)
    {
        var navigationId = Guid.NewGuid().ToString("N");
        if (retry)
        {
            _startupState.BeginRetry(navigationId);
            await ExecuteStartupScriptAsync("window.hstarStartup?.hideFailure?.()");
        }
        else
        {
            _startupState.BeginMainNavigation(navigationId);
        }

        var configuration = WebViewConfiguration.Create(
            session.Paths,
            session.BaseUri,
            session.ShellToken,
            navigationId);
        _configuration = configuration;
        _messageRouter = new WebViewMessageRouter(
            configuration,
            RequestFullRestartWithDataRootAsync,
            AcceptInteractiveAsync);
        _interactiveCompletion = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);

        var core = MainWebView.CoreWebView2;
        if (_navigationScriptId is not null)
        {
            core.RemoveScriptToExecuteOnDocumentCreated(_navigationScriptId);
        }
        var serializedNavigationId = JsonSerializer.Serialize(navigationId);
        _navigationScriptId = await core.AddScriptToExecuteOnDocumentCreatedAsync(
            $"window.__HSTAR_NAVIGATION_ID__ = {serializedNavigationId};");

        await NavigateAsync(core, configuration.StartUri, cancellationToken);
        await _interactiveCompletion.Task.WaitAsync(InteractiveTimeout, cancellationToken);
    }

    private Task AcceptInteractiveAsync(
        string navigationId,
        CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (_startupState.AcceptInteractive(navigationId, schemaVersion: 1))
        {
            _interactiveCompletion?.TrySetResult(true);
        }
        return Task.CompletedTask;
    }

    private async Task<StartupFailureAction> ShowStartupFailureAsync(
        string message,
        CancellationToken cancellationToken)
    {
        await EnsureStartupBrowserReadyAsync(cancellationToken);
        _failureAction = new TaskCompletionSource<StartupFailureAction>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var serializedMessage = JsonSerializer.Serialize(
            string.IsNullOrWhiteSpace(message) ? "Hstar 启动未完成。" : message.Trim());
        await ExecuteStartupScriptAsync(
            $"window.hstarStartup?.showFailure?.({serializedMessage})");
        RevealStartupBrowser();
        return await _failureAction.Task.WaitAsync(cancellationToken);
    }

    private async Task DismissStartupVisualAsync()
    {
        if (_startupDisposed)
        {
            return;
        }

        await WaitForMinimumStartupDisplayAsync();
        RevealMainBrowser();
        await ExecuteStartupScriptAsync("window.hstarStartup?.dispose?.()");
        var activeStartupVisual = _startupBrowserRevealed
            ? (FrameworkElement)StartupWebView
            : NativeStartupSurface;
        var completion = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        var animation = new DoubleAnimation
        {
            From = 1,
            To = 0,
            Duration = new Duration(StartupFadeDuration),
            FillBehavior = FillBehavior.Stop,
        };
        animation.Completed += (_, _) => completion.TrySetResult(true);
        activeStartupVisual.BeginAnimation(OpacityProperty, animation);
        await completion.Task;

        if (StartupWebView.CoreWebView2 is not null)
        {
            StartupWebView.CoreWebView2.WebMessageReceived -= OnStartupWebMessageReceived;
        }
        DetachStartupResourceHandler();
        StopNativeStartupMedia();
        NativeStartupSurface.Visibility = Visibility.Collapsed;
        StartupWebView.Visibility = Visibility.Collapsed;
        StartupWebView.Dispose();
        _startupDisposed = true;
        _startupState.MarkVisualDisposed();
    }

    private async Task RequestFullRestartWithDataRootAsync(
        string dataRoot,
        CancellationToken cancellationToken)
    {
        StartupCoordinator.PrepareRestartPaths(Paths, dataRoot);
        await ReleaseBrowserSessionsAsync();
        cancellationToken.ThrowIfCancellationRequested();
        RestartRequested = true;
        await Dispatcher.InvokeAsync(Close);
    }

    private Task StopOwnedBackendAsync(CancellationToken cancellationToken) =>
        _startupCoordinator.StopAsync(cancellationToken);

    private async Task<bool> ConfirmUserCloseAsync(CancellationToken cancellationToken)
    {
        cancellationToken.ThrowIfCancellationRequested();
        if (!Dispatcher.CheckAccess())
        {
            var confirmationTask = await Dispatcher.InvokeAsync(
                () => ConfirmUserCloseAsync(cancellationToken));
            return await confirmationTask;
        }

        var theme = await ResolveCanvasThemeAsync(cancellationToken);
        return ShowCloseConfirmation(theme);
    }

    private async Task<CanvasTheme> ResolveCanvasThemeAsync(
        CancellationToken cancellationToken)
    {
        var core = MainWebView.CoreWebView2;
        if (core is null)
        {
            return CanvasTheme.Light;
        }

        try
        {
            var result = await core.ExecuteScriptAsync(CanvasThemeDetection.Script)
                .WaitAsync(cancellationToken);
            return CanvasThemeDetection.ParseResult(result);
        }
        catch (InvalidOperationException)
        {
            return CanvasTheme.Light;
        }
        catch (System.Runtime.InteropServices.COMException)
        {
            return CanvasTheme.Light;
        }
    }

    private bool ShowCloseConfirmation(CanvasTheme theme)
    {
        var dialog = new ShutdownConfirmationWindow(theme)
        {
            Owner = this,
        };
        return dialog.ShowDialog() == true;
    }

    private async Task ReleaseBrowserSessionsAsync()
    {
        if (MainWebView.CoreWebView2 is null)
        {
            return;
        }
        try
        {
            await MainWebView.CoreWebView2.ExecuteScriptAsync("""
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

    private void AttachMainBrowserEvents()
    {
        if (_mainEventsAttached)
        {
            return;
        }
        var core = MainWebView.CoreWebView2;
        core.NavigationStarting += OnNavigationStarting;
        core.NewWindowRequested += OnNewWindowRequested;
        core.WebMessageReceived += OnMainWebMessageReceived;
        _mainEventsAttached = true;
    }

    private static void ConfigureBrowserSettings(CoreWebView2 core)
    {
        core.Settings.AreDefaultContextMenusEnabled = false;
        core.Settings.AreDevToolsEnabled = false;
        core.Settings.IsStatusBarEnabled = false;
        core.Settings.IsZoomControlEnabled = false;
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
                MainWebView.CoreWebView2.Navigate(target.AbsoluteUri);
                break;
            case WebPopupDisposition.OpenExternalBrowser:
                ExternalBrowserPolicy.TryOpen(target);
                break;
        }
    }

    private async void OnMainWebMessageReceived(
        object? sender,
        CoreWebView2WebMessageReceivedEventArgs eventArgs)
    {
        if (_messageRouter is null)
        {
            return;
        }

        await _messageGate.WaitAsync();
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
            MessageBox.Show(
                $"Hstar 无法完成当前桌面操作。\n\n{error.Message}",
                "Hstar",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        finally
        {
            _messageGate.Release();
        }
    }

    private void OnStartupWebMessageReceived(
        object? sender,
        CoreWebView2WebMessageReceivedEventArgs eventArgs)
    {
        if (!Uri.TryCreate(eventArgs.Source, UriKind.Absolute, out var source)
            || !string.Equals(source.Scheme, StartupUri.Scheme, StringComparison.OrdinalIgnoreCase)
            || !string.Equals(source.Host, StartupUri.Host, StringComparison.OrdinalIgnoreCase))
        {
            return;
        }

        try
        {
            using var message = JsonDocument.Parse(eventArgs.WebMessageAsJson);
            var root = message.RootElement;
            if (!root.TryGetProperty("schemaVersion", out var schema)
                || schema.GetInt32() != 1
                || !root.TryGetProperty("type", out var type))
            {
                return;
            }
            switch (type.GetString())
            {
                case "hstar-startup:visual-ready":
                    _startupBrowserReady = true;
                    _startupBrowserVisualReady.TrySetResult(true);
                    if (_nativeStartupFailed)
                    {
                        RevealStartupBrowser();
                    }
                    break;
                case "hstar-startup:retry":
                    _failureAction?.TrySetResult(StartupFailureAction.Retry);
                    break;
                case "hstar-startup:exit":
                    _failureAction?.TrySetResult(StartupFailureAction.Exit);
                    break;
            }
        }
        catch (JsonException)
        {
        }
    }

    private void RevealStartupBrowser()
    {
        if (_startupDisposed || !_startupBrowserReady)
        {
            return;
        }
        StartupWebView.Width = double.NaN;
        StartupWebView.Height = double.NaN;
        StartupWebView.HorizontalAlignment = HorizontalAlignment.Stretch;
        StartupWebView.VerticalAlignment = VerticalAlignment.Stretch;
        StartupWebView.IsHitTestVisible = true;
        _startupBrowserRevealed = true;
        StopNativeStartupMedia();
        NativeStartupSurface.Visibility = Visibility.Collapsed;
    }

    private async Task WaitForMinimumStartupDisplayAsync()
    {
        if (!_startupDisplayClock.IsRunning)
        {
            _startupDisplayClock.Start();
        }
        var remaining = MinimumStartupDisplay - _startupDisplayClock.Elapsed;
        if (remaining > TimeSpan.Zero)
        {
            await Task.Delay(remaining, _windowCancellation.Token);
        }
    }

    private void RevealMainBrowser()
    {
        MainWebView.Width = double.NaN;
        MainWebView.Height = double.NaN;
        MainWebView.HorizontalAlignment = HorizontalAlignment.Stretch;
        MainWebView.VerticalAlignment = VerticalAlignment.Stretch;
        MainWebView.IsHitTestVisible = true;
    }

    private void OnStartupWebResourceRequested(
        object? sender,
        CoreWebView2WebResourceRequestedEventArgs eventArgs)
    {
        var core = StartupWebView.CoreWebView2;
        if (core is null)
        {
            return;
        }

        if (Uri.TryCreate(eventArgs.Request.Uri, UriKind.Absolute, out var uri)
            && _embeddedStartupRuntime.TryOpen(uri, out var asset)
            && asset is not null)
        {
            eventArgs.Response = core.Environment.CreateWebResourceResponse(
                asset.Content,
                200,
                "OK",
                $"Content-Type: {asset.ContentType}\r\nCache-Control: no-store");
            return;
        }

        eventArgs.Response = core.Environment.CreateWebResourceResponse(
            new MemoryStream(),
            404,
            "Not Found",
            "Content-Type: text/plain; charset=utf-8\r\nCache-Control: no-store");
    }

    private void DetachStartupResourceHandler()
    {
        if (!_startupResourceEventsAttached || StartupWebView.CoreWebView2 is null)
        {
            return;
        }

        StartupWebView.CoreWebView2.WebResourceRequested -= OnStartupWebResourceRequested;
        StartupWebView.CoreWebView2.RemoveWebResourceRequestedFilter(
            StartupFilter,
            CoreWebView2WebResourceContext.All);
        _startupResourceEventsAttached = false;
    }

    private async Task ExecuteStartupScriptAsync(string script)
    {
        if (_startupDisposed || StartupWebView.CoreWebView2 is null)
        {
            return;
        }
        try
        {
            await StartupWebView.CoreWebView2.ExecuteScriptAsync(script);
        }
        catch (InvalidOperationException)
        {
        }
    }

    private static async Task NavigateAsync(
        CoreWebView2 core,
        Uri target,
        CancellationToken cancellationToken)
    {
        var completion = new TaskCompletionSource<bool>(
            TaskCreationOptions.RunContinuationsAsynchronously);
        void OnCompleted(object? _, CoreWebView2NavigationCompletedEventArgs eventArgs)
        {
            if (eventArgs.IsSuccess)
            {
                completion.TrySetResult(true);
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

    private async void OnClosing(object? sender, CancelEventArgs eventArgs)
    {
        if (_allowClose || _shutdownCoordinator.Phase == ShutdownPhase.Closing)
        {
            return;
        }

        eventArgs.Cancel = true;
        if (Interlocked.Exchange(ref _closeRequestActive, 1) != 0)
        {
            return;
        }

        try
        {
            var intent = RestartRequested
                ? ShutdownIntent.ControlledRestart
                : _systemShutdownRequested
                    ? ShutdownIntent.SystemShutdown
                    : ShutdownIntent.UserClose;
            if (await _shutdownCoordinator.RequestAsync(intent))
            {
                _allowClose = true;
                Close();
            }
        }
        catch (Exception error)
        {
            MessageBox.Show(
                $"Hstar 无法安全关闭。\n\n{error.Message}",
                "Hstar",
                MessageBoxButton.OK,
                MessageBoxImage.Error);
        }
        finally
        {
            Interlocked.Exchange(ref _closeRequestActive, 0);
        }
    }

    private void OnClosed(object? sender, EventArgs eventArgs)
    {
        Closing -= OnClosing;
        SourceInitialized -= OnSourceInitialized;
        _windowCancellation.Cancel();
        StopNativeStartupMedia();
        NativeStartupMedia.MediaOpened -= OnNativeStartupMediaOpened;
        NativeStartupMedia.MediaEnded -= OnNativeStartupMediaEnded;
        NativeStartupMedia.MediaFailed -= OnNativeStartupMediaFailed;
        NativeStartupSurface.Loaded -= OnNativeStartupSurfaceLoaded;
        if (_mainEventsAttached && MainWebView.CoreWebView2 is not null)
        {
            MainWebView.CoreWebView2.NavigationStarting -= OnNavigationStarting;
            MainWebView.CoreWebView2.NewWindowRequested -= OnNewWindowRequested;
            MainWebView.CoreWebView2.WebMessageReceived -= OnMainWebMessageReceived;
        }
        if (!_startupDisposed && StartupWebView.CoreWebView2 is not null)
        {
            StartupWebView.CoreWebView2.WebMessageReceived -= OnStartupWebMessageReceived;
            DetachStartupResourceHandler();
        }
        MainWebView.Dispose();
        if (!_startupDisposed)
        {
            StartupWebView.Dispose();
        }
        _messageGate.Dispose();
        _windowCancellation.Dispose();
    }

    private enum StartupFailureAction
    {
        Retry,
        Exit,
    }
}
