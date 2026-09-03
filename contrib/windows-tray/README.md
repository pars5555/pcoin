# PCoin miner tray app (Windows)

A small notification-area application that runs a PCoin full node and lets the
person using the PC see and control mining at a glance.

It exists because mining on a machine somebody else uses should never be hidden.
The icon is always visible while it runs, the tooltip shows the current hash
rate, and stopping mining takes two clicks.

## What it does

- Starts `bitcoind.exe` (hidden) if it is not already running, and waits for RPC
- Creates a wallet and a payout address on first run, then remembers it
- Offers a **12-word recovery phrase**, and can restore a wallet from one
- Opens a **main window** with live statistics — double-click the icon
- Shows live status: hash rate, blockchain height, blocks mined by this PC
- Shows what is backed up by the phrase and what is still in the old wallet
- Lets the user pick a mining effort from 10% to 100% of the machine, or none
- Lets the user mine **solo or for the pool** (`pool.pc.am:3333`), and advises
  which of the two suits this machine's hash rate
- Can **forward** what this PC mines to another wallet — set from "Forward my
  coins…", and armed only after a 1 PCN test payment the operator confirms
- Remembers the chosen mode and resumes it on next launch
- "What is this?" explains in plain language what the machine is doing

## The main window

The Windows counterpart of the Android app's home screen: hash rate with an
hour of history, chain height, peers, blocks mined (accepted shares when it is
pooled), difficulty, the solo/pool selector, the forwarding state, both wallet
balances, the payout address, and the effort slider. Double-click the tray icon
or pick "Open PCoin Miner".

It is WPF, built in code rather than XAML so the app still compiles with the
in-box `csc.exe`, and it runs on the WinForms message loop the tray icon already
pumps. Closing it only hides it — the window is a view of the miner, never its
lifetime. Mining keeps running.

Being open costs almost nothing, which is deliberate for something that sits on
a machine for months:

- the graph holds 240 fifteen-second buckets, not 3600 samples, so an hour of
  history redraws in about a pixel per point;
- the window polls once a second, but only for the hash rate, over the loopback
  HTTP RPC — one small call. Height, peers and difficulty refresh every five
  seconds, and the node's process vitals every fifteen;
- **with the window closed it polls every three seconds**, exactly as it did
  before the window existed. History keeps accumulating either way, so opening
  it shows the hour that just passed rather than an empty graph.

## Which session it runs in

**The app refuses to start in session 0 and writes the reason to
`pcoin-tray.log`.** Windows isolates services, and anything they launch, into
session 0 — which has no desktop and no notification area. A tray app started
there mines perfectly and is completely invisible to the person at the keyboard.
Two of three machines ended up in exactly that state after a remote deployment,
with no icon and no way to tell mining was running.

Deploy scripts must therefore launch it in the interactive session. `install.ps1`
does this itself; anything else running from a service context should use a
one-shot interactive scheduled task:

```
schtasks /create /tn PCoinTrayLaunch /tr C:\PCoin\PCoinTray.exe /sc once /st 23:59 /ru <user> /it /f
schtasks /run    /tn PCoinTrayLaunch
schtasks /delete /tn PCoinTrayLaunch /f
```

The single-instance mutex is scoped to the session, so it does not stop a
session-0 copy from coexisting with a visible one. The refusal above is what
does. Note that a session-0 copy left over from **before** this change runs as
SYSTEM and cannot be stopped without administrator rights — kill it from an
elevated prompt or reboot, and it will not come back.

## Recovery phrase

