/**
 * Unit tests for fetch-timeout retry utilities.
 *
 * Tests pure helper functions (env parsing, delay computation)
 * without requiring real network calls.
 */
import { describe, expect, it } from 'vitest';

import {
  computeRetryDelayMs,
  getRetryDelayMs,
  getRetryMaxAttempts,
  getTimeoutMs,
} from '../../src/services/fetch-timeout';

describe('getTimeoutMs', () => {
  it('returns default when env is undefined', () => {
    expect(getTimeoutMs(undefined, 5000)).toBe(5000);
  });

  it('returns default when env is empty', () => {
    expect(getTimeoutMs('', 5000)).toBe(5000);
  });

  it('parses valid integer', () => {
    expect(getTimeoutMs('10000', 5000)).toBe(10000);
  });

  it('returns default for non-numeric', () => {
    expect(getTimeoutMs('abc', 5000)).toBe(5000);
  });

  it('returns default for zero', () => {
    expect(getTimeoutMs('0', 5000)).toBe(5000);
  });

  it('returns default for negative', () => {
    expect(getTimeoutMs('-100', 5000)).toBe(5000);
  });
});

describe('getRetryMaxAttempts', () => {
  it('returns default when env is undefined', () => {
    expect(getRetryMaxAttempts(undefined, 3)).toBe(3);
  });

  it('parses valid integer', () => {
    expect(getRetryMaxAttempts('5', 3)).toBe(5);
  });

  it('allows zero (no retries)', () => {
    expect(getRetryMaxAttempts('0', 3)).toBe(0);
  });

  it('returns default for negative', () => {
    expect(getRetryMaxAttempts('-1', 3)).toBe(3);
  });
});

describe('getRetryDelayMs', () => {
  it('returns default when env is undefined', () => {
    expect(getRetryDelayMs(undefined, 1000)).toBe(1000);
  });

  it('parses valid integer', () => {
    expect(getRetryDelayMs('2000', 1000)).toBe(2000);
  });

  it('allows zero delay', () => {
    expect(getRetryDelayMs('0', 1000)).toBe(0);
  });
});

describe('computeRetryDelayMs', () => {
  it('returns at least baseDelay for attempt 0', () => {
    const delay = computeRetryDelayMs(0, 1000, 30000);
    // base (1000) + jitter (0-25%) = 1000-1250
    expect(delay).toBeGreaterThanOrEqual(1000);
    expect(delay).toBeLessThanOrEqual(1250);
  });

  it('doubles delay with each attempt (exponential)', () => {
    // At attempt 3, exponential = 1000 * 2^3 = 8000
    // With jitter: 8000-10000
    const delay = computeRetryDelayMs(3, 1000, 30000);
    expect(delay).toBeGreaterThanOrEqual(8000);
    expect(delay).toBeLessThanOrEqual(10000);
  });

  it('caps at maxDelayMs', () => {
    const delay = computeRetryDelayMs(20, 1000, 5000);
    // capped at 5000 + jitter (0-25%) = 5000-6250
    expect(delay).toBeGreaterThanOrEqual(5000);
    expect(delay).toBeLessThanOrEqual(6250);
  });

  it('handles zero base delay', () => {
    const delay = computeRetryDelayMs(5, 0, 30000);
    expect(delay).toBe(0);
  });
});
