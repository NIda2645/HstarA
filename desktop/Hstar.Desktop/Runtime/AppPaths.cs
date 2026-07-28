using System.IO;
using System.Text;
using System.Text.Json;
using System.Text.Json.Serialization;

namespace Hstar.Desktop.Runtime;

public sealed class AppPaths
{
    public const string Windows11Edition = "windows11";
    public const long MinimumDataRootFreeBytes = 2L * 1024 * 1024 * 1024;

    private static readonly JsonSerializerOptions BootstrapJsonOptions = new()
    {
        WriteIndented = true,
        PropertyNameCaseInsensitive = false,
    };

    private AppPaths(
        string programRoot,
        string dataRoot,
        string appDataRoot,
        string edition,
        BootstrapDocument bootstrap)
    {
        ProgramRoot = programRoot;
        DataRoot = dataRoot;
        AppDataRoot = appDataRoot;
        Edition = edition;
        Bootstrap = bootstrap;
        BootstrapPath = GetBootstrapPath(appDataRoot, edition);
        WebViewCacheRoot = Path.Combine(dataRoot, "cache", "webview2");
        LogRoot = Path.Combine(dataRoot, "logs");
        ModelRoot = Path.Combine(dataRoot, "models");
        TempRoot = Path.Combine(dataRoot, "temp");
    }

    public string ProgramRoot { get; }

    public string DataRoot { get; }

    public string AppDataRoot { get; }

    public string Edition { get; }

    public string BootstrapPath { get; }

    public string WebViewCacheRoot { get; }

    public string LogRoot { get; }

    public string ModelRoot { get; }

    public string TempRoot { get; }

    public BootstrapDocument Bootstrap { get; private set; }

    public static string ResolveProgramRoot() => Path.GetFullPath(AppContext.BaseDirectory);

    public static string ResolveAppDataRoot()
    {
        var appData = Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData);
        if (string.IsNullOrWhiteSpace(appData))
        {
            throw new InvalidOperationException("无法确定当前用户的 AppData 目录。");
        }

