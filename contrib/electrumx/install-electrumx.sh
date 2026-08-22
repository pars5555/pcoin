#!/bin/sh
# Install or update an ElectrumX server for PCoin. Idempotent: safe to re-run.
#
#   ./install-electrumx.sh <public-hostname>
#
# e.g.  ./install-electrumx.sh electrum1.pc.am
#
# WHAT THIS DELIBERATELY DOES NOT DO: it does not obtain a certificate and it
# does not enable ssl:// or wss://. It brings the server up on plain tcp:// only,
# because the thing worth proving first is that the INDEX IS CORRECT, and that is
# provable without TLS. Run enable-tls.sh afterwards. Doing it in that order also
# means a DNS record that has not propagated yet blocks nothing.
#
# Requires /etc/electrumx/daemon.env to already exist, holding DAEMON_URL for an
# RPC identity on the local node dedicated to ElectrumX. It is a separate file
# from electrumx.env purely so that the one file containing a password can be
# 0600 while the rest stays readable for debugging.
set -e

HOSTNAME_PUB="$1"
[ -n "$HOSTNAME_PUB" ] || { echo "usage: $0 <public-hostname>" >&2; exit 2; }

# Pinned. Tag 2.0.0 and master were the same commit (280cb339aa15, 2026-07-03)
# when this was written. Pin the tag: an upstream force-push must not silently
# change what runs on a server whose failure delists the coin.
REPO=https://github.com/spesmilo/electrumx
TAG=2.0.0
SRC=/opt/electrumx
DB=/var/lib/electrumx
ENVD=/etc/electrumx
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

command -v git >/dev/null || { echo "git missing" >&2; exit 1; }
[ -f "$ENVD/daemon.env" ] || { echo "$ENVD/daemon.env missing -- create the node RPC identity first" >&2; exit 1; }
grep -q '^DAEMON_URL=' "$ENVD/daemon.env" || { echo "$ENVD/daemon.env has no DAEMON_URL" >&2; exit 1; }

id electrumx >/dev/null 2>&1 || useradd --system --home-dir "$DB" --shell /usr/sbin/nologin electrumx
install -d -o electrumx -g electrumx -m 0750 "$DB"

if [ -d "$SRC/.git" ]; then
	git -C "$SRC" fetch --tags --quiet origin
	# Discard any previous append first, so re-running cannot stack duplicates.
	git -C "$SRC" checkout --quiet --force "$TAG"
else
	git clone --quiet --branch "$TAG" --depth 1 "$REPO" "$SRC"
fi

COINS="$SRC/src/electrumx/lib/coins.py"
if ! grep -q 'class PCoin(Coin)' "$COINS"; then
	printf '\n\n' >> "$COINS"
	# Everything above "class PCoin" in that file is a header comment explaining
	# why the file exists; only the class itself belongs in coins.py.
	sed -n '/^class PCoin(Coin):/,$p' "$HERE/pcoin_coin_class.py" >> "$COINS"
fi
grep -q 'class PCoin(Coin)' "$COINS" || { echo "coin class did not apply" >&2; exit 1; }

# Upstream supports Python 3.10-3.14, so the distro interpreter is fine on both
# Debian 12 (3.11) and Debian 13 (3.13). The venv is still required: Debian 13
# marks the system interpreter externally-managed (PEP 668).
[ -d "$SRC/.venv" ] || python3 -m venv "$SRC/.venv"
"$SRC/.venv/bin/pip" install --quiet --upgrade pip wheel
"$SRC/.venv/bin/pip" install --quiet "$SRC[leveldb]"

