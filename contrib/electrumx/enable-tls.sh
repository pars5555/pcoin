#!/bin/sh
# Obtain a real Let's Encrypt certificate for a PCoin ElectrumX server and turn
# on ssl:// and wss://. Idempotent: safe to re-run.
#
#   ./enable-tls.sh <public-hostname> [admin-email]
#
# Run install-electrumx.sh first. This is a separate script on purpose -- see the
# comment at the top of that one.
#
# Komodo's listing rules are the reason every choice here is what it is:
#
#   * The certificate must be publicly trusted. A self-signed one forces
#     "disable_cert_verification": true in the coins entry, which is the single
#     most common reviewer objection and is worse than it looks -- in the
#     browser (WASM) build it is the BROWSER, not Komodo, that validates, and a
#     browser cannot be told to skip it.
#   * WSS is not optional in practice. A coin with no working WSS server never
#     appears in the web wallet's generated config at all, silently, without
#     anyone filing a delisting.
#   * The renewal has to be unattended AND has to restart ElectrumX, because
#     ElectrumX reads the certificate once at startup. A certificate that
#     renewed correctly while the server kept serving the old one is how this
#     fails 60 days from now, long after anybody is watching.
set -e

HOSTNAME_PUB="$1"
EMAIL="${2:-pcoin@pc.am}"
[ -n "$HOSTNAME_PUB" ] || { echo "usage: $0 <public-hostname> [admin-email]" >&2; exit 2; }

ENVD=/etc/electrumx
WEBROOT=/var/www/acme
LIVE=/etc/letsencrypt/live/$HOSTNAME_PUB

command -v certbot >/dev/null || { echo "certbot missing" >&2; exit 1; }
[ -f "$ENVD/electrumx.env" ] || { echo "run install-electrumx.sh first" >&2; exit 1; }

# The hostname must already resolve to THIS machine, or the challenge is served
# by somebody else and certbot fails with an error that reads like a webroot
# problem. Check it here so the failure names the real cause.
RESOLVED=$(getent ahostsv4 "$HOSTNAME_PUB" 2>/dev/null | awk '{print $1; exit}')
if [ -z "$RESOLVED" ]; then
	# The LOCAL resolver saying NXDOMAIN proves nothing about what Let's Encrypt
	# will see. A host whose ElectrumX has been retrying peer discovery against
	# a name that did not exist yet has a negative cache entry for it, good for
	# the zone's SOA minimum -- 30 minutes on Cloudflare. Ask a public resolver
	# before concluding the record is missing.
	for R in 1.1.1.1 8.8.8.8; do
		RESOLVED=$(nslookup "$HOSTNAME_PUB" "$R" 2>/dev/null |
			awk '/^Name:/{f=1} f&&/^Address: /{print $2; exit}')
		[ -n "$RESOLVED" ] && { echo "note: local resolver has a stale negative cache entry; $R says $RESOLVED"; break; }
	done
fi
if [ -z "$RESOLVED" ]; then
	echo "$HOSTNAME_PUB does not resolve anywhere. Add the A record (grey cloud) first." >&2
	exit 1
fi
MYIPS=$(ip -4 -o addr show scope global 2>/dev/null | awk '{sub(/\/.*/,"",$4); print $4}')
echo "$MYIPS" | grep -qx "$RESOLVED" || {
	echo "WARNING: $HOSTNAME_PUB resolves to $RESOLVED, which is not one of this host's addresses:" >&2
	echo "$MYIPS" | sed 's/^/  /' >&2
	echo "HTTP-01 will fail unless the record points here." >&2
	exit 1
}

