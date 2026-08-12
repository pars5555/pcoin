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

    const now = {
      price: st.marginalPrice,
      sold: Number(st.soldPcn) || 0,
      retired: Number(st.retiredPcn) || 0,
      remaining: Number(st.remainingPcn) || 0,
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

    const causes = [];
    if (dSold > 0)    causes.push(`<b>${pcn(dSold)} PCN sold</b>`);
    if (dRetired > 0) causes.push(`<b>${pcn(dRetired)} PCN retired</b> (spent on the services)`);
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
