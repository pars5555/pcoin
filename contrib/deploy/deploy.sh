#!/bin/bash
#
# pc.am static deploy — git is the source of truth.
#
#   curl -fsSL https://raw.githubusercontent.com/pars5555/pcoin/main/contrib/deploy/deploy.sh | sudo bash
#   sudo /usr/local/bin/pcoin-deploy            # once installed
#   sudo /usr/local/bin/pcoin-deploy --dry-run  # show what would change
#
# WHY THIS EXISTS. The site was deployed by hand-copying index.html from a
# working tree. Three times in one day a session overwrote another session's
# live work with an older local copy, silently: the homepage lost its service
# tiles and a removed nav link came back, and nobody noticed because the deploy
# "succeeded" both times. A hand-copy has no way to know it is going backwards.
# Pulling from git does: the remote is one ordered history, so the worst case
# becomes "someone else's commit wins", not "someone else's work disappears".
#
# Properties, each because the alternative has bitten:
#
#   IDEMPOTENT      Content-hash compared before writing. Re-running changes
#                   nothing and says so, so it is safe in a cron or a loop.
#   ATOMIC          Staged in the destination directory, then mv. A plain cp
#                   lets Apache serve a half-written page to a request that
#                   arrives mid-copy -- that has happened, and produced a page
#                   missing two links.
#   BYTE-EXACT      cp, never a text transform. site/index.html is CRLF; a
#                   text-mode round trip rewrites it to LF and every anchored
#                   edit afterwards silently stops matching.
#   ADDITIVE        Never deletes. /var/www/pc.am also holds dl/ and brand/,
#                   which are NOT in the repository. An rsync --delete here
#                   would destroy the published binaries and checksums.
#   VERIFIED        Fetches the public URL back and compares hashes. An upload
#                   that returned 200 is not evidence the bytes are being
#                   served -- proxies and caches sit in between.
#   GUARDED         Refuses if HEAD carries a "DO NOT DEPLOY" marker; the repo
#                   deliberately stages copy that only becomes true after an
#                   event (see CLAUDE.md 8b).
#
# No Apache reload. These are static files, and this box serves ~215 unrelated
# vhosts -- a restart here is other people's outage.

set -uo pipefail

REPO_URL="https://github.com/pars5555/pcoin.git"
CHECKOUT="/srv/pcoin"
DOCROOT="/var/www/pc.am"
OWNER="www-data:www-data"
PUBLIC="https://pc.am"
BRANCH="${PCOIN_DEPLOY_BRANCH:-main}"
DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

