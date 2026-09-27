#!/usr/bin/env node
// market.pc.am's page figures are rendered from live state, not typed in.
//
//   node page-render-test.mjs
//
// PURE: renders the real index.html beside it through page-render.mjs with
// synthetic settings. No database, no network, no server.
//
// WHY THIS EXISTS. The page said "Orders up to $25 are sent automatically"
// while autoMaxUsd was 50, and "250 PCN per person" for a wrap desk that had
// moved on. The script fixed the first in a browser; nothing fixed either for a
// link preview, a search engine or a visitor without JavaScript. The guard that
// matters is section 2: render with deliberately ODD values and require that
// every number a visitor can read is one of them. A figure typed into the
// markup fails it -- and section 6 proves it would, against a copy with the
// old $25 sentence put back, because a check that cannot fail is not a check.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderMarketPage, deliverySentence, stockNote, limitsJson, fmtUsd } from './page-render.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(join(HERE, 'index.html'), 'utf8');
let failed = 0;
const ok = (name, cond, detail = '') => {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : ''));
  if (!cond) failed++;
};
const throws = fn => { try { fn(); return false; } catch { return true; } };

/** What a visitor without JavaScript reads: no comments, scripts, styles or tags. */
const visible = html => html
  .replace(/<!--[\s\S]*?-->/g, ' ')
  .replace(/<script[\s\S]*?<\/script>/gi, ' ')
  .replace(/<style[\s\S]*?<\/style>/gi, ' ')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&[a-z]+;/g, ' ');
/** The LIMITS object the page script starts with, parsed out of the render. */
const startLimits = html => {
  const m = html.match(/let LIMITS = (\{[^\n]*?\});/);
  return m ? JSON.parse(m[1]) : undefined;
};

// Odd on purpose: none of these can be mistaken for a figure typed into the page.
const ODD = { autoMaxUsd: 77, minOrderUsd: 33, maxOrderUsd: 444, maxOrderPcn: 5555 };
const ODD_LADDER = { totalPcn: 123456, pctSold: 12.3456 };

console.log('1. the live figures land where they belong');
const page = renderMarketPage(HTML, { settings: ODD, ladder: ODD_LADDER });
ok('auto-send sentence carries autoMaxUsd', page.includes('Orders up to $77 are sent automatically'));
ok('stock line carries the ladder', page.includes('12.35% of 123,456 PCN sold'));
ok('script starts with the live limits',
   JSON.stringify(startLimits(page)) === JSON.stringify(
     { minOrderUsd: 33, maxOrderUsd: 444, maxOrderPcn: 5555, maxOrderUsdNow: null, autoMaxUsd: 77 }),
   JSON.stringify(startLimits(page)));
ok('no marker survives the render', !/LIVE:|\/\*\/LIVE/.test(page));
ok('index.html carries every marker', ['<!--LIVE:delivery-->', '<!--LIVE:stock-->', '/*LIVE:limits*/']
   .every(m => HTML.includes(m)));
ok('the hCaptcha slot is left for server.mjs', page.includes('<!--HCAPTCHA-->'));

console.log('2. every number a no-JS visitor can read is a live one');
const ALLOWED = new Set(['77', '12.35', '123,456',
  '24']);                                   // "24 working hours": a service promise, not a setting
const nums = visible(page).match(/\d[\d,]*(?:\.\d+)?/g) || [];
const stray = nums.filter(n => !ALLOWED.has(n));
ok('no typed-in figure in the visible text', stray.length === 0, stray.length ? 'found: ' + stray.join(' ') : '');
ok('the old figures are gone from the markup',
   !/\$25\b|250 PCN per person|5% fee|100 confirmations|of 100,000 PCN/.test(visible(HTML)));

console.log('3. auto-send OFF is not "up to $0"');
const off = renderMarketPage(HTML, { settings: { ...ODD, autoMaxUsd: 0 }, ladder: ODD_LADDER });
ok('0 renders as every order by hand', off.includes('Every order is released by hand'));
ok('and never as up to $0', !/up to \$0\b/.test(off));

console.log('4. unknown is not a number');
for (const bad of [null, undefined, NaN, '', 'abc']) {
  const s = deliverySentence(bad);
  ok(`autoMaxUsd ${String(bad) || "''"} names no figure`, !/\$|\d/.test(s.replace('24 working', '')), s.slice(0, 50));
}
ok('ladder unreadable -> no stock figure', stockNote(null) === '');
ok('ladder with a zero total -> no stock figure', stockNote({ totalPcn: 0, pctSold: 0 }) === '');
const noLadder = renderMarketPage(HTML, { settings: ODD, ladder: null });
ok('page still renders without the ladder, and invents no total', !/123,456|100,000/.test(visible(noLadder)));
const unknownLimits = JSON.parse(limitsJson({ minOrderUsd: 'x', maxOrderUsd: undefined }));
ok('unreadable limits start as null, not a default',
   unknownLimits.minOrderUsd === null && unknownLimits.maxOrderUsd === null && unknownLimits.autoMaxUsd === null);

console.log('5. the script slot takes numbers only');
const inj = limitsJson({ minOrderUsd: '</script><script>alert(1)</script>', autoMaxUsd: '5' });
ok('a string cannot reach the <script>', !inj.includes('<') && JSON.parse(inj).minOrderUsd === null);
ok('a numeric string is still a number', JSON.parse(inj).autoMaxUsd === 5);

console.log('6. the check in section 2 FIRES on a typed-in figure (negative control)');
const regressed = HTML.replace('<!--LIVE:delivery-->', '<b>Orders up to $25 are sent automatically</b>.');
const back = visible(renderMarketPage(regressed, { settings: ODD, ladder: ODD_LADDER }))
  .match(/\d[\d,]*(?:\.\d+)?/g).filter(n => !ALLOWED.has(n));
ok('the old $25 sentence would have been caught', back.includes('25'), 'flagged: ' + back.join(' '));

console.log('7. markers are strict');
ok('an unknown marker throws', throws(() => renderMarketPage('<p><!--LIVE:nope--></p>')));
ok('an unclosed script marker throws', throws(() => renderMarketPage('let x = /*LIVE:limits*/{};')));
ok('a page with no markers is returned unchanged (old index.html under the new server)',
   renderMarketPage('<p>plain</p><!--HCAPTCHA-->') === '<p>plain</p><!--HCAPTCHA-->');

console.log('8. money formatting');
ok('$50', fmtUsd(50) === '$50');
ok('$12.50', fmtUsd(12.5) === '$12.50');
ok('$1,000', fmtUsd(1000) === '$1,000');

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);
