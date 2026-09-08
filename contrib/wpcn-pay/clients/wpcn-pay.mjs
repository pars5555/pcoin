// Drop-in client for the shared wPCN payment verifier (Node).
//
//   import { WpcnPay, isCredit, humanMessage } from './wpcn-pay.mjs';
//   const wpcn = new WpcnPay(process.env.WPCN_PAY_TOKEN);
//   const r = await wpcn.verify(txhash, String(user.id));
//   if (isCredit(r)) { /* credit r.usd_total, once */ }
//
// The verifier owns the anti-double-credit ledger, so a project never has to
// decide whether a hash has been claimed before -- it asks, and the answer is
// authoritative across all four projects. What a project still owns is its own
// user balance and its own idempotency, because a lost response on YOUR side
// must not credit twice either.
//
// WHAT THIS MODULE EXISTS TO STOP
// Every failure mode below has cost this project money at least once, on the
// PCN rails, in almost exactly this shape:
//
//   * A transport failure read as "no payment". A rejected fetch is not an
//     answer; it is the absence of one. Anything unresolvable comes back as
//     `unreadable`, never a definite state.
//   * `?? 0` and `|| 0` on a failed call. There is not one in this file on a
//     value that decides money.
//   * A rate re-derived at display time instead of the one actually credited.
//     `rate_usd` comes back on the row and MUST be stored with the credit.

export const STATE = {
  CREDITED:        'credited',          // credit usd_total, once
  ALREADY_CLAIMED: 'already_claimed',   // credit NOTHING
  PENDING:         'pending',           // not on chain yet; retry
  CONFIRMING:      'confirming',        // seen, too shallow; retry
  NO_PAYMENT:      'no_payment',        // real tx, paid us nothing
  REVERTED:        'reverted',          // failed on chain
  REORGED:         'reorged',           // block no longer canonical
  BAD_REQUEST:     'bad_request',       // malformed hash
  UNREADABLE:      'unreadable',        // WE COULD NOT LOOK. Retry.
};

export class WpcnPay {
  constructor(token, { endpoint = 'https://wpcnpay.pc.am', timeoutMs = 60000 } = {}) {
    if (!token) throw new Error('WpcnPay: a project bearer token is required');
    this.token = token;
    this.endpoint = endpoint;
    this.timeoutMs = timeoutMs;
  }

  /**
   * Ask whether txhash paid us, and claim it for userRef.
   *
   * Always resolves to an object with a `state`. It never rejects: a caller who
   * has to try/catch will eventually forget to, and the catch block is exactly
   * where "unknown" turns into "no".
   */
  verify(txhash, userRef) {
    return this.#request('/verify', { txhash, user_ref: String(userRef) });
  }

  /**
   * Every claim banked to this project for one user. Read-only.
   *
   * Returns { ok: true, project, claims: [...] } on success, or an object with
   * state 'unreadable' if we could not get an answer. It does NOT return a
   * verify-shaped reply, because /claims has no 'state' -- see the shape note
   * in #request.
   */
  claims(userRef) {
    return this.#request('/claims?user_ref=' + encodeURIComponent(String(userRef)), null, 'claims');
  }

  // shape: which endpoint's reply we are validating.
  //
  // THIS USED TO BE ONE RULE FOR BOTH, AND IT WAS WRONG. /verify answers with a
  // top-level 'state'; /claims answers { ok, project, claims: [] } and has no
  // 'state' at all. Demanding one turned every SUCCESSFUL /claims call into
  // 'unreadable' -- which silently disabled the heal path in INTEGRATION.md 9,
  // the one that returns a customer's money after our own write was lost. It
  // failed safe (refused rather than double-credited), so nothing broke loudly;
  // it just could never work. Found by the webai and 3dmodel teams on
  // 2026-09-08, both reading the code rather than trusting it.
  async #request(path, body, shape = 'verify') {
    let res;
    try {
      res = await fetch(this.endpoint + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          Authorization: 'Bearer ' + this.token,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      // Transport died. This resolves nothing.
      return { state: STATE.UNREADABLE, message: String(e && e.message) };
    }

    let j = null;
    try { j = await res.json(); } catch { /* fall through */ }

    // 401/403/404 mean the CALLER is misconfigured -- a deployment bug, not a
    // customer's failed payment. Resolve nothing, and log it loudly your side.
    // Checked BEFORE the shape test, so a rejection reports why rather than
    // arriving as a vague "unparseable".
    if ([401, 403, 404].includes(res.status)) {
      return { state: STATE.UNREADABLE, message: `verifier rejected this client (HTTP ${res.status})` };
    }

    // A body we cannot parse is not an answer either. In particular it is not an
    // empty result, which is how a proxy error page becomes "no payment".
    const wellFormed = shape === 'claims'
      ? (j && j.ok === true && Array.isArray(j.claims))
      : (j && typeof j.state === 'string');
    if (!wellFormed) {
      return { state: STATE.UNREADABLE, message: `unparseable reply (HTTP ${res.status})` };
    }
    return j;
  }
}

/**
 * True only for a definite "this paid us and it is yours now".
 * Deliberately NOT `state !== 'unreadable'` -- that inverts the safe default.
 */
export const isCredit = (r) =>
  r && r.state === STATE.CREDITED && Number.isFinite(Number(r.usd_total)) && Number(r.usd_total) > 0;

/** A message safe to show a customer. Never leaks an internal reason. */
export function humanMessage(r) {
  switch (r && r.state) {
    case STATE.CREDITED:        return 'Payment confirmed and credited.';
    case STATE.ALREADY_CLAIMED: return 'That transaction has already been credited.';
    case STATE.PENDING:         return 'We cannot see that transaction yet. Give it a minute and try again.';
    case STATE.CONFIRMING:      return `Payment seen — waiting for confirmations (${r.confirmations ?? '?'}/${r.required ?? '?'}).`;
    case STATE.NO_PAYMENT:      return 'That transaction did not send wPCN to our payment address.';
    case STATE.REVERTED:        return 'That transaction failed on the blockchain, so nothing was sent.';
    case STATE.REORGED:         return 'That block is being reorganised. Try again shortly.';
    case STATE.BAD_REQUEST:     return 'That does not look like a BSC transaction hash.';
    // The important one. This is NOT "you did not pay" -- it is "we could not
    // check". Saying the wrong thing here makes a paying customer think they
    // were robbed.
    default:                    return 'We could not reach the blockchain just now. '
                                     + 'Your payment is safe — please try again in a minute.';
  }
}
