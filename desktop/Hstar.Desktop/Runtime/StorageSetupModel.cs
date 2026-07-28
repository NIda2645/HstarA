using System.IO;

namespace Hstar.Desktop.Runtime;

public sealed record StorageSetupStatus(
    string NormalizedPath,
    bool CanContinue,
    bool Exists,
    bool IsNonEmpty,
    bool ContainsHstarData,
    long AvailableBytes,
    string Message,
    string Error = "");

public static class StorageSetupModel
{
    public static StorageSetupStatus Inspect(
        string rawPath,
        string programRoot,
        Func<string, long>? availableBytes = null)
    {
        if (string.IsNullOrWhiteSpace(rawPath))
        {
            return Invalid("请输入或选择数据位置。");
        }

        try
        {
            var normalized = Path.GetFullPath(
                Environment.ExpandEnvironmentVariables(rawPath.Trim()));
            AppPaths.ValidateDataRoot(normalized, programRoot);
            var freeBytes = (availableBytes ?? AppPaths.GetAvailableBytes)(normalized);
            if (freeBytes < AppPaths.MinimumDataRootFreeBytes)
            {
                return new StorageSetupStatus(
                    normalized, false, Directory.Exists(normalized), false, false,
                    freeBytes, "可用空间不足 2 GB。", "请更换储存位置。");
            }

            var exists = Directory.Exists(normalized);
            var nonEmpty = exists && Directory.EnumerateFileSystemEntries(normalized).Any();
            var hasHstarData = exists && HasHstarData(normalized);
            var message = hasHstarData
                ? "发现已有 Hstar 数据，将直接使用此位置。"
                : nonEmpty
                    ? "位置可用，现有文件将保持不变。"
                    : exists
                        ? "位置可用。"
                        : "位置可用，确认后将自动创建。";
            return new StorageSetupStatus(
                normalized, true, exists, nonEmpty, hasHstarData,
                freeBytes, message);
        }
        catch (Exception error) when (error is ArgumentException
            or IOException
            or UnauthorizedAccessException
            or NotSupportedException)
        {
            return Invalid(error.Message);
        }
    }

    private static bool HasHstarData(string root) =>
        File.Exists(Path.Combine(root, "data-manifest.json"))
        || Directory.Exists(Path.Combine(root, "data", "canvases"))
        || Directory.Exists(Path.Combine(root, "data", "openshop"))
        || Directory.Exists(Path.Combine(root, "assets"))
        || Directory.Exists(Path.Combine(root, "output"));

    private static StorageSetupStatus Invalid(string error) =>
        new(string.Empty, false, false, false, false, 0, "位置不可用。", error);
}
