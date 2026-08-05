using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Text.Json;

namespace Hstar.Desktop.Runtime;

public enum WebPopupDisposition
{
    Deny,
    NavigateSameView,
    OpenExternalBrowser,
}

public sealed record DownloadBatchRequest(
    string RequestId,
    IReadOnlyList<string> FileNames);

public static class WebViewDownloadPermissionPolicy
{
    public static bool ShouldAllow(
        Uri? requestUri,
        WebViewConfiguration configuration,
        bool hasPendingBatch) =>
        hasPendingBatch && configuration.IsAllowedNavigation(requestUri);
}

public static class WebViewMicrophonePermissionPolicy
{
    public static bool ShouldAllow(
        Uri? requestUri,
        WebViewConfiguration configuration) =>
        configuration.IsAllowedNavigation(requestUri);
}

public sealed class WebViewConfiguration
{
    private WebViewConfiguration(
        AppPaths paths,
        Uri backendBaseUri,
        string shellToken,
        string navigationId)
    {
        Paths = paths;
        BackendBaseUri = backendBaseUri;
        BrowserExecutableFolder = Path.Combine(
            paths.ProgramRoot,
            "runtime",
            "browser",
            "WebView2");
        UserDataFolder = paths.WebViewCacheRoot;
        NavigationId = navigationId;
        var startUri = new UriBuilder(backendBaseUri)
        {
            Query = $"hstar_shell_token={Uri.EscapeDataString(shellToken)}",
        };
        StartUri = startUri.Uri;
    }

    public AppPaths Paths { get; }

    public Uri BackendBaseUri { get; }

    public string BrowserExecutableFolder { get; }

    public string UserDataFolder { get; }

    public Uri StartUri { get; }

    public string NavigationId { get; }

    public static WebViewConfiguration Create(
        AppPaths paths,
        Uri backendBaseUri,
        string shellToken,
        string? navigationId = null)
    {
        ArgumentNullException.ThrowIfNull(paths);
        ArgumentNullException.ThrowIfNull(backendBaseUri);
        if (!backendBaseUri.IsAbsoluteUri
            || !string.Equals(backendBaseUri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase)
            || !IsLoopbackHost(backendBaseUri.Host))
        {
            throw new ArgumentException("Hstar WebView 后端地址必须是 loopback HTTP 地址。", nameof(backendBaseUri));
        }
        if (string.IsNullOrWhiteSpace(shellToken))
        {
            throw new ArgumentException("Hstar WebView 会话令牌不能为空。", nameof(shellToken));
        }
        navigationId = string.IsNullOrWhiteSpace(navigationId)
            ? Guid.NewGuid().ToString("N")
            : navigationId.Trim();
        return new WebViewConfiguration(paths, backendBaseUri, shellToken, navigationId);
    }

    public bool IsAllowedNavigation(Uri? uri) =>
        uri is { IsAbsoluteUri: true }
        && SameOrigin(uri, BackendBaseUri);

    public WebPopupDisposition ClassifyPopup(Uri? uri)
    {
        if (IsAllowedNavigation(uri))
        {
            return WebPopupDisposition.NavigateSameView;
        }
        return ExternalBrowserPolicy.IsAllowed(uri)
            ? WebPopupDisposition.OpenExternalBrowser
            : WebPopupDisposition.Deny;
    }

    private static bool SameOrigin(Uri candidate, Uri expected) =>
        string.Equals(candidate.Scheme, expected.Scheme, StringComparison.OrdinalIgnoreCase)
        && string.Equals(candidate.Host, expected.Host, StringComparison.OrdinalIgnoreCase)
        && candidate.Port == expected.Port;

    private static bool IsLoopbackHost(string host)
    {
        if (string.Equals(host, "localhost", StringComparison.OrdinalIgnoreCase))
        {
            return true;
        }
        return IPAddress.TryParse(host, out var address) && IPAddress.IsLoopback(address);
    }
}

public static class ExternalBrowserPolicy
{
    public static bool IsAllowed(Uri? uri) =>
        uri is { IsAbsoluteUri: true }
        && !uri.IsLoopback
        && (string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
            || string.Equals(uri.Scheme, Uri.UriSchemeHttp, StringComparison.OrdinalIgnoreCase));

