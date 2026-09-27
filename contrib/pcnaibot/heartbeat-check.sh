#!/bin/sh
# Heartbeat staleness check for the PCoin AI bot.
#
# WHY THIS EXISTS SEPARATELY FROM OnFailure=:
# with Restart=always, a bot that dies and restarts every 30 seconds reports
# `active (running)` forever and OnFailure= never fires. A crash loop is
# invisible to systemd's own notion of failure. This notices.
#
# WHY IT RUNS AS ROOT:
# pcoin-notify reads /etc/pcoin/alert.conf, which is -rw------- root root, and
# its own guard is
#     if [ ! -r "$CONF" ]; then log "no $CONF -- alert not delivered"; exit 0; fi
# so a NON-ROOT caller gets SILENT NON-DELIVERY THAT EXITS 0 -- a timer unit
# reporting success while the alarm on the money path is dead. Run it as root,
# and prove both halves: one run as `pcnaibot` must print the "not delivered"
# line, one run as root must appear in `pcoin-telegram-log show`.
set -eu

NOTIFY="${NOTIFY:-/usr/local/bin/pcoin-notify}"
BOT_HB="${BOT_HB:-/var/lib/pcnaibot/bot-heartbeat.json}"
WATCH_HB="${WATCH_HB:-/var/lib/pcnaibot/heartbeat.json}"
STALE_SECONDS="${STALE_SECONDS:-900}"
STATE_DIR="${STATE_DIR:-/var/lib/pcnaibot}"

now=$(date +%s)
problems=0

log() { logger -t pcnaibot-heartbeat -- "$*" 2>/dev/null || printf '%s\n' "$*"; }

alert() {
    problems=$((problems + 1))
    log "ALERT: $1 -- $2"
    [ -x "$NOTIFY" ] && "$NOTIFY" "$1" "$2" >/dev/null 2>&1
}

# read_at <file> -- prints the `at` value, or nothing if unreadable.
read_at() {
    [ -r "$1" ] || return 0
    python3 -c "import json,sys
try:
    print(json.load(open(sys.argv[1])).get('at',''))
except Exception:
    pass" "$1" 2>/dev/null
}

check() {
    label="$1"; file="$2"; hint="$3"
    at=$(read_at "$file")

    if [ -z "$at" ]; then
        # UNREADABLE IS NOT HEALTHY AND NOT DEAD. It is unknown, and it gets its
        # own message -- collapsing it into either direction is the mistake this
        # whole codebase is written against.
        alert "PCN bot heartbeat unreadable: $label" \
              "Could not read $label's heartbeat at $file. This is NOT proof it is down and NOT proof it is up -- the check itself failed. $hint"
        return
    fi

    age=$((now - at))

    # `at` is UNIX SECONDS. If it is ever milliseconds the age goes hugely
    # negative, which is never greater than STALE_SECONDS, so the staleness
    # check CANNOT FIRE and a dead process reads as healthy. That is webai's
    # 2026-09-06 bug; refuse to be quiet about it.
    if [ "$age" -lt -86400 ]; then
        alert "PCN monitor BROKEN: $label" \
              "$label's heartbeat 'at' is $at, which is far in the future -- almost certainly milliseconds instead of seconds. While that is true the staleness check CANNOT fire. Treat $label as unmonitored until fixed."
        return
    fi

    if [ "$age" -gt "$STALE_SECONDS" ]; then
        # Keep the VARYING QUANTITY out of the deduped text: pcoin-notify dedupes
        # on sha256(SUBJECT+BODY) with REPEAT_HOURS=6, so embedding a
        # minute-count that increments every run means the stamp never matches
        # and a genuinely down rail posts EVERY FIVE MINUTES until fixed --
        # which is how people learn to mute the channel.
        alert "PCN bot STOPPED: $label" \
              "No heartbeat for over $((STALE_SECONDS / 60)) min. $hint"
    fi
}

# A fresh heartbeat is not a healthy bot (review, 2026-09-27): a Stars payment Telegram took and the
# bot could not credit is PARKED and retried, and the bot says so here. Alert every run until it
# is credited. Unreadable is not zero -- read_field prints nothing and nothing is concluded.
read_field() {
    [ -r "$1" ] || return 0
    python3 -c "import json,sys
try:
    v=json.load(open(sys.argv[1])).get(sys.argv[2])
    print('' if v is None else v)
except Exception:
    pass" "$1" "$2" 2>/dev/null
}
parked=$(read_field "$BOT_HB" stars_parked)
case "$parked" in
    ''|0) ;;
    *[!0-9]*) ;;
    *) alert "PCN bot: $parked Stars payment(s) NOT CREDITED" \
             "Telegram took the Stars and the bot could not credit them; they are parked and retried every 2 min. journalctl -u pcnaibot | grep -i parked -- and see kv 'stars:parked:%' in the bot's database." ;;
