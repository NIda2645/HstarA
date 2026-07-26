using System.Net;
using System.Net.Sockets;

namespace Hstar.Desktop.Runtime;

public sealed class PortAllocator : IDisposable
{
    public const int PreferredPort = 5000;
    public const int LastFallbackPort = 5099;

    private TcpListener? _reservation;

    private PortAllocator(TcpListener reservation, int selectedPort)
    {
        _reservation = reservation;
        SelectedPort = selectedPort;
    }

    public int SelectedPort { get; }

    public static PortAllocator Reserve()
    {
        for (var port = PreferredPort; port <= LastFallbackPort; port++)
        {
            var listener = new TcpListener(IPAddress.Loopback, port);
            listener.Server.ExclusiveAddressUse = true;
            try
            {
                listener.Start();
                return new PortAllocator(listener, port);
            }
            catch (SocketException)
            {
                listener.Dispose();
            }
        }

        throw new InvalidOperationException("Hstar 无法在 5000-5099 范围内找到可用端口。");
    }

    public void Release()
    {
        _reservation?.Stop();
        _reservation = null;
    }

    public void Dispose() => Release();
}
