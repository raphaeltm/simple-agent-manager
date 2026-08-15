import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  evaluateGitleaksFindings,
  gitleaksArgsForMode,
  redactSecretScanOutput,
  type SecretFindingBaseline,
  secretFindingDigest,
} from './check-secret-scan-policy';
import { createCurrentTreeSnapshot } from './run-gitleaks';

const syntheticFinding = {
  RuleID: 'synthetic-rule',
  File: 'fixtures/example.txt',
  StartLine: 1,
  Secret: 'synthetic-not-a-real-secret-value',
  Match: 'TOKEN=synthetic-not-a-real-secret-value',
};

function baseline(expiresAt = '2099-01-01T00:00:00.000Z'): SecretFindingBaseline {
  const digest = secretFindingDigest(syntheticFinding);
  if (!digest) throw new Error('Synthetic finding must produce a digest.');
  return {
    version: 1,
    matcherVersion: 'gitleaks-finding-v2-unredacted',
    baseCommit: 'fixture',
    groups: [
      {
        classification: 'synthetic-test-fixture',
        reason: 'Fixture exercises secret-redaction behavior without a live credential.',
        owner: 'security',
        reviewedAt: '2026-08-09T00:00:00.000Z',
        expiresAt,
        digests: [digest],
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

  it('rejects redacted findings because location-only hashes are forgeable', () => {
    const result = evaluateGitleaksFindings(
      JSON.stringify([{ ...syntheticFinding, Secret: 'REDACTED', Match: 'TOKEN=REDACTED' }]),
      JSON.stringify(baseline()),
      new Date('2026-08-09T12:00:00.000Z')
    );

    expect(result).toMatchObject({ ok: false, reviewedFindingCount: 0, newFindingCount: 1 });
    expect(result.errors).toContain('Gitleaks output contained an incomplete finding.');
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
      '--no-banner',
      '--no-color',
      '--report-format=json',
    ]);
    expect(gitleaksArgsForMode('pr-range', 'origin/base..HEAD')).toEqual([
      'git',
      '.',
      '--log-opts',
      'origin/base..HEAD',
      '--no-banner',
      '--no-color',
      '--report-format=json',
    ]);
  });

  it.runIf(process.platform !== 'win32')(
    'snapshots symlink blobs without following targets outside the repository',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'sam-gitleaks-source-'));
      const snapshot = mkdtempSync(join(tmpdir(), 'sam-gitleaks-snapshot-'));
      const outside = join(tmpdir(), 'sam-gitleaks-outside.txt');
      writeFileSync(outside, 'outside file contents must not be copied');
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      symlinkSync(outside, join(root, 'tracked-link'));
      execFileSync('git', ['add', 'tracked-link'], { cwd: root });

      createCurrentTreeSnapshot(root, snapshot);

      expect(readFileSync(join(snapshot, 'tracked-link'), 'utf8')).toBe(outside);
      expect(readFileSync(join(snapshot, 'tracked-link'), 'utf8')).not.toContain(
        'outside file contents'
      );
    }
  );
});
