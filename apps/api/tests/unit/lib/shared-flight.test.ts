/**
 * Joining another request's in-flight promise under the joiner's own timer (src/lib/shared-flight.ts).
 * On celld a flight whose starter's client disconnected never settles; the joiner must not wait
 * past the flight's deadline plus the grace. The real-runtime proof is
 * scripts/selfhost/live/shared-flight-cancel.live.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS,
  joinSharedFlight,
  settleSharedFlight,
  SharedFlightAbandonedError,
} from '../../../src/lib/shared-flight';

const never = () => new Promise<never>(() => undefined);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('joinSharedFlight', () => {
  it('returns a live flight’s value and leaves no timer behind', async () => {
    const now = Date.now();
    await expect(joinSharedFlight(Promise.resolve('v'), now + 5000, now)).resolves.toBe('v');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('passes a live flight’s own failure through unchanged', async () => {
    const failure = new Error('read failed');
    const now = Date.now();
    await expect(joinSharedFlight(Promise.reject(failure), now + 5000, now)).rejects.toBe(failure);
  });

  it('reports a flight that never settles as abandoned at deadline plus grace, not before', async () => {
    const now = Date.now();
    const joined = joinSharedFlight(never(), now + 5000, now);
    const outcome = joined.then(
      () => 'resolved',
      (error: unknown) => error
    );
    await vi.advanceTimersByTimeAsync(5000 + DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS - 1);
    let settled = false;
    void outcome.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBeInstanceOf(SharedFlightAbandonedError);
  });

  it('gives a flight already past its deadline only the grace', async () => {
    const now = Date.now();
    const outcome = settleSharedFlight(never(), now - 10_000, now);
    await vi.advanceTimersByTimeAsync(DEFAULT_SHARED_FLIGHT_JOIN_GRACE_MS);
    await expect(outcome).resolves.toEqual({ abandoned: true });
  });

  it('settleSharedFlight returns the value of a live flight and rethrows its failure', async () => {
    const now = Date.now();
    await expect(settleSharedFlight(Promise.resolve(3), now + 10, now)).resolves.toEqual({
      abandoned: false,
      value: 3,
    });
    const failure = new Error('x');
    await expect(settleSharedFlight(Promise.reject(failure), now + 10, now)).rejects.toBe(failure);
  });
});
