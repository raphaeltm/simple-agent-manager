import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(import.meta.dirname, '../..');
const SCRIPT = join(ROOT, 'scripts/quality/check-coverage-threshold-baseline.ts');

function runReport(...args: string[]): string {
  return execFileSync('npx', ['tsx', SCRIPT, ...args], {
    cwd: ROOT,
    encoding: 'utf-8',
    timeout: 30_000,
  });
}

describe('coverage threshold baseline report', () => {
  it('prints a non-failing baseline report with low-headroom metrics', () => {
    const output = runReport();

    expect(output).toContain('Coverage threshold baseline report (non-failing).');
    expect(output).toContain('apps/api (apps/api/vitest.config.ts, measured 2026-05-07)');
    expect(output).toContain('functions: measured 47.24% / threshold 44% / headroom 3.24%');
  });

  it('emits machine-readable package baseline metadata', () => {
    const report = JSON.parse(runReport('--json'));

    expect(report).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          packageName: 'apps/web',
          configPath: 'apps/web/vitest.config.ts',
          lowHeadroomMetrics: expect.arrayContaining(['lines']),
        }),
      ])
    );
  });
});
