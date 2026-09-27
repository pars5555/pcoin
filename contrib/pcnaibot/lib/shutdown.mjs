// A deploy lets running work finish (review, 2026-09-27, item C).
//
// There was no SIGTERM handler, so node's default -- exit at once -- cut every running chat turn,
// dropped the in-memory queue and could lose a payment reply, and the unit's `docker stop -t 20`
// grace period was never used. tini (Dockerfile) forwards the signal to node; this is what node
// does with it:
//
//   1. stop taking updates, stop the timers                              (stopIntake)
//   2. start nothing that is queued -- it is durable and runs after the restart (lib/inbox.mjs)
//   3. wait for what is running, at most `timeoutMs` (15 s fits inside the unit's 20 s)
//   4. write the heartbeat, close the database                           (finalize)
//   5. exit 0
//
// A second signal exits at once, with 1.
export const DRAIN_TIMEOUT_MS = 15000;

export async function gracefulStop({ turns, timeoutMs = DRAIN_TIMEOUT_MS, stopIntake, finalize, log }) {
  const t0 = Date.now();
  stopIntake();
  turns.pause();
  log.info('shutdown: draining', { running: turns.running.size, queued: turns.waiting.length, timeoutMs });
  const drained = await turns.drain(timeoutMs);
  const ms = Date.now() - t0;
  if (drained) log.info('shutdown: every running turn finished', { ms });
  else log.warn('shutdown: drain timed out; unfinished turns are reported to their users on the next start', { left: turns.running.size, ms });
  await finalize();
  return { drained, ms };
}

export function installShutdown({ proc = process, stop, log, exit = (code) => process.exit(code) }) {
  let stopping = false;
  const onSignal = (sig) => {
    if (stopping) {
      log.warn('shutdown: second signal; exiting now', { sig });
      exit(1);
      return;
    }
    stopping = true;
    log.info('shutdown: signal received', { sig });
    Promise.resolve()
      .then(() => stop(sig))
      .then(() => exit(0), (e) => { log.error('shutdown failed', { error: String(e?.message ?? e) }); exit(1); });
  };
  proc.on('SIGTERM', onSignal);
  proc.on('SIGINT', onSignal);
  return { isStopping: () => stopping };
}
