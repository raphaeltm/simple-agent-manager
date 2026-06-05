import { describe, expect, it } from 'vitest';

import {
  computeDurableObjectRetryDelayMs,
  DEFAULT_DO_RETRY_BASE_DELAY_MS,
  DEFAULT_DO_RETRY_MAX_ATTEMPTS,
  DEFAULT_DO_RETRY_MAX_DELAY_MS,
  getDurableObjectRetryConfig,
  isTransientDurableObjectError,
} from '../../../src/services/durable-object-retry';

describe('isTransientDurableObjectError', () => {
  it('matches the exact Cloudflare code-update reset string', () => {
    expect(isTransientDurableObjectError(
      new Error('Durable Object reset because its code was updated.')
    )).toBe(true);
  });

  it('matches case variants of the code-update reset string', () => {
    expect(isTransientDurableObjectError(
      new Error('DURABLE OBJECT RESET BECAUSE ITS CODE WAS UPDATED.')
    )).toBe(true);
    expect(isTransientDurableObjectError(
      new Error('durable object reset because its code was updated.')
    )).toBe(true);
  });

  it('matches related Durable Object reset and overload conditions', () => {
    expect(isTransientDurableObjectError(new Error('Durable Object reset'))).toBe(true);
    expect(isTransientDurableObjectError(new Error('Durable Object overloaded'))).toBe(true);
    expect(isTransientDurableObjectError(new Error('overloaded Durable Object instance'))).toBe(true);
  });

  it('does not treat unrelated errors as Durable Object transient errors', () => {
    expect(isTransientDurableObjectError(new Error('database failed'))).toBe(false);
    expect(isTransientDurableObjectError(new Error('reset password token expired'))).toBe(false);
    expect(isTransientDurableObjectError(null)).toBe(false);
  });
});

describe('getDurableObjectRetryConfig', () => {
  it('uses defaults when env values are absent or invalid', () => {
    expect(getDurableObjectRetryConfig({})).toEqual({
      maxAttempts: DEFAULT_DO_RETRY_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_DO_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_DO_RETRY_MAX_DELAY_MS,
    });
    expect(getDurableObjectRetryConfig({
      DO_RETRY_MAX_ATTEMPTS: '0',
      DO_RETRY_BASE_DELAY_MS: 'not-a-number',
      DO_RETRY_MAX_DELAY_MS: '-1',
    })).toEqual({
      maxAttempts: DEFAULT_DO_RETRY_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_DO_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_DO_RETRY_MAX_DELAY_MS,
    });
  });

  it('uses positive integer env overrides', () => {
    expect(getDurableObjectRetryConfig({
      DO_RETRY_MAX_ATTEMPTS: '5',
      DO_RETRY_BASE_DELAY_MS: '25',
      DO_RETRY_MAX_DELAY_MS: '125',
    })).toEqual({
      maxAttempts: 5,
      baseDelayMs: 25,
      maxDelayMs: 125,
    });
  });
});

describe('computeDurableObjectRetryDelayMs', () => {
  it('uses capped per-attempt exponential delay from the configured base', () => {
    expect(computeDurableObjectRetryDelayMs(1, 50, 250)).toBe(50);
    expect(computeDurableObjectRetryDelayMs(2, 50, 250)).toBe(100);
    expect(computeDurableObjectRetryDelayMs(3, 50, 250)).toBe(200);
    expect(computeDurableObjectRetryDelayMs(4, 50, 250)).toBe(250);
    expect(computeDurableObjectRetryDelayMs(5, 50, 250)).toBe(250);
  });
});
