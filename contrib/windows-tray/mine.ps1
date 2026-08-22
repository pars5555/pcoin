<#
  PCoin: install and start pool mining, in one command.

    & ([scriptblock]::Create((irm https://pc.am/dl/mine.ps1))) -Address pc1qyour... -Threads 4

  WHY THIS EXISTS. install.ps1 installs; the pc.am page then shows a
  bitcoin-cli line to start mining. Run the second without the first and you get
  "is not recognized as the name of a cmdlet" pointing at a path that was never
  created -- the fallback location, which only looks wrong. This does both, in
  order, and refuses to skip the parts that matter.

  ADMIN IS OPTIONAL AND THAT IS DELIBERATE. Admin gets you C:\PCoin; without it
  everything lands in %LOCALAPPDATA%\PCoin and works identically. A one-liner
  that demands elevation is a one-liner most people will not run, so this
  reports which mode it is in rather than refusing.

  WHAT IT WILL NOT DO:
    * mine before the node has synced. Mining on an unsynced node builds blocks
      on a chain nobody else has -- they are orphaned and pay nothing.
    * accept a payout address the NODE has not validated. No regex: a typo that
      passes a pattern check still sends every reward somewhere unspendable.
#>
param(
    [string]$Address = '',
    [int]$Threads = 0,
    [string]$Pool = 'pool.pc.am:3333',
    [int]$SyncTimeoutMin = 0,          # 0 = wait indefinitely
    [switch]$SkipInstall
)
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Say  ($m) { Write-Host "  $m" }
function Warn ($m) { Write-Host "  $m" -ForegroundColor Yellow }
function Die  ($m) { Write-Host "  $m" -ForegroundColor Red; exit 1 }

$isAdmin = ([Security.Principal.WindowsPrincipal] `
    [Security.Principal.WindowsIdentity]::GetCurrent()
  ).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)

Write-Host ''
Say ("Running {0}." -f $(if ($isAdmin) { 'as administrator -- will use C:\PCoin' }
                         else { 'WITHOUT admin -- will use ' + $env:LOCALAPPDATA + '\PCoin (this is fine)' }))

# ---- 1. install -----------------------------------------------------------
if (-not $SkipInstall) {
    Say 'Installing PCoin (downloads the release zip and verifies its SHA-256)...'
    $installer = 'https://pc.am/dl/install.ps1'
    try   { $src = (Invoke-WebRequest $installer -UseBasicParsing).Content }
    catch { Die "Could not fetch $installer -- $($_.Exception.Message)" }
    # -Threads 0: install only. Mining is started below, AFTER the sync gate.
    & ([scriptblock]::Create($src)) -Threads 0
    Say 'Install step finished.'
}

# ---- 2. locate what we just installed -------------------------------------
$root = @("C:\PCoin", (Join-Path $env:LOCALAPPDATA 'PCoin')) |
        Where-Object { Test-Path (Join-Path $_ 'bitcoin-cli.exe') } |
        Select-Object -First 1
if (-not $root) {
    Die ('bitcoin-cli.exe is not in C:\PCoin or ' + $env:LOCALAPPDATA + '\PCoin. ' +
         'The install did not complete -- scroll up for its error, and do not re-run the mining command yet.')
}
$cli  = Join-Path $root 'bitcoin-cli.exe'
$data = Join-Path $root 'data'
Say "Using $root"

function Rpc {
    param([Parameter(ValueFromRemainingArguments = $true)]$Args)
    $out = & $cli "-datadir=$data" @Args 2>&1
    if ($LASTEXITCODE -ne 0) { throw ($out | Out-String).Trim() }
    return ($out | Out-String).Trim()
}

# ---- 3. wait for the node -------------------------------------------------
Say 'Waiting for the node to answer...'
$deadline = (Get-Date).AddMinutes(3)
while ($true) {
    try { Rpc getblockchaininfo | Out-Null; break } catch {
        if ((Get-Date) -gt $deadline) {
            Die ('The node is not answering RPC after 3 minutes. Start it with:  ' +
                 "`"$root\bitcoind.exe`" -datadir=`"$data`"")
        }
        Start-Sleep -Seconds 5
    }
}
Say 'Node is up.'

