// ═══════════════════════════════════════════════════════════════════════════
// Retire-on-spend — usage takes coins off the ladder, so the price rises.
// ═══════════════════════════════════════════════════════════════════════════
//
// WHAT THIS IS FOR
// PCN is only worth anything because the four services accept it. When someone
// spends PCN there, that demand should show up in the price. It does not
// automatically: coins arriving in the treasury were never part of the ladder,
// so they cannot leave it. Something has to withdraw ladder inventory to match.
//
// THE TRADE, STATED PLAINLY
// A retired coin is a coin that can never be sold for money. Retirement
// converts potential revenue into a higher price for everything still on the
// ladder. At 100% that is ruinous: $100/day of spending at $0.015 is ~6,667
// PCN/day, which empties a 100,000-coin ladder in about a fortnight with nobody
// having bought anything. At 10% it is ~667/day and the ladder lasts ~150 days
// of usage. The ratio is the whole design.
//
// NOTHING IS DESTROYED. The coins customers spent sit in the treasury exactly
// as before. "Retired" describes the LADDER: that much inventory is withdrawn
// from sale. It is a commitment, not a burn -- reversible in principle, which
// is precisely why it is recorded row by row against the chain output that
// caused it.
//
// HOW SPENDING IS DETECTED
// Each service hands out deposit addresses derived from its own xpub, so every
// address it will ever issue is known in advance and sits in `spend_addresses`.
// A payment landing on one of those is, by construction, someone paying that
// service. Nothing else lands there.
//
// We walk blocks rather than querying an address index: one pass over the chain
// costs seconds and does not lean on the explorer, which is a single process
// that every deposit credit in the estate already depends on.
//
// WHAT STOPS IT DOUBLE-COUNTING
//  * every retirement is keyed UNIQUE on (txid, vout) -- an output index cannot
//    repeat within a transaction, so re-scanning a block is a no-op
//  * the scan only reads blocks buried at least `retireMinConf` deep, so a
//    reorg cannot retire inventory for a payment that gets undone. Reorgs are
//    routine on this chain, not exceptional
//  * a daily cap bounds how far usage can move the price in one day, whatever
//    arrives

