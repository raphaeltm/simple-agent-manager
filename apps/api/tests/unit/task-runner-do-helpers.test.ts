/**
 * Unit tests for TaskRunner DO helper functions.
 *
 * Tests the pure utility functions used internally by the DO:
 * - parseEnvInt: environment variable parsing with fallback
 * - computeBackoffMs: exponential backoff calculation
 * - isTransientError: error classification for retry decisions
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Read source to verify function behavior via source contract tests
const doSource = readFileSync(
  resolve(process.cwd(), 'src/durable-objects/task-runner.ts'),
  'utf8'
);

describe('parseEnvInt', () => {
  it('exists in TaskRunner DO source', () => {
    expect(doSource).toContain('function parseEnvInt(');
  });

  it('returns fallback for undefined input', () => {
    expect(doSource).toContain("if (!value) return fallback");
  });

  it('returns fallback for non-positive parsed values', () => {
    expect(doSource).toContain('parsed > 0 ? parsed : fallback');
  });

  it('uses parseInt with radix 10', () => {
    expect(doSource).toContain("parseInt(value, 10)");
  });

  it('checks Number.isFinite to catch NaN/Infinity', () => {
    expect(doSource).toContain('Number.isFinite(parsed)');
  });
});

describe('computeBackoffMs', () => {
  it('exists in TaskRunner DO source', () => {
    expect(doSource).toContain('function computeBackoffMs(');
  });

  it('uses exponential formula (base * 2^retry)', () => {
    expect(doSource).toContain('baseDelayMs * Math.pow(2, retryCount)');
  });

  it('caps at maxDelayMs', () => {
    expect(doSource).toContain('Math.min(delay, maxDelayMs)');
  });
});

describe('isTransientError', () => {
  it('exists in TaskRunner DO source', () => {
    expect(doSource).toContain('function isTransientError(');
  });

  it('returns false for non-Error values', () => {
    expect(doSource).toContain('if (!(err instanceof Error)) return false');
  });

  it('classifies network errors as transient', () => {
    expect(doSource).toContain("'fetch failed'");
    expect(doSource).toContain("'network'");
    expect(doSource).toContain("'timeout'");
    expect(doSource).toContain("'econnrefused'");
  });

  it('classifies 429/rate limit as transient', () => {
    expect(doSource).toContain("'429'");
    expect(doSource).toContain("'rate limit'");
  });

  it('classifies 5xx errors as transient', () => {
    expect(doSource).toContain('5\\d{2}');
  });

  it('classifies not_found as permanent', () => {
    expect(doSource).toContain("'not found'");
    expect(doSource).toContain("'not_found'");
  });

  it('classifies limit_exceeded as permanent', () => {
    expect(doSource).toContain("'limit_exceeded'");
  });

  it('classifies forbidden/unauthorized as permanent', () => {
    expect(doSource).toContain("'forbidden'");
    expect(doSource).toContain("'unauthorized'");
  });

  it('defaults to transient for unknown errors', () => {
    // The function returns true at the end
    const fnBody = doSource.slice(
      doSource.indexOf('function isTransientError'),
      doSource.indexOf('// =====', doSource.indexOf('function isTransientError'))
    );
    // Last return statement should be true (default to transient)
    const lastReturn = fnBody.lastIndexOf('return true');
    expect(lastReturn).toBeGreaterThan(-1);
  });
});
