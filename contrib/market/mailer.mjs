// Outbound mail for market.pc.am. One job today: password-reset links.
//
// It shells out to curl, which already speaks SMTP over TLS on this box, rather
// than adding a mail library to a server that holds a spending wallet. The
// fewer packages in this process, the fewer to audit.
//
// config.json:
//   "mail": {
//     "url":   "smtp://smtp.gmail.com:587",
//     "from":  "pcoinpcn@gmail.com",
//     "name":  "PCoin",
//     "netrc": "/etc/pcoin/market-smtp.netrc"
//   }
// The password lives ONLY in the netrc file (0400, owned by the service user),
// never in config.json and never on curl's command line, where `ps` would show
// it to every user on the box.
//
// Unset or incomplete -> makeMailer returns null, and every feature that needs
// mail says it is unavailable instead of pretending to have sent something.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';

// Same rule as sign-up, plus no control characters. A CR or LF in an address
// or a subject would let the caller write their own mail headers.
const SAFE_ADDR = /^[^@\s|<>"]+@[^@\s|<>"]+\.[^@\s|<>"]+$/;
const NO_CTL = /^[^\x00-\x1f\x7f]*$/;

export function buildMessage({ from, name, to, subject, text, now = new Date(), id = randomBytes(12).toString('hex') }) {
  if (!SAFE_ADDR.test(from) || !SAFE_ADDR.test(to)) throw new Error('mail: bad address');
  if (!NO_CTL.test(subject) || !NO_CTL.test(name || '')) throw new Error('mail: control character in a header');
  const domain = from.split('@')[1];
  // Subject is RFC 2047 encoded so a non-ASCII character cannot break the header.
  const subj = /^[\x20-\x7e]*$/.test(subject)
    ? subject
    : `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
  const head = [
    `From: ${name ? `${name} <${from}>` : from}`,
    `To: ${to}`,
    `Subject: ${subj}`,
    `Date: ${now.toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${id}@${domain}>`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    'Auto-Submitted: auto-generated',
  ];
  // CRLF throughout, and a lone leading dot doubled: SMTP ends the message at
  // a line holding only "." and a body must never be able to say that.
  const body = String(text).replace(/\r?\n/g, '\n').split('\n')
    .map(l => (l.startsWith('.') ? '.' + l : l)).join('\r\n');
  return head.join('\r\n') + '\r\n\r\n' + body + '\r\n';
}

export function makeMailer(mailCfg, { log = console, run = runCurl } = {}) {
  const c = mailCfg || {};
  if (!c.url || !c.from || !c.netrc) return null;
  if (!/^smtps?:\/\//.test(c.url)) throw new Error('mail.url must be smtp:// or smtps://');
  return {
    from: c.from,
    /** Resolves {ok:true} or {ok:false, error}. Never throws: a mail server
     *  being down must not turn into a 500 on the page that asked. */
    async send({ to, subject, text }) {
      let msg;
      try { msg = buildMessage({ from: c.from, name: c.name || 'PCoin', to, subject, text }); }
      catch (e) { return { ok: false, error: e.message }; }
      const args = ['--silent', '--show-error', '--max-time', '30',
        '--url', c.url, '--ssl-reqd', '--netrc-file', c.netrc,
        '--mail-from', c.from, '--mail-rcpt', to, '--upload-file', '-'];
      const r = await run(args, msg);
      if (!r.ok) log.error?.(`[mail] to ${to} failed: ${r.error}`);
      return r;
    },
  };
}

function runCurl(args, input) {
  return new Promise(resolve => {
    let err = '';
    const p = spawn('curl', args, { stdio: ['pipe', 'ignore', 'pipe'] });
    p.stderr.on('data', d => { err += d; if (err.length > 4000) err = err.slice(-4000); });
    p.on('error', e => resolve({ ok: false, error: e.message }));
    p.on('close', code => resolve(code === 0
      ? { ok: true }
      : { ok: false, error: `curl exit ${code}: ${err.trim().slice(0, 300)}` }));
    p.stdin.end(input);
  });
}
