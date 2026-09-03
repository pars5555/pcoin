// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// PCoinWallet.exe - a PCoin wallet for Windows, matching the Android one.
//
// A full node plus a wallet on a PC: create or restore twelve words, receive
// to a QR code, send with a real fee shown before anything is broadcast, scroll
// the history, keep an address book. It is built from the same source files as
// the miner tray (build-wallet.bat), the way the Android wallet flavour is
// built from the miner's tree - but it is a COMPLETELY SEPARATE program at
// runtime:
//
//   * its own install directory, its own bitcoind.exe beside it, its own data
//     folder (<exe dir>\data by default), its own recovery phrase file and its
//     own address book. Nothing here reads or writes C:\PCoin, and nothing
//     here depends on the miner tray being installed - or on it not being;
//   * its own RPC port, 9543, written into its own pcoin.conf. The miner tray's
//     node listens on 9443, and two nodes on one PC would otherwise fight over
//     loopback. `listen=0` keeps it off P2P port 9444 as well, which the
//     miner's node owns when it is present. A wallet does not need inbound
//     peers; it dials the seeds;
//   * its own single-instance mutex and its own log, so the two programs never
//     mistake each other for a second copy of themselves.
//
// What it deliberately shares with the tray is the money code: derivation
// (SeedKeys), the phrase file (SeedStore), the RPC client, the node-side wallet
// setup (SeedWallet) and the build/verify/broadcast engine (ForwardEngine),
// all of which are exercised by `PCoinWallet.exe --selftest` with no node. The
// forwarding machinery inside ForwardEngine is never started here: this app
// constructs the engine only for PrepareSend, BroadcastPrepared and
// ListHistoryPage.
//
// Node ownership, because two nodes on one PC is the whole point: this app
// never looks for "a bitcoind process". It asks ITS OWN port, and if nothing
// answers it starts its own node on its own data folder. If that node exits
// at once, something else holds this data folder's lock - an earlier copy of
// this app still shutting down, or still rescanning - and the app waits for
// that node instead of claiming it. The miner tray's node, on a different
// folder and a different port, can never be adopted by mistake, and is never
// told to stop.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Windows.Forms;

namespace PCoinTray
{
    static class WalletProgram
    {
        public const string LOG_FILE = "pcoin-wallet.log";
        public const string CFG_FILE = "pcoin-wallet.cfg";
        /** The miner tray's node uses 9443 (PCoin mainnet's own default). */
        public const int RPC_PORT = 9543;

        const string MUTEX_NAME = @"Global\PCoinWalletSingleInstance";
        internal const string SHOW_EVENT = @"Global\PCoinWalletShowWindow";

        //! A winexe has no console of its own, so borrow the one it was started
        //! from. Only used by --selftest.
        [DllImport("kernel32.dll")]
        static extern bool AttachConsole(int dwProcessId);

        [STAThread]
        static int Main(string[] args)
        {
            ForwardEngine.LogFile = LOG_FILE;
            foreach (var a in args)
            {
                if (a == "--selftest" || a == "-selftest") return SelfTest();
            }
            Run();
            return 0;
        }

        /**
         * The same self-test the tray runs: BIP39/BIP32/BIP84 against the
         * published vectors, every money decision, the address book, the QR
         * encoder. Anything that touches this app's cryptography must be run
         * through this before it is shipped anywhere.
         */
        static int SelfTest()
        {
            AttachConsole(-1);
            var log = new List<string>();
            bool ok;
            try { ok = SeedSelfTest.Run(log); }
            catch (Exception ex) { log.Add("EXCEPTION: " + ex); ok = false; }
            var text = string.Join(Environment.NewLine, log.ToArray());
            Console.WriteLine();
            Console.WriteLine(text);
            try
            {
                File.WriteAllText(Path.Combine(Path.GetDirectoryName(Application.ExecutablePath),
                                               "pcoin-selftest.txt"), text);
            }
            catch { }
            return ok ? 0 : 1;
        }

