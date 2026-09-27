// Every figure on market.pc.am's page, filled from live state by the server.
//
// WHY THIS EXISTS. index.html said "Orders up to $25 are sent automatically"
// while the live autoMaxUsd was 50 (found 2026-09-27). The page script replaced
// the sentence -- but only in a browser that ran the script AND whose
// /api/ladder/state call succeeded. Link previews, search engines and anyone
// without JavaScript read the number typed into the markup. So did the footer's
// wrap-desk terms ("250 PCN per person while it is new"), which no script ever
// touched and which the desk itself had long since changed.
//
// A figure typed into the markup is a figure that goes stale the first time a
// setting moves. index.html now carries MARKERS where the figures go, and this
// fills them from the same settings /api/ladder/state publishes:
//
//   <!--LIVE:name-->                    in HTML
//   /*LIVE:name*/fallback/*/LIVE*/      inside the page script (the limits it
//                                       starts with); the fallback between the
//                                       two comments is REPLACED, and is only
//                                       what an unrendered file would run
//
// Figures the market does not own -- the wrap desk's limit, fee and waiting
// time live in that desk's environment on another host -- are not rendered
// here at all. The page names the desk and lets it state its own terms.
//
// PURE: no database, no settings object, no filesystem. server.mjs gathers the
// values and passes them in, so page-render-test.mjs runs anywhere.
//
// UNKNOWN IS NOT A NUMBER. A value that could not be read (the ladder query
// failed, a setting is not finite) renders as text that carries NO figure,
// never as a zero or a default -- the doctrine every PCN rail runs on. A marker
// this file does not know is an ERROR: a hole where a number should be is the
// same failure as a stale number, only quieter.

const fin = v => v !== null && v !== undefined && v !== '' && Number.isFinite(Number(v));

/** "$50", "$12.50", "$1,000": whole dollars stay whole, cents show as two digits. */
export function fmtUsd(v) {
  const n = Number(v);
  const cents = Math.round(n * 100) % 100 !== 0;
  return '$' + n.toLocaleString('en-US', {
    minimumFractionDigits: cents ? 2 : 0, maximumFractionDigits: 2 });
}

/** The auto-send sentence. `autoMaxUsd` 0 means auto-send is OFF (settings.mjs:
 *  "0 disables auto-send"), and server.mjs sends by itself only when
 *  autoMaxUsd > 0 && usd <= autoMaxUsd -- so "up to" is inclusive, and "up to
 *  $0" would be a promise the server never keeps. */
export function deliverySentence(autoMaxUsd) {
  const tail = ' can take anywhere from a minute to 24 working hours.';
  if (!fin(autoMaxUsd)) {
    return 'Some orders are sent automatically, usually within a minute of confirmation; '
      + '<b>others are released by hand</b> and' + tail;
  }
  const n = Number(autoMaxUsd);
  if (n <= 0) return '<b>Every order is released by hand</b>, and' + tail;
  return '<b>Orders up to ' + fmtUsd(n) + ' are sent automatically</b>, usually within a minute '
    + 'of confirmation. <b>Larger orders are released by hand</b> and' + tail;
}

/** The line under "Available to buy". The same words the page script writes
 *  once /api/ladder/state answers, so the first paint and the script agree. */
export function stockNote(ladder) {
  if (!ladder || !fin(ladder.totalPcn) || !fin(ladder.pctSold) || Number(ladder.totalPcn) <= 0) {
    return '';                                     // unknown: say nothing, never a guess
  }
  return Number(ladder.pctSold).toFixed(2) + '% of '
    + Math.round(Number(ladder.totalPcn)).toLocaleString('en-US') + ' PCN sold';
}

/** The limits the page script starts with, before /api/ladder/state answers.
 *  NUMBERS OR null ONLY: this lands inside a <script>, and a string here would
 *  be an injection point. maxOrderUsdNow needs a ladder walk, so it is left to
 *  the API, exactly as before. */
export function limitsJson(s) {
  const num = v => (fin(v) ? Number(v) : null);
  return JSON.stringify({
    minOrderUsd: num(s && s.minOrderUsd),
    maxOrderUsd: num(s && s.maxOrderUsd),
    maxOrderPcn: num(s && s.maxOrderPcn),
    maxOrderUsdNow: null,
    autoMaxUsd: num(s && s.autoMaxUsd),
  });
}

/**
 * @param html      index.html as read from disk
 * @param settings  { autoMaxUsd, minOrderUsd, maxOrderUsd, maxOrderPcn } from S.get()
 * @param ladder    { totalPcn, pctSold } from L.ladderState(), or null when it
 *                  could not be read
 */
export function renderMarketPage(html, { settings = {}, ladder = null } = {}) {
  const fill = {
    delivery: () => deliverySentence(settings.autoMaxUsd),
    stock:    () => stockNote(ladder),
    limits:   () => limitsJson(settings),
  };
  const out = String(html).replace(
    /<!--LIVE:(\w+)-->|\/\*LIVE:(\w+)\*\/[^\n]*?\/\*\/LIVE\*\//g, (m, a, b) => {
      const name = a || b;
      if (!Object.prototype.hasOwnProperty.call(fill, name)) {
        throw new Error(`page-render: index.html has a marker nothing fills: ${m.slice(0, 60)}`);
      }
      return fill[name]();
    });
  // A script marker missing its closing /*/LIVE*/ would slip past the pattern
  // above and ship its fallback as though it were live. Refuse instead.
  const stray = out.match(/<!--LIVE:|\/\*LIVE:|\/\*\/LIVE\*\//);
  if (stray) throw new Error(`page-render: malformed or unclosed marker near ${JSON.stringify(stray[0])}`);
  return out;
}
