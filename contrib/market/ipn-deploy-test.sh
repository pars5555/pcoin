#!/usr/bin/env bash
# ipn-deploy-test.sh -- ipn-deploy.sh against a FAKE host: a local directory, a
# throwaway git repository, and stand-ins for ssh, systemctl, journalctl and
# mysql that only write to a log. Nothing leaves this machine.
#
#   bash contrib/market/ipn-deploy-test.sh
#   IPN_DEPLOY=<another copy of ipn-deploy.sh> bash contrib/market/ipn-deploy-test.sh
#
# The repository has the shape the real one has: BASE (what the host runs), the
# reviewed change on top of it (two commits), and ANOTHER SESSION's later commit
# to server.mjs merged after it, checked out, with an uncommitted edit on top.
# The host starts at BASE.

set -uo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
SCRIPT=${IPN_DEPLOY:-$HERE/ipn-deploy.sh}
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
R=$T/repo H=$T/host B=$T/bin S=$T/state LOG=$T/log
mkdir -p "$R" "$H" "$B" "$S"

pass=0 fail=0
check() {                       # check <name> <command...>: the command must succeed
  local name=$1; shift
  if "$@"; then pass=$((pass + 1)); echo "  ok   $name"
  else fail=$((fail + 1)); echo "  FAIL $name"; sed 's/^/         | /' "$T/out" | tail -n 12; fi
}
section() { echo; echo "# $*"; }

# ── the repository ──────────────────────────────────────────────────────────
g() { git -C "$R" -c user.name=test -c user.email=test@example.invalid "$@"; }
w() { printf '%s\n' "$2" > "$R/contrib/market/$1"; }
g init -q
g config core.autocrlf false
g checkout -q -b main
mkdir -p "$R/contrib/market"
w server.mjs 'server BASE'; w admin.mjs 'admin BASE'; w delivery.mjs 'delivery BASE'
w ladder.mjs 'ladder BASE'; w README.md 'readme BASE'
g add -A; g commit -q -m base
BASE=$(g rev-parse HEAD)
w ipn.mjs 'ipn REVIEWED 1'; w orders-payment.sql 'ALTER TABLE orders ADD paid_payment_id -- REVIEWED'
w server.mjs 'server REVIEWED'; w admin.mjs 'admin REVIEWED'; w delivery.mjs 'delivery REVIEWED'
w ipn-test.mjs 'test'; w README.md 'readme REVIEWED'
g add -A; g commit -q -m 'the change'
w ipn.mjs 'ipn REVIEWED 2'
g add -A; g commit -q -m 'the change, a fix on top'
REV=$(g rev-parse HEAD)
# Another session's work, merged after the reviewed change and never deployed.
w server.mjs 'server REVIEWED + ANOTHER SESSION'; w cap-policy.mjs 'cap-policy ANOTHER SESSION'
g add -A; g commit -q -m 'another session'
OTHER=$(g rev-parse HEAD)
git init -q --bare "$T/origin.git"
g remote add origin "$T/origin.git"
g push -q origin main
g fetch -q origin
# A change that also edits a file the script does not deploy, and one never pushed.
g checkout -q -b wide "$REV"; w ladder.mjs 'ladder CHANGED TOO'; g commit -q -am 'wide'; WIDE=$(g rev-parse HEAD)
g checkout -q -b unpushed "$REV"; w ipn.mjs 'ipn UNPUSHED'; g commit -q -am 'unpushed'; UNPUSHED=$(g rev-parse HEAD)
g checkout -q main
w server.mjs 'server UNCOMMITTED EDIT IN THE CHECKOUT'

# ── the fake host ───────────────────────────────────────────────────────────
cat > "$B/systemctl" <<'EOF'
#!/usr/bin/env bash
echo "systemctl $*" >> "$FAKE_LOG"
case "$1" in restart) touch "$FAKE_STATE/restarted" ;; is-active) echo active ;; esac
EOF
cat > "$B/journalctl" <<'EOF'
#!/usr/bin/env bash
if [ -f "$FAKE_STATE/restarted" ]; then echo 'pcoin-market on 127.0.0.1:8789'; fi
EOF
cat > "$B/fakemysql" <<'EOF'
#!/usr/bin/env bash
in=$(cat)
if printf '%s' "$in" | grep -q information_schema; then
  if [ -f "$FAKE_STATE/migrated" ]; then printf '4\t1\t%s\n' "${FAKE_SENDING:-0}"
  else printf '0\t0\t%s\n' "${FAKE_SENDING:-0}"; fi
else
  echo "mysql ran: $in" >> "$FAKE_LOG"
  touch "$FAKE_STATE/migrated"
