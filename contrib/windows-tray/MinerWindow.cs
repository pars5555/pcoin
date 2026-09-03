// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The main window: everything this PC is doing, on one screen.
//
// The tray icon alone answers "is it mining?" and nothing else. This window is
// the Windows counterpart of the Android app's home screen -- live hash rate
// with a history graph, what the node is doing, what the wallet holds, and the
// controls to change it. Anyone can open it, see exactly what their machine is
// spending its cycles on, and turn it down or off.
//
// WPF, written in code rather than XAML so the whole app still builds with the
// in-box csc.exe (see build.bat). It runs on the WinForms message loop that
// Application.Run() already pumps: a WPF Window needs an STA thread with a
// message pump, and that is exactly what it has. There is deliberately no
// System.Windows.Application -- creating one would take over shutdown, and
// closing this window must never stop mining.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Shapes;

namespace PCoinTray
{
    /**
     * One hour of hash rate, in fixed time buckets.
     *
     * Samples arrive at whatever rate the app happens to be polling - once a
     * second with the window open, once every three seconds without - and land
     * in the bucket that matches their arrival time, so the graph covers the
     * same hour either way and does not stretch or squash when the rate changes.
     *
     * Bucketing is what keeps this cheap. An hour of one-second samples is 3600
     * points, more than there are pixels to draw them in; 240 buckets of fifteen
     * seconds is roughly one point per pixel, so redrawing every second costs
     * almost nothing. The bucket still being filled is drawn from its running
     * average, which is what makes the right-hand end of the line move every
     * second rather than every fifteen.
     *
     * Owned by the tray app, not the window, so history keeps accumulating
     * while the window is closed.
     */
    class RateHistory
    {
        public const int BUCKETS = 240;
        public const int BUCKET_MS = 15000;      // 240 x 15 s = 1 hour

        static readonly Stopwatch Clock = Stopwatch.StartNew();

        readonly double[] _done = new double[BUCKETS];
        int _count;                              // filled buckets, oldest first
        long _bucketStart = -1;
        double _sum;
        int _n;

        public void Add(double value) { Add(value, Clock.ElapsedMilliseconds); }

        //! Overload taking the time explicitly, so an hour can be replayed in a
        //! test without waiting an hour.
        public void Add(double value, long now)
        {
            if (_bucketStart < 0) _bucketStart = now;

            // A long gap means the PC slept or the app was busy elsewhere.
            // Drawing thousands of invented buckets to bridge it would be a
            // lie; start the hour again instead.
            if (now - _bucketStart > (long)BUCKET_MS * BUCKETS)
            {
                _count = 0;
                _sum = 0;
                _n = 0;
                _bucketStart = now;
            }

            while (now - _bucketStart >= BUCKET_MS)
            {
                Push(_n > 0 ? _sum / _n : 0.0);
                _sum = 0;
                _n = 0;
                _bucketStart += BUCKET_MS;
            }
            _sum += value;
            _n++;
        }

        void Push(double v)
        {
            if (_count < BUCKETS) { _done[_count++] = v; return; }
            Array.Copy(_done, 1, _done, 0, BUCKETS - 1);
            _done[BUCKETS - 1] = v;
        }

        /** Completed buckets plus the one in progress. Never null. */
        public double[] Points(out double peak, out int seconds)
        {
            int extra = _n > 0 ? 1 : 0;
            var pts = new double[_count + extra];
            Array.Copy(_done, pts, _count);
            if (extra == 1) pts[_count] = _sum / _n;
            peak = 0;
            for (int i = 0; i < pts.Length; i++) if (pts[i] > peak) peak = pts[i];
            seconds = pts.Length * BUCKET_MS / 1000;
            return pts;
        }
    }

    /**
     * One reading of everything the window displays.
     *
     * Built on the polling thread and handed to the UI thread whole, so the
     * window never reads a half-updated set of fields and never blocks on RPC.
     */
    class MinerSnapshot
    {
        public bool NodeUp;
        public bool Hashing;            // what the node reports right now
        public bool WantMining;         // the user's saved intent
        public int Percent;
        public int Threads;
        public int Cores;
        public int Peers = -1;          // -1 = not known
        public double Hashrate;
        public long Height;
        public long Headers;
        public long BlocksFound;
        public double Progress = 1.0;   // verificationprogress, 0..1
        public bool Syncing;
        public double Difficulty;
        public double NetworkHashps;    // whole-network H/s, fallback input for the advice
        public double MeasuredHashrate; // what auto-tuning last measured, 0 = never
        public bool PoolMining;         // is the node hashing for a pool right now
        public string PoolUrl = "";     // configured pool, empty = solo
        public long SharesAccepted;     // pool: work units the pool has credited this PC
        public long SharesRejected;
        public int LastShareAgeSec = -1;// seconds since the accepted count last rose; -1 = none yet
        public string Address = "";
        public bool HasPhrase;
        public string PhraseBalance;    // null when there is no phrase wallet
        public string OldBalance;       // null when it cannot be read
        public string NodeVersion = "";
        public bool FastMode;           // the user's saved intent for this PC
        public long AvailableMib = -1;  // -1 = not measured yet
        public string Problem;          // why the node is unreachable, in words
        public int NodePid;
        public double NodeMemoryMb;
        public TimeSpan NodeUptime;

        /**
         * Forwarding.
         *
         * The intent fields - state, address, whether the test payment has
         * confirmed - are properties of the install and survive the node going
         * away, exactly as HasPhrase does. The sweep fields are live readings
         * and go back to unknown instead of sitting on screen next to a dead
         * node as though they were still being updated.
         */
        public ForwardStatus Forward = new ForwardStatus();
    }

    /**
     * The main window. Created once, hidden rather than destroyed on close, so
     * reopening is instant and the hash-rate history survives.
     */
    class MinerWindow : Window
    {
        // PCoin's palette. Dark by default: this window is usually opened to
        // glance at, often on a machine that is otherwise idle.
        static readonly Brush Bg = Frozen("#FF12121A");
        static readonly Brush Card = Frozen("#FF1B1B26");
        static readonly Brush CardEdge = Frozen("#FF2A2A38");
        static readonly Brush Accent = Frozen("#FF8B5CF6");
        static readonly Brush AccentDim = Frozen("#4C8B5CF6");
        static readonly Brush Text = Frozen("#FFEDEDF2");
        static readonly Brush Muted = Frozen("#FF8B8B9E");
        static readonly Brush Good = Frozen("#FF34D399");
        static readonly Brush Warn = Frozen("#FFFBBF24");
        static readonly Brush Bad = Frozen("#FFF87171");

        readonly RateHistory _history;

        readonly TextBlock _state = new TextBlock();
        readonly Ellipse _statePip = new Ellipse
        {
            Width = 10, Height = 10,
            Margin = new Thickness(0, 4, 8, 0),
            VerticalAlignment = VerticalAlignment.Top
        };
        readonly TextBlock _rate = new TextBlock();
        readonly TextBlock _rateUnit = new TextBlock();
        readonly TextBlock _effortLine = new TextBlock();
        readonly TextBlock _poolLine = new TextBlock();   // pool proof: shares + last-share heartbeat
        readonly TextBlock _poolNote = new TextBlock();   // where pool rewards actually go
        readonly Polyline _spark = new Polyline();
        readonly Polygon _sparkFill = new Polygon();
        readonly Canvas _sparkCanvas = new Canvas { ClipToBounds = true, Height = 60 };
        readonly TextBlock _sparkNote = new TextBlock();

        readonly TextBlock _height = new TextBlock();
        readonly TextBlock _peers = new TextBlock();
        readonly TextBlock _found = new TextBlock();
        readonly TextBlock _foundCaption = new TextBlock();  // "Blocks mined" (solo) / "Shares" (pool)
        readonly TextBlock _diff = new TextBlock();

        readonly Slider _slider = new Slider();
        readonly StackPanel _fastPanel = new StackPanel();
        readonly CheckBox   _fastCheck = new CheckBox();
        readonly TextBlock  _fastNote  = new TextBlock();
        //! Guards the same way _sliderEcho does: when the app pushes state INTO
        //! the checkbox, its Checked/Unchecked handlers must not fire back out
        //! and be mistaken for the user clicking it.
        bool _fastEcho;
        readonly Action<bool> _setFastMode;
        readonly TextBlock _sliderLabel = new TextBlock();
        readonly Button _toggle = new Button();

