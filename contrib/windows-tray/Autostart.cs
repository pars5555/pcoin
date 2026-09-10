// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Turning "start with Windows" off, and having it actually stay off.
//
// WHY THIS FILE EXISTS. There are up to THREE autostart mechanisms and Windows
// shows you one of them:
//
//   1. a shortcut in the user's Startup folder, and
//   2. any OTHER shortcut someone has dropped in that folder pointing at the
//      same exe -- on a real fleet PC that was `PCoin.lnk`, the desktop icon,
//      copied there by someone; it starts the app exactly as well as ours, and
//   3. a scheduled task named PCoinMiner with an AtLogOn trigger.
//
// Task Manager's "Startup apps" tab lists the shortcuts and does NOT list the
// task. So a person who does the obvious thing -- open Task Manager, disable
// PCoin Miner -- has disabled nothing that matters, and the app keeps appearing
// on every sign-in. That was reported by a real user on 2026-09-09, and they
// were right: from where they were standing the app simply refused to stop.
//
// MEASURED ON A REAL MACHINE, 2026-09-10, and it changed the design. On fleet PC
// DESKTOP-AKHQ7BJ the tray's own user could neither delete nor disable the
// scheduled task:
//
//     schtasks /delete  /tn PCoinMiner /f       -> ERROR: Access is denied.
//     schtasks /change  /tn PCoinMiner /disable -> ERROR: Access is denied.
//     Disable-ScheduledTask                     -> Access is denied.
//
// and that user was not an administrator, so UAC would have demanded a password
// they do not have. Removing the task is therefore NOT something we can rely on.
//
// Hence the lever that always works and needs no privilege at all: a task we
// cannot remove still launches an app that can DECLINE TO RUN. Autostart passes
// `--minimized`, and PCoinTray exits immediately when it sees that flag while
// the config says autostart is off. See AutostartWanted() in PCoinTray.cs.
// Removing the mechanisms is still attempted -- it is tidier -- but the promise
// to the user no longer depends on it succeeding.
//
// An app that will not stop starting is indistinguishable from malware, so the
// bar here is higher than "we tried". Every operation VERIFIES afterwards and
// reports what is actually true, because the whole failure was a control that
// looked like it worked.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;

namespace PCoinTray
{
    //! What an Enable/Disable attempt actually achieved. Deliberately not a
    //! bool: "I could not tell" is a real outcome and must not collapse into
    //! "done" (the doctrine in §7.1 of CLAUDE.md, applied to a UI control).
    enum AutostartResult
    {
        Done,           // verified: the requested state is the state on disk
        TaskRemains,    // shortcuts gone, the task could not be removed
        Failed          // something else went wrong; the message says what
    }

    static class Autostart
    {
        public const string TaskName = "PCoinMiner";
        const string PreferredShortcut = "PCoin Miner.lnk";
        public const string MinimizedFlag = "--minimized";

        public static string ExePath()
        {
            return Process.GetCurrentProcess().MainModule.FileName;
        }

        //! The Startup folder for the CURRENT user. Empty when the profile is
        //! not fully loaded (a service context), in which case there is no
        //! shortcut to find and none we could meaningfully create.
        static string StartupDir()
        {
            try
            {
                string d = Environment.GetFolderPath(Environment.SpecialFolder.Startup);
                if (!string.IsNullOrEmpty(d) && d.IndexOf("systemprofile", StringComparison.OrdinalIgnoreCase) < 0)
                    return d;
            }
            catch { }
            try
            {
                string appdata = Environment.GetEnvironmentVariable("APPDATA");
                if (!string.IsNullOrEmpty(appdata) &&
                    appdata.IndexOf("systemprofile", StringComparison.OrdinalIgnoreCase) < 0)
                    return Path.Combine(appdata, @"Microsoft\Windows\Start Menu\Programs\Startup");
            }
            catch { }
            return null;
        }

        //! EVERY shortcut in Startup that launches this exe, whatever it is
        //! called. Matching on the FILENAME was the bug: a fleet PC had both
        //! `PCoin Miner.lnk` and `PCoin.lnk` pointing here, and removing only
        //! the first left the app starting at every sign-in with the tick
        //! showing "off".
        public static List<string> OurShortcuts()
        {
            var hits = new List<string>();
            string dir = StartupDir();
            if (dir == null) return hits;

            string me;
            try { me = Path.GetFullPath(ExePath()); }
            catch { return hits; }

            string[] lnks;
            try { lnks = Directory.GetFiles(dir, "*.lnk"); }
            catch { return hits; }

            Type t = Type.GetTypeFromProgID("WScript.Shell");
            if (t == null) return hits;
            object shell = null;
            try
            {
                shell = Activator.CreateInstance(t);
                foreach (var p in lnks)
                {
                    try
                    {
                        object lnk = t.InvokeMember("CreateShortcut",
                            System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { p });
                        string target = Convert.ToString(lnk.GetType().InvokeMember("TargetPath",
                            System.Reflection.BindingFlags.GetProperty, null, lnk, new object[0]));
                        if (!string.IsNullOrEmpty(target) &&
                            string.Equals(Path.GetFullPath(target), me, StringComparison.OrdinalIgnoreCase))
                            hits.Add(p);
                    }
                    catch { /* a damaged .lnk is not a reason to stop reading the rest */ }
                }
            }
            catch { }
            finally
            {
                if (shell != null)
                    try { System.Runtime.InteropServices.Marshal.ReleaseComObject(shell); } catch { }
            }
            return hits;
        }

