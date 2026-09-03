# PCoin Wallet uninstaller (Windows).
#
#   powershell -ExecutionPolicy Bypass -File uninstall-wallet.ps1
#
# Also reachable from Settings > Apps > Installed apps > PCoin Wallet >
# Uninstall, which is the point of it existing.
#
# THE WALLET IS RESCUED, NEVER DELETED. The install folder holds
# pcoin-seed.dat (the DPAPI-protected twelve words) and data\wallets\pcoin-hd
# (the node's wallet built from them), and those ARE the coins. An uninstaller
# that removed the folder wholesale would be indistinguishable from a wallet
# wipe, and the person running it would be told "uninstalled successfully". So
# by default every wallet file - and the address book - is COPIED OUT to the
# user profile first, the path is printed, and the copy is verified to exist
# before anything is deleted. -Purge is the only way to delete them, and it
# will not run without -Yes.
#
# ONLY THIS WALLET'S NODE IS STOPPED. The PCoin miner may be installed on the
# same PC with its own bitcoind, and that one is not ours to touch: the node is
# asked to stop through ITS OWN data folder (which selects its own RPC port),
# and if it has to be forced, only the bitcoind whose command line names that
# folder is killed. Never `Stop-Process bitcoind` by name here.
#
# The chain data (blocks/chainstate) is removed by default: it is public data
# that re-downloads, so keeping it would just leave a large folder behind on a
# machine whose owner asked for the program to go. -KeepData leaves it.
param(
    # Where PCoin Wallet is installed. Found from the uninstall registry entry
    # when not given, so the Apps-list button works with no arguments even on
    # a machine that installed to a non-default folder.
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
    foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinWallet',
                        'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinWallet')) {
        try {
            $v = (Get-ItemProperty -Path $root -Name InstallLocation -ErrorAction Stop).InstallLocation
            if ($v -and (Test-Path $v)) { return $v }
        } catch { }
    }
    foreach ($c in @('C:\PCoinWallet', (Join-Path $env:LOCALAPPDATA 'PCoinWallet'))) {
        if ($c -and (Test-Path (Join-Path $c 'PCoinWallet.exe'))) { return $c }
    }
    return ''
}

