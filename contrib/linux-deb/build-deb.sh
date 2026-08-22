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

HERE="$(cd "$(dirname "$0")" && pwd)"

install -m 755 "$SRC/bitcoind"    "$OUT/pkg/opt/pcoin/bin/bitcoind"
install -m 755 "$SRC/bitcoin-cli" "$OUT/pkg/opt/pcoin/bin/bitcoin-cli"
ln -s /opt/pcoin/bin/bitcoind    "$OUT/pkg/usr/bin/pcoind"
ln -s /opt/pcoin/bin/bitcoin-cli "$OUT/pkg/usr/bin/pcoin-cli"

# The friendly layer. Without these, mining on Linux meant editing a config,
# enabling a unit, watching for sync by hand, and then calling startmining with
# an address and re-calling getcpuminerinfo forever to feed the dead-man's
# switch. Two steps in that sequence lose money when done wrong, so they are
# now a wizard and a supervisor rather than instructions in a README.
for f in pcoin-setup pcoin-mine pcoin-miner-supervisor; do
    [ -f "$HERE/$f" ] || { echo "missing $HERE/$f" >&2; exit 1; }
    install -m 755 "$HERE/$f" "$OUT/pkg/opt/pcoin/bin/$f"
done
ln -s /opt/pcoin/bin/pcoin-setup "$OUT/pkg/usr/bin/pcoin-setup"
ln -s /opt/pcoin/bin/pcoin-mine  "$OUT/pkg/usr/bin/pcoin-mine"

# The binaries link libevent dynamically. The first published .deb declared only
# libc6, so on any distro that does not already carry libevent's extra and
# pthreads modules the install SUCCEEDED and then bitcoind died on every start
# with "libevent_extra-2.1.so.7: cannot open shared object file". Ubuntu 26.04
# ships libevent_core only, so it hit this immediately.
#
# It happened AGAIN in v1.3.0 with libsqlite3-0, libstdc++6 and libgcc-s1
# undeclared, so printing the list below is no longer enough on its own -- the
# Depends line is now CHECKED against it further down, and a mismatch fails the
# build. See soname_pkg() and the enforcement block after the glibc floor.
if command -v objdump >/dev/null 2>&1; then
    echo "shared libraries the binary actually needs:"
    objdump -p "$SRC/bitcoind" | awk '/NEEDED/ {print "  " $2}'
fi

# soname -> Debian package. This is the map the Depends line is CHECKED against
# below; printing the NEEDED list was not enough, because printing something
# nobody diffs is the same as not knowing it. v1.3.0 shipped without
# libsqlite3-0, libstdc++6 or libgcc-s1 declared: the package installed cleanly
# on Ubuntu 24.04 and then every start died with
#   "libsqlite3.so.0: cannot open shared object file"
# which is exactly the libevent incident from CLAUDE.md 7.12, wearing a
# different library's clothes. Adding a soname here without adding its package
# to Depends now fails the build instead of shipping.
soname_pkg() {
    case "$1" in
        libevent_core-2.1.so.7)     echo "libevent-core-2.1-7" ;;
        libevent_extra-2.1.so.7)    echo "libevent-extra-2.1-7" ;;
        libevent_pthreads-2.1.so.7) echo "libevent-pthreads-2.1-7" ;;
        libsqlite3.so.0)            echo "libsqlite3-0" ;;
        libstdc++.so.6)             echo "libstdc++6" ;;
        libgcc_s.so.1)              echo "libgcc-s1" ;;
        libm.so.6|libc.so.6|ld-linux-x86-64.so.2|libpthread.so.0|libdl.so.2|librt.so.1)
                                    echo "libc6" ;;
        *)                          echo "" ;;
    esac
}

# The libc floor is READ FROM THE BINARY, not written down here.
#
# It was hardcoded as `libc6 (>= 2.31)` while the binary actually required
# GLIBC_2.38, which is the same failure as the libevent one above wearing
# different clothes: dpkg checks the declared version, is satisfied, installs
# cleanly, and then every start dies with "version `GLIBC_2.38' not found". A
# declared dependency that is LOOSER than the truth is worse than a missing one,
# because it converts a refusal-to-install into a crash loop.
#
# Whichever toolchain builds the release sets this, so it cannot drift.
LIBC=$(objdump -T "$SRC/bitcoind" 2>/dev/null \
       | grep -oE 'GLIBC_[0-9]+\.[0-9]+' | sort -V | tail -1 | cut -d_ -f2)
if [ -z "$LIBC" ]; then
    echo "WARNING: could not read the glibc requirement from the binary." >&2
    echo "Refusing to guess a floor -- an understated one installs and then crashes." >&2
    exit 1
fi
echo "glibc floor read from the binary: $LIBC"

# The (A | B) alternatives cover the 64-bit time_t rename: Debian 12 and older
# Ubuntu use libevent-*-2.1-7, newer Ubuntu uses the -7t64 names.
#
# adduser is here because the postinst calls it and Debian 13 minimal no longer
# ships it. The postinst falls back to useradd, but a declared dependency is
# what makes the good path happen under apt.
DEPENDS="libc6 (>= $LIBC), adduser, libsqlite3-0, libstdc++6, libgcc-s1"
DEPENDS="$DEPENDS, libevent-core-2.1-7t64 | libevent-core-2.1-7"
DEPENDS="$DEPENDS, libevent-extra-2.1-7t64 | libevent-extra-2.1-7"
DEPENDS="$DEPENDS, libevent-pthreads-2.1-7t64 | libevent-pthreads-2.1-7"