export function makeRetire({ pool, node, settings, notify, log = console }) {
  let lastNodeFail = 0, lastNodeAlert = 0;
  const q = async (sql, args = []) => (await pool.query(sql, args))[0];
  const UNITS = 1e8;
  const toUnits = pcn => Math.round(Number(pcn) * UNITS);
  const fromUnits = u => u / UNITS;

  const cfg = () => ({
    on:      !!settings.get('retireSpentCoins'),
    ratio:   Number(settings.get('retireRatioPct')) / 100,
    minConf: Number(settings.get('retireMinConf')),
    dailyCap: Number(settings.get('retireDailyCapPcn')),
    systems: String(settings.get('retireSystems') || '')
               .split(/[\s,;]+/).map(s => s.trim()).filter(Boolean),
  });

  async function cursor() {
    const [r] = await q(`SELECT height FROM chain_scan WHERE name='retire'`);
    return r ? Number(r.height) : null;
  }
  async function setCursor(h, conn = pool) {
    await conn.query(
      `INSERT INTO chain_scan (name, height) VALUES ('retire', ?)
         ON DUPLICATE KEY UPDATE height = VALUES(height)`, [h]);
  }

  async function retiredToday() {
    const [r] = await q(
      `SELECT COALESCE(SUM(pcn_retired),0) t FROM retirements WHERE at >= UTC_DATE()`);
    return Number(r[0]?.t ?? r.t ?? 0);
  }

  /** Withdraw `pcn` from the cheapest rungs that still have anything left.
   *  Runs inside the caller's transaction, with the rungs locked, so it cannot
   *  race a purchase reserving the same coins. */
  async function retireFromLadder(conn, pcn) {
    let need = toUnits(pcn);
    if (need <= 0) return 0;
    const [rungs] = await conn.query(
      `SELECT rung_no, qty_total, qty_sold, qty_reserved, qty_retired
         FROM ladder_rungs
        WHERE qty_sold + qty_reserved + qty_retired < qty_total
        ORDER BY rung_no FOR UPDATE`);
    let done = 0;
    for (const r of rungs) {
      if (need <= 0) break;
      const avail = toUnits(Number(r.qty_total)) - toUnits(Number(r.qty_sold))
                  - toUnits(Number(r.qty_reserved)) - toUnits(Number(r.qty_retired));
      if (avail <= 0) continue;
      const take = Math.min(avail, need);
      await conn.query(`UPDATE ladder_rungs SET qty_retired = qty_retired + ? WHERE rung_no = ?`,
                       [fromUnits(take).toFixed(8), r.rung_no]);
      need -= take; done += take;
    }
    return fromUnits(done);
  }

  /** One pass. Returns what it did, for the log and the operator. */
  async function scan() {
    const c = cfg();
    if (!c.on) return { ok: true, skipped: 'retirement is switched off' };
    if (!(c.ratio > 0)) return { ok: true, skipped: 'ratio is zero' };
    if (!c.systems.length) return { ok: true, skipped: 'no systems configured' };

    let tip;
    try {
      tip = await node.rpc('getblockcount');
      lastNodeFail = 0;
    } catch (e) {
      // Retirement is what makes the price respond to real usage, so this
      // failing means the price quietly stops tracking spend. Nothing else
      // watches it: the caller is a fire-and-forget setInterval that discards
      // the returned {ok:false}, so without this the mechanism can be off for
      // days and look identical to "nobody spent anything".
      if (!lastNodeFail) lastNodeFail = Date.now();
      if (Date.now() - lastNodeAlert >= 60 * 60 * 1000) {
        lastNodeAlert = Date.now();
        await notify(`🟠 <b>Retirement stalled</b>\nThe node is unreachable, so spent coins are ` +
          `not being retired and the ladder price has stopped responding to usage ` +
          `(${Math.round((Date.now() - lastNodeFail) / 60000)} min so far).\n` +
          `<code>${String(e.message).slice(0, 200)}</code>`).catch(() => {});
      }
      return { ok: false, why: `node unreachable: ${e.message}` };
    }

    const safeTip = tip - c.minConf;           // never read an unconfirmed tip
    let from = await cursor();
    if (from === null) {
      // First run: start from the tip rather than retiring for the entire past.
      // Historical spending happened before this mechanism existed and was
      // never priced in; retroactively withdrawing inventory for it would be a
      // large, silent price jump nobody asked for.
      await setCursor(safeTip);
      log.log(`[retire] first run, cursor set to ${safeTip} — history is not retroactively retired`);
      return { ok: true, initialised: safeTip };
    }
    if (safeTip <= from) return { ok: true, upToDate: true, at: from };

    const capLeft = Math.max(0, c.dailyCap - await retiredToday());
    let scanned = 0, spent = 0, retired = 0, capped = false;

    for (let h = from + 1; h <= safeTip; h++) {
      let b;
      try { b = await node.rpc('getblock', [await node.rpc('getblockhash', [h]), 2]); }
      catch (e) { log.warn(`[retire] block ${h} unreadable: ${e.message}`); break; }

      for (const tx of b.tx) {
        for (let vout = 0; vout < tx.vout.length; vout++) {
          const o = tx.vout[vout];
          const addr = o.scriptPubKey?.address;
          if (!addr || !(o.value > 0)) continue;
          const [[row]] = await pool.query(
            `SELECT system FROM spend_addresses WHERE address = ?`, [addr]);
          if (!row || !c.systems.includes(row.system)) continue;

          const want = Number(o.value) * c.ratio;
          const allowed = capped ? 0 : Math.min(want, Math.max(0, capLeft - retired));
          if (allowed < want) capped = true;

          const conn = await pool.getConnection();
          try {
            await conn.beginTransaction();
            // The UNIQUE (txid, vout) is what makes a re-scan free. Claim the
            // row FIRST: if it is already there, this output is already priced
            // in and the ladder must not move again.
            try {
              await conn.query(
                `INSERT INTO retirements (txid, vout, height, system, address, pcn_spent, pcn_retired)
                 VALUES (?,?,?,?,?,?,0)`,
                [tx.txid, vout, h, row.system, addr, Number(o.value).toFixed(8)]);
            } catch (e) {
              await conn.rollback();
              if (e.code === 'ER_DUP_ENTRY') continue;      // already counted
              throw e;
            }
            const got = allowed > 0 ? await retireFromLadder(conn, allowed) : 0;
            await conn.query(`UPDATE retirements SET pcn_retired = ? WHERE txid = ? AND vout = ?`,
                             [got.toFixed(8), tx.txid, vout]);
            await conn.commit();
            spent += Number(o.value); retired += got;
          } catch (e) {
            await conn.rollback();
            log.error(`[retire] ${tx.txid}:${vout} failed: ${e.message}`);
          } finally { conn.release(); }
        }
      }
      await setCursor(h);
      scanned++;
    }

    if (retired > 0) {
      log.log(`[retire] ${spent.toFixed(2)} PCN spent -> ${retired.toFixed(2)} retired ` +
              `over ${scanned} block(s)`);
      await notify(
        `♻️ <b>Usage retired ladder inventory</b>\n` +
        `Customers spent <b>${spent.toFixed(2)} PCN</b> on the services.\n` +
        `Withdrew <b>${retired.toFixed(2)} PCN</b> from sale (${(c.ratio * 100).toFixed(0)}%).\n` +
        (capped ? `⚠️ The daily cap of ${c.dailyCap} PCN was reached; the rest was not retired.\n` : '') +
        `Those coins are in your treasury, not destroyed — this only takes them off the ladder.`);
    }
    return { ok: true, scanned, spent, retired, capped, at: safeTip };
  }

  return { scan, cursor, setCursor, retiredToday, retireFromLadder };
}
