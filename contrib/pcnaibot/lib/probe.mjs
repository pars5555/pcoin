// Model probing -- asking each model whether it can actually be used.
//
// THE TWO THINGS NOTHING ELSE TELLS YOU, both measured live on 2026-09-11:
//
// 1. /v1/models IS NOT AUTHORITATIVE FOR REACHABILITY. It listed all 24 pool
//    models, and the diff against registry.oonacode was EMPTY -- yet all three
//    Claude models refuse at call time as "served by a subscription
//    credential... only from the Claude Code engine". A user who picked one
//    would have a reservation taken and released on every turn, forever.
//
// 2. max_tokens DOES NOT BOUND OUTPUT on every model. qwen3.7-max returned
//    9,085 output tokens against max_tokens=32 -- 284x -- while still reporting
//    stop_reason "max_tokens". Since max_tokens is the ONLY thing bounding the
//    reservation, and a settle that overruns is BILLED IN FULL and never
//    clamped, that overrun lands on the customer's balance.
//
// Neither is in the registry, in /v1/models, or in `notes`. So we ask.
//
// A check that only prints is not a check: a model that fails either probe is
// removed from the billable set, not merely logged.

import { nowSec } from './time.mjs';
import { log } from './log.mjs';
import { UpstreamError, Bucket } from './oonacode.mjs';

// Deliberately small. The prompt ASKS FOR A LONG ANSWER so that a model which
// ignores max_tokens reveals itself -- a short prompt would stop naturally and
// prove nothing.
export const PROBE_CAP = 32;
const PROBE_PROMPT = 'Write a detailed 500-word essay about the history of the bicycle.';

// Allow a little slack: some providers count a stop token or a leading
// whitespace token beyond the cap. 2x is far below the 284x we are guarding
// against and far above any honest off-by-a-few.
export const OVERRUN_TOLERANCE = 2;

export async function probeModel(client, modelId) {
  const at = nowSec();
  try {
    const resp = await client.messages({
      model: modelId,
      max_tokens: PROBE_CAP,
      messages: [{ role: 'user', content: PROBE_PROMPT }],
    });

    const out = resp?.usage?.output_tokens;
    if (!Number.isInteger(out)) {
      // We cannot see what it did. That is not a pass.
      return { ok: false, bounded: null, overrun: null, at,
               note: 'usage.output_tokens absent from the probe reply' };
    }

    const ratio = out / PROBE_CAP;
    const bounded = out <= PROBE_CAP * OVERRUN_TOLERANCE;
    return {
      ok: true,
      bounded,
      overrun: ratio,
      at,
      note: bounded ? null
        : `returned ${out} output tokens against max_tokens=${PROBE_CAP} (${ratio.toFixed(1)}x); max_tokens does not bound this model`,
    };
  } catch (e) {
    if (e instanceof UpstreamError) {
      // ONLY A PERMANENT FAILURE IS A VERDICT ON THE MODEL.
      //
      // BACKOFF (429/503) and UNKNOWN mean "we did not get an answer", which
      // says nothing about whether the model works. Treating them as a refusal
      // cost a real demotion on 2026-09-11: nvidia/nemotron-3-super-120b-a12b
      // was dropped from the menu by a single HTTP 503 "Service temporarily
      // overloaded" -- one of only TWO free models, gone until the next daily
      // re-probe, because the gateway was busy for a moment.
      //
      // This is the same rule as everywhere else in this codebase: a failed
      // read resolves nothing. `ok: null` leaves the previous verdict standing.
      if (e.bucket === Bucket.BACKOFF || e.bucket === Bucket.UNKNOWN) {
        return { ok: null, bounded: null, overrun: null, at,
                 note: `probe inconclusive (${e.bucket}): ${e.message.slice(0, 120)}` };
      }
      const subscriptionOnly = /subscription credential/i.test(e.message);
      return {
        ok: false,
        bounded: null,
        overrun: null,
        at,
        note: subscriptionOnly
          ? 'subscription-only: this model cannot be reached with an API key, whatever /v1/models says'
          : `probe failed: ${e.message.slice(0, 160)}`,
      };
    }
    // An infrastructure failure is NOT a verdict on the model either.
    return { ok: null, bounded: null, overrun: null, at, note: `probe inconclusive: ${e.message.slice(0, 120)}` };
  }
}

export function storeProbe(db, modelId, r) {
  // ok === null means INCONCLUSIVE -- write nothing, keep what we knew.
  if (r.ok === null) return false;
  db.prepare(
    `UPDATE model_prices
        SET probe_ok = ?, probe_bounded = ?, probe_overrun_x = ?, probe_note = ?, probed_at = ?
      WHERE model = ?`
  ).run(
    r.ok ? 1 : 0,
    r.bounded === null ? null : (r.bounded ? 1 : 0),
    r.overrun === null ? null : r.overrun.toFixed(2),
    r.note,
    r.at,
    modelId
  );
  return true;
}

export async function probeAll(db, client, modelIds, { retryInconclusive = true } = {}) {
  const results = [];
  for (const id of modelIds) {
    let r = await probeModel(client, id);

    // One retry on an inconclusive result, after a short pause. A model that is
    // merely never probed stays unsellable (billableSet requires probe_ok === 1),
    // so an inconclusive first attempt on a FIRST run would silently keep a good
    // model off the menu -- the retry is what stops "busy for a second" becoming
    // "absent all day".
    if (r.ok === null && retryInconclusive) {
      await new Promise((res) => setTimeout(res, 3000));
      const again = await probeModel(client, id);
      if (again.ok !== null) r = again;
    }

    storeProbe(db, id, r);
    results.push({ model: id, ...r });

    if (r.ok === false) {
      log.error('model REMOVED from the billable set by probe', { model: id, note: r.note });
    } else if (r.bounded === false) {
      log.error('model REMOVED from the billable set: max_tokens does not bound it', {
        model: id, overrun: r.overrun?.toFixed(1), note: r.note,
      });
    } else if (r.ok === null) {
      // Inconclusive is NOT a pass and NOT a failure. Say which it is.
      log.warn('model probe INCONCLUSIVE; previous verdict left standing', { model: id, note: r.note });
    }
  }
  return results;
}
