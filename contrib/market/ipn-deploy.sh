#!/usr/bin/env bash
# ipn-deploy.sh -- put the NOWPayments callback change on market.pc.am EXACTLY as
# it was reviewed, and take it off again without undoing anybody else's deploy.
#
#   contrib/market/ipn-deploy.sh <reviewed-commit> check           read-only
#   contrib/market/ipn-deploy.sh <reviewed-commit> migrate         orders-payment.sql, as root
#   contrib/market/ipn-deploy.sh <reviewed-commit> install         back up, install, restart, verify
#   contrib/market/ipn-deploy.sh <reviewed-commit> verify          read-only
#   contrib/market/ipn-deploy.sh <reviewed-commit> rollback <tag>  only if nobody deployed since
#
# Run it from any checkout of this repository that has <reviewed-commit> (the
# branch tip that was reviewed, merged and pushed). That checkout's working
# tree, its branch and whatever else has been merged do not matter: nothing is
# read from them. Needs bash 4+ (Git Bash, Linux).
#
# WHY IT IS A SCRIPT. Another session commits to contrib/market all the time,
# server.mjs included. "Copy the files from main" would ship whatever of theirs
# had been merged by then -- undeployed, possibly without the companion files it
# needs -- and a server.mjs that fails to start takes the live payment callback
# down with it. A rollback that copies backups back without looking undoes
# whoever deployed after this. So, mechanically:
#
#   1. WHAT IS INSTALLED is read from <reviewed-commit> with `git show`, never
#      from a working tree or a branch tip, and checked on the host after the copy.
#   2. THE HOST MUST STILL RUN WHAT THIS CHANGE WAS BUILT ON. For every file it
#      replaces, the live file must be BASE's version (BASE = the parent of the
#      commit that added ipn.mjs), or already the reviewed one (a re-run).
#      Anything else means somebody deployed since: it stops, changes nothing,
#      and names the file. The same check runs again on the host, in the same
#      command that swaps the files.
#   3. THE CHANGE MUST BE WHAT THIS SCRIPT INSTALLS. If BASE..<reviewed-commit>
#      changes any other file that runs on the host, it stops.
#   4. THE CODE NEEDS ITS COLUMNS. install refuses until orders-payment.sql has
#      run (`migrate`), and while any order is 'sending' (a restart then would
#      interrupt a payout).
#   5. ROLLBACK ONLY PUTS BACK WHAT IT TOOK AWAY. It first requires every code
#      file to be exactly what install put there, and every backup to be exactly
#      what install replaced; if anything is not, it stops and touches nothing.
#      The migration stays: its columns are additive, and the UNIQUE index is on
#      a column the old code never writes.
#
# Files are compared as `tr -d '\r' | md5sum` (the host's copies are LF; this
# only keeps a stray CRLF copy from reading as somebody else's deploy).
#
# Environment (the defaults are production's):
#   MARKET_SSH      runs one command on the host, stdin passed through
#                   (default: ssh root@178.105.178.27)
#   MARKET_DIR      the app directory on the host (default /opt/pcoin-market)
#   MARKET_SERVICE  the systemd unit (default pcoin-market)
#   MARKET_MYSQL    the database client ON THE HOST, as root (default: mysql pcoin_market)
#   MARKET_CHOWN    owner of installed files (default root:root; empty leaves it)
#   MARKET_UPSTREAM the branch <reviewed-commit> must already be on (default origin/main)
#   MARKET_REPO     the repository to read commits from (default: this script's)
#   MARKET_BASE     overrides BASE (default: found as described above)
#   MARKET_WAIT     seconds to wait for the restarted server to listen (default 30)

set -euo pipefail

SSH=${MARKET_SSH:-ssh root@178.105.178.27}
DIR=${MARKET_DIR:-/opt/pcoin-market}
SERVICE=${MARKET_SERVICE:-pcoin-market}
MYSQL=${MARKET_MYSQL:-mysql pcoin_market}
CHOWN=${MARKET_CHOWN-root:root}
UPSTREAM=${MARKET_UPSTREAM:-origin/main}
WAIT=${MARKET_WAIT:-30}
REPO=${MARKET_REPO:-$(git -C "$(dirname "$0")" rev-parse --show-toplevel)}
SUB=contrib/market

# What this change deploys. orders-payment.sql goes first, with `migrate`; the
# code in this order (ipn.mjs before the server that imports it).
CODE_FILES="ipn.mjs admin.mjs delivery.mjs server.mjs"
FILES="orders-payment.sql $CODE_FILES"
# What the change also touches that never goes to the host.
DEV_ONLY="README.md ipn-test.mjs ipn-e2e-test.mjs ipn-deploy.sh ipn-deploy-test.sh"

