// Search, filters, sorting and pagination for every list on the /exchange page.
//
// THE FILTERING HAPPENS ON THE EXCHANGE, not here. Every list used to be "the
// newest 300-500 rows"; filtering that in the page would search only what had
// been sent, and the moment a table outgrew its cap an old withdrawal would be
// unfindable while the page cheerfully said "no results". So this module only
// builds the query, forwards it to /admin/api/list/<name>, and renders one page
// of the answer -- search box, a dropdown per filter, a date range, sortable
// columns, and a pager. See lib/admin-lists.mjs in pcoin-exchange for the rest.
//
// No JavaScript: everything is a GET form and plain links, so it works with the
// panel exactly as it is and every state is a URL that can be bookmarked.
import { esc } from './ui.mjs';

// The only query keys ever forwarded to the exchange. Anything else in the
// panel's URL -- view, id, the flash -- stays here.
const LIST_KEYS = ['q', 'from', 'to', 'page', 'per', 'sort', 'dir'];
const isListKey = (k) => LIST_KEYS.includes(k) || /^f_[a-z_]{1,30}$/.test(k);

/** The list part of a URL, as a clean URLSearchParams. `defaults` apply only
 *  when the URL says nothing about the list at all -- so the withdrawals page
 *  opens on the open queue, while "Reset" (which sends reset=1) really shows
 *  everything instead of snapping back to the default. */
export function listParams(url, defaults = {}) {
  const src = url.searchParams;
  const out = new URLSearchParams();
  let said = src.has('reset');
  for (const [k, v] of src) {
    if (!isListKey(k)) continue;
    said = true;
    if (v !== '') out.set(k, String(v).slice(0, 200));
  }
  if (!said) for (const [k, v] of Object.entries(defaults)) out.set(k, v);
  return out;
}

/** Keep only list keys from a query string -- used to carry a list's state
 *  through a POST so an action lands back on the same filtered page. */
export function cleanListQs(qs) {
  const out = new URLSearchParams();
  try {
    for (const [k, v] of new URLSearchParams(String(qs || ''))) if (isListKey(k) && v !== '') out.set(k, v.slice(0, 200));
  } catch { /* a malformed ret is simply dropped */ }
  return out;
}

// Coloured status pill. Unknown statuses render plain rather than guessing.
const TONE = {
  good: ['paid', 'credited', 'filled', 'finished', 'active', 'sent', 'clean', 'confirmed', 'transfer', 'users only'],
  warn: ['requested', 'approved', 'paid_unverified', 'seen', 'open', 'partial', 'holding', 'waiting', 'partially_paid',
    'pending', 'confirming', 'qualified', 'not credited', 'house bot', 'mined'],
  bad: ['rejected', 'failed', 'held', 'disabled', 'refused', 'suspect', 'expired', 'orphaned', 'cancelled'],
};
export function pill(v) {
  const s = String(v ?? '');
  const tone = Object.keys(TONE).find((t) => TONE[t].includes(s));
  return `<span class="xpill${tone ? ` ${tone}` : ''}">${esc(s.replace(/_/g, ' '))}</span>`;
}

