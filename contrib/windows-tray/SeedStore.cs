// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// Storage of the recovery phrase at rest, the unlock gate that guards reading
// it back, and the screen-capture guard for the windows that display it.

using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Windows.Forms;

namespace PCoinTray
{
    /**
     * What is stored about a phrase, besides the words.
     *
     * Every field that a future version might need to know in order to
     * reproduce the same keys is written from day one, even where today's code
     * only ever writes one value. A phrase already in the wild cannot be
     * retrofitted with a field describing how it was derived.
     */
    class PhraseRecord
    {
        public int Version = 1;              // record format
        public int Scheme = 1;               // 1 = BIP39/BIP84, empty passphrase
        public int WordCount = 12;
        public string Network = "main";
        public string Path = "";             // e.g. m/84h/9444h/0h
        public string Fingerprint = "";      // master key fingerprint, hex
        public string Wallet = "";           // node wallet the descriptors went into
        public string Address0 = "";         // m/84'/coin'/0'/0/0, the mining payout
        public long BirthTime;               // unix seconds; restore rescans from here
        public long BirthHeight;             // reserved for when the chain gets long
        public string Created = "";
        public string Mnemonic = "";

        public string Serialize()
        {
            var sb = new StringBuilder();
            sb.Append("version=").Append(Version).Append('\n');
            sb.Append("scheme=").Append(Scheme).Append('\n');
            sb.Append("words=").Append(WordCount).Append('\n');
            sb.Append("network=").Append(Network).Append('\n');
            sb.Append("path=").Append(Path).Append('\n');
            sb.Append("fingerprint=").Append(Fingerprint).Append('\n');
            sb.Append("wallet=").Append(Wallet).Append('\n');
            sb.Append("address0=").Append(Address0).Append('\n');
            sb.Append("birthtime=").Append(BirthTime.ToString(CultureInfo.InvariantCulture)).Append('\n');
            sb.Append("birthheight=").Append(BirthHeight.ToString(CultureInfo.InvariantCulture)).Append('\n');
            sb.Append("created=").Append(Created).Append('\n');
            sb.Append("mnemonic=").Append(Mnemonic).Append('\n');
            return sb.ToString();
        }

        public static PhraseRecord Deserialize(string text)
        {
            var r = new PhraseRecord();
            foreach (var raw in text.Split('\n'))
            {
                int eq = raw.IndexOf('=');
                if (eq <= 0) continue;
                string k = raw.Substring(0, eq).Trim();
                string v = raw.Substring(eq + 1).Trim();
                switch (k)
                {
                    case "version": int.TryParse(v, out r.Version); break;
                    case "scheme": int.TryParse(v, out r.Scheme); break;
                    case "words": int.TryParse(v, out r.WordCount); break;
                    case "network": r.Network = v; break;
                    case "path": r.Path = v; break;
                    case "fingerprint": r.Fingerprint = v; break;
                    case "wallet": r.Wallet = v; break;
                    case "address0": r.Address0 = v; break;
                    case "birthtime": long.TryParse(v, out r.BirthTime); break;
                    case "birthheight": long.TryParse(v, out r.BirthHeight); break;
                    case "created": r.Created = v; break;
                    case "mnemonic": r.Mnemonic = v; break;
                }
            }
            return r;
        }
    }

    /**
     * The phrase file.
     *
     * Encrypted with DPAPI under the current Windows user, so the ciphertext is
     * useless if the file is copied to another machine or read by another
     * account. It lives in its own file rather than in pcoin-tray.cfg because
     * install.ps1 rewrites that config wholesale on every upgrade - a phrase
     * kept there would be destroyed by the next install.
     *
     * The paper the user wrote the words on is the real backup. This file is a
     * convenience so the Recovery phrase menu item can show them again.
     */
    static class SeedStore
    {
        const string FILE = "pcoin-seed.dat";

        // Extra entropy mixed into DPAPI so a blob from another application
        // running as the same user cannot be swapped in.
        static readonly byte[] ENTROPY = Encoding.ASCII.GetBytes("PCoin recovery phrase v1");

        public static string PathFor(string dir) { return System.IO.Path.Combine(dir, FILE); }

        public static bool Exists(string dir) { return File.Exists(PathFor(dir)); }

