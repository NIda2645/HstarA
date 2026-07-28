using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class NativeWindowThemeTests
{
    [Fact]
    public void ToColorRefUsesWindowsBgrByteOrder()
    {
        Assert.Equal(0x00271811, NativeWindowTheme.ToColorRef(0x11, 0x18, 0x27));
    }

    [Fact]
    public void ZeroWindowHandleIsANonFatalNoOp()
    {
        NativeWindowTheme.TryApplyDarkTitleBar(nint.Zero);
    }
}
