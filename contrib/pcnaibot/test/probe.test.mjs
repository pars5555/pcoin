// The startup probe must clean up every session it makes.
//
// A probe session is never written to agent_sessions, so nothing but the probe itself will delete
// it: one that survives is found by reconcileRemote an hour later and logged as a leak "we have
// NO RECORD OF". That fired on every restart (2026-09-25) because a failed delete was swallowed.

import test from 'node:test';
import assert from 'node:assert/strict';

import { dropProbeSession, probeAgentModel } from '../lib/probe.mjs';

test('a delete that does not confirm is retried until it does', async () => {
  const answers = [false, new Error('socket hang up'), true];
  const tried = [];
  const client = {
    deleteSession: async (id) => {
      tried.push(id);
      const a = answers.shift();
      if (a instanceof Error) throw a;
      return a;
    },
  };
  assert.equal(await dropProbeSession(client, 'sess-1234', { gapMs: 1 }), true);
  assert.deepEqual(tried, ['sess-1234', 'sess-1234', 'sess-1234']);
});

test('a delete that never confirms says so, and gives up', async () => {
  let n = 0;
  const client = { deleteSession: async () => { n++; return false; } };
  assert.equal(await dropProbeSession(client, 'sess-9999', { attempts: 3, gapMs: 1 }), false);
  assert.equal(n, 3);
});

test('the probe learns its session from the finished run when the stream never named it', async () => {
  // No `session` event at all -- only the run, which carries session_id.
  const client = {
    async *streamRun() {
      yield { type: 'run', run: { status: 'completed', session_id: 'from-run' } };
      yield { type: 'end', ok: true, aborted: false };
    },
  };
  const r = await probeAgentModel(client, 'glm-5.3-flash');
  assert.equal(r.ok, true);
  assert.equal(r.sessionId, 'from-run');
});
