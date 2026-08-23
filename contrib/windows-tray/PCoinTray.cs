// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// PCoin miner tray application for Windows.
//
// Deliberately built against the .NET Framework 4.x that ships with every
// Windows 10/11 install, so it can be compiled with the in-box csc.exe and
// deployed as a single .exe with no runtime to install. See build.bat.
//
// Design intent: whoever is using this PC must be able to see at a glance that
// mining is running, how hard, and be able to change or stop it in two clicks.
// Nothing here is hidden or silent.

using System;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.AccessControl;
using System.Security.Principal;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace PCoinTray
{
    static class Program
    {
        //! A winexe has no console of its own, so borrow the one it was started
        //! from. Only used by --selftest.
        [DllImport("kernel32.dll")]
        static extern bool AttachConsole(int dwProcessId);

        [STAThread]
        static int Main(string[] args)
        {
            for (int i = 0; i < args.Length; i++)
            {
                var a = args[i];
                if (a == "--selftest" || a == "-selftest") return SelfTest();
                // Set the forwarding destination on a machine with no desktop.
                // Same validation and same re-probe as the settings dialog; see
                // FleetProvision.cs for why it is not a direct file write.
                if (a == "--fleet-forward" || a == "-fleet-forward")
                {
                    AttachConsole(-1);
                    var rest = new string[Math.Max(0, args.Length - i - 1)];
                    Array.Copy(args, i + 1, rest, 0, rest.Length);
                    Console.WriteLine();
                    return FleetProvision.Run(rest);
                }
            }
            Run(args);
            return 0;
        }

        /**
         * Verify the key derivation against the published BIP32/BIP39/BIP84
         * vectors and print the PCoin test vectors.
         *
         * Anything that touches this app's cryptography must be run through
         * this before it is deployed anywhere.
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

        static void Run(string[] args)
        {
            // Refuse to run in session 0.
            //
            // Windows isolates services and anything they launch into session 0,
            // which has no desktop and no notification area. A tray app started
            // there runs perfectly, mines perfectly, and is completely invisible
            // to the person at the keyboard - who reasonably concludes their PC
            // is not mining. Worse, the single-instance mutex below is scoped to
            // the session, so the invisible copy does not prevent a second one
            // in the user's session, and the two fight over the mining mode.
            //
            // This happened on two of three machines: a remote deployment tool
            // launched the app from a service context and the icon never
            // appeared. Exiting here is what makes that self-correcting. It is
            // the first thing done, before any node is started, so there is
            // never a node left behind by the process that gives up.
            try
            {
                if (Process.GetCurrentProcess().SessionId == 0)
                {
                    Note("refusing to start in session 0: a tray icon there is invisible. "
                       + "Launch it in the interactive desktop session instead.");
                    return;
                }
            }
            catch { /* if the session cannot be read, carry on rather than not start */ }

            // --minimized means "started by the autostart shortcut": take the
            // tray icon and stay quiet. Any other launch is a person asking for
            // the app, so it opens the window.
            bool minimized = false;
            foreach (var a in args)
            {
                if (string.Equals(a, "--minimized", StringComparison.OrdinalIgnoreCase)
                    || string.Equals(a, "/minimized", StringComparison.OrdinalIgnoreCase))
                    minimized = true;
            }

            // One instance only: a second tray icon would be confusing and the
            // two would fight over the mining mode.
            //
            // But exiting silently was wrong. Someone who double-clicks the
            // desktop shortcut while the app is already running gets nothing at
            // all and reasonably concludes it is broken -- the same class of
            // mistake as the session-0 bug above, where the app was running fine
            // and simply could not be seen. So a second instance now hands the
            // request to the first one and leaves.
            // GLOBAL, not session-local, and readable across integrity levels.
            // A plain "PCoinTraySingleInstance" mutex lives in the caller's
            // session (Local\), so the v1.3.8 elevated autostart task and a
            // second copy the user double-clicks land in different namespaces and
            // BOTH run. The Global\ name + a World-allow ACL make the first copy
            // -- whatever session or elevation it is in -- the only one: every
            // later copy sees the existing mutex, hands its request to the first,
            // and leaves. (Two NODES were already impossible -- bitcoind holds a
            // datadir lock -- but two tray icons fighting over the mining mode
            // were not, which is what this closes.)
            bool created;
            Mutex mutex;
            try
            {
                var sec = new MutexSecurity();
                sec.AddAccessRule(new MutexAccessRule(
                    new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                    MutexRights.FullControl, AccessControlType.Allow));
                mutex = new Mutex(true, @"Global\PCoinTraySingleInstance", out created, sec);
            }
            catch (UnauthorizedAccessException)
            {
                // The mutex exists with an ACL we cannot open: another instance
                // owns it. Treat exactly like "already running".
                created = false;
                mutex = null;
            }
            using (mutex)
            {
                if (!created)
                {
                    if (!minimized) SignalExistingInstance();
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp(minimized));
            }
        }

        //! Named event the running instance waits on. A named EventWaitHandle is
        //! the whole IPC mechanism: no sockets, no window messages, no second
        //! file to keep in sync, and it works across the two integrity levels an
        //! installer-launched copy can end up on.
        internal const string SHOW_EVENT = @"Global\PCoinTrayShowWindow";

        /**
         * Ask the already-running copy to show itself.
         *
         * Best-effort by design. If the event cannot be opened -- the other copy
         * is starting up, or is running as a different user -- there is nothing
         * useful to say and nothing safe to do, and starting a second tray
         * anyway would be worse than doing nothing.
         */
        static void SignalExistingInstance()
        {
            try
            {
                using (var ev = EventWaitHandle.OpenExisting(SHOW_EVENT))
                    ev.Set();
            }
            catch (Exception ex)
            {
                Note("could not signal the running instance: " + ex.Message);
            }
        }

        /**
         * Record why the app declined to start.
         *
         * A winexe that exits silently is impossible to diagnose remotely, and
         * the one case that matters here - session 0 - is only ever hit from a
         * remote or service context where there is nobody to show a dialog to.
         */
        internal static void Note(string message)
        {
            try
            {
                File.AppendAllText(
                    Path.Combine(Path.GetDirectoryName(Application.ExecutablePath), "pcoin-tray.log"),
                    DateTime.Now.ToString("yyyy-MM-dd HH:mm:ss", CultureInfo.InvariantCulture)
                        + "  " + message + Environment.NewLine);
            }
            catch { }
        }
    }

    /**
     * How many mining threads this CPU actually gets FASTER with, and the one
     * place the percent -> threads mapping lives.
     *
     * THE CAP APPLIES TO FAST MODE ONLY, and that distinction is the whole
     * point -- capping both would cost light-mode miners a fifth of their rate.
     * Measured on an i9-10920X (12 physical cores, 24 logical, 19.25 MB L3),
     * 40 s per point, same machine, same chain:
     *
     *     threads       4      8      9     12     16     20     24
     *     fast  H/s  1456   2565   2720   2158   1330   1160   1183
     *     light H/s   205    375    392    462    458    505    489
     *
     * Fast mode holds the whole 2080 MiB dataset in RAM and each thread grinds a
     * 2 MiB scratchpad that is designed to sit in L3. 19.25 MB of L3 holds nine
     * of them; past that the threads evict each other's scratchpads and the
     * per-thread rate collapses faster than the extra threads add, so the TOTAL
     * falls -- all twenty-four cores produce less than four do. Light mode has
     * no dataset to stream and recomputes items instead, so it is ALU-bound
     * rather than cache-bound: hyperthread siblings genuinely help, and it keeps
     * climbing to about twenty threads.
     *
     * So the failure this prevents is specific: in FAST mode the top of the
     * slider was strictly worse on every axis at once -- less PCN, more heat,
     * more power, an unusable desktop. The owner who found it had tried 15% and
     * 100% and could not tell them apart, which is exactly right: 100% was
     * 1183 H/s and 15% was 1456. In LIGHT mode the same top of the slider is
     * honest, so it is left alone.
     *
     * UNKNOWN IS NOT UNLIMITED. If the topology cannot be read we fall back to
     * half the logical processors: right on every hyperthreaded machine, merely
     * conservative on the rest. Guessing "all of them" is the one answer we know
     * to be harmful in fast mode.
     */
    static class Cpu
    {
        const uint RELATION_PROCESSOR_CORE = 0;
        const uint RELATION_CACHE = 2;
        const long SCRATCHPAD_BYTES = 2L * 1024 * 1024;   // RANDOMX_SCRATCHPAD_L3

        // SYSTEM_LOGICAL_PROCESSOR_INFORMATION. The trailing union is 16 bytes,
        // so the whole record is 32 on x64 -- Size=32 is load-bearing: with an
        // explicit layout Marshal.SizeOf would otherwise report 24 (the last
        // field's extent) and every record after the first would be misread.
        [StructLayout(LayoutKind.Explicit, Size = 32)]
        struct SLPI
        {
            [FieldOffset(0)]  public ulong ProcessorMask;
            [FieldOffset(8)]  public uint  Relationship;
            [FieldOffset(16)] public byte  CacheLevel;
            [FieldOffset(20)] public uint  CacheSize;
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GetLogicalProcessorInformation(IntPtr buffer, ref uint returnLength);

        static int _useful = -1;
        static int _physical = -1;   // -1 = not read yet; 0 = unreadable

        //! Read the topology once. Failure leaves _physical at 0, which callers
        //! must treat as "unknown", never as "no cores" -- unknown gives no
        //! advice rather than wrong advice.
        static void EnsureTopology(int logicalCores)
        {
            if (_useful > 0) return;

            int answer = Math.Max(1, logicalCores / 2);   // see the note above
            int physical = 0;
            try
            {
                if (IntPtr.Size == 8)
                {
                    uint len = 0;
                    GetLogicalProcessorInformation(IntPtr.Zero, ref len);   // sizing call
                    if (len > 0)
                    {
                        IntPtr buf = Marshal.AllocHGlobal((int)len);
                        try
                        {
                            if (GetLogicalProcessorInformation(buf, ref len))
                            {
                                int stride = Marshal.SizeOf(typeof(SLPI));
                                long l3 = 0;
                                for (int i = 0; i + stride <= (int)len; i += stride)
                                {
                                    var e = (SLPI)Marshal.PtrToStructure(
                                        (IntPtr)(buf.ToInt64() + i), typeof(SLPI));
                                    if (e.Relationship == RELATION_PROCESSOR_CORE) physical++;
                                    else if (e.Relationship == RELATION_CACHE && e.CacheLevel == 3) l3 += e.CacheSize;
                                }
                                int byCache = (int)(l3 / SCRATCHPAD_BYTES);
                                if (physical > 0 && byCache > 0) answer = Math.Min(physical, byCache);
                                else if (physical > 0) answer = physical;
                            }
                        }
                        finally { Marshal.FreeHGlobal(buf); }
                    }
                }
            }
            catch { /* fall back; never let topology detection stop the miner */ }

            _physical = physical;
            _useful = Math.Max(1, Math.Min(answer, logicalCores));
        }

        public static int UsefulThreads(int logicalCores)
        {
            if (logicalCores < 1) logicalCores = 1;
            EnsureTopology(logicalCores);
            return Math.Min(_useful, logicalCores);
        }

        //! percent -> thread count. NOTHING IS CLAMPED HERE.
        //!
        //! An earlier version capped this at UsefulThreads() in fast mode, and
        //! that was the wrong call. The owner set the slider to its maximum,
        //! got nine of twenty-four cores, and asked -- correctly -- why the
        //! control was ignoring him. A slider that silently refuses the value
        //! you gave it is a worse failure than a slider that lets you choose
        //! badly: the first cannot be understood from the screen, the second
        //! can be labelled. Recommend() exists to label it.
        public static int ThreadsFor(int percent, int logicalCores, bool fastMode)
        {
            if (percent <= 0) return 0;
            if (logicalCores < 1) logicalCores = 1;
            int t = (int)Math.Round(logicalCores * percent / 100.0, MidpointRounding.AwayFromZero);
            return Math.Max(1, Math.Min(logicalCores, t));
        }

        //! The thread count measured to be fastest on this machine, or 0 when
        //! there is no useful advice to give. ADVICE ONLY -- never enforced.
        //!
        //! Only meaningful in fast mode: light mode is ALU-bound and keeps
        //! scaling with hyperthreads, so there is nothing to warn about.
        //!
        //! AND ONLY ON MACHINES WITH HYPERTHREADING. The first version applied
        //! the L3 bound unconditionally and an i5-9600K (6 cores, no HT, 9 MB
        //! L3) promptly disproved it: the label said "more than 4 usually mines
        //! LESS" while the machine measured 3thr=1261, 4=1495, 5=1630, 6=1622
        //! H/s -- it climbs to all six cores and plateaus, no cliff anywhere.
        //! The collapse the advice describes needs sibling threads sharing one
        //! core's L1/L2 and TLB; mere scratchpad overcommit against L3 (12 MiB
        //! on 9) turned out to be nearly free. Every HT machine measured so far
        //! agrees with min(physical, L3/2MiB): the 10920X (12P/24L, 19.25 MB)
        //! peaks at 9-10, the 9900K (8P/16L, 16 MB) at 8, the 8700K (6P/12L,
        //! 12 MB) at 6. So: advise only where the data supports it.
        public static int Recommend(int logicalCores, bool fastMode)
        {
            if (!fastMode) return 0;
            if (logicalCores < 1) logicalCores = 1;
            EnsureTopology(logicalCores);
            if (_physical <= 0 || _physical >= logicalCores) return 0;  // no HT visible: no advice
            int r = UsefulThreads(logicalCores);
            return r < logicalCores ? r : 0;
        }

        //! Thread count -> the percent that produces it, for a slider that steps
        //! one CORE at a time. Percent stays the stored unit so that existing
        //! configs, install.ps1 and the tray menu all keep working unchanged.
        public static int PercentForThreads(int threads, int logicalCores)
        {
            if (logicalCores < 1) logicalCores = 1;
            if (threads <= 0) return 0;
            if (threads >= logicalCores) return 100;
            int p = (int)Math.Round(threads * 100.0 / logicalCores, MidpointRounding.AwayFromZero);
            // Round-trip it: the label and the miner must never disagree about
            // how many cores a step means.
            for (int d = 0; d <= 6; d++)
            {
                if (ThreadsFor(p + d, logicalCores, true) == threads) return p + d;
                if (ThreadsFor(p - d, logicalCores, true) == threads) return p - d;
            }
            return Math.Max(1, Math.Min(100, p));
        }
    }

    class TrayApp : ApplicationContext
    {
        readonly NotifyIcon _icon = new NotifyIcon();
        readonly System.Windows.Forms.Timer _timer = new System.Windows.Forms.Timer();
        readonly string _dir;          // folder holding bitcoind.exe / bitcoin-cli.exe
        readonly string _cfgPath;      // our own settings, next to the exe
        readonly Icon _iconMining;
        readonly Icon _iconIdle;

        //! Mining effort is expressed as a percentage of the machine, which is
        //! meaningful on any CPU, unlike a raw core count. 0 means not mining.
        //! Fast mode is a per-PC choice, not a network one: it changes how this
        //! machine computes hashes, never what the chain accepts. Off by default
        //! because it costs ~2 GB and the owner should opt in knowingly.
        //! Fast mode is the default: it is ~6.7x light mode (measured 2690 vs
        //! 400 H/s on a 24-thread i9), and the NODE already refuses it on
        //! machines that cannot take it -- no RandomX JIT, too little RAM
        //! installed, or too little available -- reporting why either way. The
        //! checkbox stays so it can be turned off, because the node can measure
        //! memory but cannot know intent: a laptop on battery, a shared box, or
        //! someone playing a game on the same PC are all reasons to say no that
        //! no amount of probing will discover.
        bool _fastMode = true;
        const int DEFAULT_PERCENT = 50;
        static readonly int[] PERCENT_STEPS = { 10, 25, 50, 75, 100 };

        //! The wallet this app has always used. It is never renamed, never
        //! unloaded and never altered by the recovery-phrase work; a
        //! phrase-backed wallet is added beside it.
        const string WALLET_MAIN = "main";

        string _address = "";
        string _addressWallet = "";    // which wallet the payout address belongs to
        //! Pool to mine for, as host:port. EMPTY MEANS SOLO -- that is the
        //! default and the behaviour every existing install keeps. Set
        //! `poolurl=pool.pc.am:3333` in pcoin-tray.cfg to switch this machine.
        string _poolUrl = "";
        string _datadir = "";          // empty = bitcoind's default location
        int _percent = DEFAULT_PERCENT;
        bool _mining;

        // Auto-calibration. RandomX fast mode does not scale with cores past the
        // point the 2 MiB scratchpads stop fitting in L3, so the best thread count
        // is a property of THIS CPU. The miner measures it instead of trusting the
        // slider. _optimalThreads is the last measured fastest count (0 = unknown);
        // _calibStatus is non-null while a benchmark is running.
        volatile bool _calibrating;
        volatile bool _cancelCalibrate;
        int _optimalThreads;
        volatile string _calibStatus;
        bool _seedDeclined;            // the user was offered a phrase and said no
        int _threads;                  // derived from _percent, reported by the node
        bool _nodeUp;
        bool _hashing;                 // observed: is the node actually hashing?
        Process _node;                 // set only if we launched it ourselves
        bool _startedNode;
        double _hashrate;
        long _blocksFound;
        bool _poolMining;              // observed from the node, not from _poolUrl
        long _sharesAccepted;
        long _sharesRejected;
        string _poolStatus = "";       // empty means the pool connection is fine
        long _height;
        int _cores = Environment.ProcessorCount;

        RpcClient _rpc;                // HTTP RPC; anything carrying key material uses this
        SeedWallet _seed;
        PhraseInfo _phrase;            // null until a recovery phrase exists
        int _balanceTick;
        bool _balanceBusy;
        readonly Form _sync = new Form();   // never shown; used to get onto the UI thread

        // Automatic forwarding of mined coins. Opt-in, starts empty, and its
        // own state lives in pcoin-forward.json rather than pcoin-tray.cfg -
        // install.ps1 rewrites that config wholesale on every upgrade and would
        // destroy an in-flight sweep record with it.
        ForwardStore _forwardStore;
        ForwardEngine _forward;
        HashSet<string> _loadedWallets = new HashSet<string>(StringComparer.Ordinal);

        MinerWindow _window;           // created the first time it is opened
        bool _pollBusy;                // a status poll is in flight
        int _tick;                     // timer ticks, one per second
        bool _haveChainInfo;           // height/peers/difficulty have been read once
        bool _nodeEverUp;              // the node has answered at least once
        string _problem;               // why the node is unreachable, in words
        bool _reviveBusy;              // a node restart is in flight
        int _reviveCooldown;           // ticks to wait before trying again
        readonly RateHistory _history = new RateHistory();

        // The node's own vitals, refreshed rarely: enumerating processes is far
        // more expensive than an RPC call and none of it changes second to
        // second.
        int _nodePid;
        double _nodeMemMb;
        TimeSpan _nodeUptime;
        int _procTick;

        // Latest readings that both the menu and the window display. Held as
        // text because that is what both show, and null means "not known yet"
        // rather than zero.
        string _balPhraseText;
        string _balOldText;
        int _peers = -1;
        long _headers;
        double _progress = 1.0;
        bool _syncing;
        double _difficulty;
        string _nodeVersion = "";
        int _versionTick;

        readonly ToolStripMenuItem _miStatus = new ToolStripMenuItem("Starting...") { Enabled = false };
        ToolStripMenuItem _miOptimal;   // shows the measured fastest thread count; click = use it
        readonly ToolStripMenuItem _miChain = new ToolStripMenuItem("") { Enabled = false };
        readonly ToolStripMenuItem _miEarned = new ToolStripMenuItem("") { Enabled = false };
        readonly ToolStripMenuItem _miBackedUp = new ToolStripMenuItem("") { Enabled = false, Visible = false };
        readonly ToolStripMenuItem _miOldWallet = new ToolStripMenuItem("") { Enabled = false, Visible = false };
        // Forwarding gets three lines, not one: what it is doing, WHERE it is
        // sending (always, from persisted intent), and the last forward with its
        // transaction id. A destination hidden inside a status sentence is a
        // destination nobody checks.
        readonly ToolStripMenuItem _miForward = new ToolStripMenuItem("") { Enabled = false, Visible = false };
        readonly ToolStripMenuItem _miForwardTo = new ToolStripMenuItem("") { Enabled = false, Visible = false };
        readonly ToolStripMenuItem _miForwardLast = new ToolStripMenuItem("") { Enabled = false, Visible = false };
        ToolStripMenuItem _miPhrase;
        ToolStripMenuItem _miOff;
        readonly Dictionary<int, ToolStripMenuItem> _miPercent = new Dictionary<int, ToolStripMenuItem>();

        //! Percentage of the machine -> worker threads. Always at least one
        //! thread, never more than the machine has.
        int ThreadsFor(int percent) { return Cpu.ThreadsFor(percent, _cores, _fastMode); }

        public TrayApp() : this(false) { }

        public TrayApp(bool minimized)
        {
            _dir = Path.GetDirectoryName(Application.ExecutablePath);
            _cfgPath = Path.Combine(_dir, "pcoin-tray.cfg");
            // Both states share the graphite field so the app is recognisable at
            // a glance; mining vs idle is carried by the brightness of the mark.
            // Graphite is nearly invisible against a dark taskbar, which is the
            // point -- what you see is the coin floating, not a dark square.
            _iconMining = MakeIcon(Color.FromArgb(0x26, 0x2B, 0x33), Color.White);
            _iconIdle = MakeIcon(Color.FromArgb(0x26, 0x2B, 0x33), Color.FromArgb(0x7C, 0x87, 0x94));

            LoadConfig();
            _rpc = new RpcClient(_datadir);
            _seed = new SeedWallet(_rpc);
            _phrase = PhraseInfo.Load(_dir);
            var force = _sync.Handle;   // realise the handle so Invoke works later

            // Forwarding is opt-in and starts empty; constructing the engine
            // sends nothing and asks the node nothing. A store that cannot be
            // read parks forwarding rather than reading as "nothing configured".
            _forwardStore = new ForwardStore(_dir);
            _forward = new ForwardEngine(_rpc, _forwardStore,
                () => string.IsNullOrEmpty(_addressWallet) ? WALLET_MAIN : _addressWallet,
                (title, body, important) => Balloon(title, body, important),
                () => OnForwardChanged());

            BuildMenu();

            _icon.Icon = _iconIdle;
            _icon.Text = "PCoin Miner - starting";
            _icon.Visible = true;
            _icon.DoubleClick += (s, e) => ShowWindow();

            // Bring the node up (and resume the saved mining mode) off the UI
            // thread: bitcoind can take a few seconds to become responsive.
            var t = new Thread(Startup) { IsBackground = true };
            t.Start();

            // One second, but see Refresh(): a closed window only polls every
            // third tick, which is the interval this app has always used.
            _timer.Interval = 1000;
            _timer.Tick += (s, e) => Refresh();
            _timer.Start();

            StartShowListener();

            // Launched by a person, so show the window. Autostart passes
            // --minimized and lands here with minimized=true, because a window
            // appearing on every sign-in is a different product.
            if (!minimized) ShowWindow();
        }

        /**
         * Wait for a second copy of the app to ask us to show ourselves.
         *
         * The wait is on a background thread and the response is marshalled onto
         * the UI thread through _sync: touching a WPF window from the waiting
         * thread would throw, and the failure would be invisible because nobody
         * is watching this thread's exceptions.
         */
        void StartShowListener()
        {
            EventWaitHandle ev;
            try
            {
                // AutoReset: each request is consumed by exactly one wait, so two
                // rapid double-clicks cannot leave the event permanently signalled.
                // World-allow ACL so a copy at a different integrity level (a
                // non-elevated double-click vs the elevated autostart) can still
                // open it to hand over -- matching the Global\ mutex above.
                var esec = new EventWaitHandleSecurity();
                esec.AddAccessRule(new EventWaitHandleAccessRule(
                    new SecurityIdentifier(WellKnownSidType.WorldSid, null),
                    EventWaitHandleRights.FullControl, AccessControlType.Allow));
                bool evCreated;
                ev = new EventWaitHandle(false, EventResetMode.AutoReset, Program.SHOW_EVENT, out evCreated, esec);
            }
            catch (Exception ex)
            {
                // Losing this costs the "activate the running copy" behaviour and
                // nothing else, so it must never stop the miner from starting.
                Program.Note("show-listener unavailable: " + ex.Message);
                return;
            }

            var t = new Thread(() =>
            {
                for (; ; )
                {
                    try
                    {
                        ev.WaitOne();
                        _sync.BeginInvoke((Action)(() => ShowWindow()), null);
                    }
                    catch { return; }
                }
            }) { IsBackground = true, Name = "pcoin-show-listener" };
            t.Start();
        }

        // ---------- settings ----------

        void LoadConfig()
        {
            try
            {
                if (!File.Exists(_cfgPath)) return;
                foreach (var line in File.ReadAllLines(_cfgPath))
                {
                    int eq = line.IndexOf('=');
                    if (eq <= 0) continue;
                    string k = line.Substring(0, eq).Trim();
                    string v = line.Substring(eq + 1).Trim();
                    if (k == "address") _address = v;
                    else if (k == "addresswallet") _addressWallet = v;
                    else if (k == "poolurl") _poolUrl = v;
                    else if (k == "seedprompt") _seedDeclined = v == "declined";
                    else if (k == "fastmode") _fastMode = v == "1";
                    else if (k == "datadir") _datadir = v;
                    else if (k == "optimal") { int o; if (int.TryParse(v, out o)) _optimalThreads = o; }
                    else if (k == "percent")
                    {
                        int p;
                        if (int.TryParse(v, out p)) { _percent = p; _mining = p > 0; }
                    }
                    else if (k == "threads")
                    {
                        // Older config: a raw thread count. Convert once.
                        int t;
                        if (int.TryParse(v, out t))
                        {
                            _mining = t > 0;
                            _percent = t > 0
                                ? Math.Max(10, Math.Min(100, (int)Math.Round(t * 100.0 / Math.Max(1, _cores))))
                                : DEFAULT_PERCENT;
                        }
                    }
                }
            }
            catch { /* a broken config must not stop the app starting */ }
        }

        void SaveConfig()
        {
            try
            {
                File.WriteAllText(_cfgPath,
                    "address=" + _address + "\r\n" +
                    "addresswallet=" + _addressWallet + "\r\n" +
                    "poolurl=" + _poolUrl + "\r\n" +
                    "datadir=" + _datadir + "\r\n" +
                    "percent=" + (_mining ? _percent : 0).ToString(CultureInfo.InvariantCulture) + "\r\n" +
                    "optimal=" + _optimalThreads.ToString(CultureInfo.InvariantCulture) + "\r\n" +
                    "seedprompt=" + (_seedDeclined ? "declined" : "") + "\r\n" +
                    "fastmode=" + (_fastMode ? "1" : "0") + "\r\n");
            }
            catch { }
        }

        // ---------- menu ----------

        void BuildMenu()
        {
            var menu = new ContextMenuStrip();
            // The window first, in bold: it is the default action for a
            // double-click, and everything below is a shortcut into it.
            var open = new ToolStripMenuItem("Open PCoin Miner", null, (s, e) => ShowWindow())
            {
                Font = new Font(SystemFonts.MenuFont, FontStyle.Bold)
            };
            menu.Items.Add(open);
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(_miStatus);
            menu.Items.Add(_miChain);
            menu.Items.Add(_miEarned);
            menu.Items.Add(_miBackedUp);
            menu.Items.Add(_miOldWallet);
            menu.Items.Add(_miForward);
            menu.Items.Add(_miForwardTo);
            menu.Items.Add(_miForwardLast);
            // No "I received it" item: forwarding arms itself once the node
            // confirms the test payment. See ForwardEngine's arming block for
            // what that trades away.
            menu.Items.Add(new ToolStripSeparator());

            _miOff = new ToolStripMenuItem("Not mining", null, (s, e) => SetMode(0));
            menu.Items.Add(_miOff);
            foreach (int p in PERCENT_STEPS)
            {
                int pct = p; // capture
                var item = new ToolStripMenuItem(
                    string.Format(CultureInfo.InvariantCulture, "Mine at {0}%  ({1} of {2} cores)",
                                  pct, ThreadsFor(pct), _cores),
                    null, (s, e) => SetMode(pct));
                _miPercent[pct] = item;
                menu.Items.Add(item);
            }
            _miOptimal = new ToolStripMenuItem("", null, (s, e) => ResetToOptimal()) { Visible = false };
            menu.Items.Add(_miOptimal);

            menu.Items.Add(new ToolStripSeparator());
            // No "copy the phrase" anywhere. Copying an address is fine - an
            // address is public - and copying twelve words is not.
            _miPhrase = new ToolStripMenuItem("Recovery phrase...", null, (s, e) => OnRecoveryPhrase());
            menu.Items.Add(_miPhrase);
            menu.Items.Add(new ToolStripMenuItem("Forward my coins...", null, (s, e) => OpenForwardSettings()));
            menu.Items.Add(new ToolStripMenuItem("Copy payout address", null, (s, e) =>
            {
                if (!string.IsNullOrEmpty(_address)) Clipboard.SetText(_address);
            }));
            menu.Items.Add(new ToolStripMenuItem("Open PCoin folder", null, (s, e) =>
            {
                try { Process.Start("explorer.exe", _dir); } catch { }
            }));
            menu.Items.Add(new ToolStripMenuItem("What is this?", null, (s, e) => ShowAbout()));
            menu.Items.Add(new ToolStripSeparator());
            menu.Items.Add(new ToolStripMenuItem("Stop mining and exit", null, (s, e) => Quit()));

            _icon.ContextMenuStrip = menu;
        }

        void MarkMode()
        {
            _miOff.Checked = !_mining;
            foreach (var kv in _miPercent) kv.Value.Checked = _mining && kv.Key == _percent;
            if (_miOptimal != null)
            {
                if (_optimalThreads > 0)
                {
                    int cur = ThreadsFor(_percent);
                    bool atBest = _mining && cur == _optimalThreads;
                    _miOptimal.Visible = true;
                    _miOptimal.Enabled = !atBest;
                    _miOptimal.Text = atBest
                        ? string.Format(CultureInfo.InvariantCulture, "✓ Fastest here: {0} cores (auto-tuned)", _optimalThreads)
                        : string.Format(CultureInfo.InvariantCulture, "⚠ Fastest is {0} cores — click to use", _optimalThreads);
                }
                else { _miOptimal.Visible = false; }
            }
        }

        // ---------- node control ----------

        void Startup()
        {
            EnsureNode();

            // Fast mode is ON by default, so startup has to carry the same
            // safety net the checkbox has had since v1.2.4.
            //
            // -randomxfastmode is a node option, and Core exits on an option it
            // does not recognise. A tray that is newer than the bitcoind.exe
            // beside it -- someone who copied PCoinTray.exe over an older
            // install -- would otherwise get a node that never starts, with the
            // cause invisible and no way to reach the checkbox to undo it,
            // because the window shows "the node is not answering" either way.
            // Turning the default off and trying once more cannot leave the
            // machine worse than it started, and it mines in light mode instead
            // of not at all.
            if (!_nodeUp && _fastMode)
            {
                Program.Note("startup: node did not start with fast mode, retrying without it");
                _fastMode = false;
                SaveConfig();
                EnsureNode();
            }

            EnsureWalletLoaded();
            EnsurePhraseWallet();
            if (string.IsNullOrEmpty(_address)) _address = EnsureAddress();
            if (_mining) BeginCalibrationOrMine();
            SaveConfig();
            ForwardNodeReady();
            OfferPhraseSetup();
        }

        /**
         * Reconcile forwarding against the node that has just come up.
         *
         * An interrupted send has to be resolved before anything is allowed to
         * build, and that check has to happen against THIS node - a restart is
         * exactly the event that loses a mempool. Never throws: forwarding
         * failing must never stop this PC mining.
         */
        void ForwardNodeReady()
        {
            try
            {
                if (!_nodeUp) return;
                var loaded = _seed.LoadedWallets();
                // Null means the node could not be asked, which is not an empty
                // set. Passing an empty one would make reconciliation throw with
                // "wallet not loaded", which is the correct outcome anyway: it
                // leaves forwarding unreconciled, so no build is permitted.
                var set = new HashSet<string>(StringComparer.Ordinal);
                if (loaded != null) foreach (var w in loaded) set.Add(w);
                _loadedWallets = set;
                _forward.OnNodeReady(set);
            }
            catch { }
        }

        /**
         * Load the phrase-backed wallet, if this machine has one.
         *
         * It is loaded in addition to whatever wallet was already here. Nothing
         * is created: a missing pcoin-hd wallet with a phrase on file means
         * something is wrong that a silent createwallet would only paper over.
         */
        void EnsurePhraseWallet()
        {
            if (!_nodeUp || _phrase == null || string.IsNullOrEmpty(_phrase.Wallet)) return;
            _seed.EnsureWallet(_phrase.Wallet, false, false);

            // Adopt the recorded payout address only when nothing is saved -
            // for instance after an upgrade blanked the config. A saved address
            // is the user's persisted intent and is never replaced from here.
            if (string.IsNullOrEmpty(_address) && !string.IsNullOrEmpty(_phrase.Address0))
            {
                _address = _phrase.Address0;
                _addressWallet = _phrase.Wallet;
                SaveConfig();
            }
        }

        /**
         * bitcoind does not open any wallet by itself, so the balance stays
         * invisible until something asks for it. That used to happen as a side
         * effect of EnsureAddress(), which is skipped once an address is saved
         * — so after an upgrade the node mined happily while reporting no
         * wallet at all. Load it explicitly, and ask the node to remember it so
         * a future restart does not depend on this app at all.
         *
         * LOAD ONLY. This used to call EnsureWallet(create:true) on every
         * startup, so wallet creation was a side effect of the app launching -
         * the exact pattern that was deliberately removed from the Android
         * NodeController. It did no damage today only because Core refuses
         * createwallet over an existing directory; on a machine that has
         * legitimately migrated to pcoin-hd it would silently manufacture an
         * empty "main", and it was one Core behaviour change away from being
         * dangerous. Creating a wallet is now something only the setup flow
         * does, deliberately, from a recovery phrase.
         */
        void EnsureWalletLoaded()
        {
            if (!_nodeUp) return;

            // Over the socket first, because "getwalletinfo" through bitcoin-cli
            // fails once more than one wallet is loaded - it has no way to know
            // which one is meant - and that failure used to read as "no wallet
            // is open".
            if (_seed.EnsureWallet(WALLET_MAIN, false, false) == null) return;

            if (Cli("getwalletinfo") != null) return;   // already open
            Cli("loadwallet \"main\" true");            // true => load on startup
        }

        void EnsureNode()
        {
            if (Cli("getblockcount") != null) { _nodeUp = true; return; }

            // RPC silence does not mean there is no node.
            //
            // Core answers nothing useful while it loads, and after an unclean
            // shutdown that includes a full wallet rescan - minutes, not
            // seconds. Starting a second bitcoind then is pointless (it dies on
            // the data directory lock) and would mark this app as the node's
            // owner, so it would try to shut down a node it never started.
            // Wait for the one that is already there instead.
            bool already;
            try { already = Process.GetProcessesByName("bitcoind").Length > 0; }
            catch { already = false; }
            if (already)
            {
                for (int i = 0; i < 300; i++)
                {
                    if (Cli("getblockcount") != null) { _nodeUp = true; return; }
                    try { if (Process.GetProcessesByName("bitcoind").Length == 0) break; }
                    catch { break; }
                    Thread.Sleep(1000);
                }
                return;
            }

            try
            {
                // NOTE: -daemon/-daemonwait are Unix-only; on Windows bitcoind
                // always runs in the foreground. Start it as a hidden child
                // process instead and poll until RPC answers.
                var psi = new ProcessStartInfo(Path.Combine(_dir, "bitcoind.exe"), NodeArgs())
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WorkingDirectory = _dir
                };
                _node = Process.Start(psi);
                _startedNode = true;
            }
            catch { return; }

            for (int i = 0; i < 90; i++)
            {
                if (Cli("getblockcount") != null) { _nodeUp = true; return; }
                if (_node != null && _node.HasExited) return; // it died; give up
                Thread.Sleep(1000);
            }
        }

        //! Arguments applied to BOTH bitcoind and bitcoin-cli, so the two always
        //! agree about which datadir and network they are talking about.
        //!
        //! ONLY put an argument here if bitcoin-cli itself declares it. The two
        //! binaries have separate argument tables, and Core does not ignore an
        //! argument it does not know: bitcoin-cli exits 1 with "Error parsing
        //! command line arguments: Invalid parameter -x", which Cli() reads as
        //! "the call failed". A daemon-only flag added here therefore does not
        //! degrade one feature, it silently fails EVERY RPC the tray makes.
        string CommonArgs()
        {
            return string.IsNullOrEmpty(_datadir) ? "" : "-datadir=\"" + _datadir + "\"";
        }

        //! Arguments for bitcoind: everything above, plus the daemon-only flags.
        //!
        //! -randomxfastmode is registered by the node's SetupServerArgs and by
        //! nothing else, so it MUST NOT reach bitcoin-cli. It did until v1.3.6,
        //! and the result was that ticking "Fast mode" bricked the whole tray:
        //! every Cli() call exited 1, so _nodeUp could never become true, the
        //! "intent is on but the node is not hashing" recovery could never fire,
        //! ReviveNode() bailed out because bitcoind really was running, and
        //! startmining was never issued. The node sat there in perfect health,
        //! fast mode and all, mining NOTHING, while the tray showed "The PCoin
        //! node is not answering" -- and the node reported mining=false with an
        //! empty modereason, because a dataset nobody asked for has nothing to
        //! say for itself. That cost a full evening to find; keep the split.
        //!
        //! Mining-only. The verification path stays in light mode whatever this
        //! says, so the worst case of getting it wrong is a slower or a hungrier
        //! miner -- never a different view of the chain.
        string NodeArgs()
        {
            var args = CommonArgs();
            if (_fastMode) args += " -randomxfastmode";
            return args;
        }

        string EnsureAddress()
        {
            // With a recovery phrase in use, the payout address comes from the
            // phrase - not from whichever wallet happens to answer first. This
            // is what stops an upgrade that blanks the config from quietly
            // moving mining rewards back into the wallet with no backup.
            if (_phrase != null && !string.IsNullOrEmpty(_phrase.Address0))
            {
                _addressWallet = _phrase.Wallet;
                return _phrase.Address0;
            }

            // Reuse an existing wallet if there is one; create it otherwise.
            if (Cli("loadwallet \"main\"") == null && Cli("getwalletinfo") == null)
            {
                Cli("createwallet \"main\"");
            }
            string a = Cli("getnewaddress \"mining\"");
            _addressWallet = WALLET_MAIN;
            return a == null ? "" : a.Trim();
        }

        void SetMode(int percent)
        {
            _cancelCalibrate = true;   // a deliberate choice wins over an in-flight auto-tune
            _mining = percent > 0;
            if (percent > 0) _percent = percent;
            SaveConfig();
            MarkMode();
            int threads = ThreadsFor(percent);
            var t = new Thread(() =>
            {
                if (threads == 0) { Cli("stopmining"); }
                else
                {
                    if (string.IsNullOrEmpty(_address)) _address = EnsureAddress();
                    StartMining(threads);
                }
            })
            { IsBackground = true };
            t.Start();
        }

        //! Start mining -- solo, or for a pool when `poolurl` is set in the config.
        //!
        //! THE POOL BRANCH LIVES HERE, IN THE ONE FUNCTION EVERY CALLER GOES
        //! THROUGH, and that is the whole point. The tray re-issues mining from
        //! four places -- app start, node restart, the "intent is on but the node
        //! is not hashing" recovery, and the mode menu -- and every one of them
        //! calls this. Putting the branch anywhere else would leave a path that
        //! silently reverts the machine to solo, which is exactly what would have
        //! happened on the first reboot: the pool would look like it worked for a
        //! day and then quietly stop, with the balance frozen and nothing saying
        //! why.
        //!
        //! Note what is NOT sent: a ttl. The tray is the supervisor here and it
        //! is alive by definition when this runs; a dead-man's switch would only
        //! add a way for mining to stop while the tray still says it is on.
        void StartMining(int threads)
        {
            if (string.IsNullOrEmpty(_address)) return;
            string t = threads.ToString(CultureInfo.InvariantCulture);
            if (!string.IsNullOrEmpty(_poolUrl))
            {
                Cli("startpoolmining \"" + _poolUrl + "\" \"" + _address + "\" " + t);
                return;
            }
            Cli("startmining \"" + _address + "\" " + t);
        }

        // ---------- auto-calibration ----------
        //
        // Every start, benchmark a handful of thread counts (mining the whole
        // time) and settle on the fastest. RandomX fast mode collapses past the
        // point the 2 MiB scratchpads stop fitting in L3 -- on a 12C/24T i9,
        // 8 threads measured 2715 H/s and 24 threads 1125 -- so the best count is
        // a cache property this machine has to measure, not a slider default the
        // user will push to maximum. The measured optimum is remembered and shown
        // in the menu; a manual pick still wins (SetMode cancels this) and the
        // menu labels the optimum so the user can click back to it.

        void BeginCalibrationOrMine()
        {
            // Only fast mode on a hyperthreaded CPU has a collapse to tune around;
            // light mode and non-HT machines scale monotonically. Recommend()
            // returns 0 in those cases, and then there is nothing to measure.
            if (_fastMode && Cpu.Recommend(_cores, _fastMode) > 0)
            {
                var t = new Thread(Calibrate) { IsBackground = true };
                t.Start();
            }
            else
            {
                StartMining(ThreadsFor(_percent));
            }
        }

        static double TrimmedMean(List<double> xs)
        {
            if (xs == null || xs.Count == 0) return 0;
            var s = new List<double>(xs); s.Sort();
            int drop = s.Count >= 6 ? 2 : (s.Count >= 3 ? 1 : 0);   // shed warm-up lows
            double sum = 0; int n = 0;
            for (int i = drop; i < s.Count; i++) { sum += s[i]; n++; }
            return n > 0 ? sum / n : 0;
        }

        void SetCalibStatus(string s)
        {
            // Just set the field; the 1 s status timer renders it. Calling Refresh
            // from here would poll re-entrantly for no benefit on a ~15 s dwell.
            _calibStatus = s;
        }

        void Calibrate()
        {
            try
            {
                _calibrating = true;
                _cancelCalibrate = false;
                if (string.IsNullOrEmpty(_address)) _address = EnsureAddress();
                if (string.IsNullOrEmpty(_address)) { StartMining(ThreadsFor(_percent)); return; }

                // Candidates: dense around the cache heuristic, with a low anchor
                // and all-cores to bracket the peak from both sides.
                int h = Cpu.Recommend(_cores, _fastMode);
                if (h <= 0) h = _cores;
                var set = new SortedSet<int>();
                foreach (int d in new[] { -2, -1, 0, 1, 2, 4 })
                {
                    int n = h + d;
                    if (n >= 1 && n <= _cores) set.Add(n);
                }
                set.Add(Math.Max(1, _cores / 4));
                set.Add(_cores);
                var candidates = new List<int>(set);

                // Mine at the heuristic while the 2 GiB fast-mode dataset builds --
                // measuring during the build would read slow light-mode rates.
                StartMining(h);
                SetCalibStatus("Auto-tuning: preparing...");
                for (int i = 0; i < 120 && !_cancelCalibrate; i++)
                {
                    var r = Poll(false);
                    if (r.NodeUp && (r.Mode == "fast" || r.Mode == "mixed") && r.DatasetProgress >= 100) break;
                    if (i > 40 && r.NodeUp && r.Mode == "light" && r.DatasetProgress == 0) break; // fast mode not coming
                    Thread.Sleep(1500);
                }
                if (_cancelCalibrate) return;

                int bestN = h; double bestH = 0;
                var log = new List<string>();
                foreach (int n in candidates)
                {
                    if (_cancelCalibrate) return;
                    StartMining(n);
                    SetCalibStatus(string.Format(CultureInfo.InvariantCulture, "Auto-tuning: testing {0} cores...", n));
                    Thread.Sleep(3000);   // let the new workers spin up before sampling
                    var samples = new List<double>();
                    for (int k = 0; k < 8 && !_cancelCalibrate; k++)
                    {
                        Thread.Sleep(1500);
                        var r = Poll(false);
                        if (r.Hashrate > 0) samples.Add(r.Hashrate);
                    }
                    if (_cancelCalibrate) return;
                    double avg = TrimmedMean(samples);
                    log.Add(n + ":" + (int)avg);
                    // Candidates ascend, so a higher thread count must be
                    // MEANINGFULLY faster (>2%) to displace a lower one. On the
                    // flat top of the curve that biases toward fewer threads --
                    // same hash rate, less power and heat -- and it keeps run-to-
                    // run noise from flipping the pick between adjacent plateau
                    // counts.
                    if (avg > bestH * 1.02) { bestH = avg; bestN = n; }
                }
                if (_cancelCalibrate) return;

                Program.Note("auto-tune: " + string.Join(" ", log.ToArray()) + " -> best " + bestN + " (" + (int)bestH + " H/s)");
                _optimalThreads = bestN;
                _percent = Cpu.PercentForThreads(bestN, _cores);
                _mining = true;
                SaveConfig();
                StartMining(bestN);
                SetCalibStatus(null);
            }
            catch (Exception ex)
            {
                try { Program.Note("auto-tune failed: " + ex.Message); StartMining(ThreadsFor(_percent)); } catch { }
                SetCalibStatus(null);
            }
            finally { _calibrating = false; }
        }

        void ResetToOptimal()
        {
            if (_optimalThreads > 0) SetMode(Cpu.PercentForThreads(_optimalThreads, _cores));
        }

        // ---------- recovery phrase ----------

        //! Offer the phrase once, from the UI thread. If the answer is no, that
        //! is remembered and never asked again; the menu item is always there.
        void OfferPhraseSetup()
        {
            if (_phrase != null || _seedDeclined || !_nodeUp) return;
            try { _sync.BeginInvoke(new Action(() => RunPhraseSetup())); }
            catch { }
        }

        void OnRecoveryPhrase()
        {
            if (_phrase != null) ShowStoredPhrase();
            else RunPhraseSetup();
        }

        /**
         * Create or restore a phrase-backed wallet.
         *
         * Nothing is written anywhere - not the phrase file, not the config -
         * until the node has been made to agree, address for address, with the
         * words. If any step fails the machine is left exactly as it was.
         */
        void RunPhraseSetup()
        {
            if (!_nodeUp)
            {
                MessageBox.Show("The PCoin node is still starting. Try again in a moment.",
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            bool hasOldWallet = _phrase == null && !string.IsNullOrEmpty(_address);
            string mnemonic = null;
            bool restore;

            using (var intro = new PhraseIntroForm(hasOldWallet))
            {
                if (intro.ShowDialog() != DialogResult.OK || intro.Choice == SetupChoice.Cancel)
                {
                    _seedDeclined = true;
                    SaveConfig();
                    return;
                }

                if (intro.Choice == SetupChoice.Create)
                {
                    // A second phrase must never be generated over the top of a
                    // stored one. If the words on file are the only copy of a
                    // wallet, replacing them destroys it.
                    if (SeedStore.Exists(_dir))
                    {
                        MessageBox.Show(
                            "This PC already has a recovery phrase stored. Use \"Recovery phrase...\" to " +
                            "see it.\r\n\r\nNothing has been changed. If you really mean to start over with " +
                            "a different phrase, move " + SeedStore.PathFor(_dir) + " somewhere safe first.",
                            "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
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
                restore ? "Restoring your wallet and scanning the blockchain. This can take a minute."
                        : "Creating your wallet from the recovery phrase...",
                () => { outcome = _seed.Setup(mn, restore); });

            if (ex != null)
            {
                MessageBox.Show("Setup failed: " + RpcClient.Sanitize(ex.Message) +
                                "\r\n\r\nNothing has been changed.",
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (outcome == null || !outcome.Ok)
            {
                MessageBox.Show((outcome == null ? "Setup did not complete." : outcome.Error) +
                                "\r\n\r\nYour existing wallet and coins have not been touched.",
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            // A restore that produced a brand new wallet while a different
            // phrase is already on file would leave the stored words and the
            // wallet being paid into disagreeing with each other. Stop before
            // persisting anything: the node has an extra wallet, which is
            // harmless, and mining carries on paying where it was.
            if (SeedStore.Exists(_dir) && !outcome.AlreadySetUp)
            {
                MessageBox.Show(
                    "This PC already has a different recovery phrase stored, so the new one has not " +
                    "been saved and mining has not been redirected.\r\n\r\n" +
                    "Nothing has been lost: your existing wallets and coins are untouched. Move " +
                    SeedStore.PathFor(_dir) + " somewhere safe before restoring a different phrase.",
                    "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            // The node has now proved it derives the same address from the same
            // words. Only at this point is anything persisted.
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
                // Replacing is allowed only when the wallet already held these
                // exact keys - that is a repeat of the same setup, not a
                // different phrase overwriting an old one.
                SeedStore.Save(_dir, record, outcome.AlreadySetUp);
                PhraseInfo.Save(_dir, info);
            }
            catch (Exception saveEx)
            {
                MessageBox.Show(
                    "The wallet was created, but the phrase could not be saved on this PC:\r\n\r\n" +
                    saveEx.Message + "\r\n\r\n" +
                    "Your paper copy is what matters, so keep it safe. The \"Recovery phrase\" menu " +
                    "item will not be able to show the words again.",
                    "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }

            _phrase = info;
            _address = outcome.Address;
            _addressWallet = outcome.Wallet;
            _seedDeclined = false;
            SaveConfig();

            string confChanges = _seed.EnsureConfig();

            // Mining rewards go to the backed-up wallet from this moment. That
            // is the whole point of doing this early: the amount that is not
            // protected by the phrase stops growing today.
            if (_mining) StartMining(ThreadsFor(_percent));

            var msg = new StringBuilder();
            msg.Append("Your PCoin wallet is now backed up by your recovery phrase.\r\n\r\n");
            msg.Append("Mining rewards from now on are paid to:\r\n").Append(outcome.Address).Append("\r\n\r\n");

            // On a restore, say what the scan found. A single mistyped word that
            // happens to be another word from the list passes the checksum about
            // one time in sixteen, so a wrong phrase restores cleanly into an
            // empty wallet - and this dialog used to congratulate the user and
            // redirect mining to it with no caveat at all.
            if (restore)
            {
                if (outcome.TxCount < 0 || outcome.Balance < 0)
                    msg.Append("The node could not be asked what the scan found, so this wallet's " +
                               "balance is not known yet. Check the tray menu in a moment.\r\n\r\n");
                else if (outcome.TxCount == 0 && outcome.Balance == 0)
                    msg.Append("The scan finished and found NO transactions and a balance of zero.\r\n\r\n" +
                               "If this phrase should have coins, it is not the right phrase - check " +
                               "every word against your paper, and check whether you wrote down 12 " +
                               "words or 24. Nothing has been destroyed and your other wallets are " +
                               "untouched.\r\n\r\n");
                else
                    msg.Append("The scan found ")
                       .Append(outcome.TxCount.ToString(CultureInfo.InvariantCulture))
                       .Append(" transaction(s) and a balance of ")
                       .Append(outcome.Balance.ToString("0.########", CultureInfo.InvariantCulture))
                       .Append(" PC.\r\n\r\nIf that is not what you expected, check the words " +
                               "against your paper.\r\n\r\n");
            }

            if (hasOldWallet)
                msg.Append("Your previous wallet is untouched and still holds its coins. They are not " +
                           "covered by the phrase - keep the existing wallet backup.\r\n\r\n");
            if (!string.IsNullOrEmpty(confChanges) && !confChanges.StartsWith("could not"))
                msg.Append("Added to pcoin.conf (takes effect the next time the node starts): ")
                   .Append(confChanges).Append("\r\n\r\n");
            msg.Append("You can see the words again from the tray menu.");
            MessageBox.Show(msg.ToString(), "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        /**
         * Show the stored phrase again, behind a Windows sign-in prompt.
         *
         * The phrase file is encrypted for this Windows account, so this prompt
         * is not what keeps an attacker out - it is what keeps a passer-by at an
         * unattended desk out, and what makes revealing the words a deliberate
         * act rather than an accident.
         */
        void ShowStoredPhrase()
        {
            var outcome = WindowsUnlock.Prompt(null,
                "Confirm your Windows sign-in to show your PCoin recovery phrase.");

            if (outcome == WindowsUnlock.Outcome.Cancelled) return;
            if (outcome == WindowsUnlock.Outcome.WrongCredential)
            {
                MessageBox.Show("That did not match your Windows sign-in. Nothing has been shown.",
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (outcome == WindowsUnlock.Outcome.CannotVerify)
            {
                // Never lock somebody out of their own recovery phrase because
                // of how they sign in to Windows. Say plainly what this does and
                // does not protect, and make them type something.
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
                    "when the file was copied here from another machine. Your paper copy still works; " +
                    "the wallet itself is unaffected.",
                    "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }
            if (rec == null || string.IsNullOrEmpty(rec.Mnemonic))
            {
                MessageBox.Show("There is no recovery phrase stored on this PC.",
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Information);
                return;
            }

            using (var show = new PhraseShowForm(rec.Mnemonic.Split(' '),
                "Your PCoin recovery phrase",
                "These " + rec.WordCount + " words rebuild this wallet on any machine. " +
                "Check them against your paper.\r\n\r\n" +
                "First address: " + rec.Address0 + "\r\n" +
                "Derivation: " + rec.Path + "  (BIP84 / BIP39, documented in PCOIN.md)",
                "Close"))
            {
                show.ShowDialog();
            }
        }

        // ---------- forwarding ----------

        /**
         * Open the forwarding settings.
         *
         * Modal, and deliberately so: the address it writes is the destination
         * of every future block reward, and the engine re-reads that value at
         * the commit point of a send. One window at a time is one decision at a
         * time.
         */
        void OpenForwardSettings()
        {
            try
            {
                using (var f = new ForwardSettingsForm(_forward, _rpc,
                           () => string.IsNullOrEmpty(_addressWallet) ? WALLET_MAIN : _addressWallet))
                {
                    f.ShowDialog();
                }
            }
            catch (Exception ex)
            {
                MessageBox.Show("The forwarding settings could not be opened.\r\n\r\n" + ex.Message,
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
            UpdateForwardMenu();
            PushToWindow(_nodeUp);
        }

        void OnAckProbe()
        {
            try { _forward.AcknowledgeProbe(); }
            catch (Exception ex)
            {
                MessageBox.Show("That could not be saved.\r\n\r\n" + ex.Message,
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        /** Called by the engine from its worker thread. Hops to the UI thread. */
        void OnForwardChanged()
        {
            try
            {
                _sync.BeginInvoke(new Action(() =>
                {
                    UpdateForwardMenu();
                    PushToWindow(_nodeUp);
                }));
            }
            catch { }
        }

        /**
         * The three notifications forwarding is allowed to raise, and no others.
         *
         * Settled, the test payment arriving, and being stuck after three
         * consecutive failures. "No peers", "syncing" and "nothing mature yet"
         * NEVER notify - they are ordinary states shown in the app. That
         * restraint is a design decision, not a limitation.
         */
        void Balloon(string title, string body, bool important)
        {
            try
            {
                _sync.BeginInvoke(new Action(() =>
                {
                    try
                    {
                        _icon.BalloonTipTitle = title;
                        _icon.BalloonTipText = body;
                        _icon.BalloonTipIcon = important ? ToolTipIcon.Warning : ToolTipIcon.Info;
                        _icon.ShowBalloonTip(important ? 20000 : 10000);
                    }
                    catch { }
                }));
            }
            catch { }
        }

        /**
         * Forwarding's three menu lines.
         *
         * The destination is shown in EVERY non-holding state, straight from
         * persisted intent - never only inside a status sentence, and never from
         * a live reading that can go away when the node does.
         */
        void UpdateForwardMenu()
        {
            ForwardStatus f;
            try { f = _forward.Status; }
            catch { return; }

            bool holding = f.State == ForwardState.HOLDING || string.IsNullOrEmpty(f.Address);
            string line;
            if (f.HasSweep && f.SweepState != SweepState.SETTLED)
            {
                line = "Forwarding " + ForwardPolicy.CoinsSat(f.SweepAmountSat) + " - " +
                       ForwardPolicy.SweepWording(f.SweepState, f.SweepConfirmations);
            }
            else if (holding)
            {
                line = "Not forwarding - coins stay in this wallet";
            }
            else if (f.State == ForwardState.PROBING_PENDING)
            {
                line = "Forwarding: a test payment is due once coins mature";
            }
            else if (f.State == ForwardState.PROBING_SENT)
            {
                line = f.ProbeConfirmed
                    ? "Test payment arrived - confirm you can see it"
                    : "Test payment sent - waiting for it to confirm";
            }
            else
            {
                line = "Forwarding is on";
                if (f.EtaMs > 0) line += " - next in about " + ForwardPolicy.RoughDuration(f.EtaMs);
            }
            if (!holding && !string.IsNullOrEmpty(f.Blocked) && !f.HasSweep)
                line += "  (not forwarding: " + f.Blocked + ")";
            if (!string.IsNullOrEmpty(f.Error)) line += "  !";
            _miForward.Text = line;
            _miForward.Visible = true;

            _miForwardTo.Text = holding ? "" : "Forwarding to: " + f.Address;
            _miForwardTo.Visible = !holding;

            _miForwardLast.Visible = !string.IsNullOrEmpty(f.LastTxid);
            if (_miForwardLast.Visible)
            {
                _miForwardLast.Text = "Last forward: " + ForwardPolicy.CoinsSat(f.LastAmountSat) +
                                      " on " + new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                                          .AddMilliseconds(f.LastAtMs).ToLocalTime()
                                          .ToString("d MMM yyyy HH:mm", CultureInfo.InvariantCulture) +
                                      "  -  " + f.LastTxid;
            }

        }

        /**
         * The forwarding status the window should draw.
         *
         * When the node is gone, the user's intent and the address they chose
         * are properties of the install and stay on screen; whether a sweep is
         * in flight, how many confirmations it has and what is blocking it are
         * live readings and go back to unknown, rather than sitting there as
         * though they were still being updated.
         */
        ForwardStatus ForwardForDisplay(bool nodeUp)
        {
            try
            {
                var f = _forward.Status;
                if (nodeUp) return f;
                return new ForwardStatus
                {
                    State = f.State,
                    Address = f.Address,
                    ProbeConfirmed = f.ProbeConfirmed,
                    ProbeAcked = f.ProbeAcked,
                    HasRecord = f.HasRecord,
                    Error = f.Error,
                    LastTxid = f.LastTxid,
                    LastAmountSat = f.LastAmountSat,
                    LastAtMs = f.LastAtMs,
                    LastAddress = f.LastAddress,
                };
            }
            catch { return new ForwardStatus(); }
        }

        //! What the forwarding engine needs from the tray's own poll.
        NodeStats ForwardStatsFrom(Reading r)
        {
            return new NodeStats
            {
                Height = r.Height,
                Headers = r.Headers,
                InitialBlockDownload = r.InitialBlockDownload,
                TipTimeSec = r.TipTimeSec,
            };
        }

        // ---------- status ----------

        /**
         * The timer tick. Decides how much to ask the node for, and how often.
         *
         * This app runs for months on somebody else's PC, so the cost of simply
         * being open matters. Three rules keep it near zero:
         *
         *  - with the window closed there is nothing to animate, so it polls
         *    every three seconds, as it always did;
         *  - with the window open it polls once a second, but only for the hash
         *    rate, which is a single small call over loopback;
         *  - chain height, peers and difficulty change slowly and cost more, so
         *    they are refreshed every five seconds either way.
         */
        void Refresh()
        {
            _tick++;
            bool windowOpen = _window != null && _window.IsVisible;
            if (!windowOpen && (_tick % 3) != 0) return;

            if (_pollBusy) return;
            _pollBusy = true;
            bool full = (_tick % 5) == 0 || !_haveChainInfo;
            var t = new Thread(() =>
            {
                Reading r = null;
                try { r = Poll(full); }
                catch { }
                try
                {
                    var got = r;
                    _sync.BeginInvoke(new Action(() =>
                    {
                        try { ApplyReading(got); }
                        finally { _pollBusy = false; }
                    }));
                }
                catch { _pollBusy = false; }
            })
            { IsBackground = true };
            t.Start();
        }

        //! What one poll of the node returns. Null fields mean "not answered".
        class Reading
        {
            public bool Full;               // chain fields were refreshed too
            public bool NodeUp;
            public string Problem;          // why not, in words, when NodeUp is false
            public bool Hashing;
            public int Threads;
            public double Hashrate;
            public string Mode;             // "fast" / "light" / "mixed"
            public int DatasetProgress;     // RandomX fast-mode dataset build %, 0-100
            public long BlocksFound;
            public int Cores;
            //! Pool mining. PoolMining false means the three below are
            //! meaningless, NOT zero -- a solo miner must never be rendered as
            //! "0 shares accepted", which reads as broken.
            public bool PoolMining;
            public long SharesAccepted;
            public long SharesRejected;
            public string PoolStatus;
            public long Height;
            public long Headers;
            public double Progress = 1.0;
            public bool Syncing;
            public double Difficulty;
            public int Peers = -1;
            public string Version;

            // Forwarding needs the RAW readings, not the display-friendly ones.
            // Its sync tolerance is 3 blocks where the display uses 2, and it
            // needs the initialblockdownload flag itself rather than the folded
            // Syncing above; a tip age check needs the tip's own timestamp.
            public bool InitialBlockDownload;
            public long TipTimeSec;
            public HashSet<string> LoadedWallets;
        }

        /**
         * Read the node's state. Runs on a worker thread; touches no UI.
         *
         * Prefers the loopback HTTP RPC, which costs one socket, and falls back
         * to bitcoin-cli if that fails for any reason. The fallback is what
         * keeps "is the node up?" as reliable as it was before this window
         * existed - that answer drives whether mining is restarted, so it must
         * never become less trustworthy than the process-spawning version.
         */
        /**
         * Say, in one sentence a non-technical person can act on, why the node
         * is not answering.
         *
         * "Node not running" was the only thing this app ever said, whatever
         * the cause: a blocked port, a missing binary, a wrong data directory
         * and a crashed process all looked identical. Somebody whose firewall
         * is eating loopback RPC has no way to guess that from those three
         * words, so each cause now names itself and says what to do about it.
         */
        string DiagnoseNode()
        {
            string exe = Path.Combine(_dir, "bitcoind.exe");
            if (!File.Exists(exe))
                return "bitcoind.exe is missing from " + _dir + ". Reinstall PCoin.";

            bool processAlive;
            try { processAlive = Process.GetProcessesByName("bitcoind").Length > 0; }
            catch { processAlive = false; }

            string datadir = string.IsNullOrEmpty(_datadir) ? RpcClient.DefaultDataDir() : _datadir;
            if (!Directory.Exists(datadir))
                return "The data folder " + datadir + " does not exist.";

            if (!processAlive)
            {
                return _startedNode || _nodeEverUp
                    ? "The PCoin node stopped. Restarting it..."
                    : "Starting the PCoin node...";
            }

            // The process is alive but not answering. Distinguish "still
            // starting" from "something is in the way", because the advice is
            // completely different.
            if (!File.Exists(Path.Combine(datadir, ".cookie")))
                return "The node is starting up (no RPC cookie in " + datadir + " yet).";

            var probe = _rpc.Call("uptime", "[]");
            string err = probe.Error ?? "";

            // A node that is loading is not a broken node. Core answers RPC
            // during startup with error -28 and a human-readable stage, and it
            // can sit there for a while: after an unclean shutdown the wallet
            // is rescanned from its last flushed block, which on a fresh reboot
            // means replaying the chain. Reporting that as "not running" is
            // what makes people think mining has failed when it is seconds
            // away from starting - so show the node's own progress instead.
            if (err.IndexOf("-28", StringComparison.Ordinal) >= 0 ||
                err.IndexOf("warmup", StringComparison.OrdinalIgnoreCase) >= 0 ||
                err.IndexOf("Loading", StringComparison.OrdinalIgnoreCase) >= 0 ||
                err.IndexOf("Rescanning", StringComparison.OrdinalIgnoreCase) >= 0 ||
                err.IndexOf("Verifying", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                string stage = err;
                int q = stage.LastIndexOf(':');
                if (q >= 0 && q + 1 < stage.Length) stage = stage.Substring(q + 1).Trim();
                return "The node is starting up: " + (stage.Length > 0 ? stage : "please wait")
                     + ". Mining begins on its own when it is ready.";
            }

            if (err.IndexOf("401", StringComparison.Ordinal) >= 0 ||
                err.IndexOf("Unauthorized", StringComparison.OrdinalIgnoreCase) >= 0)
                return "The node refused this app's credentials. Delete .cookie in " + datadir
                     + " and restart the node.";
            if (err.IndexOf("actively refused", StringComparison.OrdinalIgnoreCase) >= 0 ||
                err.IndexOf("refused", StringComparison.OrdinalIgnoreCase) >= 0)
                return "Nothing is listening on 127.0.0.1:" + _rpc.Port + ". The node is still "
                     + "starting, or a firewall or security tool is blocking local connections "
                     + "to that port - allow bitcoind.exe on loopback.";
            if (err.IndexOf("timed out", StringComparison.OrdinalIgnoreCase) >= 0 ||
                err.IndexOf("timeout", StringComparison.OrdinalIgnoreCase) >= 0)
                return "The node is not answering in time. It may be busy starting up, or a "
                     + "firewall is silently dropping connections to 127.0.0.1:" + _rpc.Port + ".";
            if (err.Length > 0) return "The node is not answering: " + err;
            return "The node is running but not answering yet.";
        }

        Reading Poll(bool full)
        {
            var r = new Reading { Full = full };
            var mi = _rpc.Call("getcpuminerinfo", "[]");
            if (mi.Ok && mi.Result != null)
            {
                r.NodeUp = true;
                bool? m = Json.Bool(mi.Result, "mining");
                r.Hashing = m.HasValue && m.Value;
                r.Threads = (int)(Json.Number(mi.Result, "threads") ?? 0);
                r.Hashrate = Json.Number(mi.Result, "hashespersec") ?? 0;
                r.Mode = Json.Str(mi.Result, "mode");
                r.DatasetProgress = (int)(Json.Number(mi.Result, "datasetprogress") ?? 0);
                r.BlocksFound = (long)(Json.Number(mi.Result, "blocksfound") ?? 0);
                r.Cores = (int)(Json.Number(mi.Result, "cores") ?? 0);
                bool? p = Json.Bool(mi.Result, "pool");
                r.PoolMining = p.HasValue && p.Value;
                if (r.PoolMining)
                {
                    r.SharesAccepted = (long)(Json.Number(mi.Result, "sharesaccepted") ?? 0);
                    r.SharesRejected = (long)(Json.Number(mi.Result, "sharesrejected") ?? 0);
                    r.PoolStatus = Json.Str(mi.Result, "poolstatus");
                }
            }
            else
            {
                string info = Cli("getcpuminerinfo");
                if (info == null)
                {
                    // Both routes failed, so work out what to tell the user.
                    // Done here, on the polling thread, because it touches the
                    // filesystem and makes another RPC attempt.
                    try { r.Problem = DiagnoseNode(); }
                    catch (Exception ex) { r.Problem = "The node is not answering: " + ex.Message; }
                    return r;                                // NodeUp stays false
                }
                r.NodeUp = true;
                r.Hashing = Num(info, "mining") > 0 || info.Contains("\"mining\": true");
                r.Threads = (int)Num(info, "threads");
                r.Hashrate = Num(info, "hashespersec");
                r.DatasetProgress = (int)Num(info, "datasetprogress");
                r.Mode = info.Contains("\"fast\"") ? "fast" : (info.Contains("\"mixed\"") ? "mixed" : "light");
                r.BlocksFound = (long)Num(info, "blocksfound");
                r.Cores = (int)Num(info, "cores");
            }

            if (!full) return r;

            var bc = _rpc.Call("getblockchaininfo", "[]");
            if (bc.Ok && bc.Result != null)
            {
                r.Height = (long)(Json.Number(bc.Result, "blocks") ?? 0);
                r.Headers = (long)(Json.Number(bc.Result, "headers") ?? 0);
                r.Progress = Json.Number(bc.Result, "verificationprogress") ?? 1.0;
                r.Difficulty = Json.Number(bc.Result, "difficulty") ?? 0;
                bool? ibd = Json.Bool(bc.Result, "initialblockdownload");
                r.InitialBlockDownload = ibd.HasValue && ibd.Value;
                // The tip's OWN timestamp, not mediantime, which lags five
                // blocks - well over an hour at this chain's spacing - and would
                // make the forwarding tip-age check meaningless.
                r.TipTimeSec = (long)(Json.Number(bc.Result, "time") ?? 0);
                // Two blocks of slack: a node one block behind the headers it
                // has seen is not "syncing", it is simply between blocks.
                r.Syncing = r.InitialBlockDownload || r.Headers - r.Height > 2;
            }
            else
            {
                string chain = Cli("getblockcount");
                if (chain != null) long.TryParse(chain.Trim(), out r.Height);
                r.Headers = r.Height;
            }

            var pc = _rpc.Call("getconnectioncount", "[]");
            if (pc.Ok && pc.Result is double) r.Peers = (int)(double)pc.Result;

            // Which wallets are open. Forwarding treats "the payout wallet is in
            // this set" as a precondition and, during reconciliation, THROWS
            // when it is not - a wallet that cannot be asked is not evidence
            // that nothing is in flight. A failed listwallets leaves this null,
            // which is unknown, not empty.
            var lw = _rpc.Call("listwallets", "[]");
            if (lw.Ok)
            {
                var names = Json.Arr(lw.Result);
                if (names != null)
                {
                    var set = new HashSet<string>(StringComparer.Ordinal);
                    foreach (var n in names) { var s = n as string; if (s != null) set.Add(s); }
                    r.LoadedWallets = set;
                }
            }

            // The version never changes under a running node, so read it rarely.
            if (--_versionTick <= 0 || string.IsNullOrEmpty(_nodeVersion))
            {
                _versionTick = 200;
                var ni = _rpc.Call("getnetworkinfo", "[]");
                if (ni.Ok && ni.Result != null)
                {
                    string sub = Json.Str(ni.Result, "subversion");
                    if (!string.IsNullOrEmpty(sub)) r.Version = sub.Trim('/').Replace(":", " ");
                }
            }
            return r;
        }

        /** Fold a reading into the display. UI thread only. */
        void ApplyReading(Reading r)
        {
            if (r == null || !r.NodeUp)
            {
                _nodeUp = false;
                _hashing = false;
                _history.Add(0.0);
                _problem = (r == null || string.IsNullOrEmpty(r.Problem))
                    ? "The PCoin node is not answering."
                    : r.Problem;
                _icon.Icon = _iconIdle;
                _icon.Text = Truncate("PCoin Miner - " + _problem);
                _miStatus.Text = _problem;
                _miChain.Text = "";
                _miEarned.Text = "";
                // Nothing that follows a lost node may be trusted until it has
                // been re-checked, so reconciliation has to run again before any
                // build is permitted.
                try { _forward.OnNodeLost(); } catch { }
                UpdateForwardMenu();
                PushToWindow(false);
                ReviveNode();
                return;
            }
            _nodeUp = true;
            _nodeEverUp = true;
            _problem = null;
            bool mining = r.Hashing;
            _hashing = r.Hashing && r.Threads > 0;
            _threads = r.Threads;
            _hashrate = r.Hashrate;
            _blocksFound = r.BlocksFound;
            _poolMining = r.PoolMining;
            _sharesAccepted = r.SharesAccepted;
            _sharesRejected = r.SharesRejected;
            _poolStatus = r.PoolStatus ?? "";
            if (r.Cores > 0) _cores = r.Cores;
            // Chain fields are only present on a full poll; on a rate-only tick
            // the previous values stand rather than being zeroed.
            if (r.Full)
            {
                _haveChainInfo = true;
                if (r.Height > 0) _height = r.Height;
                _headers = r.Headers;
                _progress = r.Progress;
                _syncing = r.Syncing;
                _difficulty = r.Difficulty;
                _peers = r.Peers;
                if (!string.IsNullOrEmpty(r.Version)) _nodeVersion = r.Version;
            }

            // Record the rate whether or not the window is open, so opening it
            // shows the hour that just passed instead of an empty graph.
            _history.Add(_hashing ? _hashrate : 0.0);

            // NOTE: _mining is the user's saved INTENT and must not be
            // overwritten from the node's observed state. An earlier version
            // assigned it here, so restarting the node — an upgrade, a crash —
            // left the app reading "not mining" while the node was still
            // starting, then persisted that to the config. Mining silently
            // stayed off afterwards; this was observed on all three machines
            // after a binary upgrade. The observed value drives the display
            // only; intent changes solely through SetMode().
            if (_calibrating)
            {
                // Calibration owns the miner: it restarts workers between
                // candidates, and in those brief gaps `mining` reads false. The
                // recovery branch below must NOT fire here or it would start
                // mining at the saved percent and fight the benchmark.
                _icon.Icon = _iconMining;
                _miStatus.Text = _calibStatus ?? "Auto-tuning threads...";
                _icon.Text = Truncate("PCoin Miner - auto-tuning");
            }
            else if (mining && _threads > 0)
            {
                _icon.Icon = _iconMining;
                // A pool problem while the node is still hashing is the quiet
                // failure worth surfacing: the miner is busy, and none of it is
                // reaching anyone. Say so here rather than only in a log.
                string poolNote = _poolMining && _poolStatus.Length > 0 ? " - " + _poolStatus : "";
                _miStatus.Text = string.Format(CultureInfo.InvariantCulture,
                    "{0} at {1}% - {2} of {3} cores - {4:0.0} H/s{5}",
                    _poolMining ? "Pool mining" : "Mining",
                    _percent, _threads, _cores, _hashrate, poolNote);
                _icon.Text = Truncate(string.Format(CultureInfo.InvariantCulture,
                    "PCoin {0} - {1}%, {2:0.0} H/s",
                    _poolMining ? "Pool Miner" : "Miner", _percent, _hashrate));
            }
            else if (_mining)
            {
                // Intent is on but the node is not hashing: it is still coming
                // up, or the miner was stopped underneath us. Say so, and get
                // it going again rather than quietly giving up.
                _icon.Icon = _iconIdle;
                _miStatus.Text = "Starting miner...";
                _icon.Text = "PCoin Miner - starting";
                if (_nodeUp && !string.IsNullOrEmpty(_address))
                {
                    int want = ThreadsFor(_percent);
                    var t = new Thread(() => StartMining(want)) { IsBackground = true };
                    t.Start();
                }
            }
            else
            {
                _icon.Icon = _iconIdle;
                _miStatus.Text = "Not mining";
                _icon.Text = "PCoin Miner - not mining";
            }
            _miChain.Text = "Blockchain height: " + _height.ToString(CultureInfo.InvariantCulture);
            // A POOL MINER FINDS NO BLOCKS, BY DESIGN -- the pool submits them.
            // `blocksfound` therefore stays 0 forever here, and showing that
            // line unchanged would tell someone earning steadily that they have
            // earned nothing. Show the thing that is actually accumulating.
            if (_poolMining)
            {
                _miEarned.Text = "Shares accepted by the pool: "
                    + _sharesAccepted.ToString(CultureInfo.InvariantCulture)
                    + (_sharesRejected > 0
                        ? " (" + _sharesRejected.ToString(CultureInfo.InvariantCulture) + " rejected)"
                        : "");
            }
            else
            {
                _miEarned.Text = "Blocks mined by this PC: " + _blocksFound.ToString(CultureInfo.InvariantCulture);
            }
            _miPhrase.Text = _phrase == null ? "Set up a recovery phrase..." : "Recovery phrase...";
            UpdateBalances();

            // The forwarding tick, on a FULL poll only - the rate-only ticks
            // carry no chain fields at all, and a decision made on a zeroed
            // height is a decision made on a number nobody read.
            //
            // This only DECIDES whether to evaluate. The work itself runs on the
            // engine's own background thread: sendall alone can take a minute
            // and this is the UI thread that drives the whole app.
            if (r.Full)
            {
                if (r.LoadedWallets != null) _loadedWallets = r.LoadedWallets;
                try { _forward.OnTick(ForwardStatsFrom(r), _loadedWallets, true); }
                catch { /* forwarding failing must never stop this PC mining */ }
            }
            UpdateForwardMenu();

            MarkMode();
            PushToWindow(true);
        }

        /**
         * Bring a dead node back.
         *
         * Until now the app started bitcoind once, at launch, and if it ever
         * died the tray simply said "node not running" forever and the machine
         * quietly stopped contributing. That is what happened when the node
         * crashed: the PC sat idle with an error in a tooltip nobody was
         * looking at.
         *
         * Rate-limited to one attempt every thirty seconds. If the node is
         * crashing on startup, retrying in a tight loop would bury the reason
         * under thousands of log lines and hammer the disk.
         */
        void ReviveNode()
        {
            if (_reviveBusy) return;
            if (--_reviveCooldown > 0) return;
            _reviveCooldown = 30;

            // Only start one if there really is no process. A node that is
            // alive but slow to answer must be waited for, never duplicated:
            // two bitcoind instances on one data directory corrupt it.
            try { if (Process.GetProcessesByName("bitcoind").Length > 0) return; }
            catch { return; }

            _reviveBusy = true;
            var t = new Thread(() =>
            {
                try
                {
                    EnsureNode();
                    EnsureWalletLoaded();
                    ForwardNodeReady();
                    if (_nodeUp && _mining && !string.IsNullOrEmpty(_address))
                    {
                        StartMining(ThreadsFor(_percent));
                    }
                }
                catch { }
                finally { _reviveBusy = false; }
            })
            { IsBackground = true };
            t.Start();
        }

        // ---------- main window ----------

        [StructLayout(LayoutKind.Sequential)]
        struct MEMORYSTATUSEX
        {
            public uint dwLength, dwMemoryLoad;
            public ulong ullTotalPhys, ullAvailPhys, ullTotalPageFile, ullAvailPageFile,
                         ullTotalVirtual, ullAvailVirtual, ullAvailExtendedVirtual;
        }
        [DllImport("kernel32.dll", SetLastError = true)]
        [return: MarshalAs(UnmanagedType.Bool)]
        static extern bool GlobalMemoryStatusEx(ref MEMORYSTATUSEX s);

        /**
         * Physical memory available right now, in MiB, or -1 if it cannot be read.
         *
         * Available, not total: a 32 GB machine with 30 GB in use cannot host a
         * 2 GB dataset either, and quoting total would tell the owner they are
         * eligible right up until the allocation fails.
         *
         * -1 means unknown, and unknown is NOT treated as eligible.
         */
        static long AvailableMib()
        {
            try
            {
                var m = new MEMORYSTATUSEX();
                m.dwLength = (uint)Marshal.SizeOf(typeof(MEMORYSTATUSEX));
                if (!GlobalMemoryStatusEx(ref m)) return -1;
                return (long)(m.ullAvailPhys / (1024UL * 1024UL));
            }
            catch { return -1; }
        }

        /**
         * Turn fast mode on or off for this PC.
         *
         * The dataset is built by the NODE at startup, so the flag only takes
         * effect on a node restart. Saying so is the whole job here: a switch
         * that appears to do nothing for ten minutes is worse than one that
         * explains it will take a moment.
         */
        void SetFastMode(bool on)
        {
            if (_fastMode == on) return;
            _fastMode = on;
            SaveConfig();
            Balloon("PCoin",
                on ? "Fast mode on. Restarting the node to build the table - mining resumes in a moment."
                   : "Fast mode off. Restarting the node.",
                false);
            var t = new Thread(() =>
            {
                try
                {
                    // Hold off the watchdog for the whole restart. This is the
                    // one moment the node is MEANT to be down, and ReviveNode()
                    // cannot tell a deliberate stop from a crash: it would see
                    // no bitcoind, call EnsureNode() from its own thread, and
                    // race this one into starting a SECOND bitcoind on a single
                    // data directory -- the corruption EnsureNode's own comment
                    // warns about. Reusing _reviveBusy keeps that to one flag
                    // rather than inventing a second thing to keep in step.
                    _reviveBusy = true;

                    // Stop mining first so no worker is mid-batch, then ask the
                    // node to stop. `stop` is a clean shutdown -- killing the
                    // process instead risks the unclean-shutdown rescan that
                    // EnsureNode already has to wait minutes for.
                    Cli("stopmining");
                    Cli("stop");
                    for (int i = 0; i < 120; i++)
                    {
                        if (Process.GetProcessesByName("bitcoind").Length == 0) break;
                        Thread.Sleep(1000);
                    }
                    _nodeUp = false;
                    // EnsureNode reads NodeArgs() afresh, so the new flag is
                    // picked up here without any other plumbing.
                    EnsureNode();

                    // If the node refused to come back, put the setting back and
                    // start it again without the flag.
                    //
                    // Core rejects an UNKNOWN -argument at startup and exits, so
                    // a tray that is newer than its bundled node -- or a user who
                    // copied a new PCoinTray.exe over an old install -- would
                    // otherwise turn a checkbox into a permanently dead node,
                    // with the cause invisible. Reverting costs one more restart
                    // and cannot leave the machine worse than it started.
                    if (!_nodeUp && on)
                    {
                        Program.Note("fast mode: node did not start, reverting");
                        _fastMode = false;
                        SaveConfig();
                        EnsureNode();
                        Balloon("PCoin",
                                "This node does not support fast mode yet, so it has been "
                                + "turned back off. Mining continues normally.", true);
                    }

                    if (_nodeUp && _mining) SetMode(_percent);
                }
                catch (Exception ex) { Program.Note("fast-mode restart: " + ex.Message); }
                // Must be a finally: leaving this set on the way out through an
                // exception would disable the node watchdog for the rest of the
                // session, turning a one-off restart failure into a machine that
                // never recovers a node again.
                finally { _reviveBusy = false; }
            }) { IsBackground = true, Name = "pcoin-fastmode" };
            t.Start();
        }

        void ShowWindow()
        {
            try
            {
                if (_window == null)
                {
                    _window = new MinerWindow(
                        _history,
                        pct => SetMode(pct),
                        () => OnRecoveryPhrase(),
                        () => { try { Process.Start("explorer.exe", _dir); } catch { } },
                        () => OpenForwardSettings(),
                        () => OnAckProbe(),
                        on => SetFastMode(on));
                }
                _window.Reveal();
                PushToWindow(_nodeUp);
            }
            catch (Exception ex)
            {
                // Never let a UI problem take the miner down with it: the tray
                // icon and the node have to keep working regardless.
                _window = null;
                MessageBox.Show("The PCoin Miner window could not be opened.\r\n\r\n" + ex.Message,
                                "PCoin", MessageBoxButtons.OK, MessageBoxIcon.Warning);
            }
        }

        void PushToWindow(bool nodeUp)
        {
            if (_window == null || !_window.IsVisible) return;
            try
            {
                var s = new MinerSnapshot
                {
                    NodeUp = nodeUp,
                    Hashing = nodeUp && _hashing,
                    WantMining = _mining,
                    Percent = _percent,
                    Threads = _threads,
                    Cores = _cores,
                    Peers = _peers,
                    Hashrate = _hashrate,
                    Height = _height,
                    Headers = _headers,
                    BlocksFound = _blocksFound,
                    Progress = _progress,
                    Syncing = _syncing,
                    Difficulty = _difficulty,
                    Address = _address,
                    HasPhrase = _phrase != null,
                    PhraseBalance = _balPhraseText,
                    OldBalance = _balOldText,
                    NodeVersion = _nodeVersion,
                    FastMode = _fastMode,
                    AvailableMib = AvailableMib(),
                    Problem = _problem,
                    Forward = ForwardForDisplay(nodeUp)
                };
                if (--_procTick <= 0 || _nodePid == 0)
                {
                    _procTick = 15;
                    MinerWindow.FillProcessInfo(s);
                    _nodePid = s.NodePid;
                    _nodeMemMb = s.NodeMemoryMb;
                    _nodeUptime = s.NodeUptime;
                }
                else
                {
                    s.NodePid = _nodePid;
                    s.NodeMemoryMb = _nodeMemMb;
                    s.NodeUptime = _nodeUptime;
                }
                _window.Apply(s);
            }
            catch { }
        }

        /**
         * Show what each wallet holds, itemised.
         *
         * The two balances are never added into one number: "backed up by your
         * phrase" and "in the old wallet with no phrase" are different kinds of
         * money to the person who owns them. A balance that cannot be read says
         * so rather than showing zero - somebody looking at their own coins must
         * never be shown a zero that means "I do not know".
         */
        void UpdateBalances()
        {
            if (!_nodeUp || _balanceBusy) return;
            if (--_balanceTick > 0) return;
            _balanceTick = 5;                        // roughly every 15 seconds
            _balanceBusy = true;

            var t = new Thread(() =>
            {
                string hd = null, old = null;
                try
                {
                    double trusted, immature;
                    if (_phrase != null && !string.IsNullOrEmpty(_phrase.Wallet))
                    {
                        hd = _seed.Balances(_phrase.Wallet, out trusted, out immature)
                            ? "Backed up by your phrase: " + Coins(trusted) + Maturing(immature)
                            : "Backed up by your phrase: (cannot read)";
                    }
                    if (_seed.Balances(WALLET_MAIN, out trusted, out immature))
                    {
                        old = (_phrase == null ? "Balance: " : "Old wallet, no phrase: ")
                            + Coins(trusted) + Maturing(immature);
                    }
                }
                catch { }

                try
                {
                    _sync.BeginInvoke(new Action(() =>
                    {
                        _miBackedUp.Visible = hd != null;
                        if (hd != null) { _miBackedUp.Text = hd; _balPhraseText = hd; }
                        _miOldWallet.Visible = old != null;
                        if (old != null) { _miOldWallet.Text = old; _balOldText = old; }
                        _balanceBusy = false;
                        PushToWindow(_nodeUp);
                    }));
                }
                catch { _balanceBusy = false; }
            })
            { IsBackground = true };
            t.Start();
        }

        static string Coins(double v)
        {
            return v.ToString("#,##0.########", CultureInfo.InvariantCulture) + " PCN";
        }

        //! Coinbase output cannot be spent for 100 blocks, so newly mined coins
        //! are reported separately rather than folded into a spendable total.
        static string Maturing(double immature)
        {
            return immature > 0 ? "  (+" + Coins(immature) + " still maturing)" : "";
        }

        void ShowStatusBalloon()
        {
            _icon.BalloonTipTitle = "PCoin Miner";
            _icon.BalloonTipText = _nodeUp
                ? _miStatus.Text + "\n" + _miChain.Text + "\n" + _miEarned.Text
                : "The PCoin node is not running.";
            _icon.ShowBalloonTip(5000);
        }

        void ShowAbout()
        {
            MessageBox.Show(
                "This PC is running a PCoin node and can mine PCoin (PCN).\n\n" +
                "Mining uses spare CPU time to help secure the PCoin blockchain. " +
                "You control it: right-click the tray icon to change how many cores " +
                "it uses, or choose \"Not mining\" to stop entirely.\n\n" +
                "Payout address:\n" + (_address == "" ? "(none yet)" : _address) + "\n\n" +
                (_phrase == null
                    ? "This wallet has NO recovery phrase. If Windows is reinstalled, the coins are gone. " +
                      "Use \"Set up a recovery phrase...\" in the tray menu.\n\n"
                    : "This wallet is backed up by a 12-word recovery phrase. Keep the paper safe.\n\n") +
                "Website: https://pc.am",
                "About PCoin Miner", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        void Quit()
        {
            // Tell forwarding we are going. It never starts a new build after
            // this; a transaction already committed to disk is picked up and
            // resolved by the next start, which is the whole point of writing
            // the record before the broadcast.
            try { _forward.Shutdown(); } catch { }
            try { Cli("stopmining"); } catch { }
            // Only shut the node down if this app was the one that started it.
            // A node that was already running belongs to someone else.
            if (_startedNode)
            {
                try
                {
                    Cli("stop");
                    if (_node != null) _node.WaitForExit(20000);
                }
                catch { }
            }
            _timer.Stop();
            _icon.Visible = false;
            _icon.Dispose();
            Application.Exit();
        }

        // ---------- helpers ----------

        //! Run bitcoin-cli and return stdout, or null if the call failed.
        string Cli(string args)
        {
            try
            {
                // CommonArgs(), never NodeArgs(): see the comment on both.
                string full = CommonArgs();
                full = (full.Length == 0 ? "" : full + " ") + args;
                var psi = new ProcessStartInfo(Path.Combine(_dir, "bitcoin-cli.exe"), full)
                {
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    WorkingDirectory = _dir
                };
                using (var p = Process.Start(psi))
                {
                    string outp = p.StandardOutput.ReadToEnd();
                    p.StandardError.ReadToEnd();
                    if (!p.WaitForExit(20000)) { try { p.Kill(); } catch { } return null; }
                    return p.ExitCode == 0 ? outp : null;
                }
            }
            catch { return null; }
        }

        //! Pull a numeric JSON field out without needing a JSON library.
        static double Num(string json, string key)
        {
            var m = Regex.Match(json, "\"" + key + "\"\\s*:\\s*(true|false|-?[0-9.eE+]+)");
            if (!m.Success) return 0;
            string v = m.Groups[1].Value;
            if (v == "true") return 1;
            if (v == "false") return 0;
            double d;
            return double.TryParse(v, NumberStyles.Float, CultureInfo.InvariantCulture, out d) ? d : 0;
        }

        static string Truncate(string s)
        {
            // NotifyIcon.Text throws above 63 characters on older frameworks.
            return s.Length <= 62 ? s : s.Substring(0, 62);
        }

        //! Draw the tray icon at runtime so no .ico file has to ship.
        // The PCoin mark: a struck coin, drawn from the same geometry as the
        // Android drawables and the website SVG (scratchpad/make_icons.ps1 is
        // the source those are generated from). Kept as code rather than an
        // embedded .ico because the tray needs two tinted states and build.bat
        // compiles a bare file list with no resource step.
        //
        // Coordinates are the 108-unit icon canvas of which only the middle 72
        // is ever shown, mapped onto whatever pixel size the shell asks for.
        static Icon MakeIcon(Color disc, Color glyph)
        {
            const int Px = 32;
            using (var bmp = new Bitmap(Px, Px))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.PixelOffsetMode = System.Drawing.Drawing2D.PixelOffsetMode.HighQuality;

                // 108-canvas -> pixels, showing the central 72 window.
                float s = Px / 72f;
                g.ScaleTransform(s, s);
                g.TranslateTransform(-18f, -18f);

                using (var field = new SolidBrush(disc))
                using (var mark = new SolidBrush(glyph))
                {
                    g.FillEllipse(field, 18f, 18f, 72f, 72f);

                    // milled edge: 16 teeth, each half of its 22.5 degree step
                    const float ringIn = 27.5f - 6.5f / 2f;
                    const float ringOut = 27.5f + 6.5f / 2f;
                    for (int i = 0; i < 16; i++)
                    {
                        float a0 = -90f + i * (360f / 16f);
                        using (var p = new System.Drawing.Drawing2D.GraphicsPath())
                        {
                            p.AddArc(54f - ringOut, 54f - ringOut, ringOut * 2, ringOut * 2, a0, 11.25f);
                            p.AddArc(54f - ringIn, 54f - ringIn, ringIn * 2, ringIn * 2, a0 + 11.25f, -11.25f);
                            p.CloseFigure();
                            g.FillPath(mark, p);
                        }
                    }

                    g.FillEllipse(mark, 54f - 21f, 54f - 21f, 42f, 42f);

                    // four-point star, struck back out of the face in the field
                    // colour -- at 16px a cut star still reads, a thin one does not
                    var star = new PointF[8];
                    for (int i = 0; i < 8; i++)
                    {
                        double r = (i % 2 == 0) ? 15.5 : 5.5;
                        double a = (-90 + i * 45) * Math.PI / 180.0;
                        star[i] = new PointF((float)(54 + r * Math.Cos(a)), (float)(54 + r * Math.Sin(a)));
                    }
                    g.FillPolygon(field, star);
                }

                IntPtr h = bmp.GetHicon();
                try { return (Icon)Icon.FromHandle(h).Clone(); }
                finally { DestroyIcon(h); }
            }
        }

        // GetHicon allocates an icon handle the GC never frees. One leak per
        // call is harmless, but this runs on every theme change on some shells.
        [System.Runtime.InteropServices.DllImport("user32.dll", SetLastError = true)]
        static extern bool DestroyIcon(IntPtr hIcon);
    }
}
