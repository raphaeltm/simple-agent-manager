/**
 * Joining a promise that another request started (a per-isolate "in-flight" cache entry).
 *
 * On Cloudflare a shared flight settles by its own deadline. On the self-hosted celld runtime
 * (0.6.3) every async op (fetch, D1 call, setTimeout) belongs to the request that started it, and
 * celld drops the op when that request's client disconnects: the flight never settles, and the
 * deadline timer its starter set is dropped with it. A request that joined it would wait until
 * its own client gave up or celld's 300 s handler budget ran out (task H2, the one-minute hangs
 * on the self-host box; scripts/selfhost/live/shared-flight-cancel.live.test.ts).
 *
 * `joinSharedFlight` waits under a timer the JOINING request owns, until the flight's own
 * deadline plus a grace, then reports the flight abandoned so the caller can start its own. A
 * live flight always settles at its deadline, before this timer, so callers on Cloudflare see
 * exactly the result they saw before.
 *
 * The joiner must also never RESUME on the flight's settlement. On celld the code that runs when
 * a promise settles belongs to the request whose op settled it, so a joiner that simply awaited
 * the flight continued as part of the starter's request: every D1 call, fetch and timer it made
 * afterwards was dropped as soon as the starter answered, and the joiner hung with no abort
 * anywhere (task R6 on the box: authenticated requests hung to the client cap after #2706). So
 * on celld the flight's settlement only records the outcome, and the joiner wakes on its own short
 * timer.
 * scripts/selfhost/live/shared-flight-cancel.live.test.ts covers both cases on the real runtime.
 */

/**
 * Margin past a flight's own deadline before the joiner gives up on it. Internal safety margin,
 * not an operator setting: it only has to outlast the starter's own deadline timer.
 */
export const DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS = 1_000;

/**
 * How often a joiner checks whether the flight has settled. Internal, not an operator setting: it
 * bounds the latency a joiner adds (only when it joins a read still in flight), and each check is
 * one timer with no I/O.
 */
export const SHARED_FLIGHT_POLL_MS = 10;

/**
 * Whether a joiner resumes on its own timer instead of on the flight's settlement. Only the celld
 * runtime needs it: the generated celld entry module turns it on at startup
 * (scripts/selfhost/celld-project.ts), so Cloudflare keeps resuming joiners directly, with no
 * added timer or latency.
 */
let resumeOnOwnTimer = false;

/** Called once by the celld entry module, before any request runs. */
export function resumeSharedFlightJoinsOnOwnTimer(): void {
  resumeOnOwnTimer = true;
}

/** Test seam: the mode the celld entry module selects, or back to the Cloudflare default. */
export function __setSharedFlightResumeOnOwnTimerForTest(enabled: boolean): void {
  resumeOnOwnTimer = enabled;
}

/** The flight did not settle by its deadline: its starter's request is gone. Start your own. */
export class SharedFlightAbandonedError extends Error {
  constructor() {
    super('A shared in-flight read did not settle by its deadline');
    this.name = 'SharedFlightAbandonedError';
  }
}

/**
 * `flight`'s result, or `SharedFlightAbandonedError` once `deadlineAt + graceMs` passes.
 * `now` is the caller's clock for `deadlineAt`; the wait itself is a real timer.
 */
export async function joinSharedFlight<T>(
  flight: Promise<T>,
  deadlineAt: number,
  now: number = Date.now(),
  graceMs: number = DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS
): Promise<T> {
  const waitMs = Math.max(0, deadlineAt - now) + graceMs;
  if (!resumeOnOwnTimer) return await raceOwnTimer(flight, waitMs);
  const giveUpAt = Date.now() + waitMs;
  const state: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
  // These callbacks run in the turn of whoever settles the flight. They only record the outcome:
  // no I/O, no timers, no awaits, so nothing of the joiner's is created on the starter's behalf.
  flight.then(
    (value) => (state.outcome = { ok: true, value }),
    (error: unknown) => (state.outcome = { ok: false, error })
  );
  // An already-settled flight is recorded by now, still in this request's own turn: no timer.
  await null;
  while (!state.outcome) {
    const remaining = giveUpAt - Date.now();
    if (remaining <= 0) throw new SharedFlightAbandonedError();
    // A timer this request owns: the code after it, and everything that code starts, is ours.
    await new Promise<void>((resume) =>
      setTimeout(resume, Math.min(SHARED_FLIGHT_POLL_MS, remaining))
    );
  }
  if (state.outcome.ok) return state.outcome.value;
  throw state.outcome.error;
}

/** Cloudflare: the flight's settlement resumes the joiner; the joiner's timer only bounds it. */
async function raceOwnTimer<T>(flight: Promise<T>, waitMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new SharedFlightAbandonedError()), waitMs);
  });
  try {
    return await Promise.race([flight, abandoned]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `joinSharedFlight` for callers that retry: `abandoned` instead of a thrown abandonment. */
export async function settleSharedFlight<T>(
  flight: Promise<T>,
  deadlineAt: number,
  now: number = Date.now()
): Promise<{ abandoned: true } | { abandoned: false; value: T }> {
  try {
    return { abandoned: false, value: await joinSharedFlight(flight, deadlineAt, now) };
  } catch (error) {
    if (error instanceof SharedFlightAbandonedError) return { abandoned: true };
    throw error;
  }
}
