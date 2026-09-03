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
seedprompt=declined    set if the user was offered a phrase and said no
fastmode=1             RandomX fast mode; cleared automatically if the node will not start with it
```

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