# ENFORCE the map: every soname the binaries actually need must resolve to a
# package that appears in Depends. This is the check that would have caught
# both shipped bugs -- the missing libevent modules and the missing
# libsqlite3-0 -- before a user ever saw them. It is deliberately a build
# FAILURE, not a warning: a warning in build output is a warning nobody reads.
if command -v objdump >/dev/null 2>&1; then
    MISSING=""
    for BIN in bitcoind bitcoin-cli; do
        [ -f "$SRC/$BIN" ] || continue
        for SO in $(objdump -p "$SRC/$BIN" | awk '/NEEDED/ {print $2}'); do
            PKG=$(soname_pkg "$SO")
            if [ -z "$PKG" ]; then
                MISSING="$MISSING\n  $SO (from $BIN) -- unknown soname, add it to soname_pkg()"
            elif ! printf '%s' "$DEPENDS" | grep -q -- "$PKG"; then
                MISSING="$MISSING\n  $SO (from $BIN) -- needs '$PKG' in Depends"
            fi
        done
    done
    if [ -n "$MISSING" ]; then
        printf 'REFUSING TO BUILD: undeclared shared-library dependencies:%b\n' "$MISSING" >&2
        echo "An install that succeeds proves the files were copied, nothing more." >&2
        exit 1
    fi
    echo "dependency check: every NEEDED soname is covered by Depends"
fi

SIZE=$(du -sk "$OUT/pkg" | cut -f1)

cat > "$OUT/pkg/DEBIAN/control" <<EOF
Package: pcoin
Version: $VER
Section: net
Priority: optional
Architecture: amd64
Maintainer: PCoin Project <pcoin@pc.am>
Installed-Size: $SIZE
Depends: $DEPENDS
Homepage: https://pc.am
Description: PCoin full node and CLI
 PCoin (PCN) is an independent Layer-1 blockchain: Bitcoin's economics with
 RandomX CPU proof-of-work, so an ordinary processor is a competitive miner.
 .
 Installs the node and CLI as pcoind and pcoin-cli. The binaries keep their
 upstream names inside /opt/pcoin/bin, so this package never collides with
 Bitcoin Core.
 .
 Run "sudo pcoin-setup" to choose a payout address and start mining, then
 "pcoin-mine" to watch it. Nothing mines until you do: a node that mines
 before it has synced builds on a chain it has not verified.
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

# Mining is a SEPARATE unit from the node on purpose. Stopping mining should
# never mean stopping the node -- a node that leaves the network when its owner
# turns mining off makes the chain weaker for everyone else too.
cat > "$OUT/pkg/lib/systemd/system/pcoin-miner.service" <<'EOF'
[Unit]
Description=PCoin miner
After=pcoind.service
Wants=pcoind.service
# Deliberately NOT BindsTo/PartOf. Those propagate a pcoind stop into a miner
# stop, and propagation is one-way: `systemctl restart pcoind` would leave
# mining off until the next reboot, silently. The supervisor already rides out
# a node restart on its own, so coupling the units only adds a failure mode.

[Service]
Type=simple
User=pcoin
Group=pcoin
ExecStart=/opt/pcoin/bin/pcoin-miner-supervisor
Restart=always
RestartSec=10

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
    # adduser is Priority:important, NOT essential, and Debian 13 (trixie)
    # minimal installs and every debian:13 container ship without it. The
    # package declares Depends: adduser so apt pulls it in -- but `dpkg -i`
    # does not resolve dependencies, and install.sh falls back to exactly that.
    # Without this branch the postinst died with "adduser: not found" (exit
    # 127) AFTER the files were unpacked, leaving the package half-configured.
    # useradd/groupadd come from `passwd`, which is Priority:required, so they
    # are always present.
    if command -v adduser >/dev/null 2>&1; then
        adduser --system --group --home /var/lib/pcoin --no-create-home \
                --gecos "PCoin node" pcoin >/dev/null
    else
        getent group pcoin >/dev/null || groupadd --system pcoin
        useradd --system --gid pcoin --home-dir /var/lib/pcoin --no-create-home \
                --shell /usr/sbin/nologin --comment "PCoin node" pcoin
    fi
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
addnode=152.53.171.190:9444
addnode=178.105.3.51:9444
CONF
    chown pcoin:pcoin /var/lib/pcoin/pcoin.conf
    chmod 640 /var/lib/pcoin/pcoin.conf
fi

mkdir -p /etc/pcoin

if [ -d /run/systemd/system ]; then
    systemctl daemon-reload || true
    # On an UPGRADE the binaries under the running services just changed, so
    # restart whatever was already enabled. Never enable anything here: mining
    # is opt-in, and an install that silently starts mining is not acceptable.
    if systemctl is-enabled --quiet pcoind 2>/dev/null; then
        systemctl restart pcoind || true
        if systemctl is-enabled --quiet pcoin-miner 2>/dev/null; then
            systemctl restart pcoin-miner || true
        fi
    fi
fi

echo ""
echo "  PCoin installed."
echo ""
echo "    sudo pcoin-setup     choose a payout address and start mining"
echo "    pcoin-mine           watch it work"
echo ""
echo "  Nothing is mining yet. pcoin-setup starts the node, waits for it to"
echo "  sync, and only then begins -- mining sooner builds on unverified blocks."
echo ""
exit 0
EOF
chmod 755 "$OUT/pkg/DEBIAN/postinst"

cat > "$OUT/pkg/DEBIAN/prerm" <<'EOF'
#!/bin/sh
set -e
# Stop the miner before the node: the supervisor's shutdown path calls
# stopmining, which needs the node still answering RPC to do anything.
if [ -d /run/systemd/system ]; then
    systemctl stop pcoin-miner >/dev/null 2>&1 || true
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