        // ---- mining mode (solo vs pool) ----
        readonly RadioButton _rbSolo = new RadioButton();
        readonly RadioButton _rbPool = new RadioButton();
        readonly TextBox _poolBox = new TextBox();
        readonly TextBlock _modeAdvice = new TextBlock();
        readonly Button _applyMode = new Button();
        // Guards like _sliderEcho: true while the app pushes the current mode
        // INTO the radios, so their Checked handlers do not fire back as a click.
        bool _modeEcho;
        string _lastShownPool;   // null so the first render echoes the mode in
        const string DEFAULT_POOL = "pool.pc.am:3333";

        readonly TextBlock _syncLine = new TextBlock();
        readonly ProgressBar _syncBar = new ProgressBar();
        readonly Border _syncCard = new Border();

        readonly TextBlock _balPhrase = new TextBlock();
        readonly TextBlock _balOld = new TextBlock();
        readonly TextBlock _phraseWarn = new TextBlock();
        readonly TextBox _addr = new TextBox();
        readonly Button _phraseBtn = new Button();

        readonly TextBlock _proc = new TextBlock();

        readonly TextBlock _fwdState = new TextBlock();
        readonly TextBlock _fwdDestLabel = new TextBlock();
        readonly TextBox _fwdDest = new TextBox();
        readonly TextBlock _fwdBlocked = new TextBlock();
        readonly TextBlock _fwdError = new TextBlock();
        readonly TextBlock _fwdLast = new TextBlock();
        readonly Button _fwdManage = new Button();
        readonly Button _fwdCopyTxid = new Button();

        readonly Action<int> _setPercent;   // 0 = stop
        readonly Action<string> _setPool;   // "" = solo, else pool host:port
        readonly Action _openPhrase;
        readonly Action _openFolder;
        readonly Action _openForward;
        readonly Action _ackProbe;

        //! True while code (not the user) is moving the slider, so the
        //! ValueChanged handler can tell a refresh apart from a real choice.
        bool _sliderEcho;
        int _pendingPercent = -1;
        // While STOPPED the rail is a pick-your-cores control the Start button
        // reads, so once it has been primed we must not shove it back to a
        // default -- that is what reset a user's pick to 12 (the 50% default).
        bool _sliderPrimed;
        MinerSnapshot _last = new MinerSnapshot();

        public MinerWindow(RateHistory history, Action<int> setPercent, Action openPhrase, Action openFolder,
                           Action openForward, Action ackProbe,
                           Action<bool> setFastMode, Action<string> setPool)
        {
            _setFastMode = setFastMode;
            _history = history;
            _setPercent = setPercent;
            _setPool = setPool;
            _openPhrase = openPhrase;
            _openFolder = openFolder;
            _openForward = openForward;
            _ackProbe = ackProbe;

            Title = "PCoin Miner";
            // Arrow keys must reach the slider, not move focus.
            //
            // WPF's KeyboardNavigation claims Left/Right/Up/Down inside
            // InputManager.PreProcessInput, which runs BEFORE any routed event
            // -- so a PreviewKeyDown handler, even on the Window at the very top
            // of the tunnel, never sees them. Measured: Home and End reached the
            // handler and arrows did not, on the same keypress path. Turning
            // directional navigation off on this window lets them through. Tab
            // still moves focus normally; nothing on this page relies on arrows
            // for navigation.
            KeyboardNavigation.SetDirectionalNavigation(this, KeyboardNavigationMode.None);
            Width = 470;
            MinWidth = 420;
            Height = 760;
            MinHeight = 460;
            Background = Bg;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            UseLayoutRounding = true;
            SourceInitialized += (s, e) => DarkenTitleBar();

            // Closing hides. The tray icon is the app's real lifetime; a window
            // close must never be mistaken for "stop mining".
            Closing += (s, e) => { e.Cancel = true; Hide(); };

            Content = BuildBody();
            Apply(_last);
        }

        // ---------- layout ----------

        UIElement BuildBody()
        {
            var scroll = new ScrollViewer
            {
                VerticalScrollBarVisibility = ScrollBarVisibility.Auto,
                HorizontalScrollBarVisibility = ScrollBarVisibility.Disabled,
                Background = Bg,
                Padding = new Thickness(14, 12, 14, 14)
            };
            var col = new StackPanel();
            col.Children.Add(Header());
            col.Children.Add(RateCard());
            col.Children.Add(StatsRow());
            col.Children.Add(SyncCard());
            col.Children.Add(ControlCard());
            col.Children.Add(MiningModeCard());
            col.Children.Add(WalletCard());
            col.Children.Add(ForwardCard());
            col.Children.Add(ProcessFooter());
            scroll.Content = col;
            return scroll;
        }

        UIElement Header()
        {
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 10) };

            var name = new TextBlock
            {
                Text = "PCoin Miner",
                Foreground = Text,
                FontSize = 17,
                FontWeight = FontWeights.SemiBold,
                VerticalAlignment = VerticalAlignment.Center
            };
            DockPanel.SetDock(name, Dock.Left);
            row.Children.Add(name);

