#!/bin/sh
# Apply PCoin's listing files to a clone of GLEECBTC/coins, and refuse if the
# result would not be accepted.
#
#   ./apply-to-coins-repo.sh /path/to/your/fork/of/coins
#
# Validation is the point. The `coins` file is a single 730-entry JSON array
# with no schema and no CI that runs on a fork, so a trailing comma or a
# duplicate ticker is discovered by a human reviewer days later, if at all.
# Everything this checks has actually been shipped wrong by somebody:
# a ticker collision, a P2P port written into the rpcport field (PR #1960
# existed solely to fix that for another coin), and a hand-added icons/ file
# that conflicts with the bot that generates that directory.
set -e

DEST="$1"
[ -n "$DEST" ] || { echo "usage: $0 <path-to-coins-repo-clone>" >&2; exit 2; }
[ -f "$DEST/coins" ] || { echo "$DEST does not look like the coins repo (no ./coins)" >&2; exit 1; }
HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
SRC="$HERE/files"

python3 - "$SRC" "$DEST" <<'PY'
import json, os, shutil, sys

src, dest = sys.argv[1], sys.argv[2]

coins = json.load(open(os.path.join(dest, 'coins'), encoding='utf-8'))
ours = json.load(open(os.path.join(src, 'coins-entries.json'), encoding='utf-8'))
existing = {c['coin'] for c in coins}

# Re-adding our own entries must be a no-op, not a duplicate.
coins = [c for c in coins if c['coin'] not in {o['coin'] for o in ours}]
existing = {c['coin'] for c in coins}

for o in ours:
    if o['coin'] in existing:
        sys.exit(f"FAIL: ticker {o['coin']} already exists upstream")
    for f in ('coin', 'fname', 'pubtype', 'p2shtype', 'wiftype', 'mm2', 'protocol'):
        if f not in o:
            sys.exit(f"FAIL: {o['coin']} missing required field {f}")
    # rpcport is the RPC port, not P2P. PCoin's is P2P minus one, which is
    # exactly the kind of thing that gets "corrected" to the wrong value.
    if o['rpcport'] != 9443:
        sys.exit(f"FAIL: {o['coin']} rpcport is {o['rpcport']}, expected 9443")
    if o['sign_message_prefix'] != "PCoin Signed Message:\n":
        sys.exit(f"FAIL: {o['coin']} sign_message_prefix is not PCoin's")
    if 'disable_cert_verification' in json.dumps(o):
        sys.exit(f"FAIL: {o['coin']} must not disable certificate verification")

# Insert TEXTUALLY, do not re-serialise the whole file. A json.dump round-trip
# renormalises upstream's indentation -- it silently re-indented an unrelated
# "eth_send_coins" line, because the 730 entries are not uniformly formatted.
# A PR that touches somebody else's coin is a PR that gets questioned.
path = os.path.join(dest, 'coins')
text = open(path, encoding='utf-8').read()
body = text.rstrip()
if not body.endswith(']'):
    sys.exit("FAIL: coins file does not end with ']'")
body = body[:-1].rstrip()
if body.endswith(','):
    sys.exit("FAIL: coins file has a trailing comma before ']'")

block = ',\n' + '\n'.join(
    '  ' + line for line in
    ',\n'.join(json.dumps(o, indent=2) for o in ours).splitlines())
new_text = body + block + '\n]' + text[len(text.rstrip()):]

# Never write a file we cannot read back as the array we intended.
parsed = json.loads(new_text)
if len(parsed) != len(coins) + len(ours):
    sys.exit(f"FAIL: rewrote to {len(parsed)} entries, expected {len(coins) + len(ours)}")
if [c['coin'] for c in parsed[-len(ours):]] != [o['coin'] for o in ours]:
    sys.exit("FAIL: our entries are not the last ones after insertion")
open(path, 'w', encoding='utf-8', newline='').write(new_text)

for rel in ('electrums/PCN', 'explorers/PCN', 'swaps/PCN-KMD.md', 'icons_original/pcn.png'):
    s = os.path.join(src, rel)
    d = os.path.join(dest, rel)
    os.makedirs(os.path.dirname(d), exist_ok=True)
    shutil.copyfile(s, d)

# electrums and explorers must be valid JSON arrays.
for rel in ('electrums/PCN', 'explorers/PCN'):
    v = json.load(open(os.path.join(dest, rel), encoding='utf-8'))
    if not isinstance(v, list) or not v:
        sys.exit(f"FAIL: {rel} is not a non-empty JSON array")

srv = json.load(open(os.path.join(dest, 'electrums/PCN'), encoding='utf-8'))
if len(srv) < 2:
    sys.exit("FAIL: Komodo requires details of at least 2 Electrum servers")
for e in srv:
    if not e.get('ws_url'):
        sys.exit(f"FAIL: {e['url']} has no ws_url -- without WSS the coin is "
                 "silently dropped from the web wallet's generated config")
    if not e.get('contact'):
        sys.exit(f"FAIL: {e['url']} has no contact; failing servers are "
                 "auto-delisted and they need someone to tell")

# icons/ is produced by .github/workflows/gen_configs.yml from icons_original/.
if os.path.exists(os.path.join(dest, 'icons/pcn.png')):
    sys.exit("FAIL: icons/pcn.png exists. That directory is bot-generated; "
             "remove the hand-added file.")

import struct
hdr = open(os.path.join(dest, 'icons_original/pcn.png'), 'rb').read(33)
if hdr[:8] != b'\x89PNG\r\n\x1a\n':
    sys.exit("FAIL: icons_original/pcn.png is not a PNG")
w, h = struct.unpack('>II', hdr[16:24])
if w < 128 or h < 128:
    sys.exit(f"FAIL: icon is {w}x{h}, minimum is 128x128")

swap = open(os.path.join(dest, 'swaps/PCN-KMD.md'), encoding='utf-8').read()
if 'TODO_' in swap:
    print("WARNING: swaps/PCN-KMD.md still has placeholder txids.")
    print("         The completed swap is a HARD requirement -- do not open the")
    print("         PR until the five real transaction links are in that file.")
else:
    lines = [l for l in swap.splitlines() if l.strip()]
    if len(lines) != 5:
        sys.exit(f"FAIL: swaps/PCN-KMD.md has {len(lines)} lines, expected exactly 5")

print(f"applied: {len(ours)} coins entries, icon {w}x{h}, {len(srv)} electrum servers")
PY

echo
echo "Now, in $DEST:"
echo "  git checkout -b add-pcoin-pcn && git add -A && git commit && git push"
echo "  open the PR against GLEECBTC/coins master, body = $HERE/PR-BODY.md"
echo
echo "Re-measure the hashrate concentration before filing -- the PR body quotes it:"
echo "  pcoin-concentration-watch --window 300 --dry-run"