# ---- 4. payout address, validated BY THE NODE -----------------------------
while ($true) {
    if (-not $Address) {
        Write-Host ''
        Say 'Where should your mining rewards be paid?'
        Say 'Paste a PCoin address you control -- it starts with pc1q. The node checks it before we start.'
        $Address = (Read-Host '  Payout address').Trim()
    }
    if (-not $Address) { Warn 'An address is required -- block rewards have to go somewhere.'; continue }
    try {
        $v = Rpc validateaddress $Address | ConvertFrom-Json
        if ($v.isvalid) { Say "Payout address validated by the node: $Address"; break }
        Warn "The node says that is not a valid PCoin address: $Address"
        $Address = ''
    } catch {
        # An RPC that FAILED has not told us the address is bad. Retry; never
        # treat an unanswered question as a rejection, or as an acceptance.
        Warn "Could not check the address yet ($($_.Exception.Message.Split([char]10)[0])). Retrying..."
        Start-Sleep -Seconds 5
    }
}

# ---- 5. the sync gate -----------------------------------------------------
Say 'Checking sync. Mining before the node is synced produces orphans that pay nothing.'
$syncDeadline = if ($SyncTimeoutMin -gt 0) { (Get-Date).AddMinutes($SyncTimeoutMin) } else { [datetime]::MaxValue }
while ($true) {
    try   { $i = Rpc getblockchaininfo | ConvertFrom-Json }
    catch { Start-Sleep -Seconds 10; continue }
    if (-not $i.initialblockdownload) { Say "Synced at height $($i.blocks)."; break }
    $pct = [math]::Round(100 * [double]$i.verificationprogress, 2)
    Say ("  syncing... height {0}, {1}% verified" -f $i.blocks, $pct)
    if ((Get-Date) -gt $syncDeadline) {
        Die 'Still syncing when the timeout expired. Re-run this command later; nothing is broken.'
    }
    Start-Sleep -Seconds 20
}

# ---- 6. mine --------------------------------------------------------------
if ($Threads -le 0) {
    # Half the cores by default: enough to earn, and it leaves the machine
    # usable. Someone who wants the whole box can say so.
    $cores    = [Environment]::ProcessorCount
    $suggest  = [math]::Max(1, [math]::Floor($cores / 2))
    $answer   = (Read-Host "  How many CPU threads should mine? $cores available, press Enter for $suggest").Trim()
    if (-not $answer) {
        $Threads = $suggest
    } elseif ($answer -match '^[0-9]+$' -and [int]$answer -ge 1) {
        $Threads = [int]$answer
        if ($Threads -gt $cores) {
            Warn "$Threads is more than the $cores cores you have; the node caps it at $cores."
        }
    } else {
        $Threads = $suggest
        Warn "'$answer' is not a thread count. Using $suggest."
    }
}
Say "Starting pool mining on $Pool with $Threads thread(s)..."
try { Rpc startpoolmining $Pool $Address $Threads | Out-Null }
catch { Die "startpoolmining failed: $($_.Exception.Message)" }

Start-Sleep -Seconds 5
try {
    $s = Rpc getcpuminerinfo | ConvertFrom-Json
    if ($s.mining) {
        Write-Host ''
        Say "MINING. threads=$($s.threads)  pool=$Pool"
        Say "Paid to: $Address"
        Say "Check anytime:  `"$cli`" -datadir=`"$data`" getcpuminerinfo"
        Say "Stop with:      `"$cli`" -datadir=`"$data`" stopmining"
        Write-Host ''
    } else {
        Warn 'The node accepted the command but reports mining=false. Check the debug log:'
        Warn "  $data\debug.log"
    }
} catch {
    Warn "Started, but could not read back status: $($_.Exception.Message)"
}
