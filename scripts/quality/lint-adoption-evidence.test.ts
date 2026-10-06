import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

interface LintEvidence {
  eslintFoundationParity: {
    legacyDiagnostics: number;
    flatDiagnostics: number;
    missingNormalizedFindings: number;
    addedNormalizedFindings: number;
  };
  oxlintShadow: {
    mode: string;
    typeAware: boolean;
    typeCheck: boolean;
    trackedAstroFiles: number;
    observedAstroFiles: number;
    samFixtureExpectedFindings: number;
    samFixtureObservedFindings: number;
    samFixtureConformancePercent: number;
  };
  fixEvidence: { exactSafeFixOutputMatch: boolean; fixesAppliedToRepository: boolean };
  newInlineSuppressions: number;
  promotion: { decision: string; gates: Record<string, boolean>; reasons: string[] };
}

const evidence = JSON.parse(
  readFileSync(join(process.cwd(), 'scripts/quality/lint-adoption-evidence.json'), 'utf8')
) as LintEvidence;

describe('lint adoption evidence', () => {
  it('proves the ESLint host migration preserved the audited finding set', () => {
    expect(evidence.eslintFoundationParity).toMatchObject({
      legacyDiagnostics: 2372,
      flatDiagnostics: 2372,
      missingNormalizedFindings: 0,
      addedNormalizedFindings: 0,
    });
  });

  it('keeps non-type-aware Oxlint and the alpha SAM host advisory', () => {
    expect(evidence.oxlintShadow).toMatchObject({
      mode: 'report-only',
      typeAware: false,
      typeCheck: false,
      samFixtureConformancePercent: 100,
    });
    expect(evidence.oxlintShadow.observedAstroFiles).toBe(evidence.oxlintShadow.trackedAstroFiles);
    expect(evidence.oxlintShadow.samFixtureObservedFindings).toBe(
      evidence.oxlintShadow.samFixtureExpectedFindings
    );
  });

  it('refuses promotion while any required gate is unmet', () => {
    expect(evidence.promotion.decision).toBe('stay-shadow');
    expect(Object.values(evidence.promotion.gates)).toContain(false);
    expect(evidence.promotion.reasons.length).toBeGreaterThan(0);
    expect(evidence.fixEvidence).toMatchObject({
      exactSafeFixOutputMatch: false,
      fixesAppliedToRepository: false,
    });
    expect(evidence.newInlineSuppressions).toBe(0);
  });
});
