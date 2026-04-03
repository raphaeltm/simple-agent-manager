/**
 * Behavioral tests for TaskRunner DO helper functions.
 *
 * Tests the actual exported functions instead of reading source code as strings.
 */
import { describe, expect, it } from 'vitest';

import {
  computeBackoffMs,
  isTransientError,
  parseEnvInt,
} from '../../src/durable-objects/task-runner/helpers';

describe('parseEnvInt', () => {
  it('returns fallback for undefined input', () => {
    expect(parseEnvInt(undefined, 42)).toBe(42);
  });

  it('returns fallback for empty string', () => {
    expect(parseEnvInt('', 42)).toBe(42);
  });

  it('parses valid integer strings', () => {
    expect(parseEnvInt('100', 42)).toBe(100);
    expect(parseEnvInt('1', 0)).toBe(1);
  });

  it('returns fallback for non-numeric strings', () => {
    expect(parseEnvInt('abc', 42)).toBe(42);
    expect(parseEnvInt('NaN', 42)).toBe(42);
  });

  it('returns fallback for zero (not positive)', () => {
    expect(parseEnvInt('0', 42)).toBe(42);
  });

  it('returns fallback for negative numbers', () => {
    expect(parseEnvInt('-5', 42)).toBe(42);
  });

  it('returns fallback for Infinity', () => {
    expect(parseEnvInt('Infinity', 42)).toBe(42);
  });

  it('parses integers with leading/trailing whitespace from parseInt behavior', () => {
    // parseInt('  10  ', 10) returns 10
    expect(parseEnvInt('  10  ', 42)).toBe(10);
  });
});

describe('computeBackoffMs', () => {
  it('returns base delay for first retry (retryCount=0)', () => {
    expect(computeBackoffMs(0, 1000, 60000)).toBe(1000);
  });

  it('doubles delay for each retry (exponential)', () => {
    expect(computeBackoffMs(1, 1000, 60000)).toBe(2000);
    expect(computeBackoffMs(2, 1000, 60000)).toBe(4000);
    expect(computeBackoffMs(3, 1000, 60000)).toBe(8000);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoffMs(10, 1000, 5000)).toBe(5000);
    expect(computeBackoffMs(20, 1000, 5000)).toBe(5000);
  });

  it('handles zero base delay', () => {
    expect(computeBackoffMs(5, 0, 60000)).toBe(0);
  });
});

describe('isTransientError', () => {
  it('returns false for non-Error values', () => {
    expect(isTransientError('string error')).toBe(false);
    expect(isTransientError(null)).toBe(false);
    expect(isTransientError(undefined)).toBe(false);
    expect(isTransientError(42)).toBe(false);
  });

  it('returns false for errors with permanent flag', () => {
    const err = Object.assign(new Error('some error'), { permanent: true });
    expect(isTransientError(err)).toBe(false);
  });

  it('classifies network errors as transient', () => {
    expect(isTransientError(new Error('fetch failed'))).toBe(true);
    expect(isTransientError(new Error('network error'))).toBe(true);
    expect(isTransientError(new Error('request timeout'))).toBe(true);
    expect(isTransientError(new Error('ECONNREFUSED'))).toBe(true);
    expect(isTransientError(new Error('ENOTFOUND'))).toBe(true);
  });

  it('classifies rate limit errors as transient', () => {
    expect(isTransientError(new Error('429 Too Many Requests'))).toBe(true);
    expect(isTransientError(new Error('rate limit exceeded'))).toBe(true);
  });

  it('classifies 5xx errors as transient', () => {
    expect(isTransientError(new Error('500 Internal Server Error'))).toBe(true);
    expect(isTransientError(new Error('502 Bad Gateway'))).toBe(true);
    expect(isTransientError(new Error('503 Service Unavailable'))).toBe(true);
  });

  it('classifies not_found errors as permanent', () => {
    expect(isTransientError(new Error('resource not found'))).toBe(false);
    expect(isTransientError(new Error('NOT_FOUND'))).toBe(false);
  });

  it('classifies auth errors as permanent', () => {
    expect(isTransientError(new Error('forbidden'))).toBe(false);
    expect(isTransientError(new Error('unauthorized'))).toBe(false);
  });

  it('classifies validation errors as permanent', () => {
    expect(isTransientError(new Error('invalid input'))).toBe(false);
    expect(isTransientError(new Error('limit_exceeded'))).toBe(false);
  });

  it('defaults to transient for unknown errors', () => {
    expect(isTransientError(new Error('something unexpected happened'))).toBe(true);
  });

  it('permanent flag takes precedence over message matching', () => {
    // Message says "network error" (transient), but permanent flag is set
    const err = Object.assign(new Error('network error'), { permanent: true });
    expect(isTransientError(err)).toBe(false);
  });
});
