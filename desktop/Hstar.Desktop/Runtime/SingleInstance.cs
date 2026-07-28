using System.Threading;

namespace Hstar.Desktop.Runtime;

public sealed class SingleInstance : IDisposable
{
    public const string MutexName = @"Local\Hstar.Windows11";

    private readonly Mutex _mutex;
    private readonly EventWaitHandle _shutdownEvent;
    private bool _disposed;

    private SingleInstance(Mutex mutex, EventWaitHandle shutdownEvent, bool isPrimary)
    {
        _mutex = mutex;
        _shutdownEvent = shutdownEvent;
        IsPrimary = isPrimary;
    }

    public bool IsPrimary { get; }

    public static SingleInstance Acquire()
    {
        var mutex = new Mutex(initiallyOwned: true, MutexName, out var createdNew);
        var shutdownEvent = MaintenanceMode.CreateShutdownListener();
        return new SingleInstance(mutex, shutdownEvent, createdNew);
    }

    public async Task WaitForShutdownAsync(CancellationToken cancellationToken)
    {
        ObjectDisposedException.ThrowIf(_disposed, this);
        var completion = new TaskCompletionSource(
            TaskCreationOptions.RunContinuationsAsynchronously);
        RegisteredWaitHandle? registeredWait = null;
        using var cancellation = cancellationToken.Register(
            () => completion.TrySetCanceled(cancellationToken));
        try
        {
            registeredWait = ThreadPool.RegisterWaitForSingleObject(
                _shutdownEvent,
                (_, _) => completion.TrySetResult(),
                null,
                Timeout.Infinite,
                executeOnlyOnce: true);
            await completion.Task.ConfigureAwait(false);
        }
        finally
        {
            registeredWait?.Unregister(null);
        }
    }

    public void Dispose()
    {
        if (_disposed)
        {
            return;
        }

        if (IsPrimary)
        {
            try
            {
                _mutex.ReleaseMutex();
            }
            catch (ApplicationException)
            {
            }
        }

        _shutdownEvent.Dispose();
        _mutex.Dispose();
        _disposed = true;
    }
}
