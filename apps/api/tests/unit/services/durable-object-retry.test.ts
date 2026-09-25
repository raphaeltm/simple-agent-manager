import { describe, expect, it } from 'vitest';

import {
  classifyDurableObjectError,
  computeDurableObjectRetryDelayMs,
  DEFAULT_DO_RETRY_BASE_DELAY_MS,
  DEFAULT_DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS,
  DEFAULT_DO_RETRY_MAX_ATTEMPTS,
  DEFAULT_DO_RETRY_MAX_DELAY_MS,
  getDurableObjectRetryConfig,
  isDurableObjectConnectionLostError,
  isDurableObjectCpuLimitResetError,
  isDurableObjectStorageFullError,
  isRetryableForIdempotentDurableObjectOperation,
  isTransientDurableObjectError,
} from '../../../src/services/durable-object-retry';

const CPU_LIMIT_RESET = 'Durable Object exceeded its CPU time limit and was reset.';
const CONNECTION_LOST = 'Network connection lost.';

describe('isTransientDurableObjectError', () => {
  it('matches the exact Cloudflare code-update reset string', () => {
    expect(
      isTransientDurableObjectError(new Error('Durable Object reset because its code was updated.'))
    ).toBe(true);
  });

  it('matches case variants of the code-update reset string', () => {
    expect(
      isTransientDurableObjectError(new Error('DURABLE OBJECT RESET BECAUSE ITS CODE WAS UPDATED.'))
    ).toBe(true);
    expect(
      isTransientDurableObjectError(new Error('durable object reset because its code was updated.'))
    ).toBe(true);
  });

  it('matches related Durable Object reset and overload conditions', () => {
    expect(isTransientDurableObjectError(new Error('Durable Object reset'))).toBe(true);
    expect(isTransientDurableObjectError(new Error('Durable Object overloaded'))).toBe(true);
    expect(isTransientDurableObjectError(new Error('overloaded Durable Object instance'))).toBe(
      true
    );
  });

  it('matches production-shaped Durable Object memory and storage-timeout resets', () => {
    expect(
      isTransientDurableObjectError(
        new Error("Durable Object's isolate exceeded its memory limit and was reset.")
      )
    ).toBe(true);
    expect(
      isTransientDurableObjectError(
        new Error(
          'Durable Object storage operation exceeded timeout which caused object to be reset.'
        )
      )
    ).toBe(true);
  });

  it('does not treat unrelated errors as Durable Object transient errors', () => {
    expect(isTransientDurableObjectError(new Error('database failed'))).toBe(false);
    expect(isTransientDurableObjectError(new Error('reset password token expired'))).toBe(false);
    expect(isTransientDurableObjectError(null)).toBe(false);
  });

  it('does not retry SQLITE_FULL storage limit failures', () => {
    const err = new Error('Durable Object storage operation failed: SQLITE_FULL');
    expect(isDurableObjectStorageFullError(err)).toBe(true);
    expect(isTransientDurableObjectError(err)).toBe(false);
  });
});

describe('isDurableObjectStorageFullError', () => {
  it('matches Cloudflare/SQLite full-storage variants', () => {
    expect(isDurableObjectStorageFullError(new Error('SQLITE_FULL'))).toBe(true);
    expect(isDurableObjectStorageFullError(new Error('database or disk is full'))).toBe(true);
    expect(isDurableObjectStorageFullError(new Error('Exceeded the maximum database size.'))).toBe(
      true
    );
    expect(isDurableObjectStorageFullError(new Error('sqlite full while inserting'))).toBe(true);
  });

  it('does not match unrelated SQLite failures', () => {
    expect(isDurableObjectStorageFullError(new Error('SQLITE_BUSY'))).toBe(false);
    expect(isDurableObjectStorageFullError(new Error('database locked'))).toBe(false);
  });
});

