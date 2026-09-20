// THE WRAP DESK'S ANNOUNCEMENT FEED — facts only, never words.
//
// The owner, 2026-09-20: "that should be automatically send on every wrap …
// make sure next times it will be sent automatically without approval gate,
// because there is approval gate for channel posts."
//
// WHY THIS IS A FEED AND NOT A SENDER
// The ledgers and both watchers live on this host. `pcoin-approve` — the thing
// that can actually publish to @PCoinPCN — lives on the gate host, and there is
// NO SSH between the two in either direction (tested both ways, 2026-09-20,
// `Permission denied (publickey)`). The only channel is the one that already
// exists: the gate PULLS /ingest/controls from this panel every tick. So this
// module adds one array to a response the gate already asks for.
//
// The doctrine that shape comes from is stated at the /ingest/controls handler
// and holds here too: THE PANEL CANNOT PUBLISH. It can only record a fact that
// the gate picks up. Specifically, nothing below emits a sentence, a caption or
// a headline. It emits a transaction id, an address and an amount; the gate
// renders the fixed template in its own code and re-verifies the PCoin side
// against explorer.pc.am before it posts. A compromised panel can therefore
// name a different transaction — which the gate will look up and find does not
// pay what it claims — but it cannot put words on the public channel.
//
// THE FLOOR IS THE WHOLE SAFETY STORY, so it is read first and it fails closed.
// There are 41 wraps and 3 redemptions in these ledgers, 33 of them released.
// Without a floor the first tick after this ships would publish THIRTY-SIX
// announcements of things that happened weeks ago, one a minute, to a public
// channel. `announceFloor()` throws when the file is missing or unparseable and
// every caller turns that into an EMPTY feed — so the failure mode of every
// mistake here (not installed, wrong path, unreadable, corrupt) is silence.
// That is the only acceptable direction for this particular bug.
import { readFileSync } from 'node:fs';

// Written by pcoin-wrapdesk-watch (wraps) and pcoin-redeem-watch (returns).
// Both are on this host; both are 0644, so the panel reads them whether it runs
// as root or not.
export const STATE_FILE = '/var/lib/pcoin-wrapdesk/state.json';
export const REDEEM_FILE = '/var/lib/pcoin-wrapdesk/redeem.json';
// The desk's own claim ledger, owned by the `wrapdesk` user. It is the ONLY
// place the PCoin destination of a return is written down, which is why it is
// read here rather than inferred — see the burn-route note in returnItems().
export const RETURNS_FILE = '/var/lib/wrapdesk/returns.json';

// An epoch, in /etc/pcoin/control because that is the directory this panel is
// granted and it holds no secrets. Nothing closed BEFORE this instant is ever
// announced.
export const FLOOR_FILE = '/etc/pcoin/control/wrapdesk-announce-from';

// HOW MANY FACTS ARE OFFERED PER PULL — not how many get published. The gate
// publishes at most one per tick (WRAPDESK_PER_TICK there); it is handed a few
// so that one item it cannot verify does not block every wrap behind it. That
// is a real case: a PCoin transaction the explorer cannot resolve is HELD for
// ever by design, and with a window of one, "for ever" would have been every
// later announcement too.
//
// The gate's cap is the blast radius, and it is deliberately tiny. The desk
// closes roughly one wrap a day and the gate ticks every minute, so if the
// floor is ever wrong somebody gets a minute per post to notice rather than
// watching forty arrive at once.
export const FEED_WINDOW = 3;

// A backlog this size means the gate has not published for about a week at the
// real rate. Reported so the gate can say so out loud; it does not stop the
// feed, because holding back announcements the public was promised is its own
// failure.
export const BACKLOG_LOUD_AT = 6;

const HEX64 = /^[0-9a-f]{64}$/;
const BSCTX = /^0x[0-9a-f]{64}$/;
const PCADDR = /^pc1[02-9ac-hj-np-z]{20,70}$/;

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

