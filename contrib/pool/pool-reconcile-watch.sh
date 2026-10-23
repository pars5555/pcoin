#!/usr/bin/env bash
# Keep checking that every block the pool paid still agrees with the chain.
#
# firstblock-watch.sh answered one question once -- "did the very first payout
# work" -- and then went quiet by design. This is the ongoing version, and it
# exists because the pool is now OPEN: strangers are earning from these blocks,
# and a coinbase pays permanently. There is no bad send to re-send.
#
# It ALERTS, it does not act. Alerts go to the PRIVATE ops channel only.
# @PCoinPCN is for announcements written deliberately for people; subscribers
# have already once received "status=3/NOTIMPLEMENTED" and an internal hostname
# from a monitor that could not tell the two apart.
#
#   */15 * * * * /opt/pcoin-pool/pool-reconcile-watch.sh >> /var/log/pcoin-pool-watch.log 2>&1

set -uo pipefail
cd "$(dirname "$0")"
CFG=${CFG:-/opt/pcoin-pool/pool.config.json}
STATE=${STATE:-/opt/pcoin-pool/.reconcile-state}
CONF=${CONF:-/etc/pcoin/alert.conf}

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

notify() {
    # A missing config is not a reason to fail silently -- it is a reason to say
    # so in the log, which is the only other place anyone might look.
    # Preferred path: pcoin-notify, run as root through one narrow sudo rule.
    # This script runs as pcoin-pool and cannot read the root-owned token file,
    # which is why every alert it ever raised was logged as NOT sent.
    if [ -x /usr/local/bin/pcoin-notify ] && sudo -n /usr/local/bin/pcoin-notify --help >/dev/null 2>&1; then
        if sudo -n /usr/local/bin/pcoin-notify "PCoin pool: reconciliation" "$1"; then
            say "alert sent via pcoin-notify"; return 0
        fi
        say "pcoin-notify failed -- falling back to the direct path"
    fi
    [ -r "$CONF" ] || { say "cannot read $CONF -- alert NOT sent: $1"; return 0; }
    # shellcheck disable=SC1090
    . "$CONF"
    if [ -z "${TELEGRAM_TOKEN:-}" ] || [ -z "${ALERT_CHAT:-}" ]; then
        say "no token or ALERT_CHAT -- alert NOT sent: $1"; return 0
    fi
    curl -s --max-time 20 -o /dev/null \
        --data-urlencode "chat_id=${ALERT_CHAT}" \
        --data-urlencode "text=$1" \
        --data-urlencode "disable_web_page_preview=true" \
        "https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage" \
        || say "telegram send failed (will retry next tick)"
}

# Report a condition at most once, so a channel stays worth reading. The key
# includes the block, so a NEW bad block still alerts even if an older one did.
seen() { grep -qxF "$1" "$STATE" 2>/dev/null; }
mark() { echo "$1" >> "$STATE"; }

