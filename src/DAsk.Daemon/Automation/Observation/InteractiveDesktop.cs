using System.Runtime.InteropServices;
using System.Text;

namespace DAsk.Daemon.Automation.Observation;

/// <summary>
/// QA BUG-002 (2026-11-16): whether this process can see an interactive desktop at all. The screen cannot be captured when the process
/// runs in a non-interactive window station (a service or a scheduled task without "run only when logged on"), or when the input desktop
/// is not the user's normal desktop (the session is locked, the secure desktop of a UAC/Ctrl+Alt+Del prompt is showing, or the session is
/// disconnected). Read-only: it opens the input desktop for reading object information only and closes it again.
/// </summary>
public static class InteractiveDesktop
{
    public sealed record State(bool Interactive, string? Reason);

    private const int UOI_FLAGS = 1, UOI_NAME = 2, WSF_VISIBLE = 1;
    private const uint DESKTOP_READOBJECTS = 0x0001;

    [StructLayout(LayoutKind.Sequential)]
    private struct USEROBJECTFLAGS { public int fInherit; public int fReserved; public int dwFlags; }

    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll", SetLastError = true)] private static extern bool GetUserObjectInformation(IntPtr hObj, int nIndex, ref USEROBJECTFLAGS pvInfo, int nLength, out int lpnLengthNeeded);
    [DllImport("user32.dll", SetLastError = true, CharSet = CharSet.Unicode, EntryPoint = "GetUserObjectInformationW")]
    private static extern bool GetUserObjectName(IntPtr hObj, int nIndex, StringBuilder pvInfo, int nLength, out int lpnLengthNeeded);
    [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr OpenInputDesktop(uint dwFlags, bool fInherit, uint dwDesiredAccess);
    [DllImport("user32.dll", SetLastError = true)] private static extern bool CloseDesktop(IntPtr hDesktop);

    public static State Probe()
    {
        try
        {
            var ws = GetProcessWindowStation();
            var flags = new USEROBJECTFLAGS();
            if (ws != IntPtr.Zero && GetUserObjectInformation(ws, UOI_FLAGS, ref flags, Marshal.SizeOf<USEROBJECTFLAGS>(), out _) && (flags.dwFlags & WSF_VISIBLE) == 0)
                return new(false, "this process runs in a non-interactive window station (a service or background task session has no visible desktop)");
            var desk = OpenInputDesktop(0, false, DESKTOP_READOBJECTS);
            if (desk == IntPtr.Zero)
                return new(false, $"the input desktop cannot be opened (Win32 error {Marshal.GetLastWin32Error()}: the session is locked, on a secure desktop, or disconnected)");
            try
            {
                var name = new StringBuilder(256);
                if (GetUserObjectName(desk, UOI_NAME, name, name.Capacity * 2, out _) && !string.Equals(name.ToString(), "Default", StringComparison.OrdinalIgnoreCase))
                    return new(false, $"the active desktop is \"{name}\", not the user's desktop (the session is locked or a secure prompt is showing)");
            }
            finally { CloseDesktop(desk); }
            return new(true, null);
        }
        catch (Exception ex) when (ex is DllNotFoundException or EntryPointNotFoundException)
        {
            return new(false, $"the desktop could not be queried ({ex.GetType().Name})");
        }
    }
}
