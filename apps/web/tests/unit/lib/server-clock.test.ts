import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordServerTime, serverNow, toDeviceTime } from '../../../src/lib/server-clock';

/**
 * Access countdowns read the server's clock through this module. The offset is module state, so
 * each test sets it and the suite puts it back.
 */
describe('server clock', () => {
  afterEach(() => {
    vi.useRealTimers();
    recordServerTime(Date.now());
  });

  it('reads the server clock from the offset measured when a response arrived', () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    // The server was 5 minutes ahead when the response came in.
    recordServerTime(1_000_000 + 300_000, 1_000_000);

    vi.advanceTimersByTime(60_000);

    expect(serverNow()).toBe(1_060_000 + 300_000);
    // A server end time shown on this device's clock.
    expect(toDeviceTime(1_000_000 + 300_000 + 600_000)).toBe(1_600_000);
  });

  it.each([undefined, null, 'soon', NaN, Number.POSITIVE_INFINITY])(
    'ignores a server time that is not a finite number (%s)',
    (bad) => {
      vi.useFakeTimers();
      vi.setSystemTime(2_000_000);
      recordServerTime(2_000_000 + 1_000, 2_000_000);

      recordServerTime(bad);

      expect(serverNow()).toBe(2_001_000);
    }
  );
});
