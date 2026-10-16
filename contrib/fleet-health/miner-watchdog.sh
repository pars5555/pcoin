#!/bin/bash
# miner-watchdog.sh - keep a Linux miner mining when nobody is watching it.
#
# The Linux side of contrib/fleet-health/miner-watchdog.ps1, and it exists for
# the same measured reason: a miner that stops has no way to say so, and pool
# mining lives INSIDE bitcoind, so a node that will not start means no hashing
# and no shares - invisible from the pool until someone counts machines.
#
# Two failures it repairs, both of which have actually happened in the fleet:
#
#   A. pcoind will not stay up because `~/.pcoin/peers.dat` is corrupt. The node
#      refuses to start in that state by design (`src/addrdb.cpp:217`: "move the
#      file out of the way ... to have a new one created on the next start") and
#      systemd then restarts it forever - 52,727 restarts were counted on musho
#      in one incident while nothing was being mined.
#   B. the node is healthy and synced but nothing is hashing, i.e. 0 pcminer
#      threads while pcoin-miner.service is active. The supervisor is the ON
#      switch, so restarting IT is the fix; `bitcoin-cli stopmining` is not.
#
# Deliberately conservative: it never touches a node that is still in initial
# block download (the supervisor waits for that itself), it restarts the
# supervisor at most once every 30 minutes, and it logs every action.
#
# Install (per user):
#   install -Dm755 miner-watchdog.sh ~/.local/bin/pcoin-watchdog
#   install -Dm644 pcoin-watchdog.service pcoin-watchdog.timer ~/.config/systemd/user/
#   systemctl --user daemon-reload && systemctl --user enable --now pcoin-watchdog.timer

set -u
BIN="$HOME/.local/share/pcoin/bin"
DD="${PCOIN_DATADIR:-$HOME/.pcoin}"
CLI="env LD_LIBRARY_PATH=$HOME/.local/share/pcoin/lib $BIN/bitcoin-cli -datadir=$DD"
LOG="${PCOIN_WATCHDOG_LOG:-$HOME/.local/state/pcoin-watchdog.log}"
mkdir -p "$(dirname "$LOG")" 2>/dev/null || LOG="/tmp/pcoin-watchdog.log"

log() {
    printf '%s %s\n' "$(date -u '+%Y-%m-%d %H:%M:%S')" "$*" >> "$LOG"
    if [ "$(stat -c %s "$LOG" 2>/dev/null || echo 0)" -gt 1048576 ]; then
        tail -n 500 "$LOG" > "$LOG.tmp" && mv "$LOG.tmp" "$LOG"
    fi
}

json_field() { sed -n "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"\{0,1\}\([^\",}]*\).*/\1/p" <<<"$2" | head -1; }

state="$(systemctl --user is-active pcoind.service 2>/dev/null || echo unknown)"

# --- A. the node is not up --------------------------------------------------
if [ "$state" != "active" ]; then
    recent="$(journalctl --user -u pcoind -n 80 --no-pager 2>/dev/null)"
    if grep -q "Invalid or corrupt peers.dat" <<<"$recent"; then
        if [ -f "$DD/peers.dat" ]; then
            mv "$DD/peers.dat" "$DD/peers.dat.corrupt-$(date -u +%Y%m%d-%H%M%S)" \
                && log "node down on a corrupt peers.dat: quarantined it, restarting pcoind"
        else
            log "node down, log says corrupt peers.dat, but the file is already gone: restarting pcoind"
        fi
        systemctl --user restart pcoind.service
    else
        log "pcoind is $state and the log shows no corrupt peers.dat - leaving it to systemd"
    fi
    exit 0
fi

# --- B. the node is up: is anything actually hashing? -----------------------
pid="$(pgrep -x bitcoind | head -1)"
threads=0
[ -n "$pid" ] && threads="$(cat /proc/"$pid"/task/*/comm 2>/dev/null | grep -c pcminer)"

if [ "$threads" -eq 0 ]; then
    info="$("$CLI" getblockchaininfo 2>/dev/null)"
    if grep -q '"initialblockdownload"[[:space:]]*:[[:space:]]*true' <<<"$info"; then
        log "0 pcminer threads but the node is still in initial block download - correct state, not touched"
        exit 0
    fi
    sup="$(systemctl --user is-active pcoin-miner.service 2>/dev/null || echo unknown)"
    if [ "$sup" = "active" ]; then
        last="$(grep 'restarted pcoin-miner' "$LOG" 2>/dev/null | tail -1 | cut -d' ' -f1-2)"
        if [ -n "$last" ]; then
            age=$(( $(date -u +%s) - $(date -u -d "$last" +%s 2>/dev/null || echo 0) ))
        else
            age=999999
        fi
        if [ "$age" -gt 1800 ]; then
            systemctl --user restart pcoin-miner.service
            log "node synced but 0 pcminer threads: restarted pcoin-miner (the supervisor is the ON switch)"
        else
            log "still 0 threads, last supervisor restart was ${age}s ago - waiting rather than looping"
        fi
    else
        log "0 threads and pcoin-miner is $sup - not starting mining myself"
    fi
fi

exit 0