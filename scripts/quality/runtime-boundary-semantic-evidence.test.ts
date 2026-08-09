import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

const evidence = JSON.parse(
  readFileSync(
    join(process.cwd(), 'scripts/quality/runtime-boundary-semantic-evidence.json'),
    'utf8'
  )
) as {
  scope: string;
  stage: string;
  blockingEnabled: boolean;
  rules: Record<string, number>;
  totalDiagnostics: number;
  sampleReview: { potentialFalsePositivePercent: number };
  decision: { promote: boolean; reason: string };
};

describe('runtime-boundary semantic adoption evidence', () => {
  it('contains only the two approved bounded rules', () => {
    expect(evidence.scope).toBe('apps/api/src');
    expect(Object.keys(evidence.rules).sort()).toEqual([
      'blind-external-payload-narrowing',
      'unvalidated-row-narrowing',
    ]);
    expect(Object.values(evidence.rules).reduce((total, count) => total + count, 0)).toBe(
      evidence.totalDiagnostics
    );
  });

  it('stays advisory while the sampled noise gate is unmet', () => {
    expect(evidence.stage).toBe('advisory');
    expect(evidence.blockingEnabled).toBe(false);
    expect(evidence.sampleReview.potentialFalsePositivePercent).toBeGreaterThan(5);
    expect(evidence.decision.promote).toBe(false);
    expect(evidence.decision.reason).not.toHaveLength(0);
  });
});
