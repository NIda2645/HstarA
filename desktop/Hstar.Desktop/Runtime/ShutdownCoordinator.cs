namespace Hstar.Desktop.Runtime;

public enum ShutdownIntent
{
    UserClose,
    ControlledRestart,
    SystemShutdown,
}

public enum ShutdownPhase
{
    Running,
    Confirming,
    StoppingBackend,
    Closing,
}

public sealed class ShutdownCoordinator
{
    private readonly SemaphoreSlim _gate = new(1, 1);
    private readonly Func<CancellationToken, Task> _stopBackend;
    private readonly Func<CancellationToken, Task<bool>> _confirmUserClose;

    public ShutdownCoordinator(
        Func<CancellationToken, Task> stopBackend,
        Func<CancellationToken, Task<bool>> confirmUserClose)
    {
        _stopBackend = stopBackend ?? throw new ArgumentNullException(nameof(stopBackend));
        _confirmUserClose = confirmUserClose
            ?? throw new ArgumentNullException(nameof(confirmUserClose));
    }

    public ShutdownPhase Phase { get; private set; } = ShutdownPhase.Running;

    public async Task<bool> RequestAsync(
        ShutdownIntent intent,
        CancellationToken cancellationToken = default)
    {
        await _gate.WaitAsync(cancellationToken).ConfigureAwait(false);
        try
        {
            if (Phase == ShutdownPhase.Closing)
            {
                return true;
            }

            if (intent == ShutdownIntent.UserClose)
            {
                Phase = ShutdownPhase.Confirming;
                if (!await _confirmUserClose(cancellationToken).ConfigureAwait(false))
                {
                    Phase = ShutdownPhase.Running;
                    return false;
                }
            }

            Phase = ShutdownPhase.StoppingBackend;
            try
            {
                await _stopBackend(cancellationToken).ConfigureAwait(false);
            }
            catch
            {
                Phase = ShutdownPhase.Running;
                throw;
            }
            Phase = ShutdownPhase.Closing;
            return true;
        }
        finally
        {
            _gate.Release();
        }
    }
}