fi
EOF
# ssh: run the command locally. FAKE_RACE=<text> makes somebody deploy
# server.mjs in the instant before the host runs a command containing <text>:
# after the script's own checks, before its swap.
cat > "$B/fakessh" <<'EOF'
#!/usr/bin/env bash
if [ -n "${FAKE_RACE:-}" ] && [[ "$1" == *"$FAKE_RACE"* ]]; then
  printf 'server DEPLOYED BY A RACER\n' > "$FAKE_HOST/server.mjs"
fi
exec bash -c "$1"
EOF
chmod +x "$B"/*
export PATH="$B:$PATH" FAKE_LOG=$LOG FAKE_STATE=$S FAKE_HOST=$H

reset_host() {
  rm -rf "$H" "$S"; mkdir -p "$H" "$S"; : > "$LOG"
  for f in server admin delivery ladder; do printf '%s BASE\n' "$f" > "$H/$f.mjs"; done
  echo '{"ipnSecret":"not-read-by-this-test"}' > "$H/config.json"
}
run() {                          # run <args...>: exit status in $rc, output in $T/out
  MARKET_SSH="$B/fakessh" MARKET_DIR="$H" MARKET_MYSQL=fakemysql MARKET_CHOWN= MARKET_REPO="$R" \
    MARKET_WAIT=3 bash "$SCRIPT" "$@" > "$T/out" 2>&1
  rc=$?
}
snap() { (cd "$H" && for f in $(ls | sort); do printf '%s %s\n' "$f" "$(md5sum < "$f" | cut -c1-32)"; done); }
is()  { [ "$(cat "$H/$1" 2>/dev/null)" = "$2" ]; }
out() { grep -q -- "$1" "$T/out"; }
restarts() { grep -c 'systemctl restart' "$LOG" || true; }
tag() { sed -n 's/.*rollback \([0-9]\{8\}T[0-9]\{6\}Z\).*/\1/p' "$T/out" | tail -n 1; }

# ── the cases ───────────────────────────────────────────────────────────────
section 'check: a host still at BASE'
reset_host; before=$(snap)
run "$REV" check
check 'passes' [ "$rc" = 0 ]
check 'finds BASE as the parent of the commit that added ipn.mjs' out "built on ${BASE:0:12}"
check 'touches nothing' [ "$(snap)" = "$before" ]

section 'install refuses before the migration'
reset_host; before=$(snap)
run "$REV" install
check 'refused' [ "$rc" != 0 ]
check 'says why' out 'migration has not run'
check 'host unchanged, nothing restarted' [ "$(snap)" = "$before" -a "$(restarts)" = 0 ]

section 'migrate'
run "$REV" migrate
check 'passes' [ "$rc" = 0 ]
check 'the reviewed SQL is on the host and was run' \
  is orders-payment.sql 'ALTER TABLE orders ADD paid_payment_id -- REVIEWED'
check 'and was what ran' grep -q 'mysql ran: ALTER TABLE orders ADD paid_payment_id -- REVIEWED' "$LOG"
check 'the code is untouched' is server.mjs 'server BASE'

section 'install refuses while an order is sending'
before=$(snap)
FAKE_SENDING=1 run "$REV" install
check 'refused' [ "$rc" != 0 ]
check 'host unchanged, nothing restarted' [ "$(snap)" = "$before" -a "$(restarts)" = 0 ]

section 'install from a checkout of a main that has moved on'
run "$REV" install
TAG=$(tag)
check 'passes' [ "$rc" = 0 ]
check 'server.mjs is the REVIEWED one: not main'"'"'s, not the working tree'"'"'s' is server.mjs 'server REVIEWED'
check 'ipn.mjs is the reviewed tip' is ipn.mjs 'ipn REVIEWED 2'
check 'admin.mjs and delivery.mjs are the reviewed ones' \
  bash -c "[ \"\$(cat '$H/admin.mjs')\" = 'admin REVIEWED' ] && [ \"\$(cat '$H/delivery.mjs')\" = 'delivery REVIEWED' ]"
check 'nothing else shipped (no cap-policy.mjs, ladder.mjs untouched)' \
  bash -c "[ ! -e '$H/cap-policy.mjs' ] && [ \"\$(cat '$H/ladder.mjs')\" = 'ladder BASE' ]"
check 'the replaced files are backed up under the printed tag' \
  bash -c "[ -n '$TAG' ] && [ \"\$(cat '$H/server.mjs.bak-npipn-$TAG')\" = 'server BASE' ] && [ \"\$(cat '$H/admin.mjs.bak-npipn-$TAG')\" = 'admin BASE' ]"
check 'restarted once' [ "$(restarts)" = 1 ]

section 'verify, and a second install'
run "$REV" verify
check 'verify passes against the reviewed commit' [ "$rc" = 0 ]
run "$REV" install
check 'a second install has nothing to do' [ "$rc" = 0 ]
check 'and restarts nothing' [ "$(restarts)" = 1 ]

