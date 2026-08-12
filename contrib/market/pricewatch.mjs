// ═══════════════════════════════════════════════════════════════════════════
// Price watch — say it out loud, every time the ladder price moves.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHY THIS IS A WATCHER AND NOT AN ALERT AT EACH CAUSE
//
// The ladder price is a pure function of `qty_sold + qty_retired`, and several
// unrelated things change those: a purchase completing, retire-on-spend
// withdrawing inventory, an expired order releasing its reservation, an
// operator editing a rung by hand, the ladder being regenerated. Alerting
// inside each of those paths means the day someone adds a sixth way to move
// inventory, the price changes silently — and the previous alerts all still
// look healthy, which is worse than having none.
//
// So this watches the OBSERVABLE FACT — the published price is not what it was
// — rather than each hypothesised cause. It cannot be bypassed by a new code
// path, because there is no code path involved: it re-reads the number.
//
// STATE LIVES IN THE DATABASE, NOT IN MEMORY.
// An in-memory "last price" would be lost on every restart, which gives a
// choice between two wrong behaviours: alert on the first read after a restart
// (crying wolf on every deploy) or suppress it (silently missing a real move
// that happened while the process was down). Persisted, a restart is invisible
// and a move across one is still reported.
//
// FIRST RUN IS SILENT. With nothing stored there is no "before", and an
// unknown must not be rendered as a change — the estate's standing rule. The
// baseline is recorded and the next real move is the first thing announced.

const KEY = 'lastPublishedPrice';

/** Formats a price the way the site does: enough decimals to be exact, no
 *  trailing noise. A price alert that rounds is a price alert that can report
 *  "0.015 -> 0.015". */
const money = n =>
  n === null || n === undefined ? 'unknown'
  : '$' + Number(n).toFixed(9).replace(/0+$/, '').replace(/\.$/, '');

const pcn = n => Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });

