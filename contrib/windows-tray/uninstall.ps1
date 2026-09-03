# PCoin Windows uninstaller.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1
#
# Also reachable two other ways, which is the point of it existing:
#   - Settings > Apps > Installed apps > PCoin Miner > Uninstall
#   - the tray icon's right-click menu > "Uninstall PCoin..."
#
# THE WALLET IS RESCUED, NEVER DELETED. This is the whole design constraint.
# The install folder holds pcoin-seed.dat (the DPAPI-protected twelve words)
# and data\wallet.dat (or data\wallets\), and those ARE the coins -- there is
# no copy on any server, because a miner pays a bare address and nothing else
# ever sees the key. An uninstaller that removed the folder wholesale would be
# indistinguishable from a wallet wipe, and the person running it would be told
# "uninstalled successfully". So by default every wallet file is COPIED OUT to
# the user profile first, the path is printed, and the copy is verified to
# exist before anything is deleted. -Purge is the only way to delete them, and
# it will not run without -Yes.
#
# The chain data (blocks/chainstate, several GB) is removed by default: it is
# public data that re-downloads in minutes, so keeping it would just leave a
# large folder behind on a machine whose owner asked for the program to go.
# -KeepData leaves it.
param(
    # Where PCoin is installed. Found from the uninstall registry entry when not
    # given, so the Apps-list button and the tray menu both work with no
    # arguments even on a machine that installed to a non-default folder.
    [string]$InstallDir = '',
    # Delete wallet files too. Refuses without -Yes: this is the one flag that
    # can destroy money, so it must never be reachable by a single typo.
    [switch]$Purge,
    # Leave the chain data (blocks/chainstate) on disk.
    [switch]$KeepData,
    # No prompts. This is what QuietUninstallString uses.
    [switch]$Yes,
    # Set by the elevated relaunch so it cannot ask again and loop.
    [switch]$NoElevate
)

$ErrorActionPreference = 'Stop'
$script:IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

function Find-InstallDir {
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinMiner',
                        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinMiner')) {
        try {
            $v = (Get-ItemProperty -Path $root -Name InstallLocation -ErrorAction Stop).InstallLocation
            if ($v -and (Test-Path $v)) { return $v }
        } catch { }
    }
    foreach ($c in @('C:\PCoin', (Join-Path $env:LOCALAPPDATA 'PCoin'))) {
        if ($c -and (Test-Path (Join-Path $c 'PCoinTray.exe'))) { return $c }
    }
    return ''
}

if (-not $InstallDir) { $InstallDir = Find-InstallDir }
if (-not $InstallDir -or -not (Test-Path $InstallDir)) {
    Write-Output 'PCoin does not appear to be installed (no install folder found).'
    Write-Output 'Nothing to do.'
    exit 0
}

# Read the data directory out of the tray config rather than assuming
# <install>\data: an install can be pointed elsewhere with -DataDir, and
# deleting the wrong folder -- or missing the right one -- is exactly the
# mistake this script must not make.
$DataDir = Join-Path $InstallDir 'data'
$cfg = Join-Path $InstallDir 'pcoin-tray.cfg'
if (Test-Path $cfg) {
    foreach ($line in (Get-Content $cfg -ErrorAction SilentlyContinue)) {
        if ($line -match '^\s*datadir\s*=\s*(.+?)\s*$' -and $Matches[1]) { $DataDir = $Matches[1] }
    }
}

Write-Output 'PCoin uninstaller'
Write-Output "  install folder : $InstallDir"
Write-Output "  data folder    : $DataDir"
Write-Output ''

# --- elevate -------------------------------------------------------------
# Without admin this still removes the program, the shortcuts and the per-user
# registry entry; elevation additionally removes the logon task, the firewall
# rule, the Defender exclusions, and an install under C:\.
if (-not $script:IsAdmin -and -not $NoElevate) {
    Write-Output '  Elevating to remove the logon task, firewall rule and Defender'
    Write-Output '  exclusions. Approve the UAC prompt -- or decline to remove only'
    Write-Output '  what does not need admin.'
    $extra = ''
    if ($Purge)    { $extra = $extra + ' -Purge' }
    if ($KeepData) { $extra = $extra + ' -KeepData' }
    if ($Yes)      { $extra = $extra + ' -Yes' }
    $self = $MyInvocation.MyCommand.Path
    $inner = "try { & '$self' -InstallDir '$InstallDir' -NoElevate$extra } catch { Write-Host `$_.Exception.Message -ForegroundColor Red; Start-Sleep 10 }"
    try {
        Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$inner -Wait
        Write-Output '  Elevated uninstall finished.'
        exit 0
    } catch {
        Write-Output '  Elevation declined; continuing without it.'
    }
}

