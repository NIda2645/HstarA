using System.IO;
using Microsoft.Web.WebView2.Core;

namespace Hstar.Desktop.Runtime;

public sealed class WebViewEnvironmentFactory
{
    private readonly object _gate = new();
    private Task<CoreWebView2Environment>? _environment;
    private string? _browserExecutableFolder;
    private string? _userDataFolder;

    public Task<CoreWebView2Environment> GetAsync(AppPaths paths)
    {
        ArgumentNullException.ThrowIfNull(paths);
        var browserExecutableFolder = Path.Combine(
            paths.ProgramRoot,
            "runtime",
            "browser",
            "WebView2");
        var userDataFolder = paths.WebViewCacheRoot;

        lock (_gate)
        {
            if (_environment is not null)
            {
                if (!string.Equals(
                        _browserExecutableFolder,
                        browserExecutableFolder,
                        StringComparison.OrdinalIgnoreCase)
                    || !string.Equals(
                        _userDataFolder,
                        userDataFolder,
                        StringComparison.OrdinalIgnoreCase))
                {
                    throw new InvalidOperationException(
                        "同一 Hstar 窗口不能切换 WebView2 运行时或缓存目录。");
                }
                return _environment;
            }

            _browserExecutableFolder = browserExecutableFolder;
            _userDataFolder = userDataFolder;
            Environment.SetEnvironmentVariable(
                "WEBVIEW2_DEFAULT_BACKGROUND_COLOR",
                "FF0A29FF",
                EnvironmentVariableTarget.Process);
            _environment = CoreWebView2Environment.CreateAsync(
                browserExecutableFolder: browserExecutableFolder,
                userDataFolder: userDataFolder);
            return _environment;
        }
    }
}
