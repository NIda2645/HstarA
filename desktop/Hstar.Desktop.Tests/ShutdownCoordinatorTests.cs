using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class ShutdownCoordinatorTests
{
    [Fact]
    public async Task CancelledUserCloseLeavesBackendRunning()
    {
        var stopCalls = 0;
        var coordinator = new ShutdownCoordinator(
            _ =>
            {
                stopCalls += 1;
                return Task.CompletedTask;
            },
            _ => Task.FromResult(false));

        var accepted = await coordinator.RequestAsync(ShutdownIntent.UserClose);

        Assert.False(accepted);
        Assert.Equal(0, stopCalls);
        Assert.Equal(ShutdownPhase.Running, coordinator.Phase);
    }

    [Fact]
    public async Task ControlledRestartBypassesPromptAndStopsBackendOnce()
    {
        var prompts = 0;
        var stopCalls = 0;
        var coordinator = new ShutdownCoordinator(
            _ =>
            {
                stopCalls += 1;
                return Task.CompletedTask;
            },
            _ =>
            {
                prompts += 1;
                return Task.FromResult(true);
            });

        var accepted = await coordinator.RequestAsync(ShutdownIntent.ControlledRestart);

        Assert.True(accepted);
        Assert.Equal(0, prompts);
        Assert.Equal(1, stopCalls);
        Assert.Equal(ShutdownPhase.Closing, coordinator.Phase);
    }

    [Fact]
    public async Task ConfirmedUserClosePromptsAndStopsBackendOnce()
    {
        var prompts = 0;
        var stopCalls = 0;
        var coordinator = new ShutdownCoordinator(
            _ =>
            {
                stopCalls += 1;
                return Task.CompletedTask;
            },
            _ =>
            {
                prompts += 1;
                return Task.FromResult(true);
            });

        Assert.True(await coordinator.RequestAsync(ShutdownIntent.UserClose));
        Assert.Equal(1, prompts);
        Assert.Equal(1, stopCalls);
        Assert.Equal(ShutdownPhase.Closing, coordinator.Phase);
    }
}
