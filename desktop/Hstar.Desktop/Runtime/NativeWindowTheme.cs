using System.Runtime.InteropServices;

namespace Hstar.Desktop.Runtime;

internal static class NativeWindowTheme
{
    private const int DwmwaUseImmersiveDarkMode = 20;
    private const int DwmwaUseImmersiveDarkModeBefore20H1 = 19;
    private const int DwmwaBorderColor = 34;
    private const int DwmwaCaptionColor = 35;
    private const int DwmwaTextColor = 36;

    internal static int ToColorRef(byte red, byte green, byte blue) =>
        red | (green << 8) | (blue << 16);

    internal static void TryApplyDarkTitleBar(nint windowHandle)
    {
        if (windowHandle == nint.Zero)
        {
            return;
        }

        try
        {
            var enabled = 1;
            var result = DwmSetWindowAttribute(
                windowHandle,
                DwmwaUseImmersiveDarkMode,
                ref enabled,
                sizeof(int));
            if (result < 0)
            {
                _ = DwmSetWindowAttribute(
                    windowHandle,
                    DwmwaUseImmersiveDarkModeBefore20H1,
                    ref enabled,
                    sizeof(int));
            }

            if (!OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22000))
            {
                return;
            }

            SetColor(windowHandle, DwmwaBorderColor, 0x33, 0x41, 0x55);
            SetColor(windowHandle, DwmwaCaptionColor, 0x11, 0x18, 0x27);
            SetColor(windowHandle, DwmwaTextColor, 0xF8, 0xFA, 0xFC);
        }
        catch (DllNotFoundException)
        {
        }
        catch (EntryPointNotFoundException)
        {
        }
        catch (BadImageFormatException)
        {
        }
    }

    private static void SetColor(
        nint windowHandle,
        int attribute,
        byte red,
        byte green,
        byte blue)
    {
        var color = ToColorRef(red, green, blue);
        _ = DwmSetWindowAttribute(windowHandle, attribute, ref color, sizeof(int));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(
        nint windowHandle,
        int attribute,
        ref int value,
        int valueSize);
}
