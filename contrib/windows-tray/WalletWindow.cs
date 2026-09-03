// Copyright (c) 2026 The PCoin developers
// Distributed under the MIT software license, see the accompanying
// file COPYING or http://www.opensource.org/licenses/mit-license.php.
//
// The PCoin Wallet main window: balance, sync state, the receive address as
// text and as a QR code, and the buttons that open everything else.
//
// WPF, written in code rather than XAML so the app still builds with the
// in-box csc.exe, running on the WinForms message loop that WalletApp pumps -
// the same arrangement as the miner's MinerWindow, whose look this copies.
// Closing this window quits the app (see WalletApp.Quit).
//
// Two things about the receive card are deliberate and must survive edits:
//
//  * The QR encodes the BARE address, not a pcoin: URI. Nothing in this
//    ecosystem parses BIP21 yet, and a scanner that shows the raw text shows
//    something a person can compare against the text underneath.
//  * The QR is always black on white, whatever the theme, with a four-module
//    quiet zone drawn as part of the image. A dark-mode QR with inverted
//    colours is unreadable to a good many scanners, and a code butted against
//    a coloured card is a code that does not scan. Modules are whole pixels:
//    the bitmap is built at an integer scale and shown unscaled, so no module
//    is a fraction of a pixel wider than its neighbour.

using System;
using System.Globalization;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Shapes;

namespace PCoinTray
{
    /**
     * What the window shows. Built by WalletApp on its poll thread and handed
     * over whole; unknown readings stay unknown (BalanceKnown false, Blocks
     * -1) rather than reading as zero.
     */
    class WalletSnapshot
    {
        public bool NodeUp;
        public string NodeStatus = "";
        public bool StartedNode;
        public bool HasWallet;
        public string WalletProblem = "";
        public string Address = "";
        public string AddressWarning = "";
        public string DataDir = "";
        public bool ChainKnown;
        public long Blocks = -1;
        public long Headers = -1;
        public bool Ibd = true;
        public double Progress;
        public int Peers = -1;
        public bool BalanceKnown;
        public long TrustedSat;
        public long PendingSat;
        public long ImmatureSat;
        /** height and headers both known, not in IBD, height >= headers. */
        public bool BalanceTrustworthy;
    }

    class WalletWindow : Window
    {
        static readonly Brush Bg = Frozen("#FF12121A");
        static readonly Brush Card = Frozen("#FF1B1B26");
        static readonly Brush CardEdge = Frozen("#FF2A2A38");
        static readonly Brush Accent = Frozen("#FF8B5CF6");
        static readonly Brush Text = Frozen("#FFEDEDF2");
        static readonly Brush Muted = Frozen("#FF8B8B9E");
        static readonly Brush Good = Frozen("#FF34D399");
        static readonly Brush Warn = Frozen("#FFFBBF24");
        static readonly Brush Bad = Frozen("#FFF87171");

        /** The QR image's target edge, in pixels, before integer rounding. */
        const int QR_TARGET_PX = 216;
        const int QR_QUIET = 4;

        readonly Action _onSend, _onHistory, _onBook, _onPhrase, _onSetup, _onFolder, _onClose;

        readonly Ellipse _statePip = new Ellipse { Width = 10, Height = 10, Margin = new Thickness(0, 4, 8, 0), VerticalAlignment = VerticalAlignment.Top };
        readonly TextBlock _state = new TextBlock();
        readonly TextBlock _balance = new TextBlock();
        readonly TextBlock _balanceUnit = new TextBlock();
        readonly TextBlock _pendingLine = new TextBlock();
        readonly TextBlock _walletProblem = new TextBlock();
        readonly Border _syncCard = new Border();
        readonly TextBlock _syncLine = new TextBlock();
        readonly ProgressBar _syncBar = new ProgressBar();
        readonly Border _setupCard = new Border();
        readonly Border _receiveCard = new Border();
        readonly Image _qr = new Image();
        readonly Border _qrPlate = new Border();
        readonly TextBox _addr = new TextBox();
        readonly TextBlock _addrWarn = new TextBlock();
        readonly TextBlock _footer = new TextBlock();
        readonly Button _send = new Button();
        readonly Button _history = new Button();
        readonly Button _book = new Button();
        readonly Button _phraseBtn = new Button();
        readonly Button _copy = new Button();

        WalletSnapshot _last = new WalletSnapshot();
        string _qrFor;
        bool _allowClose;

