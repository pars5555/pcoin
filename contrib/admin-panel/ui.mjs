// The panel's shared rendering vocabulary.
//
// It was duplicated across detail.mjs and would have been duplicated twice more
// by the pages added after it. One copy means one place where "unknown renders
// as an em-dash, never as a zero" is enforced, which is the rule most of these
// helpers exist to keep.
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const DASH = '<span class="muted">&mdash;</span>';
export const T = v => (v === null || v === undefined || v === '') ? DASH : esc(v);
export const num = (x, d = 2) => (typeof x === 'number' && isFinite(x))
  ? x.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d }) : null;
export const N = (x, d = 2) => { const v = num(x, d); return v === null ? DASH : esc(v); };
export const USD = (x, d = 2) => { const v = num(x, d); return v === null ? DASH : '$' + esc(v); };
export const PCT = (x, d = 2) => { const v = num(x, d); return v === null ? DASH : esc(v) + '%'; };
export const YN = (b, yes = 'yes', no = 'no') => (b === undefined || b === null) ? DASH
  : b ? `<span class="ok">${yes}</span>` : `<span class="muted">${no}</span>`;

export const when = s => s ? esc(String(s).replace('T', ' ').replace(/\.\d+Z?$/, '').slice(0, 19)) +
  ' <span class="muted">UTC</span>' : DASH;

// Durations render in the largest two units that are not zero. A raw "45056 s"
// makes the reader do arithmetic before they can tell whether it is a problem.
export const dur = s => {
  if (typeof s !== 'number' || !isFinite(s)) return DASH;
  const neg = s < 0; s = Math.abs(s);
  const d = Math.floor(s / 86400), h = Math.floor(s % 86400 / 3600),
        m = Math.floor(s % 3600 / 60), sec = Math.floor(s % 60);
  const out = d ? `${d} d ${h} h` : h ? `${h} h ${m} min`
            : m ? `${m} min ${sec} s` : `${sec} s`;
  return neg ? 'in ' + out : out;
};
export const agoIso = iso => {
  if (!iso) return DASH;
  const t = Date.parse(iso);
  if (!isFinite(t)) return DASH;
  const secs = (Date.now() - t) / 1000;
  return secs < 0 ? 'in ' + dur(-secs) : dur(secs) + ' ago';
};
export const agoEpoch = e => (typeof e === 'number' && isFinite(e))
  ? dur(Date.now() / 1000 - e) + ' ago' : DASH;

export const hash = h => {
  if (typeof h !== 'number' || !isFinite(h)) return DASH;
  return h >= 1e9 ? N(h / 1e9, 2) + ' GH/s' : h >= 1e6 ? N(h / 1e6, 2) + ' MH/s'
       : h >= 1e3 ? N(h / 1e3, 1) + ' kH/s' : N(h, 0) + ' H/s';
};

// Full value in the tooltip, short value on the page. Addresses are 42+ characters
// and a column of them is unreadable; the title attribute keeps them copyable.
export const addr = a => a ? `<code title="${esc(a)}">${esc(String(a).length > 26
  ? String(a).slice(0, 12) + '…' + String(a).slice(-8) : a)}</code>` : DASH;

export const card = (title, inner) => `<div class="card"><h2>${esc(title)}</h2>${inner}</div>`;
export const note = t => `<p class="muted">${t}</p>`;

export const kv = rows => `<table>${rows.filter(Boolean).map(([k, v, n2]) =>
  `<tr><td style="width:32%">${esc(k)}</td><td><b>${v}</b></td>` +
  `<td class="muted">${n2 || ''}</td></tr>`).join('')}</table>`;

export const tbl = (heads, rows, empty = 'Nothing to show.') => rows.length
  ? `<div style="overflow-x:auto"><table><tr>${heads.map(h => `<th>${esc(h)}</th>`).join('')}</tr>` +
    rows.map(r => `<tr>${r.map(c => `<td>${c}</td>`).join('')}</tr>`).join('') + '</table></div>'
  : `<p class="muted">${esc(empty)}</p>`;

export const tiles = items => `<div class="stats-grid" style="margin-bottom:16px">` +
  items.filter(Boolean).map(([label, value, colour]) =>
    `<div class="stat-box"><div class="label">${esc(label)}</div>` +
    `<div class="value"${colour ? ` style="color:var(--${colour})"` : ''}>${value}</div></div>`
  ).join('') + '</div>';

export const failed = (what, err) =>
  card(what + ' — unreadable',
    `<p class="bad">${esc(err || 'no reason given')}</p>` +
    note('This is shown as an error rather than as zeroes. "The number is nought" and ' +
         '"I could not look" must never render as the same pixel.'));