        static void Run()
        {
            // Refuse to run in session 0. A window there is invisible to the
            // person at the keyboard (CLAUDE.md section 7.3); exiting before
            // any node is started means nothing is left running unseen.
            try
            {
                if (Process.GetCurrentProcess().SessionId == 0)
                {
                    Note("refusing to start in session 0: a window there is invisible. " +
                         "Launch it in the interactive desktop session instead.");
                    return;
                }
            }
            catch { }

            // One instance only. A different name from the tray's mutex, so the
            // two programs can run side by side; Global\ plus a World-allow ACL
            // so an elevated copy and an ordinary one still see each other.
            bool created;
            Mutex mutex;
            try
            {
                var sec = new MutexSecurity();
                sec.AddAccessRule(new MutexAccessRule(
                    new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                    MutexRights.FullControl, AccessControlType.Allow));
                mutex = new Mutex(true, MUTEX_NAME, out created, sec);
            }
            catch (UnauthorizedAccessException)
            {
                created = false;
                mutex = null;
            }
            using (mutex)
            {
                if (!created)
                {
                    SignalExistingInstance();
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                // Every failure is written down before anything else happens
                // to it. A wallet that vanished without a line in its log is a
                // wallet nobody can trust again.
                AppDomain.CurrentDomain.UnhandledException += (s, e) =>
                    Note("UNHANDLED: " + e.ExceptionObject);
                Application.ThreadException += (s, e) =>
                {
                    Note("UI EXCEPTION: " + e.Exception);
                    try
                    {
                        MessageBox.Show("Something went wrong in PCoin Wallet:\r\n\r\n" + RpcClient.Sanitize(e.Exception.Message) +
                                        "\r\n\r\nDetails are in " + LOG_FILE + ". Nothing has been sent.",
                                        "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    }
                    catch { }
                };
                Note("start: v" + typeof(WalletProgram).Assembly.GetName().Version + " in " +
                     Path.GetDirectoryName(Application.ExecutablePath));
                Application.Run(new WalletApp());
                Note("exit: message loop ended");
            }
        }

        //! A second launch brings the running window forward instead of doing
        //! nothing: silence reads as "it is broken".
        static void SignalExistingInstance()
        {
            try
            {
                using (var ev = EventWaitHandle.OpenExisting(SHOW_EVENT)) ev.Set();
            }
            catch
            {
                MessageBox.Show("PCoin Wallet is already running.", "PCoin Wallet",
                                MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
        }

        internal static void Note(string message)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), LOG_FILE),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                        + "  " + message + Environment.NewLine);
            }
            catch { }
        }
    }

    /**
     * The node's configuration, written by this app into ITS OWN data folder.
     *
     * Append-only, like SeedWallet.EnsureConfig: anything already in the file
     * is left exactly as it is, so an operator who set something by hand keeps
     * it. The keys below are the ones a fresh install needs to work at all:
     *
     *   rpcport=9543   not 9443, so this node and the miner tray's node can
     *                  share a PC. RpcClient reads this same line, so the two
     *                  sides cannot disagree.
     *   listen=0       no inbound P2P: never binds 9444, which the miner's node
     *                  owns when it is present. Outbound connections to the
     *                  seeds are all a wallet needs.
     *   fallbackfee    Core's default is 0 and PCoin has no fee history, so
     *                  without this every send fails "Fee estimation failed".
     *   changetype     the phrase-backed wallet holds only wpkh() descriptors;
     *                  paying a taproot address would otherwise fail while
     *                  allocating change.
     *   addnode        the seeds, so a first start finds peers even if DNS is
     *                  blocked.
     */
    static class WalletConfig
    {
        static readonly string[] SEEDS =
        {
            "35.239.156.16:9444",
            "178.105.3.51:9444",
            "152.53.171.190:9444",
        };

        /** Returns null on success or a message on failure. */
        public static string Ensure(string datadir)
        {
            try
            {
                Directory.CreateDirectory(datadir);
                string path = Path.Combine(datadir, "pcoin.conf");
                var have = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (File.Exists(path))
                {
                    foreach (var raw in File.ReadAllLines(path))
                    {
                        string line = raw.Trim();
                        int eq = line.IndexOf('=');
                        if (eq > 0 && line[0] != '#') have.Add(line.Substring(0, eq).Trim());
                    }
                }
                var add = new List<string>();
                if (!have.Contains("server")) add.Add("server=1");
                if (!have.Contains("rpcport")) add.Add("rpcport=" + WalletProgram.RPC_PORT.ToString(CultureInfo.InvariantCulture));
                if (!have.Contains("listen")) add.Add("listen=0");
                if (!have.Contains("dbcache")) add.Add("dbcache=300");
                if (!have.Contains("fallbackfee")) add.Add("fallbackfee=0.00001");
                if (!have.Contains("changetype")) add.Add("changetype=bech32");
                if (!have.Contains("addnode")) foreach (var s in SEEDS) add.Add("addnode=" + s);
                if (add.Count == 0) return null;

                var sb = new StringBuilder();
                if (!File.Exists(path) || new FileInfo(path).Length == 0)
                    sb.Append("# PCoin Wallet node configuration. Written by PCoinWallet.exe; lines are only ever added, never changed.\r\n");
                else
                    sb.Append("\r\n# added by PCoinWallet\r\n");
                foreach (var l in add) sb.Append(l).Append("\r\n");
                File.AppendAllText(path, sb.ToString());
                return null;
            }
            catch (Exception ex)
            {
                return "could not write pcoin.conf: " + ex.Message;
            }
        }
    }