    public static bool TryOpen(Uri uri)
    {
        if (!IsAllowed(uri))
        {
            return false;
        }
        try
        {
            Process.Start(new ProcessStartInfo
            {
                FileName = uri.AbsoluteUri,
                UseShellExecute = true,
            });
            return true;
        }
        catch (Exception error) when (error is Win32Exception or InvalidOperationException)
        {
            return false;
        }
    }
}

public sealed class WebViewMessageRouter
{
    private readonly WebViewConfiguration _configuration;
    private readonly Func<string, CancellationToken, Task> _restart;
    private readonly Func<string, CancellationToken, Task> _interactive;
    private readonly Func<DownloadBatchRequest, CancellationToken, Task> _downloadBatch;

    public WebViewMessageRouter(
        WebViewConfiguration configuration,
        Func<string, CancellationToken, Task> restart,
        Func<string, CancellationToken, Task>? interactive = null,
        Func<DownloadBatchRequest, CancellationToken, Task>? downloadBatch = null)
    {
        _configuration = configuration;
        _restart = restart;
        _interactive = interactive ?? ((_, _) => Task.CompletedTask);
        _downloadBatch = downloadBatch ?? ((_, _) => Task.CompletedTask);
    }

    public async Task<bool> TryHandleAsync(
        string source,
        string messageJson,
        CancellationToken cancellationToken = default)
    {
        if (!Uri.TryCreate(source, UriKind.Absolute, out var sourceUri)
            || !_configuration.IsAllowedNavigation(sourceUri))
        {
            return false;
        }

        try
        {
            using var message = JsonDocument.Parse(messageJson);
            var root = message.RootElement;
            if (root.ValueKind != JsonValueKind.Object
                || !root.TryGetProperty("type", out var typeElement)
                || !root.TryGetProperty("schemaVersion", out var schemaElement)
                || schemaElement.ValueKind != JsonValueKind.Number
                || !schemaElement.TryGetInt32(out var schemaVersion)
                || schemaVersion != 1)
            {
                return false;
            }

            var type = typeElement.GetString();
            if (type == "hstar:interactive")
            {
                if (!root.TryGetProperty("navigationId", out var navigationElement)
                    || navigationElement.ValueKind != JsonValueKind.String)
                {
                    return false;
                }
                var navigationId = navigationElement.GetString() ?? string.Empty;
                if (!string.Equals(
                    navigationId,
                    _configuration.NavigationId,
                    StringComparison.Ordinal))
                {
                    return false;
                }
                await _interactive(navigationId, cancellationToken);
                return true;
            }

            if (type == "hstar:download-batch")
            {
                if (!root.TryGetProperty("requestId", out var requestElement)
                    || requestElement.ValueKind != JsonValueKind.String
                    || !Guid.TryParse(requestElement.GetString(), out _)
                    || !root.TryGetProperty("fileNames", out var filesElement)
                    || filesElement.ValueKind != JsonValueKind.Array)
                {
                    return false;
                }

                var fileNames = new List<string>();
                foreach (var fileElement in filesElement.EnumerateArray())
                {
                    if (fileElement.ValueKind != JsonValueKind.String
                        || fileNames.Count >= 500)
                    {
                        return false;
                    }
                    var fileName = fileElement.GetString()?.Trim() ?? string.Empty;
                    if (fileName.Length is < 1 or > 180
                        || fileName is "." or ".."
                        || !string.Equals(Path.GetFileName(fileName), fileName, StringComparison.Ordinal))
                    {
                        return false;
                    }
                    fileNames.Add(fileName);
                }
                if (fileNames.Count == 0)
                {
                    return false;
                }

                await _downloadBatch(
                    new DownloadBatchRequest(requestElement.GetString()!, fileNames),
                    cancellationToken);
                return true;
            }

            if (type != "hstar:restart-with-data-root"
                || !root.TryGetProperty("dataRoot", out var dataRootElement))
            {
                return false;
            }

            var dataRoot = dataRootElement.GetString()?.Trim() ?? string.Empty;
            if (!Path.IsPathFullyQualified(dataRoot))
            {
                return false;
            }
            dataRoot = Path.GetFullPath(dataRoot);
            AppPaths.ValidateDataRoot(dataRoot, _configuration.Paths.ProgramRoot);
            await _restart(dataRoot, cancellationToken);
            return true;
        }
        catch (Exception error) when (error is JsonException
            or ArgumentException
            or NotSupportedException
            or PathTooLongException)
        {
            return false;
        }
    }
}
