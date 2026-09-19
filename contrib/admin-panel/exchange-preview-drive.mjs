// Drive the live-filtering in a real browser and assert it behaves.
// window.__loads counts FULL page loads: it must stay at 1 throughout, or the
// page navigated instead of updating in place.
import { readFileSync, writeFileSync } from 'node:fs';
const BASE = readFileSync(process.argv[2], 'utf8').trim();
const OUT = process.argv[3];
const t = await (await fetch('http://127.0.0.1:9761/json/new?about:blank', { method: 'PUT' })).json();
const ws = new WebSocket(t.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0; const wait = new Map();
ws.addEventListener('message', (m) => { const d = JSON.parse(m.data); if (d.id && wait.has(d.id)) { wait.get(d.id)(d); wait.delete(d.id); } });
const send = (method, params = {}) => new Promise((r) => { const id = ++seq; wait.set(id, r); ws.send(JSON.stringify({ id, method, params })); });
const evalJs = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true })).result?.result?.value;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let bad = 0;
const check = (name, cond, detail = '') => { console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '   ' + detail : '')); if (!cond) bad++; };

await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: BASE });
await sleep(1500);

const summary = () => evalJs("document.querySelector('.xsummary span')?.textContent.replace(/\\s+/g,' ').trim()");
const loads = () => evalJs('window.__loads');
const rows = () => evalJs("document.querySelectorAll('#xres table tr').length - 1");
const btnHidden = () => evalJs("getComputedStyle(document.querySelector('form.xfilters button.xgo')).display");

const start = await summary();
check('the page rendered a list', /of\s*64/.test(String(start)), String(start));
check('the Filter button is hidden when the script runs', (await btnHidden()) === 'none');

// ---- typing in the search box updates without a click and without reloading
await evalJs(`(function(){ const i = document.querySelector('form.xfilters input[type=search]');
  i.focus(); i.value = 'user1@'; i.dispatchEvent(new Event('input', { bubbles: true })); return 1; })()`);
await sleep(700);
const afterType = await summary();
check('typing filtered the list with no Filter click', /of\s*1\b/.test(String(afterType)), String(afterType));
check('no full page load happened', (await loads()) === 1, 'loads=' + (await loads()));
check('the caret is still in the search box', (await evalJs("document.activeElement.type")) === 'search');
check('the URL now carries the search', /q=user1/.test(String(await evalJs('location.search'))), String(await evalJs('location.search')));

// ---- changing a select applies at once
await evalJs(`(function(){ const i = document.querySelector('form.xfilters input[type=search]');
  i.value=''; i.dispatchEvent(new Event('input',{bubbles:true})); return 1; })()`);
await sleep(600);
await evalJs(`(function(){ const s = document.querySelector('form.xfilters select[name=f_country]');
  s.value = 'AM'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await sleep(700);
const afterSelect = await summary();
check('changing a dropdown applied at once', /of\s*9\b/.test(String(afterSelect)), String(afterSelect));
check('still no page load', (await loads()) === 1);
check('a chip appeared for the filter', (await evalJs("!!document.querySelector('#xres .xchip')")) === true);

// ---- sorting from the dropdown
await evalJs(`(function(){ const s = document.querySelector('form.xfilters select[name=sort]');
  s.value = 'pcn'; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
await sleep(700);
const firstPcn = await evalJs("document.querySelector('#xres table tr:nth-child(2)')?.textContent.replace(/\\s+/g,' ').slice(0,60)");
check('sorting by PCN applied at once', /of\s*9\b/.test(String(await summary())), String(firstPcn));
check('still no page load after sorting', (await loads()) === 1);

// ---- a pager click stays in place too
await evalJs(`(function(){ const s=document.querySelector('form.xfilters select[name=f_country]'); s.value=''; s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
await sleep(700);
await evalJs(`(function(){ const s=document.querySelector('form.xfilters select[name=per]'); s.value='10'; s.dispatchEvent(new Event('change',{bubbles:true})); return 1; })()`);
await sleep(700);
const pager = await evalJs("!!document.querySelector('#xres .xpager a')");
check('a pager is shown at 10 per page', pager === true);
await evalJs(`(function(){ const a=[...document.querySelectorAll('#xres .xpager a')].find(x=>x.textContent.trim()==='3'); a && a.click(); return 1; })()`);
await sleep(800);
check('paging updated in place', /21.{0,3}30/.test(String(await summary())), String(await summary()));
check('still no page load after paging', (await loads()) === 1, 'loads=' + (await loads()));
check('rows on the page', (await rows()) === 10, String(await rows()));

const shot = await send('Page.captureScreenshot', { format: 'png', clip: { x: 0, y: 0, width: 1440, height: 760, scale: 0.75 } });
writeFileSync(OUT, Buffer.from(shot.result.data, 'base64'));
await fetch(`http://127.0.0.1:9761/json/close/${t.id}`);
ws.close();
console.log(bad ? `\n${bad} CHECK(S) FAILED` : '\nlive filtering works');
process.exit(bad ? 1 : 0);
