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
OWNER="www-data:www-data"
BRANCH="${PCOIN_DEPLOY_BRANCH:-main}"
DRY=0
ACK=""
[ "${1:-}" = "--dry-run" ] && DRY=1
# --ack <sha>: I have read the hold on <sha> and its condition is met.
#
# Lifting a hold used to mean hand-editing /var/lib/pcoin-deploy.rev, which
# works but leaves no record of who decided or why, and invites the shortcut
# that actually breaks things: pointing the marker at HEAD, which skips EVERY
# unread hold at once rather than the one you judged. Naming the commit makes
# that impossible -- you can only ever acknowledge a hold you have looked at.
if [ "${1:-}" = "--ack" ]; then
  ACK="${2:-}"
  [ -n "$ACK" ] || { printf 'deploy: --ack needs the commit carrying the hold\n' >&2; exit 2; }
fi

# Which sites live on this host. Selected by whether the docroot EXISTS, not by
# hostname: the same script then runs unmodified everywhere, and a host that
# does not serve a site simply skips it instead of creating an empty one.
#
#   <source subdir under site/> | <docroot> | <public URL>
#
# pc.am is on the GCP box; docs.pc.am is Caddy on a different host entirely.
# Deploying the site from one machine therefore CANNOT keep the guide current,
# which is how docs.pc.am went a day without the pricing section it needed.
TARGETS="
.|/var/www/pc.am|https://pc.am
docs|/var/www/docs.pc.am|https://docs.pc.am
"

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
LAST_REV_FILE="/var/lib/pcoin-deploy.rev"
LAST_REV=$(cat "$LAST_REV_FILE" 2>/dev/null || true)
if [ -n "$LAST_REV" ] && git -C "$CHECKOUT" cat-file -e "$LAST_REV^{commit}" 2>/dev/null; then
  RANGE="$LAST_REV..HEAD"
else
  RANGE="HEAD -1"                      # first run: judge HEAD alone
fi

# An acknowledgement moves the window PAST the named commit and no further, so
# every later commit is still read. git's A..B excludes A, which is exactly the
# semantics wanted: "I have seen this one."
if [ -n "$ACK" ]; then
  git -C "$CHECKOUT" cat-file -e "$ACK^{commit}" 2>/dev/null \
    || die "--ack $ACK is not a commit in this repository"
  if ! git -C "$CHECKOUT" log $RANGE --pretty='%H' -- site/ | grep -q "^$(git -C "$CHECKOUT" rev-parse "$ACK")$"; then
    die "--ack $ACK does not name an undeployed commit touching site/ (nothing to acknowledge)"
  fi
  ACK_SUBJ=$(git -C "$CHECKOUT" log -1 --pretty='%h %s' "$ACK")
  say "acknowledging hold on: $ACK_SUBJ"
  say "  (later commits are still checked; this skips only the one named)"
  RANGE="$(git -C "$CHECKOUT" rev-parse "$ACK")..HEAD"
  logger -t pcoin-deploy "hold acknowledged: $ACK_SUBJ by ${SUDO_USER:-$(id -un)}" 2>/dev/null || true
fi

HOLD=$(git -C "$CHECKOUT" log $RANGE --pretty='%h %s%n%b' -- site/ \
       | grep -iE '^Deploy-Hold:' || true)
if [ -n "$HOLD" ]; then
  say ""
  say "REFUSING: an undeployed commit touching site/ carries a deploy hold:"
  printf '  %s\n' "$HOLD"
  say ""
  say "Once that condition is genuinely met, acknowledge THAT commit by name:"
  say "  sudo $0 --ack <sha>"
  say "Do not point /var/lib/pcoin-deploy.rev at HEAD to get past this -- that"
  say "skips every unread hold, not the one you just judged."
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
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
total_changed=0; total_same=0; sites=0; failed=0

for target in $TARGETS; do
  sub="${target%%|*}"; rest="${target#*|}"
  docroot="${rest%%|*}"; public="${rest##*|}"
  src="$SRC"; [ "$sub" = "." ] || src="$SRC/$sub"

  [ -d "$docroot" ] || continue           # this host does not serve that site
  [ -d "$src" ] || { say "skip $public — $src missing in repo"; continue; }
  sites=$((sites+1))
  say ""
  say "-- $public  ($docroot)"

  changed=0; same=0
  while IFS= read -r -d '' f; do
    rel="${f#"$src"/}"
    # pc.am's own tree contains docs/, which is a SEPARATE site with its own
    # docroot. Deploying it under pc.am too is harmless, but on the host that
    # serves docs.pc.am it must not be handled twice.
    dst="$docroot/$rel"
    if [ -f "$dst" ] && cmp -s "$f" "$dst"; then
      same=$((same+1)); continue
    fi
    changed=$((changed+1))
    if [ "$DRY" = "1" ]; then
      say "   would update  $rel ($(stat -c%s "$f") bytes)"
      continue
    fi
    mkdir -p "$(dirname "$dst")"
    [ -f "$dst" ] && cp -a "$dst" "$dst.bak.$STAMP"
    tmp="$dst.stage.$$"
    cp "$f" "$tmp"                     # byte copy; no text transform
    chown "$OWNER" "$tmp" 2>/dev/null
    chmod 644 "$tmp"
    mv -f "$tmp" "$dst"                # atomic within the same filesystem
    say "   updated  $rel"
  done < <(find "$src" -type f -print0)

  say "   $changed changed, $same already current"
  total_changed=$((total_changed+changed)); total_same=$((total_same+same))
  [ "$DRY" = "1" ] && continue
  [ "$changed" = "0" ] && continue

  # ---- verify against the PUBLIC url, not the file we just wrote ----
  sleep 1
  local_sum=$(sha256sum "$docroot/index.html" 2>/dev/null | cut -d' ' -f1)
  live_sum=$(curl -fsSL --max-time 30 -H 'Cache-Control: no-cache' "$public/" 2>/dev/null \
             | sha256sum | cut -d' ' -f1)
  if [ "$local_sum" = "$live_sum" ]; then
    say "   verified: $public serves the deployed bytes"
  else
    failed=$((failed+1))
    say "   WARNING: $public does NOT match the file on disk."
    say "     on disk: $local_sum"
    say "     served : $live_sum"
    say "   Usually a Cloudflare cache; purge it, or wait and re-check. It can"
    say "   also mean another process rewrote the file after this deploy."
  fi
done

say ""
[ "$sites" = "0" ] && { say "no known docroot on this host — nothing to deploy"; exit 0; }
say "$total_changed changed, $total_same already current, across $sites site(s)"
[ "$DRY" = "1" ] && exit 0
[ "$failed" != "0" ] && exit 4
# Record only after every site verified. Written early, a failed deploy would
# still narrow the next run's hold window past a commit that never shipped.
[ "$total_changed" != "0" ] && printf '%s' "$(git -C "$CHECKOUT" rev-parse HEAD)" > "$LAST_REV_FILE"
say "deployed $REV"
