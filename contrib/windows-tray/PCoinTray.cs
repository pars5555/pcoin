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
using System.IO;
using System.Text.RegularExpressions;
using System.Threading;
using System.Windows.Forms;

namespace PCoinTray
{
    static class Program
    {
        [STAThread]
        static void Main()
        {
            // One instance only: a second tray icon would be confusing and the
            // two would fight over the mining mode.
            bool created;
            using (var mutex = new Mutex(true, "PCoinTraySingleInstance", out created))
            {
                if (!created)
                {
                    MessageBox.Show("The PCoin miner tray app is already running.\n" +
                                    "Look for the PCoin icon in the notification area.",
                                    "PCoin Miner", MessageBoxButtons.OK, MessageBoxIcon.Information);
                    return;
                }
                Application.EnableVisualStyles();
                Application.SetCompatibleTextRenderingDefault(false);
                Application.Run(new TrayApp());
            }
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

        string _address = "";
        string _datadir = "";          // empty = bitcoind's default location
        int _threads;                  // 0 = not mining
        bool _nodeUp;
        Process _node;                 // set only if we launched it ourselves
        bool _startedNode;
        double _hashrate;
        long _blocksFound;
        long _height;
        int _cores = Environment.ProcessorCount;

        readonly ToolStripMenuItem _miStatus = new ToolStripMenuItem("Starting...") { Enabled = false };
        readonly ToolStripMenuItem _miChain = new ToolStripMenuItem("") { Enabled = false };
        readonly ToolStripMenuItem _miEarned = new ToolStripMenuItem("") { Enabled = false };
        ToolStripMenuItem _miOff, _mi2, _mi4, _miAll;

        public TrayApp()
        {
            _dir = Path.GetDirectoryName(Application.ExecutablePath);
            _cfgPath = Path.Combine(_dir, "pcoin-tray.cfg");
            _iconMining = MakeIcon(Color.FromArgb(139, 92, 246), Color.White);
            _iconIdle = MakeIcon(Color.FromArgb(90, 96, 110), Color.FromArgb(210, 210, 215));

            LoadConfig();
            BuildMenu();

            _icon.Icon = _iconIdle;
            _icon.Text = "PCoin Miner - starting";
            _icon.Visible = true;
            _icon.DoubleClick += (s, e) => ShowStatusBalloon();

            // Bring the node up (and resume the saved mining mode) off the UI
            // thread: bitcoind can take a few seconds to become responsive.
            var t = new Thread(Startup) { IsBackground = true };
            t.Start();

            _timer.Interval = 3000;
            _timer.Tick += (s, e) => Refresh();
            _timer.Start();
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
                    else if (k == "datadir") _datadir = v;
                    else if (k == "threads") int.TryParse(v, out _threads);
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
                    "datadir=" + _datadir + "\r\n" +
                    "threads=" + _threads.ToString(CultureInfo.InvariantCulture) + "\r\n");
            }
            catch { }
        }

        // ---------- menu ----------

        void BuildMenu()
        {
            var menu = new ContextMenuStrip();
            var title = new ToolStripMenuItem("PCoin Miner") { Enabled = false, Font = new Font(SystemFonts.MenuFont, FontStyle.Bold) };
            menu.Items.Add(title);
            menu.Items.Add(_miStatus);
            menu.Items.Add(_miChain);
            menu.Items.Add(_miEarned);
            menu.Items.Add(new ToolStripSeparator());

            _miOff = new ToolStripMenuItem("Not mining", null, (s, e) => SetMode(0));
            _mi2 = new ToolStripMenuItem("Mine with 2 cores", null, (s, e) => SetMode(2));
            _mi4 = new ToolStripMenuItem("Mine with 4 cores", null, (s, e) => SetMode(4));
            _miAll = new ToolStripMenuItem("Mine with all " + _cores + " cores", null, (s, e) => SetMode(_cores));
            menu.Items.Add(_miOff);
            menu.Items.Add(_mi2);
            menu.Items.Add(_mi4);
            menu.Items.Add(_miAll);

            menu.Items.Add(new ToolStripSeparator());
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
            _miOff.Checked = _threads == 0;
            _mi2.Checked = _threads == 2;
            _mi4.Checked = _threads == 4;
            _miAll.Checked = _threads == _cores && _threads != 0 && _threads != 2 && _threads != 4;
        }

