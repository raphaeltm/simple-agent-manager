import { describe, expect, it } from 'vitest';

import {
  classifyFileSize,
  compareCoverageThresholds,
  countLines,
  isTestFile,
  parseCoverageThresholds,
} from './check-repo-quality-visibility';

const budgets = {
  sourceWarnLines: 500,
  sourceOversizedLines: 800,
  testWarnLines: 800,
  testOversizedLines: 1200,
};

describe('repo quality visibility guard', () => {
  it('classifies source and test files with separate report-only budgets', () => {
    expect(classifyFileSize('apps/api/src/routes/example.ts', 501, budgets)).toEqual({
      file: 'apps/api/src/routes/example.ts',
      lines: 501,
      kind: 'source',
      severity: 'warning',
    });
    expect(classifyFileSize('apps/api/tests/example.test.ts', 1201, budgets)).toEqual({
      file: 'apps/api/tests/example.test.ts',
      lines: 1201,
      kind: 'test',
      severity: 'oversized',
    });
    expect(classifyFileSize('apps/api/tests/example.test.ts', 700, budgets)).toBeNull();
  });

  it('identifies common test file naming conventions', () => {
    expect(isTestFile('apps/web/tests/widget.test.tsx')).toBe(true);
    expect(isTestFile('packages/vm-agent/internal/server/server_test.go')).toBe(true);
    expect(isTestFile('packages/shared/src/types.ts')).toBe(false);
  });

  it('counts lines without inventing a trailing blank line', () => {
    expect(countLines('one\ntwo\n')).toBe(2);
    expect(countLines('one\ntwo')).toBe(2);
    expect(countLines('')).toBe(0);
  });

  it('parses coverage thresholds from Vitest config source', () => {
    expect(
      parseCoverageThresholds(`
        coverage: coverageConfig(['src/**/*.ts'], {
          statements: 45,
          branches: 40,
          functions: 44,
          lines: 45,
        }),
      `)
    ).toEqual({ statements: 45, branches: 40, functions: 44, lines: 45 });
  });

  it('reports coverage threshold drift without treating raises as failures by default', () => {
    const drift = compareCoverageThresholds(
      { 'apps/api/vitest.config.ts': { statements: 45, branches: 40, functions: 44, lines: 45 } },
      { 'apps/api/vitest.config.ts': { statements: 44, branches: 40, functions: 45, lines: 45 } }
    );

    expect(drift).toEqual([
      {
        file: 'apps/api/vitest.config.ts',
        metric: 'statements',
        baseline: 45,
        current: 44,
        direction: 'lowered',
      },
      {
        file: 'apps/api/vitest.config.ts',
        metric: 'functions',
        baseline: 44,
        current: 45,
        direction: 'raised',
      },
    ]);
  });
});
