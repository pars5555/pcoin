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
    [string]$Version = '1.0.1',
    [string]$Sha256 = '757e26c439a137e1134afe4767634218eeddac41286466b73a80c14ecb4f535a',
    [string[]]$AddNode = @('35.239.156.16:9444'),
    [switch]$NoStart
)

$ErrorActionPreference = 'Stop'
$name = "pcoin-$Version-win64.zip"
$url = "https://github.com/pars5555/pcoin/releases/download/v$Version/$name"

Write-Output "PCoin $Version installer"
New-Item -ItemType Directory -Force $InstallDir | Out-Null

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
Copy-Item (Join-Path $tmp "pcoin-$Version\*") $InstallDir -Force -Recurse
Write-Output "  installed to $InstallDir"

# --- node configuration --------------------------------------------------
$dataDir = Join-Path $env:LOCALAPPDATA 'PCoin'
New-Item -ItemType Directory -Force $dataDir | Out-Null
$conf = @('server=1', 'listen=1', 'dbcache=300', 'maxconnections=40', 'par=2')
foreach ($n in $AddNode) { $conf += "addnode=$n" }
$conf | Set-Content -Encoding ascii (Join-Path $dataDir 'pcoin.conf')

@('address=', 'datadir=', "threads=$Threads") |
    Set-Content -Encoding ascii (Join-Path $InstallDir 'pcoin-tray.cfg')
if ($Threads -gt 0) { Write-Output "  configured to mine with $Threads cores" }
else { Write-Output '  configured; mining is OFF' }

# --- best-effort host tweaks (need admin; not fatal) ---------------------
try {
    Add-MpPreference -ExclusionPath $InstallDir, $dataDir -ErrorAction Stop
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
$startup = [Environment]::GetFolderPath('Startup')
$ws = New-Object -ComObject WScript.Shell
$lnk = $ws.CreateShortcut((Join-Path $startup 'PCoin Miner.lnk'))
$lnk.TargetPath = (Join-Path $InstallDir 'PCoinTray.exe')
$lnk.WorkingDirectory = $InstallDir
$lnk.Description = 'PCoin node and miner'
$lnk.Save()
Write-Output '  autostart shortcut created'

# --- launch --------------------------------------------------------------
if (-not $NoStart) {
    Get-Process PCoinTray -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Process -FilePath (Join-Path $InstallDir 'PCoinTray.exe') -WorkingDirectory $InstallDir
    Start-Sleep -Seconds 40
    $cli = Join-Path $InstallDir 'bitcoin-cli.exe'
    Write-Output '--- node ---'
    & $cli getblockchaininfo 2>&1 | Select-Object -First 6
    Write-Output '--- miner ---'
    & $cli getcpuminerinfo 2>&1 | Select-Object -First 7
    Write-Output '--- peers ---'
    & $cli getconnectioncount 2>&1
    Write-Output '--- processes ---'
    (Get-Process bitcoind, PCoinTray -ErrorAction SilentlyContinue |
        Select-Object Name, Id | Format-Table -AutoSize | Out-String).Trim()
}
Write-Output 'PCOIN_INSTALL_DONE'