    /**
     * The application: one window, one node, one wallet.
     *
     * Runs on the WinForms message loop (the WPF window needs an STA thread
     * with a pump, and this is one). Everything that talks to the node runs on
     * a background thread; results reach the window through _sync, a never-
     * shown Form whose BeginInvoke lands on the UI thread.
     */
    class WalletApp : ApplicationContext
    {
        /** How often the window is refreshed from the node. */
        const int POLL_MS = 5000;

        readonly string _dir;
        readonly string _datadir;
        readonly RpcClient _rpc;
        readonly SeedWallet _seed;
        readonly ForwardStore _store;
        readonly ForwardEngine _engine;
        readonly AddressBookStore _book;
        readonly Form _sync = new Form();   // never shown; used to get onto the UI thread
        readonly ManualResetEvent _stop = new ManualResetEvent(false);

        WalletWindow _window;
        PhraseInfo _phrase;
        string _walletProblem = "";
        Process _node;
        bool _startedNode;
        volatile bool _nodeUp;
        volatile bool _quitting;
        volatile string _nodeStatus = "Starting the PCoin node...";
        volatile string _addressWarning = "";
        volatile WalletSnapshot _last = new WalletSnapshot();
        bool _setupRunning;
        bool _bookWarned;

        public WalletApp()
        {
            _dir = Path.GetDirectoryName(Application.ExecutablePath);
            _datadir = ReadDataDir();
            _rpc = new RpcClient(_datadir);
            _seed = new SeedWallet(_rpc);
            // The engine needs a store to exist; nothing in this app ever writes
            // to it, and no forwarding evaluation is ever started.
            _store = new ForwardStore(_dir);
            _engine = new ForwardEngine(_rpc, _store, () => SeedWallet.HD_WALLET, null, null);
            _book = new AddressBookStore(_dir);
            _phrase = LoadPhrase();

            var force = _sync.Handle;   // realise the handle so BeginInvoke works
            ShowWindow();
            StartShowListener();
            var t = new Thread(Startup) { IsBackground = true, Name = "wallet-startup" };
            t.Start();
        }

        // ---------------------------------------------------------- config

        /**
         * The data folder. <exe dir>\data unless pcoin-wallet.cfg says
         * otherwise. NEVER bitcoind's own default (%APPDATA%\PCoin): that is
         * where the miner tray keeps ITS node on a PC that has both, and two
         * programs on one data folder is exactly the collision this app exists
         * to avoid.
         */
        string ReadDataDir()
        {
            string dd = "";
            try
            {
                string cfg = Path.Combine(_dir, WalletProgram.CFG_FILE);
                if (File.Exists(cfg))
                {
                    foreach (var raw in File.ReadAllLines(cfg))
                    {
                        string line = raw.Trim();
                        int eq = line.IndexOf('=');
                        if (eq <= 0 || line[0] == '#') continue;
                        if (string.Equals(line.Substring(0, eq).Trim(), "datadir", StringComparison.OrdinalIgnoreCase))
                            dd = line.Substring(eq + 1).Trim();
                    }
                }
            }
            catch { }
            if (string.IsNullOrEmpty(dd)) dd = Path.Combine(_dir, "data");
            return dd;
        }

        /**
         * What is known about the stored phrase, without decrypting it.
         *
         * pcoin-seed.info is the plain sidecar (address, path, network); the
         * words themselves are in pcoin-seed.dat under DPAPI. If the sidecar
         * is missing but the phrase file exists, try to rebuild the sidecar
         * from the phrase - and if THAT fails (another Windows account wrote
         * it), say so rather than treating the PC as having no wallet: a fresh
         * phrase generated over a stored one is the one mistake this app must
         * never make.
         */
        PhraseInfo LoadPhrase()
        {
            PhraseInfo info = null;
            try { info = PhraseInfo.Load(_dir); } catch { }
            if (info != null && !string.IsNullOrEmpty(info.Address0)) return info;
            if (!SeedStore.Exists(_dir)) return null;
            try
            {
                var rec = SeedStore.Load(_dir);
                if (rec == null || string.IsNullOrEmpty(rec.Address0))
                {
                    _walletProblem = "A recovery phrase file exists here but holds no address. Restore from your paper copy.";
                    return null;
                }
                info = new PhraseInfo
                {
                    Wallet = string.IsNullOrEmpty(rec.Wallet) ? SeedWallet.HD_WALLET : rec.Wallet,
                    Address0 = rec.Address0,
                    Network = rec.Network,
                    Path = rec.Path,
                    Fingerprint = rec.Fingerprint,
                    Created = rec.Created,
                    WordCount = rec.WordCount
                };
                try { PhraseInfo.Save(_dir, info); } catch { }
                return info;
            }
            catch (Exception ex)
            {
                _walletProblem = "A recovery phrase is stored here but cannot be read by this Windows account (" +
                                 ex.Message + "). Nothing has been changed. Restore from your paper copy, or sign in " +
                                 "as the account that set this wallet up.";
                return null;
            }
        }

