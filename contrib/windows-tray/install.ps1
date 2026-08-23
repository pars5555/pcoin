# PCoin Windows installer.
#
# Installs the node, CLI and miner tray app, configures them, and starts the
# tray app in the current desktop session.
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Threads 4
#
# Or straight from the repo:
#   & ([scriptblock]::Create((iwr https://raw.githubusercontent.com/pars5555/pcoin/main/contrib/windows-tray/install.ps1 -UseBasicParsing).Content)) -Threads 4
#
# Threads 0 (the default) installs everything but does NOT start mining. Do
# that deliberately: a node that mines before it has synced the existing chain
# builds a competing fork.

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
    [string]$Version = '1.3.6',
    [string]$Sha256 = '80fce51c77ad156580b4793c0a7caab01f07fbc916dde2af0d8e6331c35ab0bf',
    # All three seeds, not just one. The node also carries them compiled in as
    # of v1.2.1, so this is belt and braces rather than the only route in.
    [string[]]$AddNode = @('35.239.156.16:9444', '178.105.3.51:9444', '152.53.171.190:9444'),
    [switch]$NoStart,
    # Set by the elevated relaunch so it cannot ask again and loop.
    [switch]$NoElevate
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

# --- download and verify -------------------------------------------------
$zip = Join-Path $env:TEMP $name
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$script:IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

# OFFER elevation, never demand it. A one-liner that refuses without admin is a
# one-liner most people will not run, and everything essential works unelevated.
# But three 'skipped (needs admin)' lines are only useful if there is a way to
# act on them, and re-typing the command with a different shell is friction
# enough that nobody does. -NoElevate keeps it non-interactive for scripts.
if (-not $script:IsAdmin -and -not $NoElevate) {
    Write-Output ''
    Write-Output '  Not running as administrator. Without it this install skips:'
    Write-Output '    - Defender exclusions (scans throttle the miner)'
    Write-Output '    - the inbound firewall rule for port 9444 (fewer peers)'
    Write-Output '    - the logon scheduled task, and installing into C:\PCoin'
    $reply = Read-Host '  Relaunch as administrator to include them? [Y/n]'
    if ($reply -notmatch '^[Nn]') {
        $inner = "& ([scriptblock]::Create((irm https://pc.am/dl/install.ps1))) -Threads $Threads -NoElevate"
        try {
            Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-Command',$inner
            Write-Output '  Continuing in the elevated window. You can close this one.'
            return
        } catch {
            # UAC declined, or no interactive desktop. Carry on unelevated --
            # refusing here would leave the machine with nothing installed.
            Write-Output '  Elevation declined; continuing without it.'
        }
    }
    Write-Output ''
}
Invoke-WebRequest -Uri $url -OutFile $zip -UseBasicParsing
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
        break
    } catch {
        if ($attempt -eq 6) { throw }
        Get-Process bitcoind, PCoinTray, bitcoin-cli -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Seconds 5
    }
}
Write-Output "  installed to $InstallDir"

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
$poolUrl = ''
if ($keep.ContainsKey('poolurl')) { $poolUrl = $keep['poolurl'] }
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

@("address=$addr",
  "addresswallet=$addrWallet",
  "datadir=$DataDir",
  "threads=$threadsOut",
  "seedprompt=$seedPrompt",
  "fastmode=$fastMode",
  "poolurl=$poolUrl",
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
# exist. /RL LIMITED keeps it unelevated so it never raises a UAC prompt.
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
            schtasks /create /tn PCoinMiner /tr $exePath /sc onlogon /ru $who /it /rl LIMITED /f | Out-Null
            if ($LASTEXITCODE -eq 0) { Write-Output "  autostart task created for $who" }
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
    $target = (Get-Process explorer -ErrorAction SilentlyContinue | Select-Object -First 1).SessionId
    $mine = (Get-Process -Id $PID).SessionId
    if ($null -ne $target -and $mine -ne $target) {
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