say()  { printf '%s\n' "$*"; }
die()  { printf 'deploy: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = "0" ] || die "must run as root (sudo)"
command -v git >/dev/null || die "git is not installed"

# ---------------------------------------------------------------- 1. sources
if [ -d "$CHECKOUT/.git" ]; then
  git -C "$CHECKOUT" remote set-url origin "$REPO_URL"
  git -C "$CHECKOUT" fetch --quiet origin "$BRANCH" || die "git fetch failed"
  # Hard reset, not pull: this checkout is a deploy artifact, never edited here.
  # A merge conflict on a production box at 3am is not a thing anyone wants.
  git -C "$CHECKOUT" reset --hard --quiet "origin/$BRANCH" || die "git reset failed"
else
  say "cloning $REPO_URL -> $CHECKOUT"
  git clone --quiet --branch "$BRANCH" --depth 50 "$REPO_URL" "$CHECKOUT" \
    || die "git clone failed"
fi

SRC="$CHECKOUT/site"
[ -d "$SRC" ] || die "$SRC missing — wrong branch?"
REV=$(git -C "$CHECKOUT" rev-parse --short HEAD)
SUBJ=$(git -C "$CHECKOUT" log -1 --pretty=%s)
say "at $REV  $SUBJ"

# ------------------------------------------------------------- 2. stop marker
# Copy is sometimes committed BEFORE the event it describes is true.
#
# The window is "commits not yet deployed", not "the last N commits". A fixed
# window re-reads history that already shipped, and the first version of this
# refused every deploy because a commit from days earlier said it was RELEASING
# copy that had been "staged behind DO NOT DEPLOY YET". A hold and a lifted hold
# read the same to grep.
#
# So the hold is an explicit trailer that only ever means one thing:
#     Deploy-Hold: waiting for height 2800
# Prose is only ever a warning, and it names the commit so a human can judge.
LAST_REV_FILE="$DOCROOT/.deployed-rev"
LAST_REV=$(cat "$LAST_REV_FILE" 2>/dev/null || true)
if [ -n "$LAST_REV" ] && git -C "$CHECKOUT" cat-file -e "$LAST_REV^{commit}" 2>/dev/null; then
  RANGE="$LAST_REV..HEAD"
else
  RANGE="HEAD -1"                      # first run: judge HEAD alone
fi

HOLD=$(git -C "$CHECKOUT" log $RANGE --pretty='%h %s%n%b' -- site/ \
       | grep -iE '^Deploy-Hold:' || true)
if [ -n "$HOLD" ]; then
  say ""
  say "REFUSING: an undeployed commit touching site/ carries a deploy hold:"
  printf '  %s\n' "$HOLD"
  say "Deploy again once that condition is met."
  exit 3
fi

SOFT=$(git -C "$CHECKOUT" log $RANGE --pretty='%h|%s' -- site/ | while IFS='|' read -r h s; do
         git -C "$CHECKOUT" log -1 --pretty='%b' "$h" | grep -qi 'do not deploy' && echo "  $h $s"
       done)
if [ -n "$SOFT" ]; then
  say ""
  say "NOTE: undeployed commit(s) mention 'do not deploy' in prose:"
  printf '%s\n' "$SOFT"
  say "Not blocking — use the Deploy-Hold: trailer for a real hold. Continuing."
fi

# ------------------------------------------------------------------ 3. deploy
changed=0; same=0
STAMP=$(date -u +%Y%m%dT%H%M%SZ)

while IFS= read -r -d '' f; do
  rel="${f#"$SRC"/}"
  dst="$DOCROOT/$rel"
  if [ -f "$dst" ] && cmp -s "$f" "$dst"; then
    same=$((same+1)); continue
  fi
  changed=$((changed+1))
  if [ "$DRY" = "1" ]; then
    say "  would update  $rel ($(stat -c%s "$f") bytes)"
    continue
  fi
  mkdir -p "$(dirname "$dst")"
  [ -f "$dst" ] && cp -a "$dst" "$dst.bak.$STAMP"
  tmp="$dst.stage.$$"
  cp "$f" "$tmp"                     # byte copy; no text transform
  chown "$OWNER" "$tmp" 2>/dev/null
  chmod 644 "$tmp"
  mv -f "$tmp" "$dst"                # atomic within the same filesystem
  say "  updated  $rel"
done < <(find "$SRC" -type f -print0)

say "$changed changed, $same already current"
[ "$DRY" = "1" ] && exit 0
[ "$changed" = "0" ] && { say "nothing to do"; exit 0; }

# ------------------------------------------------------------------ 4. verify
# Trust what the public URL serves, not what we just wrote.
sleep 1
local_sum=$(sha256sum "$DOCROOT/index.html" | cut -d' ' -f1)
live_sum=$(curl -fsSL --max-time 30 -H 'Cache-Control: no-cache' "$PUBLIC/" 2>/dev/null | sha256sum | cut -d' ' -f1)
if [ "$local_sum" = "$live_sum" ]; then
  # Only now is the revision "deployed". Recording it before verification would
  # narrow the next run's hold window past a commit that never actually shipped.
  printf '%s' "$(git -C "$CHECKOUT" rev-parse HEAD)" > "$LAST_REV_FILE"
  say "verified: $PUBLIC serves the deployed bytes ($REV)"
else
  say ""
  say "WARNING: $PUBLIC does NOT match the file on disk."
  say "  on disk: $local_sum"
  say "  served : $live_sum"
  say "Usually a Cloudflare cache; purge it, or wait and re-check."
  say "It can also mean another process rewrote the file after this deploy."
  exit 4
fi
