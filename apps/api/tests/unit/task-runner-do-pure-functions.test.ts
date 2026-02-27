/**
 * Behavioral unit tests for TaskRunner DO pure functions.
 *
 * These tests call the actual exported functions and verify their return
 * values — not string matching against source code.
 */
import { describe, it, expect } from 'vitest';
import {
  parseEnvInt,
  computeBackoffMs,
  isTransientError,
} from '../../src/durable-objects/task-runner-helpers';

// =============================================================================
// parseEnvInt
// =============================================================================

describe('parseEnvInt', () => {
  it('returns fallback when value is undefined', () => {
    expect(parseEnvInt(undefined, 42)).toBe(42);
  });

  it('returns fallback when value is empty string', () => {
    expect(parseEnvInt('', 42)).toBe(42);
  });

  it('parses valid integer string', () => {
    expect(parseEnvInt('100', 42)).toBe(100);
  });

  it('returns fallback for non-numeric string', () => {
    expect(parseEnvInt('abc', 42)).toBe(42);
  });

  it('returns fallback for zero', () => {
    // parseEnvInt requires > 0
    expect(parseEnvInt('0', 42)).toBe(42);
  });

  it('returns fallback for negative numbers', () => {
    expect(parseEnvInt('-5', 42)).toBe(42);
  });

  it('returns fallback for NaN-producing strings', () => {
    expect(parseEnvInt('NaN', 42)).toBe(42);
  });

  it('returns fallback for Infinity', () => {
    expect(parseEnvInt('Infinity', 42)).toBe(42);
  });

  it('parses integers with trailing non-numeric characters', () => {
    // parseInt('123abc', 10) returns 123
    expect(parseEnvInt('123abc', 42)).toBe(123);
  });

  it('returns fallback for float-only strings like "0.5"', () => {
    // parseInt('0.5', 10) returns 0, which is not > 0
    expect(parseEnvInt('0.5', 42)).toBe(42);
  });

  it('parses large integers', () => {
    expect(parseEnvInt('1000000', 42)).toBe(1000000);
  });
});

// =============================================================================
// computeBackoffMs
// =============================================================================

describe('computeBackoffMs', () => {
  it('returns base delay for retry 0', () => {
    expect(computeBackoffMs(0, 5000, 60000)).toBe(5000);
  });

  it('doubles delay for each retry', () => {
    expect(computeBackoffMs(1, 5000, 60000)).toBe(10000);
    expect(computeBackoffMs(2, 5000, 60000)).toBe(20000);
    expect(computeBackoffMs(3, 5000, 60000)).toBe(40000);
  });

  it('caps at max delay', () => {
    expect(computeBackoffMs(4, 5000, 60000)).toBe(60000); // 5000 * 16 = 80000, capped at 60000
    expect(computeBackoffMs(10, 5000, 60000)).toBe(60000);
  });

  it('returns base when maxDelay equals base', () => {
    expect(computeBackoffMs(0, 5000, 5000)).toBe(5000);
    expect(computeBackoffMs(1, 5000, 5000)).toBe(5000);
  });

  it('handles base delay of 1ms', () => {
    expect(computeBackoffMs(0, 1, 1000)).toBe(1);
    expect(computeBackoffMs(10, 1, 1000)).toBe(1000); // 1 * 1024 = 1024, capped at 1000
  });

  it('returns maxDelay when base * 2^retry exceeds it', () => {
    expect(computeBackoffMs(20, 1000, 30000)).toBe(30000);
  });
});

// =============================================================================
// isTransientError
// =============================================================================

