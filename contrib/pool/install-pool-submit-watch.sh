#!/bin/bash
# Install pcoin-pool-submit-watch on the pool host, every 5 minutes.
#
# This is the watcher whose absence let 17 blocks be destroyed in silence on
# 2026-09-05. The pool host had exactly two cron entries -- certbot and
# e2scrub_all -- and nothing at all watching the pool.
#
# OnFailure is deliberately NOT wired: the script does its own notifying and
# exits 0 whether or not it alerted, so a systemd failure here would mean the
# script itself broke, which is what the CANNOT VERIFY branch already covers.
set -euo pipefail

install -m 644 /dev/stdin /etc/systemd/system/pcoin-pool-submit-watch.service <<'UNIT'
[Unit]
Description=PCoin pool submit watch - can the pool actually get a block to the node
After=network-online.target

[Service]
Type=oneshot
Environment=POOL_LOG=/var/log/pcoin-pool.log
Environment=POOL_DB=/opt/pcoin-pool/pool.sqlite
Environment=POOL_CLI=/opt/pcoin/bin/bitcoin-cli
Environment=POOL_DATADIR=-datadir=/var/lib/pcoin
Environment=POOL_WATCH_STATE=/var/lib/pcoin-monitor/pool-submit-watch.json
Environment=POOL_EXPECTED_BLOCKS=4.0
Environment=POOL_FAIL_STREAK=3
ExecStart=/usr/local/bin/pcoin-pool-submit-watch
Nice=10
MemoryMax=128M
TimeoutStartSec=120
UNIT

install -m 644 /dev/stdin /etc/systemd/system/pcoin-pool-submit-watch.timer <<'UNIT'
[Unit]
Description=Run the PCoin pool submit watch every 5 minutes

[Timer]
OnBootSec=3min
OnUnitActiveSec=5min
AccuracySec=30s
Persistent=true

[Install]
WantedBy=timers.target
UNIT

mkdir -p /var/lib/pcoin-monitor
systemctl daemon-reload
systemctl enable --now pcoin-pool-submit-watch.timer >/dev/null
echo "  timer: $(systemctl is-active pcoin-pool-submit-watch.timer), next $(systemctl list-timers pcoin-pool-submit-watch.timer --no-pager | awk 'NR==2{print $1, $2, $3}')"
echo "  notifier present: $([ -x /usr/local/bin/pcoin-notify ] && echo yes || echo 'NO -- alerts would be printed, not sent')"