export function makePriceWatch({ pool, ladder, notify, log = console }) {
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];

  async function readLast() {
    try {
      const [r] = await q(`SELECT v FROM market_state WHERE k=?`, [KEY]);
      return r ? JSON.parse(r.v) : null;
    } catch (e) {
      // A read failure must NOT be treated as "no previous price" — that would
      // silently re-baseline and swallow the very move we exist to report.
      log.warn('[pricewatch] could not read the last price:', e.message);
      return { unreadable: true };
    }
  }

  async function writeLast(snap) {
    await q(`INSERT INTO market_state (k, v) VALUES (?,?)
             ON DUPLICATE KEY UPDATE v = VALUES(v)`, [KEY, JSON.stringify(snap)]);
  }

  /** One pass. Returns what it saw, so a caller or a test can assert on it. */
  async function check() {
    let st;
    try { st = await ladder.ladderState(); }
    catch (e) { log.warn('[pricewatch] ladder unreadable:', e.message); return { ok: false, why: e.message }; }

    // The LEDGER of retirements, read separately from the ladder's counters.
    //
    // These are two independent facts and must not be conflated. `qty_retired`
    // on a rung says inventory was withdrawn; the `retirements` table says a
    // specific chain output paid a specific service. Retire-on-spend moves both
    // together. A direct edit, a rebuild, or a migration moves only the first.
    //
    // The earlier version of this alert reported any rise in qty_retired as
    // "spent on the services", which is an inference, not an observation — and
    // it was wrong the first two times it fired, announcing 947 PCN of customer
    // revenue that never existed. A price alert that invents a business reason
    // is worse than one that says nothing, because it is believed.
    let ledger = null;
    try {
      const [r] = await q(`SELECT COALESCE(SUM(pcn_retired),0) AS t FROM retirements`);
      const raw = r[0]?.t ?? r?.t;
      const n = Number(raw);
      // `?? 0` on the way out of a query that may not have answered is the
      // exact bug this file is here to prevent: it turns "I could not read the
      // ledger" into "the ledger says nothing was paid", which then prints as
      // "retired with NO payment on chain" — an accusation, stated confidently,
      // from a failed read. Unreadable stays null, and null prints as unverified.
      ledger = Number.isFinite(n) ? n : null;
      if (ledger === null) log.warn('[pricewatch] retirement ledger returned a non-number:', raw);
    } catch (e) {
      log.warn('[pricewatch] retirement ledger unreadable:', e.message);
    }

    const now = {
      price: st.marginalPrice,
      sold: Number(st.soldPcn) || 0,
      retired: Number(st.retiredPcn) || 0,
      remaining: Number(st.remainingPcn) || 0,
      ledger,
    };

    const last = await readLast();
    if (last?.unreadable) return { ok: false, why: 'state unreadable' };

    if (!last) {
      await writeLast(now);
      log.log(`[pricewatch] baseline recorded at ${money(now.price)}`);
      return { ok: true, baseline: true, price: now.price };
    }

    if (last.price === now.price) return { ok: true, moved: false, price: now.price };

    // It moved. Work out WHY from the deltas, so the message answers the first
    // question the reader will have instead of prompting a database session.
    const dSold = now.sold - (Number(last.sold) || 0);
    const dRetired = now.retired - (Number(last.retired) || 0);
    const pct = (last.price > 0 && now.price !== null)
      ? ((now.price - last.price) / last.price) * 100 : null;

    // How much of the retirement delta is BACKED by real payment records? Only
    // that part may be described as customer spending; the rest is reported as
    // what it actually is — inventory that left the ladder with nothing on
    // chain accounting for it.
    const dLedger = (now.ledger !== null && last.ledger !== null && last.ledger !== undefined)
      ? now.ledger - Number(last.ledger) : null;

    const causes = [];
    if (dSold > 0) causes.push(`<b>${pcn(dSold)} PCN sold</b>`);
    if (dRetired > 0) {
      if (dLedger === null) {
        causes.push(`<b>${pcn(dRetired)} PCN retired</b> (could not check the payment ledger — ` +
                    `cause unverified)`);
      } else if (Math.abs(dLedger - dRetired) < 0.00000001) {
        causes.push(`<b>${pcn(dRetired)} PCN retired</b> — customers spent on the services`);
      } else if (dLedger > 0) {
        causes.push(`<b>${pcn(dRetired)} PCN retired</b>, of which only ${pcn(dLedger)} PCN is ` +
                    `matched by a payment on chain. ⚠️ The remaining ${pcn(dRetired - dLedger)} ` +
                    `PCN left the ladder with nothing accounting for it.`);
      } else {
        causes.push(`⚠️ <b>${pcn(dRetired)} PCN retired with NO payment on chain</b> — the ladder ` +
                    `was edited directly. This is not customer spending.`);
      }
    }
    if (dSold < 0 || dRetired < 0) causes.push(`⚠️ counters went DOWN — the ladder was edited or rebuilt`);
    if (!causes.length) causes.push(`no change in sold or retired — the ladder itself was changed`);

    const dir = now.price === null ? '🔚'
              : pct === null ? '📊'
              : pct > 0 ? '📈' : '📉';

    await notify(
      `${dir} <b>Ladder price moved</b>\n` +
      `${money(last.price)} → <b>${money(now.price)}</b>` +
      (pct === null ? '' : `  (${pct > 0 ? '+' : ''}${pct.toFixed(2)}%)`) + `\n` +
      causes.map(c => `• ${c}`).join('\n') + `\n` +
      `${pcn(now.remaining)} PCN left on the ladder` +
      (now.price === null ? `\n<b>The ladder is empty — there is nothing left to sell.</b>` : '')
    ).catch(e => log.warn('[pricewatch] alert failed:', e.message));

    // Written only AFTER the alert is attempted. If this process dies between
    // the two, the next pass re-reports the same move — a duplicate is a much
    // smaller problem than a price change nobody was told about.
    await writeLast(now);
    log.log(`[pricewatch] ${money(last.price)} -> ${money(now.price)}`);
    return { ok: true, moved: true, from: last.price, to: now.price, pct, dSold, dRetired };
  }

  return { check };
}