# --- the renewal deploy hook -------------------------------------------------
# ElectrumX runs unprivileged and /etc/letsencrypt/{live,archive} are 0700 root,
# so it cannot read the certificate in place. Copy it out with ownership it can
# read, then restart -- ElectrumX loads the certificate once, at startup.
cat > /usr/local/sbin/electrumx-cert-deploy <<'HOOK'
#!/bin/sh
# certbot --deploy-hook: runs ONLY when a certificate was actually renewed.
# $RENEWED_LINEAGE is the /etc/letsencrypt/live/<name> directory.
set -e
DEST=/etc/electrumx/ssl
[ -n "$RENEWED_LINEAGE" ] || { echo "no RENEWED_LINEAGE" >&2; exit 1; }
# The PARENT must be traversable by the service user too. A correctly-owned
# ssl/ inside a 0750 root:root /etc/electrumx fails with a PermissionError
# that names no path at all.
chgrp electrumx /etc/electrumx && chmod 0750 /etc/electrumx
install -d -m 0750 -o electrumx -g electrumx "$DEST"
install -m 0644 -o electrumx -g electrumx "$RENEWED_LINEAGE/fullchain.pem" "$DEST/fullchain.pem"
install -m 0640 -o electrumx -g electrumx "$RENEWED_LINEAGE/privkey.pem"   "$DEST/privkey.pem"
logger -t electrumx-cert-deploy "installed renewed certificate from $RENEWED_LINEAGE"
systemctl restart electrumx
HOOK
chmod 700 /usr/local/sbin/electrumx-cert-deploy

# --- issue -------------------------------------------------------------------
# On a host where ufw allows :80 only from Cloudflare, acme-port80 opens it for
# the seconds the challenge needs and closes it again -- including on unattended
# renewal, because certbot stores these hooks in the renewal config.
# Build the hook flags as real positional parameters. A single shell variable
# cannot carry them: each hook is ONE argument that happens to contain a space,
# so unquoted expansion word-splits it and certbot sees a stray "open" and
# "close" and rejects the entire command line.
if [ -x /usr/local/sbin/acme-port80 ]; then
	set -- --pre-hook "/usr/local/sbin/acme-port80 open" \
	       --post-hook "/usr/local/sbin/acme-port80 close"
	/usr/local/sbin/acme-port80 open
else
	set --
fi

# From here on ANY exit must close port 80 again, including a certbot failure.
# Without this, the first failed run leaves the port open to the world
# indefinitely on a host that restricts it to Cloudflare for a reason -- which
# is exactly what happened the first two times this script was run.
close_port() { [ -x /usr/local/sbin/acme-port80 ] && /usr/local/sbin/acme-port80 close; }
trap close_port EXIT INT TERM

if [ -d "$LIVE" ]; then
	echo "certificate already present for $HOSTNAME_PUB; forcing the deploy hook"
	RENEWED_LINEAGE="$LIVE" /usr/local/sbin/electrumx-cert-deploy || true
else
	certbot certonly --webroot -w "$WEBROOT" -d "$HOSTNAME_PUB" \
		--non-interactive --agree-tos -m "$EMAIL" \
		--deploy-hook /usr/local/sbin/electrumx-cert-deploy "$@"
fi

close_port
[ -f /etc/electrumx/ssl/fullchain.pem ] || { echo "certificate was not deployed" >&2; exit 1; }

# --- turn on ssl:// and wss:// ----------------------------------------------
python3 - "$ENVD/electrumx.env" "$HOSTNAME_PUB" <<'PY'
import re, sys
path, host = sys.argv[1], sys.argv[2]
src = open(path, encoding='utf-8').read()

want = {
    'SERVICES': 'tcp://:50001,ssl://:50002,wss://:50004,rpc://127.0.0.1:8000',
    'REPORT_SERVICES': f'tcp://{host}:50001,ssl://{host}:50002,wss://{host}:50004',
    'SSL_CERTFILE': '/etc/electrumx/ssl/fullchain.pem',
    'SSL_KEYFILE': '/etc/electrumx/ssl/privkey.pem',
}
for key, val in want.items():
    line = f'{key}={val}'
    if re.search(rf'(?m)^{key}=', src):
        src = re.sub(rf'(?m)^{key}=.*$', line, src)
    else:
        src = src.rstrip('\n') + '\n' + line + '\n'
open(path, 'w', encoding='utf-8').write(src)
print('services:', want['SERVICES'])
PY

systemctl restart electrumx
sleep 5
systemctl is-active electrumx >/dev/null || { echo "electrumx failed to restart" >&2; journalctl -u electrumx -n 30 --no-pager >&2; exit 1; }
echo "TLS enabled for $HOSTNAME_PUB: ssl 50002, wss 50004"