        /**
         * Write the record.
         *
         * Refuses to replace an existing phrase unless the caller says so
         * explicitly. Overwriting a phrase destroys access to whatever it was
         * holding, so it must never happen as a side effect of some other
         * operation.
         */
        public static void Save(string dir, PhraseRecord rec, bool allowReplace)
        {
            string path = PathFor(dir);
            if (File.Exists(path) && !allowReplace)
                throw new InvalidOperationException("a recovery phrase is already stored; refusing to overwrite it");

            byte[] plain = Encoding.UTF8.GetBytes(rec.Serialize());
            byte[] blob;
            try { blob = ProtectedData.Protect(plain, ENTROPY, DataProtectionScope.CurrentUser); }
            finally { Hashes.Wipe(plain); }

            // Write to a temporary file and put it into place in ONE operation,
            // so an interrupted write can never leave a truncated phrase behind
            // - and, just as important, can never leave no phrase at all.
            //
            // This used to move the live file aside to ".prev" and only then
            // move the temp file in. If that second move threw - an antivirus
            // lock, a full disk - the live phrase file no longer existed, the
            // caller saw an exception, and the words survived only in a ".prev"
            // file the user had never been told about. The ".prev" copy was also
            // left on disk forever, so a machine set up twice kept a DPAPI blob
            // of a superseded phrase indefinitely.
            //
            // File.Replace is atomic and needs no second step. On the create
            // path (no existing file) a plain Move is the equivalent.
            string tmp = path + ".tmp";
            File.WriteAllText(tmp, Convert.ToBase64String(blob));
            try
            {
                if (File.Exists(path)) File.Replace(tmp, path, null);
                else File.Move(tmp, path);
            }
            catch
            {
                // The live file is still whatever it was. Clean up the scratch
                // copy rather than leaving a plaintext-adjacent blob lying
                // around, and let the caller see the failure.
                try { File.Delete(tmp); } catch { }
                throw;
            }

            // Any ".prev" from a previous version of this code is a DPAPI blob
            // of a phrase that is no longer in use. Nothing reads it and it is
            // not a backup the user knows about, so it does not get to linger.
            try { File.Delete(path + ".prev"); } catch { }
        }

        //! Returns null if there is no phrase, throws if there is one and it
        //! cannot be decrypted (a wrong Windows account, or a corrupted file) -
        //! those two cases must not look the same to the caller.
        public static PhraseRecord Load(string dir)
        {
            string path = PathFor(dir);
            if (!File.Exists(path)) return null;
            byte[] blob = Convert.FromBase64String(File.ReadAllText(path).Trim());
            byte[] plain = ProtectedData.Unprotect(blob, ENTROPY, DataProtectionScope.CurrentUser);
            try { return PhraseRecord.Deserialize(Encoding.UTF8.GetString(plain)); }
            finally { Hashes.Wipe(plain); }
        }
    }

    /**
     * Ask Windows to confirm the person at the keyboard.
     *
     * The phrase is already protected by DPAPI under this account, so anything
     * that can run this program as this user could in principle read it. This
     * prompt is the Windows equivalent of the phone's unlock gate: it stops a
     * passer-by at an unattended desk, and makes showing the words a deliberate
     * act. It is not, and cannot be, protection against someone who already
     * controls the account.
     */
    static class WindowsUnlock
    {
        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        struct CREDUI_INFO
        {
            public int cbSize;
            public IntPtr hwndParent;
            [MarshalAs(UnmanagedType.LPWStr)] public string pszMessageText;
            [MarshalAs(UnmanagedType.LPWStr)] public string pszCaptionText;
            public IntPtr hbmBanner;
        }

