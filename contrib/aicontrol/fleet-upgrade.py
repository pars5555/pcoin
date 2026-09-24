#!/usr/bin/env python3
"""Upgrade the Windows fleet's PCoinTray.exe to a published release, one step at a time.

    python fleet-upgrade.py probe  [PC ...]                        read-only: exe hash, tray/node up, UAC, mode
    python fleet-upgrade.py stage  VER ZIPSHA EXESHA [PC ...]      PC downloads the release zip in the BACKGROUND,
                                                                   checks both hashes, extracts PCoinTray.exe
    python fleet-upgrade.py status VER [PC ...]                    staging / swap result, exe hash, tray up
    python fleet-upgrade.py swap   VER EXESHA [PC ...]             ELEVATED: stop tray, rename old exe, copy new,
                                                                   restart via the PCoinMiner task
    python fleet-upgrade.py mining [PC ...]                        the node's own getcpuminerinfo, one line

PC defaults to the seven office miners. VER is e.g. 1.4.37; ZIPSHA is the
pcoin-win64-miner.zip hash from the release's SHA256SUMS; EXESHA is the hash of
pcoin-<VER>/PCoinTray.exe inside that zip.

WHY IT IS SHAPED LIKE THIS (each of these was paid for, see CLAUDE.md 7.6-7.8
and memory/fleet-tray-upgrade-without-uac.md):
  * A slow script reads as a DEAD device on this transport, so nothing here
    waits on the device: the download and the swap run as detached processes
    and write a status file; `status` reads it. Poll from HERE.
  * Every script travels base64 via psb64.py, so no quote is mutated in transit.
  * Only PCoinTray.exe is replaced. install.ps1 is NOT run: it rewrites
    pcoin-tray.cfg, and each PC's pool, thread level and payout are its own.
    The node keeps running throughout; the new tray adopts it.
  * The swap needs elevation (the tray runs elevated for large pages). On the
    owner's PCs UAC is "never notify" (ConsentPromptBehaviorAdmin=0), so
    Start-Process -Verb RunAs elevates silently. `probe` prints CPBA: on a PC
    where it is not 0 the swap would show a UAC prompt nobody answers -- do not
    use this there.
  * The old exe is kept as PCoinTray.exe.v<old>-<timestamp>: rename it back to
    roll back. Nothing is deleted.
  * getcpuminerinfo's rate field is `hashespersec` (there is no `hashrate`),
    and right after a restart it reads 0 while fast mode rebuilds its dataset.

First used 2026-09-24 for v1.4.37: canary 5SH2116, then the other six.
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
FLEET = ["MAKAVST", "AKHQ7BJ", "5SH2116", "I5UT4OJ", "JTIIJES", "VHQ1C8A", "6QIOQ5J"]

PROBE = r"""
$ErrorActionPreference = 'SilentlyContinue'
$exe = 'C:\PCoin\PCoinTray.exe'
$f = Get-Item $exe
$h = (Get-FileHash $exe -Algorithm SHA256).Hash.Substring(0,12)
$tray = Get-Process PCoinTray
$node = Get-Process bitcoind
$cpba = (Get-ItemProperty 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System').ConsentPromptBehaviorAdmin
$keys = (Get-Content 'C:\PCoin\pcoin-tray.cfg' | Where-Object { $_ -match '^(poolurl|percent|threads)=' }) -join ' '
Write-Output ("{0} | exe {1} bytes sha {2} | tray {3} | node {4} | CPBA {5} | {6}" -f $env:COMPUTERNAME, $f.Length, $h, [bool]$tray, [bool]$node, $cpba, $keys)
"""

STAGE = r"""
$dir = 'C:\PCoin\upd@TAG@'
New-Item -ItemType Directory -Force -Path $dir | Out-Null
Remove-Item "$dir\status.txt" -ErrorAction SilentlyContinue
$stage = @'
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$dir = 'C:\PCoin\upd@TAG@'
try {
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $zip = Join-Path $dir 'miner.zip'
  Invoke-WebRequest -UseBasicParsing -Uri 'https://github.com/pars5555/pcoin/releases/download/v@VER@/pcoin-win64-miner.zip' -OutFile $zip
  $zh = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
  if ($zh -ne '@ZIPSHA@') { throw "zip hash is $zh" }
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $z = [IO.Compression.ZipFile]::OpenRead($zip)
  try {
    $e = $z.Entries | Where-Object { $_.FullName -eq 'pcoin-@VER@/PCoinTray.exe' }
    if (-not $e) { throw 'PCoinTray.exe not in the zip' }
    [IO.Compression.ZipFileExtensions]::ExtractToFile($e, (Join-Path $dir 'PCoinTray.exe'), $true)
  } finally { $z.Dispose() }
  $eh = (Get-FileHash (Join-Path $dir 'PCoinTray.exe') -Algorithm SHA256).Hash.ToLower()
  if ($eh -ne '@EXESHA@') { throw "exe hash is $eh" }
  Set-Content (Join-Path $dir 'status.txt') "READY $eh"
} catch { Set-Content (Join-Path $dir 'status.txt') ('FAILED ' + $_.Exception.Message) }
'@
Set-Content -Path "$dir\stage.ps1" -Value $stage -Encoding UTF8
Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$dir\stage.ps1"
Write-Output "$env:COMPUTERNAME staging started"
"""

SWAP = r"""
$dir = 'C:\PCoin\upd@TAG@'
$st = Get-Content "$dir\status.txt" -ErrorAction SilentlyContinue
if ($st -ne 'READY @EXESHA@') { Write-Output "$env:COMPUTERNAME NOT READY: $st"; return }
Remove-Item "$dir\swap.txt" -ErrorAction SilentlyContinue
$swap = @'
$dir = 'C:\PCoin\upd@TAG@'
try {
  $new = Join-Path $dir 'PCoinTray.exe'
  if ((Get-FileHash $new -Algorithm SHA256).Hash.ToLower() -ne '@EXESHA@') { throw 'staged exe hash changed' }
  $old = (Get-FileHash 'C:\PCoin\PCoinTray.exe' -Algorithm SHA256).Hash.Substring(0,8).ToLower()
  Get-Process PCoinTray -ErrorAction SilentlyContinue | Stop-Process -Force
  Start-Sleep -Seconds 3
  Rename-Item 'C:\PCoin\PCoinTray.exe' ('PCoinTray.exe.v' + $old + '-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  Copy-Item $new 'C:\PCoin\PCoinTray.exe'
  $h = (Get-FileHash 'C:\PCoin\PCoinTray.exe' -Algorithm SHA256).Hash.ToLower()
  schtasks /run /tn PCoinMiner | Out-Null
  Start-Sleep -Seconds 8
  if (-not (Get-Process PCoinTray -ErrorAction SilentlyContinue)) { schtasks /run /tn PCoinMiner | Out-Null; Start-Sleep -Seconds 8 }
  $up = [bool](Get-Process PCoinTray -ErrorAction SilentlyContinue)
  Set-Content (Join-Path $dir 'swap.txt') "SWAPPED $h trayRunning=$up"
} catch { Set-Content (Join-Path $dir 'swap.txt') ('FAILED ' + $_.Exception.Message) }
'@
Set-Content -Path "$dir\swap.ps1" -Value $swap -Encoding UTF8
Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -ArgumentList '-NoProfile','-ExecutionPolicy','Bypass','-File',"$dir\swap.ps1"
Write-Output "$env:COMPUTERNAME swap started (elevated)"
"""

STATUS = r"""
$dir = 'C:\PCoin\upd@TAG@'
$t = Get-Process PCoinTray -ErrorAction SilentlyContinue | Select-Object -First 1
$h = (Get-FileHash 'C:\PCoin\PCoinTray.exe' -Algorithm SHA256).Hash.Substring(0,12)
Write-Output ("{0} | stage: {1} | swap: {2} | exe now {3} | tray running {4} since {5}" -f $env:COMPUTERNAME, (Get-Content "$dir\status.txt" -ErrorAction SilentlyContinue), (Get-Content "$dir\swap.txt" -ErrorAction SilentlyContinue), $h, [bool]$t, $t.StartTime)
"""

MINING = r"""
$cli = @('C:\PCoin\bitcoin-cli.exe', 'C:\PCoin\bin\bitcoin-cli.exe') | Where-Object { Test-Path $_ } | Select-Object -First 1
$j = & $cli -datadir=C:\PCoin\data getcpuminerinfo 2>&1 | Out-String
try { $m = $j | ConvertFrom-Json; $s = "mining=$($m.mining) H/s=$([math]::Round([double]$m.hashespersec)) threads=$($m.threads) mode=$($m.mode) pool=$($m.pool) poolstate=$($m.poolstate) shares=$($m.sharesaccepted)/$($m.sharessubmitted) largepages=$($m.largepages)" } catch { $s = 'miner info unreadable' }
Write-Output ("{0} | {1}" -f $env:COMPUTERNAME, $s)
"""


def run(pc, script):
    r = subprocess.run([sys.executable, os.path.join(HERE, "psb64.py"), pc, "-"], input=script,
                       capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
    lines = [l for l in r.stdout.splitlines() if l.startswith("DESKTOP") or "NOT READY" in l]
    print("\n".join(lines) if lines else "%s: no answer (%s)" % (pc, (r.stderr or r.stdout).strip()[:160]))


def main(a):
    if len(a) < 2 or a[1] not in ("probe", "stage", "status", "swap", "mining"):
        sys.exit(__doc__)
    cmd, rest = a[1], a[2:]
    fill = {}
    if cmd == "stage":
        fill = {"@VER@": rest[0], "@TAG@": rest[0].replace(".", ""), "@ZIPSHA@": rest[1].lower(), "@EXESHA@": rest[2].lower()}
        rest = rest[3:]
    elif cmd == "swap":
        fill = {"@VER@": rest[0], "@TAG@": rest[0].replace(".", ""), "@EXESHA@": rest[1].lower()}
        rest = rest[2:]
    elif cmd == "status":
        fill = {"@TAG@": rest[0].replace(".", "")}
        rest = rest[1:]
    script = {"probe": PROBE, "stage": STAGE, "status": STATUS, "swap": SWAP, "mining": MINING}[cmd]
    for k, v in fill.items():
        script = script.replace(k, v)
    for pc in (rest or FLEET):
        run(pc, script)


if __name__ == "__main__":
    main(sys.argv)
