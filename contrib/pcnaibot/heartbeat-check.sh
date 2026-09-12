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

check "pcnaibot (telegram)" "$BOT_HB" \
      "systemctl status pcnaibot -- note Restart=always means a crash loop still reports active (running)."
check "pcnaibot (watcher)" "$WATCH_HB" \
      "systemctl list-timers pcnaibot-watch.timer -- 'systemctl start pcnaibot-watch.service' runs one tick."

[ "$problems" -eq 0 ] && log "pcnaibot heartbeats healthy"
exit 0
