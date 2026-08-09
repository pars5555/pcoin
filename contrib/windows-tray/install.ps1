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
    [string]$InstallDir = 'C:\PCoin',
    [string]$DataDir = '',
    # Bump both together at every release. The hash is of pcoin-<ver>-win64.zip
    # and the install aborts on a mismatch, so a forgotten bump here breaks
    # every new install rather than failing quietly.
    [string]$Version = '1.2.3',
    [string]$Sha256 = 'ba06161803244ea567f6e3f1212499e7f08b352da23b970c3b4820a3d4cad318',
    # All three seeds, not just one. The node also carries them compiled in as
    # of v1.2.1, so this is belt and braces rather than the only route in.
    [string[]]$AddNode = @('35.239.156.16:9444', '35.238.47.14:9444', '178.105.3.51:9444'),
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$name = "pcoin-$Version-win64.zip"
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
$fastMode = '0'
if ($keep.ContainsKey('fastmode')) { $fastMode = $keep['fastmode'] }

@("address=$addr",
  "addresswallet=$addrWallet",
  "datadir=$DataDir",
  "threads=$Threads",
  "seedprompt=$seedPrompt",
  "fastmode=$fastMode") |
    Set-Content -Encoding ascii $trayCfg
if ($Threads -gt 0) { Write-Output "  configured to mine with $Threads cores" }
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
        schtasks /create /tn PCoinMiner /tr $exePath /sc onlogon /ru $who /it /rl LIMITED /f | Out-Null
        if ($LASTEXITCODE -eq 0) { Write-Output "  autostart task created for $who" }
        else { Write-Output '  autostart task could not be created (shortcut still applies)' }
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
