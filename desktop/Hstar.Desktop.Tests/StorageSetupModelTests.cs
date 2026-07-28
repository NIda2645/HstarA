using Hstar.Desktop.Runtime;
using Xunit;

namespace Hstar.Desktop.Tests;

public sealed class StorageSetupModelTests : IDisposable
{
    private readonly string _root = Path.Combine(
        Path.GetTempPath(),
        $"hstar-storage-setup-tests-{Guid.NewGuid():N}");

    [Fact]
    public void ExistingNonEmptyDirectoryIsAllowedWithoutMigration()
    {
        var programRoot = Path.Combine(_root, "Program");
        var target = Path.Combine(_root, "Existing");
        Directory.CreateDirectory(target);
        File.WriteAllText(Path.Combine(target, "existing.txt"), "keep");

        var status = StorageSetupModel.Inspect(
            target,
            programRoot,
            _ => 10L * 1024 * 1024 * 1024);

        Assert.True(status.CanContinue);
        Assert.True(status.Exists);
        Assert.True(status.IsNonEmpty);
        Assert.False(status.ContainsHstarData);
        Assert.Contains("现有文件", status.Message);
    }

    [Fact]
    public void ExistingHstarDirectoryIsDetectedAndAllowedDirectly()
    {
        var programRoot = Path.Combine(_root, "Program");
        var target = Path.Combine(_root, "ExistingHstar");
        Directory.CreateDirectory(Path.Combine(target, "data", "canvases"));

        var status = StorageSetupModel.Inspect(
            target,
            programRoot,
            _ => 10L * 1024 * 1024 * 1024);

        Assert.True(status.CanContinue);
        Assert.True(status.ContainsHstarData);
        Assert.Contains("已有 Hstar 数据", status.Message);
    }

    [Fact]
    public void InspectingMissingDirectoryDoesNotCreateIt()
    {
        var target = Path.Combine(_root, "NotCreatedYet");

        var status = StorageSetupModel.Inspect(
            target,
            Path.Combine(_root, "Program"),
            _ => 10L * 1024 * 1024 * 1024);

        Assert.True(status.CanContinue);
        Assert.False(status.Exists);
        Assert.False(Directory.Exists(target));
        Assert.Contains("自动创建", status.Message);
    }

    public void Dispose()
    {
        if (Directory.Exists(_root))
        {
            Directory.Delete(_root, recursive: true);
        }
    }
}