OUT=$(node payouts.mjs --config "$CFG" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')
if [ -z "$OUT" ]; then
    say "payouts.mjs produced nothing -- resolving nothing, will retry"
    exit 0
fi

# --- a block whose ledger and chain disagree. The one that must never be quiet.
if printf '%s' "$OUT" | grep -q "DO NOT RECONCILE"; then
    DETAIL=$(printf '%s\n' "$OUT" | sed -n '/RECONCILIATION/,/BALANCES/p' | grep -A4 "FAIL" | head -20)
    # Key on SEVERITY, never on a head-truncated body. The old key was the md5
    # of at most 20 lines, and each failing block emits two -- so past ten
    # failures the fingerprint froze and the condition could never re-alert,
    # however much worse it got. It stayed frozen from 2026-08-22 onward.
    NFAIL=$(printf '%s\n' "$OUT" | grep -c "FAIL")
    MAXH=$(printf '%s\n' "$OUT" | grep -oE "height [0-9]+" | grep -oE "[0-9]+" | sort -n | tail -1)
    # Key on WHICH addresses disagree, not how many blocks do. Every block
    # after 4669 fails, so a count-based key would change every run and alert
    # every fifteen minutes forever -- worse than the frozen key it replaced.
    # A new address joining this set is a real miner being misplaid, and that
    # changes the key and alerts at once.
    ADDRS=$(printf '%s\n' "$OUT" | sed -n '/RECONCILIATION/,/BALANCES/p' \
            | grep -oE 'pc1[a-z0-9]+' | sort -u | tr '\n' ',')
    KEY="mismatch:addrs=$(printf '%s' "${ADDRS:-none}" | md5sum | cut -c1-12)"
    if ! seen "$KEY"; then
        mark "$KEY"
        say "MISMATCH -- alerting (${NFAIL} failing block(s), highest ${MAXH:-unknown}, addresses: ${ADDRS:-none})"
        notify "PCoin pool: A BLOCK DOES NOT RECONCILE.
The ledger and the chain disagree about what a block paid. Coinbase payouts are
permanent, so this cannot be corrected by re-sending -- investigate before the
next block.

$DETAIL"
    else
        # Suppress the ALERT on repeat, never the log line. This exit used to
        # sit outside the guard, so a repeat run wrote nothing at all and the
        # check looked as though it had not run.
        say "MISMATCH -- unchanged (${NFAIL} failing, highest ${MAXH:-unknown}, addresses: ${ADDRS:-none}); not re-alerting"
    fi
    exit 1
fi

# --- a block we could not check against the chain. NOT agreement.
if printf '%s' "$OUT" | grep -q "UNVERIFIED\|UNCHECKED"; then
    DETAIL=$(printf '%s\n' "$OUT" | grep -E "UNVERIFIED|UNCHECKED" | head -5)
    KEY="unverified:$(printf '%s' "$DETAIL" | md5sum | cut -c1-12)"
    if ! seen "$KEY"; then
        mark "$KEY"
        say "unverified block -- alerting"
        notify "PCoin pool: a block could not be checked against the chain.
This is NOT a mismatch and NOT agreement -- the node could not be read, so
nothing is resolved either way. If it clears on the next tick, ignore it.

$DETAIL"
    fi
    exit 0
fi

# --- an orphaned block, or a reorg alarm the ledger deliberately did not act on
ORPH=$(printf '%s\n' "$OUT" | grep -E "ORPHANED|\*\*\* ALARM \*\*\*" | head -5)
if [ -n "$ORPH" ]; then
    # Key on WHICH block, not on the words describing it. The alarm text carries
    # a live number -- `left the chain at ${confs} confirmations` is rebuilt from
    # the current tip on every tick (store.mjs:777) -- so hashing the body minted
    # a fresh key every time the chain found a block. Measured 2026-10-24: 431
    # keys, 431 alerts, 0 duplicates in seven days, about ONE historical orphan
    # whose ledger had already been correctly left alone. That is exactly the
    # count-based key the mismatch branch above warns about; there it was fixed
    # and here it was not.
    #
    # The identity is two lines above the alarm in payouts.mjs's block listing --
    # height, then the block hash -- so take the hashes from the context rather
    # than from the body. A genuinely new orphan has a new hash and alerts at
    # once, which is the property the key exists for.
    IDS=$(printf '%s\n' "$OUT" | grep -B2 -E "ORPHANED|\*\*\* ALARM \*\*\*" \
            | grep -oE '[0-9a-f]{64}' | sort -u | tr '\n' ',')
    # No identity readable means we cannot tell one orphan from another, and
    # then there is no safe key: the body alone is NOT one, because the alarm
    # text for two different blocks can be byte-identical. Collapsing them
    # silently swallows a real orphan, which is the one failure that must not
    # happen here -- so an unreadable identity dedupes NOTHING and alerts every
    # tick. Noisy, and never missing. A check that cannot fire is
    # indistinguishable from one that passes.
    KEY=""
    [ -n "$IDS" ] && KEY="orphan:${IDS}"
    if [ -z "$KEY" ] || ! seen "$KEY"; then
        [ -n "$KEY" ] && mark "$KEY"
        say "orphan/alarm -- alerting (${KEY:-no identity; not deduping})"
        notify "PCoin pool: a block left the chain.
Its payouts are void -- the work was real, the coins never were. Miners in that
block's window are paid by later blocks instead; nothing is owed to them.

$ORPH"
    else
        # Suppress the ALERT on repeat, never the log line -- the same rule as
        # the mismatch branch. Without this the only trace of an unchanged
        # orphan was silence, which reads as the check not having run.
        say "orphan/alarm -- unchanged (${KEY}); not re-alerting"
    fi
fi

# --- quiet success. Log a one-liner so the log proves the check ran.
SUMMARY=$(printf '%s\n' "$OUT" | grep "verified against the coinbase ON THE CHAIN" | head -1)
say "ok -- ${SUMMARY:-no blocks yet}"
