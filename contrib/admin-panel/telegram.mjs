// The Telegram estate: every channel, group and bot PCoin depends on.
//
// WHY IT IS A FILE AND NOT A LIVE READ. The obvious way to build this page is to
// ask Telegram. We may not: `getUpdates` is exclusive, and on this estate
// `pcoin-group-watch` is the only permitted consumer of it -- a second caller
// steals updates and each sees half a conversation. So this page is a written
// record, edited by hand at /opt/pcoin-admin/telegram.json, and it says when it
// was last checked rather than pretending to be live.
//
// The chat ids matter more than the handles. Sending operational text to the
// PUBLIC channel has happened once on this project -- subscribers received
// `status=3/NOTIMPLEMENTED` and an internal hostname -- so each row carries the
// rule that governs it, not just its address.
import { readFileSync, existsSync } from 'node:fs';
import { esc, card, kv, tbl, note, T, tiles, DASH } from './ui.mjs';

const FILE = process.env.ADMIN_TELEGRAM || '/opt/pcoin-admin/telegram.json';

const load = () => {
  try {
    if (!existsSync(FILE)) return { error: 'telegram.json is not present on this host' };
    return JSON.parse(readFileSync(FILE, 'utf8'));
  } catch (e) { return { error: e.message }; }
};

const KIND_COLOUR = {
  'public channel': 'ok',
  'public group': 'ok',
  'private channel': 'warn',
  'direct message': 'muted',
};

export function telegramPage() {
  const d = load();
  if (d.error) {
    return card('Telegram — unreadable',
      `<p class="bad">${esc(d.error)}</p>` +
      note('Shown as an error rather than as an empty directory. "There are no channels" ' +
           'and "I could not read the file" must not look the same.'));
  }
  const chans = d.channels || [], bots = d.bots || [];

  return tiles([
    ['Channels & groups', String(chans.length)],
    ['Bots', String(bots.length)],
    ['Public surfaces', String(chans.filter(c => String(c.kind || '').startsWith('public')).length)],
    ['Last checked', esc(d.updated || 'unknown')],
  ]) +

  card('Channels and groups',
    tbl(['Handle', 'Chat id', 'Kind', 'What it is for', 'Who posts to it'],
      chans.map(c => [
        c.url ? `<a href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.handle)}</a>`
              : `<b>${esc(c.handle)}</b>`,
        `<code>${esc(c.id)}</code>`,
        `<span class="${KIND_COLOUR[c.kind] || 'muted'}">${esc(c.kind)}</span>`,
        esc(c.purpose || ''),
        `<span class="muted">${esc(c.posted_by || '')}</span>`])) +
    '<div style="margin-top:14px">' +
    chans.filter(c => c.rules).map(c =>
      `<p><b>${esc(c.handle)}</b> &mdash; <span class="muted">${esc(c.rules)}</span></p>`).join('') +
    '</div>') +

  card('Bots',
    tbl(['Handle', 'What it is', 'Where it runs', 'Code'],
      bots.map(b => [
        b.handle && b.handle.startsWith('@')
          ? `<a href="https://t.me/${esc(b.handle.slice(1))}" target="_blank" rel="noopener">${esc(b.handle)}</a>`
          : `<span class="warn">${esc(b.handle || 'unrecorded')}</span>`,
        esc(b.what || ''),
        `<span class="muted">${esc(b.runs || '')}</span>`,
        b.code ? `<code>${esc(b.code)}</code>` : DASH])) +
    '<div style="margin-top:14px">' +
    bots.filter(b => b.owner).map(b =>
      `<p class="muted"><b>${esc(b.handle)}</b> &mdash; ${esc(b.owner)}</p>`).join('') +
    '</div>') +

  card('The rules that govern these', `
    <p><b>One poller only.</b> <code>getUpdates</code> is exclusive: two consumers steal each
    other's updates and each sees half a conversation. <code>pcoin-group-watch</code> on
    178.105.178.27 is the only permitted consumer on this estate, and a 409 from Telegram
    means somebody started a second one.</p>
    <p><b>Alerts and announcements are different acts.</b> Operational text goes to the private
    ops channel and must never reach <a href="https://t.me/PCoinPCN" target="_blank"
    rel="noopener">@PCoinPCN</a>. That mistake has been made once: subscribers received
    <code>status=3/NOTIMPLEMENTED</code> and an internal hostname.</p>
    <p><b>No announcement without a picture, and none before the owner has seen the real
    thing.</b> An announcement is a card image with the text under it, DMed to the owner for an
    explicit yes first — the actual photo and the actual words, not a description of them.</p>
    <p><b>Moderation is gentle.</b> Warn, then delete. Nobody is banned from the group without
    asking the owner first.</p>`) +

  card('How to read this page', note(
    'This is a written record, not a live read, for the reason at the top of ' +
    '<code>telegram.mjs</code>: asking Telegram would mean a second consumer of an exclusive ' +
    'API. Edit <code>/opt/pcoin-admin/telegram.json</code> and bump its <code>updated</code> ' +
    'field when anything changes.'));
}
