using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class SingleInstanceTests
{
    [Fact]
    public void OnlyTheFirstLeaseOwnsTheWindows11Mutex()
    {
        var runId = Guid.NewGuid().ToString("N");
        var mutexName = $@"{SingleInstance.MutexName}.Tests.{runId}";
        var shutdownEventName = $@"{MaintenanceMode.ShutdownEventName}.Tests.{runId}";
        using var first = SingleInstance.Acquire(mutexName, shutdownEventName);
        using var second = SingleInstance.Acquire(mutexName, shutdownEventName);

        Assert.True(first.IsPrimary);
        Assert.False(second.IsPrimary);
    }
}
