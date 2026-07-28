using System.Text.Json;

namespace Hstar.Desktop.Runtime;

internal enum CanvasTheme
{
    Light,
    Dark,
}

internal static class CanvasThemeDetection
{
    internal const string Script = """
        (() => {
          const roots = [document.documentElement, document.body];
          return roots.some(root =>
            root?.classList?.contains('theme-dark')
            || root?.classList?.contains('studio-theme-dark'));
        })()
        """;

    internal static CanvasTheme ParseResult(string? json)
    {
        if (string.IsNullOrWhiteSpace(json))
        {
            return CanvasTheme.Light;
        }

        try
        {
            return JsonSerializer.Deserialize<bool>(json)
                ? CanvasTheme.Dark
                : CanvasTheme.Light;
        }
        catch (JsonException)
        {
            return CanvasTheme.Light;
        }
    }
}
