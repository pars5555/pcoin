// Work in flight, with a ceiling, and a queue in front of it -- so THE POLL LOOP NEVER WAITS.
//
// The loop used to `await` a free slot before starting a chat turn. That held every later update
// until some turn finished -- including a Stars pre_checkout_query, which Telegram wants answered
// within 10 seconds or it fails the payment on the user's screen. webcrafter (webbuilderbot) cannot
// hit this, because its webhook handles each update in its own request; this is the same property
// for a long-polling loop (2026-09-27, owner: "do the same" as webcrafter's Stars).
//
// track(p)     counts a promise already running (a button's background work, a turn)
// submit(fn)   runs fn() now if there is room, otherwise when something finishes; FIFO
// pause()      starts nothing more -- for a shutdown; what waits is durable (lib/inbox.mjs)
// drain(ms)    resolves when nothing is running, or after `ms`; true if nothing is running
export function turnQueue(max) {
  const running = new Set();
  const waiting = [];
  let paused = false;
  const settle = (p) => { p.finally(() => { running.delete(p); pump(); }).catch(() => undefined); return p; };
  function pump() {
    while (!paused && waiting.length && running.size < max) {
      const fn = waiting.shift();
      const p = Promise.resolve().then(fn);
      running.add(p);
      settle(p);
    }
  }
  return {
    running,
    waiting,
    track(p) { running.add(p); return settle(p); },
    submit(fn) { waiting.push(fn); pump(); },
    pause() { paused = true; },
    get paused() { return paused; },
    async drain(timeoutMs) {
      let timer;
      const timeout = new Promise((r) => { timer = setTimeout(r, timeoutMs); });
      // Work tracked while draining (a reply being sent) is waited for too.
      const idle = (async () => { while (running.size) await Promise.allSettled([...running]); })();
      await Promise.race([idle, timeout]);
      clearTimeout(timer);
      return running.size === 0;
    },
  };
}