export function makeLister({ self, call, unknown }) {
  return async function listPage(url, spec) {
    const base = new URLSearchParams({ view: spec.view });
    if (spec.sub) base.set(spec.sub.name, spec.sub.value);
    const qs = listParams(url, spec.defaults || {});
    const r = await call('GET', `/admin/api/list/${spec.list}?${qs}`);
    if (!r.readable || r.status !== 200 || !r.json || !Array.isArray(r.json.rows)) {
      return { html: unknown(spec.title || spec.list, r), data: null, qs };
    }
    const d = r.json;

    // A link to this list with some keys changed. Changing anything but the
    // page goes back to page 1, or a narrower filter could land past the end.
    const link = (changes, { keepPage = false } = {}) => {
      const p = new URLSearchParams(base);
      for (const [k, v] of qs) p.set(k, v);
      if (!keepPage) p.delete('page');
      for (const [k, v] of Object.entries(changes)) {
        if (v === null || v === undefined || v === '') p.delete(k); else p.set(k, String(v));
      }
      // An explicitly EMPTY list keeps the defaults from reappearing.
      if (![...p.keys()].some(isListKey)) p.set('reset', '1');
      return `${self}?${p.toString().replace(/&/g, '&amp;')}`;
    };

    // ---- the filter bar --------------------------------------------------
    const hid = (n, v) => `<input type="hidden" name="${esc(n)}" value="${esc(v)}">`;
    const virtualLabel = spec.virtualLabels || {};
    const selects = Object.entries(d.facets || {}).map(([name, f]) => {
      const cur = d.applied.filters[name] ?? '';
      const opts = [
        `<option value="">Any ${esc(f.label)}</option>`,
        ...(f.virtual || []).map((v) => `<option value="${esc(v)}"${cur === v ? ' selected' : ''}>${esc(virtualLabel[v] || v)}</option>`),
        ...f.values.map((v) => `<option value="${esc(v.value)}"${cur === v.value ? ' selected' : ''}>${esc(v.value || '(empty)')} (${v.count})</option>`),
      ];
      return `<select name="f_${esc(name)}" title="${esc(f.label)}">${opts.join('')}</select>`;
    }).join('');
    // SORT AS ITS OWN CONTROL, with the direction separate. Clicking a header
    // works too, but only tells you the order after you have clicked it, and a
    // column you cannot see (balances were the owner's example) is not
    // discoverable at all. Labels come from the columns, so a list that gains a
    // sortable column gains the option here with no extra wiring.
    const sortNames = [];
    for (const c of spec.columns) {
      if (c.sort && d.sortable.includes(c.sort) && !sortNames.some((x) => x.key === c.sort)) {
        sortNames.push({ key: c.sort, label: c.label });
      }
    }
    for (const k of d.sortable) if (!sortNames.some((x) => x.key === k)) sortNames.push({ key: k, label: k });
    const sortSel = `<label>sort by <select name="sort">${sortNames.map((o) =>
      `<option value="${esc(o.key)}"${o.key === d.sort ? ' selected' : ''}>${esc(o.label)}</option>`).join('')}</select></label>
      <select name="dir" title="direction">
        <option value="desc"${d.dir === 'desc' ? ' selected' : ''}>▼ highest / newest first</option>
        <option value="asc"${d.dir === 'asc' ? ' selected' : ''}>▲ lowest / oldest first</option>
      </select>`;
    const perSel = `<select name="per" title="rows per page">${(d.perAllowed || [25, 50, 100]).map((n) =>
      `<option value="${n}"${n === d.per ? ' selected' : ''}>${n} / page</option>`).join('')}</select>`;
    const filterBar = `<div class="card"><form method="GET" action="${self}" class="xfilters">
      ${hid('view', spec.view)}${spec.sub ? hid(spec.sub.name, spec.sub.value) : ''}
      <input type="search" name="q" value="${esc(d.applied.q)}" placeholder="${esc(spec.searchHint || 'Search…')}">
      ${selects}
      <label>${esc(spec.dateLabel || 'from')} <input type="date" name="from" value="${esc(d.applied.from || '')}"></label>
      <label>to <input type="date" name="to" value="${esc(d.applied.to || '')}"></label>
      ${sortSel}
      ${perSel}
      <span style="display:flex;gap:4px;align-items:center"><button type="submit">Filter</button>
      <a class="reset" href="${self}?${base.toString().replace(/&/g, '&amp;')}&amp;reset=1" title="clear every filter, including the default one">Reset</a></span>
    </form>${chips()}</div>`;

    function chips() {
      const c = [];
      if (d.applied.q) c.push(`<a class="xchip" href="${link({ q: null })}" title="remove">search: <b>${esc(d.applied.q)}</b> ✕</a>`);
      for (const [name, v] of Object.entries(d.applied.filters)) {
        const lab = (d.facets[name] && d.facets[name].label) || name;
        c.push(`<a class="xchip" href="${link({ [`f_${name}`]: null })}" title="remove">${esc(lab)}: <b>${esc(virtualLabel[v] || v)}</b> ✕</a>`);
      }
      if (d.applied.from) c.push(`<a class="xchip" href="${link({ from: null })}">from <b>${esc(d.applied.from)}</b> ✕</a>`);
      if (d.applied.to) c.push(`<a class="xchip" href="${link({ to: null })}">to <b>${esc(d.applied.to)}</b> ✕</a>`);
      return c.length ? `<div class="xchips">${c.join('')}</div>` : '';
    }

    // ---- the table ---------------------------------------------------------
    const head = spec.columns.map((c) => {
      if (!c.sort || !d.sortable.includes(c.sort)) return `<th>${esc(c.label)}</th>`;
      const on = d.sort === c.sort;
      const nextDir = on && d.dir === 'desc' ? 'asc' : 'desc';
      return `<th><a class="xsort${on ? ' on' : ''}" href="${link({ sort: c.sort, dir: nextDir })}">${esc(c.label)}${on ? (d.dir === 'desc' ? ' ▼' : ' ▲') : ''}</a></th>`;
    }).join('');
    const body = d.rows.length
      ? d.rows.map(spec.row).join('')
      : `<tr><td colspan="${spec.columns.length}" class="muted" style="text-align:center;padding:28px">${
        d.total === 0 && !d.applied.q && !Object.keys(d.applied.filters).length && !d.applied.from && !d.applied.to
          ? esc(spec.empty || 'Nothing yet.') : 'Nothing matches these filters.'}</td></tr>`;

    // ---- summary and pager -------------------------------------------------
    const first = d.total ? (d.page - 1) * d.per + 1 : 0;
    const last = Math.min(d.page * d.per, d.total);
    const summary = `<span>${d.total ? `Showing <b>${first}–${last}</b> of <b>${d.total}</b>` : 'No rows'}${
      d.pages > 1 ? ` · page ${d.page} of ${d.pages}` : ''}</span>`;
    const pager = d.pages > 1 ? (() => {
      const pg = (n, label = String(n), cls = '') => n === d.page
        ? `<span class="cur">${esc(label)}</span>`
        : `<a class="${cls}" href="${link({ page: n }, { keepPage: true })}">${esc(label)}</a>`;
      const out = [];
      out.push(d.page > 1 ? pg(d.page - 1, '‹ Prev') : '<span class="off">‹ Prev</span>');
      const win = new Set([1, d.pages, d.page - 2, d.page - 1, d.page, d.page + 1, d.page + 2].filter((n) => n >= 1 && n <= d.pages));
      let prev = 0;
      for (const n of [...win].sort((a, b) => a - b)) {
        if (n - prev > 1) out.push('<span class="gap">…</span>');
        out.push(pg(n));
        prev = n;
      }
      out.push(d.page < d.pages ? pg(d.page + 1, 'Next ›') : '<span class="off">Next ›</span>');
      return `<div class="xpager">${out.join('')}</div>`;
    })() : '';

    const table = `<div class="xsummary">${summary}${pager}</div>
      <div class="card" style="padding:0;overflow-x:auto"><table><tr>${head}</tr>${body}</table></div>
      ${pager ? `<div class="xsummary"><span></span>${pager}</div>` : ''}`;

    return { html: filterBar + table, data: d, qs };
  };
}