        public WalletWindow(Action onSend, Action onHistory, Action onBook, Action onPhrase,
                            Action onSetup, Action onFolder, Action onClose)
        {
            _onSend = onSend;
            _onHistory = onHistory;
            _onBook = onBook;
            _onPhrase = onPhrase;
            _onSetup = onSetup;
            _onFolder = onFolder;
            _onClose = onClose;

            Title = "PCoin Wallet";
            Width = 480;
            MinWidth = 420;
            Height = 720;
            MinHeight = 480;
            Background = Bg;
            WindowStartupLocation = WindowStartupLocation.CenterScreen;
            TextOptions.SetTextFormattingMode(this, TextFormattingMode.Display);
            UseLayoutRounding = true;
            SnapsToDevicePixels = true;
            SourceInitialized += (s, e) => DarkenTitleBar();
            // Closing is quitting. The app decides how (it may have a node to
            // stop first) and calls ForceClose when it is done.
            Closing += (s, e) =>
            {
                if (_allowClose) return;
                e.Cancel = true;
                _onClose();
            };

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
            col.Children.Add(BalanceCard());
            col.Children.Add(SyncCard());
            col.Children.Add(SetupCard());
            col.Children.Add(ReceiveCard());
            col.Children.Add(ActionsCard());
            col.Children.Add(Footer());
            scroll.Content = col;
            return scroll;
        }

        UIElement Header()
        {
            var row = new DockPanel { Margin = new Thickness(0, 0, 0, 10) };
            var name = new TextBlock
            {
                Text = "PCoin Wallet",
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

        UIElement BalanceCard()
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

            stack.Children.Add(Caption("Balance"));
            var row = new StackPanel { Orientation = Orientation.Horizontal };
            _balance.Foreground = Text;
            _balance.FontSize = 34;
            _balance.FontWeight = FontWeights.Light;
            _balance.Text = "--";
            row.Children.Add(_balance);
            _balanceUnit.Foreground = Muted;
            _balanceUnit.FontSize = 15;
            _balanceUnit.Margin = new Thickness(7, 0, 0, 7);
            _balanceUnit.VerticalAlignment = VerticalAlignment.Bottom;
            _balanceUnit.Text = "PCN";
            row.Children.Add(_balanceUnit);
            stack.Children.Add(row);

            _pendingLine.Foreground = Muted;
            _pendingLine.FontSize = 12;
            _pendingLine.TextWrapping = TextWrapping.Wrap;
            _pendingLine.Margin = new Thickness(0, 2, 0, 0);
            stack.Children.Add(_pendingLine);

            _walletProblem.Foreground = Warn;
            _walletProblem.FontSize = 11.5;
            _walletProblem.TextWrapping = TextWrapping.Wrap;
            _walletProblem.Margin = new Thickness(0, 8, 0, 0);
            _walletProblem.Visibility = Visibility.Collapsed;
            stack.Children.Add(_walletProblem);

            return Panel(stack);
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

        UIElement SetupCard()
        {
            var stack = new StackPanel();
            stack.Children.Add(Caption("No wallet yet"));
            stack.Children.Add(new TextBlock
            {
                Text = "Create a new wallet, or restore one from its twelve words. The same words " +
                       "open the wallet in the PCoin Wallet app on Android.",
                Foreground = Text,
                FontSize = 12.5,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 0, 0, 10)
            });
            var b = new Button { Content = "Create or restore a wallet...", Padding = new Thickness(14, 7, 14, 7), FontSize = 12.5, Cursor = Cursors.Hand, HorizontalAlignment = HorizontalAlignment.Left };
            StyleButton(b, true);
            b.Click += (s, e) => _onSetup();
            stack.Children.Add(b);

            _setupCard.Child = stack;
            _setupCard.Background = Card;
            _setupCard.BorderBrush = Accent;
            _setupCard.BorderThickness = new Thickness(1);
            _setupCard.CornerRadius = new CornerRadius(10);
            _setupCard.Padding = new Thickness(13, 11, 13, 11);
            _setupCard.Margin = new Thickness(0, 0, 0, 10);
            _setupCard.Visibility = Visibility.Collapsed;
            return _setupCard;
        }

        UIElement ReceiveCard()
        {
            var stack = new StackPanel();
            stack.Children.Add(Caption("Receive"));

            // A white plate around the code, whatever the theme.
            _qr.Stretch = Stretch.None;
            _qr.HorizontalAlignment = HorizontalAlignment.Center;
            _qr.VerticalAlignment = VerticalAlignment.Center;
            RenderOptions.SetBitmapScalingMode(_qr, BitmapScalingMode.NearestNeighbor);
            RenderOptions.SetEdgeMode(_qr, EdgeMode.Aliased);
            _qrPlate.Child = _qr;
            _qrPlate.Background = Brushes.White;
            _qrPlate.CornerRadius = new CornerRadius(6);
            _qrPlate.HorizontalAlignment = HorizontalAlignment.Center;
            _qrPlate.Margin = new Thickness(0, 0, 0, 10);
            _qrPlate.Visibility = Visibility.Collapsed;
            stack.Children.Add(_qrPlate);

            stack.Children.Add(new TextBlock
            {
                Text = "Your PCoin address",
                Foreground = Muted,
                FontSize = 11,
                Margin = new Thickness(0, 0, 0, 3)
            });
            // Read-only TextBox rather than a TextBlock: an address is
            // something people need to select and copy, and a label cannot be.
            _addr.IsReadOnly = true;
            _addr.Background = Brushes.Transparent;
            _addr.BorderThickness = new Thickness(0);
            _addr.Foreground = Text;
            _addr.FontFamily = new FontFamily("Consolas, Courier New");
            _addr.FontSize = 12.5;
            _addr.Padding = new Thickness(0);
            _addr.TextWrapping = TextWrapping.Wrap;
            _addr.Text = "(no wallet yet)";
            stack.Children.Add(_addr);

            _addrWarn.Foreground = Warn;
            _addrWarn.FontSize = 11.5;
            _addrWarn.TextWrapping = TextWrapping.Wrap;
            _addrWarn.Margin = new Thickness(0, 6, 0, 0);
            _addrWarn.Visibility = Visibility.Collapsed;
            stack.Children.Add(_addrWarn);

            var row = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 10, 0, 0) };
            _copy.Content = "Copy address";
            _copy.Padding = new Thickness(12, 6, 12, 6);
            _copy.FontSize = 12;
            _copy.Cursor = Cursors.Hand;
            StyleButton(_copy, false);
            _copy.Click += (s, e) =>
            {
                if (string.IsNullOrEmpty(_last.Address)) return;
                try { Clipboard.SetText(_last.Address); _copy.Content = "Copied"; } catch { }
            };
            row.Children.Add(_copy);
            stack.Children.Add(row);

