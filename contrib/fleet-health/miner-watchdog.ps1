# miner-watchdog.ps1 - keep a Windows miner mining without anyone watching it.
#
# WHY THIS EXISTS. On 2026-10-08 DESKTOP-VHQ1C8A (office01) stopped mining and
# nobody noticed for two days. The chain of events is entirely ordinary:
#
#   1. `C:\PCoin\data\peers.dat` was corrupt (checksum mismatch). Bitcoin Core
#      REFUSES to start in that state on purpose - `src/addrdb.cpp:217` tells the
#      operator to move the file out of the way - so bitcoind exits at startup,
#      every time.
#   2. The tray tried once, logged `node did not start with fast mode (Exited),
#      retrying without it`, the retry failed for the same reason, and it stopped
#      trying.
#   3. Nothing else on the machine notices a node that is simply absent: the tray
#      still runs, the scheduled task still exists, the desktop shortcut still
#      points at a real file. Pool mining lives INSIDE bitcoind, so no node means
#      no hashing at all - and no share ever reaching the pool to give it away.
#
# This script is the missing watchdog. It is deliberately allowed to do exactly
# two things, both of which have actually happened:
#
#   A. bitcoind is NOT running  -> quarantine a corrupt peers.dat if that is what
#      the log says, then start bitcoind WITH `-randomxfastmode`.
#   B. bitcoind IS running but fell back to light mode while pcoin-tray.cfg still
#      asks for fast (DESKTOP-6QIOQ5J did this on 2026-10-09: 8 GB of RAM, only
#      1.8 GB free, fast mode needs ~3 GB) -> restart it, but only when the
#      stated reason is NOT memory, because that one is real and restarting only
#      burns the miner's uptime.
#
# It never starts a second node (it checks the RPC port first), it is
# rate-limited, and every action it takes is appended to C:\PCoin\watchdog.log.
#
# Install (per PC, from an elevated shell):
#   powershell -ExecutionPolicy Bypass -File C:\PCoin\miner-watchdog.ps1 -Install
# or run it by hand for a dry look:
#   powershell -ExecutionPolicy Bypass -File C:\PCoin\miner-watchdog.ps1

param([switch]$Install)

$ErrorActionPreference = 'SilentlyContinue'
$PCoin = 'C:\PCoin'
$DD    = "$PCoin\data"
$CLI   = "$PCoin\bitcoin-cli.exe"
$NODE  = "$PCoin\bitcoind.exe"
$CFG   = "$PCoin\pcoin-tray.cfg"
$LOG   = "$PCoin\watchdog.log"

function Write-WdLog($msg) {
    $line = "{0} {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $msg
    Add-Content -Path $LOG -Value $line
    # keep the log from growing forever
    $f = Get-Item $LOG
    if ($f -and $f.Length -gt 1048576) {
        $tail = Get-Content $LOG -Tail 500
        Set-Content -Path $LOG -Value $tail
    }
}

function Test-RpcUp {
    return [bool](Get-NetTCPConnection -LocalPort 9443 -State Listen -ErrorAction SilentlyContinue)
}

function Start-NodeFast {
    Start-Process -FilePath $NODE -ArgumentList '-datadir=C:\PCoin\data', '-randomxfastmode' -WindowStyle Hidden
}

if ($Install) {
    # Creating a task with /rl HIGHEST needs elevation. Run this -Install through
    # Start-Process -Verb RunAs, which on these PCs elevates silently
    # (ConsentPromptBehaviorAdmin=0), or from an elevated shell by hand.
    $task = 'PCoinWatchdog'
    schtasks /delete /tn $task /f 2>$null | Out-Null
    $ps = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $out = schtasks /create /tn $task /sc minute /mo 10 /rl HIGHEST /f `
        /tr "$ps -NoProfile -ExecutionPolicy Bypass -File $PCoin\miner-watchdog.ps1" 2>&1
    if ($LASTEXITCODE -eq 0) {
        # Report the truth: a log line that says "installed" while schtasks
        # returned Access denied is worse than no log at all.
        Write-WdLog "watchdog task $task installed (every 10 minutes, highest privileges)"
        Write-Output "INSTALL-OK"
    } else {
        Write-WdLog "watchdog task install FAILED: $out"
        Write-Output "INSTALL-FAILED: $out"
    }
    exit $LASTEXITCODE
}

# --- A. is the node running at all? -----------------------------------------
if (-not (Get-Process bitcoind -ErrorAction SilentlyContinue)) {
    $tail = (Get-Content "$DD\debug.log" -Tail 60 -ErrorAction SilentlyContinue) -join "`n"
    if ($tail -match 'Invalid or corrupt peers.dat') {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        Move-Item "$DD\peers.dat" "$DD\peers.dat.corrupt-$stamp" -Force
        Write-WdLog "node down: corrupt peers.dat found in the log, quarantined as peers.dat.corrupt-$stamp"
    }
    if (-not (Test-RpcUp)) {
        Start-NodeFast
        Write-WdLog "node was not running and no RPC listener: started bitcoind with -randomxfastmode"
    } else {
        Write-WdLog "node process absent but RPC 9443 is listening - something is starting it, leaving it alone"
    }
    exit 0
}

# --- B. running, but on the slow path? --------------------------------------
$mi = (& $CLI -datadir=$DD getcpuminerinfo 2>$null) -join ' '
if ($mi -match '"mode"\s*:\s*"light"') {
    $wantsFast = (Get-Content $CFG -ErrorAction SilentlyContinue | Select-String '^fastmode=1')
    $memoryReason = $mi -match 'MiB free|MiB is available|needs .* MiB'
    if ($wantsFast -and -not $memoryReason) {
        # one restart per hour, at most - the miner's own auto-tune is better at this than we are
        $last = (Get-Content $LOG -ErrorAction SilentlyContinue | Select-String 'restarted for light mode' | Select-Object -Last 1)
        $recent = $false
        if ($last) {
            $when = [datetime]::ParseExact(($last.Line -split ' ')[0..1] -join ' ', 'yyyy-MM-dd HH:mm:ss', $null)
            $recent = ((Get-Date) - $when).TotalMinutes -lt 60
        }
        if (-not $recent) {
            & $CLI -datadir=$DD stop | Out-Null
            Start-Sleep 12
            Start-NodeFast
            Write-WdLog "node restarted for light mode (cfg asks fast, reason is not memory)"
        }
    } elseif ($memoryReason) {
        Write-WdLog "light mode is a real memory shortage, not touched (nothing to fix by restarting)"
    }
}

# --- C. the miner unit: node up but nothing hashing -------------------------
$threads = (& $CLI -datadir=$DD getcpuminerinfo 2>$null | Out-String)
if ($threads -match '"mining"\s*:\s*true' -and $threads -match '"threads"\s*:\s*0') {
    Write-WdLog "node reports mining with 0 threads - the tray will reconcile on its next pass"
}