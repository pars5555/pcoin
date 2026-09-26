// The free chat agent (lib/studio.mjs): what it is told, what it may propose, and its memory.
//
// Pinned: nothing the model says is trusted for money -- every proposal is checked against the
// database and the live price list; a half-written tool call is no card; the conversation keeps
// what happened while the model was thinking; the free chat has limits; settings refuse what
// cannot be served.

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  chatTurn, validateProposal, normalizeHistory, loadHistory, appendHistory, noteFor, chatGate,
  systemPrompt, priceLines, testChatModel, PROPOSE_TOOL,
} from '../lib/studio.mjs';
import { settingsProblems, DEFAULT_SETTINGS, getSettings, saveSettings } from '../lib/settings.mjs';
import { mediaOffer } from '../lib/media.mjs';
import { MARGIN_E6, OFFER, LISTING, SETTINGS, freshDb, addItem } from './fixtures.mjs';

// A chat model that answers from a script; each answer may be a function of the request.
function fakeOona(answers) {
  const calls = [];
  return {
    calls,
    rateLimitRemaining: null,
    async messages(body) {
      calls.push(body);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return typeof a === 'function' ? a(body) : a;
    },
  };
}
const toolAnswer = (input, text = 'Here is the card — press ✅ to make it.') => ({
  stop_reason: 'tool_use',
  content: [
    { type: 'thinking', thinking: 'the user wants a fox', signature: 'sig' },
    { type: 'text', text },
    { type: 'tool_use', id: 'tu_1', name: 'propose', input },
  ],
  usage: { input_tokens: 10, output_tokens: 10 },
});
const textAnswer = (text) => ({ stop_reason: 'end_turn', content: [{ type: 'text', text }], usage: { input_tokens: 1, output_tokens: 1 } });
const turnDeps = (db, oona) => ({ db, oona, settings: SETTINGS, offer: OFFER, marginE6: MARGIN_E6, balanceMicro: 1_000_000n });