section 'verify notices a file that is not the reviewed one'
cp "$H/admin.mjs" "$T/admin.keep"; printf 'admin HAND EDIT\n' > "$H/admin.mjs"
run "$REV" verify
check 'fails' [ "$rc" != 0 ]
cp "$T/admin.keep" "$H/admin.mjs"

section 'rollback while nobody has deployed since'
run "$REV" rollback "$TAG"
check 'passes' [ "$rc" = 0 ]
check 'server/admin/delivery are BASE again' \
  bash -c "[ \"\$(cat '$H/server.mjs')\" = 'server BASE' ] && [ \"\$(cat '$H/admin.mjs')\" = 'admin BASE' ] && [ \"\$(cat '$H/delivery.mjs')\" = 'delivery BASE' ]"
check 'ipn.mjs is gone' [ ! -e "$H/ipn.mjs" ]
check 'restarted' [ "$(restarts)" = 2 ]

section 'install refuses a host that runs somebody else'"'"'s deploy'
reset_host; touch "$S/migrated"
printf 'server DEPLOYED BY ANOTHER SESSION\n' > "$H/server.mjs"
before=$(snap)
run "$REV" install
check 'refused' [ "$rc" != 0 ]
check 'names the file' out 'server.mjs'
check 'host unchanged, nothing restarted' [ "$(snap)" = "$before" -a "$(restarts)" = 0 ]
run "$REV" check
check 'check refuses it too' [ "$rc" != 0 ]
run "$REV" migrate
check 'and so does migrate' [ "$rc" != 0 ]

section 'somebody deploys in the instant between the checks and the swap'
reset_host; touch "$S/migrated"
FAKE_RACE="mv -f '.server.mjs.npipn-new'" run "$REV" install
check 'refused' [ "$rc" != 0 ]
check 'the racer'"'"'s server.mjs stands, nothing of this change went in' \
  bash -c "[ \"\$(cat '$H/server.mjs')\" = 'server DEPLOYED BY A RACER' ] && [ ! -e '$H/ipn.mjs' ] && [ \"\$(cat '$H/admin.mjs')\" = 'admin BASE' ]"
check 'nothing restarted' [ "$(restarts)" = 0 ]

section 'rollback refuses after somebody deployed over this change'
reset_host; touch "$S/migrated"
run "$REV" install
TAG=$(tag)
check 'installed' [ "$rc" = 0 ]
printf 'server DEPLOYED LATER BY ANOTHER SESSION\n' > "$H/server.mjs"
: > "$LOG"; before=$(snap)
run "$REV" rollback "$TAG"
check 'refused' [ "$rc" != 0 ]
check 'names the file, and says to coordinate' out 'changed since this change was installed: server.mjs.*coordinate'
check 'nothing was put back, not even the files nobody touched' [ "$(snap)" = "$before" ]
check 'nothing restarted' [ "$(restarts)" = 0 ]

section 'somebody deploys in the instant between the rollback'"'"'s checks and its swap'
reset_host; touch "$S/migrated"
run "$REV" install
TAG=$(tag)
: > "$LOG"
FAKE_RACE="mv -f '.server.mjs.npipn-back'" run "$REV" rollback "$TAG"
check 'refused' [ "$rc" != 0 ]
check 'the racer'"'"'s server.mjs stands, and nothing else was put back'   bash -c "[ \"\$(cat '$H/server.mjs')\" = 'server DEPLOYED BY A RACER' ] && [ \"\$(cat '$H/ipn.mjs')\" = 'ipn REVIEWED 2' ] && [ \"\$(cat '$H/admin.mjs')\" = 'admin REVIEWED' ] && [ \"\$(cat '$H/delivery.mjs')\" = 'delivery REVIEWED' ]"
check 'nothing restarted' [ "$(restarts)" = 0 ]

section 'rollback refuses a backup that is not what install replaced'
reset_host; touch "$S/migrated"
run "$REV" install
TAG=$(tag)
printf 'admin SOMETHING ELSE\n' > "$H/admin.mjs.bak-npipn-$TAG"
: > "$LOG"; before=$(snap)
run "$REV" rollback "$TAG"
check 'refused' [ "$rc" != 0 ]
check 'nothing changed, nothing restarted' [ "$(snap)" = "$before" -a "$(restarts)" = 0 ]

section 'a change that is not what the script installs'
reset_host; touch "$S/migrated"; before=$(snap)
run "$WIDE" check
check 'refused: it also changes ladder.mjs' [ "$rc" != 0 ]
check 'names it' out 'ladder.mjs'
run "$UNPUSHED" install
check 'install refuses a commit that is not on origin/main' [ "$rc" != 0 ]
check 'says so' out 'not on origin/main'
check 'host unchanged' [ "$(snap)" = "$before" ]

echo
echo "$pass passed, $fail failed ($SCRIPT)"
[ "$fail" = 0 ]