        // ---------------------------------------------------------- window

        void ShowWindow()
        {
            _window = new WalletWindow(
                () => OnSend(),
                () => OnHistory(),
                () => OnAddressBook(),
                () => OnRecoveryPhrase(),
                () => OnSetup(),
                () => { try { Process.Start("explorer.exe", _dir); } catch { } },
                () => Quit());
            _window.Show();
            _window.Apply(Snapshot());
        }

        //! Wait for a second launch's signal and bring the window forward.
        void StartShowListener()
        {
            var t = new Thread(() =>
            {
                EventWaitHandle ev;
                try
                {
                    var sec = new EventWaitHandleSecurity();
                    sec.AddAccessRule(new EventWaitHandleAccessRule(
                        new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                        EventWaitHandleRights.FullControl, AccessControlType.Allow));
                    bool created;
                    ev = new EventWaitHandle(false, EventResetMode.AutoReset, WalletProgram.SHOW_EVENT, out created, sec);
                }
                catch { return; }
                using (ev)
                {
                    while (!_quitting)
                    {
                        if (!ev.WaitOne(1000)) continue;
                        try { _sync.BeginInvoke(new Action(() => { if (_window != null) _window.Reveal(); })); }
                        catch { }
                    }
                }
            }) { IsBackground = true, Name = "wallet-show-listener" };
            t.Start();
        }

        void Push()
        {
            var s = Snapshot();
            _last = s;
            try { _sync.BeginInvoke(new Action(() => { if (_window != null) _window.Apply(s); })); }
            catch { }
        }

        WalletSnapshot Snapshot()
        {
            var s = new WalletSnapshot();
            s.NodeUp = _nodeUp;
            s.NodeStatus = _nodeStatus;
            s.StartedNode = _startedNode;
            s.HasWallet = _phrase != null;
            s.WalletProblem = _walletProblem;
            s.Address = _phrase != null ? _phrase.Address0 : "";
            s.AddressWarning = _addressWarning;
            s.DataDir = _datadir;
            var prev = _last;
            // Chain and balance readings are refreshed by Poll(); between polls
            // the last known figures are carried, never zeroed.
            s.ChainKnown = prev.ChainKnown;
            s.Blocks = prev.Blocks;
            s.Headers = prev.Headers;
            s.Ibd = prev.Ibd;
            s.Progress = prev.Progress;
            s.Peers = prev.Peers;
            s.BalanceKnown = prev.BalanceKnown;
            s.TrustedSat = prev.TrustedSat;
            s.PendingSat = prev.PendingSat;
            s.ImmatureSat = prev.ImmatureSat;
            s.BalanceTrustworthy = prev.BalanceTrustworthy;
            return s;
        }

        // ---------------------------------------------------------- startup

        void Startup()
        {
            string err = WalletConfig.Ensure(_datadir);
            if (err != null) WalletProgram.Note("config: " + err);

            EnsureNode();
            Push();
            if (_nodeUp) OnNodeUp();

            // Poll until told to stop. The first poll also catches a node that
            // took longer than EnsureNode's patience.
            while (!_stop.WaitOne(POLL_MS))
            {
                try { Poll(); }
                catch (Exception ex) { WalletProgram.Note("poll: " + ex.Message); }
            }
        }

        /**
         * Everything that has to happen once the node answers: load the
         * phrase-backed wallet, check the stored address against it, and offer
         * setup if there is no wallet yet.
         */
        void OnNodeUp()
        {
            try
            {
                if (_phrase != null)
                {
                    string e = _seed.EnsureWallet(_phrase.Wallet, false, false);
                    if (e != null) WalletProgram.Note("loadwallet " + _phrase.Wallet + ": " + e);
                    VerifyAddress();
                }
                // The phrase-backed wallet is the only wallet this app uses;
                // the config keys a send depends on are written at startup, but
                // an operator-edited file may have lost them, so re-check.
                _seed.EnsureConfig();
            }
            catch (Exception ex) { WalletProgram.Note("node up: " + ex.Message); }
            Push();
            if (_phrase == null && string.IsNullOrEmpty(_walletProblem))
            {
                WalletProgram.Note("node up: no wallet on this PC, offering setup");
                try { _sync.BeginInvoke(new Action(() => RunSetup(false))); }
                catch (Exception ex) { WalletProgram.Note("offer setup: " + ex.Message); }
            }
        }

