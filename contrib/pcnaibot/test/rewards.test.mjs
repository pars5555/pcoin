// The welcome gift and the invite reward (lib/rewards.mjs).
//
// Pinned:
//   * the gift is given ONCE per chat id, as a 'gift' ledger row, only by the call that creates the
//     account -- and never again, even if the user row is re-created;
//   * an invite is recorded only for a NEW account, never for yourself, never to a stranger, and
//     only once per invited person;
//   * the reward is paid once, when a video is delivered AND the invited person has topped up at
//     least the minimum of their own money (deposits minus Stars refunds) -- the gift never counts;
//   * the books close (reconcile) after every step.
import test from 'node:test';
import assert from 'node:assert/strict';

import { freshDb, fakeTg, fakeMedia, PNG, OFFER, SETTINGS } from './fixtures.mjs';
import { settingsProblems, mergeSettingsInput } from '../lib/settings.mjs';
import { openAccount, payInviteReward, parseInvite, inviteLink, inviteStats, toppedUpMicro, usdToMicro } from '../lib/rewards.mjs';
import { deliverItem } from '../lib/jobs.mjs';
import { reconcile } from '../lib/deposits.mjs';
import { nowSec } from '../lib/db.mjs';

const GIFT = usdToMicro(3);
const REWARD = usdToMicro(2);
const MIN = usdToMicro(1);
const open = (db, chatId, extra = {}) => openAccount(db, { chatId, model: 'studio', giftMicro: GIFT, ...extra });
const bal = (db, c) => db.prepare('SELECT balance_micro_usd b FROM users WHERE chat_id = ?').get(c).b;
const topUp = (db, c, micro, key = `stars:T${c}-${micro}`) => {
  db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (?,?, 'deposit_stars', ?, 'test', ?)`).run(c, Number(micro), key, nowSec());
  db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd + ? WHERE chat_id = ?').run(Number(micro), c);
};
const pay = (db, referredId, over = {}) => payInviteReward(db, { referredId, rewardMicro: REWARD, minTopupMicro: MIN, ...over });

test('a new account gets the welcome gift once, as a gift ledger row', () => {
  const db = freshDb({ chats: [] });
  const a = open(db, 100, { lang: 'hy' });
  assert.equal(a.created, true);
  assert.equal(a.giftMicro, GIFT);
  assert.equal(a.user.lang, 'hy');
  assert.equal(bal(db, 100), 3_000_000);
  const rows = db.prepare("SELECT * FROM ledger WHERE chat_id = 100").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, 'gift');
  assert.equal(rows[0].idem_key, 'welcome:100');

  const again = open(db, 100);
  assert.equal(again.created, false);
  assert.equal(again.giftMicro, 0n);
  assert.equal(bal(db, 100), 3_000_000, 'an existing user gets nothing more');
  assert.ok(reconcile(db).ok);
});

test('a user row re-created later never gets a second gift', () => {
  const db = freshDb({ chats: [] });
  open(db, 100);
  db.prepare('DELETE FROM users WHERE chat_id = 100').run();
  const b = open(db, 100);
  assert.equal(b.created, true);
  assert.equal(b.giftMicro, 0n, 'welcome:100 is already taken');
  assert.equal(bal(db, 100), 0);
  assert.equal(db.prepare("SELECT COUNT(*) n FROM ledger WHERE kind = 'gift'").get().n, 1);
});

test('a zero gift writes nothing', () => {
  const db = freshDb({ chats: [] });
  const a = openAccount(db, { chatId: 100, model: 'studio', giftMicro: 0n });
  assert.equal(a.created, true);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM ledger').get().n, 0);
  assert.ok(reconcile(db).ok);
});

test('invite links parse only as r<positive id>', () => {
  assert.equal(parseInvite('r508669931'), 508669931);
  assert.equal(parseInvite(' r7 '), 7);
  for (const bad of ['', 'r', 'r0', 'x7', 'r7x', 'r-7', null, undefined, 'r123456789012345678901']) assert.equal(parseInvite(bad), null, String(bad));
  assert.equal(inviteLink('PcoinAiBot', 7), 'https://t.me/PcoinAiBot?start=r7');
});

test('an invite is recorded only for a new account, never for yourself or a stranger', () => {
  const db = freshDb({ chats: [] });
  open(db, 1);                                                  // the inviter
  assert.equal(open(db, 2, { invitedBy: 1 }).invite, 'recorded');
  assert.equal(open(db, 3, { invitedBy: 3 }).invite, 'self');
  assert.equal(open(db, 4, { invitedBy: 999 }).invite, 'no_referrer', 'the inviter must exist');
  assert.equal(open(db, 2, { invitedBy: 1 }).invite, null, 'an existing account cannot be invited');
  // The same person cannot be claimed twice, even if their user row were re-created.
  db.prepare('DELETE FROM users WHERE chat_id = 2').run();
  open(db, 5);
  assert.equal(open(db, 2, { invitedBy: 5 }).invite, 'taken');
  assert.equal(db.prepare('SELECT referrer_chat_id r FROM referrals WHERE referred_chat_id = 2').get().r, 1, 'the first inviter keeps them');
});

test('the reward waits for a real top-up: the gift alone never pays the inviter', () => {
  const db = freshDb({ chats: [] });
  open(db, 1);
  open(db, 2, { invitedBy: 1 });
  assert.deepEqual(pay(db, 2, { itemId: 10 }), { paid: false, why: 'not_topped_up' });
  topUp(db, 2, 990_000);                                        // 99 cents: under the $1 minimum
  assert.equal(pay(db, 2).why, 'not_topped_up');
  assert.equal(db.prepare('SELECT status FROM referrals WHERE referred_chat_id = 2').get().status, 'pending', 'still waiting');

  topUp(db, 2, 10_000);                                         // now exactly $1
  const r = pay(db, 2, { itemId: 11 });
  assert.equal(r.paid, true);
  assert.equal(r.referrerId, 1);
  assert.equal(r.micro, REWARD);
  assert.equal(bal(db, 1), 5_000_000, '$3 gift + $2 reward');
  const row = db.prepare('SELECT * FROM referrals WHERE referred_chat_id = 2').get();
  assert.equal(row.status, 'rewarded');
  assert.equal(row.trigger_item_id, 11);
  const led = db.prepare("SELECT * FROM ledger WHERE kind = 'referral'").all();
  assert.equal(led.length, 1);
  assert.equal(led[0].chat_id, 1);
  assert.equal(led[0].idem_key, 'referral:2');

  assert.equal(pay(db, 2).why, 'none', 'paid once');
  assert.equal(bal(db, 1), 5_000_000);
  assert.deepEqual(inviteStats(db, 1), { joined: 1, rewarded: 1, earnedMicro: REWARD });
  assert.ok(reconcile(db).ok);
});

test('a Stars refund takes the top-up back out of the count', () => {
  const db = freshDb({ chats: [] });
  open(db, 1);
  open(db, 2, { invitedBy: 1 });
  topUp(db, 2, 5_000_000);
  db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (2, -5000000, 'adjust', 'stars-refund:X', 'refund', ?)`).run(nowSec());
  db.prepare('UPDATE users SET balance_micro_usd = balance_micro_usd - 5000000 WHERE chat_id = 2').run();
  assert.equal(toppedUpMicro(db, 2), 0n);
  assert.equal(pay(db, 2).why, 'not_topped_up');
  // A hand credit or a rebate is not their money either.
  db.prepare(`INSERT INTO ledger (chat_id, delta_micro_usd, kind, idem_key, note, created_at) VALUES (2, 9000000, 'adjust', 'admin:abc12345', 'x', ?)`).run(nowSec());
  assert.equal(toppedUpMicro(db, 2), 0n);
});

