// VITALS launcher - a real Windows executable so the app can be pinned like an app.
//
// The problem it solves: panel.ps1 is hosted by powershell.exe. Windows pins the HOST, so pinning the
// running window produced a "Windows PowerShell" tile with the PowerShell icon. Setting
// SetCurrentProcessExplicitAppUserModelID inside panel.ps1 fixes how the running window GROUPS, but it
// cannot change what a pin resolves to - the pin needs its own identity.
//
// So: a WinExe with the icon compiled in (/win32icon), which declares the SAME AppUserModelID the panel
// declares. Matching IDs are what let Windows treat the tile and the panel window as one application:
// the pin shows the right icon, clicking it starts VITALS, and the live window groups under it instead
// of spawning a second PowerShell tile beside it.
//
// It is a launcher, not a host: it starts the stack and exits. Everything it needs is resolved relative
// to its own folder, so the whole directory stays portable - copy it to a USB stick and it still works.
//
//   csc /target:winexe /win32icon:vitals.ico /out:VITALS.exe launcher.cs

using System;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

static class Launcher
{
    [DllImport("shell32.dll", CharSet = CharSet.Unicode)]
    static extern int SetCurrentProcessExplicitAppUserModelID(string appID);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int MessageBox(IntPtr hWnd, string text, string caption, uint type);

    const string APP_ID = "Ben.Vitals.Panel";   // must match panel.ps1

    [STAThread]
    static int Main(string[] args)
    {
        try { SetCurrentProcessExplicitAppUserModelID(APP_ID); } catch { }

        string here = AppDomain.CurrentDomain.BaseDirectory.TrimEnd('\\');
        string launch = Path.Combine(here, "launch.ps1");

        if (!File.Exists(launch))
        {
            // A launcher that silently does nothing is worse than one that says why. This is the only
            // case that interrupts the user, and it means the folder was moved or split up.
            MessageBox(IntPtr.Zero,
                "launch.ps1 was not found next to VITALS.exe.\n\n" +
                "Expected:\n" + launch + "\n\n" +
                "Keep the whole vitals folder together - the launcher resolves everything relative to itself.",
                "VITALS", 0x10);
            return 2;
        }

        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"" + launch + "\""
                        + (args.Length > 0 ? " " + string.Join(" ", args) : ""),
            WorkingDirectory = here,
            UseShellExecute = false,
            CreateNoWindow = true,          // no console flash on launch
        };

        try
        {
            var p = Process.Start(psi);
            // Give it a moment to fail loudly rather than exiting into silence. launch.ps1 throws if
            // node is missing or the bridge never answers, and that exit code is worth surfacing.
            if (p != null && p.WaitForExit(2500) && p.ExitCode != 0)
            {
                MessageBox(IntPtr.Zero,
                    "VITALS could not start (exit code " + p.ExitCode + ").\n\n" +
                    "Most likely cause: Node.js is not installed or not on PATH.\n" +
                    "Check by running this in a terminal:  node --version\n\n" +
                    "To see the real error, run:\n  powershell -ExecutionPolicy Bypass -File \"" + launch + "\"",
                    "VITALS", 0x10);
                return p.ExitCode;
            }
        }
        catch (Exception ex)
        {
            MessageBox(IntPtr.Zero, "VITALS failed to launch:\n\n" + ex.Message, "VITALS", 0x10);
            return 1;
        }
        return 0;
    }
}
