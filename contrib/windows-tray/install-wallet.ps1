# PCoin Wallet installer (Windows).
#
#   irm https://pc.am/dl/install-wallet.ps1 | iex
#   powershell -ExecutionPolicy Bypass -File install-wallet.ps1 [-ZipPath x.zip]
#
# Installs PCoinWallet.exe with its own node binaries into its own folder,
# puts a shortcut on the desktop and in the Start menu, lists the program in
# Settings > Apps, and opens it. It does NOT touch the PCoin miner: a machine
# may have both, and each keeps its own folder, its own node, its own data,
# its own RPC port (wallet 9543, miner 9443) and its own recovery phrase.
#
# Nothing here mines, nothing here needs to autostart, and nothing here needs
# a firewall rule: the wallet's node does not accept inbound connections.
param(
    # C:\PCoinWallet when we can create it; otherwise a per-user location,
    # because creating a folder at the root of C: needs administrator rights.
    [string]$InstallDir = '',
    [string]$DataDir = '',
    # Bump both together on a WALLET release. $Version selects the release tag
    # the zip is fetched from, so the URL and the hash move as one. The install
    # aborts on a mismatch, so a forgotten bump breaks every new install
    # loudly rather than installing something unverified.
    [string]$Version = '1.4.0',
    [string]$Sha256 = '6cc60cdf13968dcea16eba5b9c9a550204195326c4976972d670fa2c2b54d0a0',
    # Install from a local zip instead of downloading (offline / testing a
    # build before it is published). Its SHA-256 is still checked against
    # $Sha256 when one is given.
    [string]$ZipPath = '',
    # Download from somewhere other than the GitHub release (testing).
    [string]$ZipUrl = '',
    [switch]$NoStart,
    # Set by the elevated relaunch so it cannot ask again and loop.
    [switch]$NoElevate,
    # Re-download and re-extract even when this exact version is installed.
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

if (-not $InstallDir) {
    $InstallDir = 'C:\PCoinWallet'
    if (-not (Test-Path $InstallDir)) {
        try {
            New-Item -ItemType Directory -Path $InstallDir -Force -ErrorAction Stop | Out-Null
        } catch {
            $InstallDir = Join-Path $env:LOCALAPPDATA 'PCoinWallet'
            Write-Output "  C:\PCoinWallet needs admin; installing to $InstallDir instead"
        }
    }
}
$InstallDir = [IO.Path]::GetFullPath($InstallDir).TrimEnd('\')
$name = 'pcoin-win64-wallet.zip'
if (-not $ZipUrl) { $ZipUrl = "https://github.com/pars5555/pcoin/releases/download/v$Version/$name" }
# Beside the program, not %LOCALAPPDATA%: remote management tools often run
# with a service's environment, where that variable points at the system
# profile, and the data folder must be the same wherever this is launched from.
if (-not $DataDir) { $DataDir = Join-Path $InstallDir 'data' }
$DataDir = [IO.Path]::GetFullPath($DataDir).TrimEnd('\')

Write-Output "PCoin Wallet $Version installer"

$script:IsAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

New-Item -ItemType Directory -Force $InstallDir | Out-Null

# --- elevate (optional) --------------------------------------------------
# Elevation only ADDS a Defender exclusion and the C:\PCoinWallet location;
# everything else works without it. Declining UAC drops through.
if (-not $script:IsAdmin -and -not $NoElevate) {
    Write-Output ''
    Write-Output '  Elevating for the full install (Defender exclusion, C:\PCoinWallet).'
    Write-Output '  Approve the UAC prompt - or decline it to install for this user only.'
    $extra = ''
    if ($Force) { $extra = $extra + ' -Force' }
    if ($NoStart) { $extra = $extra + ' -NoStart' }
    if ($ZipPath) { $extra = $extra + " -ZipPath '$ZipPath'" }
    if ($ZipUrl -and $PSBoundParameters.ContainsKey('ZipUrl')) { $extra = $extra + " -ZipUrl '$ZipUrl'" }
    if ($PSBoundParameters.ContainsKey('Sha256')) { $extra = $extra + " -Sha256 '$Sha256'" }
    if ($PSBoundParameters.ContainsKey('Version')) { $extra = $extra + " -Version '$Version'" }
    $self = $MyInvocation.MyCommand.Path
    if ($self -and (Test-Path $self)) {
        $inner = "try { & '$self' -NoElevate$extra } catch { Write-Host `$_.Exception.Message -ForegroundColor Red; Start-Sleep 10 }"
    } else {
        $inner = "try { & ([scriptblock]::Create((irm https://pc.am/dl/install-wallet.ps1))) -NoElevate$extra } catch { Write-Host `$_.Exception.Message -ForegroundColor Red; Start-Sleep 10 }"
    }
    try {
        Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-Command',$inner
        Write-Output '  Continuing in the elevated window. You can close this one.'
        return
    } catch {
        Write-Output '  Elevation declined; continuing without it.'
    }
    Write-Output ''
}

# --- stop a running copy (ours only) -------------------------------------
# The wallet exe is stopped by name; ITS node is asked to stop through its own
# data folder, which selects its own RPC port. The miner's node, if any, is on
# another folder and another port and is never addressed.
Get-Process PCoinWallet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$cliPath = Join-Path $InstallDir 'bitcoin-cli.exe'
if ((Test-Path $cliPath) -and (Test-Path $DataDir)) {
    try { & $cliPath -datadir="$DataDir" stop 2>&1 | Out-Null } catch { }
    for ($i = 0; $i -lt 30; $i++) {
        $ours = @()
        try {
            $ours = Get-CimInstance Win32_Process -Filter "Name = 'bitcoind.exe'" -ErrorAction Stop |
                Where-Object { $_.CommandLine -and $_.CommandLine.IndexOf($DataDir, [StringComparison]::OrdinalIgnoreCase) -ge 0 }
        } catch { }
        if (-not $ours) { break }
        Start-Sleep -Seconds 1
    }
}

# --- download and verify -------------------------------------------------
$zip = Join-Path $env:TEMP $name
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$verFile = Join-Path $InstallDir '.pcoin_wallet_version'
$sameVer = (-not $ZipPath) -and (-not $Force) -and (Test-Path $verFile) -and `
    ((Get-Content $verFile -ErrorAction SilentlyContinue) -eq $Version) -and `
    (Test-Path (Join-Path $InstallDir 'bitcoind.exe')) -and `
    (Test-Path (Join-Path $InstallDir 'PCoinWallet.exe'))
if ($sameVer) {
    Write-Output "  already at v$Version - skipping download (use -Force to reinstall)"
} else {
    if ($ZipPath) {
        if (-not (Test-Path $ZipPath)) { throw "ZipPath not found: $ZipPath" }
        Write-Output "  using local zip: $ZipPath"
        Copy-Item -LiteralPath $ZipPath -Destination $zip -Force
    } else {
        Write-Output "  downloading $ZipUrl"
        Invoke-WebRequest -Uri $ZipUrl -OutFile $zip -UseBasicParsing
    }
    $got = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
    if ($Sha256) {
        if ($got -ne $Sha256.ToLower()) { throw "SHA256 mismatch: got $got" }
        Write-Output '  sha256 ok'
    } elseif ($ZipPath) {
        # A local file the operator chose: report the hash, do not refuse.
        Write-Output "  sha256 $got (local zip, no pinned hash to compare against)"
    } else {
        # A download with nothing to check it against is not installed. This
        # is what a forgotten $Sha256 bump looks like, and it must fail loudly
        # rather than put an unverified binary in front of a wallet.
        throw "no expected SHA-256 is pinned for v$Version (got $got); refusing to install an unverified download"
    }

    $tmp = Join-Path $env:TEMP 'pcoin-wallet-unpack'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $zip -DestinationPath $tmp -Force

    # The archive lays the node out as pcoin-<ver>\bin\*.exe; the app looks
    # beside itself first and in bin\ second, and every line below expects the
    # flat layout. Find bitcoind.exe wherever it is and flatten from there.
    $src = Get-ChildItem -Path $tmp -Filter 'bitcoind.exe' -Recurse -File | Select-Object -First 1
    if (-not $src) { throw "bitcoind.exe not found in $name - archive layout unexpected" }
    $srcDir = $src.DirectoryName
    foreach ($attempt in 1..6) {
        try {
            Copy-Item (Join-Path $srcDir '*') $InstallDir -Force -Recurse
            foreach ($f in @('PCoinWallet.exe', 'uninstall-wallet.ps1', 'START HERE.txt', 'COPYING')) {
                Get-ChildItem -Path $tmp -Filter $f -Recurse -File | Select-Object -First 1 |
                    ForEach-Object { Copy-Item $_.FullName $InstallDir -Force }
            }
            break
        } catch {
            if ($attempt -eq 6) { throw }
            Get-Process PCoinWallet -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
            Start-Sleep -Seconds 5
        }
    }
    Write-Output "  installed to $InstallDir"
    Set-Content -Path $verFile -Value $Version -Encoding ascii
}
if (-not (Test-Path (Join-Path $InstallDir 'PCoinWallet.exe'))) {
    throw "PCoinWallet.exe is missing from $name - archive layout unexpected"
}

# --- config --------------------------------------------------------------
# pcoin-wallet.cfg holds ONLY the data folder. The recovery phrase
# (pcoin-seed.dat / pcoin-seed.info) and the address book are never touched
# by this script; they belong to the person, not to the install.
New-Item -ItemType Directory -Force $DataDir | Out-Null
@("datadir=$DataDir") | Set-Content -Encoding ascii (Join-Path $InstallDir 'pcoin-wallet.cfg')
# The node's own config. Written only when absent: the app appends any missing
# key at every start (see WalletConfig in PCoinWallet.cs), and a file the
# owner edited stays theirs.
$conf = Join-Path $DataDir 'pcoin.conf'
if (-not (Test-Path $conf)) {
    @('# PCoin Wallet node configuration. The wallet adds any missing line at start; edit freely.',
      'server=1', 'rpcport=9543', 'listen=0', 'dbcache=300',
      'fallbackfee=0.00001', 'changetype=bech32',
      'addnode=35.239.156.16:9444', 'addnode=178.105.3.51:9444', 'addnode=152.53.171.190:9444') |
        Set-Content -Encoding ascii $conf
}
Write-Output "  data directory: $DataDir"

# --- best-effort host tweaks (need admin; not fatal) ---------------------
try {
    Add-MpPreference -ExclusionPath $InstallDir, $DataDir -ErrorAction Stop
    Write-Output '  defender exclusion added'
} catch { Write-Output '  defender exclusion skipped (needs admin)' }

# --- shortcuts -----------------------------------------------------------
try {
    $ws = New-Object -ComObject WScript.Shell
    $targets = @()
    $desk = [Environment]::GetFolderPath('Desktop')
    if (-not $desk -or $desk -match 'systemprofile') {
        if ($env:USERNAME) {
            $c = Join-Path (Join-Path $env:SystemDrive 'Users') (Join-Path $env:USERNAME 'Desktop')
            if (Test-Path $c) { $desk = $c }
        }
    }
    if ($desk -and (Test-Path $desk)) { $targets += (Join-Path $desk 'PCoin Wallet.lnk') }
    $menu = [Environment]::GetFolderPath('Programs')
    if ($menu -and (Test-Path $menu) -and $menu -notmatch 'systemprofile') { $targets += (Join-Path $menu 'PCoin Wallet.lnk') }
    foreach ($t in $targets) {
        $l = $ws.CreateShortcut($t)
        $l.TargetPath = (Join-Path $InstallDir 'PCoinWallet.exe')
        $l.WorkingDirectory = $InstallDir
        $l.Description = 'PCoin Wallet'
        $l.Save()
        Write-Output ('  shortcut: ' + $t)
    }
} catch {
    Write-Output ('  shortcuts skipped: ' + $_.Exception.Message)
}

# --- Settings > Apps entry -----------------------------------------------
# Written only when the uninstaller is actually on disk: an UninstallString
# pointing at a file that was never installed is a button that does nothing.
try {
    $unins = Join-Path $InstallDir 'uninstall-wallet.ps1'
    if (Test-Path $unins) {
        $arpRoot = if ($script:IsAdmin) { 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinWallet' }
                   else                 { 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\PCoinWallet' }
        if (-not (Test-Path $arpRoot)) { New-Item -Path $arpRoot -Force | Out-Null }
        $ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
        $q  = '"' + $unins + '"'
        $kb = 0
        try { $kb = [int](((Get-ChildItem $InstallDir -File -ErrorAction SilentlyContinue |
                            Measure-Object Length -Sum).Sum) / 1024) } catch { }
        $vals = @{
            DisplayName     = 'PCoin Wallet'
            DisplayVersion  = $Version
            Publisher       = 'PCoin'
            InstallLocation = $InstallDir
            URLInfoAbout    = 'https://pc.am'
            UninstallString = "$ps -NoProfile -ExecutionPolicy Bypass -File $q"
            QuietUninstallString = "$ps -NoProfile -ExecutionPolicy Bypass -File $q -Yes"
            NoModify        = 1
            NoRepair        = 1
            InstallDate     = (Get-Date -Format 'yyyyMMdd')
        }
        if ($kb -gt 0) { $vals['EstimatedSize'] = $kb }
        $ico = Join-Path $InstallDir 'PCoinWallet.exe'
        if (Test-Path $ico) { $vals['DisplayIcon'] = $ico }
        foreach ($k in $vals.Keys) {
            $t = if ($vals[$k] -is [int]) { 'DWord' } else { 'String' }
            New-ItemProperty -Path $arpRoot -Name $k -Value $vals[$k] -PropertyType $t -Force | Out-Null
        }
        Write-Output ('  listed in Settings > Apps (' + $(if ($script:IsAdmin) { 'all users' } else { 'this user' }) + ')')
    } else {
        Write-Output '  Apps-list entry skipped: uninstall-wallet.ps1 is not in this build'
    }
} catch {
    Write-Output ('  Apps-list entry skipped: ' + $_.Exception.Message)
}

# --- open it -------------------------------------------------------------
# From an interactive desktop, just start it. From a service or a remote
# management session (session 0), a window would be invisible and the app
# refuses to start there, so hand it to the logged-on user's desktop through a
# one-shot interactive scheduled task, then remove the task.
if (-not $NoStart) {
    $exe = Join-Path $InstallDir 'PCoinWallet.exe'
    $sid = 0
    try { $sid = (Get-Process -Id $PID).SessionId } catch { }
    if ($sid -ne 0 -and [Environment]::UserInteractive) {
        Start-Process -FilePath $exe -WorkingDirectory $InstallDir
        Write-Output '  PCoin Wallet opened'
    } else {
        $who = ''
        try { $who = (Get-CimInstance Win32_ComputerSystem).UserName } catch { }
        if ($who) {
            cmd /c "schtasks /create /tn PCoinWalletLaunch /tr `"$exe`" /sc once /st 23:59 /ru `"$who`" /it /f >nul 2>nul" | Out-Null
            cmd /c 'schtasks /run /tn PCoinWalletLaunch >nul 2>nul' | Out-Null
            Start-Sleep -Seconds 3
            cmd /c 'schtasks /delete /tn PCoinWalletLaunch /f >nul 2>nul' | Out-Null
            Write-Output "  PCoin Wallet opened on $who's desktop"
        } else {
            Write-Output '  no interactive user found; open PCoin Wallet from the desktop shortcut'
        }
    }
}
Write-Output 'PCOIN_WALLET_INSTALL_DONE'
