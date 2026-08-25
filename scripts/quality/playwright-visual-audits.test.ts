import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { selectPlaywrightVisualAudits } from './select-playwright-visual-audits';

function createFixture(files: string[], quarantine: string): string {
  const root = mkdtempSync(path.join(tmpdir(), 'sam-playwright-visual-'));
  const testsDir = path.join(root, 'apps/web/tests/playwright');
  mkdirSync(testsDir, { recursive: true });
  for (const file of files) {
    writeFileSync(path.join(testsDir, file), 'test fixture\n');
  }
  writeFileSync(path.join(testsDir, 'visual-audit-quarantine.txt'), quarantine);
  return root;
}

describe('Playwright visual audit selector', () => {
  it('selects non-staging audit specs that are not quarantined', () => {
    const root = createFixture(
      [
        'failure-card-audit.spec.ts',
        'legacy-audit.spec.ts',
        'staging-real-env-audit.spec.ts',
        'component.spec.ts',
      ],
      'legacy-audit.spec.ts\n'
    );

    expect(selectPlaywrightVisualAudits(root).selected).toEqual([
      'tests/playwright/failure-card-audit.spec.ts',
    ]);
  });

  it('fails closed when quarantine references a missing file', () => {
    const root = createFixture(['failure-card-audit.spec.ts'], 'missing-audit.spec.ts\n');

    expect(() => selectPlaywrightVisualAudits(root)).toThrow('file does not exist');
  });

  it('fails closed when every visual audit is quarantined', () => {
    const root = createFixture(['failure-card-audit.spec.ts'], 'failure-card-audit.spec.ts\n');

    expect(() => selectPlaywrightVisualAudits(root)).toThrow('selection is empty');
  });
});