            var machine = new TextBlock
            {
                Text = Environment.MachineName,
                Foreground = Muted,
                FontSize = 12,
                VerticalAlignment = VerticalAlignment.Center,
                HorizontalAlignment = HorizontalAlignment.Right,
                TextTrimming = TextTrimming.CharacterEllipsis
            };
            row.Children.Add(machine);
            return row;
        }

        UIElement RateCard()
        {
            var stack = new StackPanel();

            var status = new DockPanel { Margin = new Thickness(0, 0, 0, 6), LastChildFill = true };
            DockPanel.SetDock(_statePip, Dock.Left);
            status.Children.Add(_statePip);
            _state.Foreground = Text;
            _state.FontSize = 13;
            _state.FontWeight = FontWeights.SemiBold;
            _state.VerticalAlignment = VerticalAlignment.Center;
            _state.TextWrapping = TextWrapping.Wrap;
            status.Children.Add(_state);
            stack.Children.Add(status);

            var rateRow = new StackPanel { Orientation = Orientation.Horizontal };
            _rate.Foreground = Text;
            _rate.FontSize = 38;
            _rate.FontWeight = FontWeights.Light;
            _rate.Text = "--";
            rateRow.Children.Add(_rate);
            _rateUnit.Foreground = Muted;
            _rateUnit.FontSize = 15;
            _rateUnit.Margin = new Thickness(7, 0, 0, 8);
            _rateUnit.VerticalAlignment = VerticalAlignment.Bottom;
            _rateUnit.Text = "H/s";
            rateRow.Children.Add(_rateUnit);
            stack.Children.Add(rateRow);

            _effortLine.Foreground = Muted;
            _effortLine.FontSize = 12;
            _effortLine.Margin = new Thickness(0, 1, 0, 8);
            stack.Children.Add(_effortLine);

            // Pool proof, right under the number the user stares at. Only shown
            // while pool mining; solo leaves it collapsed.
            _poolLine.FontSize = 12.5;
            _poolLine.FontWeight = FontWeights.SemiBold;
            _poolLine.Margin = new Thickness(0, 0, 0, 3);
            _poolLine.TextWrapping = TextWrapping.Wrap;
            _poolLine.Visibility = Visibility.Collapsed;
            stack.Children.Add(_poolLine);

            _poolNote.Foreground = Muted;
            _poolNote.FontSize = 11;
            _poolNote.Margin = new Thickness(0, 0, 0, 8);
            _poolNote.TextWrapping = TextWrapping.Wrap;
            _poolNote.Visibility = Visibility.Collapsed;
            stack.Children.Add(_poolNote);

            _sparkFill.Fill = AccentDim;
            _sparkFill.StrokeThickness = 0;
            _spark.Stroke = Accent;
            _spark.StrokeThickness = 1.6;
            _spark.StrokeLineJoin = PenLineJoin.Round;
            _sparkCanvas.Children.Add(_sparkFill);
            _sparkCanvas.Children.Add(_spark);
            _sparkCanvas.SizeChanged += (s, e) => DrawSpark();
            stack.Children.Add(_sparkCanvas);

            _sparkNote.Foreground = Muted;
            _sparkNote.FontSize = 10.5;
            _sparkNote.Margin = new Thickness(0, 4, 0, 0);
            stack.Children.Add(_sparkNote);

            return Panel(stack);
        }

        UIElement StatsRow()
        {
            var grid = new Grid { Margin = new Thickness(0, 0, 0, 10) };
            for (int i = 0; i < 4; i++) grid.ColumnDefinitions.Add(new ColumnDefinition());
            AddStat(grid, 0, "Block height", _height);
            AddStat(grid, 1, "Peers", _peers);
            AddStat(grid, 2, "Blocks mined", _found, _foundCaption);
            AddStat(grid, 3, "Difficulty", _diff);
            return grid;
        }

        void AddStat(Grid grid, int column, string caption, TextBlock value, TextBlock captionBlock = null)
        {
            var stack = new StackPanel();
            value.Foreground = Text;
            value.FontSize = 15;
            value.Text = "--";
            value.TextTrimming = TextTrimming.CharacterEllipsis;
            stack.Children.Add(value);
            var cap = captionBlock ?? new TextBlock();
            cap.Text = caption;
            cap.Foreground = Muted;
            cap.FontSize = 11;
            cap.Margin = new Thickness(0, 2, 0, 0);
            cap.TextTrimming = TextTrimming.CharacterEllipsis;
            stack.Children.Add(cap);
            var cell = Panel(stack);
            cell.Margin = new Thickness(column == 0 ? 0 : 4, 0, column == 3 ? 0 : 4, 0);
            cell.Padding = new Thickness(10, 8, 6, 8);
            Grid.SetColumn(cell, column);
            grid.Children.Add(cell);
        }

        UIElement SyncCard()
        {
            var stack = new StackPanel();
            _syncLine.Foreground = Warn;
            _syncLine.FontSize = 12;
            _syncLine.TextWrapping = TextWrapping.Wrap;
            stack.Children.Add(_syncLine);
            _syncBar.Height = 4;
            _syncBar.Margin = new Thickness(0, 8, 0, 0);
            _syncBar.Minimum = 0;
            _syncBar.Maximum = 1;
            _syncBar.Foreground = Accent;
            _syncBar.Background = CardEdge;
            _syncBar.BorderThickness = new Thickness(0);
            stack.Children.Add(_syncBar);

            _syncCard.Child = stack;
            _syncCard.Background = Card;
            _syncCard.BorderBrush = CardEdge;
            _syncCard.BorderThickness = new Thickness(1);
            _syncCard.CornerRadius = new CornerRadius(10);
            _syncCard.Padding = new Thickness(12, 10, 12, 10);
            _syncCard.Margin = new Thickness(0, 0, 0, 10);
            _syncCard.Visibility = Visibility.Collapsed;
            return _syncCard;
        }

        UIElement ControlCard()
        {
            var stack = new StackPanel();
            stack.Children.Add(Caption("How hard this PC works"));

            _sliderLabel.Foreground = Text;
            _sliderLabel.FontSize = 13;
            _sliderLabel.Margin = new Thickness(0, 0, 0, 6);
            stack.Children.Add(_sliderLabel);

            _slider.Minimum = 10;
            _slider.Maximum = 100;
            // ONE STEP = ONE CORE.
            //
            // This used to move in 5% jumps, which on a 24-core machine is a
            // step of 1.2 cores: two different slider positions could mean the
            // same number of cores, and no position meant "ten". Percent is a
            // unit the user has to translate; cores is the unit they actually
            // choose. Minimum/Maximum are re-fitted to the real core count in
            // ApplySnapshot as soon as the node reports it -- until then this is
            // a placeholder range, not a promise.
            _slider.Minimum = 1;
            _slider.Maximum = 24;
            _slider.TickFrequency = 1;
            _slider.IsSnapToTickEnabled = true;
            _slider.SmallChange = 1;
            _slider.LargeChange = 1;
            _slider.Foreground = Accent;
            _slider.Value = 4;
            // Click anywhere on the rail to set the value there. Without this,
            // WPF's default is to page by LargeChange via the track's repeat
            // buttons -- and with this custom template those buttons never fired
            // at all, so the only way to change the mining rate was to drag the
            // 16-pixel thumb. Tested on a real desktop: track clicks and arrow
            // keys both did nothing.
            _slider.IsMoveToPointEnabled = true;
            // Arrow keys need the control to be able to take focus, and a click
            // on the rail is the natural way to give it.
            _slider.Focusable = true;
            _slider.PreviewMouseLeftButtonDown += (s, e) => _slider.Focus();
            StyleSlider(_slider);
            // Track the drag live in the label, but only restart the miner when
            // the user lets go. Committing on every ValueChanged would stop and
            // restart hashing dozens of times across one drag.
            _slider.ValueChanged += (s, e) =>
            {
                if (_sliderEcho) return;
                int cores = Math.Max(1, _last.Cores);
                int want = Math.Max(1, Math.Min(cores, (int)Math.Round(_slider.Value)));
                _pendingPercent = Cpu.PercentForThreads(want, cores);
                UpdateSliderLabel(_pendingPercent, true);
            };
            // Handle the arrow keys OURSELVES.
            //
            // WPF's Slider is supposed to do this through class-level key
            // gestures, and a comment above once claimed it worked. It does not.
            // Verified on this machine: with the window in the foreground and
            // UIAutomation reporting HasKeyboardFocus=true on the slider,
            // three synthesized RIGHT presses left the value on 13, while a
            // RangeValuePattern SetValue moved it to 14 immediately -- so the
            // control is healthy and the key simply never arrives. Two separate
            // input paths (SendKeys and the agent's key_combination) agreed.
            //
            // Rather than keep guessing why the built-in gesture does not fire
            // under this custom template, step the value here, where one press
            // is one core by construction.
            // ...and attach it to the WINDOW, not the slider.
            //
            // Attaching to the slider got Home and End working but left the
            // arrow keys dead, which is the tell: PreviewKeyDown tunnels from
            // the root down, and WPF's directional KeyboardNavigation claims
            // Left/Right/Up/Down on the way to move focus between controls. By
            // the time the slider would see them they are gone. Handling them at
            // the top of the tunnel is the only place that sees every key, and
            // the IsKeyboardFocusWithin guard keeps this from hijacking arrows
            // meant for anything else on the page.
            PreviewKeyDown += (s, e) =>
            {
                if (!_slider.IsKeyboardFocusWithin) return;
                double v = _slider.Value;
                switch (e.Key)
                {
                    case Key.Left:  case Key.Down:  v -= 1; break;
                    case Key.Right: case Key.Up:    v += 1; break;
                    case Key.Home: v = _slider.Minimum; break;
                    case Key.End:  v = _slider.Maximum; break;
                    case Key.PageDown: v -= 4; break;
                    case Key.PageUp:   v += 4; break;
                    default: return;
                }
                _slider.Value = Math.Max(_slider.Minimum, Math.Min(_slider.Maximum, v));
                e.Handled = true;   // stop the window scrolling instead
            };
            _slider.PreviewMouseUp += (s, e) => CommitSlider();
            _slider.LostMouseCapture += (s, e) => CommitSlider();
            _slider.KeyUp += (s, e) => CommitSlider();
            stack.Children.Add(_slider);

            _toggle.Margin = new Thickness(0, 10, 0, 0);
            // This is the primary action of the whole window, so it should read
            // as one. 7px of padding and no minimum height rendered it as a thin
            // strip -- narrower than the cards above it and easy to mistake for a
            // label rather than the button you are meant to press.
            _toggle.Padding = new Thickness(0, 12, 0, 12);
            _toggle.MinHeight = 44;
            _toggle.HorizontalAlignment = HorizontalAlignment.Stretch;
            _toggle.FontSize = 14;
            _toggle.FontWeight = FontWeights.SemiBold;
            _toggle.Cursor = Cursors.Hand;
            _toggle.Click += (s, e) =>
            {
                // Read intent from the last snapshot, never from the button's
                // own caption: a stale caption would flip mining the wrong way.
                if (_last.WantMining) _setPercent(0);
                else _setPercent(Snap((int)Math.Round(_slider.Value)));
            };
            StyleButton(_toggle, true);
            stack.Children.Add(_toggle);

            // ---- fast mode -------------------------------------------------
            // RandomX has two modes that produce IDENTICAL hashes and differ
            // only in memory. Light mode keeps a ~256 MiB cache and recomputes
            // dataset items on the fly; fast mode builds the whole ~2 GiB
            // dataset once and then just reads it, which is several times
            // quicker per hash.
            //
            // The node verifies in light mode always and that never changes --
            // a phone with 2 GB has to be able to check every block. This
            // switch affects MINING on this PC only.
            //
            // Shown to everyone rather than hidden behind a command line
            // argument, because a miner running at a fraction of their hardware
            // and never being told is the whole problem. On a machine that
            // cannot take it, the row still appears and explains why -- an
            // option that silently vanishes reads as a bug.
            _fastPanel.Margin = new Thickness(0, 12, 0, 0);

            _fastCheck.Content = "Use fast mode (more memory, several times faster)";
            _fastCheck.Foreground = Text;
            _fastCheck.FontSize = 12;
            _fastCheck.Cursor = Cursors.Hand;
            _fastCheck.Checked   += (s, e) => { if (!_fastEcho) _setFastMode(true); };
            _fastCheck.Unchecked += (s, e) => { if (!_fastEcho) _setFastMode(false); };
            _fastPanel.Children.Add(_fastCheck);

            _fastNote.FontSize = 11;
            _fastNote.Foreground = Muted;
            _fastNote.TextWrapping = TextWrapping.Wrap;
            _fastNote.Margin = new Thickness(0, 4, 0, 0);
            _fastPanel.Children.Add(_fastNote);

            stack.Children.Add(_fastPanel);


            return Panel(stack);
        }

        //! Solo vs pool. SUGGEST-ONLY: the app shows which path is better for this
        //! machine (from its hash rate vs the network) but never switches on its
        //! own -- the user picks and clicks Apply. Render() fills the radios and
        //! the advice line from the snapshot under _modeEcho so those pushes are
        //! not mistaken for clicks.
        UIElement MiningModeCard()
        {
            var stack = new StackPanel();
            stack.Children.Add(Caption("Mining mode"));

            _rbSolo.Content = "Solo — keep the whole block when this PC finds one";
            _rbSolo.Foreground = Text; _rbSolo.FontSize = 12.5;
            _rbSolo.Margin = new Thickness(0, 2, 0, 2); _rbSolo.Cursor = Cursors.Hand;
            _rbPool.Content = "Pool — a steady share of the pool's blocks";
            _rbPool.Foreground = Text; _rbPool.FontSize = 12.5;
            _rbPool.Margin = new Thickness(0, 2, 0, 2); _rbPool.Cursor = Cursors.Hand;
            _rbSolo.Checked += (s, e) => { if (!_modeEcho) _poolBox.IsEnabled = false; };
            _rbPool.Checked += (s, e) =>
            {
                if (_modeEcho) return;
                _poolBox.IsEnabled = true;
                if (string.IsNullOrWhiteSpace(_poolBox.Text)) _poolBox.Text = DEFAULT_POOL;
            };
            stack.Children.Add(_rbSolo);
            stack.Children.Add(_rbPool);

            _poolBox.Margin = new Thickness(20, 2, 0, 6);
            _poolBox.FontSize = 12;
            _poolBox.FontFamily = new FontFamily("Consolas, Courier New");
            _poolBox.Padding = new Thickness(6, 4, 6, 4);
            stack.Children.Add(_poolBox);

            _modeAdvice.Foreground = Muted; _modeAdvice.FontSize = 11.5;
            _modeAdvice.TextWrapping = TextWrapping.Wrap;
            _modeAdvice.Margin = new Thickness(0, 2, 0, 8);
            stack.Children.Add(_modeAdvice);

            _applyMode.Content = "Apply mining mode";
            _applyMode.Padding = new Thickness(12, 8, 12, 8);
            _applyMode.FontSize = 12.5;
            _applyMode.HorizontalAlignment = HorizontalAlignment.Stretch;
            _applyMode.Cursor = Cursors.Hand;
            _applyMode.Click += (s, e) =>
            {
                string url = _rbPool.IsChecked == true ? (_poolBox.Text ?? "").Trim() : "";
                _setPool(url);
            };
            StyleButton(_applyMode, false);
            stack.Children.Add(_applyMode);

            return Panel(stack);
        }

        UIElement WalletCard()
        {
            var stack = new StackPanel();
            stack.Children.Add(Caption("Wallet"));

            _balPhrase.Foreground = Text;
            _balPhrase.FontSize = 13;
            _balPhrase.TextWrapping = TextWrapping.Wrap;
            _balPhrase.Margin = new Thickness(0, 0, 0, 4);
            stack.Children.Add(_balPhrase);

            _balOld.Foreground = Text;
            _balOld.FontSize = 13;
            _balOld.TextWrapping = TextWrapping.Wrap;
            stack.Children.Add(_balOld);

            _phraseWarn.Foreground = Warn;
            _phraseWarn.FontSize = 11.5;
            _phraseWarn.TextWrapping = TextWrapping.Wrap;
            _phraseWarn.Margin = new Thickness(0, 8, 0, 0);
            stack.Children.Add(_phraseWarn);

            stack.Children.Add(new TextBlock
            {
                Text = "Rewards are paid to",
                Foreground = Muted,
                FontSize = 11,
                Margin = new Thickness(0, 10, 0, 3)
            });

            // Read-only TextBox rather than a TextBlock: an address is something
            // people need to select and copy, and a plain label cannot be.
            _addr.IsReadOnly = true;
            _addr.Background = Brushes.Transparent;
            _addr.BorderThickness = new Thickness(0);
            _addr.Foreground = Text;
            _addr.FontFamily = new FontFamily("Consolas, Courier New");
            _addr.FontSize = 12;
            _addr.Padding = new Thickness(0);
            _addr.Text = "(none yet)";
            stack.Children.Add(_addr);

            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
            var copy = new Button { Content = "Copy address", Padding = new Thickness(12, 6, 12, 6), FontSize = 12, Cursor = Cursors.Hand };
            StyleButton(copy, false);
            copy.Click += (s, e) =>
            {
                if (string.IsNullOrEmpty(_last.Address)) return;
                try { Clipboard.SetText(_last.Address); copy.Content = "Copied"; } catch { }
            };
            row.Children.Add(copy);

            _phraseBtn.Content = "Recovery phrase...";
            _phraseBtn.Padding = new Thickness(12, 6, 12, 6);
            _phraseBtn.FontSize = 12;
            _phraseBtn.Margin = new Thickness(8, 0, 0, 0);
            _phraseBtn.Cursor = Cursors.Hand;
            StyleButton(_phraseBtn, false);
            _phraseBtn.Click += (s, e) => _openPhrase();
            row.Children.Add(_phraseBtn);
            stack.Children.Add(row);

            return Panel(stack);
        }

        /**
         * The forwarding card.
         *
         * Two rules run through all of it. A transaction that has merely been
         * broadcast is NEVER worded as sent - with one peer, or with only
         * block-relay-only peers, a successful sendrawtransaction can mean
         * nobody else has seen it. And every amount and address shown for an
         * in-flight transaction comes from the DECODED transaction, never from
         * the setting it was built from: what was actually built is the only
         * honest thing to display.
         */
        UIElement ForwardCard()
        {
            var stack = new StackPanel();
            stack.Children.Add(Caption("Forwarding"));

            _fwdState.Foreground = Text;
            _fwdState.FontSize = 13;
            _fwdState.TextWrapping = TextWrapping.Wrap;
            stack.Children.Add(_fwdState);

            _fwdDestLabel.Text = "FORWARDING TO THIS ADDRESS";
            _fwdDestLabel.Foreground = Muted;
            _fwdDestLabel.FontSize = 10.5;
            _fwdDestLabel.FontWeight = FontWeights.SemiBold;
            _fwdDestLabel.Margin = new Thickness(0, 10, 0, 3);
            stack.Children.Add(_fwdDestLabel);

            // Same treatment the payout address gets: a read-only TextBox, not a
            // label, because this is the string a person has to be able to
            // select, copy and compare against their other wallet.
            _fwdDest.IsReadOnly = true;
            _fwdDest.Background = Brushes.Transparent;
            _fwdDest.BorderThickness = new Thickness(0);
            _fwdDest.Foreground = Text;
            _fwdDest.FontFamily = new FontFamily("Consolas, Courier New");
            _fwdDest.FontSize = 12;
            _fwdDest.Padding = new Thickness(0);
            _fwdDest.TextWrapping = TextWrapping.Wrap;
            stack.Children.Add(_fwdDest);

            _fwdBlocked.Foreground = Muted;
            _fwdBlocked.FontSize = 11.5;
            _fwdBlocked.TextWrapping = TextWrapping.Wrap;
            _fwdBlocked.Margin = new Thickness(0, 8, 0, 0);
            stack.Children.Add(_fwdBlocked);

            _fwdError.Foreground = Warn;
            _fwdError.FontSize = 11.5;
            _fwdError.TextWrapping = TextWrapping.Wrap;
            _fwdError.Margin = new Thickness(0, 8, 0, 0);
            stack.Children.Add(_fwdError);

            _fwdLast.Foreground = Muted;
            _fwdLast.FontSize = 11;
            _fwdLast.TextWrapping = TextWrapping.Wrap;
            _fwdLast.Margin = new Thickness(0, 10, 0, 0);
            stack.Children.Add(_fwdLast);

            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };

            _fwdManage.Content = "Set forwarding address";
            _fwdManage.Padding = new Thickness(12, 6, 12, 6);
            _fwdManage.FontSize = 12;
            _fwdManage.Cursor = Cursors.Hand;
            StyleButton(_fwdManage, false);
            _fwdManage.Click += (s, e) => { if (_openForward != null) _openForward(); };
            row.Children.Add(_fwdManage);

            // No "I received it" button: forwarding arms itself once the node
            // confirms the test payment.
            _fwdCopyTxid.Content = "Copy transaction ID";
            _fwdCopyTxid.Padding = new Thickness(12, 6, 12, 6);
            _fwdCopyTxid.FontSize = 12;
            _fwdCopyTxid.Margin = new Thickness(8, 0, 0, 0);
            _fwdCopyTxid.Cursor = Cursors.Hand;
            StyleButton(_fwdCopyTxid, false);
            _fwdCopyTxid.Click += (s, e) =>
            {
                if (string.IsNullOrEmpty(_last.Forward.LastTxid)) return;
                try { Clipboard.SetText(_last.Forward.LastTxid); _fwdCopyTxid.Content = "Copied"; } catch { }
            };
            row.Children.Add(_fwdCopyTxid);

            stack.Children.Add(row);
            return Panel(stack);
        }

        void ApplyForward(MinerSnapshot s)
        {
            ForwardStatus f = s.Forward ?? new ForwardStatus();
            bool holding = f.State == ForwardState.HOLDING || string.IsNullOrEmpty(f.Address);
            bool inFlight = f.HasSweep && f.SweepState != SweepState.SETTLED;

            if (inFlight)
            {
                _fwdState.Text = "Forwarding " + ForwardPolicy.CoinsSat(f.SweepAmountSat) + " - " +
                                 ForwardPolicy.SweepWording(f.SweepState, f.SweepConfirmations);
            }
            else if (holding)
            {
                _fwdState.Text = "Holding coins in this wallet. They are safe here: your twelve words " +
                                 "recover them. Set an address to forward them automatically.";
            }
            else if (f.State == ForwardState.PROBING_PENDING)
            {
                // Shows the destination IN FULL, deliberately. This is the state
                // a user sits in for a day after typing an address, and it is
                // the only chance to notice a wrong one before rewards are
                // committed to it. A shortened form would hide exactly the
                // characters a mistyped address differs by.
                _fwdState.Text = "Forwarding to:\n" + f.Address +
                                 "\n\nA test payment will be sent once coins mature - about a day " +
                                 "after this PC finds its next block.";
            }
            else if (f.State == ForwardState.PROBING_SENT && f.ProbeConfirmed)
            {
                _fwdState.Text = "Test payment of " + ForwardPolicy.CoinsSat(ForwardPolicy.PROBE_SAT) +
                                 " has arrived at " + ForwardPolicy.ShortAddress(f.Address) +
                                 ". Check that wallet, then confirm below.";
            }
            else if (f.State == ForwardState.PROBING_SENT)
            {
                _fwdState.Text = "Test payment of " + ForwardPolicy.CoinsSat(ForwardPolicy.PROBE_SAT) +
                                 " sent to " + ForwardPolicy.ShortAddress(f.Address) +
                                 " - waiting for it to confirm.";
            }
            else
            {
                string t = "Forwarding to " + ForwardPolicy.ShortAddress(f.Address) + ".";
                // Computed from OBSERVED block spacing, never from the 600 s
                // target - the measured value is far higher, so the target would
                // understate every estimate.
                if (f.EtaMs > 0) t += " Next forward in about " + ForwardPolicy.RoughDuration(f.EtaMs) + ".";
                _fwdState.Text = t;
            }

            // Read straight from persisted intent, never from a live reading:
            // the address the user chose must stay on screen even when the node
            // is unreachable, a sweep is mid-flight, or a precondition is
            // blocking. Shown in EVERY non-holding state, never only inside a
            // status sentence.
            bool showDest = !holding;
            _fwdDest.Text = f.Address ?? "";
            _fwdDest.Visibility = showDest ? Visibility.Visible : Visibility.Collapsed;
            _fwdDestLabel.Visibility = showDest ? Visibility.Visible : Visibility.Collapsed;

            // Ordinary blocked states are shown here and never notified:
            // "nothing mature yet" is what a healthy PC reports for most of
            // every day.
            bool showBlocked = !string.IsNullOrEmpty(f.Blocked) && !holding && !inFlight;
            _fwdBlocked.Text = showBlocked ? "Not forwarding: " + f.Blocked : "";
            _fwdBlocked.Visibility = showBlocked ? Visibility.Visible : Visibility.Collapsed;

            _fwdError.Text = f.Error ?? "";
            _fwdError.Visibility = string.IsNullOrEmpty(f.Error) ? Visibility.Collapsed : Visibility.Visible;

            // Sourced from persisted history, not from a live read, so it stays
            // on screen across restarts and does not vanish because a query
            // failed.
            bool hasLast = !string.IsNullOrEmpty(f.LastTxid);
            if (hasLast)
            {
                _fwdLast.Text = "Last forward: " + ForwardPolicy.CoinsSat(f.LastAmountSat) + " on " +
                                new DateTime(1970, 1, 1, 0, 0, 0, DateTimeKind.Utc)
                                    .AddMilliseconds(f.LastAtMs).ToLocalTime()
                                    .ToString("d MMM yyyy HH:mm", CultureInfo.InvariantCulture) +
                                "\n" + f.LastTxid;
            }
            _fwdLast.Visibility = hasLast ? Visibility.Visible : Visibility.Collapsed;
            _fwdCopyTxid.Visibility = hasLast ? Visibility.Visible : Visibility.Collapsed;

            _fwdManage.Content = holding ? "Set forwarding address" : "Change or stop forwarding";
        }

        /**
         * The node's vitals as a single footer line rather than a card.
         *
         * It is reference information - which process, how much memory, how
         * long it has been up - not something anyone watches, so it does not
         * deserve a card's worth of vertical space.
         */
        UIElement ProcessFooter()
        {
            var row = new DockPanel { Margin = new Thickness(2, 2, 2, 0), LastChildFill = true };

            var open = new Button
            {
                Content = "Open folder",
                Padding = new Thickness(10, 4, 10, 4),
                FontSize = 11,
                Cursor = Cursors.Hand,
                VerticalAlignment = VerticalAlignment.Top,
                Margin = new Thickness(8, 0, 0, 0)
            };
            StyleButton(open, false);
            open.Click += (s, e) => _openFolder();
            DockPanel.SetDock(open, Dock.Right);
            row.Children.Add(open);

            _proc.Foreground = Muted;
            _proc.FontSize = 11;
            _proc.TextWrapping = TextWrapping.Wrap;
            _proc.LineHeight = 16;
            _proc.VerticalAlignment = VerticalAlignment.Center;
            _proc.ToolTip = "Memory is mostly RandomX's 256 MB cache, which every mining thread shares.";
            row.Children.Add(_proc);

            return row;
        }

        // ---------- update ----------

        /**
         * Push a new reading. Must be called on the UI thread.
         *
         * Everything displayed comes from @p s; nothing is remembered between
         * calls except the hash-rate history, so a field that stops being
         * available cannot leave a stale value on screen pretending to be live.
         */
        public void Apply(MinerSnapshot s)
        {
            if (s == null) return;
            _last = s;

            UpdateFastMode(s.FastMode, s.AvailableMib);

            bool starting = s.NodeUp && s.WantMining && !s.Hashing;
            if (!s.NodeUp)
            {
                _statePip.Fill = Bad;
                // Name the actual cause. "Node not running" told nobody
                // anything they could act on.
                _state.Text = string.IsNullOrEmpty(s.Problem) ? "Node not running" : s.Problem;
            }
            else if (s.Hashing)
            {
                _statePip.Fill = Good;
                _state.Text = s.Syncing ? "Mining - still catching up" : "Mining";
            }
            else if (starting)
            {
                _statePip.Fill = Warn;
                _state.Text = "Starting the miner";
            }
            else
            {
                _statePip.Fill = Muted;
                _state.Text = "Not mining";
            }

            if (s.NodeUp && s.Hashing)
            {
                _rate.Text = s.Hashrate >= 1000
                    ? (s.Hashrate / 1000.0).ToString("0.00", CultureInfo.InvariantCulture)
                    : s.Hashrate.ToString("0.0", CultureInfo.InvariantCulture);
                _rateUnit.Text = s.Hashrate >= 1000 ? "kH/s" : "H/s";
                _rate.Foreground = Text;
            }
            else
            {
                _rate.Text = "--";
                _rateUnit.Text = "H/s";
                _rate.Foreground = Muted;
            }

            _effortLine.Text = s.NodeUp && s.Hashing
                ? string.Format(CultureInfo.InvariantCulture, "{0} of {1} cores  ·  {2}% effort", s.Threads, s.Cores, s.Percent)
                : string.Format(CultureInfo.InvariantCulture, "{0} cores available", s.Cores);

            // Pool proof, right under the hash rate. A pool miner finds no blocks
            // and its local balance stays 0, so a bare "720 H/s and 0 PCN" reads
            // as broken. The accepted-share counter -- climbing, with a "last
            // share N ago" pulse -- is the visible proof the pool is taking this
            // PC's work and crediting it.
            if (s.NodeUp && s.Hashing && s.PoolMining)
            {
                string host = string.IsNullOrEmpty(s.PoolUrl) ? "pool" : s.PoolUrl;
                string body;
                if (s.SharesAccepted <= 0)
                    body = "connected · waiting for first share";
                else if (s.LastShareAgeSec < 0)
                    body = string.Format(CultureInfo.InvariantCulture, "{0:#,##0} shares accepted", s.SharesAccepted);
                else
                    body = string.Format(CultureInfo.InvariantCulture, "{0:#,##0} shares accepted · last {1}",
                                         s.SharesAccepted, AgoWords(s.LastShareAgeSec));
                if (s.SharesRejected > 0)
                    body += string.Format(CultureInfo.InvariantCulture, " · {0:#,##0} rejected", s.SharesRejected);
                _poolLine.Text = "● " + host + "  ·  " + body;
                _poolLine.Foreground = Good;
                _poolLine.Visibility = Visibility.Visible;
                _poolNote.Text = "Pool rewards are paid to your address on the pool's schedule — they are not shown as a balance on this PC.";
                _poolNote.Visibility = Visibility.Visible;
            }
            else
            {
                _poolLine.Visibility = Visibility.Collapsed;
                _poolNote.Visibility = Visibility.Collapsed;
            }

            // Sampling happens in the tray app, so history keeps building while
            // this window is closed. Here it is only drawn.
            DrawSpark();

            _height.Text = s.NodeUp ? s.Height.ToString("#,##0", CultureInfo.InvariantCulture) : "--";
            _peers.Text = s.Peers >= 0 ? s.Peers.ToString(CultureInfo.InvariantCulture) : "--";
            // A pool miner finds no blocks -- the pool does -- so "Blocks mined: 0"
            // reads as failure to someone earning steadily. Show the shares the
            // pool is actually crediting instead, matching the tray menu.
            if (s.NodeUp && s.PoolMining)
            {
                _foundCaption.Text = "Shares";
                _found.Text = s.SharesAccepted.ToString("#,##0", CultureInfo.InvariantCulture);
            }
            else
            {
                _foundCaption.Text = "Blocks mined";
                _found.Text = s.NodeUp ? s.BlocksFound.ToString("#,##0", CultureInfo.InvariantCulture) : "--";
            }
            _diff.Text = s.NodeUp ? FormatDifficulty(s.Difficulty) : "--";
            _peers.Foreground = s.NodeUp && s.Peers == 0 ? Bad : Text;

            if (s.NodeUp && s.Syncing)
            {
                _syncCard.Visibility = Visibility.Visible;
                long behind = Math.Max(0, s.Headers - s.Height);
                _syncLine.Text = behind > 0
                    ? string.Format(CultureInfo.InvariantCulture,
                        "Catching up with the network - {0:#,##0} blocks to go ({1:0.0}%). Rewards found before this finishes may not survive.",
                        behind, s.Progress * 100.0)
                    : "Catching up with the network.";
                _syncBar.Value = Math.Max(0, Math.Min(1, s.Progress));
            }
            else
            {
                _syncCard.Visibility = Visibility.Collapsed;
            }

            // Re-fit the rail to the machine we are actually on. The slider is
            // built before any snapshot exists, so its range starts as a guess;
            // once the node reports the real core count, one tick must equal one
            // core or the label and the miner will disagree about what a step is.
            int coreMax = Math.Max(1, s.Cores);
            if (Math.Abs(_slider.Maximum - coreMax) > 0.5)
            {
                _sliderEcho = true;
                _slider.Maximum = coreMax;
                _slider.TickFrequency = coreMax > 32 ? 4 : 1;
                _sliderEcho = false;
            }

            // Mirror the live thread count WHILE MINING. While stopped, only
            // prime the rail once and then leave it where the user put it -- the
            // Start button reads _slider.Value, so re-pushing a default here is
            // exactly what discarded a pick made before mining.
            if (_pendingPercent < 0 && (s.WantMining || !_sliderPrimed))
            {
                int shown = Cpu.ThreadsFor(s.Percent, coreMax, s.FastMode);
                if (shown < 1)
                {
                    // Stopped and nothing chosen yet: default to the measured/
                    // heuristic best for this CPU, not an arbitrary 50%.
                    int rec = Cpu.Recommend(coreMax, s.FastMode);
                    shown = rec > 0 ? rec : Math.Max(1, Math.Min(coreMax, Cpu.ThreadsFor(50, coreMax, s.FastMode)));
                }
                _sliderEcho = true;
                _slider.Value = Math.Max(1, Math.Min(coreMax, shown));
                _sliderEcho = false;
                UpdateSliderLabel(Cpu.PercentForThreads(shown, coreMax), false);
                _sliderPrimed = true;
            }

            _toggle.Content = s.WantMining ? "Stop mining" : "Start mining";
            StyleButton(_toggle, !s.WantMining);

            // ---- mining mode (solo vs pool) ----
            // The advice line is always fresh. The radios re-echo ONLY when the
            // actual configured mode changes, so a user mid-selection (picked but
            // not yet Applied) is never stomped -- the same rule as the slider.
            // Prefer what the node is hashing right now, and fall back to
            // what auto-tuning measured, so a stopped miner still gets real
            // advice instead of "measuring..." beside a machine that is
            // measuring nothing. Difficulty is the exact input; the network
            // rate is only for the case where the chain call failed and it did not.
            double advHps = s.Hashrate > 0 ? s.Hashrate : s.MeasuredHashrate;
            var adv = Cpu.AdviseMode(advHps, s.Difficulty, s.NetworkHashps);
            _modeAdvice.Text = adv.Line;
            string poolUrl = s.PoolUrl ?? "";
            if (poolUrl != _lastShownPool)
            {
                _lastShownPool = poolUrl;
                bool poolNow = poolUrl.Length > 0;
                _modeEcho = true;
                _rbPool.IsChecked = poolNow;
                _rbSolo.IsChecked = !poolNow;
                _poolBox.Text = poolNow ? poolUrl : DEFAULT_POOL;
                _poolBox.IsEnabled = poolNow;
                _modeEcho = false;
            }

            _balPhrase.Visibility = s.PhraseBalance == null ? Visibility.Collapsed : Visibility.Visible;
            if (s.PhraseBalance != null) _balPhrase.Text = s.PhraseBalance;
            _balOld.Visibility = s.OldBalance == null ? Visibility.Collapsed : Visibility.Visible;
            if (s.OldBalance != null) _balOld.Text = s.OldBalance;
            if (s.PhraseBalance == null && s.OldBalance == null)
            {
                _balOld.Visibility = Visibility.Visible;
                _balOld.Text = s.NodeUp ? "Reading the wallet..." : "Waiting for the node";
            }

            _phraseWarn.Visibility = s.HasPhrase ? Visibility.Collapsed : Visibility.Visible;
            _phraseWarn.Text = "This wallet has no recovery phrase. If Windows is reinstalled or the disk "
                             + "fails, these coins are gone. Setting one up takes a minute.";
            _phraseBtn.Content = s.HasPhrase ? "Recovery phrase..." : "Set up a recovery phrase...";

            _addr.Text = string.IsNullOrEmpty(s.Address) ? "(none yet)" : s.Address;

            ApplyForward(s);

            _proc.Text = BuildProcessText(s);
        }

        static string BuildProcessText(MinerSnapshot s)
        {
            if (!s.NodeUp) return "bitcoind is not responding on this PC.";
            var sb = new System.Text.StringBuilder();
            sb.Append(string.IsNullOrEmpty(s.NodeVersion) ? "PCoin node" : s.NodeVersion);
            if (s.NodePid > 0)
            {
                sb.Append("  ·  pid ").Append(s.NodePid.ToString(CultureInfo.InvariantCulture));
                if (s.NodeMemoryMb > 0)
                    sb.Append("  ·  ").Append(s.NodeMemoryMb.ToString("#,##0", CultureInfo.InvariantCulture)).Append(" MB");
                if (s.NodeUptime.TotalSeconds > 0)
                    sb.Append("  ·  up ").Append(FormatSpan(s.NodeUptime));
            }
            return sb.ToString();
        }

        static string FormatSpan(TimeSpan t)
        {
            if (t.TotalDays >= 1) return string.Format(CultureInfo.InvariantCulture, "{0}d {1}h", (int)t.TotalDays, t.Hours);
            if (t.TotalHours >= 1) return string.Format(CultureInfo.InvariantCulture, "{0}h {1}m", (int)t.TotalHours, t.Minutes);
            return string.Format(CultureInfo.InvariantCulture, "{0}m", Math.Max(1, (int)t.TotalMinutes));
        }

        //! "8s ago" / "3m ago" / "1h ago" for the share heartbeat. Kept coarse
        //! on purpose -- the point is a live pulse, not a stopwatch.
        static string AgoWords(int sec)
        {
            if (sec < 5) return "just now";
            if (sec < 90) return sec.ToString(CultureInfo.InvariantCulture) + "s ago";
            if (sec < 5400) return Math.Max(1, (sec + 30) / 60).ToString(CultureInfo.InvariantCulture) + "m ago";
            return Math.Max(1, (sec + 1800) / 3600).ToString(CultureInfo.InvariantCulture) + "h ago";
        }

        static string FormatDifficulty(double d)
        {
            if (d <= 0) return "--";
            if (d >= 1000000) return (d / 1000000.0).ToString("0.00", CultureInfo.InvariantCulture) + "M";
            if (d >= 1000) return (d / 1000.0).ToString("0.00", CultureInfo.InvariantCulture) + "k";
            if (d >= 1) return d.ToString("0.00", CultureInfo.InvariantCulture);
            return d.ToString("0.0000", CultureInfo.InvariantCulture);
        }

        // ---------- the graph ----------

        void DrawSpark()
        {
            double w = _sparkCanvas.ActualWidth, h = _sparkCanvas.ActualHeight;
            double peak;
            int seconds;
            double[] hist = _history.Points(out peak, out seconds);

            if (w <= 1 || h <= 1 || hist.Length < 2)
            {
                _spark.Points = new PointCollection();
                _sparkFill.Points = new PointCollection();
                _sparkNote.Text = "Collecting hash-rate history...";
                return;
            }

            // A flat zero line still needs a scale, or every point lands on the
            // bottom edge and the graph looks broken rather than idle.
            double scale = peak > 0 ? peak * 1.15 : 1.0;

            // The hour is drawn to a fixed width whether or not it is full, so
            // the line grows in from the left instead of the whole graph
            // rescaling under the reader every fifteen seconds.
            int slots = Math.Max(hist.Length, RateHistory.BUCKETS);
            double step = w / (slots - 1.0);
            double x0 = w - step * (hist.Length - 1);

            var pts = new PointCollection(hist.Length);
            for (int i = 0; i < hist.Length; i++)
                pts.Add(new Point(x0 + step * i, h - (hist[i] / scale) * (h - 2) - 1));
            _spark.Points = pts;

            var fill = new PointCollection(pts);
            fill.Add(new Point(w, h));
            fill.Add(new Point(x0, h));
            _sparkFill.Points = fill;

            _sparkNote.Text = peak > 0
                ? string.Format(CultureInfo.InvariantCulture, "Last hour · peak {0:#,##0.0} H/s", peak)
                : "Last hour · idle";
        }

        // ---------- slider ----------

        static int Snap(int v)
        {
            int s = (int)(Math.Round(v / 5.0) * 5);
            return Math.Max(10, Math.Min(100, s));
        }

        //! The RandomX dataset. 2080 MiB is the real figure from the library,
        //! not a round number -- see randomx.h RANDOMX_DATASET_BASE_SIZE +
        //! RANDOMX_DATASET_EXTRA_SIZE.
        const long FAST_MODE_MIB = 2080;
        //! Headroom on top. Allocating right up to the last free megabyte on a
        //! machine that is also doing something else is how the OOM killer gets
        //! involved, and on Windows how everything starts swapping.
        const long FAST_MODE_HEADROOM_MIB = 900;

        /**
         * Decide what the fast-mode row says, from what this machine actually has.
         *
         * Three outcomes, and the disabled one still explains itself. An option
         * that is simply absent on some machines reads as a bug or a missing
         * feature; one that says "this PC has 2.0 GB free and needs about 3.0"
         * tells the owner exactly what would change it.
         */
        //! Enabled in v1.2.4 — the release that also adds -randomxfastmode to the
        //! node. The two must ship together, and that is not a preference: Core
        //! exits on an unknown argument, so a tray passing this flag to an older
        //! bitcoind kills the node it just started. If this is ever true while the
        //! node flag is absent, every user who ticks the box loses mining until
        //! they untick it, and the cause is invisible from the UI.
        const bool FAST_MODE_AVAILABLE = true;

        void UpdateFastMode(bool enabled, long availableMib)
        {
            long need = FAST_MODE_MIB + FAST_MODE_HEADROOM_MIB;
            bool eligible = FAST_MODE_AVAILABLE && availableMib >= need;

            _fastEcho = true;
            _fastCheck.IsEnabled = eligible;
            _fastCheck.IsChecked = enabled && eligible;
            _fastEcho = false;

            _fastCheck.Opacity = eligible ? 1.0 : 0.55;

            if (!FAST_MODE_AVAILABLE)
            {
                _fastNote.Text = "Coming in the next update. It builds a 2 GB table in "
                               + "memory and mines several times faster on this PC.";
            }
            else if (!eligible)
            {
                _fastNote.Text = string.Format(CultureInfo.InvariantCulture,
                    "Needs about {0:0.0} GB of free memory; this PC has {1:0.0} GB right now. "
                    + "Mining still works in the normal mode.",
                    need / 1024.0, availableMib / 1024.0);
            }
            else if (enabled)
            {
                _fastNote.Text = string.Format(CultureInfo.InvariantCulture,
                    "On. Uses about {0:0.0} GB while mining. The first start takes a "
                    + "few seconds to build the table.", FAST_MODE_MIB / 1024.0);
            }
            else
            {
                _fastNote.Text = string.Format(CultureInfo.InvariantCulture,
                    "Off. Turning it on uses about {0:0.0} GB of memory and mines "
                    + "several times faster. Same coins, same rules — only this PC "
                    + "changes.", FAST_MODE_MIB / 1024.0);
            }
        }

        //! Say what this setting will actually DO, including when more is not more.
        //!
        //! The old label read "100% - 24 of 24 cores", which promises a payoff
        //! that does not exist: past the point where the RandomX scratchpads stop
        //! fitting in L3, extra threads make the machine mine LESS (see Cpu). An
        //! owner who dragged this to the end got a hot, unusable PC producing
        //! about half the coin of the same PC at a third of the setting, with
        //! nothing on screen hinting at it. Now the slider stops at the useful
        //! number and the label explains the stop, because a control that
        //! silently ignores its own top half is its own kind of lie.
        //! Say how many cores, and say when more of them would earn LESS.
        //!
        //! The advice is never enforced -- the operator asked for this control
        //! and is entitled to use all of it. But silence would be dishonest: on
        //! a 24-thread/19.25 MB-L3 machine, all 24 cores measured 1308 H/s
        //! against 2563 at nine, because each RandomX thread needs a private
        //! 2 MiB scratchpad and only nine fit in L3. Someone dragging to the end
        //! deserves to know that before their electricity bill tells them.
        void UpdateSliderLabel(int percent, bool pending)
        {
            int cores = Math.Max(1, _last.Cores);
            int threads = Cpu.ThreadsFor(percent, cores, _last.FastMode);
            int best = Cpu.Recommend(cores, _last.FastMode);
            string note = "";
            if (best > 0 && threads > best)
                note = string.Format(CultureInfo.InvariantCulture,
                    "  -  more than {0} usually mines LESS on this CPU", best);
            else if (best > 0 && threads == best)
                note = "  -  fastest measured on this CPU";
            _sliderLabel.Text = string.Format(CultureInfo.InvariantCulture,
                "{0} of {1} cores{2}{3}", threads, cores, note,
                pending ? "  (release to apply)" : "");
        }

        void CommitSlider()
        {
            if (_pendingPercent < 0) return;
            int p = _pendingPercent;
            _pendingPercent = -1;
            UpdateSliderLabel(p, false);
            // Moving the slider sets the effort. It does not start mining that
            // was switched off -- that is what the button is for.
            if (_last.WantMining && p != _last.Percent) _setPercent(p);
        }

        // ---------- small helpers ----------

        static Brush Frozen(string argb)
        {
            var b = new SolidColorBrush((Color)ColorConverter.ConvertFromString(argb));
            b.Freeze();
            return b;
        }

        static TextBlock Caption(string text)
        {
            return new TextBlock
            {
                Text = text.ToUpperInvariant(),
                Foreground = Muted,
                FontSize = 10.5,
                FontWeight = FontWeights.SemiBold,
                Margin = new Thickness(0, 0, 0, 8)
            };
        }

        static Border Panel(UIElement child)
        {
            return new Border
            {
                Child = child,
                Background = Card,
                BorderBrush = CardEdge,
                BorderThickness = new Thickness(1),
                CornerRadius = new CornerRadius(10),
                Padding = new Thickness(13, 11, 13, 11),
                Margin = new Thickness(0, 0, 0, 10)
            };
        }

        /**
         * Give a button a flat look that survives on a dark background.
         *
         * The stock Aero template paints its own light chrome and ignores
         * Background, so the whole visual tree is replaced.
         */
        static void StyleButton(Button b, bool primary)
        {
            b.Foreground = primary ? Brushes.White : Text;
            b.Background = primary ? Accent : Card;
            b.BorderBrush = primary ? Accent : CardEdge;
            b.BorderThickness = new Thickness(1);
            if (b.Template != null && b.Tag as string == "styled") return;

            var border = new FrameworkElementFactory(typeof(Border));
            border.SetValue(Border.CornerRadiusProperty, new CornerRadius(7));
            border.SetBinding(Border.BackgroundProperty, new System.Windows.Data.Binding("Background") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
            border.SetBinding(Border.BorderBrushProperty, new System.Windows.Data.Binding("BorderBrush") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
            border.SetBinding(Border.BorderThicknessProperty, new System.Windows.Data.Binding("BorderThickness") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });
            // Bind Padding to the button, do NOT nail it to zero. This template
            // replaces the entire visual tree, so a hardcoded 0 here silently
            // discarded every Padding set by a caller -- which is why raising
            // _toggle.Padding did nothing at all and Start mining kept rendering
            // as a thin strip.
            border.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });

            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            presenter.SetValue(ContentPresenter.MarginProperty, new Thickness(10, 0, 10, 0));
            border.AppendChild(presenter);

            var t = new ControlTemplate(typeof(Button)) { VisualTree = border };
            b.Template = t;
            b.Tag = "styled";
        }

        /**
         * Replace the stock slider chrome, which paints a white track from the
         * system theme and ignores Background on a dark window.
         */
        static void StyleSlider(Slider s)
        {
            // Parsed from markup rather than built with FrameworkElementFactory
            // because Track.Thumb and the two repeat buttons are plain CLR
            // properties, which a factory cannot set. This is still runtime
            // XAML - nothing here needs a XAML compiler, so the app keeps
            // building with the in-box csc.
            //
            // The decrease button IS the filled part of the track, which is why
            // it is not blank: it shows how far along the slider sits, and
            // clicking anywhere on the rail still pages the value.
            const string xaml =
                "<ControlTemplate TargetType=\"Slider\"" +
                " xmlns=\"http://schemas.microsoft.com/winfx/2006/xaml/presentation\"" +
                " xmlns:x=\"http://schemas.microsoft.com/winfx/2006/xaml\">" +
                "<Grid>" +
                "<Border Height=\"4\" CornerRadius=\"2\" Background=\"#FF2A2A38\" VerticalAlignment=\"Center\"/>" +
                "<Track x:Name=\"PART_Track\">" +
                "<Track.DecreaseRepeatButton>" +
                "<RepeatButton Command=\"{x:Static Slider.DecreaseLarge}\">" +
                "<RepeatButton.Template><ControlTemplate TargetType=\"RepeatButton\">" +
                "<Border Background=\"Transparent\">" +
                "<Border Height=\"4\" CornerRadius=\"2\" Background=\"#FF8B5CF6\" VerticalAlignment=\"Center\"/>" +
                "</Border></ControlTemplate></RepeatButton.Template></RepeatButton>" +
                "</Track.DecreaseRepeatButton>" +
                "<Track.IncreaseRepeatButton>" +
                "<RepeatButton Command=\"{x:Static Slider.IncreaseLarge}\">" +
                "<RepeatButton.Template><ControlTemplate TargetType=\"RepeatButton\">" +
                "<Border Background=\"Transparent\"/></ControlTemplate></RepeatButton.Template></RepeatButton>" +
                "</Track.IncreaseRepeatButton>" +
                "<Track.Thumb>" +
                "<Thumb Width=\"16\" Height=\"16\">" +
                "<Thumb.Template><ControlTemplate TargetType=\"Thumb\">" +
                "<Ellipse Width=\"16\" Height=\"16\" Fill=\"#FF8B5CF6\"/>" +
                "</ControlTemplate></Thumb.Template></Thumb>" +
                "</Track.Thumb>" +
                "</Track></Grid></ControlTemplate>";
            try
            {
                s.Template = (ControlTemplate)System.Windows.Markup.XamlReader.Parse(xaml);
            }
            catch
            {
                // Keep the stock slider rather than lose the control entirely.
            }
            s.Height = 22;
            s.Cursor = Cursors.Hand;
        }

        /**
         * Ask Windows for a dark title bar so the frame matches the content.
         *
         * Best effort: the attribute is ignored before Windows 10 1809 and
         * changed number in 20H1, so both are tried and neither is checked.
         */
        void DarkenTitleBar()
        {
            try
            {
                var helper = new System.Windows.Interop.WindowInteropHelper(this);
                int on = 1;
                DwmSetWindowAttribute(helper.Handle, 20, ref on, sizeof(int));
                DwmSetWindowAttribute(helper.Handle, 19, ref on, sizeof(int));
            }
            catch { }
        }

        [System.Runtime.InteropServices.DllImport("dwmapi.dll")]
        static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int value, int size);

        /**
         * Show the window, or bring it back if it is already open behind
         * something. Restores a minimised window: on a second launch attempt
         * people expect the window, not silence.
         */
        public void Reveal()
        {
            if (!IsVisible) Show();
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            Activate();
            Topmost = true;
            Topmost = false;
            Focus();
        }

        /** Read the node process's own vitals. Cheap, and purely cosmetic. */
        public static void FillProcessInfo(MinerSnapshot s)
        {
            try
            {
                var ps = Process.GetProcessesByName("bitcoind");
                if (ps.Length == 0) return;
                var p = ps[0];
                s.NodePid = p.Id;
                s.NodeMemoryMb = p.WorkingSet64 / (1024.0 * 1024.0);
                try { s.NodeUptime = DateTime.Now - p.StartTime; }
                catch { /* another user's process: start time is not readable */ }
            }
            catch { }
        }
    }
}
