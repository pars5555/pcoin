# PCoin miner tray app (Windows)

A small notification-area application that runs a PCoin full node and lets the
person using the PC see and control mining at a glance.

It exists because mining on a machine somebody else uses should never be hidden.
The icon is always visible while it runs, the tooltip shows the current hash
rate, and stopping mining takes two clicks.

## What it does

- Starts `bitcoind.exe` (hidden) if it is not already running, and waits for RPC
- Creates a wallet and a payout address on first run, then remembers it
- Shows live status: hash rate, blockchain height, blocks mined by this PC
- Lets the user pick **Not mining / 2 cores / 4 cores / all cores** at any time
- Remembers the chosen mode and resumes it on next launch
- "What is this?" explains in plain language what the machine is doing

## Building

Requires nothing beyond a stock Windows install — it compiles against the
.NET Framework 4.x that is already present, using the in-box C# compiler:

```
build.bat
```

That produces `PCoinTray.exe` (about 15 KB). Put it in the same folder as
`bitcoind.exe` and `bitcoin-cli.exe`.

## Configuration

Settings live in `pcoin-tray.cfg` next to the executable, written automatically:

```
address=pc1q...        payout address (created on first run if empty)
datadir=               optional; blank means bitcoind's default location
threads=4              0 = not mining
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
