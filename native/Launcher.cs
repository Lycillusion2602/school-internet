// ============================================================
//  schoolnet hidden-window launcher
//  A tiny WinExe (no console subsystem) that starts the Node
//  daemon directly, with NO visible window.
//
//  Why a compiled exe instead of a .vbs?
//    Windows Script Host is unavailable/broken on some machines
//    (cscript/wscript fail with "not enough memory resources").
//    A WinExe has no console at all, so nothing ever flashes.
//
//  Note: the Node daemon writes its own logs (logs\schoolnet-*.log),
//  so we start node directly and let it inherit no handles.
//
//  Build:
//    node scripts\build-launcher.js
//
//  Usage:  schoolnet-daemon.exe [nodePath] [--wait]
//    nodePath  optional explicit path to node.exe (default: "node")
//    --wait    block until the daemon exits (used by Task Scheduler)
// ============================================================
using System;
using System.Diagnostics;
using System.IO;

class SchoolNetLauncher
{
    static int Main(string[] args)
    {
        string nodeExe = "node";
        bool wait = false;
        foreach (string a in args)
        {
            if (string.Equals(a, "--wait", StringComparison.OrdinalIgnoreCase)) wait = true;
            else if (!a.StartsWith("-")) nodeExe = a;
        }

        // exe lives in <root>\bin ; project root is one level up
        string exeDir = AppDomain.CurrentDomain.BaseDirectory;
        string root = Path.GetFullPath(Path.Combine(exeDir, ".."));
        string cli = Path.Combine(root, "src", "cli.js");
        string logDir = Path.Combine(root, "logs");
        Directory.CreateDirectory(logDir);
        string errLog = Path.Combine(logDir, "launcher.err.log");

        if (!File.Exists(cli))
        {
            TryAppend(errLog, "cannot find " + cli);
            return 2;
        }

        var psi = new ProcessStartInfo();
        psi.FileName = nodeExe;
        psi.Arguments = "\"" + cli + "\" daemon";
        psi.WorkingDirectory = root;
        psi.UseShellExecute = false;   // required for CreateNoWindow
        psi.CreateNoWindow = true;     // no console window
        psi.WindowStyle = ProcessWindowStyle.Hidden;

        try
        {
            var p = Process.Start(psi);
            if (wait)
            {
                p.WaitForExit();
                // 退出码 3 = 单实例锁拒绝（已有守护进程在运行）。
                // 对计划任务而言，"守护进程已在运行"即可视为成功，故映射为 0，
                // 避免任务因非零退出码而反复重启。
                return p.ExitCode == 3 ? 0 : p.ExitCode;
            }
            return 0;
        }
        catch (Exception e)
        {
            TryAppend(errLog, "failed to start daemon: " + e.Message);
            return 1;
        }
    }

    static void TryAppend(string path, string line)
    {
        try { File.AppendAllText(path, DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss") + " " + line + Environment.NewLine); }
        catch { }
    }
}
