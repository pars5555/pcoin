#!/bin/sh
# One-line PCoin install for Debian and Ubuntu:
#
#     curl -fsSL https://pc.am/dl/install.sh | sudo sh
#
# Downloads the current release, checks it against the published SHA256SUMS,
# installs it, and hands straight over to the setup wizard.
#
# The checksum check is not decoration. This script is fetched over the network
# and then installs a binary that will hold a payout address, so "the download
# completed" is not the same claim as "the download is the file the project
# published". A mismatch aborts; it never warns and continues.
#
# Deliberately no version pinned in here. The Windows installer pins one and
# every release therefore needs a manual bump that has been forgotten before;
# resolving through /releases/latest/download means this file is correct for
# every future release without being edited.
set -eu

BASE="https://github.com/pars5555/pcoin/releases/latest/download"
DEB="pcoin-linux-amd64.deb"

if [ -t 1 ]; then
    B=$(printf '\033[1m'); G=$(printf '\033[32m'); R=$(printf '\033[31m'); N=$(printf '\033[0m')
else
    B=''; G=''; R=''; N=''
fi

fail() { printf '%s%s%s\n' "$R" "$*" "$N" >&2; exit 1; }

[ "$(id -u)" = 0 ] || fail "Run this with sudo:  curl -fsSL https://pc.am/dl/install.sh | sudo sh"

case "$(uname -m)" in
    x86_64|amd64) : ;;
    *) fail "This package is amd64 only; this machine is $(uname -m).
Build from source instead: https://github.com/pars5555/pcoin" ;;
esac
command -v dpkg >/dev/null 2>&1 || fail "This installer is for Debian and Ubuntu (no dpkg here)."

# curl or wget, whichever the box has.
if command -v curl >/dev/null 2>&1; then
    GET="curl -fsSL -o"
elif command -v wget >/dev/null 2>&1; then
    GET="wget -q -O"
else
    fail "Neither curl nor wget is installed."
fi

TMP=$(mktemp -d)
# Clean up on any exit, including the failure paths above this point being hit
# later -- a half-downloaded .deb left in /tmp is how people install the wrong
# thing next time.
trap 'rm -rf "$TMP"' EXIT INT TERM

printf '%sDownloading PCoin...%s\n' "$B" "$N"
$GET "$TMP/$DEB" "$BASE/$DEB" || fail "Download failed: $BASE/$DEB"
$GET "$TMP/SHA256SUMS" "$BASE/SHA256SUMS" || fail "Could not fetch SHA256SUMS."

WANT=$(awk -v f="$DEB" '$2 == f || $2 == "*" f { print $1; exit }' "$TMP/SHA256SUMS")
[ -n "$WANT" ] || fail "SHA256SUMS does not list $DEB -- refusing to install."
GOT=$(sha256sum "$TMP/$DEB" | awk '{print $1}')
if [ "$WANT" != "$GOT" ]; then
    fail "CHECKSUM MISMATCH -- not installing.
  published $WANT
  got       $GOT"
fi
printf '  %schecksum verified%s\n\n' "$G" "$N"

printf '%sInstalling...%s\n' "$B" "$N"
# apt-get resolves the libevent dependencies; plain dpkg -i would not.
if command -v apt-get >/dev/null 2>&1; then
    # NEEDRESTART_SUSPEND silences Ubuntu's "services being deferred" wall of
    # text. It is advice about OTHER packages and it buries the one line that
    # matters here. Nothing PCoin installs needs a service restart to work.
    # Output is captured rather than discarded: hidden on success, shown in full
    # when it fails, because "apt could not install the package" on its own is
    # useless to whoever has to fix it. $TMP is gone by then, so the log cannot
    # just point at it.
    if ! DEBIAN_FRONTEND=noninteractive NEEDRESTART_SUSPEND=1 \
         apt-get install -y -q "$TMP/$DEB" >"$TMP/apt.log" 2>&1; then
        printf '%s\n' "$R--- apt output ---$N" >&2
        tail -25 "$TMP/apt.log" >&2
        fail "Install failed. The apt output above says why."
    fi
else
    dpkg -i "$TMP/$DEB" || fail "dpkg failed; install libevent 2.1 and retry."
fi
printf '  %sinstalled%s\n' "$G" "$N"

# The wizard needs to read answers from the person, but when this script is
# piped into sh, stdin IS the script -- reading from it would consume the rest
# of this file and get nonsense. Reopen the terminal explicitly.
if [ -e /dev/tty ] && (: </dev/tty) 2>/dev/null; then
    printf '\n'
    exec /opt/pcoin/bin/pcoin-setup </dev/tty >/dev/tty 2>&1
fi

printf '\n  Now run:  %ssudo pcoin-setup%s\n\n' "$B" "$N"
