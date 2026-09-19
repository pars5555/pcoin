// /wrapdesk - is the wrap desk taking new requests, and one switch to change it.
//
// The panel and the wrap desk run on the SAME host, so this writes the switch
// file directly. No SSH key, no second credential, no new service to trust --
// the panel gains the ability to flip one flag on one path and nothing else.
//
// WHAT THE SWITCH DOES AND DOES NOT DO, said on the page as well as here,
// because somebody will press it in six months without reading anything:
// closing stops NEW wrap requests. Wraps already in flight keep counting
// confirmations and are still paid. Closing the door and repudiating a debt are
// different acts and only one of them has ever been announced.
//
// The state shown is READ FROM THE FILE the desk itself reads, every render --
// never remembered, never cached. A control that reports its own intention
// rather than the world is the failure mode this whole panel exists to avoid.
import { existsSync, readFileSync } from 'node:fs';
import { esc, card, note, tiles } from './ui.mjs';

// The flag this panel OWNS and can actually write.
//
// It was /etc/pcoin/wrapdesk-closed until 2026-09-19, and that is why the
// button on this page had never once worked: the panel runs
// ProtectSystem=strict, so /etc/pcoin is read-only to it and every press
// returned "could not change it". It failed honestly rather than lying, but it
// failed. /etc/pcoin/control is granted to the panel because it holds no
// secrets -- /etc/pcoin holds the keeper's private key and the desk's SSO
// secret and must never be writable from a web page.
export const CLOSED_FILE = '/etc/pcoin/control/wrapdesk-closed';

// Every path the DESK treats as closing it, in the desk's own order. The panel
// can only remove the first; the rest are shown so that a flag it cannot clear
// is never mistaken for one it has.
export const LEGACY_CLOSED_FILES = ['/etc/pcoin/wrapdesk-closed'];
const ALL_CLOSED_FILES = [CLOSED_FILE, ...LEGACY_CLOSED_FILES];

export function wrapdeskState() {
  // Unreadable is NOT open. If this cannot be determined, say so rather than
  // drawing a green light -- "I could not look" and "it is running" must never
  // render the same, and here the difference is whether money can arrive.
  const hits = [];
  for (const path of ALL_CLOSED_FILES) {
    try {
      if (!existsSync(path)) continue;
      let body = '';
      try { body = readFileSync(path, 'utf8'); }
      catch (e) { body = `(exists but could not be read: ${e.message})`; }
      hits.push({ path, note: body });
    } catch (e) {
      return { open: null, note: '', error: `${path}: ${e.message}`, hits: [] };
    }
  }
  return {
    open: hits.length === 0,
    note: hits.map((h) => h.note).join(String.fromCharCode(10)),
    hits,
    // A flag the desk honours but this page cannot delete. Reopening will not
    // work while one of these is present, and saying so beats a button that
    // reports success and changes nothing.
    stuck: hits.filter((h) => h.path !== CLOSED_FILE).map((h) => h.path),
  };
}

export function wrapdeskPage(st, flash) {
  const pill = (txt, colour) =>
    `<span style="display:inline-block;padding:4px 12px;border-radius:999px;` +
    `font-weight:700;font-size:12px;letter-spacing:.5px;` +
    `background:var(--${colour});color:#0b1020">${esc(txt)}</span>`;

  let statusPill, button, explain;
  if (st.open === null) {
    statusPill = pill('UNKNOWN', 'yellow');
    button = '';
    explain = 'The switch file could not be read, so the real state is unknown. '
      + 'No button is offered rather than one that might do the opposite of what '
      + 'it says. ' + (st.error ? esc(st.error) : '');
  } else if (st.open) {
    statusPill = pill('OPEN', 'green');
    button = '<form method="post" style="display:inline">'
      + '<input type="hidden" name="action" value="close">'
      + '<button style="background:var(--red);color:#0b1020;border:0;border-radius:999px;'
      + 'padding:8px 20px;cursor:pointer;font-weight:700">Close the desk</button></form>';
    explain = 'New wrap requests are being accepted.';
  } else {
    statusPill = pill('CLOSED', 'red');
    button = '<form method="post" style="display:inline">'
      + '<input type="hidden" name="action" value="open">'
      + '<button style="background:var(--green);color:#0b1020;border:0;border-radius:999px;'
      + 'padding:8px 20px;cursor:pointer;font-weight:700">Reopen the desk</button></form>';
    explain = 'New wrap requests are refused with HTTP 503 and an explanation. '
      + 'Wraps already in flight are unaffected.';
    if (st.stuck && st.stuck.length) {
      button = '';
      explain += ' <b>Reopening is not offered here</b>, because the desk is also held '
        + 'closed by ' + st.stuck.map((p) => `<code>${esc(p)}</code>`).join(', ')
        + ', which this panel cannot delete. Remove it on the host first. A button that '
        + 'reported success and left the desk closed would be worse than no button.';
    }
  }

  return '<h1>Wrap desk</h1>'
    + '<p class="muted">Whether wrapdesk.pc.am is taking new requests.</p>'
    + (flash ? `<div class="card" style="border-left:4px solid var(--blue)"><p>${esc(flash)}</p></div>` : '')
    + tiles([
        ['Intake', st.open === null ? 'unknown' : (st.open ? 'open' : 'closed'),
         st.open === null ? 'yellow' : (st.open ? 'green' : 'red')],
      ])
    + card('Switch',
        '<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap">'
        + button + statusPill + '</div>'
        + '<p class="muted" style="margin-top:10px">' + explain + '</p>'
        + '<p class="muted">Takes effect on the next request &mdash; the desk reads this '
        + 'per request, so there is no restart and nobody mid-request is interrupted.</p>'
        + '<p class="muted">This page writes <code>' + esc(CLOSED_FILE) + '</code>. The desk '
        + 'is closed if that file <b>or</b> any older flag exists, so a flag created by hand '
        + 'from an out-of-date runbook still shuts the desk.</p>')
    + (st.note
        ? card('Why it was closed',
            `<pre style="white-space:pre-wrap;background:var(--panel-2);padding:12px;`
            + `border-radius:4px;font-size:12px">${esc(st.note)}</pre>`)
        : '')
    + card('What closing does, and does not do',
        '<p><b>It stops new wrap requests.</b> That is all it stops.</p>'
        + note('Wraps already in flight keep counting confirmations and are still paid. '
             + 'Closing the door and repudiating a debt are different acts, and only the '
             + 'first one has ever been announced. If you reopen this, reopen it because '
             + 'the allocation and the PancakeSwap depth can carry it &mdash; the closure '
             + 'on 2026-09-13 was because they could not.'));
}
