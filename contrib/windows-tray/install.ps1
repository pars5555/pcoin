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
    [string]$Version = '1.0.1',
    [string]$Sha256 = '757e26c439a137e1134afe4767634218eeddac41286466b73a80c14ecb4f535a',
    [string[]]$AddNode = @('35.239.156.16:9444'),
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
# A file can stay locked briefly after its process exits, so retry rather than
# aborting a half-finished install.
foreach ($attempt in 1..6) {
    try {
        Copy-Item (Join-Path $tmp "pcoin-$Version\*") $InstallDir -Force -Recurse
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
$conf = @('server=1', 'listen=1', 'dbcache=300', 'maxconnections=40', 'par=2')
foreach ($n in $AddNode) { $conf += "addnode=$n" }
$conf | Set-Content -Encoding ascii (Join-Path $DataDir 'pcoin.conf')
Write-Output "  data directory: $DataDir"

@('address=', "datadir=$DataDir", "threads=$Threads") |
    Set-Content -Encoding ascii (Join-Path $InstallDir 'pcoin-tray.cfg')
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

# --- launch --------------------------------------------------------------
if (-not $NoStart) {
    Get-Process PCoinTray -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Process -FilePath (Join-Path $InstallDir 'PCoinTray.exe') -WorkingDirectory $InstallDir
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
        Select-Object Name, Id | Format-Table -AutoSize | Out-String).Trim()
}
Write-Output 'PCOIN_INSTALL_DONE'