test('a minimum of $0 pays on the first video with no top-up; switched off pays nothing', () => {
  const db = freshDb({ chats: [] });
  open(db, 1);
  open(db, 2, { invitedBy: 1 });
  assert.equal(pay(db, 2, { enabled: false }).why, 'off');
  assert.equal(pay(db, 2, { rewardMicro: 0n }).why, 'off');
  assert.equal(pay(db, 2, { minTopupMicro: 0n }).paid, true);
});

test('an inviter who is gone voids the invite instead of paying nobody', () => {
  const db = freshDb({ chats: [] });
  open(db, 1);
  open(db, 2, { invitedBy: 1 });
  topUp(db, 2, 5_000_000);
  db.prepare('DELETE FROM users WHERE chat_id = 1').run();
  assert.equal(pay(db, 2).why, 'referrer_gone');
  assert.equal(db.prepare('SELECT status FROM referrals WHERE referred_chat_id = 2').get().status, 'void');
});

test('the gift and invite amounts are bounded: a typo cannot hand out a fortune', () => {
  const check = (over) => settingsProblems({ ...SETTINGS, ...over }, { offer: OFFER, chatChoices: ['mimo-v2.5'] });
  assert.deepEqual(check({}), [], 'the defaults are valid');
  assert.equal(SETTINGS.giftUsd, 3);
  assert.equal(SETTINGS.inviteRewardUsd, 2);
  for (const bad of [{ giftUsd: 300 }, { giftUsd: -1 }, { giftUsd: 3.005 }, { inviteRewardUsd: 20.01 }, { inviteMinTopupUsd: 5000 }, { giftEnabled: 'yes' }]) {
    assert.ok(check(bad).length > 0, JSON.stringify(bad));
  }
  assert.deepEqual(check({ giftUsd: 0, inviteRewardUsd: 20, inviteMinTopupUsd: 0, giftEnabled: false }), []);
  // What the admin form sends: strings and checkbox words.
  const m = mergeSettingsInput(SETTINGS, { giftUsd: '2.50', giftEnabled: 'on', invitesEnabled: false, inviteMinTopupUsd: '0' });
  assert.equal(m.giftUsd, 2.5);
  assert.equal(m.giftEnabled, true);
  assert.equal(m.invitesEnabled, false);
  assert.equal(m.inviteMinTopupUsd, 0);
  assert.equal(mergeSettingsInput(SETTINGS, { margin: '4' }).giftUsd, 3, 'another form leaves the gift alone');
});

test('delivering a video calls the after-delivery hook once, and a throwing hook still delivers', async () => {
  const db = freshDb({ chats: [7] });
  const mk = () => Number(db.prepare(
    `INSERT INTO items (chat_id, kind, summary, prompt, result_url, result_expires_at, delivery_attempts, created_at)
     VALUES (7, 'video', 'a clip', 'a clip', 'https://x.example/v.mp4', ?, 0, ?)`
  ).run(nowSec() + 3600, nowSec()).lastInsertRowid);
  const seen = [];
  const deps = { db, tg: fakeTg(), media: fakeMedia({ bytes: PNG }), onDelivered: async (it) => { seen.push(it.id); } };
  const id = mk();
  assert.equal((await deliverItem(deps, id)).ok, true);
  assert.equal((await deliverItem(deps, id)).ok, true, 'already delivered');
  assert.deepEqual(seen, [id], 'once');

  const id2 = mk();
  const r = await deliverItem({ ...deps, onDelivered: async () => { throw new Error('boom'); } }, id2);
  assert.equal(r.ok, true);
  assert.ok(db.prepare('SELECT delivered_at FROM items WHERE id = ?').get(id2).delivered_at);
});