        [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern int CredUIPromptForWindowsCredentials(ref CREDUI_INFO uiInfo, int authError,
            ref uint authPackage, IntPtr inAuthBuffer, uint inAuthBufferSize,
            out IntPtr outAuthBuffer, out uint outAuthBufferSize, ref bool save, int flags);

        [DllImport("credui.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool CredUnPackAuthenticationBuffer(int dwFlags, IntPtr pAuthBuffer, uint cbAuthBuffer,
            StringBuilder pszUserName, ref int pcchMaxUserName,
            StringBuilder pszDomainName, ref int pcchMaxDomainName,
            StringBuilder pszPassword, ref int pcchMaxPassword);

        [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
        static extern bool LogonUser(string user, string domain, string password,
            int logonType, int logonProvider, out IntPtr token);

        [DllImport("kernel32.dll", SetLastError = true)]
        static extern bool CloseHandle(IntPtr h);

        [DllImport("ole32.dll")]
        static extern void CoTaskMemFree(IntPtr p);

        const int CREDUIWIN_ENUMERATE_CURRENT_USER = 0x200;
        const int ERROR_CANCELLED = 1223;
        const int ERROR_LOGON_FAILURE = 1326;
        const int ERROR_INSUFFICIENT_BUFFER = 122;
        const int LOGON32_LOGON_NETWORK = 3;
        const int LOGON32_LOGON_INTERACTIVE = 2;
        const int LOGON32_PROVIDER_DEFAULT = 0;

        public enum Outcome { Verified, Cancelled, WrongCredential, CannotVerify }

        public static Outcome Prompt(IWin32Window owner, string message)
        {
            IntPtr outBuf = IntPtr.Zero;
            try
            {
                var info = new CREDUI_INFO
                {
                    cbSize = Marshal.SizeOf(typeof(CREDUI_INFO)),
                    hwndParent = owner == null ? IntPtr.Zero : owner.Handle,
                    pszCaptionText = "PCoin - confirm it is you",
                    pszMessageText = message,
                    hbmBanner = IntPtr.Zero
                };
                uint authPackage = 0, outSize = 0;
                bool save = false;
                int rc = CredUIPromptForWindowsCredentials(ref info, 0, ref authPackage, IntPtr.Zero, 0,
                                                           out outBuf, out outSize, ref save,
                                                           CREDUIWIN_ENUMERATE_CURRENT_USER);
                if (rc == ERROR_CANCELLED) return Outcome.Cancelled;
                if (rc != 0) return Outcome.CannotVerify;

                int cu = 513, cd = 513, cp = 513;
                var user = new StringBuilder(cu);
                var domain = new StringBuilder(cd);
                var pass = new StringBuilder(cp);
                if (!CredUnPackAuthenticationBuffer(0, outBuf, outSize, user, ref cu, domain, ref cd, pass, ref cp))
                {
                    if (Marshal.GetLastWin32Error() != ERROR_INSUFFICIENT_BUFFER) return Outcome.CannotVerify;
                    user = new StringBuilder(cu); domain = new StringBuilder(cd); pass = new StringBuilder(cp);
                    if (!CredUnPackAuthenticationBuffer(0, outBuf, outSize, user, ref cu, domain, ref cd, pass, ref cp))
                        return Outcome.CannotVerify;
                }

                string u = user.ToString(), d = domain.ToString(), p = pass.ToString();
                user.Clear(); domain.Clear(); pass.Clear();

                // A Windows Hello PIN or a fingerprint does not come back as a
                // password, so there is nothing here that LogonUser can check.
                if (p.Length == 0) return Outcome.CannotVerify;

                int slash = u.IndexOf('\\');
                if (slash > 0) { d = u.Substring(0, slash); u = u.Substring(slash + 1); }

                IntPtr token;
                bool ok = LogonUser(u, string.IsNullOrEmpty(d) ? null : d, p,
                                    LOGON32_LOGON_NETWORK, LOGON32_PROVIDER_DEFAULT, out token);
                int err = ok ? 0 : Marshal.GetLastWin32Error();
                if (!ok && err != ERROR_LOGON_FAILURE)
                {
                    // Some accounts and policies forbid a network logon; an
                    // interactive one answers the same question.
                    ok = LogonUser(u, string.IsNullOrEmpty(d) ? null : d, p,
                                   LOGON32_LOGON_INTERACTIVE, LOGON32_PROVIDER_DEFAULT, out token);
                    err = ok ? 0 : Marshal.GetLastWin32Error();
                }
                p = null;
                if (ok) { CloseHandle(token); return Outcome.Verified; }
                return err == ERROR_LOGON_FAILURE ? Outcome.WrongCredential : Outcome.CannotVerify;
            }
            catch
            {
                // Interop is not allowed to be the reason somebody cannot reach
                // their own recovery phrase.
                return Outcome.CannotVerify;
            }
            finally
            {
                if (outBuf != IntPtr.Zero) { try { CoTaskMemFree(outBuf); } catch { } }
            }
        }
    }

    /**
     * Keep a window out of screenshots, screen recordings and shared screens -
     * the desktop counterpart of FLAG_SECURE.
     *
     * Best effort by design: WDA_EXCLUDEFROMCAPTURE needs Windows 10 2004 or
     * newer. On an older build the window falls back to being merely blacked
     * out for capture, and if even that is unavailable the phrase is still
     * shown, because refusing to show it would be worse.
     */
    static class ScreenGuard
    {
        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SetWindowDisplayAffinity(IntPtr hWnd, uint dwAffinity);

        const uint WDA_MONITOR = 0x00000001;
        const uint WDA_EXCLUDEFROMCAPTURE = 0x00000011;

        public static void Protect(Form f)
        {
            try
            {
                if (!SetWindowDisplayAffinity(f.Handle, WDA_EXCLUDEFROMCAPTURE))
                    SetWindowDisplayAffinity(f.Handle, WDA_MONITOR);
            }
            catch { }
        }
    }
}