describe('isTransientError', () => {
  // --- Non-Error inputs ---
  it('returns false for non-Error values', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(42)).toBe(false);
    expect(isTransientError({})).toBe(false);
  });

  // --- Permanent flag (C1 fix) ---
  it('returns false when error has permanent: true flag', () => {
    const err = Object.assign(new Error('Node agent not ready within 120000ms'), {
      permanent: true,
    });
    expect(isTransientError(err)).toBe(false);
  });

  it('returns false when permanent flag is set even for transient-looking messages', () => {
    // A network-looking message but explicitly marked permanent
    const err = Object.assign(new Error('fetch failed permanently'), {
      permanent: true,
    });
    expect(isTransientError(err)).toBe(false);
  });

  it('treats errors without permanent flag normally', () => {
    const err = Object.assign(new Error('some error'), { permanent: false });
    // permanent is false, so falls through to message matching
    // "some error" doesn't match any specific pattern → default transient
    expect(isTransientError(err)).toBe(true);
  });

  // --- Network/timeout errors (transient) ---
  it('classifies "fetch failed" as transient', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
  });

  it('classifies "network error" as transient', () => {
    expect(isTransientError(new Error('network error'))).toBe(true);
  });

  it('classifies "timeout" as transient', () => {
    expect(isTransientError(new Error('request timeout'))).toBe(true);
  });

  it('classifies "ECONNREFUSED" as transient', () => {
    expect(isTransientError(new Error('connect ECONNREFUSED'))).toBe(true);
  });

  it('classifies "ENOTFOUND" as transient', () => {
    expect(isTransientError(new Error('getaddrinfo ENOTFOUND'))).toBe(true);
  });

  // --- HTTP status errors ---
  it('classifies 429 rate limit as transient', () => {
    expect(isTransientError(new Error('HTTP 429 Too Many Requests'))).toBe(true);
  });

  it('classifies "rate limit" as transient', () => {
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('classifies 500 as transient', () => {
    expect(isTransientError(new Error('HTTP 500 Internal Server Error'))).toBe(true);
  });

  it('classifies 502 as transient', () => {
    expect(isTransientError(new Error('HTTP 502 Bad Gateway'))).toBe(true);
  });

  it('classifies 503 as transient', () => {
    expect(isTransientError(new Error('HTTP 503 Service Unavailable'))).toBe(true);
  });

  // --- Permanent errors ---
  it('classifies "not found" as permanent', () => {
    expect(isTransientError(new Error('Resource not found'))).toBe(false);
  });

  it('classifies "not_found" as permanent', () => {
    expect(isTransientError(new Error('NOT_FOUND'))).toBe(false);
  });

  it('classifies "limit_exceeded" as permanent', () => {
    expect(isTransientError(new Error('limit_exceeded: max nodes reached'))).toBe(false);
  });

  it('classifies "invalid" as permanent', () => {
    expect(isTransientError(new Error('invalid configuration'))).toBe(false);
  });

  it('classifies "forbidden" as permanent', () => {
    expect(isTransientError(new Error('forbidden: access denied'))).toBe(false);
  });

  it('classifies "unauthorized" as permanent', () => {
    expect(isTransientError(new Error('unauthorized'))).toBe(false);
  });

  // --- Default behavior ---
  it('defaults to transient for unknown error messages', () => {
    expect(isTransientError(new Error('something unexpected happened'))).toBe(true);
  });

  // --- Real-world error patterns from step handlers ---
  it('classifies "Specified node is not available" with permanent flag', () => {
    const err = Object.assign(new Error('Specified node is not available'), {
      permanent: true,
    });
    expect(isTransientError(err)).toBe(false);
  });

  it('classifies "Maximum 10 nodes allowed" with permanent flag', () => {
    const err = Object.assign(
      new Error('Maximum 10 nodes allowed. Cannot auto-provision.'),
      { permanent: true },
    );
    expect(isTransientError(err)).toBe(false);
  });

  it('classifies "Workspace creation failed" with permanent flag', () => {
    const err = Object.assign(new Error('Workspace creation failed'), {
      permanent: true,
    });
    expect(isTransientError(err)).toBe(false);
  });

  it('classifies "Node provisioning failed" as transient (retryable)', () => {
    // No permanent flag, message doesn't match permanent patterns
    expect(isTransientError(new Error('Node provisioning failed'))).toBe(true);
  });
});
