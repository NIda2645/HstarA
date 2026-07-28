using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class StartupStateMachineTests
{
    [Fact]
    public void OverlayCanExitOnlyForCurrentInteractiveNavigation()
    {
        var state = new StartupStateMachine();
        state.MarkVisualReady();
        state.MarkBackendReady();
        state.BeginMainNavigation("nav-current");

        Assert.False(state.AcceptInteractive("nav-old", schemaVersion: 1));
        Assert.False(state.AcceptInteractive("nav-current", schemaVersion: 2));
        Assert.True(state.AcceptInteractive("nav-current", schemaVersion: 1));
        Assert.Equal(StartupPhase.MainInteractive, state.Phase);
    }

    [Fact]
    public void RetryStartsASeparateNavigationGeneration()
    {
        var state = new StartupStateMachine();
        state.MarkVisualReady();
        state.MarkBackendReady();
        state.BeginMainNavigation("nav-first");
        state.Fail("navigation failed");

        state.BeginRetry("nav-retry");

        Assert.Equal(StartupPhase.MainLoading, state.Phase);
        Assert.False(state.AcceptInteractive("nav-first", schemaVersion: 1));
        Assert.True(state.AcceptInteractive("nav-retry", schemaVersion: 1));
    }
}
