import { describe, expect, it } from 'vitest';

import { type OxlintReport, summarizeOxlintReport } from './run-oxlint-shadow';

describe('Oxlint shadow summary', () => {
  it('produces deterministic, bounded report-only output', () => {
    const report: OxlintReport = {
      diagnostics: [
        { code: 'typescript/no-any', severity: 'warning' },
        { code: 'eslint/no-console', severity: 'warning' },
        { code: 'typescript/no-any', severity: 'warning' },
      ],
      number_of_files: 12,
      number_of_rules: 3,
      start_time: 0.25,
      threads_count: 2,
    };

    expect(summarizeOxlintReport(report)).toEqual({
      diagnostics: 3,
      files: 12,
      mode: 'report-only',
      rules: 3,
      seconds: 0.25,
      topRules: [
        { count: 2, rule: 'typescript/no-any' },
        { count: 1, rule: 'eslint/no-console' },
      ],
    });
  });

  it('uses rule name as the stable tie-breaker', () => {
    const report: OxlintReport = {
      diagnostics: [
        { code: 'z/rule', severity: 'warning' },
        { code: 'a/rule', severity: 'warning' },
      ],
      number_of_files: 1,
      number_of_rules: 2,
      start_time: 0.1,
      threads_count: 1,
    };

    expect(summarizeOxlintReport(report).topRules).toEqual([
      { count: 1, rule: 'a/rule' },
      { count: 1, rule: 'z/rule' },
    ]);
  });
});
