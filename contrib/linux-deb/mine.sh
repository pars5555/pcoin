#!/bin/sh
# PCoin: install and start POOL mining, in one command.
#
#   curl -fsSL https://pc.am/dl/mine.sh | sudo sh
#
# pcoin-setup configures SOLO mining. This is its pool counterpart: it installs
# if needed, waits for the node, asks where to pay you, and starts mining
# against pool.pc.am.
#
# READS FROM /dev/tty, NOT STDIN. Piped into sh, stdin IS this script -- reading
# it would swallow the rest of the file. install.sh has the same rule.
set -eu

POOL="${POOL:-pool.pc.am:3333}"
DATADIR="${DATADIR:-/var/lib/pcoin}"
CLI="/opt/pcoin/bin/bitcoin-cli -datadir=$DATADIR"
B=$(printf '\033[1m'); N=$(printf '\033[0m'); Y=$(printf '\033[33m'); R=$(printf '\033[31m')

say()  { printf '  %s\n' "$1"; }
warn() { printf '  %s%s%s\n' "$Y" "$1" "$N"; }
die()  { printf '  %s%s%s\n' "$R" "$1" "$N"; exit 1; }

[ "$(id -u)" = 0 ] || die "Run with sudo:  curl -fsSL https://pc.am/dl/mine.sh | sudo sh"
[ -r /dev/tty ] || die "No terminal available. This asks questions; run it interactively."

printf '\n  %sPCoin pool miner setup%s\n\n' "$B" "$N"

# ---- 1. install if the node is not here ----------------------------------
if [ ! -x /opt/pcoin/bin/bitcoin-cli ]; then
    say "PCoin is not installed yet -- installing first."
    curl -fsSL https://pc.am/dl/install.sh | sh || die "Install failed. Nothing was started."
fi
[ -x /opt/pcoin/bin/bitcoin-cli ] || die "bitcoin-cli still missing after install; stopping."

# ---- 2. node up ----------------------------------------------------------
systemctl is-active --quiet pcoind || {
    say "Starting pcoind..."
    systemctl enable --now pcoind >/dev/null 2>&1 || true
}
say "Waiting for the node to answer RPC..."
i=0
until $CLI getblockchaininfo >/dev/null 2>&1; do
    i=$((i + 1)); [ "$i" -gt 60 ] && die "pcoind is not answering after 5 minutes. Check: journalctl -u pcoind -n 50"
    sleep 5
done
say "Node is up."

# ---- 3. payout address, validated BY THE NODE ----------------------------
ADDR="${ADDRESS:-}"
while :; do
    if [ -z "$ADDR" ]; then
        printf '\n  Where should your mining rewards be paid?\n'
        printf '  Paste a PCoin address you control (starts with pc1q).\n'
        printf '  Address: '
        IFS= read -r ADDR < /dev/tty || die "No input."
        ADDR=$(printf '%s' "$ADDR" | tr -d '[:space:]')
    fi
    [ -n "$ADDR" ] || { warn "An address is required -- rewards have to go somewhere."; continue; }

    if ! RES=$($CLI validateaddress "$ADDR" 2>&1); then
        # The CALL failed. That is not a verdict on the address: it is an
        # unanswered question. Retry -- never read it as a yes or a no.
        warn "Could not reach the node to check that address yet. Retrying..."
        sleep 5
        continue
    fi
    case "$RES" in
        *'"isvalid": true'*|*'"isvalid":true'*) say "Address validated by the node: $ADDR"; break ;;
        *'"isvalid": false'*|*'"isvalid":false'*) warn "The node says that is not a valid PCoin address."; ADDR="" ;;
        *) warn "Unexpected reply from validateaddress; not accepting it."; ADDR="" ;;
    esac
done

# ---- 4. threads ----------------------------------------------------------
CORES=$(nproc 2>/dev/null || echo 1)
SUGGEST=$(( CORES / 2 )); [ "$SUGGEST" -lt 1 ] && SUGGEST=1
THREADS="${THREADS:-}"
if [ -z "$THREADS" ]; then
    printf '\n  How many CPU threads should mine? %s available, Enter for %s: ' "$CORES" "$SUGGEST"
    IFS= read -r THREADS < /dev/tty || THREADS=""
    THREADS=$(printf '%s' "$THREADS" | tr -d '[:space:]')
fi
case "$THREADS" in
    ''|*[!0-9]*) THREADS="$SUGGEST" ;;
esac
[ "$THREADS" -lt 1 ] && THREADS="$SUGGEST"
say "Using $THREADS thread(s) of $CORES."

# ---- 5. the sync gate ----------------------------------------------------
printf '\n'
say "Waiting for the chain to sync. Mining on an unsynced node builds blocks on a"
say "chain nobody else has -- they are orphaned and pay nothing."
while :; do
    INFO=$($CLI getblockchaininfo 2>/dev/null) || { sleep 10; continue; }
    case "$INFO" in
        *'"initialblockdownload": false'*|*'"initialblockdownload":false'*)
            H=$(printf '%s' "$INFO" | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p' | head -1)
            say "Synced at height ${H:-?}."; break ;;
    esac
    H=$(printf '%s' "$INFO" | sed -n 's/.*"blocks": *\([0-9]*\).*/\1/p' | head -1)
    say "  syncing... height ${H:-?}"
    sleep 20
done

# ---- 6. mine, and keep mining after a reboot -----------------------------
say "Starting pool mining on $POOL ..."
$CLI startpoolmining "$POOL" "$ADDR" "$THREADS" >/dev/null 2>&1 \
    || die "startpoolmining failed. Check: journalctl -u pcoind -n 50"

cat > /etc/pcoin/poolminer.conf <<CONF
# Written by mine.sh. Read by pcoin-poolminer.service.
POOL=$POOL
ADDRESS=$ADDR
THREADS=$THREADS
CONF
chmod 644 /etc/pcoin/poolminer.conf 2>/dev/null || true

cat > /etc/systemd/system/pcoin-poolminer.service <<'UNIT'
[Unit]
Description=PCoin pool miner (re-applies pool mining after a restart)
# NOT BindsTo/PartOf pcoind: propagation is one-way, so a `systemctl restart
# pcoind` would stop mining and never restart it, silently, until reboot.
After=pcoind.service
Wants=pcoind.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/pcoin/poolminer.conf
ExecStart=/bin/sh -c 'until /opt/pcoin/bin/bitcoin-cli -datadir=/var/lib/pcoin getblockchaininfo >/dev/null 2>&1; do sleep 5; done; \
  until /opt/pcoin/bin/bitcoin-cli -datadir=/var/lib/pcoin getblockchaininfo | grep -q "\"initialblockdownload\": *false"; do sleep 20; done; \
  /opt/pcoin/bin/bitcoin-cli -datadir=/var/lib/pcoin startpoolmining "$POOL" "$ADDRESS" "$THREADS"'

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable pcoin-poolminer >/dev/null 2>&1 || true

sleep 4
if $CLI getcpuminerinfo 2>/dev/null | grep -q '"mining": *true'; then
    printf '\n  %sMINING%s  pool=%s  threads=%s\n' "$B" "$N" "$POOL" "$THREADS"
    say "Paid to: $ADDR"
    say "Status:  sudo -u pcoin $CLI getcpuminerinfo"
    say "Stop:    sudo -u pcoin $CLI stopmining  &&  sudo systemctl disable --now pcoin-poolminer"
    printf '\n'
else
    warn "Command accepted but the node reports mining=false. Check: journalctl -u pcoind -n 50"
fi
