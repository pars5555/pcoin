// Logging, and the two places a credential escapes.
//
// Rule, from five real leaks on this project: REDACT BY ALLOW-LIST, NEVER BY
// PATTERN. Every one of those leaks came from printing a line NEAR a match --
// a process command line, an env block, a context line around a regex hit. So
// nothing here ever serialises an arbitrary object. You name the fields you
// want logged, or they are not logged.
//
// The second escape is error logging. A `fetch` error object carries the
// Authorization header; an axios one carries it twice. `console.error(err)`
// therefore prints a credential. We log `err.message` and `err.stack` ONLY --
// never the object, never `err.config`, never `err.request`, never process.env.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
let minLevel = LEVELS.info;

export function setLevel(name) {
  if (LEVELS[name] === undefined) throw new Error(`unknown log level ${name}`);
  minLevel = LEVELS[name];
}

// Scalars only, and short ones. An object would reintroduce exactly the
// serialise-everything hazard this module exists to prevent.
function fmtValue(v) {
  if (v === null) return 'null';
  if (v === undefined) return 'undefined';
  const t = typeof v;
  if (t === 'number' || t === 'boolean' || t === 'bigint') return String(v);
  if (t === 'string') {
    const s = v.length > 300 ? `${v.slice(0, 300)}...<${v.length}>` : v;
    return /[\s="]/.test(s) ? JSON.stringify(s) : s;
  }
  // Anything else is a programming error at the call site, not something to
  // print. Say so without printing it.
  return `<${t}:unloggable>`;
}

function emit(level, msg, fields) {
  if (LEVELS[level] < minLevel) return;
  let line = `${new Date().toISOString()} ${level} ${msg}`;
  if (fields) {
    for (const [k, v] of Object.entries(fields)) line += ` ${k}=${fmtValue(v)}`;
  }
  const stream = LEVELS[level] >= LEVELS.warn ? process.stderr : process.stdout;
  stream.write(`${line}\n`);
}

export const log = {
  debug: (msg, fields) => emit('debug', msg, fields),
  info:  (msg, fields) => emit('info', msg, fields),
  warn:  (msg, fields) => emit('warn', msg, fields),
  error: (msg, fields) => emit('error', msg, fields),
};

// The ONLY sanctioned way to log a caught throwable.
export function errFields(e) {
  return {
    err: e instanceof Error ? e.message : String(e),
    stack: e instanceof Error && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : '-',
  };
}

// A Telegram user id sitting next to a PCN deposit address is a customer
// ledger: it links a chain identity to a Telegram account, and deposit
// addresses are per-user and reused forever. Log the FACT of the lookup, not
// the pair. Use these when either has to appear at all.
export function addrTag(address) {
  if (typeof address !== 'string' || address.length < 12) return '<addr?>';
  return `${address.slice(0, 6)}..${address.slice(-4)}`;
}
export function chatTag(chatId) {
  return `chat#${String(chatId).slice(-4)}`;
}

export function installCrashHandlers(onFatal) {
  process.on('unhandledRejection', (reason) => {
    log.error('unhandledRejection', errFields(reason));
    if (onFatal) onFatal(reason);
  });
  process.on('uncaughtException', (e) => {
    log.error('uncaughtException', errFields(e));
    if (onFatal) onFatal(e);
    // An uncaught exception has left the process in an unknown state. Exit and
    // let Restart=always bring it back clean; OnFailure= sees a non-zero exit.
    process.exit(1);
  });
}