die()  { echo "STOP: $*" >&2; exit 3; }
note() { echo "  $*"; }
remote()    { $SSH "$@" < /dev/null; }       # a command on the host
remote_in() { $SSH "$@"; }                   # ... reading this script's stdin
g() { git -C "$REPO" "$@"; }

[ "${BASH_VERSINFO[0]}" -ge 4 ] || die "needs bash 4 or later"
[ $# -ge 2 ] || { sed -n '2,10p' "$0" >&2; exit 2; }
REV_ARG=$1; ACTION=$2; TAG_ARG=${3:-}

REV=$(g rev-parse --verify --quiet "$REV_ARG^{commit}") || die "no commit '$REV_ARG' in $REPO (fetch it first)"
if [ -n "${MARKET_BASE:-}" ]; then
  BASE=$(g rev-parse --verify --quiet "$MARKET_BASE^{commit}") || die "no commit '$MARKET_BASE'"
else
  ADDED=$(g log --diff-filter=A --format=%H "$REV" -- "$SUB/ipn.mjs" | tail -n 1)
  [ -n "$ADDED" ] || die "$REV does not contain $SUB/ipn.mjs"
  BASE=$(g rev-parse --verify --quiet "$ADDED^") || die "the commit that added ipn.mjs has no parent"
fi

# md5 of a file at a commit, or "absent".
md5_at() {
  if g cat-file -e "$1:$SUB/$2" 2>/dev/null; then
    g show "$1:$SUB/$2" | tr -d '\r' | md5sum | cut -c1-32
  else
    echo absent
  fi
}
# The host-side expression for one file's md5 (CR removed).
md5_expr() { printf '$(tr -d %s < %s | md5sum | cut -c1-32)' "'\\r'" "'$1'"; }

# "<file> <md5|absent>" for each named file on the host, in one call.
live_md5s() {
  local s="cd '$DIR' || exit 9;"
  for f in "$@"; do
    s="$s if [ -e '$f' ]; then echo \"$f $(md5_expr "$f")\"; else echo '$f absent'; fi;"
  done
  remote "$s"
}
read_live() {
  local f m
  while read -r f m; do
    if [ -n "$f" ]; then LIVEMD5[$f]=$m; fi
  done < <(live_md5s "$@")
}

declare -A BASEMD5 REVMD5 LIVEMD5 STATE

# ── what the reviewed change is ─────────────────────────────────────────────
scope_check() {
  local p f bad=""
  for p in $(g diff --name-only "$BASE" "$REV"); do
    case "$p" in
      "$SUB"/*) f=${p#"$SUB"/} ;;
      *) bad="$bad $p"; continue ;;
    esac
    case " $FILES $DEV_ONLY " in
      *" $f "*) ;;
      *) bad="$bad $p" ;;
    esac
  done
  if [ -n "$bad" ]; then
    die "BASE..reviewed also changes$bad, which this script does not deploy. Nothing was changed."
  fi
  for f in $FILES; do
    BASEMD5[$f]=$(md5_at "$BASE" "$f")
    REVMD5[$f]=$(md5_at "$REV" "$f")
    if [ "${REVMD5[$f]}" = absent ]; then die "$f is missing from $REV"; fi
  done
}

# ── what the host runs: STATE[f] = installed | install, or stop ─────────────
host_check() {
  local f m bad=""
  read_live $FILES
  for f in $FILES; do
    m=${LIVEMD5[$f]:-}
    if [ -z "$m" ]; then die "could not read $DIR/$f on the host"; fi
    if [ "$m" = "${REVMD5[$f]}" ]; then STATE[$f]=installed
    elif [ "$m" = "${BASEMD5[$f]}" ]; then STATE[$f]=install
    else bad="$bad $f"; fi
  done
  if [ -n "$bad" ]; then
    for f in $bad; do
      echo "  $f: live ${LIVEMD5[$f]}; this change was built on ${BASEMD5[$f]} and installs ${REVMD5[$f]}" >&2
    done
    die "the host runs something this change was not built on:$bad. Somebody deployed since ${BASE:0:8}. Nothing was changed. Put what is live into git and rebuild the change on it, then run this again."
  fi
}

# "<new columns> <unique index> <orders sending>" from the host's database.
db_state() {
  printf '%s\n' "SELECT
    (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND
      ((TABLE_NAME = 'orders' AND COLUMN_NAME IN ('paid_payment_id','invoice_usd')) OR
       (TABLE_NAME = 'ipn_events' AND COLUMN_NAME IN ('outcome','note')))),
    (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND
      TABLE_NAME = 'orders' AND INDEX_NAME = 'uq_paid_payment_id' AND NON_UNIQUE = 0),
    (SELECT COUNT(*) FROM orders WHERE status = 'sending');" | remote_in "$MYSQL -N -B" | tr '\t' ' '
}
DB_COLS=""; DB_IDX=""; DB_SENDING=""
read_db() {
  local st
  st=$(db_state) || die "could not read the database on the host ($MYSQL)"
  read -r DB_COLS DB_IDX DB_SENDING <<<"$st"
}

report() {
  local f
  echo "reviewed ${REV:0:12}, built on ${BASE:0:12}, host $DIR"
  for f in $FILES; do
    note "$(printf '%-20s %-9s live %s  reviewed %s' "$f" "${STATE[$f]}" "${LIVEMD5[$f]}" "${REVMD5[$f]}")"
  done
}

# One file from the reviewed commit to "$DIR/.<f>.npipn-new", checked on arrival.
stage() {
  local f=$1 got
  g show "$REV:$SUB/$f" | remote_in "cat > '$DIR/.$f.npipn-new'"
  got=$(remote "cd '$DIR' && echo \"$(md5_expr ".$f.npipn-new")\"")
  if [ "$got" != "${REVMD5[$f]}" ]; then die "$f arrived as $got, not ${REVMD5[$f]}; nothing installed"; fi
}

# One command on the host: every live file is re-checked against what it must
# be (nobody deployed in the last seconds) BEFORE anything is touched; then the
# backups; then the swap.
swap() {
  local tag=$1 f; shift
  local s="set -e; cd '$DIR';"
  for f in "$@"; do
    if [ "${BASEMD5[$f]}" = absent ]; then
      s="$s if [ -e '$f' ]; then echo 'STOP: $f appeared on the host' >&2; exit 4; fi;"
    else
      s="$s if [ \"$(md5_expr "$f")\" != '${BASEMD5[$f]}' ]; then echo 'STOP: $f changed on the host' >&2; exit 4; fi;"
    fi
  done
  for f in "$@"; do
    if [ "${BASEMD5[$f]}" != absent ]; then s="$s cp -p '$f' '$f.bak-npipn-$tag';"; fi
  done
  for f in "$@"; do
    s="$s chmod 644 '.$f.npipn-new';"
    if [ -n "$CHOWN" ]; then s="$s chown '$CHOWN' '.$f.npipn-new';"; fi
    s="$s mv -f '.$f.npipn-new' '$f';"
  done
  remote "$s" || die "the host refused the swap (see above); nothing was installed"
}

restart_and_wait() {
  local t0 j i
  t0=$(remote "date +%s")
  remote "systemctl restart '$SERVICE'"
  for i in $(seq 1 "$WAIT"); do
    j=$(remote "journalctl -u '$SERVICE' --since '@$t0' --no-pager 2>/dev/null || true")
    if printf '%s' "$j" | grep -q 'MIGRATION MISSING'; then
      die "the restarted server says MIGRATION MISSING: run '$0 $REV_ARG migrate' (it reopens without a restart)"
    fi
    if printf '%s' "$j" | grep -q 'pcoin-market on 127.0.0.1:'; then
      if [ "$(remote "systemctl is-active '$SERVICE'" || true)" = active ]; then
        note "$SERVICE is up"
        return 0
      fi
    fi
    sleep 1
  done
  die "$SERVICE did not come up within ${WAIT}s: journalctl -u $SERVICE -n 80"
}

verify_reviewed() {       # every named file must be the reviewed one
  local f bad=""
  read_live "$@"
  for f in "$@"; do
    if [ "${LIVEMD5[$f]:-}" != "${REVMD5[$f]}" ]; then bad="$bad $f"; fi
  done
  if [ -n "$bad" ]; then die "not the reviewed version on the host:$bad"; fi
}

scope_check
case "$ACTION" in
  check)
    host_check
    report
    read_db
    note "database: $DB_COLS/4 new columns, unique index $DB_IDX, orders sending $DB_SENDING"
    echo "check passed: nothing on the host is foreign to this change"
    ;;

  migrate)
    host_check
    if [ "${STATE[orders-payment.sql]}" = install ]; then
      stage orders-payment.sql
      swap "$(date -u +%Y%m%dT%H%M%SZ)" orders-payment.sql
    fi
    remote "$MYSQL < '$DIR/orders-payment.sql'" || die "the migration failed (see above)"
    read_db
    if [ "$DB_COLS" != 4 ] || [ "$DB_IDX" != 1 ]; then
      die "after the migration: $DB_COLS/4 columns, unique index $DB_IDX"
    fi
    echo "migrated: 4/4 columns, uq_paid_payment_id unique"
    ;;

  install)
    if ! g merge-base --is-ancestor "$REV" "$UPSTREAM" 2>/dev/null; then
      die "$REV is not on $UPSTREAM: merge and push it first (and fetch), so what runs is in git for everyone"
    fi
    host_check
    report
    read_db
    if [ "$DB_COLS" != 4 ] || [ "$DB_IDX" != 1 ]; then
      die "the migration has not run ($DB_COLS/4 columns, unique index $DB_IDX): '$0 $REV_ARG migrate' first"
    fi
    if [ "$DB_SENDING" != 0 ]; then
      die "$DB_SENDING order(s) are 'sending': a restart now would interrupt a payout. Wait until none are."
    fi
    todo=""
    for f in $FILES; do
      if [ "${STATE[$f]}" = install ]; then todo="$todo $f"; fi
    done
    if [ -z "$todo" ]; then
      echo "nothing to install: the host already runs the reviewed files"
      exit 0
    fi
    TAG=$(date -u +%Y%m%dT%H%M%SZ)
    for f in $todo; do stage "$f"; done
    swap "$TAG" $todo
    note "installed:$todo (backups *.bak-npipn-$TAG)"
    restart_and_wait
    verify_reviewed $FILES
    echo "installed and verified. To undo: $0 $REV_ARG rollback $TAG"
    ;;

  verify)
    verify_reviewed $FILES
    if [ "$(remote "systemctl is-active '$SERVICE'" || true)" != active ]; then die "$SERVICE is not active"; fi
    echo "verified: the host runs the reviewed files and $SERVICE is active"
    ;;

  rollback)
    if ! [[ "$TAG_ARG" =~ ^[0-9]{8}T[0-9]{6}Z$ ]]; then
      die "rollback needs the tag install printed (the *.bak-npipn-<tag> suffix)"
    fi
    # Every code file must be EXACTLY what install put there. If one is not,
    # somebody deployed over this change and putting the backups back would
    # undo their work: stop before touching anything.
    read_live $CODE_FILES
    bad=""
    for f in $CODE_FILES; do
      if [ "${LIVEMD5[$f]:-}" != "${REVMD5[$f]}" ]; then bad="$bad $f"; fi
    done
    if [ -n "$bad" ]; then
      die "changed since this change was installed:$bad. Rolling back would revert whoever deployed that. Nothing was changed; coordinate with them."
    fi
    s="set -e; cd '$DIR';"
    for f in $CODE_FILES; do          # the same checks on the host, in the command that swaps
      s="$s if [ \"$(md5_expr "$f")\" != '${REVMD5[$f]}' ]; then echo 'STOP: $f changed on the host' >&2; exit 4; fi;"
      if [ "${BASEMD5[$f]}" != absent ]; then
        s="$s if [ ! -f '$f.bak-npipn-$TAG_ARG' ] || [ \"$(md5_expr "$f.bak-npipn-$TAG_ARG")\" != '${BASEMD5[$f]}' ]; then echo 'STOP: $f.bak-npipn-$TAG_ARG is missing or is not what this change replaced' >&2; exit 4; fi;"
      fi
    done
    for f in $CODE_FILES; do
      if [ "${BASEMD5[$f]}" = absent ]; then
        s="$s rm -f '$f';"
      else
        s="$s cp -p '$f.bak-npipn-$TAG_ARG' '.$f.npipn-back'; mv -f '.$f.npipn-back' '$f';"
      fi
    done
    remote "$s" || die "the host refused the rollback (see above); nothing was changed"
    restart_and_wait
    read_live $CODE_FILES
    for f in $CODE_FILES; do
      if [ "${LIVEMD5[$f]}" != "${BASEMD5[$f]}" ]; then
        die "$f is ${LIVEMD5[$f]} after the rollback, expected ${BASEMD5[$f]}"
      fi
    done
    echo "rolled back to ${BASE:0:12}'s files; the migration's columns stay (additive)"
    ;;

  *) die "unknown action '$ACTION' (check | migrate | install | verify | rollback <tag>)" ;;
esac
