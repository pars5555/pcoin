# PCoin Windows installer.
#
# Installs the node, CLI and miner tray app, configures them, and starts the
# tray app in the current desktop session.
#
# The published one-liner is the shortest thing that actually works:
#
#   irm https://pc.am/dl/install.ps1 | iex
#
# `irm` on its own only DOWNLOADS the script -- PowerShell has no way to run a
# remote script without piping it somewhere, so `| iex` is the floor, and that
# pipeline cannot carry arguments. Everything a normal install needs must
# therefore be the DEFAULT: mining is on unless -NoMine, and SOLO is chosen
# unless -Pool. The older form still works and still takes switches, which
# matters because copies of it are already published:
#
#   & ([scriptblock]::Create((irm https://pc.am/dl/install.ps1))) -Mine
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Threads 4
#
# Mining starts immediately, and with solo as the default that is safe only
# because the tray REFUSES to solo-mine until the chain is current: three
# consecutive full polls saying so, re-checked every tick. Do not remove that
# gate. A fresh solo install once began at height 16 of 6,806 and found three
# blocks on its own fork before the first chain read landed, which is why the
# check treats "we have not looked yet" as unsafe rather than as "not syncing".

param(
    [int]$Threads = 0,
    # C:\PCoin when it already exists or we can create it; otherwise a
    # per-user location, because creating a folder at the root of C: needs
    # administrator rights and a one-liner that demands elevation is a one-liner
    # most people will not run.
    [string]$InstallDir = '',
    [string]$DataDir = '',
    # Bump both together on a WINDOWS release. $Version also selects the release
    # tag the zip is fetched from, so the URL and the hash move as one and a
    # half-applied bump is impossible. The hash is of pcoin-win64-miner.zip
    # and the install aborts on a mismatch, so a forgotten bump here breaks
    # every new install rather than failing quietly.
    [string]$Version = '1.4.27',
    [string]$Sha256 = 'f1d46934b6f70e4e9f271ba1af0fe6e78dee8fcee34f7e672b867600a76944a6',
    # All three seeds, not just one. The node also carries them compiled in as
    # of v1.2.1, so this is belt and braces rather than the only route in.
    [string[]]$AddNode = @('35.239.156.16:9444', '178.105.3.51:9444', '152.53.171.190:9444'),
    [switch]$NoStart,
    # Set by the elevated relaunch so it cannot ask again and loop.
    [switch]$NoElevate,
    # Install from a local zip instead of downloading the release (offline /
    # testing a build before it is published). Its SHA-256 is still verified
    # against $Sha256, so a stale local file is caught exactly like a bad download.
    [string]$ZipPath = '',
    # Do NOT migrate-and-remove a previous install found in a different folder.
    # The default (single install) is what you want in production; this is for
    # testing a build side-by-side without disturbing an existing install.
    [switch]$NoCleanup,
    # Accepted and ignored: mining is the default now, so this switch has
    # nothing left to turn on. It stays because the previous published one-liner
    # passed it and copies of that command are saved in people's notes, in this
    # repo's docs and in the fleet scripts -- dropping the parameter would turn
    # every one of them into "a parameter cannot be found that matches -Mine".
    [switch]$Mine,
    # Install the node and wallet without starting the miner.
    [switch]$NoMine,
    # Re-download and re-extract even when this exact version is already installed.
    # Without it the install skips the 9 MB download when C:\PCoin already holds
    # this $Version, and only re-applies config / restarts the tray.
    [switch]$Force,
    # Mine for the POOL instead of the default solo. The pool pays a small
    # steady share of every block it finds; solo pays the whole 50 PCN when THIS
    # machine finds one. Solo is the default as of v1.4.11 -- see the reasoning
    # where $poolUrl is set. You can switch either way later from the tray's
    # Mining-mode panel, and the tray tells you which suits your hash rate.
    [switch]$Pool,
    # Accepted and now redundant: solo is the default. It stays because the
    # published one-liner carrying it is in people's notes and in this repo's
    # docs, and dropping the parameter would turn every copy into "a parameter
    # cannot be found that matches -Solo".
    [switch]$Solo
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir) {
    $InstallDir = 'C:\PCoin'
    if (-not (Test-Path $InstallDir)) {
        try {
            New-Item -ItemType Directory -Path $InstallDir -Force -ErrorAction Stop | Out-Null
        } catch {
            $InstallDir = Join-Path $env:LOCALAPPDATA 'PCoin'
            Write-Output "  C:\PCoin needs admin; installing to $InstallDir instead"
        }
    }
}
# Pinned to the tag $Version names, NOT /releases/latest/. Components ship
# separately now, so "latest" is whatever released last -- an Android-only
# release has no Windows asset and this would 404 for everyone. A stale pin
# serves the previous working miner instead, which is the failure worth having.
# It also makes $Version drive both the URL and which $Sha256 is correct, so the
# two can no longer disagree.
$name = "pcoin-win64-miner.zip"
$url = "https://github.com/pars5555/pcoin/releases/download/v$Version/$name"

# Keep the data directory beside the program by default. Remote management
# tools often launch with a service's environment block, so %LOCALAPPDATA% can
# point at system32\config\systemprofile instead of the real user - an explicit
# path makes the install identical on every machine.
if (-not $DataDir) { $DataDir = Join-Path $InstallDir 'data' }

Write-Output "PCoin $Version installer"

$script:IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

New-Item -ItemType Directory -Force $InstallDir | Out-Null

# Stop anything already running from this folder, otherwise the copy fails
# with a sharing violation. The tray app re-launches bitcoin-cli every few
# seconds, so it has to go first and be given time to die before the node.
# WAIT FOR THE PROCESS TO ACTUALLY BE GONE, don't sleep a guess.
# Stop-Process -Force is asynchronous: it returns before Windows has torn the
# process down and released its file handles. The fixed sleeps here were a
# guess at how long that takes, and on 2026-09-12 the guess was wrong -- a node
# that had just caught up 456 blocks was still flushing, held bitcoind.exe, and
# every one of the six copy retries below hit a sharing violation. The install
# aborted having already verified the download, leaving the machine on the old
# version with its tray stopped.
function Wait-Gone {
    param([string[]]$Names, [int]$Seconds = 90)
    for ($i = 0; $i -lt $Seconds; $i++) {
        $live = @(Get-Process -Name $Names -ErrorAction SilentlyContinue)
        if ($live.Count -eq 0) { return $true }
        Start-Sleep -Seconds 1
    }
    return $false
}