# Group-owned by electrumx, NOT root:root. enable-tls.sh later drops the
# certificate in $ENVD/ssl, and a 0750 root:root parent means the service
# cannot traverse into it -- ElectrumX dies with a bare
# "PermissionError: [Errno 13]" that names no path. daemon.env stays 0600
# root:root inside it; systemd reads EnvironmentFile as root before
# dropping privileges, so the group has no way to see the password.
install -d -m 0750 -o root -g electrumx "$ENVD"
if [ ! -f "$ENVD/electrumx.env" ]; then
	# systemd EnvironmentFile syntax: KEY=value, no spaces around '='. ElectrumX's
	# own docs show "COIN = Bitcoin" because they assume an envdir; that spacing
	# is wrong here and produces variables that are never read.
	cat > "$ENVD/electrumx.env" <<EOF
# ElectrumX for PCoin. Written by install-electrumx.sh; edit freely afterwards.
COIN=PCoin
NET=mainnet
DB_DIRECTORY=$DB
DB_ENGINE=leveldb

# tcp only for now. enable-tls.sh rewrites these two lines to add ssl:// and
# wss:// once a real certificate exists. rpc:// is the local admin socket that
# electrumx_rpc talks to; it must stay on loopback.
SERVICES=tcp://:50001,rpc://127.0.0.1:8000
REPORT_SERVICES=tcp://$HOSTNAME_PUB:50001

# NOTE: do NOT add REPORT_HOST here. Upstream lists it as obsolete and refuses
# to start if it is set at all; the hostname belongs in REPORT_SERVICES.

# The chain is a few thousand blocks. Nothing here needs a large cache.
CACHE_MB=400
MAX_SESSIONS=500

# 'on' crawls and gossips, which is what lets electrum1 and electrum2 report
# each other to clients. The PEERS list in the coin class seeds it.
PEER_DISCOVERY=on
# CAREFUL: this is parsed by EnvBase.boolean(), which is true for ANY non-empty
# string -- "false" and "no" both mean TRUE. To turn it off, set it to nothing.
PEER_ANNOUNCE=yes

# Pin proxy detection to the conventional Tor port. Left unset, ElectrumX probes
# localhost 9050, 9150 AND 1080 and adopts whatever answers -- on seed 3 that is
# gost, an unrelated SOCKS relay, which would silently start carrying PCoin peer
# traffic. Nothing listens on 9050 on either host, so this disables the proxy.
TOR_PROXY_PORT=9050

LOG_LEVEL=info
EOF
	chmod 0640 "$ENVD/electrumx.env"
fi

cat > /etc/systemd/system/electrumx.service <<EOF
[Unit]
Description=ElectrumX server for PCoin ($HOSTNAME_PUB)
Documentation=https://github.com/pars5555/pcoin/blob/main/contrib/electrumx/README.md
After=network-online.target
Wants=network-online.target

[Service]
# daemon.env holds DAEMON_URL (which embeds the RPC password) and is 0600.
# electrumx.env holds everything else.
EnvironmentFile=$ENVD/daemon.env
EnvironmentFile=$ENVD/electrumx.env
ExecStart=$SRC/.venv/bin/electrumx_server
User=electrumx
Group=electrumx
Type=simple
Restart=always
RestartSec=10s
# ElectrumX flushes its DB on SIGINT; SIGTERM is not the clean path.
KillSignal=SIGINT
TimeoutStopSec=120

# --- hardening ---
# ElectrumX needs no privilege at all: every port it binds is above 1024.
NoNewPrivileges=true
CapabilityBoundingSet=
AmbientCapabilities=
PrivateTmp=true
PrivateDevices=true
ProtectSystem=strict
ProtectHome=true
ProtectKernelTunables=true
ProtectKernelModules=true
ProtectControlGroups=true
RestrictSUIDSGID=true
RestrictRealtime=true
LockPersonality=true
ReadWritePaths=$DB
# LevelDB opens many files; upstream silently lowers MAX_SESSIONS if this is low.
LimitNOFILE=8192

[Install]
WantedBy=multi-user.target
EOF

systemctl daemon-reload
systemctl enable --quiet electrumx
systemctl restart electrumx
echo "electrumx installed for $HOSTNAME_PUB at tag $TAG"
