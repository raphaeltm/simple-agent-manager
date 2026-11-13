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
 */

/**
 * Margin past a flight's own deadline before the joiner gives up on it. Internal safety margin,
 * not an operator setting: it only has to outlast the starter's own deadline timer.
 */
export const DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS = 1_000;

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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abandoned = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new SharedFlightAbandonedError()),
      Math.max(0, deadlineAt - now) + graceMs
    );
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