        bool RpcAlive()
        {
            try { return _rpc.Call(null, "getblockcount", "[]", 5000).Ok; }
            catch { return false; }
        }

        string FindNodeExe()
        {
            string a = Path.Combine(_dir, "bitcoind.exe");
            if (File.Exists(a)) return a;
            string b = Path.Combine(Path.Combine(_dir, "bin"), "bitcoind.exe");
            if (File.Exists(b)) return b;
            return null;
        }

        /**
         * Start, or find, THIS wallet's node.
         *
         * Only our own port is asked; a process named bitcoind is never taken
         * as evidence of anything, because on a PC with the miner tray there
         * is always one and it is not ours. See the file comment.
         */
        void EnsureNode()
        {
            if (RpcAlive())
            {
                _nodeUp = true;
                _nodeStatus = "";
                WalletProgram.Note("node: a node already answers on port " + WalletProgram.RPC_PORT + "; not starting one");
                return;
            }

            string exe = FindNodeExe();
            if (exe == null)
            {
                _nodeStatus = "bitcoind.exe was not found next to PCoinWallet.exe. Reinstall PCoin Wallet.";
                WalletProgram.Note("node: bitcoind.exe missing in " + _dir);
                return;
            }

            try
            {
                // -daemon is Unix-only; on Windows bitcoind runs in the
                // foreground, so it is started hidden and RPC is polled.
                var psi = new ProcessStartInfo(exe, "-datadir=\"" + _datadir + "\"")
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = _dir
                };
                _node = Process.Start(psi);
                _startedNode = true;
                WalletProgram.Note("node: started " + exe + " on " + _datadir);
            }
            catch (Exception ex)
            {
                _nodeStatus = "Could not start the node: " + ex.Message;
                WalletProgram.Note("node: start failed: " + ex.Message);
                return;
            }

            for (int i = 0; i < 90; i++)
            {
                if (RpcAlive()) { _nodeUp = true; _nodeStatus = ""; return; }
                if (_node != null && _node.HasExited)
                {
                    // It died at once. The usual reason is that another
                    // bitcoind holds THIS data folder's lock - an earlier copy
                    // of this app still shutting down, or still rescanning
                    // after an unclean stop. Wait for that one rather than
                    // claim it: it is not ours to stop.
                    _startedNode = false;
                    _node = null;
                    _nodeStatus = "Waiting for a node that is already using this wallet's data folder...";
                    Push();
                    for (int j = 0; j < 300; j++)
                    {
                        if (RpcAlive()) { _nodeUp = true; _nodeStatus = ""; return; }
                        if (_stop.WaitOne(1000)) return;
                    }
                    _nodeStatus = "The node could not be started. If another program is using " + _datadir +
                                  ", close it; otherwise see debug.log in that folder.";
                    WalletProgram.Note("node: exited at once and nothing answered on " + WalletProgram.RPC_PORT);
                    return;
                }
                if (_stop.WaitOne(1000)) return;
            }
            _nodeStatus = "The node is taking a long time to start. Still waiting...";
        }

        void Poll()
        {
            if (_quitting) return;
            if (!_nodeUp)
            {
                if (RpcAlive())
                {
                    _nodeUp = true;
                    _nodeStatus = "";
                    OnNodeUp();
                }
                else if (_node != null && _node.HasExited && _startedNode)
                {
                    _nodeStatus = "The node stopped unexpectedly. See debug.log in " + _datadir + ".";
                }
                Push();
                return;
            }

            var s = Snapshot();
            var r = _rpc.Call(null, "getblockchaininfo", "[]", 10000);
            if (r.Ok)
            {
                s.ChainKnown = true;
                s.Blocks = (long)(Json.Number(r.Result, "blocks") ?? -1.0);
                s.Headers = (long)(Json.Number(r.Result, "headers") ?? -1.0);
                s.Ibd = Json.Bool(r.Result, "initialblockdownload") ?? true;
                s.Progress = Json.Number(r.Result, "verificationprogress") ?? 0.0;
            }
            else if (r.Transport)
            {
                // The node stopped answering. Nothing below is worth asking,
                // and the figures on screen keep their age rather than
                // becoming zero.
                _nodeUp = false;
                _nodeStatus = "The PCoin node is not answering.";
                s.NodeUp = false;
                s.NodeStatus = _nodeStatus;
                _last = s;
                Push();
                return;
            }
            var c = _rpc.Call(null, "getconnectioncount", "[]", 5000);
            if (c.Ok && c.Result is double) s.Peers = (int)(double)c.Result;

            if (_phrase != null)
            {
                var b = _rpc.Call(_phrase.Wallet, "getbalances", "[]", 10000);
                if (b.Ok)
                {
                    var mine = Json.Field(b.Result, "mine");
                    double? trusted = Json.Number(mine, "trusted");
                    if (trusted.HasValue)
                    {
                        s.BalanceKnown = true;
                        s.TrustedSat = ForwardPolicy.ToSat(trusted.Value);
                        s.PendingSat = ForwardPolicy.ToSat(Json.Number(mine, "untrusted_pending") ?? 0.0);
                        s.ImmatureSat = ForwardPolicy.ToSat(Json.Number(mine, "immature") ?? 0.0);
                    }
                }
                else if (!b.Transport && b.Code.HasValue && b.Code.Value == -18)
                {
                    // -18 RPC_WALLET_NOT_FOUND: not loaded. Load it and read
                    // again next time round.
                    _seed.EnsureWallet(_phrase.Wallet, false, false);
                }
            }
            s.BalanceTrustworthy = s.ChainKnown && !s.Ibd && s.Blocks >= 0 && s.Headers >= 0 && s.Blocks >= s.Headers;
            _last = s;
            try { _sync.BeginInvoke(new Action(() => { if (_window != null) _window.Apply(s); })); }
            catch { }
        }

