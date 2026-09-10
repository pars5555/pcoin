// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Turning "start with Windows" off, and having it actually stay off.
//
// WHY THIS FILE EXISTS. There are TWO independent autostart mechanisms and
// Windows only shows you one of them:
//
//   1. a shortcut in the user's Startup folder, and
//   2. a scheduled task named PCoinMiner with an AtLogOn trigger.
//
// Task Manager's "Startup apps" tab lists (1) and does not list (2) at all. So
// a person who does the obvious thing -- open Task Manager, disable PCoin
// Miner -- has disabled nothing that matters, and the app keeps appearing on
// every sign-in. That was reported by a real user on 2026-09-09, and they were
// right: from where they were standing the app simply refused to stop.
//
// An app that will not stop starting is indistinguishable from malware, so the
// bar here is higher than "we tried". Every operation VERIFIES afterwards and
// reports what is actually true, because the whole failure was a control that
// looked like it worked.
//
// The second mechanism exists for a good reason (Explorer staggers Startup
// items and can take minutes; Task Scheduler is immediate), so the answer is
// not to delete it -- it is to make one switch govern both.

using System;
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
        NeedsAdmin,     // the scheduled task would not budge without elevation
        Failed          // something else went wrong; the message says what
    }

    static class Autostart
    {
        public const string TaskName = "PCoinMiner";
        const string ShortcutName = "PCoin Miner.lnk";

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

        static string ShortcutPath()
        {
            string d = StartupDir();
            return d == null ? null : Path.Combine(d, ShortcutName);
        }

        public static bool ShortcutExists()
        {
            string p = ShortcutPath();
            try { return p != null && File.Exists(p); } catch { return false; }
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

        //! "Will this app start itself when I sign in?" -- true if EITHER
        //! mechanism is live. Anything narrower is the bug this file fixes.
        public static bool IsEnabled()
        {
            return ShortcutExists() || TaskExists();
        }

        // ---------- turning it off ----------

        public static AutostartResult Disable(out string message)
        {
            message = "";
            bool shortcutGone = true;

            string p = ShortcutPath();
            if (p != null)
            {
                try { if (File.Exists(p)) File.Delete(p); }
                catch (Exception ex) { shortcutGone = false; message = ex.Message; }
                shortcutGone = shortcutGone && !File.Exists(p);
            }

            // The task is the half that needs privilege. It was created by an
            // elevated installer with /RU <user>, so a non-elevated delete is
            // refused -- and schtasks says so on stderr with a non-zero code
            // rather than throwing, which is easy to miss.
            if (TaskExists())
            {
                string outp, err;
                Run("schtasks.exe", "/delete /tn \"" + TaskName + "\" /f", out outp, out err);

                if (TaskExists())
                {
                    // One elevated retry, which raises a UAC prompt the person
                    // asked for by clicking the menu item.
                    if (!RunElevated("schtasks.exe", "/delete /tn \"" + TaskName + "\" /f"))
                    {
                        message = "Windows did not allow the scheduled task to be removed.";
                        return AutostartResult.NeedsAdmin;
                    }
                    if (TaskExists())
                    {
                        message = "The scheduled task " + TaskName + " is still present.";
                        return AutostartResult.NeedsAdmin;
                    }
                }
            }

            if (!shortcutGone)
            {
                message = "The Startup shortcut could not be deleted: " + message;
                return AutostartResult.Failed;
            }

            // Verify the whole claim, not the half we just touched.
            return IsEnabled() ? AutostartResult.Failed : AutostartResult.Done;
        }

        // ---------- turning it back on ----------

        public static AutostartResult Enable(out string message)
        {
            message = "";
            string exe = Application_ExecutablePath();

            string p = ShortcutPath();
            if (p == null)
            {
                message = "Could not locate your Startup folder.";
                return AutostartResult.Failed;
            }

            try { CreateShortcut(p, exe); }
            catch (Exception ex) { message = ex.Message; return AutostartResult.Failed; }

            if (!File.Exists(p))
            {
                message = "The Startup shortcut was not created.";
                return AutostartResult.Failed;
            }

            // The scheduled task is the faster of the two but needs admin. Not
            // having it is not a failure: the shortcut alone does start the app,
            // just later. Say so rather than raising a UAC prompt nobody asked
            // for -- and never claim the task exists when it does not.
            if (!TaskExists())
            {
                string outp, err;
                string who = Environment.UserDomainName + "\\" + Environment.UserName;
                Run("schtasks.exe",
                    "/create /tn \"" + TaskName + "\" /tr \"" + exe + "\" " +
                    "/sc onlogon /ru \"" + who + "\" /it /rl LIMITED /f", out outp, out err);
                if (!TaskExists())
                    message = "Enabled. It will start a little after sign-in; " +
                              "reinstalling as administrator makes it immediate.";
            }

            return IsEnabled() ? AutostartResult.Done : AutostartResult.Failed;
        }

        // ---------- plumbing ----------

        static string Application_ExecutablePath()
        {
            return Process.GetCurrentProcess().MainModule.FileName;
        }

        //! Deliberately IDENTICAL to what install.ps1 creates -- same target,
        //! same working directory, same (absent) arguments. Toggling this off
        //! and on again must not quietly change how the app starts.
        //!
        //! Worth knowing: neither this nor install.ps1 passes --minimized, so
        //! the window DOES appear at sign-in even though PCoinTray.cs:796 says
        //! autostart should pass it. That is a separate, older discrepancy and
        //! is left alone here on purpose -- changing whether a window appears
        //! at logon is not a change to smuggle in with a bug fix.
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
