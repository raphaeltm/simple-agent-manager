import { describe, expect, it } from 'vitest';

import { findingsConform, normalizeOxlintSamFindings } from './run-oxlint-sam-shadow';

describe('Oxlint SAM alpha shadow comparison', () => {
  const finding = {
    file: 'packages/eslint-plugin-sam/tests/fixtures/example.ts',
    line: 4,
    message: 'runtime validation required',
    rule: 'sam/no-unvalidated-request-json',
  };

  it('normalizes only SAM alpha-host diagnostics', () => {
    expect(
      normalizeOxlintSamFindings([
        {
          code: 'eslint(no-unused-vars)',
          filename: finding.file,
          labels: [{ span: { line: 1 } }],
          message: 'extra native finding',
        },
        {
          code: 'sam(no-unvalidated-request-json)',
          filename: finding.file,
          labels: [{ span: { line: 4 } }],
          message: finding.message,
        },
      ])
    ).toEqual([finding]);
  });

  it('requires exact normalized finding parity', () => {
    expect(findingsConform([finding], [finding])).toBe(true);
    expect(findingsConform([finding], [{ ...finding, line: 5 }])).toBe(false);
  });
});
