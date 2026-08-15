import { describe, expect, it, vi } from 'vitest';

import {
  classifyDiagnosisFailure,
  diagnosisRetryDelay,
  resolveDiagnosisCompletedStepDelayMs,
} from '../../../src/services/diagnosis-runner-policy';

// The DiagnosisRunner DO module imports `DurableObject` from the
// Workers-runtime-only 'cloudflare:workers' specifier at module scope, so
// loading it (even just to import the plain `resultCount` helper) under the
// plain Node test runner requires stubbing that specifier — mirrors the
// established pattern in tests/unit/durable-objects/codex-refresh-lock.test.ts
// and tests/unit/durable-objects/credential-setup-session.test.ts.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ctx: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    env: any;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(ctx: any, env: any) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { resultCount } = await import('../../../src/durable-objects/diagnosis-runner');

describe('DiagnosisRunner retry policy', () => {
  it.each([
    ['429 rate limited', true],
    ['upstream returned 503', true],
    ['request timeout', true],
    ['network unavailable', true],
    ['invalid permanent request', false],
  ])('classifies %s', (message, transient) => {
    expect(classifyDiagnosisFailure(new Error(message)).transient).toBe(transient);
  });

  it('uses exponential backoff capped by the configured maximum', () => {
    expect(diagnosisRetryDelay(1, 2_000, 10_000)).toBe(2_000);
    expect(diagnosisRetryDelay(3, 2_000, 10_000)).toBe(8_000);
    expect(diagnosisRetryDelay(8, 2_000, 10_000)).toBe(10_000);
  });

  it('resolves a positive configurable floor for completed-step retries', () => {
    expect(resolveDiagnosisCompletedStepDelayMs('2500')).toBe(2_500);
    expect(resolveDiagnosisCompletedStepDelayMs('0')).toBe(1_000);
    expect(resolveDiagnosisCompletedStepDelayMs(undefined)).toBe(1_000);
  });
});

// resultCount parses a tool-execution result string to count evidence items.
// It replaced a blind `JSON.parse(result) as Record<string, unknown>` cast
// with `maybeJsonRecord` — these tests pin the exact behavior across every
// shape a tool result can legitimately or maliciously take.
describe('resultCount (tool-result evidence counting)', () => {
  it('returns the explicit total field when present', () => {
    expect(resultCount(JSON.stringify({ total: 5, items: [1, 2] }))).toBe(5);
  });

  it('sums the lengths of all array-valued fields when no total is given', () => {
    expect(resultCount(JSON.stringify({ errors: [1, 2, 3], warnings: [4, 5] }))).toBe(5);
  });

  it('returns null when there is no total and no array fields', () => {
    expect(resultCount(JSON.stringify({ message: 'no evidence here' }))).toBeNull();
    expect(resultCount(JSON.stringify({}))).toBeNull();
  });

  it('returns null (never throws) for malformed JSON', () => {
    expect(resultCount('{not valid json')).toBeNull();
  });

  it('returns null (never throws) for a JSON null literal', () => {
    // A blind `JSON.parse(result) as Record<string, unknown>` cast previously
    // relied on `null.total` throwing and being caught by the outer try/catch
    // to reach this same outcome — maybeJsonRecord reaches it without a throw.
    expect(resultCount('null')).toBeNull();
  });

  it('returns null for top-level JSON primitives (string/number/boolean)', () => {
    expect(resultCount('"just a string"')).toBeNull();
    expect(resultCount('42')).toBeNull();
    expect(resultCount('true')).toBeNull();
  });

  it('sums nested array lengths when the top-level JSON value is itself an array', () => {
    // maybeJsonRecord accepts arrays (numeric indices are valid record keys),
    // matching Object.values(array) behavior on the pre-fix blind cast.
    expect(resultCount(JSON.stringify([[1, 2], [3], 'not-an-array']))).toBe(3);
  });

  it('returns null for an empty top-level array', () => {
    expect(resultCount('[]')).toBeNull();
  });
});
