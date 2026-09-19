// /keeper - the wPCN price keeper: what it is doing, and every knob it has.
//
// WHY THIS PAGE EXISTS. The keeper's settings used to live only in its systemd
// unit's Environment= lines. Changing one meant an SSH session and a
// daemon-reload, so the owner could not; and running the script by hand gave a
// DIFFERENT PROGRAM, because a bare run inherits none of them. That second
// failure has already cost this project a day (CLAUDE.md 7.14).
//
// THE SCHEMA IS NOT DEFINED HERE, DELIBERATELY. Bounds, defaults, env-var names
// and the one-line meaning of each knob are read from the file the KEEPER
// writes after every run. Copying them into this page would create two
// definitions of the same rule, and the day they disagree the panel would show
// a bound the keeper does not enforce. So the keeper is the schema and this
// page is only a view of it. The consequence is honest: before the keeper has
// run once, this page says so rather than inventing a form.
//
// WHAT IT SHOWS THAT A CONFIG FILE CANNOT. Two columns: what is SET here, and
// what the keeper ACTUALLY USED on its last run, with the source of each value
// -- panel, unit, or built-in default. Drift between them is then visible
// instead of assumed, which is the whole lesson of the pc.am/dl copies.
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { esc, card, note, tiles, kv, tbl, N, USD, PCT, DASH, agoEpoch, failed } from './ui.mjs';

export const TUNING_FILE = process.env.KEEPER_TUNING
  || '/etc/pcoin/control/keeper-tuning.json';
const EFFECTIVE_FILE = process.env.KEEPER_EFFECTIVE
  || '/var/lib/pcoin-wrapdesk/keeper-effective.json';
const STATE_FILE = process.env.KEEPER_STATE
  || '/var/lib/pcoin-wrapdesk/keeper.json';

const readJson = (p) => {
  // Three outcomes, never two: absent, unreadable, and read. Collapsing the
  // first two is how a panel draws a confident zero over a broken file.
  if (!existsSync(p)) return { state: 'absent' };
  try { return { state: 'ok', data: JSON.parse(readFileSync(p, 'utf8')) }; }
  catch (e) { return { state: 'error', error: e.message }; }
};

export function keeperData() {
  return {
    tuning: readJson(TUNING_FILE),
    eff: readJson(EFFECTIVE_FILE),
    st: readJson(STATE_FILE),
  };
}

// Validate a posted form against the KEEPER's own bounds. Returns
// { values, errors }. Nothing is written unless errors is empty -- a partial
// write would leave the keeper running half of what was intended.
export function validate(form, schema) {
  const values = {}, errors = [];
  for (const key of Object.keys(schema.bounds || {})) {
    const raw = String(form.get(key) ?? '').trim();
    const isBool = schema.values && typeof schema.values[key] === 'boolean';
    if (raw === '') { errors.push(`${key}: empty`); continue; }
    if (isBool) {
      if (raw !== 'on' && raw !== 'off') { errors.push(`${key}: must be on or off`); continue; }
      values[key] = raw === 'on';
      continue;
    }
    const v = Number(raw);
    if (!Number.isFinite(v)) { errors.push(`${key}: "${raw}" is not a number`); continue; }
    const [lo, hi] = schema.bounds[key];
    if (lo !== null && hi !== null && (v < lo || v > hi)) {
      errors.push(`${key}: ${v} is outside ${lo} to ${hi}`); continue;
    }
    values[key] = v;
  }
  return { values, errors };
}

export function writeTuning(values, who) {
  const body = {
    _note: 'Written by the PCoin admin panel. The keeper reads this on every run '
         + 'and refuses to trade if it is unparsable or out of bounds -- it does NOT '
         + 'fall back to defaults. Bounds live in the keeper, not here. '
         + `Last written ${new Date().toISOString()}${who ? ' by ' + who : ''}.`,
    ...values,
  };
  mkdirSync(dirname(TUNING_FILE), { recursive: true });
  const tmp = TUNING_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(body, null, 1));
  renameSync(tmp, TUNING_FILE);       // atomic: a torn config would stop the keeper
}