            stack.Children.Add(new TextBlock
            {
                Text = "This address belongs to your twelve words and never changes. Anyone can pay you " +
                       "at it as often as they like.",
                Foreground = Muted,
                FontSize = 11,
                TextWrapping = TextWrapping.Wrap,
                Margin = new Thickness(0, 8, 0, 0)
            });

            _receiveCard.Child = stack;
            _receiveCard.Background = Card;
            _receiveCard.BorderBrush = CardEdge;
            _receiveCard.BorderThickness = new Thickness(1);
            _receiveCard.CornerRadius = new CornerRadius(10);
            _receiveCard.Padding = new Thickness(13, 11, 13, 11);
            _receiveCard.Margin = new Thickness(0, 0, 0, 10);
            return _receiveCard;
        }

        UIElement ActionsCard()
        {
            var stack = new StackPanel();
            stack.Children.Add(Caption("Wallet"));

            var row1 = new StackPanel { Orientation = Orientation.Horizontal };
            _send.Content = "Send...";
            _send.Padding = new Thickness(16, 7, 16, 7);
            _send.FontSize = 13;
            _send.Cursor = Cursors.Hand;
            StyleButton(_send, true);
            _send.Click += (s, e) => _onSend();
            row1.Children.Add(_send);

            _history.Content = "History...";
            _history.Padding = new Thickness(12, 7, 12, 7);
            _history.FontSize = 13;
            _history.Margin = new Thickness(8, 0, 0, 0);
            _history.Cursor = Cursors.Hand;
            StyleButton(_history, false);
            _history.Click += (s, e) => _onHistory();
            row1.Children.Add(_history);

            _book.Content = "Address book...";
            _book.Padding = new Thickness(12, 7, 12, 7);
            _book.FontSize = 13;
            _book.Margin = new Thickness(8, 0, 0, 0);
            _book.Cursor = Cursors.Hand;
            StyleButton(_book, false);
            _book.Click += (s, e) => _onBook();
            row1.Children.Add(_book);
            stack.Children.Add(row1);

            var row2 = new StackPanel { Orientation = Orientation.Horizontal, Margin = new Thickness(0, 8, 0, 0) };
            _phraseBtn.Content = "Recovery phrase...";
            _phraseBtn.Padding = new Thickness(12, 6, 12, 6);
            _phraseBtn.FontSize = 12;
            _phraseBtn.Cursor = Cursors.Hand;
            StyleButton(_phraseBtn, false);
            _phraseBtn.Click += (s, e) => _onPhrase();
            row2.Children.Add(_phraseBtn);

            var folder = new Button { Content = "Open wallet folder", Padding = new Thickness(12, 6, 12, 6), FontSize = 12, Margin = new Thickness(8, 0, 0, 0), Cursor = Cursors.Hand };
            StyleButton(folder, false);
            folder.Click += (s, e) => _onFolder();
            row2.Children.Add(folder);
            stack.Children.Add(row2);

            return Panel(stack);
        }

