// "PAY FROM KEEPER" -- the panel's side of paying an exchange USDT withdrawal
// on BNB Smart Chain from the keeper wallet (owner, 2026-09-25: "if keeper has
// 251.94 then can you send user exchange withdrawals from keeper ... by 1
// click? i dont want you do that" -- the owner presses it, nobody else).
//
// The panel holds no key and signs nothing. It runs /usr/local/bin/pcoin-keeper-pay
// (contrib/wpcn/pcoin-keeper-pay), which reads the keeper's key itself, keeps
// its own ledger, and cannot pay one key twice: it records the signed
// transaction BEFORE broadcasting and, on any retry, re-sends those identical
// bytes instead of signing again. So "press it again" is safe after every kind
// of failure, exactly as with Pay from market-hot.
//
// The tool is run with the KEEPER's python, read off the keeper's own unit.
// The system python has no web3; running the script with it would fail every
// time in a way that reads like the chain being down (wrapdesk.mjs, watchArgv).
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
export const KEEPER_PAY_BIN = process.env.KEEPER_PAY_BIN || '/usr/local/bin/pcoin-keeper-pay';
const KEEPER_UNIT = process.env.KEEPER_UNIT || 'pcoin-wpcn-keeper.service';

async function keeperPython() {
  const { stdout } = await run('systemctl', ['show', KEEPER_UNIT, '-p', 'ExecStart', '--no-pager'], { timeout: 15000 });
  const all = [...String(stdout).matchAll(/argv\[\]=([^;]*);/g)]
    .map((m) => m[1].trim().split(/\s+/).filter(Boolean)).filter((a) => a.length);
  if (!all.length) throw new Error(`could not read ExecStart from ${KEEPER_UNIT}`);
  return all[all.length - 1][0];
}

// The tool prints ONE JSON object on stdout; anything else is not an answer.
export function lastJson(stdout) {
  const lines = String(stdout || '').trim().split('\n').reverse();
  for (const l of lines) {
    const t = l.trim();
    if (t.startsWith('{')) { try { return JSON.parse(t); } catch { return null; } }
  }
  return null;
}

// "12.34" -> "12340000" micro-dollars, exactly, or null. Never a float: this
// is the amount that goes on chain.
export function usdToMicro(s) {
  const m = /^(\d{1,9})(?:\.(\d{1,6}))?$/.exec(String(s || '').trim());
  if (!m) return null;
  const micro = BigInt(m[1]) * 1000000n + BigInt((m[2] || '').padEnd(6, '0'));
  return micro > 0n ? micro.toString() : null;
}

export async function keeperStatus() {
  try {
    const py = await keeperPython();
    const { stdout } = await run(py, [KEEPER_PAY_BIN, '--status'], { timeout: 60000 });
    return lastJson(stdout) || { ok: false, error: 'the tool gave no answer' };
  } catch (e) {
    return { ok: false, error: String((e && (e.stderr || e.message)) || e).trim().slice(0, 300) };
  }
}

// -> { state: 'sent'|'already'|'refused'|'unknown'|'dry-run', txid?, message }
// A crash, a timeout or an unparseable answer is UNKNOWN, never "not sent":
// the transaction may already be on its way, and the tool's own ledger is what
// makes the next press safe.
export async function keeperSend({ key, to, micro, note }) {
  let py;
  try { py = await keeperPython(); } catch (e) { return { state: 'refused', message: `${e.message}. Nothing was sent.` }; }
  try {
    const { stdout } = await run(py, [KEEPER_PAY_BIN, '--send', key, to, String(micro), '--note', String(note || '')],
      { timeout: 300000, maxBuffer: 1 << 20 });
    return lastJson(stdout) || { state: 'unknown', message: 'The tool finished but gave no answer.' };
  } catch (e) {
    const j = lastJson(e && e.stdout);
    if (j) return j;
    if (e && e.code === 2) return { state: 'refused', message: String(e.stderr || 'refused').trim().slice(0, 300) };
    return { state: 'unknown', message: `The tool did not finish (${String((e && (e.stderr || e.message)) || e).trim().slice(0, 200)}).` };
  }
}
