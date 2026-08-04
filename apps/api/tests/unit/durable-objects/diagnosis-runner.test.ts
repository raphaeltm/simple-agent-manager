import { describe, expect, it } from 'vitest';

import {
  classifyDiagnosisFailure,
  diagnosisRetryDelay,
} from '../../../src/services/diagnosis-runner-policy';

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
});
