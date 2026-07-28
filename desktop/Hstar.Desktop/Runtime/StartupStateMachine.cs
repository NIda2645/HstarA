namespace Hstar.Desktop.Runtime;

public enum StartupPhase
{
    WindowVisible,
    StartupVisualReady,
    BackendStarting,
    MainLoading,
    MainInteractive,
    StartupVisualDisposed,
    Failed,
}

public sealed class StartupStateMachine
{
    private string _navigationId = string.Empty;

    public StartupPhase Phase { get; private set; } = StartupPhase.WindowVisible;

    public string FailureReason { get; private set; } = string.Empty;

    public void MarkVisualReady()
    {
        EnsureNotDisposed();
        Phase = StartupPhase.StartupVisualReady;
    }

    public void MarkBackendReady()
    {
        EnsureNotDisposed();
        Phase = StartupPhase.BackendStarting;
    }

    public void BeginMainNavigation(string navigationId)
    {
        if (string.IsNullOrWhiteSpace(navigationId))
        {
            throw new ArgumentException("导航代次不能为空。", nameof(navigationId));
        }
        EnsureNotDisposed();
        _navigationId = navigationId;
        FailureReason = string.Empty;
        Phase = StartupPhase.MainLoading;
    }

    public bool AcceptInteractive(string navigationId, int schemaVersion)
    {
        if (Phase != StartupPhase.MainLoading
            || schemaVersion != 1
            || !string.Equals(navigationId, _navigationId, StringComparison.Ordinal))
        {
            return false;
        }
        Phase = StartupPhase.MainInteractive;
        return true;
    }

    public void MarkVisualDisposed()
    {
        if (Phase != StartupPhase.MainInteractive)
        {
            throw new InvalidOperationException("主界面尚未就绪，不能释放启动画面。");
        }
        Phase = StartupPhase.StartupVisualDisposed;
    }

    public void Fail(string reason)
    {
        FailureReason = string.IsNullOrWhiteSpace(reason) ? "Hstar 启动失败。" : reason.Trim();
        Phase = StartupPhase.Failed;
    }

    public void BeginRetry(string navigationId)
    {
        if (Phase != StartupPhase.Failed)
        {
            throw new InvalidOperationException("只有启动失败后才能重试。");
        }
        BeginMainNavigation(navigationId);
    }

    private void EnsureNotDisposed()
    {
        if (Phase == StartupPhase.StartupVisualDisposed)
        {
            throw new InvalidOperationException("启动画面已经释放。");
        }
    }
}
