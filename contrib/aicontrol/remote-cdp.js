// Drive Chrome on a remote PC through the DevTools Protocol.
//
//   node remote-cdp.js <script.json>
//
// Runs ON the target machine (pushed there base64-encoded by ac.py), because
// the debugging port is bound to that machine's localhost and is not reachable
// from anywhere else.
//
// WHY THIS EXISTS
// UI Automation on Chrome times out: `read_screen` and `get_clickable_elements`
// both gave "Operation timed out" against a loaded Chrome window, and
// `capture_screen` returns only a text description through the API, never the
// image. So there is no way to see or click the browser blind. CDP is exact --
// it clicks a selector, not a guessed pixel.
//
// Zero dependencies: Node 22+ ships a global WebSocket, and this box runs
// v24.16.0. Nothing to install on a machine we do not own.
//
// The action list is JSON so it can be written from the controlling side
// without quoting anything through PowerShell (see CLAUDE.md 7.8 -- double
// quotes are stripped in transit, which is why everything here arrives base64).

const fs = require('fs');
const PORT = process.env.CDP_PORT || 9222;

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function targets() {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
  return (await r.json()).filter(t => t.type === 'page');
}

async function pick(match) {
  for (let i = 0; i < 30; i++) {
    const ts = await targets();
    const hit = match ? ts.find(t => (t.url + ' ' + t.title).toLowerCase().includes(match.toLowerCase())) : ts[0];
    if (hit) return hit;
    await sleep(1000);
  }
  throw new Error('no page matching ' + match);
}

class Session {
  constructor(ws) { this.ws = ws; this.id = 0; this.waiters = new Map(); }
  static async open(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    const s = new Session(ws);
    ws.onmessage = e => {
      const m = JSON.parse(e.data);
      if (m.id && s.waiters.has(m.id)) { s.waiters.get(m.id)(m); s.waiters.delete(m.id); }
    };
    return s;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => {
      this.waiters.set(id, m => m.error ? rej(new Error(method + ': ' + m.error.message)) : res(m.result));
      setTimeout(() => rej(new Error(method + ' timed out')), 60000);
    });
  }
  // Everything goes through one evaluate: no domains enabled, nothing to flood.
  async js(expr) {
    const r = await this.send('Runtime.evaluate',
      { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'js threw');
    return r.result && r.result.value;
  }
  close() { try { this.ws.close(); } catch (e) {} }
}

async function run(actions) {
  let sess = null;
  const out = [];
  for (const a of actions) {
    try {
      if (a.op === 'attach') { const t = await pick(a.match); sess?.close(); sess = await Session.open(t); out.push('attached: ' + t.title.slice(0, 60)); }
      else if (a.op === 'navigate') { await sess.send('Page.navigate', { url: a.url }); await sleep(a.wait || 3000); out.push('navigated: ' + a.url); }
      else if (a.op === 'wait') { await sleep(a.ms); out.push('waited ' + a.ms + 'ms'); }
      else if (a.op === 'eval') { out.push('eval: ' + JSON.stringify(await sess.js(a.js)).slice(0, 400)); }
      else if (a.op === 'click') {
        const ok = await sess.js(`(()=>{const e=document.querySelector(${JSON.stringify(a.sel)});
          if(!e) return 'MISS'; e.scrollIntoView({block:'center'}); e.click(); return 'ok';})()`);
        out.push('click ' + a.sel + ': ' + ok);
      }
      else if (a.op === 'text') { out.push('text: ' + String(await sess.js('document.body.innerText')).replace(/\n{2,}/g, '\n').slice(0, a.max || 1500)); }
      else if (a.op === 'title') { out.push('title: ' + await sess.js('document.title')); }
      else out.push('unknown op ' + a.op);
    } catch (e) { out.push('ERROR ' + a.op + ': ' + e.message); }
  }
  sess?.close();
  return out;
}

(async () => {
  const actions = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const out = await run(actions);
  console.log(out.join('\n'));
  process.exit(0);
})();