test('a clear request becomes a checked spec; the model\'s text comes with it; thinking is dropped', async () => {
  const db = freshDb();
  const oona = fakeOona([toolAnswer({ kind: 'image', prompt: 'A red fox sitting in fresh snow, photorealistic', summary: 'Лиса в снегу', shape: 'wide' })]);
  const r = await chatTurn(turnDeps(db, oona), { chatId: 7, userContent: 'лиса в снегу, широкая' });
  assert.equal(r.failed, null);
  assert.equal(r.text, 'Here is the card — press ✅ to make it.');
  assert.deepEqual(r.spec, { kind: 'image', model: 'wan2.7-image-pro', prompt: 'A red fox sitting in fresh snow, photorealistic', summary: 'Лиса в снегу',
    shape: 'wide', seconds: null, resolution: null, sources: [], startItemId: null, newVersionOf: null });
  const body = oona.calls[0];
  assert.equal(body.model, 'mimo-v2.5');
  assert.deepEqual(body.tools, [PROPOSE_TOOL]);
  assert.equal(body.messages.at(-1).content, 'лиса в снегу, широкая');
  assert.match(body.system, /reply in the language of the user's latest message/);
  assert.match(body.system, /THE USER'S LATEST MESSAGE: "лиса в снегу, широкая"\. Reply, and write the card summary, in the language of THAT message/);
  assert.match(body.system, /a picture costs \$0\.27/);
});

test('a talk-only answer is just text, and a half-written tool call is no card', async () => {
  const db = freshDb();
  const r = await chatTurn(turnDeps(db, fakeOona([textAnswer('Picture or video?')])), { chatId: 7, userContent: 'a fox' });
  assert.deepEqual(r, { text: 'Picture or video?', spec: null, failed: null });
  const cut = { ...toolAnswer({ kind: 'image', prompt: 'A fox', summary: 'A fox', shape: 'square' }), stop_reason: 'max_tokens' };
  const r2 = await chatTurn(turnDeps(db, fakeOona([cut])), { chatId: 7, userContent: 'a fox' });
  assert.equal(r2.spec, null);
  assert.equal(r2.failed, 'max_tokens');
});

test('an invalid proposal goes back to the model once, with the reason, and its own blocks untouched', async () => {
  const db = freshDb({ chats: [7, 8] });
  const foreign = addItem(db, { chatId: 8, kind: 'image' });
  const mine = addItem(db, { chatId: 7, kind: 'image' });
  const oona = fakeOona([
    toolAnswer({ kind: 'image', prompt: 'make it night', summary: 'Night', shape: 'square', sources: [foreign] }),
    toolAnswer({ kind: 'image', prompt: 'make it night', summary: 'Night', shape: 'square', sources: [mine] }, ''),
  ]);
  const r = await chatTurn(turnDeps(db, oona), { chatId: 7, userContent: 'make it night' });
  assert.deepEqual(r.spec.sources, [mine]);
  const retry = oona.calls[1].messages;
  assert.equal(retry.at(-2).role, 'assistant');
  assert.equal(retry.at(-2).content[0].type, 'thinking', 'the model\'s own blocks go back as they were');
  assert.equal(retry.at(-1).content[0].type, 'tool_result');
  assert.equal(retry.at(-1).content[0].is_error, true);
  assert.match(retry.at(-1).content[0].content, new RegExp(`#${foreign} is not one of this user's items`));
  assert.equal(r.text, 'Here is the card — press ✅ to make it.', 'the first text stands when the retry has none');
});

test('a second invalid proposal is no card', async () => {
  const db = freshDb();
  const bad = { kind: 'poster', prompt: 'x x x', summary: 'y y y', shape: 'square' };
  const r = await chatTurn(turnDeps(db, fakeOona([toolAnswer(bad), toolAnswer(bad)])), { chatId: 7, userContent: 'a poster' });
  assert.equal(r.spec, null);
  assert.equal(r.failed, 'invalid');
});

test('the gateway down: the turn throws, and nothing about money is touched', async () => {
  const db = freshDb();
  await assert.rejects(chatTurn(turnDeps(db, fakeOona([new Error('HTTP 502')])), { chatId: 7, userContent: 'a fox' }));
  assert.equal(db.prepare('SELECT COUNT(*) n FROM reservations').get().n, 0);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM proposals').get().n, 0);
});

test('proposals are checked: sources, kinds, limits, lengths', () => {
  const db = freshDb({ chats: [7, 8] });
  const photo = addItem(db, { kind: 'upload' });
  const pic = addItem(db, { kind: 'image' });
  const clipFromPhoto = addItem(db, { kind: 'video', startItemId: photo });
  const clipFromText = addItem(db, { kind: 'video' });
  const other = addItem(db, { chatId: 8, kind: 'image' });
  const v = (input, settings = SETTINGS, offer = OFFER) => validateProposal(db, 7, { prompt: 'a prompt', summary: 'a summary', shape: 'square', ...input }, { offer, settings });

  assert.match(v({ kind: 'image', sources: [clipFromText] }).error, /is a video/);
  assert.match(v({ kind: 'image', sources: [other] }).error, /not one of this user's items/);
  assert.deepEqual(v({ kind: 'image', sources: ['#' + pic, String(photo)] }).spec.sources, [pic, photo], '"#12" and "12" both read');
  assert.match(v({ kind: 'image', sources: [pic, photo] }, { ...SETTINGS, pictureModel: 'qwen-image-3.0-pro' }, mediaOffer(LISTING.map((m) => (m.id === 'qwen-image-3.0-pro' ? { ...m, limits: { input_images: { min: 0, max: 1 } } } : m)))).error, /at most 1 pictures/);
  assert.match(v({ kind: 'poster' }).error, /kind must be/);
  assert.equal(v({ kind: 'image', shape: 'hexagon' }).spec.shape, 'square');

  // Animate a picture: photo-to-video from it.
  assert.deepEqual(v({ kind: 'video', sources: [pic] }).spec, { kind: 'video', model: 'happyhorse-1.1', prompt: 'a prompt', summary: 'a summary',
    shape: 'square', seconds: 5, resolution: '720P', sources: [pic], startItemId: pic, newVersionOf: null });
  // Change a clip: a NEW version, from its own starting photo -- never the mp4.
  const nv = v({ kind: 'video', sources: [clipFromPhoto] }).spec;
  assert.equal(nv.newVersionOf, clipFromPhoto);
  assert.deepEqual(nv.sources, [photo]);
  const nt = v({ kind: 'video', sources: [clipFromText] }).spec;
  assert.equal(nt.newVersionOf, clipFromText);
  assert.deepEqual(nt.sources, [], 'a clip made from words is redone from words');
  assert.match(v({ kind: 'video', sources: [pic, photo] }).error, /at most one picture/);
  assert.equal(v({ kind: 'video', seconds: 60 }).spec.seconds, 15, 'clamped to the model\'s range');
  assert.equal(v({ kind: 'video', seconds: 1 }).spec.seconds, 3);
  const noI2v = mediaOffer(LISTING.filter((m) => m.id !== 'happyhorse-1.1-i2v'));
  assert.match(v({ kind: 'video', sources: [pic] }, SETTINGS, noI2v).error, /cannot start from a picture/);
  assert.match(v({ kind: 'image' }, SETTINGS, {}).error, /unavailable/);
});

test('history: a record written while the model thinks survives the save', () => {
  const db = freshDb();
  appendHistory(db, 7, [{ role: 'user', content: 'a fox' }, { role: 'assistant', content: 'Card P1 shown' }]);
  const seenByTurn = loadHistory(db, 7);
  noteFor(db)(7, '(Picture #1 was made and sent: a fox)');           // lands during the turn
  appendHistory(db, 7, [{ role: 'user', content: 'make it night' }, { role: 'assistant', content: 'Card P2 shown' }]);
  const h = loadHistory(db, 7);
  assert.equal(seenByTurn.length, 2);
  assert.ok(h.some((m) => m.content.includes('Picture #1 was made')));
  assert.equal(h.at(-1).content, 'Card P2 shown');
});

test('history is sent well-formed: starts with the user, alternates, is trimmed', () => {
  const msgs = [
    { role: 'assistant', content: '(Picture #1 was made)' },
    { role: 'user', content: 'a' }, { role: 'user', content: 'b' },
    { role: 'assistant', content: 'c' }, { role: 'assistant', content: '(record)' },
    { role: 'user', content: 'd' }, { role: 'tool', content: 'x' }, { role: 'user', content: '' },
  ];
  const n = normalizeHistory(msgs);
  assert.deepEqual(n.map((m) => m.role), ['user', 'assistant', 'user']);
  assert.equal(n[0].content, 'a\n\nb');
  assert.equal(n[1].content, 'c\n\n(record)');
  const long = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: `m${i}` }));
  const t = normalizeHistory(long, 24);
  assert.ok(t.length <= 24);
  assert.equal(t[0].role, 'user');
});

