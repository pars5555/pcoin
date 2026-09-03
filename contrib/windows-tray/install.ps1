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
# therefore be the DEFAULT: mining is on unless -NoMine, and the pool is chosen
# unless -Solo. The older form still works and still takes switches, which
# matters because copies of it are already published:
#
#   & ([scriptblock]::Create((irm https://pc.am/dl/install.ps1))) -Mine
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Threads 4
#
# Mining starting immediately is safe HERE because a new install mines to the
# POOL, and a pool miner works on the block the pool hands it rather than one
# built from its own chain -- so it does not need to be synced first and cannot
# build a competing fork while it catches up. -Solo does need a synced node,
# and the tray waits for that on its own.

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
    [string]$Version = '1.4.2',
    [string]$Sha256 = '56a9d848ccf6f9e7a8cb9d5207480fa85ddb26f0225c35d09884d6eba77e3ff9',
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
    # Mine SOLO instead of the default pool. Solo pays the whole 50 PCN block when
    # THIS machine finds one -- rare unless you have a lot of hash rate, so most
    # miners see long dry spells. The default (pool) pays a small steady share.
    # You can switch either way later from the tray's Mining-mode panel.
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
Get-Process PCoinTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3
Get-Process bitcoin-cli -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# A previous install may have used a different datadir, so a targeted
# 'bitcoin-cli stop' can miss. Ask nicely, then insist.
$cliPath = Join-Path $InstallDir 'bitcoin-cli.exe'
if (Test-Path $cliPath) {
    try { & $cliPath stop 2>&1 | Out-Null } catch { }
    try { & $cliPath -datadir="$DataDir" stop 2>&1 | Out-Null } catch { }
    Start-Sleep -Seconds 8
}
Get-Process bitcoind -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 4

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
        catch { Write-Output ('    could not move the data dir (' + $_.Exception.Message + '); the node will re-sync') }
    }
    try { Remove-Item $old -Recurse -Force -ErrorAction Stop; Write-Output "    removed $old" }
    catch { Write-Output ('    could not fully remove ' + $old + ' (' + $_.Exception.Message + ') -- delete it by hand') }
}
# Tear down any stale autostart so the new one (created below) is the only one.
# schtasks /delete on a task that does not exist writes to stderr, which
# PowerShell 5.1 wraps in a NativeCommandError and THROWS under ErrorAction Stop
# (2>$null does not stop it). Delete only when the task actually exists, and
# swallow anything anyway.
if ($script:IsAdmin -and (Get-ScheduledTask -TaskName PCoinMiner -ErrorAction SilentlyContinue)) {
    try { cmd /c 'schtasks /delete /tn PCoinMiner /f >nul 2>nul' | Out-Null } catch { }
}
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
        Start-Sleep -Seconds 5
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
# Default a NEW install to the pool: for a small miner, pool pays a steady share
# instead of waiting days for a rare solo block. An existing install keeps its own
# choice, and -Solo forces solo.
$poolUrl = 'pool.pc.am:3333'
if ($keep.ContainsKey('poolurl')) { $poolUrl = $keep['poolurl'] }
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
    if ($startup) {
        $ws = New-Object -ComObject WScript.Shell
        $lnk = $ws.CreateShortcut((Join-Path $startup 'PCoin Miner.lnk'))
        $lnk.TargetPath = (Join-Path $InstallDir 'PCoinTray.exe')
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
            schtasks /create /tn PCoinMiner /tr $exePath /sc onlogon /ru $who /it /rl $rl /f | Out-Null
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
    $target = $null
    try { $target = (Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).SessionId } catch { }
    $mySession = [System.Diagnostics.Process]::GetCurrentProcess().SessionId
    if ($null -ne $target -and $mySession -ne $target) {
        try {
            $who = (Get-CimInstance Win32_ComputerSystem).UserName
            schtasks /create /tn PCoinTrayLaunch /tr $exe /sc once /st 23:59 /ru $who /it /f | Out-Null
            schtasks /run /tn PCoinTrayLaunch | Out-Null
            Start-Sleep -Seconds 8
            schtasks /delete /tn PCoinTrayLaunch /f | Out-Null
            Write-Output "  started in desktop session $target"
        } catch {
            Write-Output ('  could not reach the desktop session: ' + $_.Exception.Message)
        }
    } else {
        Start-Process -FilePath $exe -WorkingDirectory $InstallDir
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
