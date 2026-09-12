// Token estimation, and why it is measured in BYTES.
//
// `chars / 3.5` is an ENGLISH-ASCII heuristic and a Telegram bot is not an
// ASCII input. Cyrillic and Armenian are 2 bytes/char at roughly 1 token per
// 1-2 characters; CJK is 3 bytes at near 1 token/char; emoji are 4. On those
// scripts chars/3.5 runs 2-10x LOW -- which turns "a quote is never lower than
// the bill" into a falsehood on ordinary traffic. THIS PROJECT'S USERS WRITE
// ARMENIAN.
//
// The estimate exists only as a FALLBACK. If POST /v1/messages/count_tokens
// works for the pool (Q4 -- the registry declares countTokens:false, which
// contradicts the spec's "Costs nothing and sends nothing upstream"), count the
// exact request body instead and reserve on the real figure. It costs nothing,
// so that is not a trade.

// Divisor chosen so that measured/estimate <= 1.0 for EVERY fixture script --
// i.e. the estimate is never lower than the truth. Calibrate with
// `node tools/calibrate-tokens.mjs` once a key exists, and keep the fixtures as
// a unit test.
export const BYTES_PER_TOKEN = 2.2;

// Safety band on top of the estimate. The quote is a CEILING; it must bound the
// bill, not approximate it.
export const ESTIMATE_BAND = 1.25;

export function utf8Bytes(s) {
  return Buffer.byteLength(String(s), 'utf8');
}

export function estimateTokens(text) {
  return Math.ceil(utf8Bytes(text) / BYTES_PER_TOKEN);
}

// Quote the ENTIRE serialized request -- system prompt + the conversation
// history + tool definitions -- not just the new message. The under-count on
// the rest grows without bound as the conversation does.
export function estimateRequestTokens({ system = '', messages = [], tools = [] }) {
  let bytes = utf8Bytes(system);
  for (const m of messages) {
    bytes += utf8Bytes(typeof m.content === 'string' ? m.content : JSON.stringify(m.content));
    bytes += 8; // role + framing overhead, deliberately generous
  }
  if (tools.length) bytes += utf8Bytes(JSON.stringify(tools));
  return Math.ceil((bytes / BYTES_PER_TOKEN) * ESTIMATE_BAND);
}

// The calibration fixture. Every script this bot will actually see.
export const FIXTURES = [
  { name: 'english-short', text: 'hello world' },
  { name: 'english-para', text: 'The quick brown fox jumps over the lazy dog. '.repeat(8) },
  { name: 'armenian', text: 'Բարեւ Ձեզ ինչպես եք։ Ես ուզում եմ իմանալ գինը։' },
  { name: 'armenian-long', text: 'Բարեւ Ձեզ, ինչպես եք։ '.repeat(20) },
  { name: 'russian', text: 'Привет как дела? Я хочу узнать цену на это.' },
  { name: 'chinese', text: '你好世界，我想知道这个的价格是多少。' },
  { name: 'arabic', text: 'مرحبا كيف حالك؟ أريد أن أعرف السعر.' },
  { name: 'emoji', text: '🚀🔥💰🎉😀😃😄😁😆😅🤣😂🙂🙃😉😊😇🥰😍🤩' },
  { name: 'code-block', text: '```js\nfunction f(x) {\n  return x.map(y => y * 2);\n}\n```' },
  { name: 'mixed', text: 'Hello Բարեւ Привет 你好 🚀 mixed script line' },
];

// Compare estimates against measured counts. EVERY ratio must be <= 1.0, which
// is what "the quote is never lower than the bill" means arithmetically.
// `measure` is an async fn(text) -> token count.
export async function calibrate(measure) {
  const rows = [];
  for (const f of FIXTURES) {
    const measured = await measure(f.text);
    const estimate = estimateTokens(f.text);
    rows.push({
      name: f.name,
      bytes: utf8Bytes(f.text),
      chars: f.text.length,
      measured,
      estimate,
      ratio: estimate === 0 ? Infinity : measured / estimate,
      // What the naive English heuristic would have produced, for contrast.
      naiveChars35: Math.ceil(f.text.length / 3.5),
    });
  }
  const worst = rows.reduce((a, b) => (b.ratio > a.ratio ? b : a), rows[0]);
  return { rows, worst, safe: rows.every((r) => r.ratio <= 1.0) };
}