Get-Process PCoinTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Wait-Gone -Names 'PCoinTray' -Seconds 30 | Out-Null
Get-Process bitcoin-cli -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# A previous install may have used a different datadir, so a targeted
# 'bitcoin-cli stop' can miss. Ask nicely, then insist.
$cliPath = Join-Path $InstallDir 'bitcoin-cli.exe'
if (Test-Path $cliPath) {
    try { & $cliPath stop 2>&1 | Out-Null } catch { }
    try { & $cliPath -datadir="$DataDir" stop 2>&1 | Out-Null } catch { }
    # A clean shutdown flushes the chainstate; on a node that has just synced a
    # few hundred blocks that is tens of seconds, not eight.
    Wait-Gone -Names 'bitcoind' -Seconds 90 | Out-Null
}
Get-Process bitcoind -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
if (-not (Wait-Gone -Names 'bitcoind','PCoinTray','bitcoin-cli' -Seconds 60)) {
    Write-Output '  warning: something is still holding the install folder; the copy may retry'
}

# --- exactly one install, wherever it was -------------------------------
# Every bitcoind / PCoinTray / bitcoin-cli was just stopped BY NAME above, so no
# instance from any folder or session survives. Now make sure only ONE install
# DIRECTORY remains: if a previous copy sits somewhere other than where we are
# installing (admin C:\PCoin vs non-admin %LOCALAPPDATA%\PCoin, or a hand-picked
# -InstallDir), migrate its recovery seed and its data directory so nothing is
# lost or re-synced, then delete it. Its autostart is torn down below regardless,
# so two tray icons can never come back at the next logon.
$normNew = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$oldDirs = New-Object System.Collections.Generic.HashSet[string]([StringComparer]::OrdinalIgnoreCase)
if (-not $NoCleanup) {
foreach ($cand in @('C:\PCoin', (Join-Path $env:LOCALAPPDATA 'PCoin'))) {
    if (Test-Path (Join-Path $cand 'PCoinTray.exe')) {
        $n = [IO.Path]::GetFullPath($cand).TrimEnd('\')
        if ($n -ne $normNew) { [void]$oldDirs.Add($n) }
    }
}
try {
    $act = (Get-ScheduledTask -TaskName PCoinMiner -ErrorAction SilentlyContinue).Actions.Execute
    if ($act) {
        $d = Split-Path ($act.Trim('"')) -Parent
        if ($d -and (Test-Path (Join-Path $d 'PCoinTray.exe'))) {
            $n = [IO.Path]::GetFullPath($d).TrimEnd('\')
            if ($n -ne $normNew) { [void]$oldDirs.Add($n) }
        }
    }
} catch { }
foreach ($old in $oldDirs) {
    Write-Output "  previous install found at $old -- migrating and removing it"
    $oldSeed = Join-Path $old 'pcoin-seed.dat'
    $newSeed = Join-Path $InstallDir 'pcoin-seed.dat'
    if ((Test-Path $oldSeed) -and -not (Test-Path $newSeed)) {
        try { Copy-Item $oldSeed $newSeed -Force -ErrorAction Stop; Write-Output '    migrated your recovery seed' }
        catch { Write-Output ('    WARNING could not migrate the seed: ' + $_.Exception.Message + ' -- keep ' + $oldSeed) }
    }
    $oldData = Join-Path $old 'data'
    if ((Test-Path $oldData) -and -not (Test-Path $DataDir)) {
        try { Move-Item $oldData $DataDir -Force -ErrorAction Stop; Write-Output '    moved the data directory (no re-sync)' }
        catch {
            # NOT just a re-sync. This folder can hold wallet.dat, and the
            # rescue below is what stands between a failed move and a deleted
            # key. Say the expensive half out loud -- the old wording named
            # only the cheap one, which is how a wallet delete gets reported as
            # a benign inconvenience.
            Write-Output ('    could not move the data dir (' + $_.Exception.Message + ')')
            Write-Output '    the node will re-sync, and any wallet in there is rescued below'
        }
    }

    # --- RESCUE ANYTHING THAT DID NOT MIGRATE, BEFORE DELETING ANYTHING ------
    #
    # Both migrations above are CONDITIONAL: the seed moves only if the
    # destination has none, and the data folder moves only if the destination
    # does not exist. The delete underneath them was not conditional on
    # anything. So a machine with two installs, each holding its own seed and
    # its own wallet.dat, would migrate NEITHER and then remove the old folder
    # outright -- and for a miner whose owner never wrote down a recovery
    # phrase, which is the default state, that file IS the coins.
    #
    # uninstall.ps1 grew exactly this rescue after it deleted a wallet in the
    # field. The installer, one file away, never got it. Copy, never move; check
    # the copy is non-empty BEFORE any delete; and if anything was found, KEEP
    # the old folder and print where the copy went. An install that leaves a
    # stale directory behind is a small annoyance. The other outcome is not.
    $leftBehind = @()
    $oldSeedStill = Join-Path $old 'pcoin-seed.dat'
    if (Test-Path $oldSeedStill) { $leftBehind += $oldSeedStill }
    $oldCfg = Join-Path $old 'pcoin-tray.cfg'
    if (Test-Path $oldCfg) { $leftBehind += $oldCfg }
    # Where the node keeps the wallet is NOT fixed: Core uses <datadir>\wallets\
    # only when that folder already existed at first start, so on a fresh
    # install each wallet sits directly at data\<name>\wallet.dat. Guessing one
    # path is what cost uninstall.ps1 its whole purpose once. Take every wallet
    # wherever it is.
    if (Test-Path $oldData) {
        foreach ($d in (Get-ChildItem $oldData -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path (Join-Path $d.FullName 'wallet.dat')) { $leftBehind += $d.FullName }
        }
        foreach ($w in (Get-ChildItem (Join-Path $oldData 'wallets') -Directory -ErrorAction SilentlyContinue)) {
            if (Test-Path (Join-Path $w.FullName 'wallet.dat')) { $leftBehind += $w.FullName }
        }
    }

    if ($leftBehind.Count -gt 0) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $dest = Join-Path $env:USERPROFILE "PCoin-wallet-backup-$stamp"
        $saved = $false
        try {
            New-Item -ItemType Directory -Path $dest -Force -ErrorAction Stop | Out-Null
            foreach ($item in $leftBehind) { Copy-Item $item -Destination $dest -Recurse -Force -ErrorAction Stop }
            # Count AFTER copying, so the message can only claim a rescue that
            # actually happened.
            $n = @(Get-ChildItem $dest -Recurse -File -ErrorAction SilentlyContinue).Count
            if ($n -lt 1) { throw 'the copy is empty' }
            $saved = $true
        } catch {
            Write-Output ('    WARNING could not copy them out: ' + $_.Exception.Message)
        }
        Write-Output ''
        if ($saved) {
            Write-Output "    KEY MATERIAL WAS LEFT IN THE OLD INSTALL AND HAS BEEN COPIED TO:"
            Write-Output "      $dest"
        } else {
            Write-Output '    KEY MATERIAL IS STILL IN THE OLD INSTALL AND COULD NOT BE COPIED OUT.'
        }
        Write-Output "    $old has NOT been removed. Check the copy, then delete it yourself."
        Write-Output ''
        continue
    }

    try { Remove-Item $old -Recurse -Force -ErrorAction Stop; Write-Output "    removed $old" }
    catch { Write-Output ('    could not fully remove ' + $old + ' (' + $_.Exception.Message + ') -- delete it by hand') }
}
# Tear down any stale autostart so the new one (created below) is the only one.
# schtasks /delete on a task that does not exist writes to stderr, which
# PowerShell 5.1 wraps in a NativeCommandError and THROWS under ErrorAction Stop
# (2>$null does not stop it). Delete only when the task actually exists, and
# swallow anything anyway.
# THE TASK IS NO LONGER TORN DOWN HERE, and that is the fix for a real
# incident. It used to be deleted at this line and recreated ~500 lines later,
# after the download, hash check, copy, config, Defender exclusions, firewall
# and shortcuts. Anything that interrupted the install in that window -- a
# dropped connection, a failed download, antivirus, a reboot -- left the
# machine with NO autostart task and no message saying so.
#
# That happened on fleet PC DESKTOP-AKHQ7BJ on 2026-09-10. The install
# self-elevated (silently, because that box sets ConsentPromptBehaviorAdmin=0),
# the elevated child deleted the task here, copied the new build, and was then
# cut off before recreating it. What was left was the task's XML file gone and
# its TaskCache\Tree registry entry orphaned, so schtasks answered "cannot find
# the file specified" and even an administrator could not recreate it by name.
#
# The delete was redundant anyway: the create below passes /f, which replaces
# an existing task. Turning autostart OFF still removes it -- that now happens
# in the autostart section, next to the shortcut removal it belongs with.
foreach ($sd in @([Environment]::GetFolderPath('Startup'), (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'))) {
    if ($sd) { $stale = Join-Path $sd 'PCoinTray.lnk'; if (Test-Path $stale) { Remove-Item $stale -Force -ErrorAction SilentlyContinue } }
}
} # end if (-not $NoCleanup)

# --- download and verify -------------------------------------------------
$zip = Join-Path $env:TEMP $name
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

# Elevate straight to a UAC prompt -- the UAC dialog IS the yes/no, so a separate
# Read-Host before it was pure friction. Declining UAC (or no interactive desktop)
# drops through to an unelevated install, which still mines. Everything essential
# works without admin; elevation only ADDS the Defender exclusion, firewall rule,
# logon autostart and C:\PCoin. -NoElevate keeps it non-interactive for scripts.
if (-not $script:IsAdmin -and -not $NoElevate) {
    Write-Output ''
    Write-Output '  Elevating for the full install (Defender exclusion, firewall rule,'
    Write-Output '  logon autostart, C:\PCoin). Approve the UAC prompt -- or decline it'
    Write-Output '  to install unelevated (mining still works).'
    # No -NoExit: the elevated window closes when the install finishes and leaves
    # only the tray app running. It lingers 10 s ONLY on an error.
    $extra = ''
    if ($NoMine) { $extra = $extra + ' -NoMine' }
    if ($Force) { $extra = $extra + ' -Force' }
    if ($Solo) { $extra = $extra + ' -Solo' }
    if ($Pool) { $extra = $extra + ' -Pool' }
    # Pass -Threads ONLY when it was actually given. Passing it unconditionally
    # sent a bare "-Threads 0" to the elevated child, where it is
    # indistinguishable from someone typing it -- so the child read 0 as an
    # instruction and skipped the "keep the existing thread count" branch the
    # unelevated parent had just honoured.
    if ($PSBoundParameters.ContainsKey('Threads')) { $extra = $extra + " -Threads $Threads" }
    $inner = "try { & ([scriptblock]::Create((irm https://pc.am/dl/install.ps1))) -NoElevate$extra } catch { Write-Host `$_.Exception.Message -ForegroundColor Red; Start-Sleep 10 }"
    try {
        Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$inner
        Write-Output '  Continuing in the elevated window. You can close this one.'
        return
    } catch {
        # UAC declined, or no interactive desktop. Carry on unelevated --
        # refusing here would leave the machine with nothing installed.
        Write-Output '  Elevation declined; continuing without it.'
    }
    Write-Output ''
}
# Same-version skip: don't re-download the 9 MB zip when this exact $Version is
# already installed. -Force overrides; -ZipPath (local/testing) always installs.
$verFile = Join-Path $InstallDir '.pcoin_version'
$sameVer = (-not $ZipPath) -and (-not $Force) -and (Test-Path $verFile) -and `
    ((Get-Content $verFile -ErrorAction SilentlyContinue) -eq $Version) -and `
    (Test-Path (Join-Path $InstallDir 'bitcoind.exe')) -and `
    (Test-Path (Join-Path $InstallDir 'PCoinTray.exe'))
if ($sameVer) {
    Write-Output "  already at v$Version -- skipping download (use -Force to reinstall)"
} else {
if ($ZipPath) {
    if (-not (Test-Path $ZipPath)) { throw "ZipPath not found: $ZipPath" }
    Write-Output "  using local zip: $ZipPath"
    Copy-Item -LiteralPath $ZipPath -Destination $zip -Force
} else {
    Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
}
$got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
if ($Sha256 -and $got -ne $Sha256.ToLower()) { throw "SHA256 mismatch: got $got" }
Write-Output "  sha256 ok"

$tmp = Join-Path $env:TEMP 'pcoin-unpack'
if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
Expand-Archive -Path $zip -DestinationPath $tmp -Force

# The release archive lays the binaries out as pcoin-<ver>\bin\*.exe, but every
# line below this one -- and the tray app, and the scheduled task -- expects
# them directly in $InstallDir. Copying the tree verbatim buried them one level
# down and produced an install that looked complete and could not start a node.
# So find bitcoind.exe wherever it is and flatten from there, which also copes
# with a flat archive if the layout ever changes back.
$src = Get-ChildItem -Path $tmp -Filter 'bitcoind.exe' -Recurse -File |
       Select-Object -First 1
if (-not $src) { throw "bitcoind.exe not found in $name -- archive layout unexpected" }
$srcDir = $src.DirectoryName

# A file can stay locked briefly after its process exits, so retry rather than
# aborting a half-finished install.
foreach ($attempt in 1..6) {
    try {
        Copy-Item (Join-Path $srcDir '*') $InstallDir -Force -Recurse
        # COPYING sits beside the bin\ directory, not inside it.
        Get-ChildItem -Path $tmp -Filter 'COPYING' -Recurse -File |
            ForEach-Object { Copy-Item $_.FullName $InstallDir -Force }
        # PCoinTray.exe may sit ABOVE the node binaries rather than beside them:
        # the zip is being restructured so only the miner is at the root and
        # bitcoind/bitcoin-cli move into bin\, because four exes in one folder
        # gave no clue which to run. Flattening from $srcDir alone would then
        # leave the tray behind and trip the 'PCoinTray.exe is missing' check
        # below. Sweep for it wherever it is, so BOTH the old flat archive and
        # the new nested one install identically.
        Get-ChildItem -Path $tmp -Filter 'PCoinTray.exe' -Recurse -File |
            Select-Object -First 1 |
            ForEach-Object { Copy-Item $_.FullName $InstallDir -Force }
        Get-ChildItem -Path $tmp -Filter 'START HERE.txt' -Recurse -File |
            ForEach-Object { Copy-Item $_.FullName $InstallDir -Force }
        # uninstall.ps1, for the same reason and swept the same way. Until
        # v1.4.1 it was only ever picked up by accident: it happened to sit
        # beside bitcoind.exe in a flat archive, so the $srcDir copy above took
        # it. In the nested layout it sits one level ABOVE the node binaries and
        # that copy misses it entirely -- and the only symptom is one line of
        # output saying the Apps-list entry was skipped, on an install that
        # otherwise reports success. Sweeping for it makes both layouts install
        # identically, which is what the comment above already claims.
        Get-ChildItem -Path $tmp -Filter 'uninstall.ps1' -Recurse -File |
            Select-Object -First 1 |
            ForEach-Object { Copy-Item $_.FullName $InstallDir -Force }
        break
    } catch {
        if ($attempt -eq 6) { throw }
        Get-Process bitcoind, PCoinTray, bitcoin-cli -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        # Same reason as the stop block above: wait for the handle to go rather
        # than sleeping a fixed amount and hoping.
        Wait-Gone -Names 'bitcoind','PCoinTray','bitcoin-cli' -Seconds 30 | Out-Null
        Start-Sleep -Seconds 2
    }
}
Write-Output "  installed to $InstallDir"
Set-Content -Path $verFile -Value $Version -Encoding ascii
}

# --- node configuration --------------------------------------------------
New-Item -ItemType Directory -Force $DataDir | Out-Null
# fallbackfee: Core's default is 0 and PCoin has no fee history to estimate
# from, so without this EVERY send fails with "Fee estimation failed".
# changetype: a recovery-phrase wallet holds only wpkh descriptors, so change
# for a payment to a taproot address cannot be allocated without it.
# This file is rewritten on every install, so both belong here rather than
# being appended once and silently lost at the next upgrade.
$conf = @('server=1', 'listen=1', 'dbcache=300', 'maxconnections=40', 'par=2',
          'fallbackfee=0.00001', 'changetype=bech32')
foreach ($n in $AddNode) { $conf += "addnode=$n" }
$conf | Set-Content -Encoding ascii (Join-Path $DataDir 'pcoin.conf')
Write-Output "  data directory: $DataDir"

# The tray app must actually be here. Until v1.2.4 the release zip contained
# only bitcoind.exe, bitcoin-cli.exe and COPYING, so this script produced a node
# with no miner UI, a desktop shortcut pointing at a file that was never
# installed, and a scheduled task launching the same missing exe -- an install
# that reported success and could not mine. Fail loudly instead.
if (-not (Test-Path (Join-Path $InstallDir 'PCoinTray.exe'))) {
    throw ("PCoinTray.exe is missing from $name. This archive predates the tray " +
           "being bundled; use the Windows installer from https://pc.am, or a " +
           "release from v1.2.4 onward.")
}
Write-Output '  tray app present'

# Keep the payout address that is already configured. Blanking it would make
# the tray app hand out a fresh one on the next start, orphaning the address
# whoever runs this machine has already written down. pcoin-seed.dat and
# pcoin-seed.info are not touched at all - they hold the recovery phrase.
$trayCfg = Join-Path $InstallDir 'pcoin-tray.cfg'
$keep = @{}
if (Test-Path $trayCfg) {
    foreach ($line in (Get-Content $trayCfg)) {
        $eq = $line.IndexOf('=')
        if ($eq -gt 0) { $keep[$line.Substring(0, $eq).Trim()] = $line.Substring($eq + 1).Trim() }
    }
}
$addr = ''
if ($keep.ContainsKey('address')) { $addr = $keep['address'] }
$addrWallet = ''
if ($keep.ContainsKey('addresswallet')) { $addrWallet = $keep['addresswallet'] }
if ($addr) { Write-Output "  keeping existing payout address $addr" }

# Carry over every key the tray owns, not just the address.
#
# This rewrote the file wholesale and kept only two keys, so an upgrade silently
# discarded `seedprompt` -- bringing the recovery-phrase dialog back on a machine
# whose owner had already answered it -- and would have discarded `fastmode` the
# same way. The installer only has an opinion about datadir and threads; every
# other setting belongs to the user and must survive.
$seedPrompt = ''
if ($keep.ContainsKey('seedprompt')) { $seedPrompt = $keep['seedprompt'] }
$fastMode = '1'   # default ON for a NEW install; an upgrade keeps whatever is already set, just below
if ($keep.ContainsKey('fastmode')) { $fastMode = $keep['fastmode'] }

# Autostart is a USER CHOICE and an upgrade must not overturn it -- the same
# rule -Threads already carries a warning about further down. Someone who
# turned 'Start with Windows' off in the tray had, before this, to turn it
# off again after every upgrade, with nothing saying why it came back.
# Absent means ON, so existing installs are unchanged.
$autostart = '1'
if ($keep.ContainsKey('autostart')) { $autostart = $keep['autostart'] }
if ($autostart -eq '0') { Write-Output '  autostart stays OFF (your setting from the tray)' }
# What the tray has MEASURED about this machine, and the questions it has
# already put to its owner. `optimal` and `hashrate` are the result of an
# auto-tune that costs a couple of minutes of mining to redo; `soloprompt`
# records that the solo-vs-pool question has been asked and answered here.
# Dropping them is the same failure this block exists to stop for `seedprompt`:
# an upgrade that re-asks a person who has already decided.
$optimal = ''
if ($keep.ContainsKey('optimal')) { $optimal = $keep['optimal'] }
$hashrate = ''
if ($keep.ContainsKey('hashrate')) { $hashrate = $keep['hashrate'] }
$soloPrompt = ''
if ($keep.ContainsKey('soloprompt')) { $soloPrompt = $keep['soloprompt'] }
# Default a NEW install to SOLO. Changed 2026-09-10, on the owner's instruction,
# and the arithmetic had moved under the old default: at difficulty 0.0557 an
# ordinary 500 H/s desktop finds a block every 5.5 days, a 2,000 H/s machine
# every 1.4 days, and a measured fleet PC at 5,967 H/s finds about two a DAY.
# "Waiting days for a rare solo block" described a harder chain than this one.
#
# The real reason is not the payout though, it is concentration: our own pool
# mines ~71% of blocks, which is the single thing every exchange conversation
# dies on. A pool miner's blocks are attributed to the pool; a solo miner's are
# attributed to that miner. Defaulting to solo is the only lever we have that
# makes the chain measurably less ours without asking anybody to do anything.
#
# Safe because the tray refuses to solo-mine until the chain is current -- three
# consecutive full polls, re-checked every tick (SoloBlockedBySync). That guard
# exists because a fresh solo install once mined three blocks onto its own fork
# from height 16, so it is proven rather than assumed.
#
# An EXISTING install keeps whatever it already had: nobody is moved silently.
$poolUrl = ''
if ($keep.ContainsKey('poolurl')) { $poolUrl = $keep['poolurl'] }
if ($Pool) { $poolUrl = 'pool.pc.am:3333' }
if ($Solo) { $poolUrl = '' }
$percent = ''
if ($keep.ContainsKey('percent')) { $percent = $keep['percent'] }

# -Threads not passed means 'leave this machine as it is', NOT 'stop mining'.
#
# The parameter defaults to 0, and 0 means OFF: LoadConfig turns threads=0
# into _mining=false. So every upgrade that did not repeat -Threads silently
# stopped a machine that had been mining, and the one-liner published on
# pc.am does not include -Threads -- the advertised way to upgrade was also
# the way to stop earning. Only an EXPLICIT -Threads is an instruction.
$threadsOut = $Threads
if (-not $PSBoundParameters.ContainsKey('Threads') -and $keep.ContainsKey('threads')) {
  $threadsOut = $keep['threads']
  Write-Output "  keeping existing thread count ($threadsOut)"
}

# -Mine: ensure mining is ON. The exact count barely matters -- the tray's
# auto-calibration re-tunes it on start -- but it must be > 0, and BOTH threads=
# and percent= must agree, or the tray's percent line wins and cancels mining.
if (-not $NoMine) {
  if ($threadsOut -le 0) { $threadsOut = [Math]::Max(1, [int]([Environment]::ProcessorCount / 2)) }
  $percent = [int][Math]::Round($threadsOut * 100.0 / [Math]::Max(1, [Environment]::ProcessorCount))
  if ($percent -lt 1) { $percent = 50 }
  Write-Output "  mining ON (auto-calibration will tune the thread count on start)"
} else {
  Write-Output '  -NoMine: installed, not mining'
}

@("address=$addr",
  "addresswallet=$addrWallet",
  "datadir=$DataDir",
  "threads=$threadsOut",
  "seedprompt=$seedPrompt",
  "soloprompt=$soloPrompt",
  "fastmode=$fastMode",
  "poolurl=$poolUrl",
  "optimal=$optimal",
  "hashrate=$hashrate",
  # PERSIST THE AUTOSTART CHOICE. Reading $keep['autostart'] above and then
  # writing a config without it is worse than never having supported it: this
  # file rewrites the config WHOLESALE, so the key vanished on every upgrade,
  # the tray read "absent" as ON, saved autostart=1, and the NEXT upgrade
  # dutifully recreated the shortcut and the task. Autostart turned itself back
  # on after one upgrade and a restart -- the exact bug v1.4.11 was written to
  # prevent, and the same shape as the -Threads incident documented above.
  # Caught end-to-end on a real desktop 2026-09-10, not by reading the code.
  "autostart=$autostart",
  "percent=$percent") |
    Set-Content -Encoding ascii $trayCfg
if ($threadsOut -gt 0) { Write-Output "  configured to mine with $threadsOut cores" }
else { Write-Output '  configured; mining is OFF' }

# --- best-effort host tweaks (need admin; not fatal) ---------------------
try {
    Add-MpPreference -ExclusionPath $InstallDir, $DataDir -ErrorAction Stop
    Write-Output '  defender exclusions added'
} catch { Write-Output '  defender exclusions skipped (needs admin)' }

try {
    if (-not (Get-NetFirewallRule -DisplayName 'PCoin P2P 9444' -ErrorAction SilentlyContinue)) {
        New-NetFirewallRule -DisplayName 'PCoin P2P 9444' -Direction Inbound `
            -Protocol TCP -LocalPort 9444 -Action Allow -ErrorAction Stop | Out-Null
    }
    Write-Output '  firewall rule ok'
} catch { Write-Output '  firewall rule skipped (needs admin)' }

# --- autostart -----------------------------------------------------------
# GetFolderPath('Startup') comes back empty when this runs without a fully
# loaded user profile (e.g. from a service or an elevated remote session), so
# fall back to composing the path, and never let this step fail the install.
try {
    $tail = 'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup'
    # Prefer a path built from the actual account name: the environment block
    # may belong to a service rather than the logged-on user.
    $startup = ''
    if ($env:USERNAME) {
        $p = Join-Path (Join-Path $env:SystemDrive 'Users') (Join-Path $env:USERNAME $tail)
        if (Test-Path $p) { $startup = $p }
    }
    if (-not $startup) {
        $c = [Environment]::GetFolderPath('Startup')
        if ($c -and (Test-Path $c) -and $c -notmatch 'systemprofile') { $startup = $c }
    }
    if (-not $startup -and $env:APPDATA -and $env:APPDATA -notmatch 'systemprofile') {
        $p = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'
        if (Test-Path $p) { $startup = $p }
    }
    if ($autostart -eq '0') {
        # Honour the tray's 'Start with Windows' switch, and remove EVERY
        # shortcut in Startup that launches our exe -- matched by TARGET, not by
        # name. A fleet PC carried both 'PCoin Miner.lnk' and 'PCoin.lnk' (the
        # desktop icon, copied there by somebody) and each started the app just
        # as well, so deleting only the one we happen to create left autostart
        # working while the tray's tick said it was off.
        if ($startup) {
            $wsOff = New-Object -ComObject WScript.Shell
            # NOT $mine. PowerShell variables are case-insensitive, so $mine IS
            # the -Mine switch parameter, and assigning a path to a [switch]
            # throws "Cannot convert ... to SwitchParameter" -- which aborts
            # this whole try block and silently leaves every shortcut in place.
            # This file already carries that warning further down, about the
            # session-id local, and I walked into it anyway. Measured on a real
            # machine 2026-09-10: both shortcuts survived an autostart=0 install
            # and the log said only "autostart skipped: Cannot convert...".
            $mineExe = (Join-Path $InstallDir 'PCoinTray.exe')
            foreach ($f in (Get-ChildItem $startup -Filter *.lnk -ErrorAction SilentlyContinue)) {
                try {
                    if ($wsOff.CreateShortcut($f.FullName).TargetPath -eq $mineExe) {
                        Remove-Item $f.FullName -Force -ErrorAction SilentlyContinue
                        Write-Output ('  removed autostart shortcut ' + $f.Name)
                    }
                } catch { }
            }
        }
        Write-Output '  autostart shortcut not created (switched off in the tray)'
    } elseif ($startup) {
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut((Join-Path $startup 'PCoin Miner.lnk'))
        $lnk.TargetPath = (Join-Path $InstallDir 'PCoinTray.exe')
        # --minimized is LOAD-BEARING, not cosmetic. It is how the app knows it
        # was started by autostart rather than by a person, and therefore how it
        # knows to close again when autostart has been switched off. On a real
        # machine the scheduled task cannot be removed by a non-admin user, so
        # this flag is the only thing that keeps the promise.
        $lnk.Arguments = '--minimized'
        $lnk.WorkingDirectory = $InstallDir
        $lnk.Description = 'PCoin node and miner'
        $lnk.Save()
        Write-Output "  autostart shortcut created in $startup"
    } else {
        Write-Output '  autostart skipped: could not locate the user Startup folder'
    }

    # A desktop shortcut, because an app with no icon anywhere is an app the
    # owner cannot find again. The installer .exe has always made one; this
    # script never did, which is why script-installed machines looked
    # half-installed even while they were mining perfectly.
    $desk = [Environment]::GetFolderPath('Desktop')
    if (-not $desk -or $desk -match 'systemprofile') {
        if ($env:USERNAME) {
            $c = Join-Path (Join-Path $env:SystemDrive 'Users') (Join-Path $env:USERNAME 'Desktop')
            if (Test-Path $c) { $desk = $c }
        }
    }
    if ($desk -and (Test-Path $desk)) {
        $ws2 = New-Object -ComObject WScript.Shell
        $d = $ws2.CreateShortcut((Join-Path $desk 'PCoin.lnk'))
        $d.TargetPath = (Join-Path $InstallDir 'PCoinTray.exe')
        $d.WorkingDirectory = $InstallDir
        $d.Description = 'PCoin node and miner'
        $ic = Join-Path $InstallDir 'pcoin.ico'
        if (Test-Path $ic) { $d.IconLocation = $ic }
        $d.Save()
        Write-Output ('  desktop shortcut created in ' + $desk)
    } else {
        Write-Output '  desktop shortcut skipped: no Desktop folder found'
    }
} catch {
    Write-Output ('  autostart skipped: ' + $_.Exception.Message)
}

# --- Add/Remove Programs entry -------------------------------------------
# Without this, PCoin installs but is not in Settings > Apps, so the only way
# to remove it is to know which folder, which scheduled task, which firewall
# rule and which shortcuts to delete by hand. Software that cannot be
# uninstalled the ordinary way reads as something that did not want to be.
#
# HKLM when elevated so every account on the PC sees it; HKCU otherwise, which
# is the same place a per-user install belongs anyway.
#
# The entry is written ONLY when the uninstaller is actually on disk. An
# UninstallString pointing at a file that was never installed is the exact
# shape of the v1.2.3 bug where the zip shipped without PCoinTray.exe and the
# shortcut pointed at nothing: the install still reported success, and the
# failure surfaced later, to the user, as a button that does nothing.
try {
    $unins = Join-Path $InstallDir 'uninstall.ps1'
    if (Test-Path $unins) {
        $arpRoot = if ($script:IsAdmin) { 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinMiner' }
                   else                 { 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinMiner' }
        if (-not (Test-Path $arpRoot)) { New-Item -Path $arpRoot -Force | Out-Null }
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $q  = '"' + $unins + '"'
        $kb = 0
        try { $kb = [int](((Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue |
                            Measure-Object Length -Sum).Sum) / 1024) } catch { }
        $vals = @{
            DisplayName     = 'PCoin Miner'
            DisplayVersion  = $Version
            Publisher       = 'PCoin'
            InstallLocation = $InstallDir
            URLInfoAbout    = 'https://pc.am'
            # -File, not -Command: a path with a space in it (%LOCALAPPDATA% on
            # an account whose name has one) survives -File and does not
            # survive being pasted into -Command.
            UninstallString = "$ps -NoProfile -ExecutionPolicy Bypass -File $q"
            QuietUninstallString = "$ps -NoProfile -ExecutionPolicy Bypass -File $q -Yes"
            NoModify        = 1
            NoRepair        = 1
            InstallDate     = (Get-Date -Format 'yyyyMMdd')
        }
        if ($kb -gt 0) { $vals['EstimatedSize'] = $kb }
        $ico = Join-Path $InstallDir 'PCoinTray.exe'
        if (Test-Path $ico) { $vals['DisplayIcon'] = $ico }
        foreach ($k in $vals.Keys) {
            $t = if ($vals[$k] -is [int]) { 'DWord' } else { 'String' }
            New-ItemProperty -Path $arpRoot -Name $k -Value $vals[$k] -PropertyType $t -Force | Out-Null
        }
        Write-Output ('  listed in Settings > Apps (' + $(if ($script:IsAdmin) { 'all users' } else { 'this user' }) + ')')
    } else {
        Write-Output '  Apps-list entry skipped: uninstall.ps1 is not in this build'
    }
} catch {
    Write-Output ('  Apps-list entry skipped: ' + $_.Exception.Message)
}

# Second, independent autostart: a scheduled task with an AtLogOn trigger.
#
# The Startup shortcut is run by Explorer, which staggers startup items and can
# take several minutes to get to them - measured on one of these machines, where
# the tray did not appear for a good while after a reboot and the PC contributed
# nothing in the meantime. Task Scheduler starts it directly at logon instead.
#
# Both may fire. That is harmless: the app takes a per-session single-instance
# mutex, so whichever arrives second exits immediately.
#
# /IT puts it in the interactive desktop session, the only place a tray icon can
# exist. The run level depends on admin:
#   - Elevated: grant this account the "Lock pages in memory" right and create the
#     task at /RL HIGHEST, so the miner runs with that right and can use LARGE
#     PAGES (a big speed-up -- every core keeps adding hash rate instead of the
#     cores fighting over the TLB; see -randomxlargepages). A HIGHEST task runs
#     elevated at logon with NO UAC prompt. The right takes effect at the next
#     sign-in, so large pages activate then.
#   - Not elevated: /RL LIMITED, no large pages (fast mode still works, just capped
#     to the L3/hyperthread peak as in v1.3.7).

# Grant SeLockMemoryPrivilege ("Lock pages in memory") to $account via secedit --
# built-in, works on every Windows edition (secpol.msc is Pro-only). Idempotent.
function Grant-LockPagesRight([string]$account) {
    $sid = (New-Object System.Security.Principal.NTAccount($account)).Translate(
        [System.Security.Principal.SecurityIdentifier]).Value
    $inf = Join-Path $env:TEMP 'pcoin_lp.inf'; $sdb = Join-Path $env:TEMP 'pcoin_lp.sdb'
    Remove-Item $inf, $sdb -ErrorAction SilentlyContinue
    # Run secedit via cmd so its stderr can never be wrapped into a thrown
    # NativeCommandError under ErrorAction Stop (the PS 5.1 trap that aborts the
    # whole install). Paths are quoted for cmd.
    cmd /c "secedit /export /areas USER_RIGHTS /cfg `"$inf`" >nul 2>nul" | Out-Null
    if (-not (Test-Path $inf)) { throw 'secedit could not read the current user-rights policy' }
    $lines = Get-Content $inf; $hit = $false
    for ($i = 0; $i -lt $lines.Count; $i++) {
        if ($lines[$i] -match '^SeLockMemoryPrivilege') {
            if ($lines[$i] -notmatch [regex]::Escape($sid)) { $lines[$i] = $lines[$i].TrimEnd() + ',*' + $sid }
            $hit = $true
        }
    }
    if (-not $hit) {
        $o = @(); foreach ($x in $lines) { $o += $x; if ($x -match '\[Privilege Rights\]') { $o += "SeLockMemoryPrivilege = *$sid" } }
        $lines = $o
    }
    Set-Content -Path $inf -Value $lines -Encoding Unicode
    cmd /c "secedit /import /db `"$sdb`" /cfg `"$inf`" /areas USER_RIGHTS >nul 2>nul" | Out-Null
    cmd /c "secedit /configure /db `"$sdb`" /areas USER_RIGHTS >nul 2>nul" | Out-Null
    Remove-Item $inf, $sdb -ErrorAction SilentlyContinue
}

try {
    $who = (Get-CimInstance Win32_ComputerSystem).UserName
    if ($autostart -eq '0') {
        # Autostart is off, so remove the task rather than merely skip creating
        # it -- otherwise the setting only works for people who never had one.
        # This is the ONLY place the task is deleted now, immediately beside the
        # branch that would have created it, so there is no window in which the
        # machine is left without one.
        if ($script:IsAdmin -and (Get-ScheduledTask -TaskName PCoinMiner -ErrorAction SilentlyContinue)) {
            try {
                cmd /c 'schtasks /delete /tn PCoinMiner /f >nul 2>nul' | Out-Null
                Write-Output '  autostart task removed (switched off in the tray)'
            } catch { }
        }
        $who = $null
    }
    if ($who) {
        $exePath = Join-Path $InstallDir 'PCoinTray.exe'
        # Do not CALL schtasks without admin. It writes a bare
        #   ERROR: Access is denied.
        # to stderr, and redirecting that with 2>$null does not silence it -- in
        # PowerShell 5.1 a native command's redirected stderr is wrapped in a
        # NativeCommandError and THROWN, so the catch below printed the very same
        # text. Asking first is the only way it stays quiet.
        if (-not $script:IsAdmin) {
            Write-Output '  autostart task needs admin -- skipped (the Startup shortcut already starts it at logon)'
        } else {
            $rl = 'LIMITED'
            try {
                Grant-LockPagesRight $who
                $rl = 'HIGHEST'
                Write-Output "  granted 'Lock pages in memory' to $who -- large pages activate at next sign-in"
            } catch {
                Write-Output ('  (could not grant Lock-pages-in-memory; mining without large pages: ' + $_.Exception.Message + ')')
            }
            # Same flag as the shortcut, and for the same reason: this task
            # is the mechanism a non-admin user cannot delete, so the app
            # must be able to recognise its own autostart and bow out.
            $tr = '"' + $exePath + '" --minimized'
            schtasks /create /tn PCoinMiner /tr $tr /sc onlogon /ru $who /it /rl $rl /f | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Output "  autostart task created for $who ($rl)" }
            else { Write-Output '  autostart task could not be created (the Startup shortcut still applies)' }
        }
    }
} catch {
    Write-Output ('  autostart task skipped: ' + $_.Exception.Message)
}

# --- launch --------------------------------------------------------------
if (-not $NoStart) {
    Get-Process PCoinTray -ErrorAction SilentlyContinue |
        Stop-Process -Force -ErrorAction SilentlyContinue
    $exe = Join-Path $InstallDir 'PCoinTray.exe'

    # Start it in the session the person using this PC is logged into.
    #
    # Windows puts services, and everything they launch, in session 0 - which
    # has no desktop and no notification area. Installing over a remote
    # management tool that runs as a service therefore produces a miner that
    # works perfectly and is completely invisible, with no tray icon to show
    # the machine is mining or to stop it with. The app now refuses to start
    # there at all, so without this the install would simply end with nothing
    # running.
    # The local MUST NOT be called $mine: PowerShell variables are
    # case-insensitive, so $mine would BE the installer's -Mine switch, and
    # assigning a session id (1) to a [switch] throws
    # "Cannot convert 1 to SwitchParameter" -- aborting the install right before
    # the tray launches (which is why -NoStart, skipping this, never saw it).
    # Launch it, THEN CHECK IT IS ACTUALLY RUNNING, and fall back to the
    # interactive task if it is not.
    #
    # The session check below only fired when Get-Process explorer found
    # something. When it did not -- no interactive shell at that moment, or the
    # query failed under an elevated remote session -- this fell through to a
    # plain Start-Process, which from an elevated remote install lands in
    # session 0. The tray REFUSES to run there (PCoinTray.cs:75-99), so the
    # install ended reporting success with nothing running at all. That is what
    # happened to one machine on 2026-09-12; it sat idle until someone noticed
    # and triggered the logon task by hand.
    function Start-TrayViaTask {
        param([string]$Exe)
        try {
            $who = (Get-CimInstance Win32_ComputerSystem).UserName
            if (-not $who) { return $false }
            schtasks /create /tn PCoinTrayLaunch /tr $Exe /sc once /st 23:59 /ru $who /it /f | Out-Null
            schtasks /run /tn PCoinTrayLaunch | Out-Null
            Start-Sleep -Seconds 8
            schtasks /delete /tn PCoinTrayLaunch /f | Out-Null
            return $true
        } catch { return $false }
    }

    $target = $null
    try { $target = (Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).SessionId } catch { }
    $mySession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($null -ne $target -and $mySession -ne $target) {
        if (Start-TrayViaTask -Exe $exe) { Write-Output "  started in desktop session $target" }
        else { Write-Output '  could not reach the desktop session' }
    } else {
        Start-Process -FilePath $exe -WorkingDirectory $InstallDir
    }

    # Verify. "I called Start-Process" is not "the tray is running" - the tray
    # exits by design in session 0, so the only honest check is to look.
    $up = $false
    for ($i = 0; $i -lt 15; $i++) {
        if (@(Get-Process PCoinTray -ErrorAction SilentlyContinue).Count -gt 0) { $up = $true; break }
        Start-Sleep -Seconds 1
    }
    if (-not $up) {
        Write-Output '  tray did not start (session 0 refuses it); retrying through the desktop session'
        if (Start-TrayViaTask -Exe $exe) {
            for ($i = 0; $i -lt 15; $i++) {
                if (@(Get-Process PCoinTray -ErrorAction SilentlyContinue).Count -gt 0) { $up = $true; break }
                Start-Sleep -Seconds 1
            }
        }
        if ($up) { Write-Output '  tray started' }
        else {
            Write-Output '  WARNING: the tray is NOT running. The node and miner are installed;'
            Write-Output '           sign in to this PC, or run:  schtasks /run /tn PCoinMiner'
        }
    }
    Start-Sleep -Seconds 40
    $cli = Join-Path $InstallDir 'bitcoin-cli.exe'
    Write-Output '--- node ---'
    & $cli -datadir="$DataDir" getblockchaininfo 2>&1 | Select-Object -First 6
    Write-Output '--- miner ---'
    & $cli -datadir="$DataDir" getcpuminerinfo 2>&1 | Select-Object -First 7
    Write-Output '--- peers ---'
    & $cli -datadir="$DataDir" getconnectioncount 2>&1
    Write-Output '--- processes ---'
    (Get-Process bitcoind, PCoinTray -ErrorAction SilentlyContinue |
        Select-Object Name, Id, SessionId | Format-Table -AutoSize | Out-String).Trim()
    if (-not (Get-Process PCoinTray -ErrorAction SilentlyContinue |
              Where-Object { $_.SessionId -eq $target })) {
        Write-Output '  WARNING: no tray icon is visible on the desktop. Run PCoinTray.exe there.'
    }
}
Write-Output 'PCOIN_INSTALL_DONE'

# A run without admin succeeds, but silently does less. List exactly what was
# missed and the one command that adds it, so 'skipped (needs admin)' three
# lines up is actionable rather than just noted.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
    Write-Output ''
    Write-Output '  WHAT ADMIN WOULD HAVE ADDED (everything above still works):'
    Write-Output '    - Defender exclusions, so scans do not throttle the miner'
    Write-Output '    - an inbound firewall rule for port 9444 (better peer connectivity)'
    Write-Output '    - a logon scheduled task, and installation into C:\PCoin'
    Write-Output ''
    Write-Output '  To add them: right-click PowerShell > Run as administrator, then re-run'
    Write-Output '  the same one-liner. It is safe to run twice.'
    Write-Output ''
}