        /**
         * Diagnostic only. Asks the node whether it owns the stored address.
         * A "no" is shown as a warning and a failed call as "could not verify";
         * NEITHER ever discards the stored address (CLAUDE.md section 7.1 -
         * this exact read once threw away a payout address).
         */
        void VerifyAddress()
        {
            if (_phrase == null) return;
            var r = _rpc.Call(_phrase.Wallet, "getaddressinfo", "[" + Json.Quote(_phrase.Address0) + "]", 20000);
            if (!r.Ok)
            {
                _addressWarning = "Could not verify the receive address with the node yet.";
                return;
            }
            bool? mine = Json.Bool(r.Result, "ismine");
            if (mine == true) _addressWarning = "";
            else if (mine == false)
                _addressWarning = "WARNING: the node does not recognise this address as its own. " +
                                  "Do not receive to it until this is resolved - see pcoin-wallet.log.";
            else _addressWarning = "Could not verify the receive address with the node yet.";
            if (mine != true) WalletProgram.Note("verify: getaddressinfo ismine=" + (mine.HasValue ? mine.Value.ToString() : "unknown") + " for the stored address");
        }

        bool BalanceTrustworthy() { return _last.BalanceTrustworthy; }

        // ---------------------------------------------------------- actions

        void RequireNode()
        {
            throw new InvalidOperationException("The PCoin node is not running yet.");
        }

