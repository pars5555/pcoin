// wPCN top-ups, modelled directly on checker_pc_am's WpcnService.php.
//
// THE TWO PATHS ARE ARITHMETICALLY IDENTICAL, ON PURPOSE.
//
// wPCN is a 1:1 claim on PCN, redeemable 1:1. Since 2026-09-11 the shared
// verifier credits from `serviceRate` with `bonusPercent: 0`, so N wPCN is worth
// exactly what N PCN is worth -- and crediting it at any other number would
// contradict the one property that makes it work.
//
// Parity in VALUE is the verifier's job. Parity in ARITHMETIC is this file's:
// both paths floor to a sub-unit and CARRY the remainder, so flooring each
// payment independently does not eat a fraction every time. checker does the
// same, and the only difference is where the carry lives, forced by the asset:
//
//     PCN  -> pcn_addresses.remainder_nano_usd   (a deposit HAS an address)
//     wPCN -> users.wpcn_remainder_nano_usd      (a BEP-20 transfer has none)
//
// The client is VENDORED VERBATIM from contrib/wpcn-pay/clients/wpcn-pay.mjs --
// six rails already shipped one shared bug in a hand-written claims() parser and
// it failed safe, so nobody saw it for weeks. FIX UPSTREAM AND RE-COPY; do not
// edit lib/vendor/wpcn-pay.mjs in place.
//
// WE NEVER TALK TO BNB SMART CHAIN. Why a transaction hash and not a per-user
// address: BEP-20 has no memo field; a per-user address needs BNB in it before
// anything can be swept out; and eth_getLogs is refused by public BSC RPCs --
// measured at spans of 1, 50, 500 and 5000 blocks, all four "limit exceeded".
// EVEN A SINGLE BLOCK IS REFUSED. eth_getTransactionReceipt for one hash is
// still free everywhere, so the customer pastes the hash.

import { WpcnPay, STATE, isCredit, humanMessage } from './vendor/wpcn-pay.mjs';
import { immediate } from './db.mjs';
import { splitNano, satsToNanoUsd, parseScaled } from './money.mjs';
import { nowSec } from './time.mjs';
import { log } from './log.mjs';

export { STATE, isCredit, humanMessage };

export function isTxHash(s) {
  return typeof s === 'string' && /^0x[0-9a-fA-F]{64}$/.test(s.trim());
}

// Normalise verifier rows into what the ledger writer needs.
//
// ACCEPT BOTH FIELD SPELLINGS. A /verify transfer carries `logIndex`, `usd`,
// `rate_usd`; a /claims record carries `log_index`, `usd_credited`,
// `credited_rate_usd`. An integrator read the /verify names off a /claims row,
// got undefined for all three, and FAILED SILENTLY.
//
// Every figure is parsed from its DECIMAL STRING with parseScaled, which
// truncates -- so nothing passes through a double on its way to an integer, and
// the direction of the rounding matches the PCN path exactly.
export function creditableRows(rows, requireState) {
  if (!Array.isArray(rows)) return [];
  const out = [];
  for (const t of rows) {
    if (!t || typeof t !== 'object') continue;
    if (requireState && t.state !== requireState) continue;

    const li = t.logIndex ?? t.log_index ?? null;
    const usd = t.usd ?? t.usd_credited ?? null;
    const rate = t.rate_usd ?? t.credited_rate_usd ?? null;
    const wpcn = t.wpcn ?? t.wpcn_amount ?? null;
    const bonus = t.bonus_pct ?? t.bonusPercent ?? 0;

    // A row missing any of these is UNREADABLE, not zero.
    if (!Number.isInteger(Number(li)) || !Number.isFinite(Number(usd)) || !Number.isFinite(Number(rate))) continue;

    let usdNano;
    let rateE12;
    let wpcnSat;
    try {
      usdNano = parseScaled(String(usd), 9);
      rateE12 = parseScaled(String(rate), 12);
      // wPCN HAS 8 DECIMALS, NOT 18 -- the SAME unit as a PCN satoshi, which is
      // what lets the cross-check below reuse the PCN path's own function.
      wpcnSat = parseScaled(String(wpcn ?? 0), 8);
    } catch {
      continue; // unparseable is unreadable, never zero
    }

    out.push({ logIndex: Number(li), usdNano, rateE12, wpcnSat, bonusPct: Math.round(Number(bonus) || 0) });
  }
  return out;
}

export class WpcnService {
  constructor(db, { token, endpoint = 'https://wpcnpay.pc.am', enabled = false } = {}) {
    this.db = db;
    this.enabled = enabled;
    this.client = enabled && token ? new WpcnPay(token, { endpoint }) : null;
  }

