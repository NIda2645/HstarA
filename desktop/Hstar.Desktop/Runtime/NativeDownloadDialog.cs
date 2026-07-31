using System.IO;
using System.Windows;
using Microsoft.Win32;

namespace Hstar.Desktop.Runtime;

internal static class NativeDownloadDialog
{
    public static bool TryChooseFolder(Window owner, out string selectedFolder)
    {
        var dialog = new OpenFolderDialog
        {
            Title = "选择批量保存位置",
            Multiselect = false,
        };
        if (dialog.ShowDialog(owner) == true)
        {
            selectedFolder = dialog.FolderName;
            return true;
        }

        selectedFolder = string.Empty;
        return false;
    }

    public static bool TryChoosePath(
        Window owner,
        string? suggestedPath,
        out string selectedPath)
    {
        var fileName = SafeFileName(suggestedPath);
        var extension = Path.GetExtension(fileName).ToLowerInvariant();
        var dialog = new SaveFileDialog
        {
            Title = "保存到",
            FileName = fileName,
            DefaultExt = extension.TrimStart('.'),
            Filter = BuildFilter(extension),
            AddExtension = true,
            OverwritePrompt = true,
            CheckPathExists = true,
            RestoreDirectory = true,
        };

        var initialDirectory = SafeInitialDirectory(suggestedPath);
        if (initialDirectory is not null)
        {
            dialog.InitialDirectory = initialDirectory;
        }

        if (dialog.ShowDialog(owner) == true)
        {
            selectedPath = dialog.FileName;
            return true;
        }

        selectedPath = string.Empty;
        return false;
    }

    internal static string SafeFileName(string? suggestedPath)
    {
        string candidate;
        try
        {
            candidate = Path.GetFileName(suggestedPath ?? string.Empty);
        }
        catch (ArgumentException)
        {
            candidate = string.Empty;
        }

        candidate = string.Concat((candidate ?? string.Empty).Select(character =>
            Path.GetInvalidFileNameChars().Contains(character) ? '_' : character));
        return string.IsNullOrWhiteSpace(candidate) || candidate is "." or ".."
            ? "download"
            : candidate;
    }

    public static string UniqueFilePath(
        string folder,
        string fileName,
        ISet<string> reservedPaths)
    {
        var safeName = SafeFileName(fileName);
        var stem = Path.GetFileNameWithoutExtension(safeName);
        var extension = Path.GetExtension(safeName);
        var candidate = Path.Combine(folder, safeName);
        var suffix = 2;
        while (File.Exists(candidate) || reservedPaths.Contains(candidate))
        {
            candidate = Path.Combine(folder, $"{stem} ({suffix}){extension}");
            suffix += 1;
        }
        reservedPaths.Add(candidate);
        return candidate;
    }

    private static string? SafeInitialDirectory(string? suggestedPath)
    {
        try
        {
            var directory = Path.GetDirectoryName(suggestedPath ?? string.Empty);
            return !string.IsNullOrWhiteSpace(directory) && Directory.Exists(directory)
                ? directory
                : null;
        }
        catch (ArgumentException)
        {
            return null;
        }
    }

    private static string BuildFilter(string extension)
    {
        var label = extension switch
        {
            ".png" => "PNG 图片",
            ".jpg" or ".jpeg" => "JPEG 图片",
            ".webp" => "WebP 图片",
            ".gif" => "GIF 图片",
            ".svg" => "SVG 图片",
            ".mp4" => "MP4 视频",
            ".webm" => "WebM 视频",
            ".mov" => "MOV 视频",
            ".zip" => "ZIP 压缩包",
            ".pdf" => "PDF 文档",
            ".psd" => "Photoshop 文档",
            ".json" => "JSON 文件",
            _ => string.Empty,
        };
        return string.IsNullOrEmpty(label)
            ? "所有文件 (*.*)|*.*"
            : $"{label} (*{extension})|*{extension}|所有文件 (*.*)|*.*";
    }
}
