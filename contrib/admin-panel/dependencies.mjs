// /dependencies — every account, wallet, host and listing PCoin depends on.
//
// The register lives at /opt/pcoin-ops/dependencies.json on this host (master
// copy D:\pc.am\pcoin-dependencies.json) and was only visible in the old ops
// dashboard, which has a password and no second factor. It is shown here too
// so the unified admin is the one place to look. Read-only: the file is edited
// by hand and mirrored to D:, never from a web page.
//
// It holds POINTERS, not secrets ("sealed: ... on both vaults"), by design.
import { readFileSync } from 'node:fs';
import { esc, card, note, failed } from './ui.mjs';

const FILE = process.env.ADMIN_DEPENDENCIES || '/opt/pcoin-ops/dependencies.json';

export function loadDependencies() {
  try { return { ok: true, d: JSON.parse(readFileSync(FILE, 'utf8')) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

const link = (url, text) => (url && /^https?:\/\//.test(url)
  ? `<a href="${esc(url)}" target="_blank" rel="noopener">${esc(text)}</a>` : esc(text));

export function dependenciesPage(r) {
  if (!r.ok) return failed('the dependency register', r.error);
  const d = r.d || {};
  const secs = Array.isArray(d.sections) ? d.sections : [];
  const total = secs.reduce((a, s) => a + ((s.items || []).length), 0);
  return note(`${total} entries in ${secs.length} sections, last updated <b>${esc(d.updated || '?')}</b>. `
      + 'Pointers only: where a credential lives, never the credential. Edit the file on the server and mirror it to '
      + '<code>D:\\pc.am\\pcoin-dependencies.json</code>.')
    + secs.map((s) => card(s.title || 'Section',
      (s.note ? note(esc(s.note)) : '')
      + `<div style="overflow-x:auto"><table><tr><th>What</th><th>Account</th><th>Used for</th><th>Where the key lives</th><th>Notes</th></tr>`
      + (s.items || []).map((it) => `<tr><td><b>${link(it.url, it.name || '')}</b></td>
          <td><code>${esc(it.account || '')}</code></td><td>${esc(it.purpose || '')}</td>
          <td class="muted">${esc(it.credential || '')}</td><td class="muted">${esc(it.notes || '')}</td></tr>`).join('')
      + '</table></div>')).join('');
}