        return Path.GetFullPath(appData);
    }

    public static AppPaths Create(
        string programRoot,
        string dataRoot,
        string appDataRoot,
        string edition = Windows11Edition)
    {
        var normalizedEdition = NormalizeEdition(edition);
        var normalizedProgramRoot = NormalizeAbsolutePath(programRoot, nameof(programRoot));
        var normalizedDataRoot = NormalizeAbsolutePath(dataRoot, nameof(dataRoot));
        var normalizedAppDataRoot = NormalizeAbsolutePath(appDataRoot, nameof(appDataRoot));
        ValidateDataRoot(normalizedDataRoot, normalizedProgramRoot);

        var bootstrap = new BootstrapDocument
        {
            SchemaVersion = 1,
            Edition = normalizedEdition,
            DataRoot = normalizedDataRoot,
            Migration = new BootstrapMigration(),
        };
        return new AppPaths(
            normalizedProgramRoot,
            normalizedDataRoot,
            normalizedAppDataRoot,
            normalizedEdition,
            bootstrap);
    }

    public static AppPaths? TryLoad(
        string programRoot,
        string appDataRoot,
        string edition = Windows11Edition)
    {
        var normalizedEdition = NormalizeEdition(edition);
        var normalizedProgramRoot = NormalizeAbsolutePath(programRoot, nameof(programRoot));
        var normalizedAppDataRoot = NormalizeAbsolutePath(appDataRoot, nameof(appDataRoot));
        var bootstrapPath = GetBootstrapPath(normalizedAppDataRoot, normalizedEdition);
        if (!File.Exists(bootstrapPath))
        {
            return null;
        }

        try
        {
            var json = File.ReadAllText(bootstrapPath, Encoding.UTF8);
            var bootstrap = JsonSerializer.Deserialize<BootstrapDocument>(json, BootstrapJsonOptions)
                ?? throw new InvalidDataException("Hstar 启动配置为空。");
            ValidateBootstrap(bootstrap, normalizedEdition, normalizedProgramRoot);
            return new AppPaths(
                normalizedProgramRoot,
                Path.GetFullPath(Environment.ExpandEnvironmentVariables(bootstrap.DataRoot)),
                normalizedAppDataRoot,
                normalizedEdition,
                bootstrap);
        }
        catch (Exception error) when (error is IOException
            or UnauthorizedAccessException
            or JsonException
            or ArgumentException
            or InvalidDataException
            or NotSupportedException)
        {
            QuarantineBootstrap(bootstrapPath);
            return null;
        }
    }

    public static string SelectDefaultDataRoot(
        Func<string, bool>? driveExists = null,
        string? documentsRoot = null)
    {
        driveExists ??= Directory.Exists;
        if (driveExists(@"E:\"))
        {
            return Path.GetFullPath(@"E:\Hstar缓存");
        }
        if (driveExists(@"D:\"))
        {
            return Path.GetFullPath(@"D:\Hstar缓存");
        }

        var documents = documentsRoot;
        if (string.IsNullOrWhiteSpace(documents))
        {
            documents = Environment.GetFolderPath(Environment.SpecialFolder.MyDocuments);
        }
        if (string.IsNullOrWhiteSpace(documents))
        {
            documents = Path.Combine(
                Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
                "Documents");
        }

        return Path.GetFullPath(Path.Combine(documents, "Hstar缓存"));
    }

    public static string GetBootstrapPath(string appDataRoot, string edition = Windows11Edition)
    {
        var normalizedAppDataRoot = NormalizeAbsolutePath(appDataRoot, nameof(appDataRoot));
        return Path.Combine(normalizedAppDataRoot, "Hstar", NormalizeEdition(edition), "bootstrap.json");
    }

    public static void ValidateDataRoot(string dataRoot, string programRoot)
    {
        var normalizedDataRoot = NormalizeAbsolutePath(dataRoot, nameof(dataRoot));
        var normalizedProgramRoot = NormalizeAbsolutePath(programRoot, nameof(programRoot));
        if (IsSameOrDescendant(normalizedDataRoot, normalizedProgramRoot))
        {
            throw new ArgumentException("Hstar 数据目录不能位于程序目录内。", nameof(dataRoot));
        }
    }

    public static long GetAvailableBytes(string path)
    {
        var normalizedPath = NormalizeAbsolutePath(path, nameof(path));
        var root = Path.GetPathRoot(normalizedPath);
        if (string.IsNullOrWhiteSpace(root))
        {
            throw new ArgumentException("无法确定数据目录所在磁盘。", nameof(path));
        }

        return new DriveInfo(root).AvailableFreeSpace;
    }

    public void EnsureDataDirectories()
    {
        Directory.CreateDirectory(DataRoot);
        Directory.CreateDirectory(WebViewCacheRoot);
        Directory.CreateDirectory(LogRoot);
        Directory.CreateDirectory(ModelRoot);
        Directory.CreateDirectory(TempRoot);
    }

    public void SaveBootstrap(
        string lastStartedVersion = "",
        string migrationId = "",
        string migrationStatus = "",
        string previousDataRoot = "")
    {
        EnsureDataDirectories();
        Bootstrap = new BootstrapDocument
        {
            SchemaVersion = 1,
            Edition = Edition,
            DataRoot = DataRoot,
            LastStartedVersion = lastStartedVersion ?? string.Empty,
            Migration = new BootstrapMigration
            {
                Id = migrationId ?? string.Empty,
                Status = migrationStatus ?? string.Empty,
                PreviousDataRoot = string.IsNullOrWhiteSpace(previousDataRoot)
                    ? string.Empty
                    : Path.GetFullPath(previousDataRoot),
            },
        };
        AtomicWriteJson(BootstrapPath, Bootstrap);
    }

    private static void ValidateBootstrap(
        BootstrapDocument bootstrap,
        string expectedEdition,
        string programRoot)
    {
        if (bootstrap.SchemaVersion != 1)
        {
            throw new InvalidDataException("不支持的 Hstar 启动配置版本。");
        }
        if (!string.Equals(bootstrap.Edition, expectedEdition, StringComparison.Ordinal))
        {
            throw new InvalidDataException("Hstar 安装版本与启动配置不匹配。");
        }
        if (string.IsNullOrWhiteSpace(bootstrap.DataRoot) || !Path.IsPathFullyQualified(bootstrap.DataRoot))
        {
            throw new InvalidDataException("Hstar 数据目录必须是绝对路径。");
        }
        if (bootstrap.Migration is null)
        {
            throw new InvalidDataException("Hstar 数据迁移状态缺失。");
        }

        ValidateDataRoot(bootstrap.DataRoot, programRoot);
    }

    private static string NormalizeAbsolutePath(string path, string parameterName)
    {
        if (string.IsNullOrWhiteSpace(path))
        {
            throw new ArgumentException("路径不能为空。", parameterName);
        }

        var expanded = Environment.ExpandEnvironmentVariables(path.Trim());
        if (!Path.IsPathFullyQualified(expanded))
        {
            throw new ArgumentException("路径必须是绝对路径。", parameterName);
        }

        return Path.GetFullPath(expanded);
    }

    private static string NormalizeEdition(string edition)
    {
        var normalized = (edition ?? string.Empty).Trim().ToLowerInvariant();
        if (normalized.Length == 0
            || normalized.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-'))
        {
            throw new ArgumentException("Hstar edition 无效。", nameof(edition));
        }

        return normalized;
    }

    private static bool IsSameOrDescendant(string candidate, string parent)
    {
        var normalizedCandidate = Path.TrimEndingDirectorySeparator(Path.GetFullPath(candidate));
        var normalizedParent = Path.TrimEndingDirectorySeparator(Path.GetFullPath(parent));
        if (string.Equals(normalizedCandidate, normalizedParent, StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }

        return normalizedCandidate.StartsWith(
            normalizedParent + Path.DirectorySeparatorChar,
            StringComparison.OrdinalIgnoreCase);
    }

    private static void AtomicWriteJson(string path, BootstrapDocument document)
    {
        var directory = Path.GetDirectoryName(path)
            ?? throw new InvalidOperationException("启动配置目录无效。");
        Directory.CreateDirectory(directory);
        var temporaryPath = Path.Combine(
            directory,
            $".{Path.GetFileName(path)}.{Guid.NewGuid():N}.tmp");
        try
        {
            var payload = JsonSerializer.Serialize(document, BootstrapJsonOptions) + Environment.NewLine;
            var bytes = new UTF8Encoding(encoderShouldEmitUTF8Identifier: false).GetBytes(payload);
            using (var stream = new FileStream(
                temporaryPath,
                FileMode.CreateNew,
                FileAccess.Write,
                FileShare.None,
                bufferSize: 16 * 1024,
                FileOptions.WriteThrough))
            {
                stream.Write(bytes);
                stream.Flush(flushToDisk: true);
            }
            File.Move(temporaryPath, path, overwrite: true);
        }
        finally
        {
            File.Delete(temporaryPath);
        }
    }

    private static void QuarantineBootstrap(string bootstrapPath)
    {
        if (!File.Exists(bootstrapPath))
        {
            return;
        }

        var timestamp = DateTimeOffset.UtcNow.ToString("yyyyMMdd-HHmmss");
        var destination = $"{bootstrapPath}.corrupt-{timestamp}";
        var suffix = 1;
        while (File.Exists(destination))
        {
            destination = $"{bootstrapPath}.corrupt-{timestamp}-{suffix++}";
        }

        try
        {
            File.Move(bootstrapPath, destination);
        }
        catch (IOException)
        {
        }
        catch (UnauthorizedAccessException)
        {
        }
    }
}

public sealed class BootstrapDocument
{
    [JsonPropertyName("schemaVersion")]
    public int SchemaVersion { get; init; }

    [JsonPropertyName("edition")]
    public string Edition { get; init; } = string.Empty;

    [JsonPropertyName("dataRoot")]
    public string DataRoot { get; init; } = string.Empty;

    [JsonPropertyName("lastStartedVersion")]
    public string LastStartedVersion { get; init; } = string.Empty;

    [JsonPropertyName("migration")]
    public BootstrapMigration Migration { get; init; } = new();
}

public sealed class BootstrapMigration
{
    [JsonPropertyName("id")]
    public string Id { get; init; } = string.Empty;

    [JsonPropertyName("status")]
    public string Status { get; init; } = string.Empty;

    [JsonPropertyName("previousDataRoot")]
    public string PreviousDataRoot { get; init; } = string.Empty;
}