esac

# Telegram's Stars books against ours (lib/stars-books.mjs, hourly, review 2026-09-27 item D).
# Alerts when the answer CHANGES -- a new mismatch, reads failing, or the check going stale -- and
# once more when it is ok again. STALE = no completed check for 3 h: either the last one is older
# than that, or none has completed since the bot started 3+ h ago ('pending' or a missing field
# from a bot that has been up that long -- follow-up to the 2026-09-27 review). A bot that has only
# just started is given the 3 h. The bot's own staleness is checked below.
BOOKS_SENT="$STATE_DIR/stars-books.alerted"
books=$(python3 -c "
import json, sys, time, hashlib
STALE = 3 * 3600
try:
    hb = json.load(open(sys.argv[1]))
except Exception:
    sys.exit(0)
b = hb.get('stars_books')
started = hb.get('started_at')
up = time.time() - started if isinstance(started, (int, float)) else None
if not isinstance(b, dict):
    if up is not None and up > STALE:
        print('stale|stale|no Stars books check has completed since the bot started %d h ago' % int(up / 3600))
    sys.exit(0)
st = b.get('state') or ''
ca = b.get('checked_at')
if st in ('ok', 'mismatch') and isinstance(ca, (int, float)) and time.time() - ca > STALE:
    st = 'stale'
elif st == 'pending' and ca is None and up is not None and up > STALE:
    print('stale|stale|no Stars books check has completed since the bot started %d h ago' % int(up / 3600))
    sys.exit(0)
probs = [str(p) for p in (b.get('problems') or [])]
detail = ''
sig = st
if st == 'mismatch':
    detail = '; '.join(probs[:5]) + (' (+%d more)' % (len(probs) - 5) if len(probs) > 5 else '')
    sig = 'mismatch:' + hashlib.sha256(json.dumps(sorted(probs)).encode()).hexdigest()[:16]
elif st == 'unknown':
    detail = '%s failed reads in a row: %s' % (b.get('failures'), b.get('last_error'))
elif st == 'stale':
    detail = 'the last completed check was %d h ago' % int((time.time() - ca) / 3600)
print(st + '|' + sig + '|' + detail.replace('|', '/').replace('\n', ' '))
" "$BOT_HB" 2>/dev/null || true)
if [ -n "$books" ]; then
    b_state=${books%%|*}; b_rest=${books#*|}; b_sig=${b_rest%%|*}; b_detail=${b_rest#*|}
    b_last=$(cat "$BOOKS_SENT" 2>/dev/null || true)
    case "$b_state" in
        mismatch|unknown|stale)
            if [ "$b_sig" != "$b_last" ]; then
                case "$b_state" in
                    mismatch) alert "PCN bot: Stars books DO NOT MATCH Telegram" \
                                    "$b_detail. Telegram has Stars our records do not show, or the reverse. admin.pc.am -> PcoinAiBot -> Payments shows both sides." ;;
                    unknown)  alert "PCN bot: Stars books check cannot read Telegram" \
                                    "$b_detail. This is NOT 'the books match' -- nothing is being compared." ;;
                    stale)    alert "PCN bot: Stars books check has stopped" \
                                    "$b_detail; it runs hourly. The comparison is not being made." ;;
                esac
                printf '%s\n' "$b_sig" > "$BOOKS_SENT" 2>/dev/null || true
            fi ;;
        ok)
            if [ -n "$b_last" ]; then
                [ -x "$NOTIFY" ] && "$NOTIFY" "PCN bot: Stars books match Telegram again" "The earlier Stars books alert has cleared." >/dev/null 2>&1
                log "stars books match again (was: $b_last)"
                rm -f "$BOOKS_SENT"
            fi ;;
    esac
fi

check "pcnaibot (telegram)" "$BOT_HB" \
      "systemctl status pcnaibot -- note Restart=always means a crash loop still reports active (running)."
check "pcnaibot (watcher)" "$WATCH_HB" \
      "systemctl list-timers pcnaibot-watch.timer -- 'systemctl start pcnaibot-watch.service' runs one tick."

[ "$problems" -eq 0 ] && log "pcnaibot heartbeats healthy"
exit 0
