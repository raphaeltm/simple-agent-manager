import { describe, expect, it } from 'vitest';
import {
  evaluateGitleaksFindings,
  gitleaksArgsForMode,
  redactSecretScanOutput,
  secretFindingDigest,
  type SecretFindingBaseline,
} from './check-secret-scan-policy';

const syntheticFinding = {
  RuleID: 'synthetic-rule',
  File: 'fixtures/example.txt',
  StartLine: 1,
  Secret: 'synthetic-not-a-real-secret-value',
  Match: 'TOKEN=synthetic-not-a-real-secret-value',
};

function baseline(expiresAt = '2099-01-01T00:00:00.000Z'): SecretFindingBaseline {
  return {
    version: 1,
    matcherVersion: 'gitleaks-finding-v1',
    baseCommit: 'fixture',
    groups: [
      {
        classification: 'synthetic-test-fixture',
        reason: 'Fixture exercises secret-redaction behavior without a live credential.',
        owner: 'security',
        reviewedAt: '2026-08-09T00:00:00.000Z',
        expiresAt,
        digests: [secretFindingDigest(syntheticFinding)!],
      },
    ],
  };
}

describe('secret scan policy', () => {
  it('fails closed on new findings without returning secret metadata', () => {
    const result = evaluateGitleaksFindings(JSON.stringify([syntheticFinding]));

    expect(result).toMatchObject({
      ok: false,
      totalFindingCount: 1,
      reviewedFindingCount: 0,
      newFindingCount: 1,
    });
    expect(JSON.stringify(result)).not.toContain('synthetic-not-a-real-secret-value');
    expect(JSON.stringify(result)).not.toContain('fixtures/example.txt');
    expect(JSON.stringify(result)).not.toContain('synthetic-rule');
  });

  it('permits only the exact reviewed finding digest', () => {
    const reviewed = evaluateGitleaksFindings(
      JSON.stringify([syntheticFinding]),
      JSON.stringify(baseline()),
      new Date('2026-08-09T12:00:00.000Z')
    );
    const changed = evaluateGitleaksFindings(
      JSON.stringify([{ ...syntheticFinding, Secret: 'changed-fixture-value' }]),
      JSON.stringify(baseline()),
      new Date('2026-08-09T12:00:00.000Z')
    );

    expect(reviewed).toMatchObject({ ok: true, reviewedFindingCount: 1, newFindingCount: 0 });
    expect(changed).toMatchObject({ ok: false, reviewedFindingCount: 0, newFindingCount: 1 });
  });

  it('fails closed when a reviewed exemption expires', () => {
    const result = evaluateGitleaksFindings(
      JSON.stringify([syntheticFinding]),
      JSON.stringify(baseline('2026-08-09T11:59:59.000Z')),
      new Date('2026-08-09T12:00:00.000Z')
    );

    expect(result.ok).toBe(false);
    expect(result.errors).toEqual(['A reviewed Gitleaks baseline entry has expired.']);
  });

  it('redacts raw command output before logs or artifacts can expose values', () => {
    const redacted = redactSecretScanOutput(
      '{"Secret":"synthetic-not-a-real-secret-value","Match":"TOKEN=synthetic-not-a-real-secret-value"}'
    );

    expect(redacted).not.toContain('synthetic-not-a-real-secret-value');
    expect(redacted).toContain('[REDACTED]');
  });

  it('uses current-tree and explicit PR-range modes without full-history scan arguments', () => {
    expect(gitleaksArgsForMode('current-tree')).toEqual([
      'dir',
      '.',
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--report-format=json',
    ]);
    expect(gitleaksArgsForMode('pr-range', 'origin/base..HEAD')).toEqual([
      'git',
      '.',
      '--log-opts',
      'origin/base..HEAD',
      '--redact=100',
      '--no-banner',
      '--no-color',
      '--report-format=json',
    ]);
  });
});