describe('getDurableObjectRetryConfig', () => {
  it('uses defaults when env values are absent or invalid', () => {
    expect(getDurableObjectRetryConfig({})).toEqual({
      maxAttempts: DEFAULT_DO_RETRY_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_DO_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_DO_RETRY_MAX_DELAY_MS,
      connectionLostMaxAttempts: DEFAULT_DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS,
    });
    expect(
      getDurableObjectRetryConfig({
        DO_RETRY_MAX_ATTEMPTS: '0',
        DO_RETRY_BASE_DELAY_MS: 'not-a-number',
        DO_RETRY_MAX_DELAY_MS: '-1',
        DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS: '0',
      })
    ).toEqual({
      maxAttempts: DEFAULT_DO_RETRY_MAX_ATTEMPTS,
      baseDelayMs: DEFAULT_DO_RETRY_BASE_DELAY_MS,
      maxDelayMs: DEFAULT_DO_RETRY_MAX_DELAY_MS,
      connectionLostMaxAttempts: DEFAULT_DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS,
    });
  });

  it('uses positive integer env overrides', () => {
    expect(
      getDurableObjectRetryConfig({
        DO_RETRY_MAX_ATTEMPTS: '5',
        DO_RETRY_BASE_DELAY_MS: '25',
        DO_RETRY_MAX_DELAY_MS: '125',
        DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS: '4',
      })
    ).toEqual({
      maxAttempts: 5,
      baseDelayMs: 25,
      maxDelayMs: 125,
      connectionLostMaxAttempts: 4,
    });
  });

  it('never lets the lost-connection budget exceed the general one', () => {
    expect(
      getDurableObjectRetryConfig({
        DO_RETRY_MAX_ATTEMPTS: '2',
        DO_RETRY_CONNECTION_LOST_MAX_ATTEMPTS: '6',
      }).connectionLostMaxAttempts
    ).toBe(2);
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

describe('CPU-limit reset and lost-connection classification', () => {
  it("matches Cloudflare's exact CPU-limit reset text and nothing looser", () => {
    expect(isDurableObjectCpuLimitResetError(new Error(CPU_LIMIT_RESET))).toBe(true);
    expect(isDurableObjectCpuLimitResetError(CPU_LIMIT_RESET.toUpperCase())).toBe(true);
    expect(isDurableObjectCpuLimitResetError(new Error('Worker exceeded CPU time limit.'))).toBe(
      false
    );
  });

  it('matches the exact lost-connection text only', () => {
    expect(isDurableObjectConnectionLostError(new Error(CONNECTION_LOST))).toBe(true);
    expect(isDurableObjectConnectionLostError({ message: ' network connection lost ' })).toBe(true);
    expect(isDurableObjectConnectionLostError(new Error('Network connection lost to D1'))).toBe(
      false
    );
  });

  it('does not widen the shared transient predicate that mutation retries use (rule 67)', () => {
    expect(isTransientDurableObjectError(new Error(CPU_LIMIT_RESET))).toBe(false);
    expect(isTransientDurableObjectError(new Error(CONNECTION_LOST))).toBe(false);
  });

  it('lets idempotent operations retry every object-level failure except a full database', () => {
    expect(isRetryableForIdempotentDurableObjectOperation(new Error(CPU_LIMIT_RESET))).toBe(true);
    expect(isRetryableForIdempotentDurableObjectOperation(new Error(CONNECTION_LOST))).toBe(true);
    expect(
      isRetryableForIdempotentDurableObjectOperation(
        new Error('Durable Object reset because its code was updated.')
      )
    ).toBe(true);
    expect(isRetryableForIdempotentDurableObjectOperation(new Error('SQLITE_FULL'))).toBe(false);
    expect(isRetryableForIdempotentDurableObjectOperation(new Error('no such table: x'))).toBe(
      false
    );
  });

  it('classifies failures into stable, message-free codes', () => {
    expect(classifyDurableObjectError(new Error(CPU_LIMIT_RESET))).toBe('cpu_limit_reset');
    expect(classifyDurableObjectError(new Error(CONNECTION_LOST))).toBe('connection_lost');
    expect(classifyDurableObjectError(new Error('SQLITE_FULL'))).toBe('storage_full');
    expect(
      classifyDurableObjectError(
        new Error('Durable Object is overloaded. Requests queued for too long.')
      )
    ).toBe('transient');
    expect(classifyDurableObjectError(new Error('boom'))).toBeNull();
  });
});