// The floor, or a throw. Deliberately not defaulted: see the header.
export function announceFloor() {
  const raw = readFileSync(FLOOR_FILE, 'utf8');
  // A whole-line comment or a trailing one, both: this file has to carry the
  // date in a form a person reads, or the next person to see a bare ten-digit
  // number will not know whether it is safe to change.
  const first = String(raw).split(String.fromCharCode(10))
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split(/[\s#]/)[0])[0];
  const n = Number(first);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${FLOOR_FILE} does not hold a unix time (${JSON.stringify(first)})`);
  }
  return n;
}

// Wraps: PCN in, wPCN out. Key is `wrap:<pcoin-txid>:<deposit-address>`, which
// is the (txid, address) rule from CLAUDE.md 8c — one deposit address is reused
// by one customer across many wraps, so keying on the txid alone drops the
// second one silently.
function wrapItems(seen, floor, done) {
  const items = [];
  let selfWraps = 0;
  let noAmount = 0;
  let malformed = 0;
  for (const [key, v] of Object.entries(seen || {})) {
    // A refunded request has no `released` and is not a wrap that happened.
    if (!v || typeof v !== 'object' || v.released !== true) continue;
    const at = Number(v.at);
    if (!Number.isFinite(at) || at < floor) continue;
    if (done[key]) continue;

    const parts = String(key).split(':');
    const txid = String(parts[1] || '').toLowerCase();
    const addr = String(parts[2] || '').toLowerCase();
    const hash = String(v.bsc_txhash || '').toLowerCase();
    const wpcn = Number(v.send_wpcn);

    // A SELF-WRAP IS NOT AN ANNOUNCEMENT. The desk records its own inventory
    // moves with a `self-wrap:…` marker where a customer's transaction hash
    // would be. There is no customer, no BSC transaction and nothing to link,
    // and posting one would advertise the desk trading with itself. It is not
    // malformed — it is correctly excluded, so it is counted apart.
    if (!BSCTX.test(hash)) {
      if (hash.startsWith('self-wrap')) selfWraps += 1; else malformed += 1;
      continue;
    }
    if (parts.length !== 3 || parts[0] !== 'wrap' || !HEX64.test(txid) || !PCADDR.test(addr)) {
      malformed += 1;
      continue;
    }
    // `send_wpcn` was only added to this ledger on 2026-09-13. Five released
    // wraps before that date carry a perfectly good BSC transaction hash and no
    // amount, and there is no way to recover one: the wPCN out depends on the
    // fee in force at the time, which is not written down either. They are
    // OLD, not broken, and counted apart so that nobody goes looking for a bug.
    // Every one of them is far below any floor that will ever be installed.
    if (!Number.isFinite(wpcn) || wpcn <= 0) { noAmount += 1; continue; }
    items.push({
      key, dir: 'wrap', at,
      pcoin_txid: txid,
      // Not published. The gate uses it to pick this customer's output out of
      // a deposit transaction that may pay several.
      deposit_addr: addr,
      bsc_txhash: hash,
      wpcn,
    });
  }
  return { items, selfWraps, noAmount, malformed };
}

// Returns and redemptions: wPCN back, PCN out, 1:1 and no fee. Key is
// `<bsc-txhash>:<logIndex>` — the BEP-20 shape of the same rule, because one
// transaction can carry several Transfer logs.
function returnItems(redeem, claims, floor, done) {
  const items = [];
  let noClaim = 0;
  let malformed = 0;
  const amounts = Object.assign({}, redeem.seen || {}, redeem.returns_seen || {});
  for (const [key, p] of Object.entries(redeem.paid || {})) {
    if (!p || typeof p !== 'object') { malformed += 1; continue; }
    const at = Number(p.at);
    if (!Number.isFinite(at) || at < floor) continue;
    if (done[key]) continue;

    const cut = String(key).lastIndexOf(':');
    const hash = String(key).slice(0, cut).toLowerCase();
    const logIndex = Number(String(key).slice(cut + 1));
    const txid = String(p.pcoin_txid || '').toLowerCase();
    const wpcn = Number(amounts[key]);

    // THE BURN ROUTE IS SKIPPED, ON PURPOSE. A return carries a signed claim
    // naming the PCoin address to pay; a bare `redeem()` burn does not, and the
    // destination is only in the BSC event log, which nothing on this host
    // writes down. Without that address the gate cannot tell which output of
    // the payout transaction is the customer's, so it cannot verify the figure
    // it would be publishing. One burn has ever happened (2026-09-02) and it is
    // far below any floor; if the route is used again this count is how anyone
    // finds out an announcement was owed and not sent.
    const claim = claims[key];
    const pcoinAddr = String((claim && claim.pcoin) || '').toLowerCase();
    if (!pcoinAddr) { noClaim += 1; continue; }

    if (!BSCTX.test(hash) || !Number.isInteger(logIndex) || logIndex < 0
        || !HEX64.test(txid) || !PCADDR.test(pcoinAddr)
        || !Number.isFinite(wpcn) || wpcn <= 0) {
      malformed += 1;
      continue;
    }
    items.push({
      key, dir: 'return', at,
      bsc_txhash: hash,
      log_index: logIndex,
      pcoin_txid: txid,
      pcoin_addr: pcoinAddr,
      wpcn,
    });
  }
  return { items, noClaim, malformed };
}

// What the gate is handed. `error` is a HOLD, never a permission: every caller
// must treat a non-empty error as "announce nothing this tick".
export function announceFeed(controls) {
  let floor;
  try { floor = announceFloor(); }
  catch (e) {
    return { items: [], backlog: 0, floor: null, held: true, error: `no announce floor: ${e.message}` };
  }

  const done = (controls && controls.announced) || {};
  let state; let redeem; let claims = {};
  try { state = readJson(STATE_FILE); }
  catch (e) { return { items: [], backlog: 0, floor, held: true, error: `wrap ledger: ${e.message}` }; }
  try { redeem = readJson(REDEEM_FILE); }
  catch (e) { return { items: [], backlog: 0, floor, held: true, error: `redeem ledger: ${e.message}` }; }
  // The claim file is the only OPTIONAL read: with it unavailable, returns are
  // skipped for want of a destination address and wraps still go out.
  try { claims = readJson(RETURNS_FILE).claims || {}; } catch { claims = {}; }

  const w = wrapItems(state.seen, floor, done);
  const r = returnItems(redeem, claims, floor, done);
  // Oldest first. An announcement that fell behind is still told in the order
  // it happened, which is the only order that reads correctly to a subscriber.
  const all = w.items.concat(r.items).sort((a, b) => a.at - b.at);

  return {
    floor,
    held: false,
    error: '',
    backlog: all.length,
    excluded: {
      self_wraps: w.selfWraps,
      no_amount_recorded: w.noAmount,
      returns_without_claim: r.noClaim,
      malformed: w.malformed + r.malformed,
    },
    items: all.slice(0, FEED_WINDOW),
  };
}

// Called when the gate acknowledges what it published. Recording the key is
// belt to the gate's braces: `pcoin-approve submit --key` already refuses a
// duplicate, so a lost acknowledgement costs a retry, not a second post.
export function markAnnounced(controls, keys) {
  const c = controls || {};
  c.announced = c.announced || {};
  const now = new Date().toISOString();
  let n = 0;
  for (const k of keys) {
    if (typeof k !== 'string' || !k) continue;
    if (c.announced[k]) continue;
    c.announced[k] = now;
    n += 1;
  }
  return n;
}
