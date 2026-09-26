// Free money: the welcome gift and the invite reward (owner, 2026-09-26: "each new user should get
// 3$ gift balance, and also bounty program similar to webcrafter ... 2$ gift each invite, when
// created first video").
//
// webbuilderbot's shape, with its holes closed:
//   * THE GIFT IS A LEDGER ROW (kind 'gift', idem_key welcome:<chat_id>), written in the SAME
//     transaction that creates the account. webbuilderbot SET the balance with no row at all, so it
//     was invisible to every total and a deleted-and-returning user got it again. Here the key is
//     permanent: a user row re-created later finds the key taken and gets nothing.
//   * AN INVITE IS RECORDED ONLY BY THE UPDATE THAT CREATED THE ACCOUNT, once per invited person for
//     life (referrals.referred_chat_id UNIQUE), never for yourself, never to a referrer who does
//     not exist. A bad row is 'void', never deleted.
//   * THE REWARD IS PAID ONCE, when the invited person's video is delivered AND they have topped up
//     at least inviteMinTopupUsd of their own money (owner's choice, 2026-09-26: "first video after a
//     top-up"). The welcome gift alone never qualifies, which is what stops a fake account living on
//     its $3 from paying its maker $2. "Topped up" is deposits (PCN, wPCN, Stars) minus Stars refunds,
//     read from the ledger at payout time.
//   * The payout is a conditional UPDATE ... WHERE status = 'pending' plus a ledger row keyed
//     referral:<invited chat_id>, in one BEGIN IMMEDIATE: two deliveries racing pay once.
//
// No caps, by the owner's decision (2026-09-26: "No limits"). The amounts are admin settings.

import { immediate } from './db.mjs';
import { nowSec } from './time.mjs';

// Dollars (a settings number, whole cents) as micro-USD.
export const usdToMicro = (usd) => BigInt(Math.round(Number(usd) * 100)) * 10000n;

// The start payload of an invite link: t.me/<bot>?start=r<chat_id>.
export function parseInvite(payload) {
  const m = /^r(\d{1,20})$/.exec(String(payload ?? '').trim());
  if (!m) return null;
  const id = Number(m[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export const inviteLink = (botUsername, chatId) => `https://t.me/${botUsername}?start=r${chatId}`;

// Find or create the user. Only a call that CREATES the row may give the welcome gift or record an
// invite. Returns { user, created, giftMicro, invite } where invite is null or one of
// 'recorded' | 'self' | 'no_referrer' | 'taken'.
export function openAccount(db, { chatId, model, lang = null, giftMicro = 0n, invitedBy = null, now = nowSec() }) {
  return immediate(db, () => {
    const existing = db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId);
    if (existing) return { user: existing, created: false, giftMicro: 0n, invite: null };

    db.prepare('INSERT INTO users (chat_id, model, lang, created_at) VALUES (?,?,?,?)').run(chatId, model, lang, now);

    let gave = 0n;
    const gift = BigInt(giftMicro);
    if (gift > 0n) {
      const r = db.prepare(
        `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at)
         VALUES (?,?, 'gift', ?, 'welcome gift', ?)
         ON CONFLICT (idem_key) DO NOTHING`
      ).run(chatId, Number(gift), `welcome:${chatId}`, now);
      if (r.changes === 1) {
        db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?').run(Number(gift), chatId);
        gave = gift;
      }
    }

    let invite = null;
    if (invitedBy !== null && invitedBy !== undefined) {
      if (invitedBy === chatId) invite = 'self';
      else if (!db.prepare('SELECT 1 FROM users WHERE chat_id = ?').get(invitedBy)) invite = 'no_referrer';
      else {
        const r = db.prepare(
          `INSERT INTO referrals (referrer_chat_id, referred_chat_id, status, created_at) VALUES (?,?, 'pending', ?)
           ON CONFLICT (referred_chat_id) DO NOTHING`
        ).run(invitedBy, chatId, now);
        invite = r.changes === 1 ? 'recorded' : 'taken';
      }
    }
    return { user: db.prepare('SELECT * FROM users WHERE chat_id = ?').get(chatId), created: true, giftMicro: gave, invite };
  });
}

// What the person has paid in of their own money: deposits minus Stars refunds (a refund is an
// 'adjust' row keyed stars-refund:<charge>). Gifts, invite rewards, rebates and hand credits are
// not money they paid.
export function toppedUpMicro(db, chatId) {
  const n = db.prepare(
    `SELECT COALESCE(SUM(delta_micro_usd), 0) n FROM ledger
      WHERE chat_id = ? AND (kind IN ('deposit_pcn', 'deposit_wpcn', 'deposit_stars') OR idem_key LIKE 'stars-refund:%')`
  ).get(chatId).n;
  return BigInt(n);
}

// A video of `referredId` was delivered: pay their inviter, if one is waiting and the conditions
// hold. Returns { paid: true, referrerId, micro, balance } or { paid: false, why }. A 'pending' row
// that does not qualify yet stays pending -- the next delivered video asks again.
export function payInviteReward(db, { referredId, itemId = null, rewardMicro, minTopupMicro, enabled = true, now = nowSec() }) {
  const reward = BigInt(rewardMicro);
  if (!enabled || reward <= 0n) return { paid: false, why: 'off' };
  return immediate(db, () => {
    const ref = db.prepare("SELECT * FROM referrals WHERE referred_chat_id = ? AND status = 'pending'").get(referredId);
    if (!ref) return { paid: false, why: 'none' };
    if (ref.referrer_chat_id === referredId) {
      db.prepare("UPDATE referrals SET status = 'void', void_reason = 'self' WHERE id = ?").run(ref.id);
      return { paid: false, why: 'self' };
    }
    if (!db.prepare('SELECT 1 FROM users WHERE chat_id = ?').get(ref.referrer_chat_id)) {
      db.prepare("UPDATE referrals SET status = 'void', void_reason = 'inviter gone' WHERE id = ?").run(ref.id);
      return { paid: false, why: 'referrer_gone' };
    }
    if (toppedUpMicro(db, referredId) < BigInt(minTopupMicro)) return { paid: false, why: 'not_topped_up' };

    const up = db.prepare(
      `UPDATE referrals SET status = 'rewarded', reward_micro_usd = ?, trigger_item_id = ?, rewarded_at = ?
        WHERE id = ? AND status = 'pending'`
    ).run(Number(reward), itemId, now, ref.id);
    if (up.changes !== 1) return { paid: false, why: 'raced' };
    // A plain INSERT: a second row for the same invited person is a UNIQUE violation, which rolls
    // the whole transaction back -- the once-only guard at the database, under the one above.
    db.prepare(
      `INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'referral', ?, ?, ?)`
    ).run(ref.referrer_chat_id, Number(reward), `referral:${referredId}`, `invite reward: ${referredId} made a video`, now);
    db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?').run(Number(reward), ref.referrer_chat_id);
    const balance = db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(ref.referrer_chat_id).b;
    return { paid: true, referrerId: ref.referrer_chat_id, micro: reward, balance };
  });
}

// The inviter's figures for the invite screen.
export function inviteStats(db, chatId) {
  const r = db.prepare(
    `SELECT COUNT(CASE WHEN status <> 'void' THEN 1 END) joined,
            COUNT(CASE WHEN status = 'rewarded' THEN 1 END) rewarded,
            COALESCE(SUM(CASE WHEN status = 'rewarded' THEN reward_micro_usd END), 0) earned
       FROM referrals WHERE referrer_chat_id = ?`
  ).get(chatId);
  return { joined: r.joined, rewarded: r.rewarded, earnedMicro: BigInt(r.earned) };
}