Without a phrase, a wallet is a file: reinstall Windows and the coins are gone.
The tray app can generate twelve BIP39 words, show them once for the user to
write down, make them confirm three of them, and build a wallet from them on the
node. The scheme, the derivation path and the test vectors are documented in
[`PCOIN.md`](../../PCOIN.md#6-wallet-recovery-phrase-and-key-derivation) so any
other wallet can restore the same coins.

Things worth knowing:

- **The phrase-backed wallet is added, never substituted.** It is created under
  the name `pcoin-hd` beside whatever wallet the machine already had. No
  existing wallet is renamed, unloaded, altered or deleted, no coins are moved,
  and nothing is broadcast. Mining rewards are redirected to the new wallet from
  that point on, so the amount that has no phrase stops growing.
- **Older coins stay where they are.** They remain spendable from the old wallet
  and still need its `wallet.dat` backup. Moving them is a separate, manual
  decision — and on this chain it cannot be done in one transaction anyway,
  because coinbase output needs 100 confirmations to mature.
- **The words are the backup.** The copy stored on the PC (`pcoin-seed.dat`,
  encrypted with DPAPI for that Windows account) exists only so the menu can
  show them again. It does not survive a reinstall, a different Windows account,
  or a dead disk. The paper does.
- There is deliberately **no "copy phrase" button**, the phrase windows are
  excluded from screen capture, and viewing the phrase asks for the Windows
  sign-in first.
- The key material never touches a command line: `getdescriptorinfo` and
  `importdescriptors` go over the loopback HTTP RPC socket, because a command
  line is visible in the Windows process list.

## Building

Requires nothing beyond a stock Windows install — it compiles against the
.NET Framework 4.x that is already present, using the in-box C# compiler:

```
build.bat
```

That produces `PCoinTray.exe`. Put it in the same folder as `bitcoind.exe` and
`bitcoin-cli.exe`.

Because there is no package manager in this build, BIP39, BIP32, secp256k1,
Base58 and Bech32 are all implemented in `Seed*.cs` from scratch. **Run the
self-test after touching any of them** — it checks the derivation against the
published BIP32, BIP39 and BIP84 vectors, which were produced by other
implementations:

```
PCoinTray.exe --selftest
```

It prints a line per check, writes `pcoin-selftest.txt`, and exits non-zero on
any failure. It also prints the PCoin test vectors that `PCOIN.md` publishes.

## Configuration

Settings live in `pcoin-tray.cfg` next to the executable, written automatically:

```
address=pc1q...        payout address (created on first run if empty)
addresswallet=pcoin-hd which wallet that address belongs to
poolurl=pool.pc.am:3333 mine for this pool; blank means solo
datadir=               optional; blank means bitcoind's default location
percent=50             0 = not mining
optimal=4              thread count the calibration measured as fastest (0 = not measured)
hashrate=2517.6        H/s the calibration measured at that count (blank = never measured)
seedprompt=declined    set if the user was offered a phrase and said no
soloprompt=asked       set once the solo-vs-pool question has been put to this machine
fastmode=1             RandomX fast mode; cleared automatically if the node will not start with it
```

`install.ps1` rewrites this file wholesale on every upgrade, so it carries every
key it does not own across by hand. `hashrate` and `soloprompt` are in that list:
losing the first costs a re-tune, and losing the second re-asks a question whose
answer the owner already gave.

## Solo or pool

The window always shows a recommendation, and the app never acts on it -- the
mode changes only when someone clicks. The arithmetic behind it is
`Cpu.SoloDaysPerBlock`: `difficulty x 2^32 / your_H/s / 86400`, which is exact
given `nBits` and needs no network hash rate at all. (The whole-network figure
from `getmininginfo` survives only as a fallback for the case where
`getblockchaininfo` did not answer; it assumes 600 s spacing, which this chain
routinely is not at.) A hash rate or a difficulty that could not be read yields
0 days, which every caller treats as *not known* -- never as *no wait*.

Once per install, when auto-tuning has just measured a machine at
`Cpu.SOLO_MIN_HPS` (3,000 H/s) or better **and** the exact arithmetic puts it
within `Cpu.SOLO_DAYS_MAX` (2 days) of a block, the tray offers solo mining once
and remembers the answer, whichever it was. Both gates must pass: the floor is
what keeps a laptop out of a mode where a month with nothing is a real
possibility, and the days figure is what keeps a fast machine out of it when
difficulty has climbed.

That offer exists because a pool finding most of the network's blocks could
reorganise the chain, and machines big enough to mine alone are the ones paying
a pool fee for variance reduction they do not need. Three rules bound it, and
none of them may be relaxed:

- new installs still default to the pool (`install.ps1`), and an existing
  install keeps whatever it already had. There is no third state --
  `StartMining` reads a blank `poolurl` as SOLO, so writing "undecided" there
  would silently move every new install, laptops included.
- the app never switches mode on its own, and never mentions solo to a machine
  below the floor.
- nothing depends on the dialog being answered, or seen. This app can be
  started into session 0 with no desktop (see above), and an unanswered offer
  leaves the machine exactly as installed.

Two more files appear next to it once a recovery phrase exists. Neither is ever
committed, and `install.ps1` does not overwrite them:

```
pcoin-seed.dat         the phrase, encrypted for this Windows account
pcoin-seed.info        wallet name, first address, path - no secrets
```

To have it start with Windows, put a shortcut to `PCoinTray.exe` in
`shell:startup`.

## Notes

- `-daemon` does not exist on Windows, so the node is launched as a hidden
  child process and polled until its RPC responds.
- The app only shuts the node down on exit if it was the one that started it.
  A node that was already running is left alone.
- Memory is dominated by RandomX's 256 MB light-mode cache, which is shared by
  all mining threads — so the core count barely affects memory use. Expect
  roughly 300-350 MB total for node plus miner.
- The binaries are not code-signed, so SmartScreen will warn on first run.

## PCoin Wallet (`PCoinWallet.exe`)

A second program built from the same source tree: the Windows counterpart of
the Android wallet app. Create or restore twelve words, receive to a QR code,
send with the real fee shown before anything is broadcast, scroll the history,
keep an address book. **It does not mine**, and it is **completely separate
from the miner tray at runtime** - the two can be installed on one PC and
neither knows the other exists:

| | miner tray | wallet |
|---|---|---|
| exe | `PCoinTray.exe` | `PCoinWallet.exe` |
| install folder | `C:\PCoin` | `C:\PCoinWallet` |
| node | its own `bitcoind.exe`, `C:\PCoin\data` | its own `bitcoind.exe`, `C:\PCoinWallet\data` |
| RPC port | 9443 | **9543** |
| P2P | listens on 9444 | `listen=0` - outbound only, never binds 9444 |
| phrase file | `C:\PCoin\pcoin-seed.dat` | `C:\PCoinWallet\pcoin-seed.dat` |
| single-instance mutex | `Global\PCoinTraySingleInstance` | `Global\PCoinWalletSingleInstance` |
| log | `pcoin-tray.log` | `pcoin-wallet.log` |
| installer | `install.ps1` | `install-wallet.ps1` |
| uninstaller | `uninstall.ps1` | `uninstall-wallet.ps1` |

The wallet never looks for "a bitcoind process". It asks its own port, and if
nothing answers it starts its own node on its own data folder; if that node
exits at once (another copy of the wallet still holds the data-folder lock) it
waits for that one instead of claiming it. The miner's node can therefore
never be adopted or stopped by the wallet, and vice versa. Verified on a PC
running both: the wallet was installed, used and uninstalled while the tray
kept mining on 9443 throughout.

### Build

```cmd
cd contrib\windows-tray
build-wallet.bat
PCoinWallet.exe --selftest
```

Same in-box `csc.exe`, no NuGet. `build-wallet.bat` compiles the shared files
(`Seed*.cs`, `Forward*.cs`, `Amounts.cs`, `AddressBook*.cs`, `QrCode.cs`,
`SeedSelfTest.cs`) plus `PCoinWallet.cs`, `WalletWindow.cs` and
`WalletForms.cs`, and leaves out the tray's `PCoinTray.cs`, `MinerWindow.cs`,
`ForwardForms.cs` and `FleetProvision.cs`. `build.bat` (the tray) also compiles
the four new shared files, so `PCoinTray.exe --selftest` covers them too.

### What the shared code gives it, and what is new

Everything that touches money is shared with the tray and was already proven
on the live chain: derivation (`SeedKeys.cs`), the DPAPI phrase file
(`SeedStore.cs`), the node-side wallet setup with its cross-check that the
node derives the same first address (`SeedWallet.cs`), the RPC client, and the
build / decode / verify / broadcast engine (`ForwardEngine.cs`). New, and each
a 1:1 port of the Android file of the same name, pinned by the same test
vectors under `--selftest`:

* `Amounts.cs` - decimal text to satoshis, never through a double.
* `ForwardPolicy.FeeTier` / `MaxFeeSatFor` / `VerifyUserSend` - the three fee
  tiers (Normal 1, Fast 5, Very fast 20 sat/vB) and the assertions run on the
  DECODED transaction before it is shown: pays the address entered, the
  amount asked for, change comes back to a change descriptor of this wallet,
  fee positive and under the tier's ceiling.
* `ForwardEngine.PrepareSend` / `BroadcastPrepared` / `ListHistoryPage` -
  inspect-then-commit: build with `add_to_wallet=false`, read every input with
  `gettxout`, show the real fee; broadcast re-sends the same hex and never
  rebuilds; history pages by `listtransactions`' own `skip`, and only an empty
  node page ends the list.
* `AddressBook.cs` + `AddressBookStore.cs` - names kept locally in
  `pcoin-addressbook.json` (same JSON as Android, so a file exported from one
  imports into the other), bech32 keys folded case-insensitively, base58 never.
* `QrCode.cs` - a byte-mode, ECC-M QR encoder checked module-for-module
  (unmasked) against the Python `qrcode` vectors the Android app uses.

### Testing without real coins

The wallet runs against whatever chain its data folder's `pcoin.conf` says. A
regtest sandbox, entirely self-contained:

```
pcoin-wallet.cfg          datadir=<folder>\data
<folder>\data\pcoin.conf  regtest=1
                          rpcuser=sandbox
                          rpcpassword=sandbox
                          [regtest]
                          rpcport=9543
                          listen=0
                          fallbackfee=0.00001
                          changetype=bech32
```

Restore the standard BIP39 test phrase, then
`bitcoin-cli -datadir=<folder>\data -regtest generatetoaddress 101 <address>`
funds it. That is the recipe the end-to-end smoke test used (restore, receive,
send 1.5 PCN at the Fast tier, confirm, address book, history), driven through
UI Automation on a fleet PC that also runs the miner.

### Uninstalling

Settings > Apps > PCoin Wallet > Uninstall runs `uninstall-wallet.ps1`. It
stops only the wallet's own node (through its own data folder, never
`Stop-Process bitcoind`), copies `pcoin-seed.dat`, `pcoin-seed.info`,
`pcoin-addressbook.json`, `pcoin-wallet.cfg` and the node's `wallets\` to
`%USERPROFILE%\PCoinWallet-backup-<stamp>` and verifies the copy before
deleting anything. `-Purge` deletes the wallet files too and refuses without
`-Yes`.
