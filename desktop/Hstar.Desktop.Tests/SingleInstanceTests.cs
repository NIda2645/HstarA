using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class SingleInstanceTests
{
    [Fact]
    public void OnlyTheFirstLeaseOwnsTheWindows11Mutex()
    {
        using var first = SingleInstance.Acquire();
        using var second = SingleInstance.Acquire();

        Assert.True(first.IsPrimary);
        Assert.False(second.IsPrimary);
    }
}