  // READ payTo AND bonusPercent FROM /health, NEVER HARDCODE.
  async paymentInfo() {
    if (!this.client) return null;
    try {
      const h = await this.client.health();
      if (!h || h.ok !== true) return null;
      if (typeof h.payTo !== 'string' || !Number.isFinite(Number(h.bonusPercent))) return null;
      return {
        payTo: h.payTo,
        bonusPct: Number(h.bonusPercent),
        minConfirmations: Number(h.minConfirmations) || null,
      };
    } catch (e) {
      log.warn('wpcn: /health unreadable', { err: e.message });
      return null;
    }
  }

  #haveRow(txhash) {
    return this.db.prepare('SELECT COUNT(*) n FROM wpcn_claims WHERE txhash = ?').get(txhash).n > 0;
  }

  async verifyAndCredit(chatId, txhashRaw) {
    const txhash = String(txhashRaw).trim().toLowerCase();
    const base = { state: STATE.UNREADABLE, creditedMicro: 0n, duplicate: false, yours: false, healed: false };

    if (!isTxHash(txhash)) return { ...base, state: STATE.BAD_REQUEST };
    if (!this.client) return { ...base, state: 'disabled' };

    const r = await this.client.verify(txhash, String(chatId));
    const state = String(r?.state ?? STATE.UNREADABLE);
    log.info('wpcn verify', { chat: String(chatId).slice(-4), tx: txhash.slice(0, 12), state });

    // SWITCH ON `state`, NEVER ON `ok`. ok:false accompanies pending,
    // confirming and no_payment at HTTP 200, and `state !== 'unreadable'` would
    // make every unknown a credit.
    if (state === STATE.CREDITED) {
      // A `credited` reply we cannot read is NOT a credit. Write nothing and
      // return unreadable: the verifier has banked it, so the retry lands in
      // the heal path below.
      const rows = isCredit(r) ? creditableRows(r.transfers, STATE.CREDITED) : [];
      if (rows.length === 0) {
        log.error('wpcn: credited reply without usable transfers', { tx: txhash.slice(0, 12) });
        return { ...base, state: STATE.UNREADABLE };
      }
      return this.#credit(chatId, txhash, rows, base);
    }

    if (state === STATE.ALREADY_CLAIMED) {
      // ALREADY_CLAIMED IS TWO STATES, AND REFUSING BOTH LOSES A PAYING
      // CUSTOMER'S MONEY.
      const rows = Array.isArray(r.transfers) ? r.transfers : [];
      const yours = rows.length > 0 && rows.every((t) => t && t.yours);
      const out = { ...base, state, duplicate: true, yours };

      if (yours && !this.#haveRow(txhash)) {
        // THE HEAL PATH. insertClaim() commits to the verifier's ledger BEFORE
        // the credited result reaches us, so any lost response or process kill
        // between those two moments parks the payment there permanently.
        const recs = await this.#ownClaimRows(chatId, txhash);
        if (recs.length > 0) {
          log.warn('wpcn: HEALING a lost credit', { chat: String(chatId).slice(-4), tx: txhash.slice(0, 12) });
          const res = this.#credit(chatId, txhash, recs, out);
          return { ...res, healed: true };
        }
        // We hold nothing and cannot read the record: say "try again", NEVER
        // "already credited", and leave a loud trail.
        log.error('wpcn: verifier says claimed by this user but /claims has no record', { tx: txhash.slice(0, 12) });
        return { ...out, state: STATE.UNREADABLE };
      }
      return out;
    }

    return { ...base, state };
  }

  async #ownClaimRows(chatId, txhash) {
    try {
      const c = await this.client.claims(String(chatId));
      const all = Array.isArray(c?.claims) ? c.claims : [];
      const mine = all.filter((x) => String(x?.txhash ?? '').toLowerCase() === txhash);
      return creditableRows(mine, null);
    } catch (e) {
      log.error('wpcn: /claims unreadable during heal', { err: e.message });
      return [];
    }
  }

  // ONE ROW PER transfers[] ENTRY -- usd_total is the sum over all of them, and
  // reading transfers[0] only protects the first log index.
  #credit(chatId, txhash, rows, out) {
    return immediate(this.db, () => {
      const now = nowSec();
      const taken = [];
      let nanoNew = 0n;

      for (const row of rows) {
        const ins = this.db.prepare(
          `INSERT INTO wpcn_claims (txhash, log_index, chat_id, wpcn_sat, usd_micro, rate_e12, bonus_pct, created_at)
           VALUES (?,?,?,?,?,?,?,?)
           ON CONFLICT(txhash, log_index) DO NOTHING`
        ).run(txhash, row.logIndex, chatId, Number(row.wpcnSat),
              Number(row.usdNano / 1000n), Number(row.rateE12), row.bonusPct, now);
        if (ins.changes !== 1) continue; // this log index is already ours

        // CREDIT FROM THE PCN PATH'S OWN FUNCTION, not from the verifier's
        // stamped USD.
        //
        // wPCN has 8 decimals and a PCN satoshi is 1e-8 PCN, so the two amounts
        // are the SAME integer unit -- satsToNanoUsd() is therefore literally
        // the same arithmetic for both assets, and N wPCN credits exactly what
        // N PCN credits, by construction rather than by tolerance.
        //
        // The verifier's own figure comes from a FLOAT multiply rounded at 9dp,
        // where this floors an exact integer product: measured at 139 units the
        // two differ by 1 nano-USD ($1e-9). That is economically nothing and
        // arithmetically not parity, and parity is the whole proposition of a
        // 1:1 claim -- so the verifier's number becomes the CROSS-CHECK and
        // ours becomes the credit.
        //
        // If the amount is not readable we fall back to the stamped figure,
        // because a payment we cannot recompute is still a payment the verifier
        // has banked to us.
        const ours = row.wpcnSat > 0n ? satsToNanoUsd(row.wpcnSat, row.rateE12) : row.usdNano;
        const drift = ours === 0n ? 0 : Number(row.usdNano - ours) / Number(ours);
        if (Math.abs(drift) > 0.001) {
          // A tenth of a percent is far above float noise and far below
          // anything that could be a rate change we should silently accept.
          log.error('wpcn: verifier USD disagrees with the PCN arithmetic on the same inputs', {
            tx: txhash.slice(0, 12), logIndex: row.logIndex,
            verifier_nano: String(row.usdNano), ours_nano: String(ours), drift: drift.toFixed(4),
          });
        }
        if (row.bonusPct !== 0) {
          // Parity is the point. A non-zero bonus means wPCN credits more than
          // the same PCN -- the arbitrage that was closed on 2026-09-11 by
          // setting bonusPercent to 0.
          log.error('wpcn: verifier is applying a NON-ZERO bonus; wPCN is no longer at parity with PCN', {
            tx: txhash.slice(0, 12), bonus_pct: row.bonusPct,
          });
        }

        nanoNew += ours;
        taken.push({ ...row, creditedNano: ours });
      }

      if (taken.length === 0) {
        return { ...out, state: STATE.CREDITED, creditedMicro: 0n, duplicate: true };
      }

      // FLOOR ONCE over the whole payment, plus whatever the last one left
      // over, and carry the rest. Same shape as the PCN path; the carry lives
      // on the USER because a BEP-20 transfer has no address.
      const u = this.db.prepare('SELECT wpcn_remainder_nano_usd r FROM users WHERE chat_id = ?').get(chatId);
      if (!u) throw new Error('wpcn credit: no user row');
      const split = splitNano(nanoNew + BigInt(u.r));

      // LEDGER ROWS, keyed on (txhash, logIndex) -- the BEP-20 shape of the
      // (txid, address) rule. Keying on the hash alone silently drops the
      // second Transfer log. The whole floored amount is attributed to the
      // first log so the ledger sums to the balance move exactly; the rest are
      // ZERO ROWS, still written, because a deposit invisible to a
      // reconciliation is how webbuilderbot's dust vanished.
      for (const row of taken) {
        try {
          this.db.prepare(
            `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, rate_e12, note, created_at)
             VALUES (?,?,?,?,?,?,?)`
          ).run(chatId,
                row === taken[0] ? Number(split.micro) : 0,
                'deposit_wpcn',
                `wpcn:${txhash}:${row.logIndex}`,
                Number(row.rateE12),
                `${row.wpcnSat} wpcn-sat, bonus ${row.bonusPct}%`,
                now);
        } catch (e) {
          if (/UNIQUE constraint failed/i.test(e.message)) continue;
          throw e;
        }
      }

      if (split.micro > 0n) {
        this.db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?')
          .run(Number(split.micro), chatId);
      }
      this.db.prepare('UPDATE users SET wpcn_remainder_nano_usd = ? WHERE chat_id = ?')
        .run(Number(split.remainder), chatId);

      return { ...out, state: STATE.CREDITED, creditedMicro: split.micro, duplicate: false };
    });
  }
}