        UIElement Footer()
        {
            _footer.Foreground = Muted;
            _footer.FontSize = 10.5;
            _footer.TextWrapping = TextWrapping.Wrap;
            _footer.Margin = new Thickness(2, 0, 2, 0);
            return _footer;
        }

        // ---------- data ----------

        public void Apply(WalletSnapshot s)
        {
            if (s == null) return;
            _last = s;

            // Status line.
            if (!s.NodeUp)
            {
                _statePip.Fill = string.IsNullOrEmpty(s.NodeStatus) ? Warn : Bad;
                _state.Text = string.IsNullOrEmpty(s.NodeStatus) ? "Starting the PCoin node..." : s.NodeStatus;
            }
            else if (!s.ChainKnown)
            {
                _statePip.Fill = Warn;
                _state.Text = "Node running. Reading the chain...";
            }
            else if (s.Ibd || (s.Headers >= 0 && s.Blocks < s.Headers))
            {
                _statePip.Fill = Warn;
                _state.Text = "Catching up with the chain";
            }
            else
            {
                _statePip.Fill = Good;
                _state.Text = "Up to date" + (s.Peers > 0 ? " - " + s.Peers + (s.Peers == 1 ? " peer" : " peers") : "");
            }

            // Balance. An unread balance is a dash, never 0.00000000.
            if (!s.HasWallet)
            {
                _balance.Text = "--";
                _pendingLine.Text = "";
            }
            else if (!s.BalanceKnown)
            {
                _balance.Text = "--";
                _pendingLine.Text = s.NodeUp ? "Reading the balance..." : "The balance cannot be read while the node is down.";
            }
            else
            {
                _balance.Text = Amounts.ToPlainString(s.TrustedSat);
                var parts = new System.Collections.Generic.List<string>();
                if (s.PendingSat > 0) parts.Add("Pending: " + Amounts.ToPlainString(s.PendingSat) + " PCN");
                if (s.ImmatureSat > 0) parts.Add("Immature: " + Amounts.ToPlainString(s.ImmatureSat) + " PCN");
                string line = string.Join("   ", parts.ToArray());
                if (!s.BalanceTrustworthy) line = (line.Length > 0 ? line + "\n" : "") + "The node is still catching up, so this figure may be behind.";
                _pendingLine.Text = line;
            }
            _walletProblem.Text = s.WalletProblem ?? "";
            _walletProblem.Visibility = string.IsNullOrEmpty(s.WalletProblem) ? Visibility.Collapsed : Visibility.Visible;

            // Sync card.
            bool syncing = s.NodeUp && s.ChainKnown && (s.Ibd || (s.Headers >= 0 && s.Blocks < s.Headers));
            _syncCard.Visibility = syncing ? Visibility.Visible : Visibility.Collapsed;
            if (syncing)
            {
                string where = s.Blocks >= 0 && s.Headers >= 0
                    ? "block " + s.Blocks.ToString("N0", CultureInfo.InvariantCulture) + " of " + s.Headers.ToString("N0", CultureInfo.InvariantCulture)
                    : "reading headers";
                _syncLine.Text = "Catching up with the chain: " + where + " (" +
                                 (s.Progress * 100.0).ToString("0.0", CultureInfo.InvariantCulture) + "%). " +
                                 "Sending waits until this finishes; receiving works now.";
                _syncBar.Value = Math.Max(0.0, Math.Min(1.0, s.Progress));
            }

            // Setup card versus receive card.
            _setupCard.Visibility = !s.HasWallet && string.IsNullOrEmpty(s.WalletProblem) ? Visibility.Visible : Visibility.Collapsed;
            _receiveCard.Visibility = s.HasWallet ? Visibility.Visible : Visibility.Collapsed;
            if (s.HasWallet)
            {
                _addr.Text = s.Address;
                if (!string.Equals(_qrFor, s.Address, StringComparison.Ordinal))
                {
                    _qrFor = s.Address;
                    var img = RenderQr(s.Address, QR_TARGET_PX);
                    _qr.Source = img;
                    if (img != null)
                    {
                        _qr.Width = img.PixelWidth;
                        _qr.Height = img.PixelHeight;
                    }
                    // Unencodable is a real answer: the address text underneath
                    // is what the person pays to, the code is a convenience.
                    _qrPlate.Visibility = img == null ? Visibility.Collapsed : Visibility.Visible;
                    _copy.Content = "Copy address";
                }
                _addrWarn.Text = s.AddressWarning ?? "";
                _addrWarn.Visibility = string.IsNullOrEmpty(s.AddressWarning) ? Visibility.Collapsed : Visibility.Visible;
            }

            _send.IsEnabled = s.HasWallet && s.NodeUp;
            _history.IsEnabled = s.HasWallet && s.NodeUp;
            _phraseBtn.IsEnabled = s.HasWallet || !string.IsNullOrEmpty(s.WalletProblem);

            _footer.Text = "Node: " + (s.NodeUp ? (s.StartedNode ? "running, started by this app" : "running, started elsewhere") : "not running") +
                           (s.NodeUp && s.ChainKnown && !syncing && s.Blocks >= 0 ? " - height " + s.Blocks.ToString("N0", CultureInfo.InvariantCulture) : "") +
                           "\nData folder: " + s.DataDir + "\nRPC port " + WalletProgram.RPC_PORT + ", no inbound P2P.";
        }