        // ---------- node control ----------

        void Startup()
        {
            EnsureNode();
            if (string.IsNullOrEmpty(_address)) _address = EnsureAddress();
            if (_threads > 0) StartMining(_threads);
            SaveConfig();
        }

        void EnsureNode()
        {
            if (Cli("getblockcount") != null) { _nodeUp = true; return; }
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

        //! Extra arguments applied to both bitcoind and bitcoin-cli, so the two
        //! always agree about which datadir and network they are talking about.
        string NodeArgs()
        {
            return string.IsNullOrEmpty(_datadir) ? "" : "-datadir=\"" + _datadir + "\"";
        }

        string EnsureAddress()
        {
            // Reuse an existing wallet if there is one; create it otherwise.
            if (Cli("loadwallet \"main\"") == null && Cli("getwalletinfo") == null)
            {
                Cli("createwallet \"main\"");
            }
            string a = Cli("getnewaddress \"mining\"");
            return a == null ? "" : a.Trim();
        }

        void SetMode(int threads)
        {
            _threads = threads;
            SaveConfig();
            MarkMode();
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

        void StartMining(int threads)
        {
            if (string.IsNullOrEmpty(_address)) return;
            Cli("startmining \"" + _address + "\" " + threads.ToString(CultureInfo.InvariantCulture));
        }

        // ---------- status ----------

        void Refresh()
        {
            string info = Cli("getcpuminerinfo");
            if (info == null)
            {
                _nodeUp = false;
                _icon.Icon = _iconIdle;
                _icon.Text = "PCoin Miner - node not running";
                _miStatus.Text = "Node not running";
                _miChain.Text = "";
                _miEarned.Text = "";
                return;
            }
            _nodeUp = true;
            bool mining = Num(info, "mining") > 0 || info.Contains("\"mining\": true");
            _threads = (int)Num(info, "threads");
            _hashrate = Num(info, "hashespersec");
            _blocksFound = (long)Num(info, "blocksfound");
            int c = (int)Num(info, "cores");
            if (c > 0) _cores = c;

            string chain = Cli("getblockcount");
            if (chain != null) long.TryParse(chain.Trim(), out _height);

            if (mining && _threads > 0)
            {
                _icon.Icon = _iconMining;
                _miStatus.Text = string.Format(CultureInfo.InvariantCulture,
                    "Mining with {0} of {1} cores - {2:0.0} H/s", _threads, _cores, _hashrate);
                _icon.Text = Truncate(string.Format(CultureInfo.InvariantCulture,
                    "PCoin Miner - {0} cores, {1:0.0} H/s", _threads, _hashrate));
            }
            else
            {
                _icon.Icon = _iconIdle;
                _miStatus.Text = "Not mining";
                _icon.Text = "PCoin Miner - not mining";
            }
            _miChain.Text = "Blockchain height: " + _height.ToString(CultureInfo.InvariantCulture);
            _miEarned.Text = "Blocks mined by this PC: " + _blocksFound.ToString(CultureInfo.InvariantCulture);
            MarkMode();
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
                "Website: https://pc.am",
                "About PCoin Miner", MessageBoxButtons.OK, MessageBoxIcon.Information);
        }

        void Quit()
        {
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
                string full = NodeArgs();
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
        static Icon MakeIcon(Color disc, Color glyph)
        {
            using (var bmp = new Bitmap(32, 32))
            using (var g = Graphics.FromImage(bmp))
            {
                g.SmoothingMode = System.Drawing.Drawing2D.SmoothingMode.AntiAlias;
                g.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAlias;
                using (var b = new SolidBrush(disc)) g.FillEllipse(b, 1, 1, 30, 30);
                using (var f = new Font("Segoe UI", 17, FontStyle.Bold, GraphicsUnit.Pixel))
                using (var b = new SolidBrush(glyph))
                {
                    var sf = new StringFormat { Alignment = StringAlignment.Center, LineAlignment = StringAlignment.Center };
                    g.DrawString("P", f, b, new RectangleF(0, 0, 32, 32), sf);
                }
                IntPtr h = bmp.GetHicon();
                return (Icon)Icon.FromHandle(h).Clone();
            }
        }
    }
}
