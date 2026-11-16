# QA BUG-002 reproduction: runs the screen-observation tests inside a NEW, non-interactive window station (no visible desktop), the condition
# a service or background task is in. Expected: the real-screen tests are SKIPPED with the probe's reason, the synthetic and classification
# tests PASS, nothing fails. Read-only for the desktop; the window station exists only for this child process.
#   powershell -ExecutionPolicy Bypass -File tests\DAsk.Daemon.Tests\run-headless-observation.ps1 -OutFile <log>
param([Parameter(Mandatory = $true)][string]$OutFile)
$ErrorActionPreference = 'Stop'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class HeadlessRunner {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  struct STARTUPINFO { public int cb; public string lpReserved; public string lpDesktop; public string lpTitle; public int dwX, dwY, dwXSize, dwYSize, dwXCountChars, dwYCountChars, dwFillAttribute, dwFlags; public short wShowWindow, cbReserved2; public IntPtr lpReserved2, hStdInput, hStdOutput, hStdError; }
  [StructLayout(LayoutKind.Sequential)] struct PROCESS_INFORMATION { public IntPtr hProcess, hThread; public int dwProcessId, dwThreadId; }
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateWindowStation(string name, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll", SetLastError = true)] static extern IntPtr GetProcessWindowStation();
  [DllImport("user32.dll", SetLastError = true)] static extern bool SetProcessWindowStation(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateDesktop(string name, IntPtr dev, IntPtr mode, int flags, uint access, IntPtr sa);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr h);
  [DllImport("user32.dll")] static extern bool CloseWindowStation(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern bool CreateProcess(string app, string cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string dir, ref STARTUPINFO si, out PROCESS_INFORMATION pi);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr h, out uint code);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "GetUserObjectInformationW")] static extern bool GetUserObjectInformation(IntPtr h, int index, System.Text.StringBuilder info, int len, out int need);
  public static string WindowStationName;
  public static int Run(string cmdLine, string dir) {
    // An unnamed window station (a standard user may not create named ones): Windows names it; that name is read back.
    IntPtr hws = CreateWindowStation(null, 0, 0x10000000 /* GENERIC_ALL */, IntPtr.Zero);
    if (hws == IntPtr.Zero) throw new Exception("CreateWindowStation failed: " + Marshal.GetLastWin32Error());
    var nameBuf = new System.Text.StringBuilder(256); int need;
    if (!GetUserObjectInformation(hws, 2 /* UOI_NAME */, nameBuf, 512, out need)) throw new Exception("window station name: " + Marshal.GetLastWin32Error());
    string ws = nameBuf.ToString();
    WindowStationName = ws;
    IntPtr old = GetProcessWindowStation();
    SetProcessWindowStation(hws);
    IntPtr hd = CreateDesktop("Default", IntPtr.Zero, IntPtr.Zero, 0, 0x10000000 /* GENERIC_ALL */, IntPtr.Zero);
    SetProcessWindowStation(old);
    if (hd == IntPtr.Zero) throw new Exception("CreateDesktop failed: " + Marshal.GetLastWin32Error());
    try {
      var si = new STARTUPINFO(); si.cb = Marshal.SizeOf(si); si.lpDesktop = ws + "\\Default";
      PROCESS_INFORMATION pi;
      if (!CreateProcess(null, cmdLine, IntPtr.Zero, IntPtr.Zero, false, 0x08000000 /* CREATE_NO_WINDOW */, IntPtr.Zero, dir, ref si, out pi))
        throw new Exception("CreateProcess failed: " + Marshal.GetLastWin32Error());
      WaitForSingleObject(pi.hProcess, 900000);
      uint code; GetExitCodeProcess(pi.hProcess, out code);
      CloseHandle(pi.hThread); CloseHandle(pi.hProcess);
      return (int)code;
    } finally { CloseDesktop(hd); CloseWindowStation(hws); }
  }
}
"@
$dir = (Resolve-Path "$PSScriptRoot").Path
$cmd = "cmd.exe /c dotnet test --no-build --filter `"FullyQualifiedName~ScreenObservationTests|FullyQualifiedName~ScreenCaptureHeadlessTests|FullyQualifiedName~Phase7B1bTests.Capture_Failure`" --logger `"console;verbosity=normal`" > `"$OutFile`" 2>&1"
$code = [HeadlessRunner]::Run($cmd, $dir)
"exit code in the non-interactive window station '$([HeadlessRunner]::WindowStationName)': $code"
exit $code