# --- confirm -------------------------------------------------------------
if (-not $Yes) {
    Write-Output 'This will stop mining, shut the node down and remove PCoin from this PC.'
    if ($Purge) {
        Write-Output ''
        Write-Output '  *** -Purge: YOUR WALLET AND RECOVERY PHRASE WILL BE DELETED. ***'
        Write-Output '  *** Any coins only this PC can spend are gone permanently.   ***'
    } else {
        Write-Output 'Your wallet is NOT deleted -- it is copied to your user folder first.'
    }
    Write-Output ''
    $a = Read-Host 'Type YES to continue'
    if ($a -ne 'YES') { Write-Output 'Cancelled. Nothing was changed.'; exit 1 }
    Write-Output ''
}
if ($Purge -and -not $Yes) {
    Write-Output 'Refusing -Purge without -Yes.'
    exit 1
}

# --- stop everything -----------------------------------------------------
# Ask the node to stop rather than killing it: a killed bitcoind can leave the
# chainstate needing a reindex, and on an uninstall that keeps its data
# (-KeepData) the next install would silently pay for that with a long resync.
Write-Output 'Stopping PCoin...'
$cli = Join-Path $InstallDir 'bitcoin-cli.exe'
if (Test-Path $cli) {
    try { & $cli -datadir="$DataDir" stopmining 2>&1 | Out-Null } catch { }
    try { & $cli -datadir="$DataDir" stop 2>&1 | Out-Null } catch { }
}
Get-Process PCoinTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
for ($i = 0; $i -lt 30; $i++) {
    if (-not (Get-Process bitcoind -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Seconds 1
}
$still = Get-Process bitcoind -ErrorAction SilentlyContinue
if ($still) {
    Write-Output '  node did not stop on request; forcing it'
    $still | Stop-Process -Force -ErrorAction SilentlyContinue
    Start-Sleep -Seconds 2
}
Write-Output '  stopped'

# --- rescue the wallet ---------------------------------------------------
# Copied, not moved, and the copy is checked before any delete runs. A move
# that half-completed would leave the only copy of a key in a folder this
# script is about to remove.
$rescued = ''
if (-not $Purge) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path $env:USERPROFILE "PCoin-wallet-backup-$stamp"
    $items = @()
    foreach ($f in @('pcoin-seed.dat', 'pcoin-tray.cfg')) {
        $p = Join-Path $InstallDir $f
        if (Test-Path $p) { $items += $p }
    }
    foreach ($f in @('wallet.dat', 'wallets')) {
        $p = Join-Path $DataDir $f
        if (Test-Path $p) { $items += $p }
    }
    if ($items.Count -gt 0) {
        try {
            New-Item -ItemType Directory -Path $dest -Force -ErrorAction Stop | Out-Null
            foreach ($p in $items) { Copy-Item $p -Destination $dest -Recurse -Force -ErrorAction Stop }
            $n = @(Get-ChildItem $dest -Recurse -File -ErrorAction SilentlyContinue).Count
            if ($n -lt 1) { throw 'the copy is empty' }
            $rescued = $dest
            Write-Output ''
            Write-Output "WALLET SAVED TO: $dest"
            Write-Output "  ($n file(s)). Keep this folder -- it is the only copy of the key"
            Write-Output '  material that was on this PC.'
        } catch {
            # Never proceed to delete when the rescue failed. Stopping here
            # leaves a working install, which is always recoverable; carrying
            # on would not be.
            Write-Output ''
            Write-Output ('COULD NOT SAVE THE WALLET: ' + $_.Exception.Message)
            Write-Output 'Stopping now and changing nothing else, so the coins stay reachable.'
            Write-Output 'Copy that folder somewhere safe by hand, then re-run with -Purge if'
            Write-Output 'you really do want it gone.'
            exit 1
        }
    } else {
        Write-Output '  no wallet files found to save'
    }
}

# --- autostart, shortcuts ------------------------------------------------
Write-Output ''
Write-Output 'Removing autostart and shortcuts...'
foreach ($t in @('PCoinMiner', 'PCoinTrayLaunch')) {
    # Same PowerShell 5.1 trap install.ps1 documents: schtasks writes to stderr
    # when the task is absent, and a redirected native stderr is wrapped in a
    # NativeCommandError and thrown under ErrorAction Stop.
    if (Get-ScheduledTask -TaskName $t -ErrorAction SilentlyContinue) {
        try { cmd /c "schtasks /delete /tn $t /f >nul 2>nul" | Out-Null; Write-Output "  removed task $t" } catch { }
    }
}
$lnks = @()
foreach ($sd in @([Environment]::GetFolderPath('Startup'),
                  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup'))) {
    if ($sd) { $lnks += (Join-Path $sd 'PCoin Miner.lnk'); $lnks += (Join-Path $sd 'PCoinTray.lnk') }
}
$desk = [Environment]::GetFolderPath('Desktop')
if ($desk) { $lnks += (Join-Path $desk 'PCoin.lnk') }
foreach ($l in $lnks) {
    if ($l -and (Test-Path $l)) {
        Remove-Item $l -Force -ErrorAction SilentlyContinue
        Write-Output ('  removed ' + (Split-Path $l -Leaf))
    }
}

# --- host tweaks (admin only) --------------------------------------------
if ($script:IsAdmin) {
    try {
        if (Get-NetFirewallRule -DisplayName 'PCoin P2P 9444' -ErrorAction SilentlyContinue) {
            Remove-NetFirewallRule -DisplayName 'PCoin P2P 9444' -ErrorAction Stop
            Write-Output '  removed firewall rule'
        }
    } catch { }
    try {
        Remove-MpPreference -ExclusionPath $InstallDir, $DataDir -ErrorAction Stop
        Write-Output '  removed defender exclusions'
    } catch { }
}

# --- registry ------------------------------------------------------------
foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinMiner',
                    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinMiner')) {
    if (Test-Path $root) {
        try { Remove-Item $root -Recurse -Force -ErrorAction Stop; Write-Output '  removed the Apps-list entry' } catch { }
    }
}

# --- files ---------------------------------------------------------------
Write-Output ''
Write-Output 'Removing files...'
# Step out of the folder first: this script lives inside it, and a process whose
# working directory is the folder makes the folder undeletable even when every
# file in it is gone.
Set-Location $env:TEMP
if ($KeepData) {
    foreach ($f in (Get-ChildItem $InstallDir -Force -ErrorAction SilentlyContinue)) {
        if ($f.FullName -eq $DataDir) { continue }
        try { Remove-Item $f.FullName -Recurse -Force -ErrorAction Stop } catch { }
    }
    Write-Output "  program files removed; chain data kept at $DataDir"
} else {
    try { Remove-Item $InstallDir -Recurse -Force -ErrorAction Stop } catch { }
    if ($DataDir -and (Test-Path $DataDir) -and -not $DataDir.StartsWith($InstallDir, 'OrdinalIgnoreCase')) {
        try { Remove-Item $DataDir -Recurse -Force -ErrorAction Stop } catch { }
    }
}

# Report what is actually gone rather than what was attempted. A folder still
# holding a locked file is the normal partial case and the person needs to be
# told, not congratulated.
Write-Output ''
if (Test-Path $InstallDir) {
    $left = @(Get-ChildItem $InstallDir -Recurse -Force -ErrorAction SilentlyContinue).Count
    if ($KeepData) {
        Write-Output 'PCoin has been uninstalled (chain data kept, as asked).'
    } else {
        Write-Output "PCoin has been uninstalled, but $left file(s) could not be removed:"
        Write-Output "  $InstallDir"
        Write-Output '  Something still had them open. Reboot and delete that folder by hand.'
    }
} else {
    Write-Output 'PCoin has been uninstalled.'
}
if ($rescued) {
    Write-Output ''
    Write-Output "Your wallet was saved to: $rescued"
    Write-Output 'Without it, any coins this PC alone could spend are unrecoverable.'
}
Write-Output 'PCOIN_UNINSTALL_DONE'