const srcPill = (s) => {
  const colour = s === 'panel' ? 'green' : s === 'unit' ? 'yellow' : 'muted';
  const label = s === 'panel' ? 'this page' : s === 'unit' ? 'unit file' : s;
  return `<span style="font-size:11px;padding:2px 8px;border-radius:999px;`
       + `background:var(--panel-2);color:var(--${colour === 'muted' ? 'fg' : colour})">`
       + `${esc(label)}</span>`;
};

export function keeperPage(d, flash, flashBad) {
  const out = [];
  out.push('<h1>wPCN price keeper</h1>');
  out.push('<p class="muted">The bot that holds the PancakeSwap wPCN price against the '
    + 'PCN ladder ask. It runs on a timer every 10 minutes, compares the two prices, and '
    + 'trades only if the gap is bigger than the dead band below.</p>');

  if (flash) out.push(`<div class="card" style="border-left:4px solid var(--${flashBad ? 'red' : 'green'})"><p>${esc(flash)}</p></div>`);

  if (d.eff.state !== 'ok') {
    out.push(d.eff.state === 'absent'
      ? card('The keeper has not run yet',
          note('This page reads its settings, bounds and meanings from the file the keeper '
             + 'writes after each run, so that the panel can never show a rule the keeper '
             + 'does not enforce. That file does not exist yet. Run the keeper once '
             + '<code>systemctl start pcoin-wpcn-keeper</code> and reload this page.'))
      : failed('The keeper’s last-run file', d.eff.error));
    return out.join('');
  }

  const e = d.eff.data;
  const V = e.values || {}, S = e.sources || {}, B = e.bounds || {}, D = e.docs || {}, EV = e.env_var || {};

  if (e.error) {
    out.push(card('THE KEEPER IS REFUSING TO TRADE',
      `<p class="bad"><b>${esc(e.error)}</b></p>`
      + note('It has NOT fallen back to defaults, on purpose: a bot that moves money '
           + 'running on settings nobody chose is worse than one standing still. Correct '
           + 'the values below and save, and it will resume on its next run.')));
  }

  // ---- what it is doing right now -----------------------------------------
  const pool = e.pool_price, target = e.target_price;
  const gap = (typeof pool === 'number' && typeof target === 'number' && target > 0)
    ? (pool / target - 1) * 100 : null;
  const band = (V.dead_band ?? 0) * 100;
  out.push(tiles([
    ['Pool price', typeof pool === 'number' ? '$' + pool.toFixed(8) : DASH],
    ['Target', typeof target === 'number' ? '$' + target.toFixed(8) : DASH],
    ['Gap', gap === null ? DASH : PCT(gap),
      gap === null ? null : (Math.abs(gap) < band ? 'green' : 'yellow')],
    ['Acts above', PCT(band)],
    ['Last run', agoEpoch(e.at)],
  ]));

  if (gap !== null) {
    out.push(card('Is it going to trade?',
      Math.abs(gap) < band
        ? `<p class="ok">No. The gap is ${PCT(Math.abs(gap))}, inside the ${PCT(band)} dead `
          + 'band, so the next run will do nothing.</p>'
        : `<p>Yes. The gap is ${PCT(Math.abs(gap))}, wider than the ${PCT(band)} dead band, `
          + `so the next run will ${gap > 0 ? 'SELL wPCN to push the price down'
             : 'BUY wPCN to push the price up'}, up to its daily cap.</p>`));
  }

  // ---- the knobs -----------------------------------------------------------
  const rows = Object.keys(B).map((k) => {
    const isBool = typeof V[k] === 'boolean';
    const [lo, hi] = B[k] || [null, null];
    const input = isBool
      ? `<select name="${esc(k)}">`
        + `<option value="on"${V[k] ? ' selected' : ''}>on</option>`
        + `<option value="off"${V[k] ? '' : ' selected'}>off</option></select>`
      : `<input name="${esc(k)}" value="${esc(String(V[k]))}" inputmode="decimal" `
        + `style="width:9em" autocomplete="off">`;
    return [
      `<code>${esc(k)}</code>`,
      input,
      isBool ? 'on / off' : `${esc(String(lo))} to ${esc(String(hi))}`,
      srcPill(S[k] || '?'),
      `<span class="muted" style="font-size:12px">${esc(D[k] || '')}</span>`,
    ];
  });

  out.push(card('Settings',
    '<form method="post">'
    + tbl(['setting', 'value', 'allowed', 'now from', 'what it does'], rows)
    + '<p style="margin-top:12px"><button style="background:var(--green);color:#0b1020;'
    + 'border:0;border-radius:999px;padding:8px 22px;cursor:pointer;font-weight:700">'
    + 'Save settings</button></p></form>'
    + note('Saving writes all of them to <code>' + esc(TUNING_FILE) + '</code>, which the '
         + 'keeper reads on its next run. No restart. The bounds shown are the keeper’s '
         + 'own and it re-checks them itself, so a value this page would accept but the '
         + 'keeper would not cannot exist.')));

  const fromUnit = Object.keys(S).filter((k) => S[k] === 'unit');
  if (fromUnit.length) {
    out.push(card('Some values still come from the unit file',
      '<p>' + fromUnit.map((k) => `<code>${esc(k)}</code> (<code>${esc(EV[k] || '')}</code>)`).join(', ') + '</p>'
      + note('These are set as <code>Environment=</code> lines in the service and this page '
           + 'is not yet the source of truth for them. Pressing Save once moves every '
           + 'setting here, after which the unit’s lines stay only as a fallback if '
           + 'this file is ever lost.')));
  }

  // ---- what it has actually done ------------------------------------------
  if (d.st.state === 'ok') {
    const s = d.st.data || {}, trades = Array.isArray(s.trades) ? s.trades : [];
    const recent = trades.slice(-10).reverse().map((t) => [
      esc(new Date((t.at || 0) * 1000).toISOString().replace('T', ' ').slice(0, 16)) + ' <span class="muted">UTC</span>',
      t.dir === 'buy' ? '<span class="ok">bought wPCN</span>' : 'sold wPCN',
      `${N(t.amount, 4)} ${esc(t.unit || '')}`,
      typeof t.pool_before === 'number' ? '$' + t.pool_before.toFixed(8) : DASH,
      typeof t.posted === 'number' ? '$' + t.posted.toFixed(8) : DASH,
    ]);
    out.push(card('Recent trades',
      tbl(['when', 'direction', 'size', 'pool before', 'target'], recent,
          'It has never traded.')
      + kv([
          ['Trades ever', N(trades.length, 0)],
          ['Spent today', USD(s.usdt_spent) + ' of ' + USD(V.daily_usdt_cap) + ' cap'],
          ['Sold today', N(s.wpcn_spent) + ' of ' + N(V.daily_wpcn_cap) + ' wPCN cap'],
          ['Cap day', esc(s.day || '')],
        ])));
  } else if (d.st.state === 'error') {
    out.push(failed('The keeper’s trade log', d.st.error));
  }

  out.push(card('Why it does not trade every ten minutes',
    '<p>It trades the pool <b>to</b> the target, so straight after a trade the gap is zero '
    + 'and the next run does nothing. It only acts again once somebody else has moved the '
    + 'price by more than the dead band. Over its first nineteen days it traded nineteen '
    + 'times, not once per cycle.</p>'
    + note('Raising the dead band means fewer and larger trades, each with a wider margin, '
         + 'and a looser peg: the pool may sit that far from the PCN price before anything '
         + 'happens. It is not the fee that decides this. The keeper always trades toward '
         + 'the target, so it sells above it and buys below it, and it earns roughly half '
         + 'the gap while paying 0.25% to PancakeSwap. Anything above about a 0.5% gap is '
         + 'already profitable; the dead band is about restraint and gas, not about losing '
         + 'money on fees.')));

  return out.join('');
}