        //! Ask Task Scheduler, never a cached answer. /nh /fo csv keeps the
        //! output stable across Windows languages -- "query" prints a localised
        //! table otherwise and any parse of it is wrong on a German machine.
        public static bool TaskExists()
        {
            string outp, err;
            int rc = Run("schtasks.exe", "/query /tn \"" + TaskName + "\" /fo csv /nh", out outp, out err);
            return rc == 0 && outp.IndexOf(TaskName, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        //! "Will this app start itself when I sign in?" -- true if ANY mechanism
        //! is live. Anything narrower is the bug this file exists to fix.
        public static bool IsEnabled()
        {
            return OurShortcuts().Count > 0 || TaskExists();
        }

        // ---------- turning it off ----------

        public static AutostartResult Disable(out string message)
        {
            message = "";
            var left = new List<string>();

            foreach (var p in OurShortcuts())
            {
                try { File.Delete(p); } catch { }
                if (File.Exists(p)) left.Add(Path.GetFileName(p));
            }

            if (left.Count > 0)
            {
                message = "Could not delete " + string.Join(", ", left.ToArray()) +
                          " from your Startup folder.";
                return AutostartResult.Failed;
            }

            // The task is the half that needs privilege, and on a real machine
            // it is refused outright -- see the header. Try, then try once
            // through UAC, then say plainly that it is still there. What we do
            // NOT do is pretend: the app declining to run is what actually
            // keeps the promise, and that is already in force by now.
            if (TaskExists())
            {
                string outp, err;
                Run("schtasks.exe", "/delete /tn \"" + TaskName + "\" /f", out outp, out err);
                if (TaskExists())
                {
                    RunElevated("schtasks.exe", "/delete /tn \"" + TaskName + "\" /f");
                    if (TaskExists())
                    {
                        message = "The scheduled task " + TaskName + " could not be removed " +
                                  "(Windows refused without administrator rights). PCoin will " +
                                  "still not start: the task launches it, and it closes again " +
                                  "immediately.";
                        return AutostartResult.TaskRemains;
                    }
                }
            }

            return AutostartResult.Done;
        }

        // ---------- turning it back on ----------

        public static AutostartResult Enable(out string message)
        {
            message = "";
            string exe = ExePath();

            string dir = StartupDir();
            if (dir == null)
            {
                message = "Could not locate your Startup folder.";
                return AutostartResult.Failed;
            }

            string p = Path.Combine(dir, PreferredShortcut);
            try { CreateShortcut(p, exe); }
            catch (Exception ex) { message = ex.Message; return AutostartResult.Failed; }

            if (!File.Exists(p))
            {
                message = "The Startup shortcut was not created.";
                return AutostartResult.Failed;
            }

            // The scheduled task is the faster of the two but needs admin. Not
            // having it is not a failure: the shortcut alone does start the app,
            // just later, because Explorer staggers Startup items. Say so rather
            // than raising a UAC prompt nobody asked for.
            if (!TaskExists())
            {
                string outp, err;
                string who = Environment.UserDomainName + "\\" + Environment.UserName;
                Run("schtasks.exe",
                    "/create /tn \"" + TaskName + "\" /tr \"\\\"" + exe + "\\\" " + MinimizedFlag + "\" " +
                    "/sc onlogon /ru \"" + who + "\" /it /rl LIMITED /f", out outp, out err);
                if (!TaskExists())
                    message = "Enabled. It will start shortly after sign-in rather than " +
                              "immediately; reinstalling as administrator makes it immediate.";
            }

            return IsEnabled() ? AutostartResult.Done : AutostartResult.Failed;
        }

        // ---------- plumbing ----------

        //! Deliberately identical to what install.ps1 creates, MinimizedFlag
        //! included. That flag is load-bearing now, not cosmetic: it is how the
        //! app knows it was started by autostart rather than by a person, and
        //! therefore how it knows to close again when autostart is off.
        static void CreateShortcut(string lnkPath, string exe)
        {
            Type t = Type.GetTypeFromProgID("WScript.Shell");
            object shell = Activator.CreateInstance(t);
            try
            {
                object lnk = t.InvokeMember("CreateShortcut",
                    System.Reflection.BindingFlags.InvokeMethod, null, shell, new object[] { lnkPath });
                Type lt = lnk.GetType();
                Set(lt, lnk, "TargetPath", exe);
                Set(lt, lnk, "Arguments", MinimizedFlag);
                Set(lt, lnk, "WorkingDirectory", Path.GetDirectoryName(exe));
                Set(lt, lnk, "Description", "PCoin node and miner");
                lt.InvokeMember("Save", System.Reflection.BindingFlags.InvokeMethod, null, lnk, new object[0]);
            }
            finally
            {
                try { System.Runtime.InteropServices.Marshal.ReleaseComObject(shell); } catch { }
            }
        }

        static void Set(Type t, object o, string prop, object val)
        {
            t.InvokeMember(prop, System.Reflection.BindingFlags.SetProperty, null, o, new object[] { val });
        }

        static int Run(string exe, string args, out string stdout, out string stderr)
        {
            stdout = ""; stderr = "";
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true
                };
                using (var p = Process.Start(psi))
                {
                    stdout = p.StandardOutput.ReadToEnd();
                    stderr = p.StandardError.ReadToEnd();
                    if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } return -1; }
                    return p.ExitCode;
                }
            }
            catch (Exception ex) { stderr = ex.Message; return -1; }
        }

        //! Verb=runas raises the UAC prompt. A cancelled prompt throws
        //! Win32Exception, which is a "no" from the person and not an error to
        //! report as a crash.
        static bool RunElevated(string exe, string args)
        {
            try
            {
                var psi = new ProcessStartInfo(exe, args)
                {
                    UseShellExecute = true,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden,
                    Verb = "runas"
                };
                using (var p = Process.Start(psi))
                {
                    if (p == null) return false;
                    return p.WaitForExit(60000);
                }
            }
            catch { return false; }
        }
    }
}