        /**
         * The QR as pixels. Black on white, QR_QUIET modules of white on every
         * side, every module an integer number of pixels.
         */
        static BitmapSource RenderQr(string text, int targetPx)
        {
            var m = QrCode.Encode(text);
            if (m == null) return null;
            int modules = m.Size + 2 * QR_QUIET;
            int scale = Math.Max(1, targetPx / modules);
            int px = modules * scale;
            var pixels = new byte[px * px];
            for (int i = 0; i < pixels.Length; i++) pixels[i] = 255;
            for (int y = 0; y < m.Size; y++)
            {
                for (int x = 0; x < m.Size; x++)
                {
                    if (!m[x, y]) continue;
                    int left = (x + QR_QUIET) * scale;
                    int top = (y + QR_QUIET) * scale;
                    for (int dy = 0; dy < scale; dy++)
                    {
                        int row = (top + dy) * px + left;
                        for (int dx = 0; dx < scale; dx++) pixels[row + dx] = 0;
                    }
                }
            }
            var bmp = BitmapSource.Create(px, px, 96, 96, PixelFormats.Gray8, null, pixels, px);
            bmp.Freeze();
            return bmp;
        }

        // ---------- window plumbing ----------

        public void Reveal()
        {
            if (!IsVisible) Show();
            if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
            Activate();
            Topmost = true;
            Topmost = false;
            Focus();
        }

        /** Close for real. Only WalletApp.Quit calls this, after the node is down. */
        public void ForceClose()
        {
            _allowClose = true;
            try { Close(); } catch { }
        }

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

        /** The same flat button as the miner window; see MinerWindow.StyleButton. */
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
            border.SetBinding(Border.PaddingProperty, new System.Windows.Data.Binding("Padding") { RelativeSource = System.Windows.Data.RelativeSource.TemplatedParent });

            var presenter = new FrameworkElementFactory(typeof(ContentPresenter));
            presenter.SetValue(ContentPresenter.HorizontalAlignmentProperty, HorizontalAlignment.Center);
            presenter.SetValue(ContentPresenter.VerticalAlignmentProperty, VerticalAlignment.Center);
            presenter.SetValue(ContentPresenter.MarginProperty, new Thickness(10, 0, 10, 0));
            border.AppendChild(presenter);

            var t = new ControlTemplate(typeof(Button)) { VisualTree = border };
            // A disabled button must look disabled, or "Send..." reads as
            // broken while the node is still starting.
            var dim = new Trigger { Property = UIElement.IsEnabledProperty, Value = false };
            dim.Setters.Add(new Setter(UIElement.OpacityProperty, 0.45));
            t.Triggers.Add(dim);
            b.Template = t;
            b.Tag = "styled";
        }
    }
}