test('the free chat has limits: per hour per user, and a daily budget only for people with no balance', () => {
  const db = freshDb({ chats: [7, 8] });
  for (let i = 0; i < 3; i++) assert.equal(chatGate(db, 7, { perHour: 3, dailyBudget: 100, balanceMicro: 0 }).ok, true);
  assert.match(chatGate(db, 7, { perHour: 3, dailyBudget: 100, balanceMicro: 0 }).refuse, /3 messages this hour/);
  assert.match(chatGate(db, 8, { perHour: 99, dailyBudget: 3, balanceMicro: 0 }).refuse, /resting for today/);
  assert.equal(chatGate(db, 8, { perHour: 99, dailyBudget: 3, balanceMicro: 5 }).ok, true, 'a paying user still chats');
  assert.match(chatGate(db, 8, { perHour: 99, dailyBudget: 999, balanceMicro: 5, rateRemaining: 2, rlFloor: 30 }).refuse, /busy/);
});

test('the system prompt lists the user\'s items, the open card and the live prices', () => {
  const db = freshDb();
  const photo = addItem(db, { kind: 'upload', summary: null });
  const pic = addItem(db, { kind: 'image', summary: 'cartoon cat astronaut' });
  const s = systemPrompt({
    items: db.prepare('SELECT * FROM items ORDER BY id DESC').all(),
    openCard: { id: 4, kind: 'image', shape: 'wide', summary: 'A cat', price_micro: 270000 },
    prices: priceLines(OFFER, SETTINGS, MARGIN_E6),
    balanceMicro: 1830000n,
  });
  assert.match(s, new RegExp(`#${pic} — picture — just now — "cartoon cat astronaut"`));
  assert.match(s, new RegExp(`#${photo} — the user's photo`));
  assert.match(s, /OPEN CARD P4: picture, wide — "A cat" — \$0\.27/);
  assert.match(s, /a 5-second video costs \$2\.52 \(3–15 seconds possible, \$0\.504 per second; 720P/);
  assert.match(s, /balance is \$1\.83/);
  assert.match(s, /only make pictures and videos|only help with that/);
});

test('settings refuse what cannot be served', () => {
  const ok = settingsProblems(DEFAULT_SETTINGS, { offer: OFFER, chatChoices: ['mimo-v2.5'] });
  assert.deepEqual(ok, []);
  const bad = settingsProblems({ ...DEFAULT_SETTINGS, chatModel: 'gpt-9', pictureModel: 'gpt-image-2', videoResolution: '4K', videoSeconds: 40, videoEditModel: 'x' },
    { offer: OFFER, chatChoices: ['mimo-v2.5'] });
  assert.equal(bad.length, 5, bad.join(' | '));
  const db = freshDb();
  assert.equal(getSettings(db).pictureModel, 'wan2.7-image-pro', 'defaults with nothing stored');
  saveSettings(db, { ...DEFAULT_SETTINGS, pictureModel: 'qwen-image-3.0-pro', junk: 1 });
  assert.equal(getSettings(db).pictureModel, 'qwen-image-3.0-pro');
  assert.equal(getSettings(db).junk, undefined);
});

test('a chat model is accepted only if it calls the tool', async () => {
  assert.deepEqual(await testChatModel(fakeOona([toolAnswer({ kind: 'image', prompt: 'apple', summary: 'apple', shape: 'square' })]), 'mimo-v2.5'), { ok: true });
  assert.equal((await testChatModel(fakeOona([textAnswer('I cannot draw.')]), 'x')).ok, false);
  assert.equal((await testChatModel(fakeOona([new Error('HTTP 503')]), 'x')).ok, null);
});