if (-not $InstallDir) { $InstallDir = Find-InstallDir }
if (-not $InstallDir -or -not (Test-Path $InstallDir)) {
    Write-Output 'PCoin Wallet does not appear to be installed (no install folder found).'
    Write-Output 'Nothing to do.'
    exit 0
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')

# Read the data directory out of the wallet config rather than assuming
# <install>\data: an install can be pointed elsewhere, and deleting the wrong
# folder - or missing the right one - is exactly the mistake this script must
# not make.
$DataDir = Join-Path $InstallDir 'data'
$cfg = Join-Path $InstallDir 'pcoin-wallet.cfg'
if (Test-Path $cfg) {
    foreach ($line in (Get-Content $cfg -ErrorAction SilentlyContinue)) {
        if ($line -match '^\s*datadir\s*=\s*(.+?)\s*$' -and $Matches[1]) { $DataDir = $Matches[1] }
    }
}
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')

Write-Output 'PCoin Wallet uninstaller'
Write-Output "  install folder : $InstallDir"
Write-Output "  data folder    : $DataDir"
Write-Output ''

# --- elevate -------------------------------------------------------------
# Without admin this still removes the program, the shortcuts and the per-user
# registry entry; elevation additionally removes the Defender exclusion and an
# install under C:\.
if (-not $script:IsAdmin -and -not $NoElevate) {
    Write-Output '  Elevating to remove the Defender exclusion and a folder under C:\.'
    Write-Output '  Approve the UAC prompt - or decline to remove only what does not'
    Write-Output '  need admin.'
    $extra = ''
    if ($Purge)    { $extra = $extra + ' -Purge' }
    if ($KeepData) { $extra = $extra + ' -KeepData' }
    if ($Yes)      { $extra = $extra + ' -Yes' }
    $self = $MyInvocation.MyCommand.Path
    if ($self -and (Test-Path $self)) {
        $inner = "try { & '$self' -InstallDir '$InstallDir' -NoElevate$extra } catch { Write-Host `$_.Exception.Message -ForegroundColor Red; Start-Sleep 10 }"
    } else {
        $inner = "try { & ([scriptblock]::Create((irm https://pc.am/dl/uninstall-wallet.ps1))) -InstallDir '$InstallDir' -NoElevate$extra } catch { Write-Host `$_.Exception.Message -ForegroundColor Red; Start-Sleep 10 }"
    }
    try {
        Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$inner -Wait
        Write-Output '  Elevated uninstall finished.'
        exit 0
    } catch {
        Write-Output '  Elevation declined; continuing without it.'
    }
}

# --- confirm -------------------------------------------------------------
if ($Purge -and -not $Yes) {
    Write-Output 'Refusing -Purge without -Yes: that combination deletes the wallet.'
    exit 1
}
if (-not $Yes) {
    Write-Output 'This will close PCoin Wallet, shut its node down and remove the program.'
    if ($Purge) {
        Write-Output ''
        Write-Output '  *** -Purge: YOUR WALLET AND RECOVERY PHRASE WILL BE DELETED. ***'
        Write-Output '  *** Any coins only this PC can spend are gone permanently.   ***'
    } else {
        Write-Output 'Your wallet is NOT deleted - it is copied to your user folder first.'
    }
    Write-Output ''
    $a = Read-Host 'Type YES to continue'
    if ($a -ne 'YES') { Write-Output 'Cancelled. Nothing was changed.'; exit 1 }
    Write-Output ''
}

# --- stop the wallet and ITS node ----------------------------------------
Write-Output 'Stopping PCoin Wallet...'
Get-Process PCoinWallet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
# Ask this wallet's node to stop through its own data folder. bitcoin-cli
# reads pcoin.conf there, which carries this node's rpcport, so the miner's
# node on 9443 is never addressed.
$cli = Join-Path $InstallDir 'bitcoin-cli.exe'
if (Test-Path $cli) {
    try { & $cli -datadir="$DataDir" stop 2>&1 | Out-Null } catch { }
}
# Wait for the bitcoind that runs on OUR data folder, identified by its command
# line, and never any other.
function Get-OurNode {
    try {
        Get-CimInstance Win32_Process -Filter "Name = 'bitcoind.exe'" -ErrorAction Stop |
            Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($DataDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
    } catch { @() }
}
for ($i = 0; $i -lt 40; $i++) {
    if (-not (Get-OurNode)) { break }
    Start-Sleep -Seconds 1
}
$still = Get-OurNode
if ($still) {
    Write-Output '  the node did not stop on request; forcing only the one on our data folder'
    foreach ($p in $still) { try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { } }
    Start-Sleep -Seconds 2
}
Write-Output '  stopped'

# --- rescue the wallet ---------------------------------------------------
# Copied, not moved, and the copy is checked before any delete runs.
$rescued = ''
if (-not $Purge) {
    $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
    $dest = Join-Path $env:USERPROFILE "PCoinWallet-backup-$stamp"
    $items = @()
    foreach ($f in @('pcoin-seed.dat', 'pcoin-seed.info', 'pcoin-addressbook.json', 'pcoin-wallet.cfg')) {
        $p = Join-Path $InstallDir $f
        if (Test-Path $p) { $items += $p }
    }
    # Where the node keeps the wallet depends on the node: with no `wallets\`
    # folder present at first start, Core puts each wallet directly under the
    # data folder (`data\pcoin-hd\wallet.dat`), and creates `data\wallets\`
    # only when it already existed. Measured on a fresh install: the wallet
    # was at data\pcoin-hd\wallet.dat and a rescue that only looked in
    # `wallets\` would have missed it. Take every wallet wherever it is.
    foreach ($f in @('wallet.dat', 'wallets')) {
        $p = Join-Path $DataDir $f
        if (Test-Path $p) { $items += $p }
    }
    foreach ($d in (Get-ChildItem $DataDir -Directory -ErrorAction SilentlyContinue)) {
        if ($d.Name -eq 'wallets') { continue }
        if (Test-Path (Join-Path $d.FullName 'wallet.dat')) { $items += $d.FullName }
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
            Write-Output "  ($n file(s)). Keep this folder, or make sure your twelve words are on"
            Write-Output '  paper - either one rebuilds the wallet.'
        } catch {
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

# --- shortcuts, task -----------------------------------------------------
Write-Output ''
Write-Output 'Removing shortcuts...'
if (Get-ScheduledTask -TaskName 'PCoinWalletLaunch' -ErrorAction SilentlyContinue) {
    try { cmd /c 'schtasks /delete /tn PCoinWalletLaunch /f >nul 2>nul' | Out-Null } catch { }
}
$lnks = @()
$desk = [Environment]::GetFolderPath('Desktop')
if ($desk) { $lnks += (Join-Path $desk 'PCoin Wallet.lnk') }
$menu = [Environment]::GetFolderPath('Programs')
if ($menu) { $lnks += (Join-Path $menu 'PCoin Wallet.lnk') }
foreach ($l in $lnks) {
    if ($l -and (Test-Path $l)) {
        Remove-Item $l -Force -ErrorAction SilentlyContinue
        Write-Output ('  removed ' + (Split-Path $l -Leaf))
    }
}

# --- host tweaks (admin only) --------------------------------------------
if ($script:IsAdmin) {
    try {
        Remove-MpPreference -ExclusionPath $InstallDir, $DataDir -ErrorAction Stop
        Write-Output '  removed defender exclusions'
    } catch { }
}

# --- registry ------------------------------------------------------------
foreach ($root in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinWallet',
                    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinWallet')) {
    if (Test-Path $root) {
        try { Remove-Item $root -Recurse -Force -ErrorAction Stop; Write-Output '  removed the Apps-list entry' } catch { }
    }
}

# --- files ---------------------------------------------------------------
Write-Output ''
Write-Output 'Removing files...'
Set-Location $env:TEMP
if ($KeepData) {
    foreach ($f in (Get-ChildItem $InstallDir -Force -ErrorAction SilentlyContinue)) {
        if ($f.FullName.TrimEnd('\') -eq $DataDir) { continue }
        try { Remove-Item $f.FullName -Recurse -Force -ErrorAction Stop } catch { }
    }
    Write-Output "  program files removed; chain data kept at $DataDir"
} else {
    try { Remove-Item $InstallDir -Recurse -Force -ErrorAction Stop } catch { }
    if ($DataDir -and (Test-Path $DataDir) -and -not $DataDir.StartsWith($InstallDir, 'OrdinalIgnoreCase')) {
        try { Remove-Item $DataDir -Recurse -Force -ErrorAction Stop } catch { }
    }
}

Write-Output ''
if (Test-Path $InstallDir) {
    $left = @(Get-ChildItem $InstallDir -Recurse -Force -ErrorAction SilentlyContinue).Count
    if ($KeepData) {
        Write-Output 'PCoin Wallet has been uninstalled (chain data kept, as asked).'
    } else {
        Write-Output "PCoin Wallet has been uninstalled, but $left file(s) could not be removed:"
        Write-Output "  $InstallDir"
        Write-Output '  Something still had them open. Reboot and delete that folder by hand.'
    }
} else {
    Write-Output 'PCoin Wallet has been uninstalled.'
}
if ($rescued) {
    Write-Output ''
    Write-Output "Your wallet was saved to: $rescued"
    Write-Output 'Your twelve words on paper rebuild it anywhere; without either, coins only this PC could spend are gone.'
}
Write-Output 'PCOIN_WALLET_UNINSTALL_DONE'