        void OnSend()
        {
            if (_phrase == null) { OnSetup(); return; }
            if (!_nodeUp)
            {
                MessageBox.Show("The PCoin node is not running yet. Wait for it to start.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            WarnIfBookUnreadable();
            using (var f = new SendForm(_engine, _phrase.Wallet, _book, _phrase.Address0))
            {
                f.ShowDialog();
            }
            // A send changes the balance: refresh now rather than on the next tick.
            var t = new Thread(() => { try { Poll(); } catch { } }) { IsBackground = true };
            t.Start();
        }

        void OnHistory()
        {
            if (_phrase == null) { OnSetup(); return; }
            if (!_nodeUp)
            {
                MessageBox.Show("The PCoin node is not running yet. Wait for it to start.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            using (var f = new HistoryForm(_engine, _phrase.Wallet, _book, BalanceTrustworthy))
            {
                f.ShowDialog();
            }
        }

        void OnAddressBook()
        {
            WarnIfBookUnreadable();
            using (var f = new AddressBookForm(_book, false))
            {
                f.ShowDialog();
            }
        }

        //! Said once per run, and only after a load that actually failed.
        void WarnIfBookUnreadable()
        {
            if (_bookWarned) return;
            _book.Load();
            if (!_book.LastLoadUnreadable) return;
            _bookWarned = true;
            MessageBox.Show(
                "Your address book file could not be read (" + _book.LastLoadWhy + ").\r\n\r\n" +
                "It has NOT been deleted: a copy was kept as\r\n" + _book.CorruptPath + "\r\n\r\n" +
                "The address book starts empty. If you have an exported copy, import it.",
                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }

        void OnSetup()
        {
            if (_phrase != null)
            {
                MessageBox.Show("This PC already has a wallet. Its receive address is shown in the window.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            if (!string.IsNullOrEmpty(_walletProblem))
            {
                MessageBox.Show(_walletProblem, "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (!_nodeUp)
            {
                MessageBox.Show("The PCoin node is still starting. Try again in a moment.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            RunSetup(true);
        }

        /**
         * Create or restore the wallet. The same steps as the miner tray's
         * phrase setup, minus everything about mining: generate (or take) the
         * words, have the node build the descriptor wallet from them and prove
         * it derives the same first address, and only then store anything.
         *
         * @param explicitAsk true when the user pressed the button; false when
         *   offered automatically at first start, where "Not now" is respected
         *   quietly.
         */
        void RunSetup(bool explicitAsk)
        {
            if (_setupRunning || _phrase != null || _quitting)
            {
                WalletProgram.Note("setup: not shown (running=" + _setupRunning + ", hasPhrase=" + (_phrase != null) + ", quitting=" + _quitting + ")");
                return;
            }
            WalletProgram.Note("setup: " + (explicitAsk ? "opened by the user" : "offered at first start"));
            _setupRunning = true;
            try
            {
                string mnemonic = null;
                bool restore;
                using (var intro = new WalletSetupForm())
                {
                    if (intro.ShowDialog() != DialogResult.OK || intro.Choice == WalletSetupChoice.Cancel) return;

                    if (intro.Choice == WalletSetupChoice.Create)
                    {
                        // A second phrase must never be generated over the top
                        // of a stored one. If the words on file are the only
                        // copy of a wallet, replacing them destroys it.
                        if (SeedStore.Exists(_dir))
                        {
                            MessageBox.Show(
                                "This PC already has a recovery phrase stored at\r\n" + SeedStore.PathFor(_dir) +
                                "\r\n\r\nNothing has been changed. Move that file somewhere safe first if you " +
                                "really mean to start over with a different phrase.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                            return;
                        }
                        restore = false;
                        mnemonic = Bip39.Generate(intro.WordCount);
                        var words = mnemonic.Split(' ');
                        while (true)
                        {
                            using (var show = new PhraseShowForm(words,
                                "Write these " + words.Length + " words down, in this order",
                                "On paper, not on this computer. Anyone who has these words can spend " +
                                "your PCoin, and nobody - not even you - can recover the coins without " +
                                "them.\r\n\r\n" +
                                "There is no copy button on purpose. Keep the paper somewhere you would " +
                                "keep a passport.",
                                "I have written it down"))
                            {
                                if (show.ShowDialog() != DialogResult.OK) return;   // nothing stored
                            }
                            using (var confirm = new PhraseConfirmForm(words))
                            {
                                var r = confirm.ShowDialog();
                                if (r == DialogResult.OK) break;
                                if (r == DialogResult.Retry) continue;
                                return;                                              // nothing stored
                            }
                        }
                    }
                    else
                    {
                        restore = true;
                        using (var rf = new PhraseRestoreForm())
                        {
                            if (rf.ShowDialog() != DialogResult.OK || string.IsNullOrEmpty(rf.Mnemonic)) return;
                            mnemonic = rf.Mnemonic;
                        }
                    }
                }

                SetupOutcome outcome = null;
                string mn = mnemonic;
                var ex = BusyForm.Run(
                    restore ? "Restoring your wallet and scanning the blockchain. This can take a few minutes."
                            : "Creating your wallet from the recovery phrase...",
                    () => { outcome = _seed.Setup(mn, restore); });

                if (ex != null)
                {
                    MessageBox.Show("Setup failed: " + RpcClient.Sanitize(ex.Message) + "\r\n\r\nNothing has been changed.",
                                    "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                if (outcome == null || !outcome.Ok)
                {
                    MessageBox.Show((outcome == null ? "Setup did not complete." : outcome.Error) +
                                    "\r\n\r\nNothing has been changed.",
                                    "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                if (SeedStore.Exists(_dir) && !outcome.AlreadySetUp)
                {
                    MessageBox.Show(
                        "This PC already has a different recovery phrase stored, so the new one has not " +
                        "been saved.\r\n\r\nNothing has been lost. Move " + SeedStore.PathFor(_dir) +
                        " somewhere safe before restoring a different phrase.",
                        "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                    return;
                }

                // The node has now proved it derives the same address from the
                // same words. Only at this point is anything persisted.
                var info = new PhraseInfo
                {
                    Wallet = outcome.Wallet,
                    Address0 = outcome.Address,
                    Network = outcome.Network,
                    Path = outcome.Path,
                    Fingerprint = outcome.Fingerprint,
                    Created = DateTime.UtcNow.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture),
                    WordCount = mnemonic.Split(' ').Length
                };
                var record = new PhraseRecord
                {
                    WordCount = info.WordCount,
                    Network = info.Network,
                    Path = info.Path,
                    Wallet = info.Wallet,
                    Address0 = info.Address0,
                    Fingerprint = info.Fingerprint,
                    BirthTime = SeedWallet.GENESIS_TIME,
                    BirthHeight = 0,
                    Created = info.Created,
                    Mnemonic = mnemonic
                };
                try
                {
                    SeedStore.Save(_dir, record, outcome.AlreadySetUp);
                    PhraseInfo.Save(_dir, info);
                }
                catch (Exception saveEx)
                {
                    MessageBox.Show(
                        "The wallet was created, but the phrase could not be saved on this PC:\r\n\r\n" +
                        saveEx.Message + "\r\n\r\nYour paper copy is what matters, so keep it safe. " +
                        "\"Recovery phrase...\" will not be able to show the words again.",
                        "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                }

                _phrase = info;
                _addressWarning = "";
                _walletProblem = "";
                _seed.EnsureConfig();
                Push();

                var msg = new StringBuilder();
                msg.Append(restore ? "Your wallet has been restored.\r\n\r\n" : "Your wallet is ready.\r\n\r\n");
                msg.Append("Receive address:\r\n").Append(outcome.Address).Append("\r\n\r\n");
                if (restore)
                {
                    if (outcome.TxCount == 0)
                        msg.Append("The scan found NO transactions for these words. If you expected coins, check " +
                                   "every word against your paper - one wrong word restores a different, empty wallet.\r\n\r\n");
                    else if (outcome.TxCount > 0)
                        msg.Append("The scan found ").Append(outcome.TxCount).Append(" transaction(s).\r\n\r\n");
                }
                msg.Append("The same words open this wallet in the PCoin Wallet app on Android.");
                MessageBox.Show(msg.ToString(), "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
            }
            finally
            {
                _setupRunning = false;
            }
        }

        /**
         * Show the stored phrase again, behind a Windows sign-in prompt. The
         * same flow as the tray: the prompt keeps a passer-by out and makes
         * revealing the words a deliberate act.
         */
        void OnRecoveryPhrase()
        {
            if (!SeedStore.Exists(_dir))
            {
                MessageBox.Show("There is no recovery phrase stored on this PC.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            var outcome = WindowsUnlock.Prompt(null,
                "Confirm your Windows sign-in to show your PCoin recovery phrase.");
            if (outcome == WindowsUnlock.Outcome.Cancelled) return;
            if (outcome == WindowsUnlock.Outcome.WrongCredential)
            {
                MessageBox.Show("That did not match your Windows sign-in. Nothing has been shown.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (outcome == WindowsUnlock.Outcome.CannotVerify)
            {
                using (var t = new TypeToConfirmForm(
                    "Windows could not check who you are",
                    "This PC signs in with a PIN, a fingerprint or no password, so there is nothing " +
                    "here that can be verified.\r\n\r\n" +
                    "Your recovery phrase is stored encrypted for this Windows account, so anyone " +
                    "already signed in as you could read it. Showing it now only makes sense if you " +
                    "are alone and no screen sharing or recording is running.",
                    "SHOW"))
                {
                    if (t.ShowDialog() != DialogResult.OK) return;
                }
            }

            PhraseRecord rec;
            try { rec = SeedStore.Load(_dir); }
            catch (Exception ex)
            {
                MessageBox.Show(
                    "The stored recovery phrase could not be decrypted on this PC.\r\n\r\n" + ex.Message +
                    "\r\n\r\nThis happens when the phrase was saved by a different Windows account, or " +
                    "when the file was copied here from another machine. Your paper copy still works.",
                    "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (rec == null || string.IsNullOrEmpty(rec.Mnemonic))
            {
                MessageBox.Show("There is no recovery phrase stored on this PC.",
                                "PCoin Wallet", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }
            using (var show = new PhraseShowForm(rec.Mnemonic.Split(' '),
                "Your PCoin recovery phrase",
                "These " + rec.WordCount + " words rebuild this wallet on any machine, including the " +
                "Android PCoin Wallet app. Check them against your paper.\r\n\r\n" +
                "First address: " + rec.Address0 + "\r\n" +
                "Derivation: " + rec.Path + "  (BIP84 / BIP39, documented in PCOIN.md)",
                "Close"))
            {
                show.ShowDialog();
            }
        }

        // ---------------------------------------------------------- quit

        /**
         * Closing the window is quitting: a wallet is something you open when
         * you want it, not a background service. The node is stopped only if
         * this app started it - a node that was already answering on our port
         * belongs to whoever started it.
         */
        void Quit()
        {
            if (_quitting) return;
            _quitting = true;
            WalletProgram.Note("quit: window closed by the user; stopping" + (_startedNode ? " the node this app started" : " nothing (node not ours)"));
            _stop.Set();
            if (_startedNode)
            {
                BusyForm.Run("Shutting down the PCoin node...", () =>
                {
                    try { _rpc.Call(null, "stop", "[]", 10000); } catch { }
                    try { if (_node != null) _node.WaitForExit(30000); } catch { }
                });
            }
            try { if (_window != null) _window.ForceClose(); } catch { }
            try { _sync.Dispose(); } catch { }
            ExitThread();
        }
    }
}
