using System.IO;
using System.Reflection;

namespace Hstar.Desktop.Runtime;

public sealed class EmbeddedStartupRuntime
{
    public const string HostName = "hstar-startup.local";
    public const string ResourcePrefix = "Hstar.Desktop.StartupAssets.";

    private static readonly IReadOnlyDictionary<string, StartupResource> Resources =
        new Dictionary<string, StartupResource>(StringComparer.Ordinal)
        {
            ["/index.html"] = new("index.html", "text/html; charset=utf-8"),
            ["/startup.css"] = new("startup.css", "text/css; charset=utf-8"),
            ["/startup.js"] = new("startup.js", "text/javascript; charset=utf-8"),
            ["/ogl.mjs"] = new("ogl.mjs", "text/javascript; charset=utf-8"),
            ["/ogl.LICENSE.txt"] = new("ogl.LICENSE.txt", "text/plain; charset=utf-8"),
        };

    private readonly Assembly _assembly;

    public EmbeddedStartupRuntime(Assembly assembly)
    {
        _assembly = assembly ?? throw new ArgumentNullException(nameof(assembly));
    }

    public static EmbeddedStartupRuntime CreateApplicationRuntime() =>
        new(typeof(EmbeddedStartupRuntime).Assembly);

    public void ValidateResources()
    {
        foreach (var resource in Resources.Values)
        {
            using var stream = _assembly.GetManifestResourceStream(ResourcePrefix + resource.Name);
            if (stream is null || stream.Length == 0)
            {
                throw new InvalidOperationException(
                    $"Hstar 启动资源缺失：{resource.Name}");
            }
        }
    }

    public bool TryOpen(Uri uri, out EmbeddedStartupAsset? asset)
    {
        asset = null;
        if (!IsApprovedOrigin(uri) || !IsApprovedRawUri(uri))
        {
            return false;
        }

        var escapedPath = uri.GetComponents(UriComponents.Path, UriFormat.UriEscaped);
        var path = "/" + escapedPath;
        if (!Resources.TryGetValue(path, out var resource))
        {
            return false;
        }

        using var embedded = _assembly.GetManifestResourceStream(ResourcePrefix + resource.Name);
        if (embedded is null)
        {
            return false;
        }

        var content = new MemoryStream();
        embedded.CopyTo(content);
        content.Position = 0;
        asset = new EmbeddedStartupAsset(content, resource.ContentType);
        return true;
    }

    private static bool IsApprovedOrigin(Uri uri) =>
        uri.IsAbsoluteUri
        && string.Equals(uri.Scheme, Uri.UriSchemeHttps, StringComparison.OrdinalIgnoreCase)
        && string.Equals(uri.Host, HostName, StringComparison.OrdinalIgnoreCase)
        && uri.IsDefaultPort
        && string.IsNullOrEmpty(uri.UserInfo)
        && string.IsNullOrEmpty(uri.Query)
        && string.IsNullOrEmpty(uri.Fragment);

    private static bool IsApprovedRawUri(Uri uri)
    {
        var raw = uri.OriginalString;
        return !raw.Contains("..", StringComparison.Ordinal)
            && !raw.Contains('\\')
            && !raw.Contains("%2e", StringComparison.OrdinalIgnoreCase)
            && !raw.Contains("%2f", StringComparison.OrdinalIgnoreCase)
            && !raw.Contains("%5c", StringComparison.OrdinalIgnoreCase);
    }

    private sealed record StartupResource(string Name, string ContentType);
}

public sealed record EmbeddedStartupAsset(Stream Content, string ContentType);
