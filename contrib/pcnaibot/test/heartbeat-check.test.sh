#!/bin/sh
# Tests for heartbeat-check.sh's Stars books rules. Sends nothing: NOTIFY is a fake that
# records what WOULD have been sent. Run on any box with python3:  sh test/heartbeat-check.test.sh
set -u
HERE=$(cd "$(dirname "$0")/.." && pwd)
T=$(mktemp -d)
trap 'rm -rf "$T"' EXIT
cat > "$T/notify" <<'EOF'
#!/bin/sh
printf '%s\n' "$1" >> "$(dirname "$0")/sent"
EOF
chmod +x "$T/notify"
now=$(date +%s)
fail=0

# run <name> <expected subject regex or NONE> <stars_books json> <started_at>
run() {
  name=$1; want=$2; books=$3; started=$4
  rm -f "$T/sent" "$T/stars-books.alerted"
  printf '{"at": %s, "stars_parked": 0, "stars_books": %s, "started_at": %s}\n' "$now" "$books" "$started" > "$T/bot.json"
  printf '{"at": %s}\n' "$now" > "$T/watch.json"
  NOTIFY="$T/notify" BOT_HB="$T/bot.json" WATCH_HB="$T/watch.json" STATE_DIR="$T" sh "$HERE/heartbeat-check.sh" >/dev/null 2>&1
  got=$(cat "$T/sent" 2>/dev/null || true)
  if [ "$want" = NONE ]; then
    [ -z "$got" ] && echo "ok   $name" || { echo "FAIL $name: sent '$got'"; fail=1; }
  else
    printf '%s' "$got" | grep -qE "$want" && echo "ok   $name" || { echo "FAIL $name: wanted /$want/, sent '$got'"; fail=1; }
  fi
}

H=3600
run "fresh ok check is quiet"                 NONE        "{\"state\":\"ok\",\"checked_at\":$((now - 600))}"   "$((now - 5*H))"
run "last check 4 h ago is stopped"           "has stopped" "{\"state\":\"ok\",\"checked_at\":$((now - 4*H))}" "$((now - 9*H))"
run "pending, bot up 1 h: given time"         NONE        '{"state":"pending","checked_at":null}'              "$((now - H))"
run "pending, bot up 4 h: stopped"            "has stopped" '{"state":"pending","checked_at":null}'            "$((now - 4*H))"
run "no books field, bot up 4 h: stopped"     "has stopped" 'null'                                             "$((now - 4*H))"
run "no books field, no started_at: silent"   NONE        'null'                                               'null'
run "mismatch still alerts"                   "DO NOT MATCH" "{\"state\":\"mismatch\",\"checked_at\":$((now - 60)),\"problems\":[\"x\"]}" "$((now - 5*H))"

exit $fail
