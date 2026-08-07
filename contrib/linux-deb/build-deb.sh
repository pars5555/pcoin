#!/bin/bash
# Build a .deb for PCoin on Debian/Ubuntu.
#
# Chosen over a raw tarball as the "easiest" Linux route because apt handles
# install, upgrade and removal, and a systemd unit means the node survives a
# reboot without the user writing one.
#
# The binaries are installed to /opt/pcoin/bin and exposed as `pcoind` and
# `pcoin-cli`. They are NOT installed as /usr/bin/bitcoind: that path belongs to
# Bitcoin Core's own package, and dpkg refuses to overwrite another package's
# file. Anyone with both installed would otherwise be unable to install this at
# all.
set -eu
VER="${1:-1.2.2}"
SRC="${2:?path to extracted pcoin-<ver>/bin required}"
OUT="${3:-/tmp/debbuild}"

rm -rf "$OUT"; mkdir -p "$OUT/pkg/DEBIAN" "$OUT/pkg/opt/pcoin/bin" \
  "$OUT/pkg/usr/bin" "$OUT/pkg/lib/systemd/system" "$OUT/pkg/usr/share/doc/pcoin"

install -m 755 "$SRC/bitcoind"    "$OUT/pkg/opt/pcoin/bin/bitcoind"
install -m 755 "$SRC/bitcoin-cli" "$OUT/pkg/opt/pcoin/bin/bitcoin-cli"
ln -s /opt/pcoin/bin/bitcoind    "$OUT/pkg/usr/bin/pcoind"
ln -s /opt/pcoin/bin/bitcoin-cli "$OUT/pkg/usr/bin/pcoin-cli"

SIZE=$(du -sk "$OUT/pkg" | cut -f1)

cat > "$OUT/pkg/DEBIAN/control" <<EOF
Package: pcoin
Version: $VER
Section: net
Priority: optional
Architecture: amd64
Maintainer: PCoin Project <pcoin@pc.am>
Installed-Size: $SIZE
Depends: libc6 (>= 2.31)
Homepage: https://pc.am
Description: PCoin full node and CLI
 PCoin (PCN) is an independent Layer-1 blockchain: Bitcoin's economics with
 RandomX CPU proof-of-work, so an ordinary processor is a competitive miner.
 .
 Installs the node and CLI as pcoind and pcoin-cli. The binaries keep their
 upstream names inside /opt/pcoin/bin, so this package never collides with
 Bitcoin Core.
 .
 A systemd unit is provided but NOT enabled: run
 "sudo systemctl enable --now pcoind" when you are ready. Mining is off by
 default, because a node that mines before it has synced builds on a chain it
 has not verified.
EOF

cat > "$OUT/pkg/lib/systemd/system/pcoind.service" <<'EOF'
[Unit]
Description=PCoin full node
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pcoin
Group=pcoin
ExecStart=/opt/pcoin/bin/bitcoind -datadir=/var/lib/pcoin -printtoconsole
# -daemon is deliberately absent: systemd supervises the process, and Type=simple
# with a forking daemon gives systemd a PID that exits immediately.
ExecStop=/opt/pcoin/bin/bitcoin-cli -datadir=/var/lib/pcoin stop
Restart=on-failure
RestartSec=15
TimeoutStopSec=300

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full
ProtectHome=true
ReadWritePaths=/var/lib/pcoin

[Install]
WantedBy=multi-user.target
EOF

cat > "$OUT/pkg/DEBIAN/postinst" <<'EOF'
#!/bin/sh
set -e
if ! getent passwd pcoin >/dev/null; then
    adduser --system --group --home /var/lib/pcoin --no-create-home \
            --gecos "PCoin node" pcoin >/dev/null
fi
mkdir -p /var/lib/pcoin
chown pcoin:pcoin /var/lib/pcoin
chmod 710 /var/lib/pcoin

# The config file is pcoin.conf, not bitcoin.conf. A node given bitcoin.conf
# ignores it silently, which is the most common newcomer mistake on this fork.
if [ ! -f /var/lib/pcoin/pcoin.conf ]; then
    cat > /var/lib/pcoin/pcoin.conf <<'CONF'
# Generated on install. Safe to edit.
server=1
listen=1
dbcache=300
maxconnections=40
# Fee estimation has no history on a chain this young; without a fallback
# every send fails with "Fee estimation failed".
fallbackfee=0.00001
changetype=bech32
addnode=35.239.156.16:9444
addnode=35.238.47.14:9444
addnode=178.105.3.51:9444
CONF
    chown pcoin:pcoin /var/lib/pcoin/pcoin.conf
    chmod 640 /var/lib/pcoin/pcoin.conf
fi

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
fi

echo ""
echo "PCoin installed. The node is NOT running yet."
echo "  start it:      sudo systemctl enable --now pcoind"
echo "  check on it:   pcoin-cli -datadir=/var/lib/pcoin getblockchaininfo"
echo "  explorer:      https://explorer.pc.am"
echo ""
exit 0
EOF
chmod 755 "$OUT/pkg/DEBIAN/postinst"

cat > "$OUT/pkg/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
if [ -d /run/systemd/system ]; then
    systemctl stop pcoind >/dev/null 2>&1 || true
fi
exit 0
EOF
chmod 755 "$OUT/pkg/DEBIAN/prerm"

# The chain and any wallet live in /var/lib/pcoin and are NEVER removed by the
# package. Deleting somebody's wallet on `apt remove` would be unforgivable.
cat > "$OUT/pkg/DEBIAN/postrm" <<'EOF'
#!/bin/sh
set -e
if [ "$1" = "purge" ]; then
    echo "NOTE: /var/lib/pcoin was left in place. It holds the blockchain and"
    echo "      any wallet. Remove it by hand if you really want it gone."
fi
if [ -d /run/systemd/system ]; then
    systemctl daemon-reload >/dev/null 2>&1 || true
fi
exit 0
EOF
chmod 755 "$OUT/pkg/DEBIAN/postrm"

cp /dev/null "$OUT/pkg/usr/share/doc/pcoin/README"
echo "PCoin $VER - https://github.com/pars5555/pcoin" > "$OUT/pkg/usr/share/doc/pcoin/README"

dpkg-deb --build --root-owner-group "$OUT/pkg" "$OUT/pcoin_${VER}_amd64.deb" >/dev/null
echo "built: $OUT/pcoin_${VER}_amd64.deb"
dpkg-deb --info "$OUT/pcoin_${VER}_amd64.deb" | head -14
echo "--- contents ---"
dpkg-deb --contents "$OUT/pcoin_${VER}_amd64.deb" | awk '{print "  "$6" "$7" "$8}'
