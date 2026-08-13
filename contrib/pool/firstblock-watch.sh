#!/usr/bin/env bash
# Tell the operator when the pool's first block has reconciled against the chain.
#
#   IT DOES NOT OPEN THE POOL. It reports.
#
# Lifting the allowlist is a one-way, outward-facing act: it invites strangers
# to point hardware at a payout path, and coinbase payouts are permanent -- a
# misallocated block is on the chain forever. That decision belongs to a person.
# A script concluding "the numbers looked fine" is precisely the kind of
# authority this project's own rules say not to grant an automated read.
#
# So this checks, and says. Run it from cron every few minutes:
#   */5 * * * * /opt/pcoin-pool/firstblock-watch.sh >> /var/log/pcoin-pool-watch.log 2>&1

set -uo pipefail
cd "$(dirname "$0")"
CFG=${CFG:-/opt/pcoin-pool/pool.config.json}
STAMP=/opt/pcoin-pool/.firstblock-reported
DB=$(node -e "console.log(JSON.parse(require('fs').readFileSync('$CFG','utf8')).db)")

say() { printf '%s %s\n' "$(date -u +%FT%TZ)" "$*"; }

BLOCKS=$(sqlite3 "$DB" "SELECT COUNT(*) FROM blocks;" 2>/dev/null)
# An unreadable ledger is UNKNOWN. It is not "no blocks", and it must never
# advance anything -- least of all a report that would prompt opening the pool.
if [ -z "${BLOCKS:-}" ]; then
    say "ledger unreadable -- resolving nothing, will retry"
    exit 0
fi
[ "$BLOCKS" -eq 0 ] && exit 0

# Already told them once. Saying it every five minutes forever trains people to
# ignore it, and the one that matters would be ignored with the rest.
[ -f "$STAMP" ] && exit 0

# The check that counts: does the ledger agree with the coinbase ON THE CHAIN?
OUT=$(node payouts.mjs --config "$CFG" 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g')
if printf '%s' "$OUT" | grep -q "DO NOT RECONCILE"; then
    say "*** FIRST BLOCK DOES NOT RECONCILE -- DO NOT OPEN THE POOL ***"
    printf '%s\n' "$OUT" | sed -n '/RECONCILIATION/,/BALANCES/p'
    touch "$STAMP"
    exit 1
fi
if ! printf '%s' "$OUT" | grep -q "verified against the coinbase ON THE CHAIN"; then
    say "reconciliation could not be verified against the chain yet -- holding"
    exit 0
fi

say "=== THE POOL HAS PAID ITS FIRST BLOCK, AND IT RECONCILES ==="
printf '%s\n' "$OUT" | sed -n '/BLOCKS/,/BALANCES/p'
say "Every payout above was made by the block's own coinbase."
say "The allowlist is still ON. Opening the pool is a decision for a person:"
say "  edit allowlist to [] in $CFG, then: systemctl restart pcoin-pool"
touch "$STAMP"
